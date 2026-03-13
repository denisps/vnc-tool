'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { encodePNG, decodePNG } = require('../lib/png');

test('png: encodePNG + decodePNG roundtrip for simple RGBA image', () => {
  // 2x2 image with distinct RGBA pixels
  const width = 2;
  const height = 2;
  const rgba = Buffer.from([
    // row 0
    255, 0, 0, 255,    // red
    0, 255, 0, 255,    // green
    // row 1
    0, 0, 255, 255,    // blue
    255, 255, 0, 255,  // yellow
  ]);

  const png = encodePNG(width, height, rgba);
  assert.ok(png.length > 0, 'PNG data should not be empty');

  const decoded = decodePNG(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decoded.rgba.length, rgba.length);
  assert.ok(decoded.rgba.equals(rgba), 'Decoded RGBA should match original');
});
