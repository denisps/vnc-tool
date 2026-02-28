'use strict';

/**
 * Mock VNC server for testing. Implements RFB 3.8 protocol.
 */

const net    = require('net');
const crypto = require('crypto');
const { vncEncrypt } = require('../lib/des');

/**
 * Create a buffered reader for a socket.
 */
function createReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let closed = false;
  let closeErr = null;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (waiters.length > 0 && buffer.length >= waiters[0].n) {
      const { n, resolve } = waiters.shift();
      const data = buffer.slice(0, n);
      buffer = buffer.slice(n);
      resolve(data);
    }
  });

  socket.on('close', () => {
    closed = true;
    const err = new Error('Socket closed');
    const pending = waiters.splice(0);
    for (const w of pending) w.reject(err);
  });

  socket.on('error', (err) => {
    closeErr = err;
    const pending = waiters.splice(0);
    for (const w of pending) w.reject(err);
  });

  return function read(n) {
    if (buffer.length >= n) {
      const data = buffer.slice(0, n);
      buffer = buffer.slice(n);
      return Promise.resolve(data);
    }
    if (closed) return Promise.reject(closeErr || new Error('Socket closed'));

    return new Promise((resolve, reject) => {
      waiters.push({ n, resolve, reject });
    });
  };
}

class MockVNCServer {
  /**
   * @param {{ port?, password?, width?, height?, bgColor? }} options
   *   bgColor: { r, g, b } (default: { r:0, g:128, b:255 })
   */
  constructor(options = {}) {
    this.password = options.password || null;
    this.width    = options.width    || 800;
    this.height   = options.height   || 600;
    this.bgColor  = options.bgColor  || { r: 0, g: 128, b: 255 };
    this._port    = options.port     || 0;

    this._server  = null;
    this.events   = [];
    this._sockets = new Set();
  }

