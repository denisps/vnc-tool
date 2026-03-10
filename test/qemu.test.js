'use strict';

const { test }      = require('node:test');
const assert        = require('node:assert/strict');
const { spawn, execSync } = require('child_process');
const path          = require('path');
const fs            = require('fs');
const os            = require('os');

const { VNCClient } = require('../lib/client');

// ── Helpers ─────────────────────────────────────────────────────────────────

function hasQemu() {
  try {
    execSync('which qemu-system-x86_64', { stdio: 'ignore' });
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Find OVMF UEFI firmware files.  Returns a pflash descriptor (preferred —
 * writable NVRAM makes Escape/F2 setup entry reliable) or a single-file
 * fallback.  Returns null when no OVMF is found.
 *
 * @returns {{ type: 'pflash', code: string, vars: string }
 *          |{ type: 'bios',   path: string }
 *          | null}
 */
function findOvmf() {
  // Prefer pflash split: CODE (readonly) + VARS (writable copy).
  const pflashCode = '/usr/share/OVMF/OVMF_CODE_4M.fd';
  const pflashVars = '/usr/share/OVMF/OVMF_VARS_4M.fd';
  try {
    fs.accessSync(pflashCode);
    fs.accessSync(pflashVars);
    return { type: 'pflash', code: pflashCode, vars: pflashVars };
  } catch (_) {}

  // Fallback: single combined image loaded as legacy BIOS.
  const singles = [
    '/usr/share/ovmf/OVMF.fd',
    '/usr/share/OVMF/OVMF.fd',
    '/usr/share/qemu/OVMF.fd',
    '/usr/share/edk2/ovmf/OVMF.fd',
  ];
  for (const p of singles) {
    try { fs.accessSync(p); return { type: 'bios', path: p }; } catch (_) {}
  }
  return null;
}

// Configurable timeouts (milliseconds); override via env vars in CI.
const GLOBAL_TIMEOUT   = parseInt(process.env.QEMU_TEST_TIMEOUT     || '60000', 10);
const CONNECT_TIMEOUT  = parseInt(process.env.QEMU_CONNECT_TIMEOUT  || '15000', 10);
const CAPTURE_DURATION = parseInt(process.env.QEMU_CAPTURE_DURATION || '15000', 10);

/**
 * Poll-connect to a VNC port and return the connected VNCClient.
 * The caller must disconnect when finished.
 */
async function waitForVnc(port, timeout = 10000) {
  const start = Date.now();
  while (true) {
    const c = new VNCClient({ host: '127.0.0.1', port });
    try {
      await c.connect();
      return c;
    } catch (_err) {
      try { c.disconnect(); } catch (_) {}
      if (Date.now() - start > timeout) {
        throw new Error(`timed out waiting for VNC on port ${port}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

/**
 * Wait until `updateCount` increases by at least `delta` from `baseline`,
 * or until `ms` milliseconds have elapsed.  Returns the new updateCount.
 */
function waitForUpdate(client, baseline, delta, ms) {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (client.updateCount - baseline >= delta) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(client.updateCount);
      }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve(client.updateCount);
    }, ms);
  });
}

// ── Test ────────────────────────────────────────────────────────────────────

test('optional: qemu VNC boot capture (requires qemu)', { timeout: GLOBAL_TIMEOUT }, async (t) => {
  if (!hasQemu()) {
    t.skip('qemu-system-x86_64 not installed; skipping');
    return;
  }

  const port    = 5901;
  const display = port - 5900;
  const pngDir  = path.join(__dirname, `qemu-screens-${Date.now()}`);
  fs.mkdirSync(pngDir, { recursive: true });

  const ovmf = findOvmf();

  // ── spawn qemu ──
  const qemuArgs = [
    '-display', 'none',
    '-vnc', `:${display}`,
    '-m', '64M',
  ];

  let varsCopy = null;  // writable VARS copy; cleaned up in finally
  if (ovmf && ovmf.type === 'pflash') {
    // Use pflash split: readonly CODE + writable VARS copy so NVRAM is
    // mutable, which makes Escape/F2 setup entry reliable.
    varsCopy = path.join(os.tmpdir(), `ovmf-vars-${Date.now()}.fd`);
    fs.copyFileSync(ovmf.vars, varsCopy);
    qemuArgs.push('-drive', `if=pflash,format=raw,readonly=on,file=${ovmf.code}`);
    qemuArgs.push('-drive', `if=pflash,format=raw,file=${varsCopy}`);
  } else if (ovmf && ovmf.type === 'bios') {
    // OVMF gives a proper blue UEFI setup screen accessible via Escape/F2
    qemuArgs.push('-bios', ovmf.path);
  } else {
    // SeaBIOS fallback: boot menu accessible via F12
    qemuArgs.push('-boot', 'menu=on');
  }

  const qemu = spawn('qemu-system-x86_64', qemuArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  // drain output to prevent backpressure from stopping the process
  qemu.stdout.on('data', () => {});
  qemu.stderr.on('data', () => {});

  let qemuExited = false;
  let exitInfo   = null;
  qemu.on('exit', (code, sig) => { qemuExited = true; exitInfo = { code, sig }; });

  let client;
  let screenshotSeq = 0;
  // Suppress unhandled 'error' events on the client — we handle them by
  // letting the active test fail naturally (e.g. next await throws).
  const clientErrors = [];
  // Interval that hammers Escape+F2 as soon as we connect so we never miss
  // the narrow TianoCore UEFI setup-entry window (open ~1–3 s after boot).
  let keyInterval = null;

  /** Save a screenshot and return its path. */
  async function snap(prefix) {
    const buf   = await client.screenshot();
    const fname = path.join(pngDir, `${prefix}-${++screenshotSeq}.png`);
    fs.writeFileSync(fname, buf);
    return fname;
  }

  /**
   * Return true if the raw RGBA buffer looks like a BIOS/UEFI setup screen.
   * Accepts two common TianoCore/OVMF colour themes:
   *   - Classic dark-blue background  (b > 100, r < 100, g < 100)
   *   - Modern gray/silver background (r ≈ g ≈ b, 80–200)
   * Either way ≥25 % of pixels must match to pass.
   */
  function isBiosScreen(rgba) {
    let count = 0;
    const total = rgba.length / 4;
    for (let off = 0; off < rgba.length; off += 4) {
      const r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];
      if (b > 100 && r < 100 && g < 100) { count++; continue; }  // blue theme
      if (r > 80 && r < 200 && Math.abs(r - g) < 30 && Math.abs(r - b) < 30) count++; // gray theme
    }
    return count / total > 0.25;
  }

  try {
    // ── sub-test 1: connect ──
    await t.test('start qemu and connect to VNC', { timeout: CONNECT_TIMEOUT }, async () => {
      client = await waitForVnc(port, CONNECT_TIMEOUT - 1000);
      // Attach error listener immediately so unhandled-error events don't crash
      // the process if qemu dies or reconnection fails mid-test.
      client.on('error', (err) => clientErrors.push(err));
      // Hammer Escape+F2 from the moment we connect so we catch the brief
      // TianoCore UEFI setup-entry window without relying on precise timing.
      keyInterval = setInterval(() => {
        client.keyPress('Escape').catch(() => {});
        client.keyPress('f2').catch(() => {});
      }, 150);
    });

    if (!client) return;

    // ── sub-test 2: capture boot frames ──
    await t.test('capture boot screen updates', { timeout: CAPTURE_DURATION + 5000 }, async () => {
      // take an initial screenshot right away
      await snap('boot');

      // wait for the first real update (SeaBIOS/TianoCore draws the splash)
      const baseline = client.updateCount;
      await waitForUpdate(client, baseline, 0.01, 3000);
      await snap('boot');

      // Capture frames — key hammering continues concurrently via keyInterval.
      const start = Date.now();
      while (!qemuExited && Date.now() - start < CAPTURE_DURATION) {
        const prev = client.updateCount;
        await new Promise(r => setTimeout(r, 250));
        if (client.updateCount - prev >= 0.05) {
          await snap('boot');
        }
      }
    });

    // ── sub-test 3: verify BIOS / firmware UI ──
    await t.test('press F2 to enter BIOS and capture', { timeout: 15000 }, async () => {
      // Stop generic hammering; send a targeted burst now.
      clearInterval(keyInterval);
      keyInterval = null;

      for (let i = 0; i < 10; i++) {
        await client.keyPress('Escape');
        await client.delay(80);
        await client.keyPress('f2');
        await client.delay(80);
      }

      // give BIOS time to redraw; some firmware can take several seconds
      // to paint a configuration screen, so allow a longer interval.
      const baseline = client.updateCount;
      await waitForUpdate(client, baseline, 0.1, 5000);
      const biosShot = await snap('bios');

      // quick heuristic: the BIOS/UEFI setup screen is usually mostly blue.
      // use raw RGBA data (not the compressed PNG) for pixel analysis.
      const rgba = await client.screenshotRaw();
      assert.ok(isBiosScreen(rgba), 'BIOS/UEFI setup screen should be visible (blue or gray theme)');

      // capture a few more frames over 5 s
      const start = Date.now();
      while (!qemuExited && Date.now() - start < 5000) {
        const prev = client.updateCount;
        await new Promise(r => setTimeout(r, 250));
        if (client.updateCount - prev >= 0.01) {
          await snap('bios');
        }
      }
    });

    // ── final assertion ──
    const files = fs.readdirSync(pngDir).filter(f => f.endsWith('.png'));
    console.log(`  screenshots saved to ${pngDir} (${files.length} files)`);
    assert.ok(files.length >= 2, `expected ≥ 2 screenshots, got ${files.length}`);
  } finally {
    // Always clean up regardless of sub-test outcomes.
    clearInterval(keyInterval);
    if (client) await client.disconnect();
    if (!qemuExited) qemu.kill('SIGTERM');
    if (varsCopy) { try { fs.unlinkSync(varsCopy); } catch (_) {} }
  }
});
