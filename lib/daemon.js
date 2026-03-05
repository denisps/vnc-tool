'use strict';

/**
 * Background daemon process.
 * Usage: node lib/daemon.js --id ID --host HOST --port PORT [--password PASS] [--timeout MS]
 *
 * Maintains a persistent VNC connection and serves commands over a Unix socket.
 * IPC protocol: newline-delimited JSON.
 *   Client → Daemon: {"cmd":"...","x":...,...}\n
 *   Daemon → Client: {"ok":true,"result":...}\n  or  {"ok":false,"error":"..."}\n
 */

const fs   = require('fs');
const net  = require('net');
const os   = require('os');
const path = require('path');

const { VNCClient } = require('./client');

// ── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { id: null, host: 'localhost', port: 5900, password: null, timeout: 10000 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--id':       opts.id       = argv[++i]; break;
      case '--host':     opts.host     = argv[++i]; break;
      case '--port':     opts.port     = parseInt(argv[++i], 10); break;
      case '--password': opts.password = argv[++i]; break;
      case '--timeout':  opts.timeout  = parseInt(argv[++i], 10); break;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (!opts.id) {
  process.stderr.write('daemon: --id is required\n');
  process.exit(1);
}

const SESS_DIR  = path.join(os.homedir(), '.vnc-tool', 'sessions');
const SOCK_PATH = path.join(SESS_DIR, `${opts.id}.sock`);
const PID_PATH  = path.join(SESS_DIR, `${opts.id}.pid`);

// ── Command handler ──────────────────────────────────────────────────────────

async function handleCommand(cmd, client) {
  switch (cmd.cmd) {
    case 'screenshot': {
      const png = await client.screenshot(cmd.file || null);
      return { size: png.length, base64: png.toString('base64') };
    }
    case 'click':
      await client.mouseClick(cmd.x, cmd.y, cmd.button || 'left');
      return {};
    case 'move':
      await client.mouseMove(cmd.x, cmd.y);
      return {};
    case 'mousedown':
      await client.mouseDown(cmd.x, cmd.y, cmd.button || 'left');
      return {};
    case 'mouseup':
      await client.mouseUp(cmd.x, cmd.y, cmd.button || 'left');
      return {};
    case 'scroll':
      await client.mouseScroll(cmd.x, cmd.y, cmd.amount !== undefined ? cmd.amount : 3);
      return {};
    case 'type':
      await client.type(cmd.text || '');
      return {};
    case 'key':
      await client.keyPress(cmd.combo);
      return {};
    case 'keydown':
      await client.keyDown(cmd.key);
      return {};
    case 'keyup':
      await client.keyUp(cmd.key);
      return {};
    case 'delay':
      await client.delay(cmd.ms || 0);
      return {};
    case 'run':
      return client.run(cmd.commands || []);
    case 'ping':
      return { pong: true };
    case 'stop':
      setImmediate(() => cleanup(0));
      return {};
    case 'info':
      return { width: client.width, height: client.height };
    default:
      throw new Error(`Unknown command: ${cmd.cmd}`);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

function cleanup(code) {
  try { fs.unlinkSync(SOCK_PATH); } catch (_) {}
  try { fs.unlinkSync(PID_PATH);  } catch (_) {}
  process.exit(code);
}

process.on('SIGTERM', () => cleanup(0));
process.on('SIGINT',  () => cleanup(0));

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  // Ensure sessions directory
  await fs.promises.mkdir(SESS_DIR, { recursive: true });

  // Connect to VNC server (with retry)
  const client = new VNCClient({
    host:     opts.host,
    port:     opts.port,
    password: opts.password,
    timeout:  opts.timeout,
  });

  let retries = 5;
  while (retries > 0) {
    try {
      await client.connect();
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        process.stderr.write(`daemon: VNC connect failed: ${err.message}\n`);
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Write PID file
  await fs.promises.writeFile(PID_PATH, String(process.pid), 'utf8');

  // Remove stale socket
  try { fs.unlinkSync(SOCK_PATH); } catch (_) {}

  // Start Unix socket server
  const server = net.createServer((socket) => {
    let buf = '';

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);

        let cmd;
        try {
          cmd = JSON.parse(line);
        } catch (_) {
          socket.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n');
          continue;
        }

        handleCommand(cmd, client)
          .then(result => {
            if (!socket.destroyed) {
              socket.write(JSON.stringify({ ok: true, result }) + '\n');
            }
          })
          .catch(err => {
            if (!socket.destroyed) {
              socket.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
            }
          });
      }
    });

    socket.on('error', () => {});
  });

  server.on('error', (err) => {
    process.stderr.write(`daemon socket error: ${err.message}\n`);
    cleanup(1);
  });

  server.listen(SOCK_PATH, () => {
    // Socket is now listening — session.js polls for this file
  });

  client.on('error', (err) => {
    process.stderr.write(`daemon: VNC error: ${err && err.message ? err.message : String(err)}\n`);
    cleanup(1);
  });
})();
