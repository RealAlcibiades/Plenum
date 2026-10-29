// boot.js (mob-09, wave 105; MOBILE.json client_model.shims, MOBILE-UI 3, 9.1, 15.4 and 16.1). The shim the phone's UI page loads
// before app.js (scripts/build-mobile.mjs bundles it as a classic script, and the UI index names it as /shell/boot.js). It does four
// things in the page:
//   1. window.plenumShell: the object the UI checks by truthiness and the phone layer uses (desktop false, surface 'phone', ...).
//   2. window.fetch: same-origin /api/... and the UI's static files go through the channel (channel.js, one Worker per computer)
//      as REQ streams; the answer is a real Response whose body is the channel's stream. Abort sends CANCEL. Anything else, and
//      any /_bridge/ path, is refused here (and again in the worker, which enforces the request policy). A call while the phone is not
//      connected fails with TypeError, the same shape the UI already reads as "Cannot reach the Plenum server".
//   3. The drive state: GET /api/events is read as it streams, and each 'drive' event moves #plenum-stop[data-driving] (the
//      amber ring of MOBILE-UI 9.1). HELLO.pending.driving draws the same ring before the UI loads.
//   4. The shell DOM the page keeps above everything: #plenum-stop (z 70), #plenum-conn-strip (z 65), #plenum-lock (z 90), the Stop result
//      (#plenum-toast, #plenum-stop-sheet). Built with createElement and textContent only: no inline script, no style attribute, no innerHTML.
//
// The shell comes through a narrow facade (phone security round, plan C6b). This script installs a one-shot window.__plenumAttachShell(facade);
// app.js startShell takes it once the shell core exists and hands over a frozen object with exactly: state(), subscribe(fn), request(spec, body,
// { signal }), stop(project), lock(), unlock(method, pin), connect(id), openShell(hash), takeRoute(), log(line) and plugin(name). The facade has
// no key, no lock-set or forget call and no raw channel, and release builds set neither window.plenumShellCore nor window.plenumNative.
// Without a facade the shim answers "not connected" and the UI's own connection line says so. The native plugins come from the facade
// (plugin(name), the eight names the UI uses) or, for a bridge that only has Capacitor.Plugins, from there; they are looked up when they
// are used, because they register a moment after this script runs.
//
// Nothing here stores a key, a token or a Noise value. Nothing logs a path with a query.
//
// The module exports installShim(options) for the Node suites. In a page it installs itself (unless window.__PLENUM_SHIM_NO_AUTOINSTALL__).
import { isUiPath } from '../../lib/remote/ui-manifest.mjs';
import { capsFor, isLanPage, platformFor } from './device.js';
import { STOP_FAILURE_TEXT } from './stop.js';

export { capsFor, isLanPage, platformFor };

// The release gate (plan C7): true for the unbundled sources the Node suites import and for --dev builds, false in a release build.
const DEV_BUILD = typeof __PLENUM_DEV_BUILD__ !== 'undefined' ? __PLENUM_DEV_BUILD__ === true : true;

// The ?debug=1 hooks (window.plenumPhoneDebug) exist only in a dev build.
export function debugHooksOn(search, devBuild = DEV_BUILD) {
  return devBuild === true && /[?&](debug|demo|selftest)(=|&|$)/.test(String(search ?? ''));
}

// The plugins the facade answers for (plan C6b).
const FACADE_PLUGINS = Object.freeze(['App', 'TextZoom', 'Haptics', 'Dictation', 'IsolatedPreview', 'Browser', 'Share', 'Filesystem']);

export const REQ_HEADERS = Object.freeze(['accept', 'content-type', 'x-plenum-client-id']);
export const RES_HEADERS = Object.freeze(['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'x-plenum-auth', 'content-disposition', 'content-length']);
export const NULL_BODY_STATUS = Object.freeze([101, 204, 205, 304]);
export const ARTIFACT_VIEW = '/api/artifacts/view';
export const MAX_WORKER_BODY = 32 * 1024 * 1024;
export const STOP_LABELS = Object.freeze({ idle: 'Stop', sending: 'Stopping…', queued: 'Stop', done: 'Stopped', failed: 'Stop' });
// How long a notice (the result of a Stop, an answered card) stays as a toast. A queued Stop keeps its toast until it is sent or gives up.
export const TOAST_MS = 6000;
export const LOCK_TRY_AGAIN = 'That did not unlock Plenum. Try again.';
// The PIN pad on the lock overlay (MOBILE-UI 6.13, C22): six digits, and "Unlock and stop everything" arms the Stop until the PIN has unlocked.
export const LOCK_PIN_LENGTH = 6;
export const LOCK_STOP_ARMED_NOTE = 'Enter your PIN. Plenum stops everything once it unlocks.';
// The lock screen's Stop button: it stops at once when this phone holds the computer's Stop key (Stop without unlocking), else it unlocks first.
export const LOCK_STOP_READY_LABEL = 'Stop everything';
export const LOCK_STOP_UNLOCK_LABEL = 'Unlock and stop everything';
// Shown in place of the Unlock button and the PIN pad when the lock settings could not be read (the app stays locked; Stop still works).
export const LOCK_UNKNOWN_NOTE = 'Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.';
const utf8 = new TextEncoder();

// ----- small helpers -----

function fetchError() {
  return new TypeError('Failed to fetch');
}

function abortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  }
}

// The channel's error codes become fetch's two shapes: an abort is an AbortError, anything else is a network failure.
export function mapChannelError(err) {
  return err?.code === 'cancelled' ? abortError() : fetchError();
}

// REQ headers only. The UI sends the placeholder token and every other header; the Bridge adds the real token itself.
export function pickRequestHeaders(headers) {
  const out = {};
  if (!headers) return out;
  let entries;
  if (Array.isArray(headers)) entries = headers;
  else if (typeof headers.forEach === 'function') {
    entries = [];
    headers.forEach((value, key) => entries.push([key, value]));
  } else entries = Object.entries(headers);
  for (const [key, value] of entries) {
    const name = String(key).toLowerCase();
    if (REQ_HEADERS.includes(name)) out[name] = String(value);
  }
  return out;
}

