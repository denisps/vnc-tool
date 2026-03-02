'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { VNCClient }    = require('../lib/client');
const { MockVNCServer } = require('./mock-server');

async function withClient(serverOpts, fn) {
  const server = new MockVNCServer(serverOpts);
  const { port } = await server.start();
  const client = new VNCClient({ host: '127.0.0.1', port, timeout: 5000 });
  try {
    await client.connect();
    await fn(client, server);
  } finally {
    await client.disconnect();
    await server.stop();
  }
}

test('client: screenshot() returns a PNG buffer', async () => {
  await withClient({ width: 64, height: 48 }, async (client) => {
    const png = await client.screenshot();
    // PNG signature starts with these bytes
    assert.equal(png[0], 137);
    assert.equal(png[1], 80);  // 'P'
    assert.equal(png[2], 78);  // 'N'
    assert.equal(png[3], 71);  // 'G'
    assert.ok(png.length > 50, 'PNG should have reasonable size');
  });
});

test('client: screenshot() writes to file', async () => {
  const tmpFile = `/tmp/vnc-test-screenshot-${Date.now()}.png`;
  const fs = require('fs');
  try {
    await withClient({ width: 32, height: 32 }, async (client) => {
      await client.screenshot(tmpFile);
      const stat = fs.statSync(tmpFile);
      assert.ok(stat.size > 50, 'File should have PNG data');
      const data = fs.readFileSync(tmpFile);
      assert.equal(data[0], 137);
      assert.equal(data[1], 80);
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

test('client: updateCount and screenshotRaw mirror RFB state', async () => {
  await withClient({ width: 20, height: 10, bgColor: { r: 1, g: 2, b: 3 } }, async (client, server) => {
    assert.equal(client.updateCount, 0);
    assert.ok(client.screenshotRaw);
    assert.equal(client.screenshotRaw.length, 20 * 10 * 4);
    // trigger a partial update
    client._rfb.requestUpdate(true, 0, 0, 10, 10);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(client.updateCount > 0 && client.updateCount < 1);
    const buf = client.screenshotRaw;
    // left half should equal bgColor
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const off = (y * 20 + x) * 4;
        assert.equal(buf[off + 0], 1);
        assert.equal(buf[off + 1], 2);
        assert.equal(buf[off + 2], 3);
      }
    }
  });
});

test('client: mouseClick() sends pointer down then up', async () => {
  await withClient({ width: 800, height: 600 }, async (client, server) => {
    await client.mouseClick(200, 300, 'left');
    await new Promise(r => setTimeout(r, 100));

    const events = server.events.filter(e => e.type === 'pointer');
    assert.ok(events.length >= 2, 'Should send at least 2 pointer events');
    const down = events.find(e => e.buttons === 0x01);
    const up   = events.find(e => e.buttons === 0x00);
    assert.ok(down, 'Should have button-down event');
    assert.ok(up,   'Should have button-up event');
    assert.equal(down.x, 200);
    assert.equal(down.y, 300);
  });
});

test('client: mouseMove() sends pointer event', async () => {
  await withClient({ width: 800, height: 600 }, async (client, server) => {
    await client.mouseMove(400, 500);
    await new Promise(r => setTimeout(r, 50));

    const ev = server.getLastEvent('pointer');
    assert.ok(ev, 'Should have pointer event');
    assert.equal(ev.x, 400);
    assert.equal(ev.y, 500);
    assert.equal(ev.buttons, 0);
  });
});

test('client: type() sends key events for each character', async () => {
  await withClient({ width: 800, height: 600 }, async (client, server) => {
    await client.type('hi');
    await new Promise(r => setTimeout(r, 100));

    const keyEvents = server.events.filter(e => e.type === 'key');
    assert.ok(keyEvents.length >= 4, 'Should have key-down and key-up for each char');

    const hDown = keyEvents.find(e => e.keysym === 'h'.codePointAt(0) && e.down);
    const iDown = keyEvents.find(e => e.keysym === 'i'.codePointAt(0) && e.down);
    assert.ok(hDown, 'Should have key-down for "h"');
    assert.ok(iDown, 'Should have key-down for "i"');
  });
});

test('client: keyPress() with ctrl+c sends modifier + key', async () => {
  await withClient({ width: 800, height: 600 }, async (client, server) => {
    await client.keyPress('ctrl+c');
    await new Promise(r => setTimeout(r, 100));

    const keyEvents = server.events.filter(e => e.type === 'key');
    // Should have: ctrl down, c down, c up, ctrl up
    const ctrlDown = keyEvents.find(e => e.keysym === 0xffe3 && e.down);
    const cDown    = keyEvents.find(e => e.keysym === 'c'.codePointAt(0) && e.down);
    const ctrlUp   = keyEvents.find(e => e.keysym === 0xffe3 && !e.down);
    assert.ok(ctrlDown, 'ctrl should be pressed');
    assert.ok(cDown,    '"c" should be pressed');
    assert.ok(ctrlUp,   'ctrl should be released');
  });
});

test('client: delay() waits approximately the right time', async () => {
  await withClient({ width: 100, height: 100 }, async (client) => {
    const start = Date.now();
    await client.delay(150);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 120, `delay should be >= 120ms, got ${elapsed}`);
    assert.ok(elapsed < 500,  `delay should be < 500ms, got ${elapsed}`);
  });
});

test('client: run() executes batch commands', async () => {
  await withClient({ width: 800, height: 600 }, async (client) => {
    const results = await client.run([
      { cmd: 'delay', ms: 10 },
      { cmd: 'move', x: 100, y: 200 },
      { cmd: 'delay', ms: 10 },
    ]);
    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.ok === true));
  });
});
