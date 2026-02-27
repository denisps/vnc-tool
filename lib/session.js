'use strict';

const fs      = require('fs');
const net     = require('net');
const os      = require('os');
const path    = require('path');
const { spawn } = require('child_process');

const SESSIONS_DIR = path.join(os.homedir(), '.vnc-tool', 'sessions');

function socketPath(id) { return path.join(SESSIONS_DIR, `${id}.sock`); }
function pidPath(id)    { return path.join(SESSIONS_DIR, `${id}.pid`);  }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Ensure sessions directory exists.
 */
async function ensureDir() {
  await fs.promises.mkdir(SESSIONS_DIR, { recursive: true });
}

/**
 * Spawn a background daemon process for a persistent VNC session.
 * @param {string} id - session identifier
 * @param {{ host, port, password, timeout }} connectionOptions
 * @returns {Promise<{ id, socketPath, pid }>}
 */
async function startSession(id, connectionOptions = {}) {
  await ensureDir();

  const sock = socketPath(id);
  const pid  = pidPath(id);

  // Clean up stale files
  await fs.promises.unlink(sock).catch(() => {});
  await fs.promises.unlink(pid).catch(() => {});

  const daemonScript = path.join(__dirname, 'daemon.js');
  const args = [
    daemonScript,
    '--id',   id,
    '--host', connectionOptions.host || 'localhost',
    '--port', String(connectionOptions.port || 5900),
  ];
  if (connectionOptions.password) {
    args.push('--password', connectionOptions.password);
  }
  if (connectionOptions.timeout) {
    args.push('--timeout', String(connectionOptions.timeout));
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio:    'ignore',
  });
  child.unref();

  // Poll for socket file (up to 15 s)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await fs.promises.access(sock);
      // Socket exists → daemon is ready
      let daemonPid = child.pid;
      try {
        const raw = await fs.promises.readFile(pid, 'utf8');
        daemonPid = parseInt(raw.trim(), 10);
      } catch (_) {}
      return { id, socketPath: sock, pid: daemonPid };
    } catch (_) {
      await sleep(100);
    }
  }

  throw new Error(`Session "${id}" failed to start within timeout`);
}

/**
 * Send a stop command to the daemon and wait for its socket to disappear.
 */
async function stopSession(id) {
  try {
    await sendCommand(id, { cmd: 'stop' });
  } catch (_) {
    // Ignore errors (daemon may have already exited)
  }

  const sock = socketPath(id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.promises.access(sock);
      await sleep(100);
    } catch (_) {
      return; // socket gone → daemon stopped
    }
  }
  // Force-clean files if still present
  await fs.promises.unlink(sock).catch(() => {});
  await fs.promises.unlink(pidPath(id)).catch(() => {});
}

/**
 * Send a JSON command to the session daemon and return the result.
 * @param {string} id
 * @param {object} command
 * @returns {Promise<any>}
 */
function sendCommand(id, command, timeout = 30000) {
  const sock = socketPath(id);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    let buf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Command "${command.cmd}" timed out`));
      }
    }, timeout);

    socket.on('connect', () => {
      socket.write(JSON.stringify(command) + '\n');
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0 && !settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        try {
          const res = JSON.parse(buf.slice(0, nl));
          if (res.ok) resolve(res.result);
          else reject(new Error(res.error || 'Daemon error'));
        } catch (e) {
          reject(new Error('Invalid daemon response'));
        }
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Daemon socket closed unexpectedly'));
      }
    });
  });
}

/**
 * List all active sessions (those with a readable socket file and live PID).
 * @returns {Promise<Array<{ id, pid, socketPath }>>}
 */
async function listSessions() {
  try {
    const files = await fs.promises.readdir(SESSIONS_DIR);
    const sessions = [];

    for (const file of files) {
      if (!file.endsWith('.pid')) continue;
      const id   = file.slice(0, -4);
      const sock = socketPath(id);
      const ppf  = pidPath(id);

      try {
        const rawPid = await fs.promises.readFile(ppf, 'utf8');
        const pid = parseInt(rawPid.trim(), 10);

        // Check process still alive
        process.kill(pid, 0);
        sessions.push({ id, pid, socketPath: sock });
      } catch (_) {
        // Stale files – clean up silently
        await fs.promises.unlink(sock).catch(() => {});
        await fs.promises.unlink(ppf).catch(() => {});
      }
    }

    return sessions;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Check whether a named session is currently active.
 */
async function sessionExists(id) {
  try {
    await fs.promises.access(socketPath(id));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  startSession,
  stopSession,
  sendCommand,
  listSessions,
  sessionExists,
  SESSIONS_DIR,
};
