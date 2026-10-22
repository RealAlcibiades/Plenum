'use strict';
// The Windows half of the computer-use backend: input injection with SendInput, and the facts about windows (which one is in
// front, who owns it, whether it is elevated, where it is), all through koffi (MIT, N-API, prebuilt, so Electron needs no rebuild).
// Nothing here runs unless desktop/computer/index.cjs asks for it on win32; the unit tests give createWinNative a stand-in koffi.
//
//  - INPUT is declared as koffi structs and unions only to CHECK the layout: koffi.sizeof(INPUT) must be 40 (MOUSEINPUT 32, KEYBDINPUT
//    24, the union pads to 8) or the backend refuses to start. The events themselves are written into a Buffer at those offsets and
//    passed to SendInput as a pointer, so the bytes are exactly the ones Windows documents. dwExtraInfo is 0x504C4E4D on every
//    injected event.
//  - Mouse moves are MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, normalised to the virtual screen (GetSystemMetrics 76..79).
//    A click is move, down, up; double and triple clicks repeat with 40 ms between. Wheel deltas are WHEEL_DELTA * amount.
//  - Text is KEYEVENTF_UNICODE per UTF-16 unit (a surrogate pair is two units), 8 ms apart. Line breaks are the Return key and tabs
//    the Tab key. Named keys are virtual-key codes (KEYEVENTF_EXTENDEDKEY where Windows wants it); modifiers go down before the key
//    and up after it, and release() lifts every key and button this module still holds.
//  - SendInput returning fewer events than it was given means the input was blocked (another thread has BlockInput, or the target
//    is a higher integrity level than Plenum): { ok: false, reason: 'blocked' }.
//  - A window is "elevated" when its process cannot be opened (access denied) or its token's integrity level RID is 0x3000 or more.
//    index.cjs refuses input while such a window is in front or under the pointer, before anything is sent.
//  - ApplicationFrameHost.exe windows (Store apps) are reported as the app they host (the first child window with another pid), so
//    Calculator reads as CalculatorApp.exe; when no hosted app is found the window keeps applicationframehost.exe, which the gate
//    refuses.
//  - The module sends only what normalizeAction (actions.cjs) produced. It never logs, and typed text exists only in the call.
const koffiBindings = new WeakMap();

class NativeUnavailable extends Error {}
class InputBlocked extends Error {}
class InputCancelled extends Error {}
class Unsupported extends Error {}

const EXTRA_INFO = 0x504c4e4d;
const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010, MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040,
  WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
});
const WHEEL_DELTA = 120;
const CLICK_GAP_MS = 40;
const CHAR_GAP_MS = 8;

// Virtual-key codes for the canonical key names (actions.cjs KEY_NAMES).
const VK = Object.freeze({
  Return: 0x0d, Tab: 0x09, Escape: 0x1b, BackSpace: 0x08, Delete: 0x2e, Insert: 0x2d, Home: 0x24, End: 0x23, Page_Up: 0x21, Page_Down: 0x22,
  Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27, space: 0x20,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  ctrl: 0x11, shift: 0x10, alt: 0x12, super: 0x5b,
});
// Keys that need KEYEVENTF_EXTENDEDKEY (the grey keys of the navigation block, the arrows and the Windows key).
const EXTENDED_KEYS = new Set(['Insert', 'Delete', 'Home', 'End', 'Page_Up', 'Page_Down', 'Up', 'Down', 'Left', 'Right', 'super']);
const MODIFIER_NAMES = ['ctrl', 'shift', 'alt', 'super'];

const BUTTON_FLAGS = Object.freeze({
  left: { down: MOUSEEVENTF.LEFTDOWN, up: MOUSEEVENTF.LEFTUP },
  right: { down: MOUSEEVENTF.RIGHTDOWN, up: MOUSEEVENTF.RIGHTUP },
  middle: { down: MOUSEEVENTF.MIDDLEDOWN, up: MOUSEEVENTF.MIDDLEUP },
});

// ---------- pure helpers (exported for the tests) ----------

