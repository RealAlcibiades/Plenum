'use strict';
// The computer-use backend of the desktop shell: screen capture, input injection, window and foreground facts, and the control
// overlay, behind one interface. Platform differences live in this folder (win.cjs, mac.cjs, linux.cjs); nothing outside it tests
// process.platform for this. The shell (desktop/handlers/computer.cjs) owns one backend and the server reaches it over the shell
// channel with messages named computer-<method>; handle() below is the whole of that protocol.
//
//   createComputerBackend({ platform = process.platform, fake = process.env.PLENUM_COMPUTER_BACKEND === 'fake', fakeOptions,
//                           overlayUrl, electron, koffi, run, env, getToken, theme })
//
// Every method is async, returns plain data and never throws for a refused action. Coordinates are PHYSICAL pixels.
//   probe()                    -> { supported, reason, platform, displays: [{ id, label, bounds, scaleFactor, physical }], permissions,
//                                   wayland, tools: { xdotool }, overlay: 'protected'|'hidden-during-capture'|'unknown' }
//   windows({ all = false })   -> [{ id, title, exe, pid, displayId, bounds, own, minimized }]; with all: true, every visible
//                                 top-level window topmost first as { id, pid, exe, bounds } (null where the platform cannot say)
//   foreground()               -> { id, title, exe, pid, elevated, bounds, own } | null
//   capture({ scope, target, maxEdge }) -> { png: Uint8Array, width, height, physical, scale } | { ok: false, reason, message }
//   input(action)              -> { ok: true } | { ok: false, reason: 'elevated'|'blocked'|'unsupported'|'no-focus', message }
//   cursor() -> { x, y }       userInput() -> { mouse, keys }        focus(windowId) -> { ok }
//   isSecureField() -> true|false|null     release()      overlay({ show, displayId, rect, state, model, label })
//
// input() refuses before it sends anything when the window in front, or the window under any point of the action, is elevated.
// An action is parsed again here by normalizeAction (actions.cjs), so only fields that module knows ever reach the injector.
// Text of more than 64 characters is typed in pieces; between pieces the program in front is read again, and typing stops there
// ({ ok: false, reason: 'no-focus' }, or 'elevated') when it is no longer the program the typing began in.
//
// The wire protocol (handle): a message { type: 'computer-<method>', id, ...arguments } is answered with
// { type: 'computer-<method>-result', id, ...result }. <method> is the kebab-case of the method name above (computer-user-input,
// computer-is-secure-field; computer-secure-field is accepted too). Arguments are the fields of the message: windows { all },
// capture { scope, target, maxEdge }, input { action }, focus { windowId }, overlay { show, displayId, rect, state, model, label }.
// A result that is not an object, or that has an id or type of its own, travels under a name: windows -> { windows }, foreground ->
// { foreground }, isSecureField -> { secure }. Nothing from a message is logged here, and typed text exists only in the call.
const geometry = require('./geometry.cjs');
const { normalizeAction, pointsOf } = require('./actions.cjs');
const { createSpace, createCapture } = require('./capture.cjs');
const { createOverlay } = require('./overlay.cjs');
const { createFakeBackend } = require('./fake.cjs');

const ELEVATED_MESSAGE = 'The window in front belongs to a program running as administrator. Plenum cannot control it.';
const ELEVATED_POINT_MESSAGE = 'That spot belongs to a program running as administrator. Plenum cannot control it.';
const NOT_AVAILABLE = 'Computer use is not available on this computer.';
const FOCUS_CHANGED_MESSAGE = 'The program in front changed while the text was being typed, so the rest of it was not typed.';
// Text is typed in pieces of this many characters, and the program in front is looked at again between pieces.
const TYPE_PIECE = 64;

const METHODS = Object.freeze({
  probe: 'probe', windows: 'windows', foreground: 'foreground', capture: 'capture', input: 'input', cursor: 'cursor',
  userInput: 'userInput', focus: 'focus', isSecureField: 'isSecureField', secureField: 'isSecureField', release: 'release',
  overlay: 'overlay', requestAccess: 'requestAccess',
});

const kebabToCamel = text => text.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

function loadKoffi() {
  try {
    return require('koffi');
  } catch {
    return null;
  }
}

