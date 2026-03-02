'use strict';

const net = require('net');
const EventEmitter = require('events');
const { vncEncrypt } = require('./des');

/**
 * Low-level RFB 3.8 protocol client.
 * Events: 'update', 'bell', 'disconnect', 'error'
 */
class RFBClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host     = options.host     || 'localhost';
    this.port     = options.port     || 5900;
    this.password = options.password || null;
    this._timeout = options.timeout  || 10000;

    this.width  = 0;
    this.height = 0;
    this.name   = '';

    this._socket    = null;
    this._connected = false;
    this._buffer    = Buffer.alloc(0);
    this._waiters   = [];        // [{needed, resolve}]
    this._pendingCapture = null; // {resolve, reject}
    this._captureTimer = null;   // timer for captureScreen timeout

    // framebuffer state maintained locally (RGBA)
    this._fb = null;
    this._updateCount = 0;
  }

  // ── Internal buffered reader ──────────────────────────────────────────────

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._drainWaiters();
  }

  _drainWaiters() {
    while (this._waiters.length > 0) {
      const w = this._waiters[0];
      if (this._buffer.length >= w.needed) {
        this._waiters.shift();
        const data = this._buffer.slice(0, w.needed);
        this._buffer = this._buffer.slice(w.needed);
        w.resolve(data);
      } else {
        break;
      }
    }
  }

  _read(n) {
    return new Promise((resolve, reject) => {
      if (!this._connected && this._buffer.length < n) {
        return reject(new Error('RFB socket closed'));
      }
      if (this._buffer.length >= n) {
        const data = this._buffer.slice(0, n);
        this._buffer = this._buffer.slice(n);
        return resolve(data);
      }

      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex(w => w.resolve === wrappedResolve);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(`RFB read timeout waiting for ${n} bytes`));
      }, this._timeout);
      const wrappedResolve = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
      const wrappedReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      this._waiters.push({ needed: n, resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  _rejectAllWaiters(err) {
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      w.reject(err);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      const connTimer = setTimeout(() => {
        reject(new Error('VNC connection timeout'));
        if (this._socket) this._socket.destroy();
      }, this._timeout);

      this._socket = net.createConnection({ host: this.host, port: this.port });

      this._socket.on('data', (chunk) => this._onData(chunk));

      this._socket.on('error', (err) => {
        clearTimeout(connTimer);
        this._connected = false;
        this.emit('error', err);
        reject(err);
      });

      this._socket.on('close', () => {
        clearTimeout(connTimer);
        this._connected = false;
        this._rejectAllWaiters(new Error('VNC socket closed'));
        this.emit('disconnect');
        // Reject any pending capture
        if (this._pendingCapture) {
          if (this._captureTimer) {
            clearTimeout(this._captureTimer);
            this._captureTimer = null;
          }
          this._pendingCapture.reject(new Error('VNC disconnected'));
          this._pendingCapture = null;
        }
      });

      this._socket.on('connect', async () => {
        try {
          this._connected = true;
          await this._handshake();
          clearTimeout(connTimer);
          // Start background message loop
          this._messageLoop().catch(err => {
            if (this._connected) this.emit('error', err);
          });
          resolve();
        } catch (err) {
          clearTimeout(connTimer);
          this._connected = false;
          this._socket.destroy();
          reject(err);
        }
      });
    });
  }

  disconnect() {
    this._connected = false;
    
    // Clear any pending capture timeout
    if (this._pendingCapture) {
      if (this._captureTimer) {
        clearTimeout(this._captureTimer);
        this._captureTimer = null;
      }
      this._pendingCapture.reject(new Error('VNC disconnected'));
      this._pendingCapture = null;
    }
    
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
  }

  // ── RFB Handshake ─────────────────────────────────────────────────────────

  async _handshake() {
    // 1. Server version
    const serverVer = await this._read(12);
    if (!serverVer.toString('ascii').startsWith('RFB ')) {
      throw new Error(`Invalid RFB version: ${serverVer.toString('ascii')}`);
    }

    // 2. Client version
    this._socket.write(Buffer.from('RFB 003.008\n', 'ascii'));

    // 3. Security types
    const numSecBuf = await this._read(1);
    const numSec = numSecBuf[0];
    if (numSec === 0) {
      const lenBuf = await this._read(4);
      const len = lenBuf.readUInt32BE(0);
      const msg = await this._read(len);
      throw new Error(`Server error: ${msg.toString('utf8')}`);
    }
    const secTypes = await this._read(numSec);

    // Choose security type
    let chosenType;
    if (this.password && Array.from(secTypes).includes(2)) {
      chosenType = 2;
    } else if (Array.from(secTypes).includes(1)) {
      chosenType = 1;
    } else {
      throw new Error('No supported security type available');
    }

    this._socket.write(Buffer.from([chosenType]));

    // 4. VNC auth challenge/response
    if (chosenType === 2) {
      const challenge = await this._read(16);
      const response = vncEncrypt(this.password || '', challenge);
      this._socket.write(response);
    }

    // 5. Security result (sent for all types in our implementation)
    const resultBuf = await this._read(4);
    const resultCode = resultBuf.readUInt32BE(0);
    if (resultCode !== 0) {
      let msg = 'Authentication failed';
      try {
        const lenBuf = await this._read(4);
        const len = lenBuf.readUInt32BE(0);
        if (len > 0 && len < 4096) {
          const msgBuf = await this._read(len);
          msg = msgBuf.toString('utf8');
        }
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }

    // 6. ClientInit (shared=1)
    this._socket.write(Buffer.from([1]));

    // 7. ServerInit
    const serverInit = await this._read(24);
    this.width  = serverInit.readUInt16BE(0);
    this.height = serverInit.readUInt16BE(2);
    // bytes 4-19: server pixel format (we'll override with SetPixelFormat)
    const nameLen = serverInit.readUInt32BE(20);
    const nameBuf = await this._read(nameLen);
    this.name = nameBuf.toString('utf8');

    // allocate internal framebuffer and reset counters
    this._fb = Buffer.alloc(this.width * this.height * 4);
    this._updateCount = 0;

    // 8. Set pixel format: 32-bit BGRA (LE: blue=0, green=8, red=16)
    this._sendSetPixelFormat();

    // 9. Set encodings: Raw (0) only
    this._sendSetEncodings([0]);
  }

  _sendSetPixelFormat() {
    const buf = Buffer.alloc(20);
    buf[0] = 0;   // message type: SetPixelFormat
    // buf[1..3] = 3 padding bytes
    buf[4]  = 32; // bits-per-pixel
    buf[5]  = 24; // depth
    buf[6]  = 0;  // big-endian-flag (0 = little-endian)
    buf[7]  = 1;  // true-colour-flag
    buf.writeUInt16BE(255, 8);  // red-max
    buf.writeUInt16BE(255, 10); // green-max
    buf.writeUInt16BE(255, 12); // blue-max
    buf[14] = 16; // red-shift
    buf[15] = 8;  // green-shift
    buf[16] = 0;  // blue-shift
    // buf[17..19] = 3 padding bytes
    this._socket.write(buf);
  }

  _sendSetEncodings(encodings) {
    const buf = Buffer.alloc(4 + encodings.length * 4);
    buf[0] = 2; // message type: SetEncodings
    // buf[1] = padding
    buf.writeUInt16BE(encodings.length, 2);
    for (let i = 0; i < encodings.length; i++) {
      buf.writeInt32BE(encodings[i], 4 + i * 4);
    }
    this._socket.write(buf);
  }

  // ── Client → Server messages ──────────────────────────────────────────────

  requestUpdate(incremental, x, y, w, h) {
    const buf = Buffer.alloc(10);
    buf[0] = 3; // FramebufferUpdateRequest
    buf[1] = incremental ? 1 : 0;
    buf.writeUInt16BE(x, 2);
    buf.writeUInt16BE(y, 4);
    buf.writeUInt16BE(w, 6);
    buf.writeUInt16BE(h, 8);
    this._socket.write(buf);
  }

  sendKey(keysym, down) {
    const buf = Buffer.alloc(8);
    buf[0] = 4; // KeyEvent
    buf[1] = down ? 1 : 0;
    // buf[2..3] = padding
    buf.writeUInt32BE(keysym >>> 0, 4);
    this._socket.write(buf);
  }

  sendPointer(x, y, buttons) {
    const buf = Buffer.alloc(6);
    buf[0] = 5; // PointerEvent
    buf[1] = buttons & 0xff;
    buf.writeUInt16BE(x, 2);
    buf.writeUInt16BE(y, 4);
    this._socket.write(buf);
  }

  /**
   * Capture the full screen. Sends a non-incremental FramebufferUpdateRequest
   * and resolves when the server responds with a complete update.
   * @returns {Promise<{width, height, rgba: Buffer}>}
   */
  captureScreen() {
    // newer implementation uses the maintained framebuffer for speed
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        return reject(new Error('Not connected'));
      }

      this._captureTimer = setTimeout(() => {
        this._pendingCapture = null;
        this._captureTimer = null;
        reject(new Error('captureScreen timeout'));
      }, this._timeout);

      this._pendingCapture = {
        resolve: (result) => { 
          if (this._captureTimer) {
            clearTimeout(this._captureTimer); 
            this._captureTimer = null;
          }
          resolve(result); 
        },
        reject:  (err)    => { 
          if (this._captureTimer) {
            clearTimeout(this._captureTimer); 
            this._captureTimer = null;
          }
          reject(err); 
        },
      };

      this.requestUpdate(false, 0, 0, this.width, this.height);
    });
  }

  // ── Server → Client message loop ─────────────────────────────────────────

  async _messageLoop() {
    while (this._connected) {
      let typeBuf;
      try {
        typeBuf = await this._read(1);
      } catch (e) {
        // Socket closed or timed out — exit loop quietly
        return;
      }

      const msgType = typeBuf[0];
      try {
        switch (msgType) {
          case 0: await this._handleFramebufferUpdate(); break;
          case 1: await this._handleColourMapEntries(); break;
          case 2: this.emit('bell'); break;
          case 3: await this._handleCutText(); break;
          default:
            this.emit('error', new Error(`Unknown server message type: ${msgType}`));
            this.disconnect();
            return;
        }
      } catch (e) {
        if (this._connected) this.emit('error', e);
        return;
      }
    }
  }

  async _handleFramebufferUpdate() {
    const header = await this._read(3); // padding(1) + nrects(2)
    const nrects = header.readUInt16BE(1);

    const rects = [];
    for (let i = 0; i < nrects; i++) {
      const rectHdr = await this._read(12); // x(2) y(2) w(2) h(2) encoding(4)
      const x        = rectHdr.readUInt16BE(0);
      const y        = rectHdr.readUInt16BE(2);
      const w        = rectHdr.readUInt16BE(4);
      const h        = rectHdr.readUInt16BE(6);
      const encoding = rectHdr.readInt32BE(8);

      if (encoding === 0) { // Raw
        const pixels = w * h > 0 ? await this._read(w * h * 4) : Buffer.alloc(0);
        rects.push({ x, y, w, h, data: pixels });
      } else {
        throw new Error(`Unsupported encoding: ${encoding}`);
      }
    }

    // apply updates to internal framebuffer and accumulate change metric
    if (this._fb) {
      let changed = 0;
      for (const rect of rects) {
        for (let row = 0; row < rect.h; row++) {
          for (let col = 0; col < rect.w; col++) {
            const src = (row * rect.w + col) * 4;
            const dst = ((rect.y + row) * this.width + (rect.x + col)) * 4;
            const newR = rect.data[src + 2];
            const newG = rect.data[src + 1];
            const newB = rect.data[src + 0];
            if (
              this._fb[dst + 0] !== newR ||
              this._fb[dst + 1] !== newG ||
              this._fb[dst + 2] !== newB
            ) {
              changed++;
            }
            this._fb[dst + 0] = newR;
            this._fb[dst + 1] = newG;
            this._fb[dst + 2] = newB;
            this._fb[dst + 3] = 255;
          }
        }
      }
      if (changed > 0 && this.width * this.height > 0) {
        this._updateCount += changed / (this.width * this.height);
      }
    }

    // Assemble RGBA frame if there is a pending captureScreen()
    if (this._pendingCapture) {
      const capture = this._pendingCapture;
      this._pendingCapture = null;
      
      if (this._captureTimer) {
        clearTimeout(this._captureTimer);
        this._captureTimer = null;
      }

      const rgba = this._fb ? Buffer.from(this._fb) : Buffer.alloc(0);
      capture.resolve({ width: this.width, height: this.height, rgba });
    }

    this.emit('update', { width: this.width, height: this.height, rects });
  }

  /**
   * Convert an array of raw rectangle updates into a full RGBA framebuffer.
   *
   * The rectangles represent pixels encoded as little-endian 32-bit BGR0
   * values.  The resulting buffer will be width*height*4 bytes with the
   * usual RGBA ordering and alpha set to 255.
   *
   * @param {Array<{x:number,y:number,w:number,h:number,data:Buffer}>} rects
   * @param {number} width
   * @param {number} height
   * @returns {Buffer}
   */
  static convertRawToRGBA(rects, width, height) {
    const rgba = Buffer.alloc(width * height * 4);
    for (const rect of rects) {
      for (let row = 0; row < rect.h; row++) {
        for (let col = 0; col < rect.w; col++) {
          const src = (row * rect.w + col) * 4;
          const dst = ((rect.y + row) * width + (rect.x + col)) * 4;
          rgba[dst + 0] = rect.data[src + 2]; // R
          rgba[dst + 1] = rect.data[src + 1]; // G
          rgba[dst + 2] = rect.data[src + 0]; // B
          rgba[dst + 3] = 255;                // A
        }
      }
    }
    return rgba;
  }

  async _handleColourMapEntries() {
    const hdr = await this._read(5); // padding(1) + first-colour(2) + num-colours(2)
    const nColours = hdr.readUInt16BE(3);
    if (nColours > 0) await this._read(nColours * 6);
  }

  async _handleCutText() {
    const hdr = await this._read(7); // padding(3) + length(4)
    const len = hdr.readUInt32BE(3);
    if (len > 0) await this._read(len);
  }

  /**
   * Number of screen‑sized updates received (may be fractional).
   * @type {number}
   */
  get updateCount() {
    return this._updateCount;
  }

  /**
   * Return a copy of the current RGBA framebuffer. May be null until the
   * first update arrives.
   * @returns {Buffer|null}
   */
  get screenshotRaw() {
    return this._fb ? Buffer.from(this._fb) : null;
  }
}

module.exports = { RFBClient };
