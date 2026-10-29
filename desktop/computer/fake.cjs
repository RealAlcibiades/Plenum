'use strict';
// The fake computer backend: pure Node, no Electron, no native code, and no touch of the real desktop. It answers the same methods
// as the real backend (desktop/computer/index.cjs) from a screen it draws itself, so the server can run a whole computer-use run
// under PLENUM_COMPUTER_BACKEND=fake and every test can drive one. It is the only backend that loads under test.
//
//   createFakeBackend({ width = 1280, height = 800, scale = 1, windows, foreground, secure = false, script = [],
//                       overlayLeaks = false, holdMs = 30, platform = 'win32' })
//
//  - width and height are the display's physical pixels and scale is its scale factor (1.75 for 175 %).
//  - windows is the stacking order, topmost first: { id, title, exe, pid, bounds (physical), own?, minimized?, elevated?, popup? }.
//    A window with popup: true (a menu, a drop-down) or no title is left out of windows() and kept in windows({ all: true }).
//  - Every call is recorded in backend.calls ({ method, ... }). backend.sent holds the actions that were really injected, in order,
//    and backend.events the low-level events they made (move, mouseDown, mouseUp, keyDown, keyUp, wheel, text), so a test can see
//    that a refused action sent nothing and that release() lifted a held key.
//  - setForeground(id), setElevated(bool), setUserMoved(), setUserTyped(), setCursorMoving(ms), setSecure(bool|null), setLabel(text),
//    setWindows(list) and setTitle(id, title) change the world. script entries { after: n, foreground?, elevated?, secure?, label?,
//    windows?, title?, userMoved?, run?(backend) } change it after the n-th injected action.
//  - A click, scroll or button press without x and y lands at the pointer, and the elevated and overlay-bar checks use the pointer's
//    spot as its point, as the real backend does.
//  - capture() draws the display (a frame counter in every window, the title band of each) and then does what the real one does:
//    in window scope it crops to the window, greys the parts other programs' windows cover (geometry.maskRects) and scales the long
//    edge to maxEdge. With overlayLeaks the overlay bar shows a magenta marker in the first capture, as a window that content
//    protection does not hide would; the backend then reports 'hidden-during-capture' and hides the overlay for later captures.
const geometry = require('./geometry.cjs');
const png = require('./png.cjs');
const { normalizeAction, pointsOf } = require('./actions.cjs');

const GREY = [128, 128, 128, 255];
const MAGENTA = [255, 0, 255, 255];
const FRAME_PX = 4;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const copyRect = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });

function defaultWindows() {
  return [
    { id: 'w1', title: 'Untitled - Notepad', exe: 'C:\\Windows\\System32\\notepad.exe', pid: 1001, bounds: { x: 100, y: 80, width: 700, height: 500 } },
    { id: 'w2', title: 'Plenum', exe: 'C:\\Program Files\\Plenum\\Plenum.exe', pid: 900, own: true, bounds: { x: 640, y: 120, width: 600, height: 520 } },
    { id: 'w3', title: 'Calculator', exe: 'C:\\Windows\\System32\\CalculatorApp.exe', pid: 1002, bounds: { x: 900, y: 300, width: 320, height: 420 } },
  ];
}