// Wraps a backend (the fake, or the real one built below) with the message protocol.
function withProtocol(backend) {
  async function call(method, message) {
    switch (method) {
      case 'probe':
        return backend.probe();
      case 'windows':
        return { windows: await backend.windows({ all: message.all === true }) };
      case 'foreground':
        return { foreground: await backend.foreground() };
      case 'capture':
        return backend.capture({ scope: message.scope, target: message.target ?? message.windowId ?? message.displayId ?? null, maxEdge: message.maxEdge });
      case 'input': {
        let action = message.action;
        if (!isObject(action)) {
          const { type, id, ...rest } = message;
          void type;
          void id;
          action = rest;
        }
        return backend.input(action);
      }
      case 'cursor':
        return backend.cursor();
      case 'userInput':
        return backend.userInput();
      case 'focus':
        return backend.focus(message.windowId ?? message.target);
      case 'isSecureField':
        return { secure: await backend.isSecureField() };
      case 'release':
        return backend.release();
      case 'overlay':
        return backend.overlay({ show: message.show, displayId: message.displayId, rect: message.rect, state: message.state, model: message.model, label: message.label });
      case 'requestAccess':
        return backend.requestAccess ? backend.requestAccess() : { ok: true, requested: [] };
      default:
        return { ok: false, reason: 'unsupported', message: 'The desktop does not know that computer-use request.' };
    }
  }

  // -> the full reply { type, id, ...result }. It never throws, and a failure is a refusal that says nothing about its cause.
  async function handle(message) {
    const type = typeof message?.type === 'string' ? message.type : 'computer-unknown';
    const raw = type.replace(/^computer-/, '').replace(/-result$/, '');
    const method = METHODS[kebabToCamel(raw)] ?? null;
    let result;
    try {
      result = method ? await call(method, message) : { ok: false, reason: 'unsupported', message: 'The desktop does not know that computer-use request.' };
    } catch {
      try {
        await backend.release();
      } catch {
        // Nothing more can be done.
      }
      result = { ok: false, reason: 'blocked', message: 'The desktop could not do that.' };
    }
    const body = isObject(result) ? result : { value: result ?? null };
    return { ...body, type: `${type}-result`, id: message?.id };
  }

  return { handle };
}

