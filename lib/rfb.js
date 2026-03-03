'use strict';

const net = require('net');
const EventEmitter = require('events');
const { vncEncrypt } = require('./des');

// ── ScreenBuffer ─────────────────────────────────────────────────────────────

/**
 * A live view of the RFB client's internal RGBA framebuffer.
 *
 * Returned by {@link RFBClient#startScreenBuffering} once the first full
 * screen update has been received.  All methods are **synchronous** — no
 * round-trip to the server is needed after buffering has started.
 */
class ScreenBuffer {
  /** @param {RFBClient} rfb */
  constructor(rfb) {
    this._rfb = rfb;
  }

  /** Display width in pixels. */
  get width()  { return this._rfb.width; }

  /** Display height in pixels. */
  get height() { return this._rfb.height; }

  /**
   * Monotonically increasing change counter (see {@link RFBClient#updateCount}).
   * @type {number}
   */
  get updateCount() { return this._rfb.updateCount; }

  /**
   * Return a snapshot of the current framebuffer as `{width, height, rgba}`.
   * `rgba` is a **copy** of the internal buffer so it is safe to retain.
   * @returns {{ width: number, height: number, rgba: Buffer }}
   */
  captureScreen() {
    const { width, height } = this._rfb;
    return { width, height, rgba: Buffer.from(this._rfb._fb) };
  }

  /**
   * Return a **copy** of the raw RGBA framebuffer.
   * @returns {Buffer}
   */
  screenshotRaw() {
    return Buffer.from(this._rfb._fb);
  }
}

// ── RFBClient ─────────────────────────────────────────────────────────────────

/**
 * Low-level RFB 3.8 protocol client.
 * Events: `'update'`, `'bell'`, `'disconnect'`, `'error'`
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
    this._waiters   = [];  // [{needed, resolve, reject}]

    // Framebuffer — null until startScreenBuffering() is called.
    this._fb          = null;
    this._updateCount = 0;

    // Transient handles used during startScreenBuffering().
    this._firstScreenResolve    = null;
    this._firstScreenReject     = null;
    this._startBufferingPromise = null;
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
        this._rejectBuffering(new Error('VNC disconnected'));
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
    this._rejectBuffering(new Error('VNC disconnected'));
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
    // bytes 4-19: server pixel format (overridden by SetPixelFormat below)
    const nameLen = serverInit.readUInt32BE(20);
    const nameBuf = await this._read(nameLen);
    this.name = nameBuf.toString('utf8');

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
   * Allocate the internal framebuffer, request the first full-screen update,
   * and resolve with a {@link ScreenBuffer} once that update has been applied.
   *
   * Calling this is **optional** — omit it for one-shot commands (key presses,
   * mouse clicks, etc.) that do not need pixel data. This avoids the cost of
   * allocating and populating a potentially large buffer.
   *
   * Concurrent or repeated calls are safe: if buffering is already active a
   * new `ScreenBuffer` view is returned immediately without issuing another
   * network request.
   *
   * @returns {Promise<ScreenBuffer>}
   */
  async startScreenBuffering() {
    if (!this._connected) throw new Error('Not connected');

    // Already populated — hand back a fresh view with zero cost.
    if (this._fb) return new ScreenBuffer(this);

    // Guard against concurrent callers racing through this path.
    if (this._startBufferingPromise) return this._startBufferingPromise;

    this._fb          = Buffer.alloc(this.width * this.height * 4);
    this._updateCount = 0;

    this._startBufferingPromise = new Promise((resolve, reject) => {
      this._firstScreenResolve = () => {
        this._startBufferingPromise = null;
        resolve(new ScreenBuffer(this));
      };
      this._firstScreenReject = (err) => {
        this._fb                    = null;
        this._startBufferingPromise = null;
        reject(err);
      };
    });

    this.requestUpdate(false, 0, 0, this.width, this.height);
    return this._startBufferingPromise;
  }

  /** Reject any in-flight startScreenBuffering() promise and clear handles. */
  _rejectBuffering(err) {
    if (this._firstScreenReject) {
      this._firstScreenReject(err);
      this._firstScreenResolve = null;
      this._firstScreenReject  = null;
    }
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
      const rectHdr  = await this._read(12); // x(2) y(2) w(2) h(2) encoding(4)
      const x        = rectHdr.readUInt16BE(0);
      const y        = rectHdr.readUInt16BE(2);
      const w        = rectHdr.readUInt16BE(4);
      const h        = rectHdr.readUInt16BE(6);
      const encoding = rectHdr.readInt32BE(8);

      if (encoding !== 0) throw new Error(`Unsupported encoding: ${encoding}`);
      const data = w * h > 0 ? await this._read(w * h * 4) : Buffer.alloc(0);
      rects.push({ x, y, w, h, data });
    }

    if (this._fb) {
      let changed = 0;
      for (const rect of rects) changed += this._applyRect(rect);
      if (changed > 0 && this.width * this.height > 0) {
        this._updateCount += changed / (this.width * this.height);
      }
    }

    // Resolve any pending startScreenBuffering() call on the first update.
    if (this._firstScreenResolve) {
      const resolve = this._firstScreenResolve;
      this._firstScreenResolve = null;
      this._firstScreenReject  = null;
      resolve();
    }

    this.emit('update', { width: this.width, height: this.height, rects });
  }

  /**
   * Blit one raw BGR0 rectangle into the RGBA framebuffer.
   * @returns {number} number of changed pixels
   */
  _applyRect({ x, y, w, h, data }) {
    let changed = 0;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const src = (row * w + col) * 4;
        const dst = ((y + row) * this.width + (x + col)) * 4;
        const r = data[src + 2];
        const g = data[src + 1];
        const b = data[src + 0];
        if (this._fb[dst] !== r || this._fb[dst + 1] !== g || this._fb[dst + 2] !== b) changed++;
        this._fb[dst]     = r;
        this._fb[dst + 1] = g;
        this._fb[dst + 2] = b;
        this._fb[dst + 3] = 255;
      }
    }
    return changed;
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
   *
   * Each rectangle contributes `changed_pixels / (width*height)` to the
   * counter.  Only incremented while screen buffering is active.
   * @type {number}
   */
  get updateCount() {
    return this._updateCount;
  }
}

module.exports = { RFBClient, ScreenBuffer };
