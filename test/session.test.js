'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const { MockVNCServer }                             = require('./mock-server');
const { startSession, stopSession, sendCommand,
        listSessions, sessionExists, SESSIONS_DIR } = require('../lib/session');

// Use unique session IDs to avoid collisions between test runs
function uniqueId() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

test('session: startSession() spawns daemon and creates socket', async (t) => {
  const server = new MockVNCServer({ width: 100, height: 100 });
  const { port } = await server.start();
  const id = uniqueId();

  try {
    const info = await startSession(id, {
      host: '127.0.0.1',
      port,
      timeout: 5000,
    });

    assert.equal(info.id, id);
    assert.ok(info.socketPath, 'Should have socketPath');

    // Socket file should exist
    const exists = await sessionExists(id);
    assert.equal(exists, true, 'Session socket should exist');
  } finally {
    await stopSession(id).catch(() => {});
    await server.stop();
  }
});

test('session: sendCommand() ping works', async () => {
  const server = new MockVNCServer({ width: 100, height: 100 });
  const { port } = await server.start();
  const id = uniqueId();

  try {
    await startSession(id, { host: '127.0.0.1', port, timeout: 5000 });
    const result = await sendCommand(id, { cmd: 'ping' });
    assert.equal(result.pong, true);
  } finally {
    await stopSession(id).catch(() => {});
    await server.stop();
  }
});

test('session: stopSession() cleans up socket and pid files', async () => {
  const server = new MockVNCServer({ width: 100, height: 100 });
  const { port } = await server.start();
  const id = uniqueId();

  try {
    await startSession(id, { host: '127.0.0.1', port, timeout: 5000 });

    // Confirm it's running
    assert.equal(await sessionExists(id), true);

    await stopSession(id);

    // Socket should be gone
    const afterStop = await sessionExists(id);
    assert.equal(afterStop, false, 'Socket should be removed after stop');
  } finally {
    await stopSession(id).catch(() => {});
    await server.stop();
  }
});

test('session: listSessions() returns active sessions', async () => {
  const server = new MockVNCServer({ width: 100, height: 100 });
  const { port } = await server.start();
  const id = uniqueId();

  try {
    await startSession(id, { host: '127.0.0.1', port, timeout: 5000 });
    const sessions = await listSessions();
    const found = sessions.some(s => s.id === id);
    assert.equal(found, true, 'Session should appear in list');
  } finally {
    await stopSession(id).catch(() => {});
    await server.stop();
  }
});

test('session: sessionExists() returns false for unknown session', async () => {
  const exists = await sessionExists('definitely-not-running-xxxx');
  assert.equal(exists, false);
});

test('session: sendCommand() info returns dimensions', async () => {
  const server = new MockVNCServer({ width: 320, height: 240 });
  const { port } = await server.start();
  const id = uniqueId();

  try {
    await startSession(id, { host: '127.0.0.1', port, timeout: 5000 });
    const info = await sendCommand(id, { cmd: 'info' });
    assert.equal(info.width,  320);
    assert.equal(info.height, 240);
  } finally {
    await stopSession(id).catch(() => {});
    await server.stop();
  }
});