// A point on the virtual screen -> 0..65535, aimed at the middle of the pixel so that it maps back to the same pixel.
function normalizeAbsolute(x, y, virtual) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const px = clamp(x, virtual.x, virtual.x + virtual.width - 1);
  const py = clamp(y, virtual.y, virtual.y + virtual.height - 1);
  return {
    x: clamp(Math.round(((px - virtual.x + 0.5) * 65535) / virtual.width), 0, 65535),
    y: clamp(Math.round(((py - virtual.y + 0.5) * 65535) / virtual.height), 0, 65535),
  };
}

function writeInputHeader(buf, index, type) {
  const o = index * INPUT_SIZE;
  buf.writeUInt32LE(type, o);
  return o;
}

// One INPUT_KEYBOARD at slot `index` of buf. The union starts at offset 8 (the pointer-sized member pads it).
function writeKeyboard(buf, index, { vk = 0, scan = 0, flags = 0 }) {
  const o = writeInputHeader(buf, index, INPUT_KEYBOARD);
  buf.writeUInt16LE(vk, o + 8);
  buf.writeUInt16LE(scan, o + 10);
  buf.writeUInt32LE(flags >>> 0, o + 12);
  buf.writeUInt32LE(0, o + 16);
  buf.writeBigUInt64LE(BigInt(EXTRA_INFO), o + 24);
}

// One INPUT_MOUSE at slot `index` of buf.
function writeMouse(buf, index, { dx = 0, dy = 0, data = 0, flags = 0 }) {
  const o = writeInputHeader(buf, index, INPUT_MOUSE);
  buf.writeInt32LE(dx, o + 8);
  buf.writeInt32LE(dy, o + 12);
  buf.writeUInt32LE(data >>> 0, o + 16);
  buf.writeUInt32LE(flags >>> 0, o + 20);
  buf.writeUInt32LE(0, o + 24);
  buf.writeBigUInt64LE(BigInt(EXTRA_INFO), o + 32);
}

function encodeEvents(events) {
  const buf = Buffer.alloc(INPUT_SIZE * events.length);
  events.forEach((e, i) => (e.mouse ? writeMouse(buf, i, e.mouse) : writeKeyboard(buf, i, e.key)));
  return buf;
}

// The UTF-16 code units of a string (a character outside the BMP is two units).
function utf16Units(text) {
  const units = [];
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  return units;
}

// The integrity level RID in a TOKEN_MANDATORY_LABEL buffer: the SID follows the 16-byte structure, S-1-16-<rid>. -> number | null
function integrityRid(buf) {
  for (const at of [16, 8]) {
    if (buf.length >= at + 12 && buf[at] === 1 && buf[at + 1] >= 1 && buf[at + 1] <= 15 && buf[at + 7] === 16 && buf.subarray(at + 2, at + 7).every(b => b === 0)) {
      const count = buf[at + 1];
      return buf.readUInt32LE(at + 8 + (count - 1) * 4);
    }
  }
  return null;
}

