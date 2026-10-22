// The Claude adapter for computer use: the translation between Claude's computer toolset (computer_toolset_20260801) and the canonical
// actions that lib/computer/run.mjs takes (the shapes of desktop/computer/actions.cjs). It is pure: no request, no stream, no state.
// lib/providers.mjs (streamClaude) calls it for each member tool_use block; the run does the checks, the cards, the log and the step rows.
//
//   toCanonical(name, input)  -> the canonical action for one member, or throws an Error with the reason (an unknown member, a bad input)
//   resultBlock(use, res)     -> the tool_result for one member: { type, tool_use_id, toolset_name: 'computer', content, is_error }
//   isComputerUse(use)        -> true when a tool_use block is a member of the computer toolset (its toolset_name is 'computer')
//   changesScreen(name)       -> true for a member that can change the screen (every member but the looks)
//   NOT_EXECUTED              -> the text of a result for a block the batch did not run after an earlier computer action failed
//
// The toolset's member reference (WebFetch of the computer-use tool page, 2026): every member takes its own input fields, with no
// `action` field. screenshot and cursor_position take none; zoom takes region [x0, y0, x1, y1]; the clicks take an optional
// coordinate [x, y] and text for modifier keys ('shift', 'ctrl+shift'); left_click_drag takes start_coordinate and coordinate;
// mouse_move takes coordinate; left_mouse_down and left_mouse_up take none; scroll takes scroll_direction, scroll_amount, an optional
// coordinate and text; type takes text; key takes text (a key or a '+'-joined chord) and an optional repeat (1 to 100); hold_key takes
// text and duration (seconds); wait takes duration (seconds).
//
// The input is checked here to the same rules as desktop/computer/actions.cjs (the names, the buttons, the key spellings, the caps), so
// a bad action is refused before the run sees it. This file does not import the desktop folder: the registry tests copy lib/ alone,
// and the desktop shell checks every action again with its own copy of these rules before it injects anything.

// The seventeen members of the toolset, in the order the reference lists them.
export const COMPUTER_MEMBERS = Object.freeze([
  'screenshot', 'zoom',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
  'mouse_move', 'left_mouse_down', 'left_mouse_up', 'cursor_position',
  'scroll', 'type', 'key', 'hold_key', 'wait',
]);
const MEMBERS = new Set(COMPUTER_MEMBERS);

// The members that only look: a batch made of these changed nothing, so it gets no fresh screenshot at its end.
const LOOKS = new Set(['screenshot', 'zoom', 'cursor_position']);

// What a block gets when the batch stopped before it: an earlier computer action in the same reply failed, so nothing after it runs.
export const NOT_EXECUTED = 'Not executed: an earlier computer action in this turn failed.';

// The click members: their button and click count.
const CLICKS = Object.freeze({
  left_click: { button: 'left', count: 1 },
  right_click: { button: 'right', count: 1 },
  middle_click: { button: 'middle', count: 1 },
  double_click: { button: 'left', count: 2 },
  triple_click: { button: 'left', count: 3 },
});