export function pickResponseHeaders(headers) {
  const out = {};
  for (const name of RES_HEADERS) {
    const value = headers && typeof headers === 'object' ? headers[name] : undefined;
    if (value !== undefined && value !== null) out[name] = String(value);
  }
  return out;
}

export async function bodyBytes(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return utf8.encode(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return utf8.encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TypeError('This kind of request body is not sent through the phone link.');
}

// Reads a stream to the end, up to cap bytes. Past the cap the stream is cancelled and the read fails.
export async function readCapped(stream, cap) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      reader.cancel().catch(() => {});
      throw new RangeError('too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// Splits an event stream into its data payloads as they arrive. onData(text) is called once per complete event.
export function sseParser(onData) {
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) onData(data);
      }
    },
  };
}

// Bytes to base64 with no Buffer: chunked, so a large file does not overflow the argument list of fromCharCode.
export function base64Of(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(text);
}

// ----- the installer -----

// options: { win, doc, origFetch, core?, plugins?, app?, log? }. core is an object with the facade's members (or a subset): the Node suites pass
// it and the shim binds to it at once; in a page it comes later through window.__plenumAttachShell. plugins is { name: plugin }, the first place
// pluginOf(name) looks. Returns the installed pieces so the suites can drive them.
export function installShim(options = {}) {
  const win = options.win;
  const doc = options.doc ?? win?.document ?? null;
  if (!win || !win.location) throw new TypeError('installShim needs a window with a location');
  const origFetch = options.origFetch ?? (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  let core = options.core ?? null;
  const coreOf = () => core;
  const log = options.log ?? (() => {});
  const ResponseCtor = options.Response ?? win.Response;
  const ReadableStreamCtor = options.ReadableStream ?? win.ReadableStream;
  const decoder = new TextDecoder();
  const cap = win.Capacitor;
  const native = cap?.isNativePlatform?.() === true;
  // A native plugin by name: the one the suite gave, the facade's (the registry native.js built), or the plain Capacitor.Plugins of a bridge that has
  // no registerPlugin (the names the facade lists only). Looked up at the moment of use, because the plugins register after this script has run.
  const pluginOf = name => options.plugins?.[name] ?? core?.plugin?.(name) ?? (FACADE_PLUGINS.includes(name) ? cap?.Plugins?.[name] : null) ?? null;
  // A timer that never keeps a Node process alive (a browser's setTimeout returns a number, which has no unref).
  const later = (fn, ms) => {
    const timer = win.setTimeout?.(fn, ms);
    timer?.unref?.();
    return timer;
  };
  // Runs fn(plugin) once the plugin exists: now, or within a few seconds on a native app (it registers when the shell has started).
  const whenPlugin = (name, fn) => {
    if (!native) return;
    const attempt = tries => {
      const found = pluginOf(name);
      if (found) {
        fn(found);
        return;
      }
      if (tries < 150) later(() => attempt(tries + 1), 200);
    };
    attempt(0);
  };

  // ----- drive state -----
  const drives = new Map(); // id -> the drive summary, for drives the model is running now
  let helloDriving = null;  // HELLO.pending.driving, or null
  let connState = { status: 'idle' };
  let locked = false;
  let stopView = { state: 'idle', text: '', seq: 0 };
  let helloInfo = null;     // { deviceId, tier, caps } from the last HELLO, kept while the phone is away
  let lockInfo = { mode: 'off' };
  let hadSession = false;   // a computer is paired: the lock screen offers "Unlock and stop everything"
  let lockStop = { ready: false, computerName: '' };   // the shell's lockStop: whether a Stop can go out without unlocking
  let notice = null;        // the shell's last notice { seq, text, tone }
  let noticeAt = 0;
  let noticeShown = null;   // the seq the toast is showing
  let noticeClosed = null;
  let sheetClosed = null;
  let lockNote = '';
  // The PIN pad on the lock overlay. The digits live only here, in this closure: never in the DOM text, an attribute, a log or storage.
  let pinDigits = '';
  let pinBusy = false;      // a PIN is being checked: the keys are disabled
  let pinShown = false;     // the pad was on screen at the last paint
  let stopArmed = false;    // "Unlock and stop everything" was chosen in PIN mode: one Stop goes out once the PIN has unlocked
  let prefsTheme = 'follow';

  function drivingLabel() {
    if (drives.size) {
      const d = [...drives.values()][0];
      const of = d.limits?.steps ? ` of ${d.limits.steps}` : '';
      return `${d.label || d.kind || 'computer'}, step ${d.steps ?? 0}${of}`;
    }
    if (helloDriving) return `${helloDriving.app || helloDriving.kind || 'computer'}, step ${helloDriving.step ?? 0}${helloDriving.of ? ` of ${helloDriving.of}` : ''}`;
    return '';
  }

  function noteDriveEvent(event) {
    if (!event || event.type !== 'drive' || !event.drive || typeof event.drive !== 'object') return;
    const d = event.drive;
    if (typeof d.id !== 'string') return;
    if (d.state === 'running') drives.set(d.id, d);
    else drives.delete(d.id);
    paint();
  }

  // A tier change the computer publishes while the phone is connected: { type: 'phone', kind: 'tier', id, tier }.
  function noteTierEvent(event) {
    if (event?.type !== 'phone' || event.kind !== 'tier') return;
    if (typeof event.tier !== 'string' || !helloInfo || (helloInfo.deviceId && event.id !== helloInfo.deviceId)) return;
    helloInfo = { ...helloInfo, tier: event.tier };
    paint();
  }

  // ----- the request shim -----

  function observeEvents(stream) {
    const reader = stream.getReader();
    const parser = sseParser(text => {
      try {
        const event = JSON.parse(text);
        noteDriveEvent(event);
        noteTierEvent(event);
        if (event && event.type === 'hello') helloDriving = event.state?.pending?.driving ?? helloDriving;
      } catch {
        // A line that is not JSON is not an event.
      }
    });
    return new ReadableStreamCtor({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
        parser.push(decoder.decode(value, { stream: true }));
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  async function shimFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : input?.url ?? String(input);
    const url = new URL(raw, win.location.href);
    if (url.origin !== win.location.origin) throw fetchError();
    if (url.pathname.startsWith('/_bridge/')) {
      return new ResponseCtor('{"error":"Not found."}', { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    const isApi = url.pathname.startsWith('/api/');
    if (!isApi && !isUiPath(url.pathname) && url.pathname !== '/') {
      return origFetch ? origFetch(input, init) : Promise.reject(fetchError());
    }
    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
    const headers = pickRequestHeaders(init.headers ?? input?.headers);
    const body = await bodyBytes(init.body);
    if (!core) throw fetchError();
    const signal = init.signal ?? input?.signal ?? null;
    if (signal?.aborted) throw abortError();
    let answer;
    try {
      answer = await core.request({ method, path: url.pathname + url.search, headers }, body, { signal });
    } catch (err) {
      // The worker's request policy refused it: the same answer as a /_bridge/ path gets above.
      if (err?.code === 'refused') return new ResponseCtor('{"error":"Not found."}', { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } });
      throw mapChannelError(err);
    }
    if (NULL_BODY_STATUS.includes(answer.status)) {
      answer.cancel?.();
      return new ResponseCtor(null, { status: answer.status, headers: pickResponseHeaders(answer.headers) });
    }
    const stream = url.pathname === '/api/events' ? observeEvents(answer.body) : answer.body;
    return new ResponseCtor(stream, { status: answer.status, headers: pickResponseHeaders(answer.headers) });
  }

  // ----- the plenumShell object -----

  const zoomListeners = new Set();
  const themeListeners = new Set();
  const connListeners = new Set();
  const backListeners = new Set();
  const capsListeners = new Set();
  const routeListeners = new Set();
  let zoom = 1;
  let lastTheme = null;
  let lastRouteSeq = 0;
  const app = options.app ?? { version: '', build: '' };
  const platform = options.platform ?? platformFor(win);
  const caps = options.caps ?? capsFor(win);

  function connectionView() {
    const s = connState.status ?? 'idle';
    const state = s === 'connected' ? 'connected'
      : s === 'asleep' ? 'asleep'
        : s === 'connecting' || s === 'reconnecting' ? 'reconnecting'
          : 'offline';
    return {
      state,
      carrier: connState.carrier ?? null,
      desktopName: connState.desktopName ?? '',
      lastSeen: connState.lastSeen ?? null,
      // The phone's own tier (full, approve or read) from the computer's HELLO, and whether an app lock is set (the phone layer shows "Lock now"
      // only then). A phone that has not heard from a computer yet is 'full' to the layer, as before.
      tier: helloInfo?.tier ?? null,
      // What the computer says it can do (HELLO.caps, by the phone's tier): the phone layer shows the Browser and Computer controls only when
      // 'browser-control' or 'computer-control' is in it. A copy, so a screen cannot change what the shell keeps.
      caps: helloInfo ? [...helloInfo.caps] : [],
      lockMode: lockInfo.mode ?? 'off',
    };
  }

  // The effective theme: the phone's own preference when it is light or dark, else the phone's setting.
  function themeNow() {
    if (prefsTheme === 'dark' || prefsTheme === 'light') return prefsTheme;
    return win.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true ? 'dark' : 'light';
  }

  function fireTheme() {
    const now = themeNow();
    if (now === lastTheme) return;
    lastTheme = now;
    for (const fn of [...themeListeners]) {
      try { fn(now); } catch { /* listener error */ }
    }
  }

  function setZoomFactor(factor) {
    zoom = Number.isFinite(factor) && factor > 0 ? factor : 1;
    for (const fn of [...zoomListeners]) {
      try { fn(zoom); } catch { /* listener error */ }
    }
  }

  // The platform's own text size (iOS Dynamic Type, Android font scale) through the TextZoom plugin: read at start and again on every return.
  function refreshTextZoom() {
    const plugin = pluginOf('TextZoom');
    if (!plugin?.getPreferred) return;
    Promise.resolve(plugin.getPreferred()).then(out => {
      const value = Number(out?.value);
      if (Number.isFinite(value) && value > 0 && value !== zoom) setZoomFactor(value);
    }, () => {});
  }

  // Hardware Back. ext-phone owns the page's history (popstate); the native apps' Back button does not pop it, so it comes here: a listener
  // that returns true took it (it closed a sheet, say). Otherwise the page goes back if it can, and the app is left from the first screen.
  let backHooked = false;
  function runBack() {
    let handled = false;
    for (const fn of [...backListeners]) {
      try {
        if (fn() === true) handled = true;
      } catch { /* listener error */ }
    }
    return handled;
  }
  function hookBack() {
    if (backHooked || !native) return;
    backHooked = true;
    whenPlugin('App', App => {
      App.addListener?.('backButton', event => {
        if (runBack()) return;
        if (event?.canGoBack && typeof win.history?.back === 'function') {
          win.history.back();
          return;
        }
        if (typeof App.minimizeApp === 'function') App.minimizeApp();
        else App.exitApp?.();
      });
    });
  }

  const shell = {
    desktop: false,
    surface: 'phone',
    platform,
    app,
    token: () => '0'.repeat(64),
    // The phone's own id on the computer (HELLO.deviceId), so ext-remote can tell which row is this phone. Filled in at the first HELLO.
    device: { id: options.deviceId ?? '', name: options.deviceName ?? '' },
    caps: [...caps],
    stop(project = null) {
      const core = coreOf();
      if (!core) return Promise.resolve({ state: 'idle', text: 'Nothing to stop: no computer is connected.' });
      return core.stop(project);
    },
    connection: () => connectionView(),
    onConnection(fn) {
      connListeners.add(fn);
      try { fn(connectionView()); } catch { /* listener error */ }
      return () => connListeners.delete(fn);
    },
    // Locks the app now. Resolves true when it locked; false when no lock is set (nothing happens, the channel stays open).
    lock() {
      if (!core) return Promise.resolve(false);
      return Promise.resolve(core.lock()).then(out => out?.ok === true, () => false);
    },
    onBack(fn) {
      backListeners.add(fn);
      hookBack();
      return () => {
        backListeners.delete(fn);
      };
    },
    // From the UI page to the shell's own page: the computer list, Phone settings, pairing. openSettings() with no section is the phone's
    // own settings; a section name is the desktop UI's settings drawer (MuseUI), as before.
    openSettings(section) {
      if (section === undefined || section === null || section === '' || section === 'phone') {
        const core = coreOf();
        if (core?.openShell) return Promise.resolve(core.openShell('#settings')).catch(() => false);
        return Promise.resolve(false);
      }
      const ui = win.MuseUI;
      if (ui && typeof ui.openSettings === 'function') ui.openSettings(section);
      return Promise.resolve(true);
    },
    // The paired computers as { id, name, active } (a copy: nothing in it can change the shell). The one in use is active.
    computers() {
      const state = coreOf()?.state?.();
      const list = Array.isArray(state?.computers) ? state.computers : [];
      return list.filter(c => c && typeof c.id === 'string').map(c => ({ id: c.id, name: String(c.name ?? 'Computer'), active: c.id === state.activeId }));
    },
    // Connects another paired computer. The UI that computer sends replaces this one once, the way a newer UI does (the shell opens it).
    connectComputer(id) {
      const core = coreOf();
      const state = core?.state?.();
      if (!core || typeof id !== 'string' || !(state?.computers ?? []).some(c => c.id === id)) return Promise.resolve(false);
      return Promise.resolve(core.connect(id)).then(out => out?.ok !== false, () => false);
    },
    // The address the Report sheet may offer to email: set by the build from package.json bugs.email; empty while there is none.
    contactEmail: typeof __PLENUM_CONTACT_EMAIL__ === 'string' ? __PLENUM_CONTACT_EMAIL__ : '',
    switchComputer() {
      const core = coreOf();
      return core?.openShell ? Promise.resolve(core.openShell('#computers')).catch(() => false) : Promise.resolve(false);
    },
    // Try again after the computer could not be reached: the shell reconnects at once.
    retry() {
      const core = coreOf();
      const state = core?.state?.();
      const id = state?.activeId ?? state?.computers?.[0]?.id ?? null;
      if (!core || !id) return Promise.resolve(false);
      return Promise.resolve(core.connect(id)).then(out => out?.ok !== false, () => false);
    },
    haptic(kind = 'light') {
      const haptics = pluginOf('Haptics');
      if (!haptics) return false;
      // MOBILE-UI 12: a warning or an error is a heavy tap; everything else is light.
      const impact = kind === 'warn' || kind === 'error' ? 'HEAVY' : 'LIGHT';
      haptics.impact?.({ style: impact })?.catch?.(() => {});
      return true;
    },
    textZoom: () => zoom,
    onTextZoom(fn) {
      zoomListeners.add(fn);
      return () => zoomListeners.delete(fn);
    },
    setTextZoom(factor) {
      setZoomFactor(factor);
    },
    theme: () => themeNow(),
    onTheme(fn) {
      themeListeners.add(fn);
      return () => themeListeners.delete(fn);
    },
    // The capabilities of this phone's UI. 'dictation' joins once the native plugin says it can listen (the composer then shows its mic).
    onCaps(fn) {
      capsListeners.add(fn);
      return () => capsListeners.delete(fn);
    },
    // A notification named a place in the UI (#waiting, #handover, #chat, #settings=limit, #home): { kind, id?, project?, section?, seq }. The
    // phone layer takes it with takeRoute() when it starts, and hears the later ones through onRoute(). 'plenum:route' is the same, as a DOM event.
    onRoute(fn) {
      routeListeners.add(fn);
      return () => routeListeners.delete(fn);
    },
    takeRoute: () => coreOf()?.takeRoute?.() ?? null,
    notifications: {
      state() {
        const perm = win.Notification?.permission;
        return perm ?? (platform === 'web' ? 'unsupported' : 'native');
      },
      async request() {
        if (!win.Notification?.requestPermission) return 'unsupported';
        return win.Notification.requestPermission();
      },
    },
    // Dictation on the native apps (the Dictation plugin): on the phone first, the service only when the person allows it. Results arrive as
    // events: partial and final carry text, end says it stopped, error says why.
    dictation: {
      available: async () => {
        const plugin = pluginOf('Dictation');
        if (!plugin?.available) return { available: false, onDevice: false, permission: 'prompt' };
        return plugin.available();
      },
      async start(opts = {}) {
        const plugin = pluginOf('Dictation');
        if (!plugin?.start) return false;
        const prefs = coreOf()?.state?.()?.prefs ?? {};
        await plugin.start({ allowServer: prefs.dictationAllowService !== false, ...opts });
        return true;
      },
      async stop() {
        const plugin = pluginOf('Dictation');
        if (!plugin?.stop) return false;
        await plugin.stop();
        return true;
      },
      async cancel() {
        const plugin = pluginOf('Dictation');
        if (!plugin?.cancel) return false;
        await plugin.cancel();
        return true;
      },
      // Listens to one event ('partial' | 'final' | 'level' | 'end' | 'error'). Returns a function that stops listening.
      on(event, fn) {
        const plugin = pluginOf('Dictation');
        if (!plugin?.addListener) return () => {};
        const handle = Promise.resolve(plugin.addListener(event, fn));
        return () => { handle.then(h => h?.remove?.()).catch(() => {}); };
      },
    },
    // An artifact's HTML in the Android app's isolated view (a WebView with no bridge, no file or network access): show({ html, title }).
    preview: {
      available: () => Boolean(pluginOf('IsolatedPreview')),
      async show({ html, title } = {}) {
        const plugin = pluginOf('IsolatedPreview');
        if (!plugin?.show) return false;
        await plugin.show({ html: String(html ?? ''), title: String(title ?? '') });
        return true;
      },
    },
    async openExternal(href) {
      const url = new URL(String(href), win.location.href);
      if (url.protocol !== 'https:') return false;
      const browser = pluginOf('Browser');
      if (browser?.open) {
        await browser.open({ url: url.href });
        return true;
      }
      win.open?.(url.href, '_blank', 'noopener');
      return true;
    },
    async share(data = {}) {
      const payload = { title: String(data.title ?? ''), text: String(data.text ?? ''), url: data.url ? String(data.url) : undefined };
      const sharePlugin = pluginOf('Share');
      if (sharePlugin?.share) {
        await sharePlugin.share(payload);
        return true;
      }
      if (win.navigator?.share) {
        await win.navigator.share(payload);
        return true;
      }
      return false;
    },
    async save({ name, blob } = {}) {
      const file = String(name ?? 'plenum-file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'plenum-file';
      // On native a blob: download does nothing in the WebView, so the bytes go to the cache folder and the system share sheet takes
      // them from there (Filesystem, then Share). false when either plugin or the blob is missing, so the UI can say so.
      if (native) {
        const fsPlugin = pluginOf('Filesystem');
        const sharePlugin = pluginOf('Share');
        if (!fsPlugin?.writeFile || !sharePlugin?.share || !blob) return false;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const written = await fsPlugin.writeFile({ path: file, data: base64Of(bytes), directory: 'CACHE' });
        const uri = String(written?.uri ?? '');
        if (!uri) return false;
        await sharePlugin.share({ title: file, files: [uri] });
        return true;
      }
      if (!doc || !win.URL?.createObjectURL) return false;
      const url = win.URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = file;
      doc.body?.append(a);
      a.click();
      a.remove?.();
      win.setTimeout?.(() => win.URL.revokeObjectURL?.(url), 1000);
      return true;
    },
    // A line for the computer's debug log. The shell redacts it, keeps it in the phone's own console and posts it (the page cannot reach
    // /_bridge/ itself: the worker refuses a page request there).
    debug(line) {
      core?.log?.(String(line ?? ''));
    },
  };

  // ----- the shell DOM -----

  const els = {};
  function build(tag, id, className) {
    const el = doc.createElement(tag);
    if (id) el.id = id;
    if (className) el.className = className;
    return el;
  }

  function button(label, className, onClick) {
    const b = build('button', null, className);
    b.setAttribute('type', 'button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // What the lock does for each way the app is locked. A biometric or a passkey is asked for right here; a PIN is typed on the pad of this
  // overlay (pressPinKey), and the shell checks it and keeps the wait after wrong tries.
  function lockMethod() {
    const mode = lockInfo.mode;
    return mode === 'passkey' ? 'passkey' : mode === 'pin' ? 'pin' : 'biometric';
  }

  async function unlockFromOverlay(alsoStop) {
    const core = coreOf();
    if (!core) return;
    const method = lockMethod();
    if (method === 'pin') return;   // the pad is the unlock; "Unlock and stop everything" arms the Stop (armStop)
    const out = await core.unlock(method);
    if (out?.ok) {
      lockNote = '';
      if (alsoStop) await core.stop();
    } else if (!['cancelled', 'mode', 'unavailable'].includes(out?.reason)) {
      lockNote = LOCK_TRY_AGAIN;
    }
    paint();
  }

  // The words under the pad for a PIN that did not unlock. 'wrong' and 'wait' carry the seconds to wait; anything else is the common line.
  function pinNoteFor(out) {
    const wait = Math.ceil(Number(out?.waitSec) || 0);
    if (out?.reason === 'wrong') return wait > 0 ? `Wrong PIN. Try again in ${wait} seconds.` : 'Wrong PIN.';
    if (out?.reason === 'wait') return `Try again in ${Math.max(1, wait)} seconds.`;
    return LOCK_TRY_AGAIN;
  }

  // Forgets what was typed and chosen on the pad: the digits, the armed Stop and, with the note, whatever the pad last said.
  function clearPinEntry(withNote) {
    pinDigits = '';
    stopArmed = false;
    if (withNote) lockNote = '';
  }

  // "Unlock and stop everything" in PIN mode does not unlock: it arms one Stop that goes out once the PIN has unlocked the phone.
  function armStop() {
    stopArmed = true;
    lockNote = LOCK_STOP_ARMED_NOTE;
    paintLock();
  }

  // A key of the pad. A digit adds one (six at most); Delete removes the last; the sixth digit is sent at once and cleared.
  function pressPinKey(key) {
    if (pinBusy || !locked || lockMethod() !== 'pin') return;
    if (key === 'Delete') {
      pinDigits = pinDigits.slice(0, -1);
      paintLock();
      return;
    }
    if (pinDigits.length >= LOCK_PIN_LENGTH) return;
    pinDigits += key;
    if (pinDigits.length < LOCK_PIN_LENGTH) {
      paintLock();
      return;
    }
    submitPin().catch(() => {});
  }

  async function submitPin() {
    const entered = pinDigits;
    pinDigits = '';
    pinBusy = true;
    paintLock();
    let out = null;
    try {
      const core = coreOf();
      out = core ? await core.unlock('pin', entered) : null;
    } catch {
      out = null;   // the error is dropped: nothing about the PIN leaves this function
    }
    pinBusy = false;
    if (out?.ok === true) {
      lockNote = '';
      // The shell has already published the unlock (the overlay is gone), so the Stop goes out here, once, whatever the pad was told.
      if (stopArmed) {
        stopArmed = false;
        try {
          await coreOf()?.stop?.();
        } catch { /* the Stop result is the shell's to show */ }
      }
    } else {
      lockNote = pinNoteFor(out);
    }
    paintLock();
  }

  function mount() {
    if (!doc?.body) return;
    els.stop = build('button', 'plenum-stop', 'plenum-stop');
    els.stop.setAttribute('type', 'button');
    els.stop.setAttribute('aria-label', 'Stop');
    const mark = build('span', null, 'plenum-stop-mark');
    mark.setAttribute('aria-hidden', 'true');
    els.stopLabel = build('span', null, 'plenum-stop-label');
    els.stopLabel.textContent = 'Stop';
    // The result is spoken and drawn by the toast and the sheet below; the clipped note inside the button only mirrors it.
    els.stopNote = build('span', null, 'plenum-stop-note');
    els.stopNote.setAttribute('aria-hidden', 'true');
    els.stop.append(mark, els.stopLabel, els.stopNote);
    els.stop.addEventListener('click', () => { Promise.resolve(shell.stop()).catch(() => {}); });

    els.strip = build('div', 'plenum-conn-strip', 'plenum-conn-strip');
    els.strip.setAttribute('role', 'status');
    els.strip.hidden = true;
    els.stripText = build('span', null, 'plenum-conn-text');
    els.strip.append(els.stripText);

    // The Stop result: a toast for a notice (the result of a Stop, a queued Stop, an answered card), and a sheet when the computer could not
    // be reached for 60 s. The sheet names the way out when this phone cannot reach it (the same words as the shell page).
    els.toast = build('div', 'plenum-toast', 'plenum-toast');
    els.toast.setAttribute('role', 'status');
    els.toast.hidden = true;
    els.toastText = build('span', null, 'plenum-toast-text');
    els.toastClose = button('Close', 'sh-link plenum-toast-close', () => {
      noticeClosed = notice?.seq ?? null;
      paint();
    });
    els.toast.append(els.toastText, els.toastClose);

    els.sheet = build('div', 'plenum-stop-sheet', 'plenum-stop-sheet');
    els.sheet.setAttribute('role', 'alertdialog');
    els.sheet.setAttribute('aria-labelledby', 'plenum-stop-sheet-title');
    els.sheet.setAttribute('aria-describedby', 'plenum-stop-sheet-body');
    els.sheet.hidden = true;
    const sheetTitle = build('h2', 'plenum-stop-sheet-title', 'plenum-stop-sheet-title');
    sheetTitle.textContent = STOP_FAILURE_TEXT.title;
    const sheetBody = build('p', 'plenum-stop-sheet-body', 'plenum-stop-sheet-body');
    sheetBody.textContent = STOP_FAILURE_TEXT.body;
    const sheetActions = build('div', null, 'plenum-stop-sheet-actions');
    sheetActions.append(
      button('Try again', 'sh-btn sh-btn-primary plenum-stop-sheet-retry', () => { Promise.resolve(shell.stop()).catch(() => {}); }),
      button('Close', 'sh-link plenum-stop-sheet-close', () => {
        sheetClosed = stopView.seq;
        paint();
      }),
    );
    els.sheet.append(sheetTitle, sheetBody, sheetActions);

    els.lock = build('section', 'plenum-lock', 'plenum-lock');
    els.lock.setAttribute('role', 'dialog');
    els.lock.setAttribute('aria-modal', 'true');
    els.lock.setAttribute('aria-labelledby', 'plenum-lock-title');
    els.lock.hidden = true;
    els.lockTitle = build('h2', 'plenum-lock-title', 'plenum-lock-title');
    els.lockTitle.textContent = 'Plenum is locked';
    els.lockLine = build('p', null, 'plenum-lock-line');
    // The PIN pad (C22), shown only while the lock is a PIN: six dots, a screen-reader count, the note, and twelve cells. The digits are
    // never drawn or named anywhere but on the keys themselves; what was typed stays in pinDigits.
    els.lockDots = build('div', null, 'sh-dots plenum-lock-dots');
    els.lockDots.setAttribute('aria-hidden', 'true');
    els.lockDotList = Array.from({ length: LOCK_PIN_LENGTH }, () => build('span', null, 'sh-dot'));
    els.lockDots.append(...els.lockDotList);
    els.lockCount = build('span', null, 'sh-sr');
    els.lockCount.setAttribute('aria-live', 'polite');
    els.lockCount.textContent = `0 of ${LOCK_PIN_LENGTH} digits entered`;
    els.lockNote = build('p', null, 'plenum-lock-note');
    els.lockNote.setAttribute('role', 'alert');
    els.lockPad = build('div', null, 'sh-pad plenum-lock-pad');
    els.lockPad.setAttribute('role', 'group');
    els.lockPad.setAttribute('aria-label', 'PIN');
    els.lockKeys = [];
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'Delete']) {
      if (key === null) {
        const gap = build('span', null, 'sh-key-gap');
        gap.setAttribute('aria-hidden', 'true');
        els.lockPad.append(gap);
        continue;
      }
      const cell = build('button', null, key === 'Delete' ? 'sh-key sh-key-del' : 'sh-key');
      cell.setAttribute('type', 'button');
      cell.setAttribute('aria-label', key);
      cell.textContent = key;
      cell.addEventListener('click', () => { pressPinKey(key); });
      els.lockKeys.push(cell);
      els.lockPad.append(cell);
    }
    els.unlock = build('button', null, 'plenum-lock-unlock');
    els.unlock.setAttribute('type', 'button');
    els.unlock.textContent = 'Unlock';
    els.unlock.addEventListener('click', () => { unlockFromOverlay(false).catch(() => {}); });
    // With a computer paired, the lock screen also offers Stop (MOBILE-UI 9.1: "Unlock and stop everything"). Locking closes the channel, so
    // the choice does not wait for a connection: a paired computer is enough, and Stop goes out right after the unlock, by the same method.
    els.unlockStop = build('button', null, 'plenum-lock-unlock-stop');
    els.unlockStop.setAttribute('type', 'button');
    els.unlockStop.textContent = LOCK_STOP_UNLOCK_LABEL;
    els.unlockStop.hidden = true;
    els.unlockStop.addEventListener('click', () => {
      // A phone that holds the computer's Stop key stops without unlocking; otherwise the Stop waits for the unlock.
      if (lockStop.ready) Promise.resolve(coreOf()?.stop?.()).catch(() => {});
      else if (lockMethod() === 'pin') armStop();
      else unlockFromOverlay(true).catch(() => {});
    });
    els.lock.append(els.lockTitle, els.lockLine, els.lockDots, els.lockCount, els.lockNote, els.lockPad, els.unlock, els.unlockStop);

    doc.body.append(els.strip, els.stop, els.toast, els.sheet, els.lock);
    if (doc.head && !doc.getElementById?.('plenum-shell-css')) {
      const link = build('link', 'plenum-shell-css', null);
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('href', `${options.shellBase ?? '/shell/'}styles.css`);
      doc.head.append(link);
    }
    paint();
  }

  // Draws the shell DOM from the current state: the ring while driving, the stop label, the result, the strip and the lock.
  function paint() {
    if (!els.stop) return;
    const driving = drives.size > 0 || helloDriving !== null;
    const running = Number(coreOf()?.state?.()?.hello?.pending?.runs) || 0;
    if (driving) {
      els.stop.setAttribute('data-driving', '');
      els.stop.setAttribute('aria-description', `A model is driving: ${drivingLabel()}`);
    } else {
      els.stop.removeAttribute('data-driving');
      if (running > 0) els.stop.setAttribute('aria-description', running === 1 ? '1 run is going' : `${running} runs are going`);
      else els.stop.removeAttribute('aria-description');
    }
    els.stop.setAttribute('data-state', stopView.state);
    els.stopLabel.textContent = STOP_LABELS[stopView.state] ?? 'Stop';
    els.stopNote.textContent = stopView.text || '';
    paintResult();
    const conn = connectionView();
    const name = conn.desktopName || 'your computer';
    const when = conn.lastSeen ? ` Last seen ${conn.lastSeen}.` : '';
    const text = conn.state === 'reconnecting' ? `Reconnecting to ${name}…`
      : conn.state === 'offline' ? `Can't reach ${name}.${when}`
        : conn.state === 'asleep' ? `${name} is asleep or Plenum is closed.${when} Plenum reconnects when it wakes.`
          : '';
    els.strip.hidden = text === '' || connState.status === 'idle';
    els.strip.setAttribute('data-state', conn.state);
    els.stripText.textContent = text;
    paintLock();
    for (const fn of Array.from(connListeners)) {
      try { fn(connectionView()); } catch { /* listener error */ }
    }
  }

  // The lock overlay: the drive line, the way to unlock (a PIN pad, or one button), the note, and the armed Stop. Painted on its own for a key press.
  function paintLock() {
    if (!els.lock) return;
    const driving = drives.size > 0 || helloDriving !== null;
    els.lock.hidden = !locked;
    els.lockLine.textContent = driving ? `A model is driving ${drivingLabel()}.` : '';
    const method = lockMethod();
    const pinMode = locked && method === 'pin';
    // The overlay went away or the lock left PIN mode: what was typed and chosen on the pad goes with it. A PIN being checked finishes first
    // (the shell publishes the unlock before it answers, and the Stop that was armed must still go out); submitPin paints again after.
    if (!pinBusy && (!locked || (pinShown && !pinMode))) clearPinEntry(true);
    pinShown = pinMode;
    const unknown = locked && lockInfo.mode === 'unknown';
    els.unlock.textContent = method === 'passkey' ? 'Unlock with a passkey' : 'Unlock';
    els.unlock.hidden = method === 'pin' || unknown;
    els.lockDots.hidden = !pinMode;
    els.lockCount.hidden = !pinMode;
    els.lockPad.hidden = !pinMode;
    els.lockDotList.forEach((dot, i) => {
      if (i < pinDigits.length) dot.setAttribute('data-on', '');
      else dot.removeAttribute('data-on');
    });
    els.lockCount.textContent = `${pinDigits.length} of ${LOCK_PIN_LENGTH} digits entered`;
    if (pinBusy) els.lockPad.setAttribute('aria-busy', 'true');
    else els.lockPad.removeAttribute('aria-busy');
    for (const cell of els.lockKeys) cell.disabled = pinBusy;
    if (pinMode && stopArmed) els.unlockStop.setAttribute('aria-pressed', 'true');
    else els.unlockStop.removeAttribute('aria-pressed');
    els.unlockStop.hidden = !hadSession;
    els.unlockStop.textContent = lockStop.ready ? LOCK_STOP_READY_LABEL : LOCK_STOP_UNLOCK_LABEL;
    // The Stop result shows under the button while it is on its way or has ended; else the unknown-lock line, else the PIN note.
    const stopShown = locked && ['sending', 'queued', 'done', 'failed'].includes(stopView.state) && Boolean(stopView.text);
    els.lockNote.textContent = stopShown ? stopView.text : unknown ? LOCK_UNKNOWN_NOTE : lockNote;
  }

  // The toast and the sheet (F2): the result of a Stop is on screen where the person is looking, not only inside the button.
  function paintResult() {
    const note = notice;
    const open = Boolean(note) && noticeClosed !== note.seq;
    const waiting = open && note.tone === 'warn' && stopView.state === 'queued';
    const fresh = open && (Date.now() - noticeAt < TOAST_MS);
    const show = fresh || waiting;
    els.toast.hidden = !show;
    if (show) {
      els.toastText.textContent = note.text;
      els.toast.setAttribute('data-tone', note.tone ?? 'info');
    }
    els.sheet.hidden = !(stopView.state === 'failed' && sheetClosed !== stopView.seq);
  }

  // ----- binding to the shell's state -----

  let boundCore = null;
  let unsubscribe = null;
  function syncFromCore() {
    if (core === boundCore) return;
    unsubscribe?.();
    boundCore = core;
    unsubscribe = null;
    if (!core?.subscribe) return;
    unsubscribe = core.subscribe(snapshot => {
      connState = snapshot.connection ?? connState;
      locked = Boolean(snapshot.locked);
      stopView = snapshot.stop ?? stopView;
      helloDriving = snapshot.hello?.pending?.driving ?? null;
      lockInfo = snapshot.lock ?? lockInfo;
      lockStop = snapshot.lockStop ?? lockStop;
      hadSession = Boolean(snapshot.activeId) || (Array.isArray(snapshot.computers) && snapshot.computers.length > 0) || hadSession;
      // The phone's own id and tier come with the HELLO and are kept while the computer is away (a locked or reconnecting phone is the same phone).
      if (snapshot.hello) {
        helloInfo = {
          deviceId: snapshot.hello.deviceId ?? helloInfo?.deviceId ?? '',
          tier: snapshot.hello.tier ?? helloInfo?.tier ?? null,
          caps: Array.isArray(snapshot.hello.caps) ? snapshot.hello.caps.filter(c => typeof c === 'string') : (helloInfo?.caps ?? []),
        };
        if (helloInfo.deviceId && shell.device.id !== helloInfo.deviceId) shell.device.id = helloInfo.deviceId;
      }
      if (snapshot.notice && snapshot.notice.seq !== notice?.seq) {
        notice = snapshot.notice;
        noticeAt = Date.now();
        // The toast clears itself: paint again just after it is due.
        later(paint, TOAST_MS + 50);
      }
      const theme = snapshot.prefs?.theme ?? 'follow';
      if (theme !== prefsTheme) {
        prefsTheme = theme;
        fireTheme();
      }
      const intent = snapshot.intent;
      if (intent && !intent.taken && intent.seq !== lastRouteSeq) {
        lastRouteSeq = intent.seq;
        const { taken, ...detail } = intent;
        void taken;
        let heard = false;
        for (const fn of [...routeListeners]) {
          try { fn(detail); heard = true; } catch { /* listener error */ }
        }
        try {
          const Custom = win.CustomEvent ?? globalThis.CustomEvent;
          if (typeof win.dispatchEvent === 'function' && typeof Custom === 'function') win.dispatchEvent(new Custom('plenum:route', { detail }));
        } catch { /* a page without events */ }
        // A listener has it: it is shown, so it is not offered again to takeRoute().
        if (heard) core.takeRoute?.();
      }
      paint();
    });
  }

  // ----- the artifact iframe's requests from the service worker -----

  function serveWorkerRequests() {
    const sw = win.navigator?.serviceWorker;
    if (!sw?.addEventListener) return;
    sw.addEventListener('message', event => {
      const data = event?.data;
      const port = event?.ports?.[0];
      if (!data || data.op !== 'plenum-fetch' || !port) return;
      const path = String(data.path ?? '');
      const reply = message => port.postMessage(message);
      if (!path.startsWith(`${ARTIFACT_VIEW}?`) && path !== ARTIFACT_VIEW) {
        reply({ status: 404, headers: {}, body: null });
        return;
      }
      if (!core?.request) {
        reply({ status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: null });
        return;
      }
      core.request({ method: 'GET', path, headers: { accept: 'text/html' } })
        .then(async answer => {
          let bytes = null;
          if (answer.body) bytes = await readCapped(answer.body, MAX_WORKER_BODY);
          const buffer = bytes ? bytes.buffer : null;
          reply(buffer ? { status: answer.status, headers: pickResponseHeaders(answer.headers), body: buffer } : { status: answer.status, headers: pickResponseHeaders(answer.headers), body: null });
        })
        .catch(err => {
          if (err?.code === 'offline') reply({ status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: null });
          else reply({ status: err?.code === 'cancelled' ? 499 : 502, headers: {}, body: null });
        });
    });
  }

  // ----- wiring -----

  if (origFetch || win.fetch) win.fetch = shimFetch;
  win.plenumShell = shell;
  if (doc?.documentElement) doc.documentElement.setAttribute('data-surface', 'phone');
  if (debugHooksOn(win.location.search)) {
    win.plenumPhoneDebug = {
      ...(win.plenumPhoneDebug ?? {}),
      connection(state) {
        connState = { ...connState, status: state === 'connected' ? 'connected' : state === 'asleep' ? 'asleep' : state === 'reconnecting' ? 'reconnecting' : 'offline' };
        paint();
      },
      stopState(s) {
        stopView = { ...stopView, state: String(s), text: '' };
        paint();
      },
    };
  }
  syncFromCore();
  // The shell hands over its facade once, when it has started: app.js takes this slot at module evaluation and calls it with the facade. Nothing
  // else can set the core afterwards (a second call, or a call with nothing, answers false).
  if (!options.core) {
    try {
      Object.defineProperty(win, '__plenumAttachShell', {
        configurable: true,
        enumerable: false,
        value: facade => {
          if (core || !facade) return false;
          core = facade;
          syncFromCore();
          return true;
        },
      });
    } catch { /* a page whose window cannot take it: the shim stays unconnected */ }
  }
  if (doc) {
    if (doc.readyState === 'loading' && typeof doc.addEventListener === 'function') doc.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }
  serveWorkerRequests();

  // L15: the phone's theme and text size. The theme listeners hear the system's light/dark change (and the phone's own Theme setting, above);
  // on a native app the platform's text size is read at the start and again whenever the app comes back to the front.
  lastTheme = themeNow();
  const scheme = win.matchMedia?.('(prefers-color-scheme: dark)');
  if (scheme?.addEventListener) scheme.addEventListener('change', () => fireTheme());
  else if (scheme?.addListener) scheme.addListener(() => fireTheme());
  whenPlugin('TextZoom', refreshTextZoom);
  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState !== 'hidden') refreshTextZoom();
  });
  whenPlugin('App', App => { App.addListener?.('resume', refreshTextZoom); });
  // The mic of the composer: 'dictation' is added to the caps once the plugin says this phone can listen.
  whenPlugin('Dictation', plugin => {
    Promise.resolve(plugin.available?.()).then(out => {
      if (out?.available !== true || shell.caps.includes('dictation')) return;
      shell.caps.push('dictation');
      for (const fn of [...capsListeners]) {
        try { fn([...shell.caps]); } catch { /* listener error */ }
      }
    }, () => {});
  });

  return { shell, shimFetch, noteDriveEvent, paint, mount, syncFromCore, els, drives, setHelloDriving: v => { helloDriving = v; paint(); } };
}

// In a page, boot.js installs itself before app.js runs. The Node suites set the flag and call installShim themselves.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__PLENUM_SHIM_NO_AUTOINSTALL__) {
  installShim({ win: window, doc: document, origFetch: window.fetch ? window.fetch.bind(window) : null, log: () => {} });
}
