'use strict';
// The macOS half of the computer-use backend: input injection with CoreGraphics events, and the facts about windows, through koffi
// and a few system commands. UNVERIFIED on a real Mac: it is written from Apple's documentation and the forum reports the design
// cites, and its tests run with koffi and the commands stubbed. Treat every macOS behaviour here as tentative until it has run on one.
//
//  - Events come from a PRIVATE event source (kCGEventSourceStatePrivate), so HID-state queries (the person's own input) do not see
//    them, and are posted at the HID event tap with CGEventPost. No event tap is created (they have frozen input system-wide).
//    Mouse events carry the click count in kCGMouseEventClickState; text is a keyboard event with CGEventKeyboardSetUnicodeString;
//    modifiers are CGEventSetFlags; scrolling is CGEventCreateScrollWheelEvent2 in pixel units.
//  - CoreGraphics works in points; the backend's interface is physical pixels. The conversion is per display (the space object).
//  - Permissions: CGPreflightPostEventAccess() for input and Electron's systemPreferences.getMediaAccessStatus('screen') for capture.
//    probe() only reports them. requestAccess() calls CGRequestPostEventAccess() once, when the start dialog asks; the person has to
//    restart Plenum after granting, as the forum reports describe.
//  - foreground(): `lsappinfo front`, then `lsappinfo info -only name,pid,bundlepath <asn>` (execFile, fixed arguments, the cleaned
//    environment of env.cjs). windows(): CGWindowListCopyWindowInfo read through CoreFoundation getters, layer 0 only; with
//    all: true the same list in its front-to-back order with every layer kept. A window is elevated when its process belongs to
//    another user (`ps -o uid=`).
//  - userInput(): the pointer moved more than 3 px, or CGEventSourceSecondsSinceLastEventType(HID state, key down) is shorter than
//    the time since our last injection (hardware state excludes our private source). UNVERIFIED.
//  - isSecureField() asks the accessibility API (ApplicationServices, loaded on the first call, never at start-up; the same Accessibility
//    permission as input injection): AXUIElementCreateSystemWide -> AXFocusedUIElement (or, when that fails, AXFocusedApplication ->
//    AXFocusedUIElement) -> AXRole and AXSubrole. AppKit and Chromium mark a password field as role AXTextField with the SUBROLE
//    AXSecureTextField; the role is checked for that name too. -> true for one. Then the Carbon flag IsSecureEventInputEnabled(),
//    which AppKit and Chromium switch on while a password field has focus, and which any program can also switch on by itself for as long
//    as it likes (Terminal's Secure Keyboard Entry, an unlocked password manager): on -> true for ANY focused element, a plain text role
//    included (a program may expose its password field as an ordinary AXTextField; a false positive only refuses typing, and run.mjs
//    tells the model that a Secure Keyboard Entry elsewhere is a possible cause, so the person can turn it off). With the flag
//    off (or unreadable): false for a text field that is not secure, null (cannot tell) for anything else (no permission, no focused
//    element, a web area or group whose children are not exposed). The system-wide messaging timeout is set to 0.4 s once, because the calls are synchronous on the main thread
//    and a hung program must not freeze Stop. A failure to load or call anything answers null. UNVERIFIED on a real Mac, like the rest.
const nodeFs = require('node:fs');
const { execFile } = require('node:child_process');
const { cleanEnv } = require('./env.cjs');

class NativeUnavailable extends Error {}

const kCGEventSourceStatePrivate = -1;
const kCGEventSourceStateHIDSystemState = 1;
const kCGHIDEventTap = 0;
const kCGMouseEventClickState = 1;
const kCGScrollEventUnitPixel = 0;
const kCGEventKeyDown = 10;
const UTF8 = 0x08000100;
const FLAGS = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, super: 0x100000 };
const MOUSE_TYPES = { left: { down: 1, up: 2, drag: 6, button: 0 }, right: { down: 3, up: 4, drag: 7, button: 1 }, middle: { down: 25, up: 26, drag: 27, button: 2 } };
const PIXELS_PER_NOTCH = 50;