function createFakeBackend(options = {}) {
  const width = options.width ?? 1280;
  const height = options.height ?? 800;
  const scale = options.scale ?? 1;
  const platform = options.platform ?? 'win32';
  const holdMs = options.holdMs ?? 30;
  const screenRect = { x: 0, y: 0, width, height };

  let windowList = (options.windows ?? defaultWindows()).map(w => ({ minimized: false, own: false, elevated: false, popup: false, ...w, bounds: copyRect(w.bounds) }));
  let foregroundId = options.foreground ?? windowList.find(w => w.title && !w.own && !w.popup)?.id ?? null;
  let secure = options.secure ?? false;
  let label = options.label ?? null;
  let cursorPos = { x: Math.round(width / 2), y: Math.round(height / 2) };
  let cursorMovingUntil = 0;
  let userMoved = false;
  let userTyped = false;
  let frame = 0;
  let injectedCount = 0;
  let overlayStatus = 'unknown';
  const overlayState = { visible: false, state: null, rect: null, displayId: null, model: '', label: '', bar: null, frame: { visible: false, rect: null } };
  const held = new Set();
  const heldButtons = new Set();
  const script = (options.script ?? []).map(entry => ({ ...entry, done: false }));

  const calls = [];
  const sent = [];
  const events = [];
  const record = entry => {
    calls.push(entry);
    return entry;
  };
  const display = () => ({
    id: '1',
    label: 'Fake display',
    bounds: copyRect(screenRect),
    scaleFactor: scale,
    physical: { width, height },
    primary: true,
  });
  const findWindow = id => windowList.find(w => String(w.id) === String(id)) ?? null;
  const visible = () => windowList.filter(w => !w.minimized);
  const describe = w => ({
    id: String(w.id), title: w.title, exe: w.exe, pid: w.pid, elevated: !!w.elevated, bounds: copyRect(w.bounds), own: !!w.own,
  });

  function barRect() {
    if (!overlayState.visible) return null;
    const size = { width: Math.round(geometry.BAR_SIZE.width * scale), height: Math.round(geometry.BAR_SIZE.height * scale) };
    const target = overlayState.rect ? overlayState.rect : null;
    const placed = geometry.barPlacement({ target, display: screenRect, size, gap: Math.round(8 * scale), clearance: Math.round(FRAME_PX * scale) });
    return { x: placed.x, y: placed.y, width: placed.width, height: placed.height };
  }

  // ---------- drawing ----------

  function drawWorld({ withBar }) {
    const canvas = png.createCanvas(width, height, [28, 30, 38, 255]);
    const px = Math.max(1, Math.round(scale));
    for (const w of [...visible()].reverse()) {
      const b = w.bounds;
      const popup = w.popup || !w.title;
      png.fillRect(canvas, b.x, b.y, b.width, b.height, popup ? [236, 236, 240, 255] : w.own ? [60, 64, 90, 255] : [245, 245, 245, 255]);
      if (!popup) {
        png.fillRect(canvas, b.x, b.y, b.width, 26 * px, String(w.id) === String(foregroundId) ? [40, 110, 210, 255] : [120, 120, 130, 255]);
        png.drawText(canvas, b.x + 8, b.y + 8 * px, w.title.slice(0, Math.max(1, Math.floor((b.width - 16) / (6 * px)))), [255, 255, 255, 255], px);
        png.drawText(canvas, b.x + 8, b.y + 40 * px, `F${frame}`, [20, 20, 20, 255], 2 * px);
      }
    }
    if (withBar) {
      const bar = barRect();
      if (bar) {
        png.fillRect(canvas, bar.x, bar.y, bar.width, bar.height, [24, 24, 28, 255]);
        png.fillRect(canvas, bar.x, bar.y, Math.round(6 * scale), Math.round(6 * scale), MAGENTA);
      }
    }
    return canvas;
  }

  const toBytes = canvas => {
    const out = png.encodePng(canvas);
    const bytes = new Uint8Array(out.length);
    bytes.set(out);
    return bytes;
  };

  // ---------- script ----------

  function applyScript() {
    for (const entry of script) {
      if (entry.done || injectedCount < entry.after) continue;
      entry.done = true;
      if (entry.windows) api.setWindows(entry.windows);
      if (entry.foreground !== undefined) foregroundId = entry.foreground;
      if (entry.elevated !== undefined) api.setElevated(entry.elevated);
      if (entry.secure !== undefined) secure = entry.secure;
      if (entry.label !== undefined) label = entry.label;
      if (entry.title !== undefined && foregroundId !== null) api.setTitle(foregroundId, entry.title);
      if (entry.userMoved) userMoved = true;
      if (typeof entry.run === 'function') entry.run(api);
    }
  }

  // ---------- low-level events ----------

  const ev = (name, detail = {}) => {
    const entry = { ev: name, ...detail };
    events.push(entry);
    calls.push({ method: name, ...detail });
  };

  function keyDown(key) {
    held.add(key);
    ev('keyDown', { key });
  }
  function keyUp(key) {
    if (held.delete(key)) ev('keyUp', { key });
  }
  function moveTo(x, y) {
    cursorPos = { x, y };
    ev('move', { x, y });
  }
  function press(button) {
    heldButtons.add(button);
    ev('mouseDown', { button });
  }
  function lift(button) {
    if (heldButtons.delete(button)) ev('mouseUp', { button });
  }

  // ---------- the interface ----------

  const api = {
    kind: 'fake',
    platform,
    calls,
    sent,
    events,

    async probe() {
      record({ method: 'probe' });
      return {
        supported: true,
        reason: '',
        platform,
        displays: [display()],
        permissions: { screen: 'granted', input: 'granted' },
        wayland: false,
        tools: { xdotool: null },
        overlay: overlayStatus,
      };
    },

    async windows({ all = false } = {}) {
      record({ method: 'windows', all: !!all });
      if (all) return visible().map(w => ({ id: String(w.id), pid: w.pid, exe: w.exe, bounds: copyRect(w.bounds) }));
      return windowList
        .filter(w => w.title && !w.popup)
        .map(w => ({ id: String(w.id), title: w.title, exe: w.exe, pid: w.pid, displayId: '1', bounds: copyRect(w.bounds), own: !!w.own, minimized: !!w.minimized }));
    },

    async foreground() {
      record({ method: 'foreground' });
      const w = findWindow(foregroundId);
      return w && !w.minimized ? describe(w) : null;
    },

    async capture({ scope = 'display', target = null, maxEdge = 1280 } = {}) {
      record({ method: 'capture', scope, target });
      const limit = Math.min(4000, Math.max(256, Math.round(Number(maxEdge)) || 1280));
      frame += 1;
      const barShows = overlayState.visible;
      let withBar = barShows;
      if (barShows && overlayStatus === 'hidden-during-capture') {
        withBar = false;
        record({ method: 'captureBlink' });
      }
      const canvas = drawWorld({ withBar: withBar && options.overlayLeaks === true });
      if (barShows && overlayStatus === 'unknown') {
        overlayStatus = options.overlayLeaks === true ? 'hidden-during-capture' : 'protected';
      }
      if (scope === 'window') {
        const w = findWindow(target?.windowId ?? target);
        if (!w || w.minimized) return { ok: false, reason: 'no-window', message: 'That window is not on screen.' };
        const crop = geometry.cropRect(w.bounds, screenRect);
        if (!crop) return { ok: false, reason: 'no-window', message: 'That window is not on screen.' };
        const all = visible().map(x => ({ id: String(x.id), pid: x.pid, exe: x.exe, bounds: x.bounds }));
        const masks = geometry.maskRects(crop, all, { id: String(w.id), exe: w.exe });
        for (const m of masks) png.fillRect(canvas, m.x, m.y, m.width, m.height, GREY);
        const cropped = png.cropCanvas(canvas, crop.x, crop.y, crop.width, crop.height);
        const sentSize = geometry.fitEdge(cropped.width, cropped.height, limit);
        const out = png.resizeCanvas(cropped, sentSize.width, sentSize.height);
        return { png: toBytes(out), width: out.width, height: out.height, physical: copyRect(crop), scale: { x: crop.width / out.width, y: crop.height / out.height } };
      }
      const sentSize = geometry.fitEdge(width, height, limit);
      const out = png.resizeCanvas(canvas, sentSize.width, sentSize.height);
      return { png: toBytes(out), width: out.width, height: out.height, physical: copyRect(screenRect), scale: { x: width / out.width, y: height / out.height } };
    },

    async input(raw) {
      const parsed = normalizeAction(raw);
      if (!parsed.ok) {
        record({ method: 'input', sent: false, reason: 'unsupported' });
        return { ok: false, reason: 'unsupported', message: parsed.message };
      }
      const action = parsed.action;
      const fg = findWindow(foregroundId);
      const points = pointsOf(action);
      // What the elevated and overlay-bar checks look at: the action's points, or the pointer for an action that lands there.
      const checked = !points.length && ['click', 'scroll', 'down', 'up'].includes(action.kind) ? [{ ...cursorPos }] : points;
      if (fg && fg.elevated) {
        record({ method: 'input', action, sent: false, reason: 'elevated' });
        return { ok: false, reason: 'elevated', message: 'The window in front belongs to a program running as administrator. Plenum cannot control it.' };
      }
      for (const p of checked) {
        const top = visible().find(w => geometry.pointInRect(p, w.bounds));
        if (top && top.elevated) {
          record({ method: 'input', action, sent: false, reason: 'elevated' });
          return { ok: false, reason: 'elevated', message: 'That spot belongs to a program running as administrator. Plenum cannot control it.' };
        }
      }
      const bar = barRect();
      if (bar && checked.some(p => geometry.pointInRect(p, bar))) record({ method: 'barBlink', point: checked.find(p => geometry.pointInRect(p, bar)) });
      record({ method: 'input', action, point: points[0] ?? null, sent: true });
      sent.push(action);
      userMoved = false;
      userTyped = false;
      const mods = action.modifiers ?? [];
      switch (action.kind) {
        case 'move':
          moveTo(action.x, action.y);
          break;
        case 'click':
          mods.forEach(keyDown);
          if (typeof action.x === 'number') moveTo(action.x, action.y);
          for (let i = 0; i < action.count; i++) {
            press(action.button);
            lift(action.button);
          }
          [...mods].reverse().forEach(keyUp);
          break;
        case 'down':
          press(action.button);
          break;
        case 'up':
          lift(action.button);
          break;
        case 'drag':
          mods.forEach(keyDown);
          moveTo(action.from.x, action.from.y);
          press('left');
          moveTo(action.to.x, action.to.y);
          lift('left');
          [...mods].reverse().forEach(keyUp);
          break;
        case 'scroll':
          if (typeof action.x === 'number') moveTo(action.x, action.y);
          ev('wheel', { direction: action.direction, amount: action.amount });
          break;
        case 'type':
          ev('text', { text: action.text });
          break;
        case 'key':
          for (let i = 0; i < action.repeat; i++) {
            action.keys.forEach(keyDown);
            [...action.keys].reverse().forEach(keyUp);
          }
          break;
        case 'hold': {
          // The keys are down before the first await, so release() called right after input() lifts them.
          action.keys.forEach(keyDown);
          await sleep(Math.min(action.ms, holdMs));
          [...action.keys].reverse().forEach(keyUp);
          break;
        }
        default:
          break;
      }
      injectedCount += 1;
      applyScript();
      return { ok: true };
    },

    async cursor() {
      record({ method: 'cursor' });
      if (Date.now() < cursorMovingUntil) cursorPos = { x: cursorPos.x + 7, y: cursorPos.y + 3 };
      return { ...cursorPos };
    },

    async userInput() {
      record({ method: 'userInput' });
      const out = { mouse: userMoved, keys: userTyped };
      userMoved = false;
      userTyped = false;
      return out;
    },

    async focus(windowId) {
      record({ method: 'focus', windowId });
      const w = findWindow(windowId);
      if (!w) return { ok: false, reason: 'no-focus', message: 'That window is gone.' };
      w.minimized = false;
      foregroundId = String(w.id);
      return { ok: true };
    },

    async isSecureField() {
      record({ method: 'isSecureField' });
      return secure;
    },

    async focusedLabel() {
      record({ method: 'focusedLabel' });
      return label;
    },

    async release() {
      record({ method: 'release' });
      for (const key of [...held]) keyUp(key);
      for (const button of [...heldButtons]) lift(button);
      return { ok: true };
    },

    async overlay(opts = {}) {
      record({ method: 'overlay', show: !!opts.show, state: opts.state ?? null, rect: opts.rect ?? null });
      overlayState.visible = !!opts.show;
      overlayState.state = opts.show ? (opts.state === 'paused' ? 'paused' : 'running') : null;
      overlayState.displayId = opts.displayId ?? null;
      overlayState.rect = opts.show && opts.rect ? copyRect(opts.rect) : null;
      overlayState.model = String(opts.model ?? '');
      overlayState.label = String(opts.label ?? '');
      const frameRect = overlayState.rect ?? copyRect(screenRect);
      overlayState.frame = { visible: overlayState.visible && overlayState.state === 'running', rect: overlayState.visible ? frameRect : null };
      overlayState.bar = barRect();
      return { ok: true };
    },

    async requestAccess() {
      record({ method: 'requestAccess' });
      return { ok: true, requested: [] };
    },

    close() {
      record({ method: 'close' });
    },

    // ---------- test controls ----------

    get overlayState() {
      return overlayState;
    },
    get overlayStatus() {
      return overlayStatus;
    },
    get heldKeys() {
      return [...held];
    },
    get injected() {
      return calls.filter(c => c.method === 'input' && c.sent);
    },
    setForeground(id) {
      foregroundId = id === null ? null : String(id);
    },
    setElevated(value = true) {
      const w = findWindow(foregroundId);
      if (w) w.elevated = !!value;
    },
    setUserMoved() {
      userMoved = true;
    },
    setUserTyped() {
      userTyped = true;
    },
    setCursorMoving(ms) {
      cursorMovingUntil = Date.now() + ms;
    },
    setSecure(value) {
      secure = value;
    },
    setLabel(text) {
      label = text === undefined || text === null ? null : String(text);
    },
    setWindows(list) {
      windowList = list.map(w => ({ minimized: false, own: false, elevated: false, popup: false, ...w, bounds: copyRect(w.bounds) }));
    },
    setTitle(id, title) {
      const w = findWindow(id);
      if (w) w.title = title;
    },
    setCursor(x, y) {
      cursorPos = { x, y };
    },
  };
  return api;
}

module.exports = { createFakeBackend, defaultWindows };
