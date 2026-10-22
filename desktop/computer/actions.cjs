'use strict';
// The canonical computer-use actions, shared by the desktop shell (which injects them) and the server (which builds them). It is
// plain data and pure functions: no Electron, no native code, no I/O, so lib/computer/ may import it with createRequire.
//
//   normalizeAction(raw) -> { ok: true, action } | { ok: false, message }
//
// A canonical action, in PHYSICAL screen pixels (the server converts from the pixels the model saw):
//   { kind: 'move',  x, y }
//   { kind: 'click', x?, y?, button: 'left'|'right'|'middle', count: 1|2|3, modifiers: [] }   (no x/y: click where the pointer is)
//   { kind: 'down' | 'up', button }
//   { kind: 'drag',  from: { x, y }, to: { x, y }, modifiers: [] }                              (left button)
//   { kind: 'scroll', x?, y?, direction: 'up'|'down'|'left'|'right', amount: 1..50 }
//   { kind: 'type',  text }                                                                      (up to 10000 characters)
//   { kind: 'key',   keys: ['ctrl', 'shift', 'a'], repeat: 1..20 }
//   { kind: 'hold',  keys: ['shift'], ms: 1..5000 }
// Anything else (screenshot, zoom, wait, cursor) is not an injected action and is refused here. Fields that are not listed are
// dropped, so the shell injects only what it parsed itself.
//
// Key names are xdotool's spelling (KEY_NAMES) plus single printable characters. Input may use aliases and any letter case:
// enter -> Return, esc -> Escape, backspace -> BackSpace, pageup -> Page_Up, pagedown -> Page_Down, win/cmd/meta/windows/command
// -> super, option -> alt, control -> ctrl, and the X keysym names of ASCII punctuation (slash, period, plus ...). A string of keys
// is split on '+' ('shift+ctrl' -> ['ctrl', 'shift']); a '+' that ends the string or follows another '+' is the plus key itself.
// Modifiers sort first, in the order ctrl, shift, alt, super. A letter key is lower-cased: 'A' means the a key, and shift is only
// pressed when the action says so.

const LIMITS = Object.freeze({ repeatMax: 20, holdMaxMs: 5000, holdDefaultMs: 500, scrollMax: 50, scrollDefault: 3, textMax: 10000, keysMax: 8, coordMax: 100000 });

const MODIFIERS = Object.freeze(['ctrl', 'shift', 'alt', 'super']);
const BUTTONS = Object.freeze(['left', 'right', 'middle']);
const DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

// The canonical set of named keys. Single printable characters are keys too (see isPrintableKey) and are not listed.
const KEY_NAMES = Object.freeze([
  'Return', 'Tab', 'Escape', 'BackSpace', 'Delete', 'Insert', 'Home', 'End', 'Page_Up', 'Page_Down',
  'Up', 'Down', 'Left', 'Right', 'space', ...FUNCTION_KEYS, ...MODIFIERS,
]);

// X keysym names of ASCII punctuation -> the character. Linux types these by name; the other platforms by character.
const KEYSYM_CHARS = Object.freeze({
  exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', apostrophe: "'", parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', minus: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=',
  greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
  grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
});
// The reverse: character -> keysym name, for xdotool.
const CHAR_KEYSYMS = Object.freeze(Object.fromEntries(Object.entries(KEYSYM_CHARS).map(([name, ch]) => [ch, name])));

// Lower-case input spelling -> canonical name.
const ALIASES = (() => {
  const map = new Map();
  for (const name of KEY_NAMES) map.set(name.toLowerCase(), name);
  const add = (canonical, ...names) => names.forEach(name => map.set(name, canonical));
  add('Return', 'enter', 'kp_enter');
  add('Escape', 'esc');
  add('BackSpace', 'backspace', 'bksp');
  add('Delete', 'del');
  add('Insert', 'ins');
  add('Page_Up', 'pageup', 'pgup', 'prior', 'page up');
  add('Page_Down', 'pagedown', 'pgdn', 'next', 'page down');
  add('Up', 'arrowup', 'up_arrow', 'uparrow');
  add('Down', 'arrowdown', 'down_arrow', 'downarrow');
  add('Left', 'arrowleft', 'left_arrow', 'leftarrow');
  add('Right', 'arrowright', 'right_arrow', 'rightarrow');
  add('space', 'spacebar');
  add('ctrl', 'control', 'ctl', 'control_l', 'control_r', 'ctrl_l', 'ctrl_r');
  add('shift', 'shift_l', 'shift_r');
  add('alt', 'option', 'opt', 'alt_l', 'alt_r', 'menu');
  add('super', 'win', 'windows', 'cmd', 'command', 'meta', 'super_l', 'super_r', 'win_l', 'win_r');
  return map;
})();