// The accessibility side of isSecureField().
const AX_FRAMEWORK = '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices';
const CARBON_FRAMEWORK = '/System/Library/Frameworks/Carbon.framework/Carbon';
const AX_SECURE = 'AXSecureTextField';
// The roles of a field the person types into: for these the accessibility answer is false unless the secure-input flag is on.
const AX_TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
const AX_TIMEOUT_SECONDS = 0.4;

// ANSI virtual key codes.
const KEYCODES = Object.freeze({
  Return: 0x24, Tab: 0x30, space: 0x31, BackSpace: 0x33, Escape: 0x35, Delete: 0x75, Insert: 0x72, Home: 0x73, End: 0x77, Page_Up: 0x74, Page_Down: 0x79,
  Left: 0x7b, Right: 0x7c, Down: 0x7d, Up: 0x7e,
  F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61, F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67, F12: 0x6f,
  shift: 0x38, ctrl: 0x3b, alt: 0x3a, super: 0x37,
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11,
  1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 6: 0x16, 5: 0x17, '=': 0x18, 9: 0x19, 7: 0x1a, '-': 0x1b, 8: 0x1c, 0: 0x1d, ']': 0x1e, o: 0x1f, u: 0x20, '[': 0x21,
  i: 0x22, p: 0x23, l: 0x25, j: 0x26, "'": 0x27, k: 0x28, ';': 0x29, '\\': 0x2a, ',': 0x2b, '/': 0x2c, n: 0x2d, m: 0x2e, '.': 0x2f, '`': 0x32,
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function defaultRun(file, args, { env, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// ---------- pure parsers (exported for the tests) ----------

// "ASN:0x0-0x1b01b:" -> the token lsappinfo wants, or null.
function parseFront(text) {
  const m = /ASN:[0-9a-fx-]+:?/i.exec(String(text));
  return m ? m[0] : null;
}

// The output of `lsappinfo info -only name,pid,bundlepath <asn>` -> { name, pid, bundle } | null.
function parseAppInfo(text) {
  const s = String(text);
  const pid = /"pid"\s*=\s*(\d+)/i.exec(s);
  if (!pid) return null;
  const name = /"(?:LSDisplayName|name)"\s*=\s*"([^"]*)"/i.exec(s);
  const bundle = /"(?:LSBundlePath|bundlepath)"\s*=\s*"([^"]*)"/i.exec(s);
  return { name: name ? name[1] : '', pid: Number(pid[1]), bundle: bundle ? bundle[1] : '' };
}

// `ps -o pid=,uid=,comm= -p ...` -> Map(pid -> { uid, exe })
function parsePs(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { uid: Number(m[2]), exe: m[3] });
  }
  return out;
}

// Whether an action moves the pointer.
const movesPointer = action => action.kind === 'drag' || action.kind === 'move' || typeof action.x === 'number';

