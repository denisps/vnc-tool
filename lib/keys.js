'use strict';

// X11 KeySym values for common keys
const KEYS = {
  // Modifiers
  ctrl:       0xffe3,
  control:    0xffe3,
  lctrl:      0xffe3,
  rctrl:      0xffe4,
  shift:      0xffe1,
  lshift:     0xffe1,
  rshift:     0xffe2,
  alt:        0xffe9,
  lalt:       0xffe9,
  ralt:       0xffea,
  meta:       0xffeb,
  super:      0xffeb,
  win:        0xffeb,
  lwin:       0xffeb,
  rwin:       0xffec,
  capslock:   0xffe5,
  numlock:    0xff7f,
  scrolllock: 0xff14,

  // Function keys
  f1:  0xffbe, f2:  0xffbf, f3:  0xffc0, f4:  0xffc1,
  f5:  0xffc2, f6:  0xffc3, f7:  0xffc4, f8:  0xffc5,
  f9:  0xffc6, f10: 0xffc7, f11: 0xffc8, f12: 0xffc9,

  // Navigation
  home:      0xff50,
  left:      0xff51,
  up:        0xff52,
  right:     0xff53,
  down:      0xff54,
  pageup:    0xff55,
  prior:     0xff55,
  pagedown:  0xff56,
  next:      0xff56,
  end:       0xff57,
  begin:     0xff58,

  // Misc
  insert:    0xff63,
  delete:    0xffff,
  backspace: 0xff08,
  tab:       0xff09,
  return:    0xff0d,
  enter:     0xff0d,
  escape:    0xff1b,
  esc:       0xff1b,
  space:     0x0020,
  print:     0xff61,
  pause:     0xff13,
  'break':   0xff6b,
  menu:      0xff67,
};

/**
 * Parse a key combination string like "ctrl+c", "ctrl+alt+del", "F1", "Return".
 * Returns { modifiers: [keysym, ...], key: keysym }.
 */
function parseKeyCombo(str) {
  const MODIFIER_NAMES = new Set([
    'ctrl','control','lctrl','rctrl',
    'shift','lshift','rshift',
    'alt','lalt','ralt',
    'meta','super','win','lwin','rwin',
    'capslock','numlock','scrolllock',
  ]);

  const parts = str.split('+');
  const modifiers = [];
  const keyParts = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIER_NAMES.has(lower)) {
      modifiers.push(KEYS[lower]);
    } else {
      keyParts.push(part);
    }
  }

  if (keyParts.length === 0) {
    throw new Error(`No key specified in combo: ${str}`);
  }

  const keyStr = keyParts.join('+');
  const lower = keyStr.toLowerCase();

  let keysym;
  if (KEYS[lower] !== undefined) {
    keysym = KEYS[lower];
  } else if (keyStr.length === 1) {
    keysym = keyStr.codePointAt(0);
  } else {
    // Try uppercase lookup (F1, F2, etc.)
    const up = keyStr.toUpperCase();
    if (KEYS[up.toLowerCase()] !== undefined) {
      keysym = KEYS[up.toLowerCase()];
    } else {
      throw new Error(`Unknown key: ${keyStr}`);
    }
  }

  return { modifiers, key: keysym };
}

module.exports = { KEYS, parseKeyCombo };