// A control character is not a printable key. In typed text, tab, line feed and carriage return are allowed (type() turns them into
// the Tab and Return keys); every other control character is refused.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_OR_BREAK = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function isPrintableKey(name) {
  return typeof name === 'string' && [...name].length === 1 && !CONTROL.test(name) && name !== ' ';
}

// The canonical name of one key, or null when it is not a key this module knows.
function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  if (raw === ' ') return 'space';
  if (raw === '\t') return 'Tab';
  if (raw === '\n' || raw === '\r') return 'Return';
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length === 1) {
    if (CONTROL.test(trimmed)) return null;
    return /[A-Z]/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  }
  const lower = trimmed.toLowerCase();
  const named = ALIASES.get(lower);
  if (named) return named;
  if (Object.hasOwn(KEYSYM_CHARS, lower)) return KEYSYM_CHARS[lower];
  return null;
}

// Splits 'ctrl+shift+a' on '+'. A '+' that starts a token (the string's first character, or one that follows another '+') is the
// plus key itself: 'ctrl++' is ctrl and plus, '+' is plus.
function splitKeys(text) {
  const parts = [];
  let token = '';
  let afterPlus = true;
  for (const ch of String(text)) {
    if (ch === '+') {
      if (token !== '') {
        parts.push(token);
        token = '';
        afterPlus = true;
      } else if (afterPlus) {
        parts.push('+');
        afterPlus = false;
      }
    } else {
      token += ch;
      afterPlus = false;
    }
  }
  if (token !== '') parts.push(token);
  return parts;
}

const modifierRank = key => MODIFIERS.indexOf(key);

// -> { ok: true, keys } | { ok: false, message }. `input` is a string ('ctrl+s'), a list of strings, or a list of such strings.
function normalizeKeys(input, { allowEmpty = false, modifiersOnly = false } = {}) {
  let tokens;
  if (typeof input === 'string') tokens = splitKeys(input);
  else if (Array.isArray(input)) tokens = input.flatMap(item => (typeof item === 'string' ? (item.length > 1 ? splitKeys(item) : [item]) : [item]));
  else if (input == null && allowEmpty) tokens = [];
  else return { ok: false, message: 'Keys must be a list of key names.' };
  if (tokens.length === 0 && !allowEmpty) return { ok: false, message: 'No keys were given.' };
  if (tokens.length > LIMITS.keysMax) return { ok: false, message: `At most ${LIMITS.keysMax} keys can be pressed together.` };
  const keys = [];
  for (const token of tokens) {
    const key = normalizeKey(token);
    if (key === null) {
      const shown = typeof token === 'string' ? token.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 24) : String(typeof token);
      return { ok: false, message: `Unknown key "${shown}".` };
    }
    if (modifiersOnly && !MODIFIERS.includes(key)) return { ok: false, message: `"${key}" is not a modifier key (ctrl, shift, alt or super).` };
    if (!keys.includes(key)) keys.push(key);
  }
  // Modifiers first, in a fixed order, then the other keys as given.
  const mods = keys.filter(k => MODIFIERS.includes(k)).sort((a, b) => modifierRank(a) - modifierRank(b));
  return { ok: true, keys: [...mods, ...keys.filter(k => !MODIFIERS.includes(k))] };
}

function normalizeCoord(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > LIMITS.coordMax) return null;
  return Math.round(n);
}

// -> { x, y } | null
function normalizePoint(x, y) {
  const px = normalizeCoord(x);
  const py = normalizeCoord(y);
  return px === null || py === null ? null : { x: px, y: py };
}