function createMacNative({ koffi, space, run = defaultRun, env = process.env, getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1), ownPid = process.pid, screenStatus = () => 'not-determined', wait = sleep, now = Date.now } = {}) {
  if (!koffi) throw new NativeUnavailable('Computer use needs the koffi module, which is missing from this install.');
  if (!space) throw new NativeUnavailable('The macOS backend needs the display space.');
  const helperEnv = cleanEnv(env);

  const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
  const api = {
    CGEventSourceCreate: CG.func('void *CGEventSourceCreate(int32 stateID)'),
    CGEventCreate: CG.func('void *CGEventCreate(void *source)'),
    CGEventGetLocation: CG.func('CGPoint CGEventGetLocation(void *event)'),
    CGEventCreateMouseEvent: CG.func('void *CGEventCreateMouseEvent(void *source, uint32 mouseType, CGPoint position, uint32 mouseButton)'),
    CGEventCreateKeyboardEvent: CG.func('void *CGEventCreateKeyboardEvent(void *source, uint16 virtualKey, bool keyDown)'),
    CGEventKeyboardSetUnicodeString: CG.func('void CGEventKeyboardSetUnicodeString(void *event, uint64 stringLength, void *unicodeString)'),
    CGEventSetFlags: CG.func('void CGEventSetFlags(void *event, uint64 flags)'),
    CGEventSetIntegerValueField: CG.func('void CGEventSetIntegerValueField(void *event, uint32 field, int64 value)'),
    CGEventCreateScrollWheelEvent2: CG.func('void *CGEventCreateScrollWheelEvent2(void *source, uint32 units, uint32 wheelCount, int32 wheel1, int32 wheel2, int32 wheel3)'),
    CGEventPost: CG.func('void CGEventPost(uint32 tap, void *event)'),
    CGPreflightPostEventAccess: CG.func('bool CGPreflightPostEventAccess()'),
    CGRequestPostEventAccess: CG.func('bool CGRequestPostEventAccess()'),
    CGEventSourceSecondsSinceLastEventType: CG.func('double CGEventSourceSecondsSinceLastEventType(int32 stateID, uint32 eventType)'),
    CGWindowListCopyWindowInfo: CG.func('void *CGWindowListCopyWindowInfo(uint32 option, uint32 relativeToWindow)'),
    CGRectMakeWithDictionaryRepresentation: CG.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, void *rect)'),
    CFRelease: CF.func('void CFRelease(void *cf)'),
    CFArrayGetCount: CF.func('long CFArrayGetCount(void *array)'),
    CFArrayGetValueAtIndex: CF.func('void *CFArrayGetValueAtIndex(void *array, long index)'),
    CFDictionaryGetValue: CF.func('void *CFDictionaryGetValue(void *dict, void *key)'),
    CFStringCreateWithCString: CF.func('void *CFStringCreateWithCString(void *allocator, const char *cStr, uint32 encoding)'),
    CFStringGetCString: CF.func('bool CFStringGetCString(void *theString, void *buffer, long bufferSize, uint32 encoding)'),
    CFNumberGetValue: CF.func('bool CFNumberGetValue(void *number, int32 theType, void *valuePtr)'),
  };

  const source = api.CGEventSourceCreate(kCGEventSourceStatePrivate);
  const held = new Set();
  const heldButtons = new Set();
  let flags = 0;
  let current = { cancelled: false };
  let lastCursor = null;
  let lastInjectedAt = 0;
  let keyStrings = null;

  const post = event => {
    api.CGEventPost(kCGHIDEventTap, event);
    api.CFRelease(event);
    lastInjectedAt = now();
  };

  const toPoint = p => space.toDipPoint(p);

  // ---------- window list ----------

  function key(name) {
    keyStrings ??= new Map();
    if (!keyStrings.has(name)) keyStrings.set(name, api.CFStringCreateWithCString(null, name, UTF8));
    return keyStrings.get(name);
  }

  function readString(value) {
    if (!value) return '';
    const buf = Buffer.alloc(1024);
    return api.CFStringGetCString(value, buf, 1024, UTF8) ? buf.toString('utf8', 0, buf.indexOf(0) < 0 ? 1024 : buf.indexOf(0)) : '';
  }

  function readInt(value) {
    if (!value) return 0;
    const buf = Buffer.alloc(8);
    return api.CFNumberGetValue(value, 4, buf) ? Number(buf.readBigInt64LE(0)) : 0;
  }

  function readRect(dict) {
    if (!dict) return null;
    const buf = Buffer.alloc(32);
    if (!api.CGRectMakeWithDictionaryRepresentation(dict, buf)) return null;
    return { x: buf.readDoubleLE(0), y: buf.readDoubleLE(8), width: buf.readDoubleLE(16), height: buf.readDoubleLE(24) };
  }

  // The on-screen windows, front to back: { number, pid, name, layer, rect (points) }.
  function listRaw() {
    const array = api.CGWindowListCopyWindowInfo(1 | 16, 0);
    if (!array) return [];
    const out = [];
    try {
      const n = api.CFArrayGetCount(array);
      for (let i = 0; i < n; i++) {
        const d = api.CFArrayGetValueAtIndex(array, i);
        const rect = readRect(api.CFDictionaryGetValue(d, key('kCGWindowBounds')));
        if (!rect) continue;
        out.push({
          number: readInt(api.CFDictionaryGetValue(d, key('kCGWindowNumber'))),
          pid: readInt(api.CFDictionaryGetValue(d, key('kCGWindowOwnerPID'))),
          layer: readInt(api.CFDictionaryGetValue(d, key('kCGWindowLayer'))),
          name: readString(api.CFDictionaryGetValue(d, key('kCGWindowName'))),
          rect,
        });
      }
    } finally {
      api.CFRelease(array);
    }
    return out;
  }

  async function processTable(pids) {
    const list = [...new Set(pids)].filter(Boolean);
    if (list.length === 0) return new Map();
    try {
      return parsePs(await run('ps', ['-o', 'pid=,uid=,comm=', '-p', list.join(',')], { env: helperEnv }));
    } catch {
      return new Map();
    }
  }

  const physicalOf = rect => space.toPhysicalRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });

  async function windows({ all = false } = {}) {
    const raw = listRaw().filter(w => w.rect.width > 0 && w.rect.height > 0);
    const kept = all ? raw : raw.filter(w => w.layer === 0 && w.name);
    const table = await processTable(kept.map(w => w.pid));
    const me = getuid();
    return kept.map(w => {
      const p = table.get(w.pid);
      const entry = { id: String(w.number), pid: w.pid, exe: p?.exe ?? '', bounds: physicalOf(w.rect), elevated: !p || p.uid !== me };
      if (all) return entry;
      return { ...entry, title: w.name, own: w.pid === ownPid, minimized: false };
    });
  }

  async function foreground() {
    let asn;
    try {
      asn = parseFront(await run('lsappinfo', ['front'], { env: helperEnv }));
    } catch {
      return null;
    }
    if (!asn) return null;
    let info;
    try {
      info = parseAppInfo(await run('lsappinfo', ['info', '-only', 'name,pid,bundlepath', asn], { env: helperEnv }));
    } catch {
      return null;
    }
    if (!info) return null;
    const table = await processTable([info.pid]);
    const p = table.get(info.pid);
    const front = listRaw().find(w => w.layer === 0 && w.pid === info.pid);
    return {
      id: front ? String(front.number) : '',
      title: front?.name || info.name,
      exe: info.bundle || p?.exe || '',
      pid: info.pid,
      elevated: !p || p.uid !== getuid(),
      bounds: front ? physicalOf(front.rect) : { x: 0, y: 0, width: 0, height: 0 },
      own: info.pid === ownPid,
    };
  }

  async function cursor() {
    const event = api.CGEventCreate(null);
    if (!event) return { x: 0, y: 0 };
    try {
      const p = api.CGEventGetLocation(event);
      return space.toPhysicalPoint({ x: p.x, y: p.y });
    } finally {
      api.CFRelease(event);
    }
  }

  // ---------- the focused field ----------

  // undefined: not tried yet; null: the accessibility API cannot be used here (loaded once, never retried); else the functions.
  let ax;

  function loadAx() {
    if (ax !== undefined) return ax;
    ax = null;
    try {
      const services = koffi.load(AX_FRAMEWORK);
      const fns = {
        createSystemWide: services.func('void *AXUIElementCreateSystemWide()'),
        copyAttribute: services.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)'),
        setTimeout: null,
        secureInput: null,
        system: null,
      };
      try {
        fns.setTimeout = services.func('int AXUIElementSetMessagingTimeout(void *element, float timeoutInSeconds)');
      } catch {
        // Without it a hung program can make a call wait for the system's own limit; the answer is still right.
      }
      try {
        fns.secureInput = koffi.load(CARBON_FRAMEWORK).func('bool IsSecureEventInputEnabled()');
      } catch {
        // Without it only the accessibility answer is used.
      }
      fns.system = fns.createSystemWide();
      if (!fns.system) return ax;
      if (fns.setTimeout) {
        try {
          fns.setTimeout(fns.system, AX_TIMEOUT_SECONDS);
        } catch {
          // Not fatal.
        }
      }
      ax = fns;
    } catch {
      ax = null;
    }
    return ax;
  }

  // One attribute of an accessibility element, or null. Every value that comes back is the caller's to CFRelease.
  function axAttribute(f, element, name) {
    const out = [null];
    const error = f.copyAttribute(element, key(name), out);
    return error === 0 && out[0] ? out[0] : null;
  }

  function axString(f, element, name) {
    const value = axAttribute(f, element, name);
    if (!value) return '';
    try {
      return readString(value);
    } finally {
      api.CFRelease(value);
    }
  }

  // The focused element (a +1 reference to release), or null: the system-wide one first, then the focused application's.
  function axFocused(f) {
    const direct = axAttribute(f, f.system, 'AXFocusedUIElement');
    if (direct) return direct;
    const app = axAttribute(f, f.system, 'AXFocusedApplication');
    if (!app) return null;
    try {
      return axAttribute(f, app, 'AXFocusedUIElement');
    } finally {
      api.CFRelease(app);
    }
  }

  // The system's secure-input flag: true only when it is readable and on. A flag that cannot be read says nothing.
  function secureInputOn(f) {
    try {
      return !!f.secureInput && f.secureInput() === true;
    } catch {
      return false;
    }
  }

  // true: the focused field is a password field. false: it is a text field that is not. null: cannot tell.
  async function isSecureField() {
    let f;
    try {
      f = loadAx();
    } catch {
      return null;
    }
    if (!f) return null;
    try {
      const focused = axFocused(f);
      let role = '';
      let subrole = '';
      if (focused) {
        try {
          role = axString(f, focused, 'AXRole');
          subrole = axString(f, focused, 'AXSubrole');
        } finally {
          api.CFRelease(focused);
        }
        if (role === AX_SECURE || subrole === AX_SECURE) return true;
      }
      // A secure-input flag that is on is the system saying that a password may be being typed (AppKit and Chromium switch it on while a
      // password field has focus; a program can also keep it on for good, as Terminal's Secure Keyboard Entry does, and then it is on
      // for every field of every program). It wins over a plain text role too: a program may expose its password field as an ordinary
      // AXTextField. A false positive only refuses typing, the safe side; off says nothing either way.
      if (secureInputOn(f)) return true;
      // A text field with the flag off: the accessibility answer. Anything else is not conclusive (the program may not expose its fields,
      // or the permission may be missing).
      if (AX_TEXT_ROLES.has(role)) return false;
      return null;
    } catch {
      return null;
    }
  }

  // The title, description, help, identifier and placeholder of the focused element joined with " | " (a one-time code or CVV box says
  // so there: it is a plain text field), or null when none can be read.
  async function focusedLabel() {
    let f;
    try {
      f = loadAx();
    } catch {
      return null;
    }
    if (!f) return null;
    try {
      const focused = axFocused(f);
      if (!focused) return null;
      try {
        const parts = ['AXTitle', 'AXDescription', 'AXHelp', 'AXIdentifier', 'AXPlaceholderValue'].map(name => axString(f, focused, name).trim()).filter(Boolean);
        return parts.length ? parts.join(' | ').slice(0, 600) : null;
      } finally {
        api.CFRelease(focused);
      }
    } catch {
      return null;
    }
  }

  // ---------- input ----------

  const checkLive = token => {
    if (token.cancelled) throw Object.assign(new Error('stopped'), { stopped: true });
  };

  async function pause(ms, token) {
    let left = ms;
    while (left > 0) {
      checkLive(token);
      const slice = Math.min(left, 50);
      await wait(slice);
      left -= slice;
    }
    checkLive(token);
  }

  function keyCode(name) {
    if (Object.hasOwn(KEYCODES, name)) return KEYCODES[name];
    throw Object.assign(new Error(`The key ${name} is not available on macOS.`), { unsupported: true });
  }

  function keyEvent(name, down) {
    const code = keyCode(name);
    const event = api.CGEventCreateKeyboardEvent(source, code, down);
    if (name in FLAGS) {
      flags = down ? flags | FLAGS[name] : flags & ~FLAGS[name];
    }
    api.CGEventSetFlags(event, flags);
    post(event);
  }

  function keyDown(name) {
    keyEvent(name, true);
    held.add(name);
  }

  function keyUp(name) {
    keyEvent(name, false);
    held.delete(name);
  }

  // Lifts a key only if it is still held: a release() that came in meanwhile has lifted it already.
  const keyUpIfHeld = name => {
    if (held.has(name)) keyUp(name);
  };

  function mouseEvent(type, button, point, clickState) {
    const event = api.CGEventCreateMouseEvent(source, type, toPoint(point), MOUSE_TYPES[button].button);
    if (clickState) api.CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickState);
    api.CGEventSetFlags(event, flags);
    post(event);
  }

  let pointer = null;

  async function placeAt(x, y) {
    pointer = { x, y };
    // A move is a mouse-moved event, or a drag event while a button is down.
    const dragging = [...heldButtons][0];
    mouseEvent(dragging ? MOUSE_TYPES[dragging].drag : 5, dragging ?? 'left', pointer, 0);
  }

  async function withModifiers(mods, fn) {
    const pressed = [];
    try {
      for (const m of mods) {
        keyDown(m);
        pressed.push(m);
      }
      return await fn();
    } finally {
      for (const m of pressed.reverse()) {
        try {
          keyUpIfHeld(m);
        } catch {
          // release() lifts what is still held.
        }
      }
    }
  }

  async function position(a) {
    if (typeof a.x === 'number') await placeAt(a.x, a.y);
    else if (!pointer) pointer = await cursor();
  }

  async function perform(a, token) {
    const m = a.button ? MOUSE_TYPES[a.button] : null;
    switch (a.kind) {
      case 'move':
        await placeAt(a.x, a.y);
        break;
      case 'click':
        await withModifiers(a.modifiers ?? [], async () => {
          await position(a);
          await pause(15, token);
          for (let i = 1; i <= a.count; i++) {
            mouseEvent(m.down, a.button, pointer, i);
            mouseEvent(m.up, a.button, pointer, i);
            if (i < a.count) await pause(40, token);
          }
        });
        break;
      case 'down':
        await position(a);
        mouseEvent(m.down, a.button, pointer, 1);
        heldButtons.add(a.button);
        break;
      case 'up':
        await position(a);
        mouseEvent(m.up, a.button, pointer, 1);
        heldButtons.delete(a.button);
        break;
      case 'drag':
        await withModifiers(a.modifiers ?? [], async () => {
          await placeAt(a.from.x, a.from.y);
          await pause(30, token);
          mouseEvent(MOUSE_TYPES.left.down, 'left', pointer, 1);
          heldButtons.add('left');
          try {
            const steps = Math.max(4, Math.min(40, Math.round(Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) / 20)));
            for (let i = 1; i <= steps; i++) {
              await placeAt(Math.round(a.from.x + ((a.to.x - a.from.x) * i) / steps), Math.round(a.from.y + ((a.to.y - a.from.y) * i) / steps));
              await pause(8, token);
            }
          } finally {
            mouseEvent(MOUSE_TYPES.left.up, 'left', pointer, 1);
            heldButtons.delete('left');
          }
        });
        break;
      case 'scroll': {
        if (typeof a.x === 'number') await placeAt(a.x, a.y);
        const amount = a.amount * PIXELS_PER_NOTCH;
        const vertical = a.direction === 'up' ? amount : a.direction === 'down' ? -amount : 0;
        const horizontal = a.direction === 'left' ? amount : a.direction === 'right' ? -amount : 0;
        const event = api.CGEventCreateScrollWheelEvent2(source, kCGScrollEventUnitPixel, 2, vertical, horizontal, 0);
        post(event);
        break;
      }
      case 'type': {
        const text = a.text;
        for (let i = 0; i < text.length; ) {
          const ch = String.fromCodePoint(text.codePointAt(i));
          i += ch.length;
          if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && text[i] === '\n') i += 1;
            keyDown('Return');
            keyUp('Return');
          } else if (ch === '\t') {
            keyDown('Tab');
            keyUp('Tab');
          } else {
            const units = Buffer.alloc(ch.length * 2);
            for (let u = 0; u < ch.length; u++) units.writeUInt16LE(ch.charCodeAt(u), u * 2);
            for (const down of [true, false]) {
              const event = api.CGEventCreateKeyboardEvent(source, 0, down);
              api.CGEventKeyboardSetUnicodeString(event, ch.length, units);
              api.CGEventSetFlags(event, flags);
              post(event);
            }
          }
          await pause(8, token);
        }
        break;
      }
      case 'key':
        for (let r = 0; r < a.repeat; r++) {
          const pressed = [];
          try {
            for (const k of a.keys) {
              keyDown(k);
              pressed.push(k);
            }
          } finally {
            for (const k of pressed.reverse()) keyUpIfHeld(k);
          }
          if (r < a.repeat - 1) await pause(25, token);
        }
        break;
      case 'hold': {
        const pressed = [];
        try {
          for (const k of a.keys) {
            keyDown(k);
            pressed.push(k);
          }
          await pause(a.ms, token);
        } finally {
          for (const k of pressed.reverse()) keyUpIfHeld(k);
        }
        break;
      }
      default:
        throw Object.assign(new Error('That action is not one the desktop can inject.'), { unsupported: true });
    }
  }

  async function release() {
    current.cancelled = true;
    for (const k of [...held]) {
      try {
        keyUp(k);
      } catch {
        held.delete(k);
      }
    }
    for (const b of [...heldButtons]) {
      try {
        mouseEvent(MOUSE_TYPES[b].up, b, pointer ?? { x: 0, y: 0 }, 1);
      } catch {
        // Nothing more can be done.
      }
      heldButtons.delete(b);
    }
    flags = 0;
  }

  return {
    platform: 'darwin',

    async probe() {
      let input = 'not-determined';
      try {
        input = api.CGPreflightPostEventAccess() ? 'granted' : 'denied';
      } catch {
        input = 'not-determined';
      }
      let screen = 'not-determined';
      try {
        const status = screenStatus();
        screen = status === 'granted' ? 'granted' : status === 'not-determined' ? 'not-determined' : 'denied';
      } catch {
        screen = 'not-determined';
      }
      const supported = input === 'granted' && screen === 'granted';
      return {
        supported,
        reason: supported ? '' : 'Grant Screen Recording and Accessibility to Plenum in System Settings > Privacy & Security, then restart Plenum.',
        permissions: { screen, input },
        wayland: false,
        tools: { xdotool: null },
      };
    },

    // Asks macOS for the permission to post events, once. The person grants it in System Settings and restarts Plenum.
    async requestAccess() {
      try {
        return { ok: true, requested: ['input'], granted: !!api.CGRequestPostEventAccess() };
      } catch {
        return { ok: false, requested: [] };
      }
    },

    windows,
    foreground,
    cursor,

    async focus(windowId) {
      const target = listRaw().find(w => String(w.number) === String(windowId));
      if (!target || !Number.isInteger(target.pid) || target.pid <= 0) return { ok: false, reason: 'no-focus', message: 'That window is gone.' };
      try {
        await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${target.pid}) to true`], { env: helperEnv });
      } catch {
        return { ok: false, reason: 'no-focus', message: 'macOS did not bring that window to the front.' };
      }
      await wait(150);
      const now2 = await foreground();
      return now2 && now2.pid === target.pid ? { ok: true } : { ok: false, reason: 'no-focus', message: 'macOS did not bring that window to the front.' };
    },

    isSecureField,
    focusedLabel,

    async userInput() {
      const here = await cursor().catch(() => null);
      const mouse = here !== null && lastCursor !== null && Math.hypot(here.x - lastCursor.x, here.y - lastCursor.y) > 3;
      lastCursor = here;
      let keys = false;
      try {
        const idle = api.CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGEventKeyDown);
        keys = lastInjectedAt > 0 && idle * 1000 < now() - lastInjectedAt - 50;
      } catch {
        keys = false;
      }
      return { mouse, keys };
    },

    watch() {},

    async input(action) {
      const token = { cancelled: false };
      current = token;
      try {
        await perform(action, token);
        return { ok: true };
      } catch (err) {
        await release();
        if (err?.unsupported) return { ok: false, reason: 'unsupported', message: err.message };
        if (err?.stopped) return { ok: false, reason: 'blocked', message: 'The action was stopped.' };
        return { ok: false, reason: 'blocked', message: 'macOS refused the input. Check that Plenum has Accessibility permission.' };
      } finally {
        // Events are posted, not delivered, when CGEventPost returns: give a moved pointer a moment before reading where it is.
        if (movesPointer(action)) await wait(20);
        lastCursor = await cursor().catch(() => null);
      }
    },

    release,

    close() {
      return release();
    },
  };
}

module.exports = { createMacNative, NativeUnavailable, parseFront, parseAppInfo, parsePs, KEYCODES, FLAGS, MOUSE_TYPES };