function createComputerBackend(options = {}) {
  const {
    platform = process.platform,
    fake = process.env.PLENUM_COMPUTER_BACKEND === 'fake',
    fakeOptions = {},
    overlayUrl = () => null,
    electron = null,
    run,
    env = process.env,
    getToken = () => '',
    theme = () => 'dark',
    ownPid = process.pid,
    wait,
  } = options;

  if (fake) {
    const backend = createFakeBackend({ platform, ...fakeOptions });
    return Object.assign(backend, withProtocol(backend), { isFake: true });
  }

  let built = null;
  let supportCache = { at: 0, probe: null };

  function build() {
    if (built) return built;
    try {
      if (!electron || !electron.screen || !electron.desktopCapturer || !electron.nativeImage) throw new Error('The desktop app is not available to this process.');
      let native = null;
      // On Windows the system's own monitor rectangles make the display sizes exact (Electron's are rounded).
      const space = createSpace({ screen: electron.screen, platform, monitors: () => native?.monitors?.() ?? null });
      if (platform === 'win32') {
        const { createWinNative } = require('./win.cjs');
        native = createWinNative({ koffi: 'koffi' in options ? options.koffi : loadKoffi(), ownPid, wait });
      } else if (platform === 'darwin') {
        const { createMacNative } = require('./mac.cjs');
        native = createMacNative({ koffi: 'koffi' in options ? options.koffi : loadKoffi(), space, run, env, ownPid, wait, screenStatus: () => electron.systemPreferences.getMediaAccessStatus('screen') });
      } else {
        const { createLinuxNative } = require('./linux.cjs');
        native = createLinuxNative({ run, env, ownPid, wait });
      }
      const overlay = createOverlay({ electron, space, overlayUrl: typeof overlayUrl === 'function' ? overlayUrl : () => overlayUrl, getToken, theme, platform, ownPid, wait });
      const cap = createCapture({ electron, space, native, overlay, platform, wait });
      built = { space, native, overlay, cap, error: null };
    } catch (err) {
      built = { error: String(err?.message ?? err).slice(0, 300) };
    }
    return built;
  }

  const unavailable = reason => ({ ok: false, reason: 'unsupported', message: reason || NOT_AVAILABLE });

  // The probe, kept for two seconds so a run of actions does not ask the system every time.
  async function supported() {
    if (supportCache.probe && Date.now() - supportCache.at < 2000) return supportCache.probe;
    const result = await api.probe();
    supportCache = { at: Date.now(), probe: result };
    return result;
  }

  let chain = Promise.resolve();
  const queue = fn => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  async function safeRelease() {
    try {
      if (built && !built.error) await built.native.release();
    } catch {
      // Nothing more can be done.
    }
  }

  // The window under a physical point, from a stacking order topmost first (null when none is, or when the platform has no order).
  const windowAt = (stack, point) => (Array.isArray(stack) ? stack.find(w => geometry.pointInRect(point, w.bounds)) ?? null : null);

  // Long text is typed in pieces, and between pieces the program in front is looked at again: if it is no longer the one the typing
  // began in (another program, or an elevated one), typing stops there. A new window of the same program (its own dialog) is fine.
  async function typeInPieces(s, text, began, send) {
    const pieces = [];
    let piece = '';
    for (const ch of text) {
      piece += ch;
      if (piece.length >= TYPE_PIECE) {
        pieces.push(piece);
        piece = '';
      }
    }
    if (piece) pieces.push(piece);
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) {
        const now = await s.native.foreground();
        if (now && now.elevated) return { ok: false, reason: 'elevated', message: ELEVATED_MESSAGE };
        if (!now || !began || now.pid !== began.pid || String(now.exe).toLowerCase() !== String(began.exe).toLowerCase()) return { ok: false, reason: 'no-focus', message: FOCUS_CHANGED_MESSAGE };
      }
      const result = await send({ kind: 'type', text: pieces[i] });
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  const api = {
    kind: 'real',
    platform,

    async probe() {
      const s = build();
      if (s.error) {
        return { supported: false, reason: s.error, platform, displays: [], permissions: { screen: 'n/a', input: 'n/a' }, wayland: false, tools: { xdotool: null }, overlay: 'unknown' };
      }
      let native;
      try {
        native = await s.native.probe();
      } catch {
        native = { supported: false, reason: NOT_AVAILABLE };
      }
      const displays = s.space.displays();
      const ok = !!native.supported && displays.length > 0;
      return {
        supported: ok,
        reason: ok ? '' : native.reason || 'No display was found.',
        platform,
        displays: displays.map(({ id, label, bounds, scaleFactor, physical, primary }) => ({ id, label, bounds, scaleFactor, physical, primary })),
        permissions: native.permissions ?? { screen: 'n/a', input: 'n/a' },
        wayland: !!native.wayland,
        tools: native.tools ?? { xdotool: null },
        overlay: s.overlay.status(),
      };
    },

    async windows({ all = false } = {}) {
      const s = build();
      if (s.error) return all ? null : [];
      try {
        const list = await s.native.windows({ all: !!all });
        if (!Array.isArray(list)) return null;
        const shown = list.filter(w => !s.overlay.isOverlayWindow(w));
        if (all) return shown.map(({ id, pid, exe, bounds }) => ({ id, pid, exe, bounds }));
        const displays = s.space.displays();
        return shown.map(w => ({
          id: w.id, title: w.title, exe: w.exe, pid: w.pid,
          displayId: geometry.displayHolding(w.bounds, displays)?.id ?? null,
          bounds: w.bounds, own: !!w.own, minimized: !!w.minimized,
        }));
      } catch {
        await safeRelease();
        return all ? null : [];
      }
    },

    async foreground() {
      const s = build();
      if (s.error) return null;
      try {
        return await s.native.foreground();
      } catch {
        await safeRelease();
        return null;
      }
    },

    async capture(args = {}) {
      const s = build();
      if (s.error) return unavailable(s.error);
      const ok = await supported();
      if (!ok.supported) return unavailable(ok.reason);
      try {
        return await s.cap.capture(args);
      } catch {
        await safeRelease();
        return { ok: false, reason: 'failed', message: 'The capture failed.' };
      }
    },

    async input(raw) {
      const parsed = normalizeAction(raw);
      if (!parsed.ok) return { ok: false, reason: 'unsupported', message: parsed.message };
      const action = parsed.action;
      const s = build();
      if (s.error) return unavailable(s.error);
      return queue(async () => {
        try {
          const ok = await supported();
          if (!ok.supported) return unavailable(ok.reason);
          const front = await s.native.foreground();
          if (front && front.elevated) return { ok: false, reason: 'elevated', message: ELEVATED_MESSAGE };
          const points = pointsOf(action);
          if (points.length) {
            const stack = await s.native.windows({ all: true });
            const usable = Array.isArray(stack) ? stack.filter(w => !s.overlay.isOverlayWindow(w)) : null;
            for (const p of points) {
              const top = windowAt(usable, p);
              if (top && top.elevated) return { ok: false, reason: 'elevated', message: ELEVATED_POINT_MESSAGE };
            }
          }
          const bar = s.overlay.barPhysicalRect();
          const hitsBar = !!bar && points.some(p => geometry.pointInRect(p, bar));
          const send = a => s.native.input(a);
          const sendAction = action.kind === 'type' && action.text.length > TYPE_PIECE ? () => typeInPieces(s, action.text, front, send) : () => send(action);
          const result = hitsBar ? await s.overlay.hideBarDuring(sendAction) : await sendAction();
          if (!result.ok && result.reason === 'blocked') await safeRelease();
          return result;
        } catch {
          await safeRelease();
          return { ok: false, reason: 'blocked', message: 'The input could not be sent.' };
        }
      });
    },

    async cursor() {
      const s = build();
      if (s.error) return { x: 0, y: 0 };
      try {
        return await s.native.cursor();
      } catch {
        return { x: 0, y: 0 };
      }
    },

    async userInput() {
      const s = build();
      if (s.error) return { mouse: false, keys: false };
      try {
        return await s.native.userInput();
      } catch {
        return { mouse: false, keys: false };
      }
    },

    async focus(windowId) {
      const s = build();
      if (s.error) return { ok: false, reason: 'no-focus', message: s.error };
      if (windowId === undefined || windowId === null || windowId === '') return { ok: false, reason: 'no-focus', message: 'Name the window to bring to the front.' };
      try {
        return await s.native.focus(String(windowId));
      } catch {
        await safeRelease();
        return { ok: false, reason: 'no-focus', message: 'The window could not be brought to the front.' };
      }
    },

    async isSecureField() {
      const s = build();
      if (s.error) return null;
      try {
        const answer = await s.native.isSecureField();
        return answer === true || answer === false ? answer : null;
      } catch {
        return null;
      }
    },

    async release() {
      await safeRelease();
      return { ok: true };
    },

    async overlay(opts = {}) {
      const s = build();
      if (s.error) return unavailable(s.error);
      try {
        const clean = {
          show: opts.show === true,
          displayId: opts.displayId === undefined || opts.displayId === null ? null : String(opts.displayId),
          rect: geometry.rectOk(opts.rect) ? { x: Math.round(opts.rect.x), y: Math.round(opts.rect.y), width: Math.round(opts.rect.width), height: Math.round(opts.rect.height) } : null,
          state: opts.state === 'paused' ? 'paused' : 'running',
          model: typeof opts.model === 'string' ? opts.model : '',
          label: typeof opts.label === 'string' ? opts.label : '',
        };
        const done = await s.overlay.update(clean);
        s.native.watch?.(clean.show);
        return { ok: done.ok !== false, overlay: s.overlay.status() };
      } catch {
        return { ok: false, reason: 'unsupported', message: 'The overlay could not be shown.' };
      }
    },

    async requestAccess() {
      const s = build();
      if (s.error || !s.native.requestAccess) return { ok: true, requested: [] };
      try {
        return await s.native.requestAccess();
      } catch {
        return { ok: false, requested: [] };
      }
    },

    // Hides the overlay, lifts everything held and stops the key sweep. Called on quit, so the parts that must happen before the
    // process ends run before the first await.
    async close() {
      if (!built || built.error) return;
      const released = safeRelease();
      try {
        built.native.watch?.(false);
        built.overlay.hide();
        built.overlay.close();
      } catch {
        // Nothing more can be done.
      }
      await released;
    },

    // For the tests: the parts the backend was built from.
    get parts() {
      return built;
    },
  };

  return Object.assign(api, withProtocol(api), { isFake: false });
}

module.exports = { createComputerBackend, withProtocol, ELEVATED_MESSAGE, ELEVATED_POINT_MESSAGE };