  /**
   * Start the server. Returns { port }.
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        this._sockets.add(socket);
        socket.on('close', () => this._sockets.delete(socket));
        this._handleConnection(socket);
      });

      this._server.once('error', reject);
      this._server.listen(this._port, '127.0.0.1', () => {
        const { port } = this._server.address();
        this._port = port;
        resolve({ port });
      });
    });
  }

  /**
   * Stop the server and close all connections.
   */
  stop() {
    return new Promise((resolve) => {
      for (const s of this._sockets) {
        try { s.destroy(); } catch (_) {}
      }
      this._sockets.clear();
      if (this._server) {
        this._server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getLastEvent(type) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === type) return this.events[i];
    }
    return null;
  }

  // ── RFB connection handler ──────────────────────────────────────────────────

  _handleConnection(socket) {
    (async () => {
      const read = createReader(socket);

      try {
        // 1. Send server version
        socket.write('RFB 003.008\n');

        // 2. Read client version (12 bytes)
        await read(12);

        // 3. Send security types
        if (this.password) {
          // Offer VNC auth (type 2)
          socket.write(Buffer.from([1, 2]));
        } else {
          // Offer None (type 1)
          socket.write(Buffer.from([1, 1]));
        }

        // 4. Read client security choice
        const secChoice = await read(1);
        const chosenType = secChoice[0];

        if (chosenType === 2) {
          // VNC auth
          const challenge = crypto.randomBytes(16);
          socket.write(challenge);

          const response = await read(16);
          const expected = vncEncrypt(this.password, challenge);

          if (response.equals(expected)) {
            socket.write(Buffer.from([0, 0, 0, 0])); // SecurityResult OK
          } else {
            const msg = Buffer.from('Authentication failed');
            const result = Buffer.alloc(8);
            result.writeUInt32BE(1, 0);         // SecurityResult: fail
            result.writeUInt32BE(msg.length, 4);
            socket.write(Buffer.concat([result, msg]));
            socket.end();
            return;
          }
        } else if (chosenType === 1) {
          // None — send SecurityResult OK (we always do this for consistency)
          socket.write(Buffer.from([0, 0, 0, 0]));
        }

        // 5. Read ClientInit
        await read(1);

        // 6. Send ServerInit
        socket.write(this._buildServerInit());

        // 7. Message loop
        while (true) {
          const typeBuf = await read(1);
          const msgType = typeBuf[0];

          switch (msgType) {
            case 0: { // SetPixelFormat
              await read(19); // 3 padding + 16 pixel-format
              break;
            }
            case 2: { // SetEncodings
              const hdr = await read(3); // 1 padding + 2 num-encodings
              const n   = hdr.readUInt16BE(1);
              if (n > 0) await read(n * 4);
              break;
            }
            case 3: { // FramebufferUpdateRequest
              const req = await read(9); // incremental(1) x(2) y(2) w(2) h(2)
              const incr = req[0];
              const x = req.readUInt16BE(1);
              const y = req.readUInt16BE(3);
              const w = req.readUInt16BE(5);
              const h = req.readUInt16BE(7);
              this.events.push({ type: 'fbupdatereq', incremental: incr, x, y, w, h });
              // Always respond with a full solid-color frame
              this._sendFramebufferUpdate(socket, x, y, w, h);
              break;
            }
            case 4: { // KeyEvent
              const kev = await read(7); // down(1) padding(2) keysym(4)
              const down   = kev[0] === 1;
              const keysym = kev.readUInt32BE(3);
              this.events.push({ type: 'key', down, keysym });
              break;
            }
            case 5: { // PointerEvent
              const pev = await read(5); // buttons(1) x(2) y(2)
              const buttons = pev[0];
              const px = pev.readUInt16BE(1);
              const py = pev.readUInt16BE(3);
              this.events.push({ type: 'pointer', buttons, x: px, y: py });
              break;
            }
            case 6: { // ClientCutText
              const hdr = await read(7); // 3 padding + length(4)
              const len = hdr.readUInt32BE(3);
              if (len > 0) await read(len);
              break;
            }
            default:
              // Unknown message — close
              socket.destroy();
              return;
          }
        }
      } catch (_) {
        // Connection closed or error — clean up
        if (!socket.destroyed) socket.destroy();
      }
    })();
  }

  _buildServerInit() {
    const name     = Buffer.from('MockVNC', 'utf8');
    const buf      = Buffer.alloc(24 + name.length);
    buf.writeUInt16BE(this.width,  0);
    buf.writeUInt16BE(this.height, 2);

    // Pixel format: 32bpp, depth 24, little-endian, true-colour
    // blue@shift0, green@shift8, red@shift16  (matches client SetPixelFormat)
    buf[4]  = 32;  // bits-per-pixel
    buf[5]  = 24;  // depth
    buf[6]  = 0;   // big-endian
    buf[7]  = 1;   // true-colour
    buf.writeUInt16BE(255, 8);   // red-max
    buf.writeUInt16BE(255, 10);  // green-max
    buf.writeUInt16BE(255, 12);  // blue-max
    buf[14] = 16;  // red-shift
    buf[15] = 8;   // green-shift
    buf[16] = 0;   // blue-shift
    // buf[17..19] = padding

    buf.writeUInt32BE(name.length, 20);
    name.copy(buf, 24);
    return buf;
  }

  _sendFramebufferUpdate(socket, x, y, w, h) {
    // FramebufferUpdate header: type(1) padding(1) nrects(2)
    const hdr = Buffer.alloc(4);
    hdr[0] = 0; // FramebufferUpdate
    hdr.writeUInt16BE(1, 2); // 1 rect

    // Rect header: x(2) y(2) w(2) h(2) encoding(4)
    const rectHdr = Buffer.alloc(12);
    rectHdr.writeUInt16BE(x, 0);
    rectHdr.writeUInt16BE(y, 2);
    rectHdr.writeUInt16BE(w, 4);
    rectHdr.writeUInt16BE(h, 6);
    rectHdr.writeInt32BE(0, 8); // Raw encoding

    // Pixel data: solid colour in BGRX format (LE: byte[0]=B, [1]=G, [2]=R, [3]=0)
    const pixelCount = w * h;
    const pixels = Buffer.alloc(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      pixels[i * 4 + 0] = this.bgColor.b; // blue
      pixels[i * 4 + 1] = this.bgColor.g; // green
      pixels[i * 4 + 2] = this.bgColor.r; // red
      pixels[i * 4 + 3] = 0;              // padding
    }

    socket.write(Buffer.concat([hdr, rectHdr, pixels]));
  }
}

module.exports = { MockVNCServer };