// The caps and names, as desktop/computer/actions.cjs has them (LIMITS, MODIFIERS, KEY names). A name it does not list passes through
// unchanged, and the desktop refuses it there if it is not a key.
const LIMITS = Object.freeze({ repeat: 20, holdMs: 5000, scroll: 50, text: 10_000 });
const MODIFIERS = Object.freeze(['ctrl', 'shift', 'alt', 'super']);
const DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const MODIFIER_ALIAS = Object.freeze({ control: 'ctrl', ctl: 'ctrl', option: 'alt', opt: 'alt', win: 'super', windows: 'super', cmd: 'super', command: 'super', meta: 'super' });
const KEY_ALIAS = Object.freeze({
  enter: 'Return', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', bksp: 'BackSpace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End', pageup: 'Page_Up', pgup: 'Page_Up', pagedown: 'Page_Down', pgdn: 'Page_Down',
  tab: 'Tab', space: 'space', spacebar: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
});
const CONTROL_OR_BREAK = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}\n…[cut at ${max} characters]` : text);

// True for a tool_use block of the computer toolset. A custom tool never carries toolset_name, so it is never mistaken for a member.
export const isComputerUse = use => use?.toolset_name === 'computer';

// [x, y] -> { x, y }, rounded. Absent (undefined or null) is {} when optional, and an error when required.
function pointOf(value, what, required) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`The ${what} is needed: give it as [x, y] in the pixels of the last screenshot.`);
    return {};
  }
  if (!Array.isArray(value) || value.length !== 2 || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`The ${what} must be [x, y] with two numbers.`);
  }
  return { x: Math.round(value[0]), y: Math.round(value[1]) };
}

// A duration in seconds, as milliseconds.
function millisOf(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`A ${what} needs a duration in seconds.`);
  return Math.round(value * 1000);
}

// A whole number within a range, or the fallback when it is absent.
function countOf(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('A number is needed here.');
  return Math.min(max, Math.max(min, Math.round(value)));
}

// One key name: letters are lower case (the desktop reads 'A' as the a key), modifiers and the named keys take their canonical spelling.
function keyName(raw) {
  const text = raw.trim();
  if (text.length === 1) return /[A-Z]/.test(text) ? text.toLowerCase() : text;
  const lower = text.toLowerCase();
  if (MODIFIERS.includes(lower)) return lower;
  if (MODIFIER_ALIAS[lower]) return MODIFIER_ALIAS[lower];
  if (KEY_ALIAS[lower]) return KEY_ALIAS[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  return text;
}

// A key or a '+'-joined chord, as canonical names, modifiers first. With modifiersOnly, a key that is not a modifier is refused.
function keysOf(text, { modifiersOnly = false } = {}) {
  if (typeof text !== 'string') throw new Error('Keys must be a name such as "Tab" or a chord such as "ctrl+s".');
  const trimmed = text.trim();
  const keys = trimmed.split('+').map(p => p.trim()).filter(p => p !== '').map(keyName);
  // A trailing '+' ("ctrl++") is the plus key itself.
  if (trimmed.endsWith('+')) keys.push('+');
  if (keys.length === 0) throw new Error('No key was given.');
  if (modifiersOnly) {
    for (const key of keys) if (!MODIFIERS.includes(key)) throw new Error(`"${key}" is not a modifier key (ctrl, shift, alt or super).`);
  }
  const unique = [...new Set(keys)];
  return [...MODIFIERS.filter(m => unique.includes(m)), ...unique.filter(k => !MODIFIERS.includes(k))];
}

// The modifiers named in a text field ('shift+ctrl'); absent or empty is none.
const modifiersOf = text => (text === undefined || text === null || text === '' ? [] : keysOf(text, { modifiersOnly: true }));

// Text to type: a string, not too long, with no control characters (tab, line feed and return are allowed).
function textOf(text) {
  if (typeof text !== 'string') throw new Error('Typing needs text.');
  if (text.length > LIMITS.text) throw new Error(`Text longer than ${LIMITS.text} characters is not typed in one action.`);
  if (CONTROL_OR_BREAK.test(text)) throw new Error('The text holds control characters, which are never typed.');
  return text;
}

// The canonical action of one member, with its input. Throws an Error with a plain message for a member the run does not know, or
// for an input that cannot be an action.
export function toCanonical(name, input) {
  if (!MEMBERS.has(name)) throw new Error(`"${String(name).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 40)}" is not a computer action.`);
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (name === 'screenshot') return { kind: 'screenshot' };
  if (name === 'cursor_position') return { kind: 'cursor' };
  if (name === 'zoom') return { kind: 'zoom', region: i.region };
  if (name === 'wait') return { kind: 'wait', ms: millisOf(i.duration, 'wait') };
  if (name in CLICKS) {
    const { button, count } = CLICKS[name];
    return { kind: 'click', button, count, modifiers: modifiersOf(i.text), ...pointOf(i.coordinate, 'coordinate', false) };
  }
  switch (name) {
    case 'left_click_drag':
      return {
        kind: 'drag',
        from: pointOf(i.start_coordinate, 'start_coordinate', true),
        to: pointOf(i.coordinate, 'coordinate', true),
        modifiers: modifiersOf(i.text),
      };
    case 'mouse_move':
      return { kind: 'move', ...pointOf(i.coordinate, 'coordinate', true) };
    case 'left_mouse_down':
      return { kind: 'down', button: 'left' };
    case 'left_mouse_up':
      return { kind: 'up', button: 'left' };
    case 'scroll':
      // The desktop's scroll takes no modifier keys, so a scroll that names one is refused rather than run without it.
      if (typeof i.text === 'string' && i.text.trim() !== '') throw new Error('A scroll with a held key is not supported. Hold the key with hold_key, or scroll without it.');
      if (!DIRECTIONS.includes(i.scroll_direction)) throw new Error('The scroll direction must be up, down, left or right.');
      return { kind: 'scroll', direction: i.scroll_direction, amount: countOf(i.scroll_amount, 1, LIMITS.scroll, 3), ...pointOf(i.coordinate, 'coordinate', false) };
    case 'type':
      return { kind: 'type', text: textOf(i.text) };
    case 'key':
      return { kind: 'key', keys: keysOf(i.text), repeat: countOf(i.repeat, 1, LIMITS.repeat, 1) };
    case 'hold_key':
      return { kind: 'hold', keys: keysOf(i.text), ms: countOf(millisOf(i.duration, 'hold_key'), 1, LIMITS.holdMs, 500) };
    default:
      throw new Error(`"${name}" is not a computer action.`);
  }
}

// The tool_result for one member's block. res is what ctx.computer.step returned: { ok, output, blocks? }. A screenshot or a zoom carries
// its picture (blocks); every other success is the text 'OK', or the text the run gave.
export function resultBlock(use, res) {
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    toolset_name: 'computer',
    content: res.blocks ?? cut(String(res.output ?? 'OK'), 24_000),
    is_error: !res.ok,
  };
}

// True for a member that can change the screen (so a batch that ends with one gets a fresh screenshot at its end).
export const changesScreen = name => MEMBERS.has(name) && !LOOKS.has(name);
