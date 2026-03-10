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

test('RFB: startScreenBuffering + captureScreen returns correct dimensions and RGBA data', async () => {
  await withServer(
    { width: 80, height: 60, bgColor: { r: 255, g: 0, b: 0 } },
    {},
    async (client) => {
      await client.connect();
      const screen = await client.startScreenBuffering();
      const frame  = screen.captureScreen();   // synchronous
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
      // screenshotRaw should reflect the same data (also synchronous)
      const raw = screen.screenshotRaw();
      assert.ok(raw);
      assert.equal(raw.length, frame.rgba.length);
      assert.deepEqual(Array.from(raw), Array.from(frame.rgba));
    },
  );
});

// verify that startScreenBuffering issues exactly one request, and that
// the synchronous captureScreen() on the returned ScreenBuffer does not
// issue additional requests.
test('RFB: startScreenBuffering caches screen buffer', async () => {
  await withServer(
    { width: 50, height: 40 },
    {},
    async (client, server) => {
      await client.connect();
      const screen = await client.startScreenBuffering();
      const count  = server.events.filter(e => e.type === 'fbupdatereq').length;
      assert.equal(count, 1, 'startScreenBuffering should issue exactly one request');

      // captureScreen() is synchronous — no new network request
      screen.captureScreen();
      const count2 = server.events.filter(e => e.type === 'fbupdatereq').length;
      assert.equal(count2, count, 'captureScreen should not issue additional requests');
    },
  );
});

// verify the conversion helper independently of the networking code
test('RFB: convertRawToRGBA helper produces correct pixels', () => {
  // prepare a small 2x2 framebuffer with two rectangles
  // first rect at (0,0) width=2 height=1, pixels: blue, green
  const rects = [
    {
      x: 0, y: 0, w: 2, h: 1,
      data: Buffer.from([
        /* pixel0 BGR */ 255, 0, 0, 0,
        /* pixel1 BGR */ 0, 255, 0, 0,
      ]),
    },
    // second rect at (0,1) width=2 height=1, pixels: red, black
    {
      x: 0, y: 1, w: 2, h: 1,
      data: Buffer.from([
        /* pixel2 BGR */ 0, 0, 255, 0,
        /* pixel3 BGR */ 0, 0, 0, 0,
      ]),
    },
  ];
  const rgba = RFBClient.convertRawToRGBA(rects, 2, 2);
  assert.equal(rgba.length, 2 * 2 * 4);
  // expected order: row0 pixels then row1 pixels
  const expected = [
    // row0
    0,   0, 255, 255, // blue -> (BGR->RGB)
    0, 255,   0, 255, // green
    // row1
    255, 0,   0, 255, // red
    0,   0,   0, 255, // black
  ];
  assert.deepEqual(Array.from(rgba), expected);
});

test('RFB: updateCount and screenshotRaw behave correctly', async () => {
  await withServer(
    { width: 40, height: 20, bgColor: { r: 10, g: 20, b: 30 } },
    {},
    async (client, server) => {
      await client.connect();
      const screen  = await client.startScreenBuffering();
      const initial = screen.screenshotRaw();   // synchronous
      assert.ok(initial);
      assert.equal(initial.length, 40 * 20 * 4);
      const baseline = screen.updateCount;

      // change server colour so half update will show changes
      server.bgColor = { r: 11, g: 21, b: 31 };

      // request half-width update
      client.requestUpdate(true, 0, 0, 20, 20);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(screen.updateCount > baseline && screen.updateCount < baseline + 1);

      const buf = screen.screenshotRaw();   // synchronous
      // left half should be the new bgColor
      for (let row = 0; row < 20; row++) {
        for (let col = 0; col < 20; col++) {
          const off = (row * 40 + col) * 4;
          assert.equal(buf[off + 0], 11);
          assert.equal(buf[off + 1], 21);
          assert.equal(buf[off + 2], 31);
          assert.equal(buf[off + 3], 255);
        }
      }
      // right half should remain the original bgColor from the
      // initial full-capture (10,20,30).
      for (let row = 0; row < 20; row++) {
        for (let col = 20; col < 40; col++) {
          const off = (row * 40 + col) * 4;
          assert.equal(buf[off + 0], 10);
          assert.equal(buf[off + 1], 20);
          assert.equal(buf[off + 2], 30);
        }
      }

      // full update only changes the right half (left half already
      // bgColor).  since updateCount is cumulative we'll just make sure it
      // increases by less than a full screen's worth of change.
      const baseline2 = screen.updateCount;
      client.requestUpdate(true, 0, 0, 40, 20);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(screen.updateCount > baseline2 && screen.updateCount < baseline2 + 1);
    },
  );
});

// ensure that once connected the client continues to request updates
// automatically, and that the server sees an initial non-incremental
// request followed by incremental ones.
test('RFB: automatic update loop after connect', async () => {
  await withServer(
    { width: 20, height: 10 },
    {},
    async (client, server) => {
      await client.connect();

      let seen = 0;
      client.on('update', () => { seen++; });

      // give the client a short moment to collect a few updates
      await new Promise(r => setTimeout(r, 100));

      assert.ok(seen >= 2, 'should receive multiple update events');

      const fbreqs = server.events.filter(e => e.type === 'fbupdatereq');
      assert.ok(fbreqs.length >= 2, 'server should have gotten several requests');
      assert.equal(fbreqs[0].incremental, 0, 'first request non-incremental');
      for (let i = 1; i < fbreqs.length; i++) {
        assert.equal(fbreqs[i].incremental, 1, `request ${i} should be incremental`);
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
