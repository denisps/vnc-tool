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

  // ── spawn qemu ──
  const qemu = spawn('qemu-system-x86_64', [
    '-display', 'none',
    '-vnc', `:${display}`,
    '-m', '32M',
    '-boot', 'menu=on',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

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

  /** Save a screenshot and return its path. */
  async function snap(prefix) {
    const buf   = await client.screenshot();
    const fname = path.join(pngDir, `${prefix}-${++screenshotSeq}.png`);
    fs.writeFileSync(fname, buf);
    return fname;
  }

  /**
   * Return true if buffer contains a significant number of mostly-blue
   * pixels.  This is a crude heuristic to detect a BIOS/firmware screen,
   * which typically has a predominantly blue background.
   */
  function isMostlyBlue(buf) {
    let blueCount = 0;
    const total    = buf.length / 4;
    for (let off = 0; off < buf.length; off += 4) {
      const r = buf[off + 0];
      const g = buf[off + 1];
      const b = buf[off + 2];
      if (b > 150 && r < 100 && g < 100) blueCount++;
    }
    return blueCount / total > 0.25; // at least 25% of pixels mostly blue
  }

  try {
    // ── sub-test 1: connect ──
    await t.test('start qemu and connect to VNC', { timeout: CONNECT_TIMEOUT }, async () => {
      client = await waitForVnc(port, CONNECT_TIMEOUT - 1000);
      // Attach error listener immediately so unhandled-error events don't crash
      // the process if qemu dies or reconnection fails mid-test.
      client.on('error', (err) => clientErrors.push(err));
    });

    if (!client) return;

    // ── sub-test 2: capture boot frames ──
    await t.test('capture boot screen updates', { timeout: CAPTURE_DURATION + 5000 }, async () => {
      // take an initial screenshot right away
      await snap('boot');

      // wait for the first real update (SeaBIOS draws the splash)
      let baseline = client.updateCount;
      baseline = await waitForUpdate(client, baseline, 0.01, 3000);
      await snap('boot');

      // capture frames on every major screen change (~10% of pixels)
      const start = Date.now();
      while (!qemuExited && Date.now() - start < CAPTURE_DURATION) {
        const prev = client.updateCount;
        await new Promise(r => setTimeout(r, 250));
        const delta = client.updateCount - prev;
        if (delta >= 0.05) {
          await snap('boot');
        }
      }
    });

    // ── sub-test 3: enter BIOS ──
    await t.test('press F2 to enter BIOS and capture', { timeout: 15000 }, async () => {
      // spam F2 / Esc / Del — different firmwares use different keys
      for (let i = 0; i < 15; i++) {
        await client.keyPress('f2');
        await client.delay(80);
        //await client.keyPress('Escape');
        //await client.delay(80);
        //await client.keyPress('Delete');
        //await client.delay(80);
      }

      // give BIOS time to redraw
      const baseline = client.updateCount;
      await waitForUpdate(client, baseline, 0.1, 3000);
      const biosShot = await snap('bios');

      // quick heuristic: the BIOS screen is usually mostly blue.  verify
      // that the first 'bios' capture satisfies that condition.
      const buf = fs.readFileSync(biosShot);
      assert.ok(isMostlyBlue(buf), 'first BIOS screenshot should be mostly blue');

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
    if (client) await client.disconnect();
    if (!qemuExited) qemu.kill('SIGTERM');
  }
});
