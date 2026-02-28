'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { RFBClient }    = require('../lib/rfb');
const { MockVNCServer } = require('./mock-server');

// Helper: create server + client, run fn, then clean up
async function withServer(serverOpts, clientOpts, fn) {
  const server = new MockVNCServer(serverOpts);
  const { port } = await server.start();
  const client = new RFBClient({ host: '127.0.0.1', port, timeout: 5000, ...clientOpts });
  try {
    await fn(client, server);
  } finally {
    client.disconnect();
    await server.stop();
  }
}

test('RFB: connect to mock server with no auth', async () => {
  await withServer(
    { width: 320, height: 240 },
    {},
    async (client, server) => {
      await client.connect();
      assert.equal(client.width,  320);
      assert.equal(client.height, 240);
      assert.equal(client.name,   'MockVNC');
    },
  );
});

test('RFB: connect with VNC auth', async () => {
  await withServer(
    { width: 100, height: 100, password: 'secret' },
    { password: 'secret' },
    async (client) => {
      await client.connect();
      assert.equal(client.width,  100);
      assert.equal(client.height, 100);
    },
  );
});

test('RFB: VNC auth with wrong password fails', async () => {
  const server = new MockVNCServer({ width: 100, height: 100, password: 'correct' });
  const { port } = await server.start();
  const client = new RFBClient({ host: '127.0.0.1', port, password: 'wrong', timeout: 5000 });
  try {
    await assert.rejects(
      () => client.connect(),
      (err) => {
        assert.ok(err.message, 'Should have error message');
        return true;
      },
    );
  } finally {
    client.disconnect();
    await server.stop();
  }
});

test('RFB: captureScreen returns correct dimensions and RGBA data', async () => {
  await withServer(
    { width: 80, height: 60, bgColor: { r: 255, g: 0, b: 0 } },
    {},
    async (client) => {
      await client.connect();
      const frame = await client.captureScreen();
      assert.equal(frame.width,  80);
      assert.equal(frame.height, 60);
      assert.equal(frame.rgba.length, 80 * 60 * 4);

      // bgColor = red → RGBA pixels should be R=255, G=0, B=0, A=255
      for (let i = 0; i < 10; i++) {
        const off = i * 4;
        assert.equal(frame.rgba[off + 0], 255, `pixel ${i} R`);
        assert.equal(frame.rgba[off + 1],   0, `pixel ${i} G`);
        assert.equal(frame.rgba[off + 2],   0, `pixel ${i} B`);
        assert.equal(frame.rgba[off + 3], 255, `pixel ${i} A`);
      }
    },
  );
});

test('RFB: sendKey records event in mock server', async () => {
  await withServer(
    { width: 100, height: 100 },
    {},
    async (client, server) => {
      await client.connect();
      client.sendKey(0x41, true);  // 'A' down
      client.sendKey(0x41, false); // 'A' up
      // Give the mock server time to process
      await new Promise(r => setTimeout(r, 100));

      const ev = server.getLastEvent('key');
      assert.ok(ev, 'Should have received a key event');
      assert.equal(ev.keysym, 0x41);
    },
  );
});

test('RFB: sendPointer records event in mock server', async () => {
  await withServer(
    { width: 800, height: 600 },
    {},
    async (client, server) => {
      await client.connect();
      client.sendPointer(123, 456, 0x01); // left button
      await new Promise(r => setTimeout(r, 100));

      const ev = server.getLastEvent('pointer');
      assert.ok(ev, 'Should have received a pointer event');
      assert.equal(ev.x, 123);
      assert.equal(ev.y, 456);
      assert.equal(ev.buttons, 0x01);
    },
  );
});

test('RFB: disconnect cleans up', async () => {
  const server = new MockVNCServer({ width: 100, height: 100 });
  const { port } = await server.start();
  const client = new RFBClient({ host: '127.0.0.1', port, timeout: 5000 });
  await client.connect();

  let disconnected = false;
  client.on('disconnect', () => { disconnected = true; });

  client.disconnect();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(disconnected, true);
  await server.stop();
});