const rectFrom = (buf, at = 0) => ({ x: buf.readInt32LE(at), y: buf.readInt32LE(at + 4), width: buf.readInt32LE(at + 8) - buf.readInt32LE(at), height: buf.readInt32LE(at + 12) - buf.readInt32LE(at + 4) });
const wide = (buf, chars) => buf.toString('utf16le', 0, Math.max(0, chars) * 2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseName = exe => String(exe ?? '').split(/[\\/]/).pop().toLowerCase();

// ---------- koffi declarations ----------

function bind(koffi) {
  if (koffiBindings.has(koffi)) return koffiBindings.get(koffi);
  if (!['x64', 'arm64'].includes(process.arch)) throw new NativeUnavailable('Computer use needs a 64-bit version of Windows.');
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_U = koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_U });
  const sizes = { INPUT: koffi.sizeof(INPUT), MOUSEINPUT: koffi.sizeof(MOUSEINPUT), KEYBDINPUT: koffi.sizeof(KEYBDINPUT) };
  if (sizes.INPUT !== INPUT_SIZE || sizes.MOUSEINPUT !== 32 || sizes.KEYBDINPUT !== 24) {
    throw new NativeUnavailable(`Computer use cannot start: the INPUT structure is ${sizes.INPUT} bytes here, not ${INPUT_SIZE}.`);
  }
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const EnumProc = koffi.proto('int __stdcall PlenumEnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  koffi.proto('int __stdcall PlenumMonitorEnumProc(intptr_t hMonitor, intptr_t hdc, void *lprcMonitor, intptr_t dwData)');
  const api = {
    sizes,
    EnumProc,
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, void *lpdwProcessId)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, void *lpString, int nMaxCount)'),
    GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hWnd)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, void *lpClassName, int nMaxCount)'),
    EnumWindows: user32.func('int __stdcall EnumWindows(PlenumEnumWindowsProc *lpEnumFunc, intptr_t lParam)'),
    EnumChildWindows: user32.func('int __stdcall EnumChildWindows(intptr_t hWndParent, PlenumEnumWindowsProc *lpEnumFunc, intptr_t lParam)'),
    IsWindowVisible: user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)'),
    IsIconic: user32.func('int __stdcall IsIconic(intptr_t hWnd)'),
    IsWindow: user32.func('int __stdcall IsWindow(intptr_t hWnd)'),
    GetWindowLongW: user32.func('int32 __stdcall GetWindowLongW(intptr_t hWnd, int nIndex)'),
    EnumDisplayMonitors: user32.func('int __stdcall EnumDisplayMonitors(intptr_t hdc, void *lprcClip, PlenumMonitorEnumProc *lpfnEnum, intptr_t dwData)'),
    GetMonitorInfoW: user32.func('int __stdcall GetMonitorInfoW(intptr_t hMonitor, void *lpmi)'),
    GetWindowRect: user32.func('int __stdcall GetWindowRect(intptr_t hWnd, void *lpRect)'),
    GetWindowPlacement: user32.func('int __stdcall GetWindowPlacement(intptr_t hWnd, void *lpwndpl)'),
    GetCursorPos: user32.func('int __stdcall GetCursorPos(void *lpPoint)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
    ShowWindow: user32.func('int __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)'),
    SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(intptr_t hWnd)'),
    SwitchToThisWindow: user32.func('void __stdcall SwitchToThisWindow(intptr_t hWnd, int fUnknown)'),
    GetGUIThreadInfo: user32.func('int __stdcall GetGUIThreadInfo(uint32 idThread, void *pgui)'),
    GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int vKey)'),
    VkKeyScanW: user32.func('int16 __stdcall VkKeyScanW(uint16 ch)'),
    MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)'),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(intptr_t hObject)'),
    QueryFullProcessImageNameW: kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr_t hProcess, uint32 dwFlags, void *lpExeName, void *lpdwSize)'),
    OpenProcessToken: advapi32.func('int __stdcall OpenProcessToken(intptr_t ProcessHandle, uint32 DesiredAccess, void *TokenHandle)'),
    GetTokenInformation: advapi32.func('int __stdcall GetTokenInformation(intptr_t TokenHandle, int TokenInformationClass, void *TokenInformation, uint32 TokenInformationLength, void *ReturnLength)'),
    DwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 dwAttribute, void *pvAttribute, uint32 cbAttribute)'),
  };
  koffiBindings.set(koffi, api);
  return api;
}

// ---------- the backend ----------

