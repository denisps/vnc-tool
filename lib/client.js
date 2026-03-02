'use strict';

const fs = require('fs');
const { RFBClient } = require('./rfb');
const { encodePNG } = require('./png');
const { parseKeyCombo } = require('./keys');

/**
 * High-level VNC client API.
 */
class VNCClient {
  constructor(options = {}) {
    this._options = {
      host:     options.host     || 'localhost',
      port:     options.port     || 5900,
      password: options.password || null,
      timeout:  options.timeout  || 10000,
    };
    this._rfb = null;
  }

  get width()  { return this._rfb ? this._rfb.width  : 0; }
  get height() { return this._rfb ? this._rfb.height : 0; }

  async connect() {
    this._rfb = new RFBClient(this._options);
    // avoid unhandled 'error' events bubbling to process during startup
    this._rfb.on('error', () => {});
    await this._rfb.connect();
  }

  /**
   * Total update count from underlying RFB client.
   */
  get updateCount() {
    return this._rfb ? this._rfb.updateCount : 0;
  }

  /**
   * Access raw RGBA framebuffer maintained by RFB client.
   */
  get screenshotRaw() {
    return this._rfb ? this._rfb.screenshotRaw : null;
  }

  async disconnect() {
    if (this._rfb) {
      this._rfb.disconnect();
      this._rfb = null;
    }
  }

  /**
   * Capture screen and return PNG buffer.
   * Optionally write to outputPath.
   */
  async screenshot(outputPath) {
    // Prefer using the buffered framebuffer if we've already received at least
    // one update; otherwise perform a capture to populate it.
    let rgba, width, height;
    if (
      this._rfb &&
      this._rfb.screenshotRaw &&
      this._rfb.updateCount > 0
    ) {
      rgba   = this._rfb.screenshotRaw;
      width  = this._rfb.width;
      height = this._rfb.height;
    } else {
      const frame = await this._rfb.captureScreen();
      rgba   = frame.rgba;
      width  = frame.width;
      height = frame.height;
    }
    const png = encodePNG(width, height, rgba);
    if (outputPath) {
      await fs.promises.writeFile(outputPath, png);
    }
    return png;
  }

  async mouseMove(x, y) {
    this._rfb.sendPointer(x, y, 0);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {'left'|'right'|'middle'} button
   */
  async mouseClick(x, y, button) {
    const mask = this._buttonMask(button || 'left');
    this._rfb.sendPointer(x, y, mask);
    await this._smallDelay();
    this._rfb.sendPointer(x, y, 0);
  }

  async mouseDown(x, y, button) {
    const mask = this._buttonMask(button || 'left');
    this._rfb.sendPointer(x, y, mask);
  }

  async mouseUp(x, y, button) {
    this._rfb.sendPointer(x, y, 0);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} amount positive = scroll down, negative = scroll up
   */
  async mouseScroll(x, y, amount) {
    const steps = Math.abs(amount || 1);
    // bit 3 (0x08) = button 4 (scroll up), bit 4 (0x10) = button 5 (scroll down)
    const btn = amount < 0 ? 0x08 : 0x10;
    for (let i = 0; i < steps; i++) {
      this._rfb.sendPointer(x, y, btn);
      await this._smallDelay();
      this._rfb.sendPointer(x, y, 0);
      if (i < steps - 1) await this._smallDelay();
    }
  }

  /**
   * Type a text string by sending key-down / key-up for each character.
   */
  async type(text) {
    for (const ch of text) {
      const keysym = ch.codePointAt(0);
      this._rfb.sendKey(keysym, true);
      await this._smallDelay();
      this._rfb.sendKey(keysym, false);
      await this._smallDelay();
    }
  }

  /**
   * Press and release a key combo like "ctrl+c".
   */
  async keyPress(combo) {
    const { modifiers, key } = parseKeyCombo(combo);
    // Press modifiers
    for (const mod of modifiers) {
      this._rfb.sendKey(mod, true);
      await this._smallDelay();
    }
    // Press + release key
    this._rfb.sendKey(key, true);
    await this._smallDelay();
    this._rfb.sendKey(key, false);
    await this._smallDelay();
    // Release modifiers in reverse
    for (let i = modifiers.length - 1; i >= 0; i--) {
      this._rfb.sendKey(modifiers[i], false);
      await this._smallDelay();
    }
  }

  async keyDown(key) {
    const { key: keysym } = parseKeyCombo(key);
    this._rfb.sendKey(keysym, true);
  }

  async keyUp(key) {
    const { key: keysym } = parseKeyCombo(key);
    this._rfb.sendKey(keysym, false);
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Run an array of command objects.
   * Each object: { cmd: 'screenshot'|'click'|'move'|..., ...args }
   */
  async run(commands) {
    const results = [];
    for (const item of commands) {
      let result = null;
      switch (item.cmd) {
        case 'screenshot':
          result = await this.screenshot(item.file || null);
          break;
        case 'click':
          await this.mouseClick(item.x, item.y, item.button);
          break;
        case 'move':
          await this.mouseMove(item.x, item.y);
          break;
        case 'mousedown':
          await this.mouseDown(item.x, item.y, item.button);
          break;
        case 'mouseup':
          await this.mouseUp(item.x, item.y, item.button);
          break;
        case 'scroll':
          await this.mouseScroll(item.x, item.y, item.amount !== undefined ? item.amount : 3);
          break;
        case 'type':
          await this.type(item.text);
          break;
        case 'key':
          await this.keyPress(item.combo);
          break;
        case 'keydown':
          await this.keyDown(item.key);
          break;
        case 'keyup':
          await this.keyUp(item.key);
          break;
        case 'delay':
          await this.delay(item.ms || 0);
          break;
        default:
          throw new Error(`Unknown command: ${item.cmd}`);
      }
      results.push({ cmd: item.cmd, ok: true, result });
    }
    return results;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _buttonMask(button) {
    switch ((button || 'left').toLowerCase()) {
      case 'left':   return 0x01;
      case 'middle': return 0x02;
      case 'right':  return 0x04;
      default:       return 0x01;
    }
  }

  _smallDelay() {
    return new Promise(resolve => setImmediate(resolve));
  }
}

module.exports = { VNCClient };