function normalizeButton(value, fallback = 'left') {
  if (value === undefined || value === null || value === '') return fallback;
  const lower = typeof value === 'string' ? value.toLowerCase() : '';
  if (lower === 'centre' || lower === 'center' || lower === 'wheel') return 'middle';
  return BUTTONS.includes(lower) ? lower : null;
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (n === undefined || n === null) return fallback;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// The modifiers of an action: raw.modifiers (a list or a string) or, for a click, a string in raw.text ('shift+ctrl').
function modifiersOf(raw) {
  const source = raw.modifiers !== undefined && raw.modifiers !== null ? raw.modifiers : typeof raw.text === 'string' && raw.text.trim() !== '' ? raw.text : undefined;
  if (source === undefined || (Array.isArray(source) && source.length === 0)) return { ok: true, keys: [] };
  return normalizeKeys(source, { allowEmpty: true, modifiersOnly: true });
}

function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'The action is not an object.' };
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  switch (kind) {
    case 'move': {
      const p = normalizePoint(raw.x, raw.y);
      return p ? { ok: true, action: { kind, x: p.x, y: p.y } } : { ok: false, message: 'A move needs x and y.' };
    }
    case 'click': {
      const button = normalizeButton(raw.button);
      if (button === null) return { ok: false, message: 'The button must be left, right or middle.' };
      const count = clampInt(raw.count, 1, 3, 1);
      if (count === null) return { ok: false, message: 'The click count must be 1, 2 or 3.' };
      const mods = modifiersOf(raw);
      if (!mods.ok) return mods;
      const action = { kind, button, count, modifiers: mods.keys };
      const hasX = raw.x !== undefined && raw.x !== null;
      const hasY = raw.y !== undefined && raw.y !== null;
      if (hasX !== hasY) return { ok: false, message: 'A click needs both x and y, or neither.' };
      if (hasX) {
        const p = normalizePoint(raw.x, raw.y);
        if (!p) return { ok: false, message: 'A click needs numbers for x and y.' };
        action.x = p.x;
        action.y = p.y;
      }
      return { ok: true, action };
    }
    case 'down':
    case 'up': {
      const button = normalizeButton(raw.button);
      return button === null ? { ok: false, message: 'The button must be left, right or middle.' } : { ok: true, action: { kind, button } };
    }
    case 'drag': {
      const from = raw.from && typeof raw.from === 'object' ? normalizePoint(raw.from.x, raw.from.y) : null;
      const to = raw.to && typeof raw.to === 'object' ? normalizePoint(raw.to.x, raw.to.y) : null;
      if (!from || !to) return { ok: false, message: 'A drag needs from and to points.' };
      const mods = modifiersOf(raw);
      return mods.ok ? { ok: true, action: { kind, from, to, modifiers: mods.keys } } : mods;
    }
    case 'scroll': {
      const direction = typeof raw.direction === 'string' ? raw.direction.toLowerCase() : '';
      if (!DIRECTIONS.includes(direction)) return { ok: false, message: 'The scroll direction must be up, down, left or right.' };
      const amount = clampInt(raw.amount, 1, LIMITS.scrollMax, LIMITS.scrollDefault);
      if (amount === null) return { ok: false, message: 'The scroll amount must be a number.' };
      const action = { kind, direction, amount };
      const hasX = raw.x !== undefined && raw.x !== null;
      const hasY = raw.y !== undefined && raw.y !== null;
      if (hasX !== hasY) return { ok: false, message: 'A scroll needs both x and y, or neither.' };
      if (hasX) {
        const p = normalizePoint(raw.x, raw.y);
        if (!p) return { ok: false, message: 'A scroll needs numbers for x and y.' };
        action.x = p.x;
        action.y = p.y;
      }
      return { ok: true, action };
    }
    case 'type': {
      if (typeof raw.text !== 'string') return { ok: false, message: 'Typing needs text.' };
      if (raw.text.length > LIMITS.textMax) return { ok: false, message: `Text longer than ${LIMITS.textMax} characters is not typed in one action.` };
      if (CONTROL_OR_BREAK.test(raw.text)) return { ok: false, message: 'The text holds control characters, which are never typed.' };
      return { ok: true, action: { kind, text: raw.text } };
    }
    case 'key': {
      const keys = normalizeKeys(raw.keys !== undefined ? raw.keys : raw.key !== undefined ? raw.key : raw.text);
      if (!keys.ok) return keys;
      const repeat = clampInt(raw.repeat, 1, LIMITS.repeatMax, 1);
      if (repeat === null) return { ok: false, message: 'The repeat count must be a number.' };
      return { ok: true, action: { kind, keys: keys.keys, repeat } };
    }
    case 'hold': {
      const keys = normalizeKeys(raw.keys !== undefined ? raw.keys : raw.key);
      if (!keys.ok) return keys;
      const ms = clampInt(raw.ms, 1, LIMITS.holdMaxMs, LIMITS.holdDefaultMs);
      if (ms === null) return { ok: false, message: 'The hold time must be a number of milliseconds.' };
      return { ok: true, action: { kind, keys: keys.keys, ms } };
    }
    default:
      return { ok: false, message: `"${kind.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 24)}" is not an action the desktop can inject.` };
  }
}

// The points of an action in physical pixels (for the checks that look at where it lands), in the order they are visited.
function pointsOf(action) {
  if (!action) return [];
  if (action.kind === 'drag') return [action.from, action.to];
  if (typeof action.x === 'number' && typeof action.y === 'number') return [{ x: action.x, y: action.y }];
  return [];
}

module.exports = { KEY_NAMES, MODIFIERS, BUTTONS, DIRECTIONS, LIMITS, KEYSYM_CHARS, CHAR_KEYSYMS, normalizeAction, normalizeKey, normalizeKeys, splitKeys, isPrintableKey, pointsOf };