function createWinNative({ koffi, ownPid = process.pid, wait = sleep, now = Date.now } = {}) {
  if (!koffi) throw new NativeUnavailable('Computer use needs the koffi module, which is missing from this install.');
  const api = bind(koffi);
  const errno = typeof koffi.errno === 'function' ? () => koffi.errno() : () => 0;

  const idOf = v => (typeof v === 'bigint' ? v.toString() : String(Math.trunc(Number(v))));
  const isZero = v => Number(v) === 0;
  const handleArg = id => {
    const n = Number(id);
    return Number.isSafeInteger(n) ? n : BigInt(id);
  };

  // Keys and buttons this module has pressed and not yet released.
  const heldKeys = new Map(); // vk -> { extended }
  const heldButtons = new Set();
  let current = { cancelled: false };
  let lastCursor = null;
  let injectingUntil = 0;
  const recentKeys = new Map(); // vk -> time of our last event
  let userKeys = false;
  let watchTimer = null;
  let primed = false;
  let virtualCache = { at: 0, rect: null };

  // ---------- low level ----------

  function virtualScreen() {
    if (virtualCache.rect && now() - virtualCache.at < 1500) return virtualCache.rect;
    const rect = {
      x: api.GetSystemMetrics(76),
      y: api.GetSystemMetrics(77),
      width: Math.max(1, api.GetSystemMetrics(78)),
      height: Math.max(1, api.GetSystemMetrics(79)),
    };
    virtualCache = { at: now(), rect };
    return rect;
  }

  function sendEvents(events) {
    if (events.length === 0) return;
    injectingUntil = now() + 200;
    const sent = api.SendInput(events.length, encodeEvents(events), INPUT_SIZE);
    if (sent < events.length) throw new InputBlocked('Windows refused the input. A program running as administrator may be in front, or another program is blocking input.');
  }

  const checkLive = token => {
    if (token.cancelled) throw new InputCancelled('stopped');
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

  const scanOf = vk => {
    try {
      return api.MapVirtualKeyW(vk, 0) & 0xff;
    } catch {
      return 0;
    }
  };

  // The virtual-key code and extended flag of a canonical key name (or a single character).
  function keyCode(name) {
    if (Object.hasOwn(VK, name)) return { vk: VK[name], extended: EXTENDED_KEYS.has(name) };
    if ([...name].length !== 1) throw new Unsupported(`The key ${name} is not available on Windows.`);
    const ch = name;
    if (/^[a-z]$/.test(ch)) return { vk: ch.toUpperCase().charCodeAt(0), extended: false };
    if (/^[0-9]$/.test(ch)) return { vk: ch.charCodeAt(0), extended: false };
    const code = ch.charCodeAt(0);
    const found = code <= 0xffff ? api.VkKeyScanW(code) : -1;
    if (found === -1 || (found & 0xff) === 0xff) throw new Unsupported(`The character ${ch} is not a key on this keyboard layout.`);
    return { vk: found & 0xff, extended: false };
  }

  const keyEvent = (vk, extended, up) => ({ key: { vk, scan: scanOf(vk), flags: (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0) } });

  function keyDown(name) {
    const { vk, extended } = keyCode(name);
    sendEvents([keyEvent(vk, extended, false)]);
    heldKeys.set(vk, { extended });
    recentKeys.set(vk, now());
  }

  function keyUp(name) {
    const { vk, extended } = keyCode(name);
    sendEvents([keyEvent(vk, extended, true)]);
    heldKeys.delete(vk);
    recentKeys.set(vk, now());
  }

  // Lifts a key only if this module still holds it: a release() that came in meanwhile has lifted it already, and once is enough.
  function keyUpIfHeld(name) {
    if (heldKeys.has(keyCode(name).vk)) keyUp(name);
  }

  async function tap(name, token) {
    const { vk, extended } = keyCode(name);
    sendEvents([keyEvent(vk, extended, false), keyEvent(vk, extended, true)]);
    recentKeys.set(vk, now());
    checkLive(token);
  }

  function moveTo(x, y) {
    const n = normalizeAbsolute(x, y, virtualScreen());
    sendEvents([{ mouse: { dx: n.x, dy: n.y, flags: MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK } }]);
  }

  function buttonDown(button) {
    sendEvents([{ mouse: { flags: BUTTON_FLAGS[button].down } }]);
    heldButtons.add(button);
  }

  function buttonUp(button) {
    sendEvents([{ mouse: { flags: BUTTON_FLAGS[button].up } }]);
    heldButtons.delete(button);
  }

  async function withModifiers(mods, token, fn) {
    const pressed = [];
    try {
      for (const m of mods) {
        keyDown(m);
        pressed.push(m);
      }
      await wait(10);
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

  function readCursor() {
    const buf = Buffer.alloc(8);
    api.GetCursorPos(buf);
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
  }

  // ---------- actions ----------

  async function doClick(a, token) {
    await withModifiers(a.modifiers ?? [], token, async () => {
      if (typeof a.x === 'number') {
        moveTo(a.x, a.y);
        await pause(20, token);
      }
      for (let i = 0; i < a.count; i++) {
        sendEvents([{ mouse: { flags: BUTTON_FLAGS[a.button].down } }, { mouse: { flags: BUTTON_FLAGS[a.button].up } }]);
        if (i < a.count - 1) await pause(CLICK_GAP_MS, token);
      }
    });
  }

  async function doDrag(a, token) {
    await withModifiers(a.modifiers ?? [], token, async () => {
      moveTo(a.from.x, a.from.y);
      await pause(30, token);
      buttonDown('left');
      try {
        const dist = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y);
        const steps = Math.max(4, Math.min(40, Math.round(dist / 20)));
        for (let i = 1; i <= steps; i++) {
          moveTo(Math.round(a.from.x + ((a.to.x - a.from.x) * i) / steps), Math.round(a.from.y + ((a.to.y - a.from.y) * i) / steps));
          await pause(8, token);
        }
        await pause(30, token);
      } finally {
        buttonUp('left');
      }
    });
  }

  async function doScroll(a, token) {
    if (typeof a.x === 'number') {
      moveTo(a.x, a.y);
      await pause(20, token);
    }
    const horizontal = a.direction === 'left' || a.direction === 'right';
    const sign = a.direction === 'up' || a.direction === 'right' ? 1 : -1;
    let left = a.amount;
    while (left > 0) {
      const notches = Math.min(left, 10);
      sendEvents([{ mouse: { data: sign * notches * WHEEL_DELTA, flags: horizontal ? MOUSEEVENTF.HWHEEL : MOUSEEVENTF.WHEEL } }]);
      left -= notches;
      if (left > 0) await pause(10, token);
    }
  }

  async function doType(a, token) {
    const text = a.text;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (ch === '\r') {
        if (text[i] === '\n') i += 1;
        await tap('Return', token);
      } else if (ch === '\n') {
        await tap('Return', token);
      } else if (ch === '\t') {
        await tap('Tab', token);
      } else {
        for (const unit of utf16Units(ch)) {
          sendEvents([{ key: { vk: 0, scan: unit, flags: KEYEVENTF_UNICODE } }, { key: { vk: 0, scan: unit, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } }]);
        }
        checkLive(token);
      }
      await pause(CHAR_GAP_MS, token);
    }
  }

  async function doKey(a, token) {
    for (let r = 0; r < a.repeat; r++) {
      const pressed = [];
      try {
        for (const k of a.keys) {
          keyDown(k);
          pressed.push(k);
        }
        await wait(5);
      } finally {
        for (const k of pressed.reverse()) {
          try {
            keyUpIfHeld(k);
          } catch {
            // release() lifts what is still held.
          }
        }
      }
      checkLive(token);
      if (r < a.repeat - 1) await pause(25, token);
    }
  }

  async function doHold(a, token) {
    const pressed = [];
    try {
      for (const k of a.keys) {
        keyDown(k);
        pressed.push(k);
      }
      await pause(a.ms, token);
    } finally {
      for (const k of pressed.reverse()) {
        try {
          keyUpIfHeld(k);
        } catch {
          // release() lifts what is still held.
        }
      }
    }
  }

  async function release() {
    current.cancelled = true;
    const events = [];
    for (const [vk, { extended }] of heldKeys) events.push(keyEvent(vk, extended, true));
    for (const button of heldButtons) events.push({ mouse: { flags: BUTTON_FLAGS[button].up } });
    heldKeys.clear();
    heldButtons.clear();
    if (events.length) {
      try {
        sendEvents(events);
      } catch {
        // Nothing more can be done; the next action starts clean.
      }
    }
  }

  // ---------- windows ----------

  const procCache = new Map();

  // { exe, elevated } for a process id, or null when the process is gone.
  function processFacts(pid) {
    const cached = procCache.get(pid);
    if (cached && now() - cached.at < 1500) return cached.value;
    let value;
    const handle = api.OpenProcess(0x1000, 0, pid);
    if (isZero(handle)) {
      // Only "no such process" (87) means the process is gone. Access denied, and any failure that is not understood, count as a
      // process we may not look at, which is an elevated one: input to it is refused.
      value = errno() === 87 ? null : { exe: '', elevated: true };
    } else {
      try {
        const buf = Buffer.alloc(2048);
        const size = Buffer.alloc(4);
        size.writeUInt32LE(1024, 0);
        const ok = api.QueryFullProcessImageNameW(handle, 0, buf, size);
        const exe = ok ? wide(buf, size.readUInt32LE(0)) : '';
        let elevated = true;
        const tok = Buffer.alloc(8);
        if (api.OpenProcessToken(handle, 0x0008, tok)) {
          const token = tok.readBigUInt64LE(0);
          try {
            const info = Buffer.alloc(256);
            const ret = Buffer.alloc(4);
            if (api.GetTokenInformation(Number(token), 25, info, 256, ret)) {
              const rid = integrityRid(info);
              if (rid !== null) elevated = rid >= 0x3000;
            }
          } finally {
            api.CloseHandle(Number(token));
          }
        }
        value = { exe, elevated };
      } finally {
        api.CloseHandle(handle);
      }
    }
    procCache.set(pid, { at: now(), value });
    return value;
  }

  function pidOf(hwnd) {
    const buf = Buffer.alloc(4);
    const tid = api.GetWindowThreadProcessId(handleArg(hwnd), buf);
    return { pid: buf.readUInt32LE(0), tid };
  }

  function classOf(hwnd) {
    const buf = Buffer.alloc(512);
    const n = api.GetClassNameW(handleArg(hwnd), buf, 256);
    return wide(buf, n);
  }

  function titleOf(hwnd) {
    const len = Math.min(512, Math.max(0, api.GetWindowTextLengthW(handleArg(hwnd))));
    if (len === 0) return '';
    const buf = Buffer.alloc((len + 1) * 2);
    const n = api.GetWindowTextW(handleArg(hwnd), buf, len + 1);
    return wide(buf, n);
  }

  function isCloaked(hwnd) {
    const buf = Buffer.alloc(4);
    return api.DwmGetWindowAttribute(handleArg(hwnd), 14, buf, 4) === 0 && buf.readUInt32LE(0) !== 0;
  }

  function boundsOf(hwnd, minimized) {
    if (minimized) {
      const buf = Buffer.alloc(44);
      buf.writeUInt32LE(44, 0);
      if (api.GetWindowPlacement(handleArg(hwnd), buf)) return rectFrom(buf, 28);
    }
    const buf = Buffer.alloc(16);
    if (api.DwmGetWindowAttribute(handleArg(hwnd), 9, buf, 16) === 0) return rectFrom(buf);
    if (api.GetWindowRect(handleArg(hwnd), buf)) return rectFrom(buf);
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  function enumerate(fn) {
    const list = [];
    fn(hwnd => {
      list.push(idOf(hwnd));
      return 1;
    });
    return list;
  }

  // The app a Store window hosts: the first child window of another process.
  function hostedApp(hwnd, framePid) {
    const children = enumerate(cb => api.EnumChildWindows(handleArg(hwnd), cb, 0));
    for (const child of children) {
      const { pid } = pidOf(child);
      if (pid && pid !== framePid) return pid;
    }
    return null;
  }

  // The facts about one window, or null when it is gone or its process cannot be read.
  function describe(hwnd, { full = true } = {}) {
    if (isZero(hwnd) || !api.IsWindow(handleArg(hwnd))) return null;
    const { pid: framePid } = pidOf(hwnd);
    if (!framePid) return null;
    let facts = processFacts(framePid);
    let pid = framePid;
    if (!facts) return null;
    if (baseName(facts.exe) === 'applicationframehost.exe') {
      const hosted = hostedApp(hwnd, framePid);
      const hostedFacts = hosted ? processFacts(hosted) : null;
      if (hostedFacts) {
        facts = hostedFacts;
        pid = hosted;
      }
    }
    const minimized = !!api.IsIconic(handleArg(hwnd));
    const out = { id: idOf(hwnd), pid, exe: facts.exe, elevated: facts.elevated, bounds: boundsOf(hwnd, minimized), own: framePid === ownPid, minimized };
    if (full) out.title = titleOf(hwnd);
    return out;
  }

  const SKIPPED_CLASSES = new Set(['progman', 'workerw']);

  function visibleWindow(hwnd) {
    return !!api.IsWindowVisible(handleArg(hwnd)) && !isCloaked(hwnd);
  }

  async function windows({ all = false } = {}) {
    const handles = enumerate(cb => api.EnumWindows(cb, 0));
    const out = [];
    for (const id of handles) {
      if (!visibleWindow(id)) continue;
      if (all) {
        const w = describe(id, { full: false });
        // A minimised window is not on screen, so it is not part of the stacking order.
        if (w && !w.minimized && w.bounds.width > 0 && w.bounds.height > 0) out.push({ id: w.id, pid: w.pid, exe: w.exe, bounds: w.bounds, elevated: w.elevated });
        continue;
      }
      const title = titleOf(id);
      if (!title) continue;
      const exStyle = api.GetWindowLongW(handleArg(id), -20);
      if ((exStyle & 0x80) !== 0 && (exStyle & 0x40000) === 0) continue;
      if (SKIPPED_CLASSES.has(classOf(id).toLowerCase())) continue;
      const w = describe(id);
      if (w) out.push({ id: w.id, title: w.title, exe: w.exe, pid: w.pid, bounds: w.bounds, own: w.own, minimized: w.minimized });
    }
    return out;
  }

  async function foreground() {
    const hwnd = api.GetForegroundWindow();
    if (isZero(hwnd)) return null;
    const w = describe(hwnd);
    return w ? { id: w.id, title: w.title, exe: w.exe, pid: w.pid, elevated: w.elevated, bounds: w.bounds, own: w.own } : null;
  }

  async function focus(windowId) {
    const hwnd = handleArg(windowId);
    if (!api.IsWindow(hwnd)) return { ok: false, reason: 'no-focus', message: 'That window is gone.' };
    if (api.IsIconic(hwnd)) api.ShowWindow(hwnd, 9);
    api.SetForegroundWindow(hwnd);
    await wait(60);
    if (idOf(api.GetForegroundWindow()) !== String(windowId)) {
      api.SwitchToThisWindow(hwnd, 1);
      await wait(120);
    }
    return idOf(api.GetForegroundWindow()) === String(windowId) ? { ok: true } : { ok: false, reason: 'no-focus', message: 'Windows did not bring that window to the front.' };
  }

  async function isSecureField() {
    const fg = api.GetForegroundWindow();
    if (isZero(fg)) return null;
    const { tid } = pidOf(fg);
    const info = Buffer.alloc(72);
    info.writeUInt32LE(72, 0);
    if (!api.GetGUIThreadInfo(tid, info)) return null;
    const focusHandle = info.readBigUInt64LE(16);
    if (focusHandle === 0n) return null;
    if (classOf(focusHandle).toLowerCase() !== 'edit') return null;
    return (api.GetWindowLongW(Number(focusHandle), -16) & 0x20) !== 0;
  }

  // ---------- user input ----------

  // Reads every key once and throws the answer away, so a press from before the run is not taken for the person's during it.
  function primeKeys() {
    for (let vk = 0x08; vk <= 0xfe; vk++) api.GetAsyncKeyState(vk);
    userKeys = false;
  }

  function sweepKeys() {
    if (now() < injectingUntil) return;
    for (let vk = 0x08; vk <= 0xfe; vk++) {
      if (vk === 0xe7 || heldKeys.has(vk)) continue;
      if (now() - (recentKeys.get(vk) ?? 0) < 400) continue;
      if ((api.GetAsyncKeyState(vk) & 0x8001) !== 0) {
        userKeys = true;
        return;
      }
    }
  }

  // The exact physical rectangle of every monitor (the system's own numbers), or null if they cannot be read. Synchronous.
  function monitors() {
    try {
      const handles = [];
      api.EnumDisplayMonitors(0, null, hMonitor => {
        handles.push(hMonitor);
        return 1;
      }, 0);
      const out = [];
      for (const h of handles) {
        const info = Buffer.alloc(40);
        info.writeUInt32LE(40, 0);
        if (api.GetMonitorInfoW(typeof h === 'bigint' ? h : Number(h), info)) out.push(rectFrom(info, 4));
      }
      return out.length ? out : null;
    } catch {
      return null;
    }
  }

  return {
    platform: 'win32',
    sizes: api.sizes,
    monitors,

    async probe() {
      return { supported: true, reason: '', permissions: { screen: 'n/a', input: 'n/a' }, wayland: false, tools: { xdotool: null } };
    },

    windows,
    foreground,
    focus,
    isSecureField,

    async cursor() {
      return readCursor();
    },

    // mouse: the pointer is more than 3 px from where our last injected move, or the last call, left it. keys: the sweep saw a key
    // down that this module did not press (best effort: it runs on a 100 ms timer while a run is live).
    async userInput() {
      if (!primed) {
        primed = true;
        primeKeys();
      }
      const here = readCursor();
      const mouse = lastCursor !== null && Math.hypot(here.x - lastCursor.x, here.y - lastCursor.y) > 3;
      lastCursor = here;
      sweepKeys();
      const keys = userKeys;
      userKeys = false;
      return { mouse, keys };
    },

    // Starts or stops the 100 ms key sweep (the shell turns it on while the overlay shows).
    watch(on) {
      if (on && !watchTimer) {
        primed = true;
        primeKeys();
        watchTimer = setInterval(sweepKeys, 100);
        watchTimer.unref?.();
      } else if (!on && watchTimer) {
        clearInterval(watchTimer);
        watchTimer = null;
      }
    },

    async input(action) {
      const token = { cancelled: false };
      current = token;
      try {
        switch (action.kind) {
          case 'move':
            moveTo(action.x, action.y);
            break;
          case 'click':
            await doClick(action, token);
            break;
          case 'down':
            buttonDown(action.button);
            break;
          case 'up':
            buttonUp(action.button);
            break;
          case 'drag':
            await doDrag(action, token);
            break;
          case 'scroll':
            await doScroll(action, token);
            break;
          case 'type':
            await doType(action, token);
            break;
          case 'key':
            await doKey(action, token);
            break;
          case 'hold':
            await doHold(action, token);
            break;
          default:
            return { ok: false, reason: 'unsupported', message: 'That action is not one the desktop can inject.' };
        }
        return { ok: true };
      } catch (err) {
        await release();
        if (err instanceof InputCancelled) return { ok: false, reason: 'blocked', message: 'The action was stopped.' };
        if (err instanceof Unsupported) return { ok: false, reason: 'unsupported', message: err.message };
        if (err instanceof InputBlocked) return { ok: false, reason: 'blocked', message: err.message };
        return { ok: false, reason: 'blocked', message: 'The input could not be sent.' };
      } finally {
        // The pointer has not always arrived when SendInput returns, so an action that moved it gets a moment before the position is
        // read as "where the backend left it"; read too early, the person would seem to have moved the mouse.
        try {
          if (action.kind === 'drag' || typeof action.x === 'number') await wait(20);
          lastCursor = readCursor();
        } catch {
          lastCursor = null;
        }
      }
    },

    release,

    close() {
      this.watch(false);
      return release();
    },
  };
}

module.exports = {
  createWinNative, NativeUnavailable,
  VK, EXTENDED_KEYS, MODIFIER_NAMES, MOUSEEVENTF, INPUT_SIZE, EXTRA_INFO, WHEEL_DELTA,
  normalizeAbsolute, encodeEvents, writeKeyboard, writeMouse, utf16Units, integrityRid, rectFrom,
};
