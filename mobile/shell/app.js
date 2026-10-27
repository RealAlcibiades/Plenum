// The shell's state and actions (mob-10, waves 104 and 107). This file is the bundle entry (scripts/build-mobile.mjs writes it as shell.js).
// It owns the flow: launch and lock, pairing from a link, connecting a computer, the connection state, Stop, the debug console,
// the phone settings, ?selftest and ?demo. The screens (screens/*.js) render what it exports; they never touch the channel, the store or the keys.
//
//   const shell = createShell({ store, lock, ... });   // or startShell() in the page; a release build sets no global (see "The page" below)
//   shell.state()             the current state (no keys, no tokens): route, locked, computers, connection, hello, stop, pairing, prefs
//   shell.subscribe(fn)       -> unsubscribe; fn(state) on every change
//   shell.pair(text)          a pairing link; resolves with the final pairing state
//   shell.connect(id)         opens the channel for a computer (refused while locked)
//   shell.stop(project?)      Stop: stops everything on the active computer (in demo mode, the replay answers). While the app is locked it
//                             still goes out when this phone holds the computer's Stop key (state().lockStop.ready), without unlocking
//   shell.forget(id)          removes this phone's keys for a computer (the computer keeps its entry until Remove there)
//   shell.unlock(method, arg) method: 'biometric' | 'pin' | 'passkey'; resolves with { ok, reason, waitSec? }
//   shell.lockNow()           closes the channel and drops the keys from memory; { ok:false, reason:'no-lock' } (and nothing closes) when no lock is set
//   shell.runSelftest()       the ?selftest steps; the report is in state().selftest and in the debug log
//   shell.debug               the debug console (log, lines, sendToComputer, clear)
//   Phone security round: confirmPair() (the pairing link that waits for review), pageLog(line) (a redacted line from the UI page).
//   Wave 107 (phone settings and demo): rename(id, name), moveWay(id, kind, 'up'|'down'), testWays(id), setPush(patch),
//   setApprove(value), testPush(), enableNotifications(), enableLock(mode), setPin(pin), lockOff(pin), setPrefs(patch),
//   cancelConnect(), cancelPairing(), demoDecide(id, 'approve'|'deny'), demoReset(). Each answers { ok, reason }.
//   Stabilising (H3, H7, M6, M7, M9, M11, M15, L18): showUi({ force }), useCopy(), openShell(hash), takeRoute(), scan(), pushAndroid(), dictation().
//   state().screenRequest is { screen: 'settings' | 'computers', seq } or null: the shell page was asked for one of its own screens (#settings,
//   #computers) and the screens open it once the app is unlocked; seq is 1 for the first request and rises by one for each later one.
//
// The page. The same bundle runs on two pages: the shell's own screens (index.html, data-shell-page) and the desktop's UI (data-surface="phone",
// where boot.js is the shim). Neither gets the shell through a global in a release build (plan D2): the shell page's screens take the full core once
// through globalThis.__plenumTakeShellCore, and the UI page's shim gets a frozen facade through the one-shot slot boot.js installs
// (window.__plenumAttachShell). Only a --dev build also sets window.plenumShellCore and window.plenumNative, for the test harnesses. On the shell page, once the computer has said hello, the UI is pulled and the page is handed to it (ui-host.js);
// on the UI page the shell keeps the channel, the lock and the notification links, and sends the person back to the shell page when there is
// nothing for the UI to show (no computer, a revoked phone, an update needed).

import { b64uToBytes, bytesToB64u, defaultCreateWorker, openChannel, sendLockedStop } from './channel.js';
import { createPlatformStore, publicComputer } from './store.js';
import { createBiometricGate, createLock, createPasskeyGate } from './lock.js';
import { pageCandidates, parsePairingText, startPairing } from './pairing.js';
import { carrierUrlOk, hostLabel, usableCarriers } from './carriers.js';
import { createStopController, STOP_DONE_MS, STOP_NEEDS_UNLOCK } from './stop.js';
import { createDebugLog } from './debug.js';
import { runSelfTest } from './selftest.js';
import { createAndroidPush, isRouteLink, parseNotificationHash, subscribeWebPush } from './push.js';
import { appKindFor, capsFor, isLanPage, isNative, pageKindFor, platformFor } from './device.js';
import { createUiHost, SHELL_LINK_KEY, SHELL_QUERY } from './ui-host.js';
import { createReplay } from './screens/demo.js';
import * as S from './screens/settings.js';
import demoSession from './demo/session.json' with { type: 'json' };

const APP_VERSION = typeof __PLENUM_SHELL_VERSION__ !== 'undefined' ? __PLENUM_SHELL_VERSION__ : '0.0.0';
const LINK_VERSION = typeof __PLENUM_PROTOCOL__ !== 'undefined' ? __PLENUM_PROTOCOL__ : '1.0';

// The release gate (plan C7): true for the unbundled sources the Node suites import and for --dev builds, false in a release build. Dev builds
// only: ?selftest, the ?debug=1 hooks, the fixture screens, window.plenumShellCore and window.plenumNative, and the &ci-confirm=1 pairing marker.
export const DEV_BUILD = typeof __PLENUM_DEV_BUILD__ !== 'undefined' ? __PLENUM_DEV_BUILD__ === true : true;

// The page starts the shell once. Any script of the same origin can import this module (the same evaluated namespace) and call startShell on
// the page global, so the first start on globalThis wins and a later one resolves null without touching anything. The flag is also a
// non-configurable property of the page global, so a second evaluation of the module (the same file under another query string) refuses too.
// A start on any other object (the Node suites) is not a page start and is not counted.
let pageStarted = false;
const PAGE_STARTED_KEY = '__plenumPageStarted';
function takePageStart() {
  if (pageStarted || Object.getOwnPropertyDescriptor(globalThis, PAGE_STARTED_KEY) !== undefined) return false;
  pageStarted = true;
  try {
    Object.defineProperty(globalThis, PAGE_STARTED_KEY, { value: true });
  } catch { /* the module's own flag still holds */ }
  return true;
}

// The UI page's one-shot slot: boot.js installs window.__plenumAttachShell before this module runs. It is taken, and removed, while the module is
// evaluated, so no later script can call it; startShell calls it once, with the facade.
const attachShim = (() => {
  const f = globalThis.__plenumAttachShell;
  try { delete globalThis.__plenumAttachShell; } catch { /* not configurable */ }
  return typeof f === 'function' ? f : null;
})();

// The shell page's hand-over (plan C6a): defined only on a document whose <html> has data-shell-page, synchronously while this module is
// evaluated. screens/main.js calls it once at mount (it deletes itself); the Promise resolves to the full core when startShell has made it,
// or to null when the start failed or was refused.
let giveShellCore = () => {};
if (typeof document !== 'undefined' && document.documentElement?.hasAttribute?.('data-shell-page') && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  const handed = new Promise(resolve => { giveShellCore = resolve; });
  Object.defineProperty(globalThis, '__plenumTakeShellCore', {
    configurable: true,
    enumerable: false,
    value: () => {
      try { delete globalThis.__plenumTakeShellCore; } catch { /* not configurable */ }
      return handed;
    },
  });
}

const ACTIVE_META = 'active';
const PREFS_META = 'prefs';
const DEMO_COMPUTER = Object.freeze({ id: 'demo', name: 'Demo computer', carriers: [], lastCarrier: null, lastSeen: null, pairedAt: null, counter: 0 });
const utf8 = new TextEncoder();
const utf8Read = new TextDecoder();
const STOP_RETRY_MS = 60 * 1000;   // the channel's STOP retry window (channel.js rejects after 60 s without an answer)
const APPROVE_META = 'approve';    // this phone's copy of its Approve-from-notifications switch; the computer keeps the real one
const STOP_NOTICE = new Set(['done', 'queued', 'failed']);
const APPROVE_OFF_META = 'approve-off-pending'; // set when the opt-out of Approve-from-notifications could not reach the computer; retried at every HELLO
const LINK_META = 'shell-link';       // the link the UI page left for the shell page on the apps (ui-host.js openShell), in the store's meta
const LINK_TTL_MS = 120 * 1000;
const NOTIFICATION_LINK_MAX_AGE_MS = 60 * 1000;
export const NOTIFICATION_OLD = 'That notification is more than a minute old. Open the approval to answer it.';
const OPEN_SHELL_HASHES = Object.freeze(['', '#settings', '#computers']);
// The plugins the UI page's facade answers for (plan C6b).
const FACADE_PLUGINS = Object.freeze(['App', 'TextZoom', 'Haptics', 'Dictation', 'IsolatedPreview', 'Browser', 'Share', 'Filesystem']);
const INTENT_KEY = 'plenum-intent'; // sessionStorage: a notification route that arrived on the shell page, for the UI page to show
const SW_REGISTRATION_WAIT_MS = 3000;
export const CARD_CHANGED = 'That card changed. Open it to answer.';

// The page mode from its query: 'selftest' only in a dev build (the self-test answers a card), 'demo' for the replay, else 'normal'.
export function modeFor(search, devBuild = DEV_BUILD) {
  const params = new URLSearchParams(String(search ?? ''));
  if (devBuild === true && params.has('selftest')) return 'selftest';
  return params.has('demo') ? 'demo' : 'normal';
}

function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = frozenCopy(item);
    return Object.freeze(out);
  }
  return value;
}

// The state the UI page may see (plan C6b): a frozen copy of only these fields. No pairing, no review hosts, no self-test, no key material.
export function safeState(state) {
  const s = state ?? {};
  const hello = s.hello;
  return frozenCopy({
    page: s.page,
    locked: s.locked === true,
    lock: { mode: s.lock?.mode, locked: s.lock?.locked, failures: s.lock?.failures, waitSec: s.lock?.waitSec },
    lockStop: { ready: s.lockStop?.ready === true, computerName: String(s.lockStop?.computerName ?? '') },
    connection: { status: s.connection?.status, carrier: s.connection?.carrier, desktopName: s.connection?.desktopName, lastSeen: s.connection?.lastSeen },
    hello: hello
      ? { desktopName: hello.desktopName, desktopVersion: hello.desktopVersion, deviceId: hello.deviceId, tier: hello.tier, pending: hello.pending }
      : null,
    stop: { state: s.stop?.state, text: s.stop?.text, seq: s.stop?.seq, ack: s.stop?.ack },
    activeId: s.activeId ?? null,
    computers: (Array.isArray(s.computers) ? s.computers : []).map(c => ({ id: c.id, name: c.name })),
    notice: s.notice ?? null,
    prefs: {
      theme: s.prefs?.theme,
      textSize: s.prefs?.textSize,
      stopSide: s.prefs?.stopSide,
      dictationAllowService: s.prefs?.dictationAllowService,
      dictationOnDevice: s.prefs?.dictationOnDevice,
    },
    intent: s.intent ?? null,
    device: { platform: s.device?.platform, app: s.device?.app, appVersion: s.device?.appVersion, protocol: s.device?.protocol },
  });
}

// The facade the UI page's shim gets (plan C6b): a frozen object with exactly these members and nothing else.
export function makeFacade(shell, plugins) {
  return Object.freeze({
    state: () => safeState(shell.state()),
    subscribe: fn => shell.subscribe(state => fn(safeState(state))),
    request: (spec, body = null, opts = {}) => {
      const channel = shell.channel;
      if (!channel) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      return channel.request(spec, body, { signal: opts?.signal ?? null, scope: 'page' });
    },
    stop: project => shell.stop(project ?? null),
    lock: () => shell.lockNow(),
    unlock: (method, pin = null) => shell.unlock(method, pin),
    connect: id => shell.connect(id),
    openShell: hash => (OPEN_SHELL_HASHES.includes(hash) ? shell.openShell(hash) : Promise.resolve(false)),
    takeRoute: () => shell.takeRoute(),
    log: line => shell.pageLog(line),
    plugin: name => (FACADE_PLUGINS.includes(name) ? plugins?.[name] ?? null : null),
  });
}

// A link for the shell page that waits in the store's meta for a moment: the UI page leaves it (ui-host.js openShell) and the shell page takes it
// out once, if it is under two minutes old. A pairing link holds the pairing secret, so it never goes through sessionStorage or any web storage.
export function createLinkStore(meta, now = () => Date.now()) {
  return {
    async put(text) {
      await meta.put(LINK_META, { text: String(text).slice(0, 8192), at: now() });
    },
    async take() {
      let kept = null;
      try {
        kept = await meta.get(LINK_META);
        if (kept !== undefined && kept !== null) await meta.remove(LINK_META);
      } catch {
        return null;
      }
      return kept && typeof kept.text === 'string' && typeof kept.at === 'number' && now() - kept.at < LINK_TTL_MS ? kept.text : null;
    },
  };
}

// The name typed for this phone: control and bidirectional characters out, trimmed, 60 characters at most ('' when nothing is left).
export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, 60).trim();
}

// Takes the fragment out of the address bar. replaceState adds no history entry and does not fire hashchange.
export function clearAddressHash(env = globalThis) {
  try {
    const loc = env.location;
    if (!loc || !env.history?.replaceState) return;
    env.history.replaceState(null, '', `${loc.pathname}${loc.search}`);
  } catch { /* the address bar stays as it is */ }
}

// What this phone says about itself in the handshake. The app and the caps come from device.js, which boot.js uses too, so a LAN page is
// 'lan-web' with a picture for artifacts and no push in both places (it used to be found by a path here and by the origin in boot.js).
export function deviceFor(env = globalThis) {
  const native = isNative(env);
  const kind = appKindFor(env);
  return {
    device: { name: kind.name, platform: platformFor(env), app: kind.app, appVersion: APP_VERSION, uiHash: '' },
    caps: capsFor(env),
    native,
  };
}

// The HELLO the demo shows: the replay's own drive and approvals, so the lock line and the strips agree with the demo screens.
function demoHello(replayView) {
  const drive = replayView?.drive && replayView.drive.state === 'driving' ? replayView.drive : null;
  const waiting = (replayView?.approvals ?? []).filter(a => a.state === 'waiting').length;
  const running = (replayView?.runs ?? []).filter(r => r.state === 'running').length;
  return {
    desktopName: replayView?.computer?.name ?? 'Demo computer',
    desktopVersion: replayView?.computer?.desktopVersion || '1.4.2',
    protocol: LINK_VERSION,
    deviceId: 'demo',
    tier: 'full',
    caps: ['demo'],
    pending: {
      approvals: waiting,
      runs: running,
      driving: drive ? { app: drive.app, step: drive.step, of: drive.of } : null,
    },
    minShell: null,
  };
}

// Reads a channel response body as text (bounded: the settings answers are small).
async function readText(body, cap = 64 * 1024) {
  if (!body || typeof body.getReader !== 'function') return '';
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { reader.cancel?.().catch?.(() => {}); break; }
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return utf8Read.decode(all);
}

// The service worker's registration for a push subscription: the one the page already has, or the one that becomes ready within a few
// seconds. Never waits forever (navigator.serviceWorker.ready does when nothing registered a worker).
export async function registrationOf(serviceWorker, { wait = SW_REGISTRATION_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!serviceWorker) return null;
  try {
    const found = await serviceWorker.getRegistration?.();
    if (found) return found;
  } catch {
    // Fall through to ready.
  }
  if (!serviceWorker.ready) return null;
  let timer = null;
  const gave = new Promise(resolve => { timer = setTimer(() => resolve(null), wait); });
  try {
    return await Promise.race([Promise.resolve(serviceWorker.ready).catch(() => null), gave]);
  } finally {
    clearTimer(timer);
  }
}

// Registers sw.js for the PWA (F1): web pages in a secure context only, never the plain-http LAN page (no service worker there) and never a
// native app (it has no service worker, and its UI comes from the app). The worker serves the cached UI, shows pushes and runs the
// notification actions. The scope is the origin's root; the listener sends Service-Worker-Allowed for sw.js, and the relay serves it at /.
// A failure leaves the page working without it. Resolves the registration or null.
export async function registerServiceWorker(env = globalThis) {
  const sw = env.navigator?.serviceWorker;
  if (!sw || typeof sw.register !== 'function') return null;
  if (isNative(env) || env.isSecureContext !== true || isLanPage(env)) return null;
  try {
    return (await sw.register(new URL('sw.js', String(env.location?.href ?? 'https://localhost/')).href, { scope: '/' })) ?? null;
  } catch {
    return null;
  }
}

// A plugin-less secure storage for a phone whose plugins did not load: every call fails, so a key is never written anywhere else.
const NO_SECURE_STORAGE = Object.freeze({
  async getItem() { throw new Error('secure storage is not available'); },
  async setItem() { throw new Error('secure storage is not available'); },
  async removeItem() { throw new Error('secure storage is not available'); },
  async keys() { throw new Error('secure storage is not available'); },
});

// Builds the shell. Every input is injectable so the Node suites run the same flow on a fake worker and a fake clock.
export function createShell({
  store,
  lock = null,
  createWorker = defaultCreateWorker,
  device = { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '0.0.0', uiHash: '' },
  caps = ['ui-from-desktop'],
  pageUrl = null,
  mode = 'normal',
  debug = createDebugLog(),
  selftestFn = runSelfTest,
  stopClock = globalThis,
  onFatal = () => {},
  notifications = globalThis.Notification ?? null,
  serviceWorker = null,
  pushEnv = globalThis,
  clearHash = () => {},
  native = null,
  uiHost = null,
  pageKind = 'shell',
  stay = false,
  initialIntent = null,
  initialLink = null,
  onIntent = () => {},
  onReload = () => {},
  devBuild = DEV_BUILD,
  storage = 'ok',
} = {}) {
  if (!store) throw new TypeError('createShell needs a store');
  let computers = [];
  let activeId = null;
  let channel = null;
  let channelState = { status: 'idle', carrier: null, desktopName: '', lastSeen: null, since: 0, nextRetryAt: null, failedRounds: 0, failure: null };
  let hello = null;
  let stopCtl = null;
  let stopView = { state: 'idle', ack: null, error: null, text: '', seq: 0 };
  // The toast the screens show: { seq, text, tone }. A new notice takes the next seq, so the same text can show again.
  let notice = null;
  let noticeSeq = 0;
  let stopSeq = 0;
  // A link the page was opened with while the app was locked (#pair=..., #stop, #deny=<id>, #approve=<id>): { text, at }. It runs once the app
  // unlocks; a parked Stop runs at once (it needs no unlock), and an approve or deny older than a minute is dropped.
  let pendingLink = null;
  // A pairing link from outside the app that waits for the person's Pair (the review screen). Closure only: the link holds the pairing secret,
  // so it is never in state().
  let pendingPair = null;
  // True once a #connect=<id> link asked the shell page to show that computer's UI even though the page was opened for its own screens (?shell).
  let forceUi = false;
  // The screen the shell page was asked to open (#settings, #computers): { screen, seq } or null. seq counts the requests.
  let screenRequest = null;
  let screenSeq = 0;
  let pairing = null;
  let pairingFlow = null;
  let lockStatus = { mode: 'off', locked: false, failures: 0, waitSec: 0 };
  // Whether a Stop can go out without unlocking: the computer a Stop would go to has a Stop key on this phone (plan C6d).
  let lockStop = { ready: false, computerName: '' };
  let lockedCtl = null;
  let selftest = null;
  let booted = false;
  // Resolves once boot has read the lock. A link that arrives while the app is starting waits for it, so a locked app never runs it early;
  // a lock that could not be read counts as locked.
  let lockKnown = () => {};
  const lockRead = new Promise(resolve => { lockKnown = resolve; });
  let lockUnreadable = false;
  let loaded = false;
  let started = false;
  let prefs = S.normalisePrefs(null);
  let pushKnown = null;
  let approveStored = false;
  let hiddenAt = null;
  // Counts the pairings this page finished (from the link or the paste), so the screens start the onboarding once per pairing.
  let pairedSeq = 0;
  let pairedId = null;
  // The UI hand-over (ui-host.js): idle, loading, navigating (the page is leaving for the UI) or failed.
  let ui = { state: 'idle', cause: null, progress: null, hasCopy: false };
  let loadedUiHash;
  let refreshingUi = false;
  // True from a finished pairing until the screens say the onboarding (app lock, notifications) is over: the page is not handed to the UI
  // in between, or the person would never see those two steps.
  let holdUi = false;
  let leaving = false;
  // A route a notification named (#waiting, #handover, #chat, #settings=limit, #home): the UI shows it. seq counts them; taken is true once shown.
  let intent = initialIntent && typeof initialIntent === 'object' ? { ...initialIntent, seq: 1, taken: false } : null;
  let intentSeq = intent ? 1 : 0;
  let dictationState = null;
  let androidPushState = null;
  const replay = mode === 'demo' ? createReplay(demoSession) : null;
  const unlockedKeys = new Map();
  const subs = new Set();
  const wall = () => (typeof stopClock?.now === 'function' ? stopClock.now() : Date.now());
  const androidPush = native && device.platform === 'android' && native.UnifiedPush
    ? createAndroidPush({
      native,
      requestOf: () => channel?.request,
      vapidOf: () => (typeof hello?.vapidPublicKey === 'string' ? hello.vapidPublicKey : null),
      isVisible: () => pushEnv?.document?.visibilityState !== 'hidden',
      onLink: link => { api.handleHash(link).catch(() => {}); },
      log: line => debug.log(line, 'warn'),
    })
    : null;

  const view = () => ({
    mode,
    route: route(),
    page: pageKind,
    stay,
    locked: lockStatus.locked,
    lock: { ...lockStatus },
    computers: computers.map(c => ({ ...c })),
    activeId,
    connection: { ...channelState },
    hello: hello ? publicHello(hello) : null,
    stop: { ...stopView },
    lockStop: { ...lockStop },
    storage: storage === 'unavailable' ? 'unavailable' : 'ok',
    pairing: pairing ? { ...pairing, ...(pairing.review ? { review: { name: pairing.review.name, hosts: pairing.review.hosts.map(h => ({ ...h })) } } : {}) } : null,
    selftest,
    debugLines: debug.lines().length,
    prefs: { ...prefs },
    pushKnown: pushKnown ? { ...pushKnown } : null,
    approveStored,
    device: { appVersion: APP_VERSION, protocol: LINK_VERSION, platform: device.platform, app: device.app },
    demo: replay ? replay.view() : null,
    paired: { seq: pairedSeq, id: pairedId },
    notice: notice ? { ...notice } : null,
    ui: { ...ui, kind: uiHost?.kind ?? null },
    intent: intent ? { ...intent } : null,
    screenRequest: screenRequest ? { ...screenRequest } : null,
    dictation: dictationState ? { ...dictationState } : null,
    androidPush: androidPushState ? { ...androidPushState } : null,
  });

  let snapshot = view();
  const refresh = () => {
    if (replay) hello = demoHello(replay.view());
    snapshot = view();
    for (const fn of Array.from(subs)) {
      try { fn(snapshot); } catch { /* a screen error must not stop the others */ }
    }
    leaveForShellIfNeeded();
    return snapshot;
  };

  function say(text, tone = 'info') {
    noticeSeq += 1;
    notice = { seq: noticeSeq, text: String(text ?? ''), tone };
  }

  function route() {
    if (mode === 'demo') return 'demo';
    if (lockStatus.locked) return 'locked';
    if (pairing && !['allowed', 'denied', 'expired', 'mismatch', 'failed'].includes(pairing.state)) return 'code';
    if (mode === 'selftest') return 'selftest';
    if (!computers.length) return 'welcome';
    if (computers.length > 1 && !channel) return 'computers';
    return channel ? 'connected' : 'computers';
  }

  // The hello without anything a screen should not show: the protocol, the phone's own id and tier, and the computer's name, plus what is running.
  function publicHello(h) {
    return {
      desktopName: String(h.desktopName ?? ''),
      desktopVersion: String(h.desktopVersion ?? ''),
      protocol: h.protocol ?? null,
      deviceId: typeof h.deviceId === 'string' ? h.deviceId : '',
      tier: h.tier ?? null,
      caps: Array.isArray(h.caps) ? [...h.caps] : [],
      pending: h.pending ?? null,
      minShell: h.minShell ?? null,
    };
  }

  async function loadComputers() {
    const list = await store.publicList();
    computers = list.map(c => ({ ...c }));
    await refreshLockStop();
  }

  // The computer a Stop sent from the lock screen would go to: the active one, else the saved active one, else the only one. It works while
  // `computers` is still empty (a cold start from a notification arrives before loadComputers). Resolves the stored record or null.
  async function lockStopTarget() {
    let id = activeId;
    if (!id) id = await store.meta.get(ACTIVE_META).catch(() => null);
    let record = id ? await store.get(id) : null;
    if (!record) {
      const list = await store.publicList();
      if (list.length === 1) record = await store.get(list[0].id);
    }
    return record ?? null;
  }

  async function refreshLockStop() {
    let next = { ready: false, computerName: '' };
    try {
      const target = await lockStopTarget();
      if (target) next = { ready: publicComputer(target)?.stopReady === true, computerName: String(target.name ?? '') };
    } catch {
      // Not ready: the Stop then waits for the unlock.
    }
    lockStop = next;
  }

  function keyedRecord(record) {
    if (typeof record.myPriv === 'string') return record;
    const key = unlockedKeys.get(record.id);
    if (!key) return null;
    return { ...record, myPriv: bytesToB64u(key) };
  }

  function applyStopView(v) {
    const changed = v.state !== stopView.state;
    // The sequence moves when a Stop reaches a result (done, queued or failed): the toast and the sheet show once for each result.
    const seq = changed && STOP_NOTICE.has(v.state) ? ++stopSeq : stopView.seq;
    stopView = { ...v, seq };
    if (changed && v.state === 'done') say(v.text, 'ok');
    if (changed && v.state === 'queued') say(v.text, 'warn');
    refresh();
  }

  function bindStop(ch, name) {
    stopCtl?.dispose();
    stopCtl = createStopController({ channel: ch, clock: stopClock, computerName: name });
    stopCtl.subscribe(applyStopView);
  }

  // Stop while the app is locked (or its lock could not be read): when this phone holds the computer's Stop key, one signed STOP_ONLY goes out on
  // its own worker (channel.js sendLockedStop) and the result shows as for a live Stop. Otherwise the Stop waits for the unlock.
  async function lockedStop(project) {
    if (lockedCtl && (stopView.state === 'sending' || stopView.state === 'queued')) return lockedCtl.press(project);
    const target = await lockStopTarget().catch(() => null);
    if (!target || publicComputer(target)?.stopReady !== true) {
      say(STOP_NEEDS_UNLOCK, 'warn');
      pendingLink = { text: '#stop', at: wall() };
      refresh();
      return { ...stopView, state: 'idle', reason: 'needs-unlock' };
    }
    const listeners = new Set();
    const viaLockedWorker = {
      stop: () => sendLockedStop({ record: target, store, createWorker, onStopState: view => { for (const fn of Array.from(listeners)) fn(view); } }),
      onStopState: fn => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    lockedCtl?.dispose();
    lockedCtl = createStopController({ channel: viaLockedWorker, clock: stopClock, computerName: String(target.name ?? '') });
    lockedCtl.subscribe(applyStopView);
    const out = await lockedCtl.press(project);
    refresh();
    return out;
  }

  function attachChannel(ch, name) {
    channel = ch;
    bindStop(ch, name);
    ch.onState(s => {
      channelState = { ...s };
      if (s.status !== 'connected') {
        hello = null;
      }
      refresh();
    });
    ch.onEvent(event => {
      if (event && event.type === 'phone' && event.kind === 'revoked') refresh();
    });
    ch.onHello(h => {
      hello = h;
      refresh();
      loadPush();
      retryApproveOff();
      // A Stop key the computer just gave this phone (HELLO stopKeyNew) is in the store by now: the lock screen can send Stop without the unlock.
      refreshLockStop().then(refresh);
      afterHello();
    });
    refresh();
  }

  // Retires a channel. A Stop still queued or sending keeps its worker for the retry window, so the Stop is not dropped by a lock,
  // a Cancel, a Forget or a switch to another computer.
  function retireChannel(ch) {
    if (!ch) return;
    if (stopView.state === 'queued' || stopView.state === 'sending') {
      stopClock.setTimeout(() => ch.close(), STOP_RETRY_MS + 1000);
      return;
    }
    ch.close();
  }

  // Reads the computer's notification switches once a computer says hello. POST /api/phones/push with no change answers them.
  async function loadPush() {
    if (replay || !channel) return;
    const out = await postJson('/api/phones/push', {});
    if (out.ok && out.json?.push && typeof out.json.push === 'object') {
      pushKnown = { ...out.json.push };
      refresh();
    }
  }

  // The phone's copy of the Approve-from-notifications switch (the computer keeps the real one; a demo changes nothing on disk).
  async function keepApprove(on) {
    approveStored = on === true;
    if (!replay) await store.meta.put(APPROVE_META, approveStored).catch(() => {});
  }

  // Runs the link the page was opened with, once the app is unlocked: a pairing link or a notification link. A Stop parked while locked runs at once
  // (through stop(), which parks it again when this phone cannot send it without the unlock); every other link stays parked until the unlock.
  async function runPendingLink() {
    const link = pendingLink;
    if (!link) return null;
    const parsed = parseNotificationHash(link.text);
    if (lockStatus.locked || lockUnreadable) {
      if (parsed?.kind !== 'stop') return null;
      pendingLink = null;
      return api.stop();
    }
    pendingLink = null;
    // An approval or a denial that waited behind the lock for more than a minute is not sent: the person answers it from the open card.
    if ((parsed?.kind === 'approve' || parsed?.kind === 'deny') && wall() - link.at > NOTIFICATION_LINK_MAX_AGE_MS) {
      say(NOTIFICATION_OLD, 'warn');
      emitRoute({ kind: 'waiting', id: parsed.id });
      return { ok: false, reason: 'expired', kind: parsed.kind };
    }
    return api.handleHash(link.text);
  }

  // Approve-from-notifications was on when the lock went off but the computer was not told (offline, or it refused): the opt-out is sent at the next HELLO.
  async function retryApproveOff() {
    if (replay) return;
    const waiting = await store.meta.get(APPROVE_OFF_META).catch(() => null);
    if (waiting !== true) return;
    const out = await postJson('/api/phones/push', { approveFromNotifications: false });
    if (!out.ok) return;
    await keepApprove(false);
    await store.meta.remove(APPROVE_OFF_META).catch(() => {});
    refresh();
  }

  async function connectNow(id) {
    const record = await store.get(id);
    if (!record) return { ok: false, reason: 'unknown' };
    const keyed = keyedRecord(record);
    if (!keyed) return { ok: false, reason: 'locked' };
    if (channel) {
      retireChannel(channel);
      channel = null;
    }
    hello = null;
    activeId = id;
    await store.meta.put(ACTIVE_META, id).catch(() => {});
    await refreshLockStop();
    const ch = openChannel({
      computer: keyed,
      store,
      device,
      caps,
      createWorker,
      onWorkerError: line => debug.log(`channel: ${line}`, 'warn'),
    });
    attachChannel(ch, keyed.name);
    return { ok: true, id };
  }

  // A JSON request to the computer over the channel (the phone's own settings routes). Resolves with { ok, status, json, reason }.
  async function postJson(path, body, headers = {}) {
    if (!channel) return { ok: false, status: 0, json: null, reason: 'offline' };
    try {
      const res = await channel.request({ method: 'POST', path, headers: { 'content-type': 'application/json', ...headers } }, JSON.stringify(body ?? {}), { scope: 'shell' });
      const text = await readText(res.body);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      const ok = res.status >= 200 && res.status < 300;
      return { ok, status: res.status, json, reason: ok ? null : (json?.error ?? 'failed') };
    } catch (err) {
      return { ok: false, status: 0, json: null, reason: String(err?.code ?? 'offline') };
    }
  }

  // channel.request as the shell's own call: the worker lets a shell-scope request reach /_bridge/log.
  const shellRequest = ch => (spec, body, opts) => ch.request(spec, body, { ...(opts ?? {}), scope: 'shell' });

  // Resolves true once the computer has said hello (or at once if it has), false when there is no channel or it does not come within ms.
  // A notification link that opens the app cold arrives before the channel is up: Deny and Approve wait a moment for it, they do not fail.
  function whenConnected(ms = 8000) {
    if (!channel) return Promise.resolve(false);
    if (hello) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer = null;
      let off = () => {};
      const done = value => {
        if (timer !== null) stopClock.clearTimeout(timer);
        off();
        resolve(value);
      };
      timer = stopClock.setTimeout(() => done(false), ms);
      off = api.subscribe(() => {
        if (hello) done(true);
        else if (!channel) done(false);
      });
    });
  }

  async function savePrefs(next) {
    prefs = S.normalisePrefs(next);
    await store.meta.put(PREFS_META, prefs).catch(() => {});
    return refresh();
  }

  // M11: "Hide Plenum in the app switcher" (on by default) is FLAG_SECURE on Android, set through the app's own PlenumPrivacy plugin. The
  // setting is also kept natively, so the flag is on from the first frame; this keeps the two in step with the phone's preference. The
  // web page keeps its CSS cover (screens/main.js).
  let appliedHide = null;
  async function applyPrivacy() {
    if (device.platform !== 'android' || !native?.PlenumPrivacy?.setHideInSwitcher) return;
    const enabled = prefs.hideSwitcher !== false;
    if (appliedHide === enabled) return;
    try {
      await native.PlenumPrivacy.setHideInSwitcher({ enabled });
      appliedHide = enabled;
    } catch (err) {
      debug.log(`privacy: ${err?.code ?? 'failed'}`, 'warn');
    }
  }

  // L18: what the phone's dictation can do, for the settings screen. Only the native apps have the plugin.
  async function loadDictation() {
    if (!native?.Dictation?.available) return;
    try {
      const out = await native.Dictation.available();
      dictationState = { available: out?.available === true, onDevice: out?.onDevice === true, permission: String(out?.permission ?? 'prompt') };
    } catch {
      dictationState = { available: false, onDevice: false, permission: 'prompt' };
    }
    refresh();
  }

  async function loadAndroidPush() {
    if (!androidPush) return;
    await androidPush.start();
    androidPushState = await androidPush.state();
    refresh();
  }

  // ----- the UI hand-over (H3) -----

  function afterHello() {
    if (!uiHost || replay || mode !== 'normal') return;
    if (pageKind === 'ui') {
      refreshUi();
      return;
    }
    if (lockStatus.locked || holdUi) return;
    // A #connect=<id> link asks for that computer's UI even on a page opened for the shell's own screens (?shell).
    if (forceUi) {
      forceUi = false;
      showUi({ force: true });
      return;
    }
    if (stay) return;
    showUi();
  }

  async function showUi({ force = false } = {}) {
    if (!uiHost || pageKind !== 'shell' || !hello || replay) return { ok: false, reason: 'unavailable' };
    if (ui.state === 'loading' || ui.state === 'navigating') return { ok: true, reason: null };
    if (stay && !force) return { ok: false, reason: 'stay' };
    ui = { state: 'loading', cause: null, progress: { done: 0, total: 1 }, hasCopy: false };
    refresh();
    const out = await uiHost.show({
      hello,
      computerId: activeId,
      loadedHash: null,
      onProgress: progress => { ui = { ...ui, progress }; refresh(); },
    });
    if (out.ok) {
      ui = { ...ui, state: 'navigating', progress: { done: 1, total: 1 } };
    } else {
      ui = { state: 'failed', cause: out.cause ?? 'checksum', progress: null, hasCopy: await uiHost.hasCopy().catch(() => false) };
    }
    refresh();
    return { ok: out.ok, reason: out.ok ? null : out.cause };
  }

  // On the UI page: the HELLO says whether the computer has a newer UI. The page reloads once per new UI (ui-loader shouldReload).
  async function refreshUi() {
    if (!uiHost || refreshingUi) return;
    refreshingUi = true;
    try {
      if (loadedUiHash === undefined) loadedUiHash = await uiHost.loadedHash();
      const out = await uiHost.refresh({ hello, loadedHash: loadedUiHash, computerId: activeId });
      if (out.ok && out.reload) onReload();
    } finally {
      refreshingUi = false;
    }
  }

  // Which computer the UI on this page came from: its id, null when unknown, 'any' where the page cannot tell (the LAN page, the iPhone's copy).
  async function uiComputerOf() {
    return typeof uiHost?.uiComputerId === 'function' ? uiHost.uiComputerId() : 'any';
  }

  // The UI page has nothing to show for these states, so the shell's screens take over: no computer paired (forgotten, or this phone was
  // removed), a computer that revoked this phone, or an update that must come first. The lock is not one of them: boot.js draws its own.
  function leaveForShellIfNeeded() {
    if (pageKind !== 'ui' || !uiHost || leaving || !loaded || mode !== 'normal') return;
    const status = channelState.status;
    const needs = computers.length === 0 || ['revoked', 'update-app', 'update-desktop'].includes(status);
    if (!needs) return;
    leaving = true;
    Promise.resolve(uiHost.openShell()).catch(() => { leaving = false; });
  }

  function emitRoute(link) {
    intentSeq += 1;
    intent = { ...link, seq: intentSeq, taken: false };
    if (pageKind === 'shell') onIntent({ ...link });
    refresh();
  }

  const api = {
    state: () => snapshot,
    subscribe(fn) {
      subs.add(fn);
      try { fn(snapshot); } catch { /* listener error */ }
      return () => subs.delete(fn);
    },
    get channel() { return channel; },
    debug,

    // Launch: reads the lock, the saved computers, the saved active computer and the phone's own preferences. Idempotent.
    async boot() {
      if (booted) return snapshot;
      booted = true;
      prefs = S.normalisePrefs(await store.meta.get(PREFS_META).catch(() => null));
      approveStored = (await store.meta.get(APPROVE_META).catch(() => null)) === true;
      try {
        if (lock) {
          await lock.lockOnLaunch();
          lockStatus = { ...lockStatus, ...(await lock.status()) };
        }
      } catch {
        // The lock settings could not be read: the app stays locked (mode 'unknown', no way to unlock), and Stop still works through lockStop.
        lockUnreadable = true;
        lockStatus = { ...lockStatus, mode: 'unknown', locked: true };
      } finally {
        lockKnown();
      }
      try {
        await loadComputers();
      } catch {
        computers = [];
      }
      loaded = true;
      applyPrivacy();
      loadDictation();
      loadAndroidPush();
      if (mode === 'demo') {
        computers = [{ ...DEMO_COMPUTER }];
        activeId = DEMO_COMPUTER.id;
        channelState = { ...channelState, status: 'connected', carrier: 'lan', desktopName: 'Demo computer', since: Date.now() };
        return refresh();
      }
      const saved = await store.meta.get(ACTIVE_META).catch(() => null);
      if (lockStatus.locked) return refresh();
      if (mode === 'selftest' || computers.length) {
        // A #connect=<id> link the page was opened with names the computer to show, ahead of the saved one.
        const asked = /^#connect=([0-9a-f]{64})$/.exec(pendingLink?.text ?? '')?.[1] ?? null;
        const target = computers.find(c => c.id === asked) ?? computers.find(c => c.id === saved) ?? computers[0];
        if (target) {
          // One UI per computer: a UI page whose UI came from another computer hands the person to the shell page, which connects this one
          // and pulls its UI. No channel is opened here.
          if (pageKind === 'ui' && uiHost) {
            const uiFor = await uiComputerOf();
            if (uiFor !== 'any' && uiFor !== target.id) {
              await api.openShell(`#connect=${target.id}`);
              return refresh();
            }
          }
          const opened = await connectNow(target.id);
          if (!opened.ok) debug.log(`connect: ${opened.reason}`, 'warn');
        }
      }
      return refresh();
    },

    // Pairing from a link. The final state is returned (allowed, denied, expired, mismatch or failed).
    async pair(text, options = {}) {
      // Pairing is refused while the app is locked: a new record is stored only as the lock keeps it (wrapped in PIN mode).
      if (mode === 'demo') {
        pairing = { state: 'failed', code: null, tried: [], reason: 'demo' };
        refresh();
        return { ...pairing };
      }
      if (lockStatus.locked) {
        pairing = { state: 'failed', code: null, tried: [], reason: 'locked' };
        refresh();
        return { ...pairing };
      }
      let payload;
      try {
        payload = parsePairingText(text);
      } catch (err) {
        pairing = { state: 'failed', code: null, tried: [], reason: err?.code ?? 'not-plenum' };
        refresh();
        return { ...pairing };
      }
      pairing = { state: 'starting', code: null, tried: [], reason: null };
      refresh();
      // The key of a record the lock wrapped stays in memory for this unlocked session, so the new computer can connect now.
      let wrapped = null;
      // The name typed on Welcome is the name this phone pairs under (the computer shows it in Phones and in the connected line).
      const typed = cleanName(options?.name);
      const flow = startPairing({
        payload,
        store,
        createWorker,
        device: typed ? { ...device, name: typed } : device,
        caps,
        pageUrl,
        prepareRecord: async record => {
          const kept = lock ? await lock.protect(record) : record;
          if (kept !== record) wrapped = { id: record.id, key: b64uToBytes(record.myPriv) };
          return kept;
        },
        onState: s => {
          pairing = { ...s };
          refresh();
        },
      });
      pairingFlow = flow;
      const final = await flow.done;
      if (pairingFlow === flow) pairingFlow = null;
      if (final.state === 'allowed') {
        await loadComputers();
        const id = final.computerId ?? computers.at(-1)?.id;
        pairing = null;
        pairedSeq += 1;
        pairedId = id ?? null;
        holdUi = true;
        if (wrapped) unlockedKeys.set(wrapped.id, wrapped.key);
        // Connects only when the app is still unlocked (the lock can come on while the pairing is open).
        if (id && !lockStatus.locked) await connectNow(id);
        refresh();
        return { ...final, computerId: id ?? null };
      }
      refresh();
      return { ...final };
    },

    async connect(id) {
      if (lockStatus.locked) return { ok: false, reason: 'locked' };
      // One UI per computer: the UI on this page is another computer's, so the shell page connects this one and pulls its UI.
      if (pageKind === 'ui' && uiHost) {
        const uiFor = await uiComputerOf();
        if (uiFor !== 'any' && uiFor !== id) {
          await api.openShell(`#connect=${id}`);
          return { ok: true, reason: 'opening' };
        }
      }
      const result = await connectNow(id);
      refresh();
      return result;
    },

    async stop(project = null) {
      if (replay) {
        const out = replay.stop();
        stopView = { state: 'done', ack: out.ack, error: null, text: out.text, seq: ++stopSeq };
        say(out.text, 'ok');
        refresh();
        // The demo's Stop answers like the live one: the result shows for a moment, then the Stop is idle again (stop.js does the same).
        stopClock.setTimeout(() => {
          if (stopView.state !== 'done') return;
          stopView = { state: 'idle', ack: null, error: null, text: '', seq: stopView.seq };
          refresh();
        }, STOP_DONE_MS);
        return { ...stopView };
      }
      // Locked, or the lock could not be read: Stop does not wait for an unlock when this phone can send it without one.
      if (lockStatus.locked || lockUnreadable) return lockedStop(project);
      if (!stopCtl) return { ...stopView, state: 'idle', text: 'Nothing to stop: no computer is connected.' };
      const out = await stopCtl.press(project);
      refresh();
      return out;
    },

    async forget(id) {
      if (replay) return { ...refresh(), ok: false, reason: 'demo' };
      if (activeId === id && channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
        channelState = { ...channelState, status: 'closed' };
        activeId = null;
        await store.meta.remove(ACTIVE_META).catch(() => {});
      }
      unlockedKeys.delete(id);
      await store.remove(id);
      await loadComputers();
      return { ...refresh(), ok: true, reason: null };
    },

    // Phone settings: the name on this phone only (the computer keeps its own).
    async rename(id, name) {
      if (replay) return { ok: false, reason: 'demo' };
      const clean = cleanName(name);
      if (!id || !clean) return { ok: false, reason: 'name' };
      const saved = await store.patchComputer(id, { name: clean });
      if (!saved) return { ok: false, reason: 'unknown' };
      await loadComputers();
      if (activeId === id) hello = hello ? { ...hello } : null;
      refresh();
      return { ok: true, reason: null };
    },

    // Ways to reach: Move up and Move down reorder the carriers the record holds. The order is used at the next connection.
    async moveWay(id, kind, dir) {
      if (replay) return { ok: false, reason: 'demo' };
      const record = await store.get(id);
      if (!record) return { ok: false, reason: 'unknown' };
      const current = (Array.isArray(record.carriers) ? record.carriers : []).map(c => c.kind);
      const order = S.orderedWays(current);
      const next = S.moveWay(order, kind, dir);
      if (next.join() === order.join()) return { ok: true, reason: null, order: next };
      const sorted = [...record.carriers].sort((a, b) => next.indexOf(a.kind) - next.indexOf(b.kind));
      await store.patchComputer(id, { carriers: sorted });
      await loadComputers();
      refresh();
      return { ok: true, reason: null, order: next };
    },

    // Test them now: the phone reconnects and the carrier that answers is shown in the connection state.
    async testWays(id) {
      if (replay) return { ok: false, reason: 'demo' };
      if (!channel || activeId !== id) return { ok: false, reason: 'offline' };
      channel.reconnect?.();
      refresh();
      return { ok: true, reason: null };
    },

    // Notifications kept on the computer (POST /api/phones/push). A switch the computer refuses stays where it was.
    async setPush(patch) {
      if (replay) {
        pushKnown = { ...S.pushValues(pushKnown), ...patch };
        refresh();
        return { ok: true, reason: null };
      }
      // Turning the first line off turns Approve from notifications off in the same request: the approval needs that line.
      const sent = patch.firstLine === false ? { ...patch, approveFromNotifications: false } : { ...patch };
      const out = await postJson('/api/phones/push', sent);
      if (out.ok) {
        pushKnown = { ...S.pushValues(pushKnown), ...patch };
        if (sent.approveFromNotifications !== undefined) await keepApprove(sent.approveFromNotifications === true);
      }
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    // Approve from notifications: asked of the computer, which checks the first line itself (409 when it is off).
    async setApprove(value) {
      const on = value === true;
      if (on && !(pushKnown?.firstLine === true)) return { ok: false, reason: 'first-line' };
      if (replay) {
        approveStored = on;
        refresh();
        return { ok: true, reason: null };
      }
      const out = await postJson('/api/phones/push', { approveFromNotifications: on });
      if (out.ok) await keepApprove(on);
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    async testPush() {
      if (replay) return { ok: true, reason: null };
      const out = await postJson('/api/phones/test-push', {});
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    // Turn on notifications: the browser's permission (the user gesture is the tap on the screen). The native app asks through its plugin.
    // Web: the permission, then the push subscription, which the computer keeps: "Allowed" means a subscription is on the computer. The
    // computer's VAPID public key comes in its HELLO (vapidPublicKey); without it nothing is subscribed and the answer says so.
    // Android: UnifiedPush through the person's push app (push.js createAndroidPush); the endpoint it gives goes to the computer.
    async enableNotifications() {
      if (replay) return { ok: true, reason: null };
      if (androidPush) {
        const out = await androidPush.enable();
        androidPushState = await androidPush.state();
        refresh();
        return { ok: out.ok === true, reason: out.ok === true ? null : (out.reason ?? 'failed') };
      }
      const key = typeof hello?.vapidPublicKey === 'string' ? hello.vapidPublicKey : null;
      if (!key || !channel || !serviceWorker || !notifications) return { ok: false, reason: 'unavailable' };
      const registration = await registrationOf(serviceWorker);
      if (!registration) return { ok: false, reason: 'unavailable' };
      const out = await subscribeWebPush({
        registration,
        applicationServerKey: key,
        request: channel.request,
        deviceId: typeof hello?.deviceId === 'string' && hello.deviceId ? hello.deviceId : activeId,
        notification: notifications,
        env: pushEnv,
      });
      refresh();
      if (out.ok) return { ok: true, reason: null };
      if (out.state === 'denied') return { ok: false, reason: 'denied' };
      if (out.state === 'unsupported') return { ok: false, reason: 'unavailable' };
      return { ok: false, reason: 'failed' };
    },

    notificationPermission() {
      return notifications?.permission ?? 'unknown';
    },

    // Android: the person chooses the push app (the system chooser). The settings line reads the answer from state().androidPush.
    async chooseDistributor() {
      if (!androidPush) return { ok: false, reason: 'unavailable' };
      const out = await androidPush.chooseDistributor();
      androidPushState = await androidPush.state();
      refresh();
      return out;
    },

    // Turn the notifications of this phone off at the computer (the subscription is dropped there).
    async disableNotifications() {
      if (replay) return { ok: true, reason: null };
      if (androidPush) {
        const out = await androidPush.disable();
        androidPushState = await androidPush.state();
        refresh();
        return out;
      }
      const out = await postJson('/api/phones/push', { subscription: null });
      refresh();
      return { ok: out.ok, reason: out.reason };
    },

    // App lock on: biometric (native), a passkey (web) or a PIN (web, through setPin).
    async enableLock(mode) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      let result;
      if (mode === 'biometric') result = await lock.enableBiometric();
      else if (mode === 'passkey') result = await lock.enablePasskey();
      else return { ok: false, reason: 'mode' };
      lockStatus = { ...lockStatus, ...(await lock.status()) };
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? null };
    },

    async setPin(pin) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      const result = await lock.setPin(String(pin ?? ''));
      if (result?.ok) for (const [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
      lockStatus = { ...lockStatus, ...(await lock.status()) };
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? null };
    },

    async lockOff(pin = null) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      const result = await lock.disable({ pin: pin === null ? null : String(pin) });
      lockStatus = { ...lockStatus, ...(await lock.status()) };
      // Approve from notifications needs the app lock: with the lock off, the computer's opt-in goes off as well. When the computer cannot be
      // reached (or refuses), the opt-out is kept and sent at the next HELLO.
      if (result?.ok && approveStored && !replay) {
        let told = false;
        if (channel) {
          const out = await postJson('/api/phones/push', { approveFromNotifications: false });
          if (out.ok) {
            await keepApprove(false);
            told = true;
          }
        }
        if (!told) await store.meta.put(APPROVE_OFF_META, true).catch(() => {});
      }
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? (result?.ok ? null : 'pin') };
    },

    // The phone's own preferences (theme, text size, Stop side, haptics, switcher, lock time, dictation, the LAN strip).
    async setPrefs(patch) {
      await savePrefs({ ...prefs, ...(patch ?? {}) });
      applyPrivacy();
      return { ok: true, reason: null };
    },

    cancelConnect() {
      if (channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
        channelState = { ...channelState, status: 'closed' };
        activeId = null;
        store.meta.remove(ACTIVE_META).catch(() => {});
        refreshLockStop().then(refresh);
      }
      refresh();
      return { ok: true, reason: null };
    },

    // Drops a pairing in progress, and a pairing link that waits for review.
    cancelPairing() {
      const flow = pairingFlow;
      pairingFlow = null;
      pendingPair = null;
      try { flow?.cancel?.(); } catch { /* already done */ }
      pairing = null;
      refresh();
      return { ok: true, reason: null };
    },

    // The person pressed Pair on the review screen: the parked link starts pairing. Resolves the final pairing state, or { ok: false, reason: 'none' }.
    async confirmPair() {
      const parked = pendingPair;
      if (!parked) return { ok: false, reason: 'none' };
      pendingPair = null;
      return api.pair(parked.text);
    },

    // A line from the UI page's console (the facade's log): redacted, kept in the phone's own console and, when connected, sent to the computer.
    pageLog(line) {
      const entry = debug.log(String(line ?? '').slice(0, 2000), 'page');
      if (entry && channel && !replay) {
        channel.request({ method: 'POST', path: '/_bridge/log', headers: { 'content-type': 'application/json' } }, JSON.stringify({ line: entry.text }), { scope: 'shell' })
          .then(answer => answer.cancel?.(), () => {});
      }
      return Boolean(entry);
    },

    debugClear() {
      debug.clear();
      refresh();
      return { ok: true, reason: null };
    },

    // Posts the most recent debug lines to the computer. A phone not connected cannot send (the screen says so).
    async debugSend() {
      if (replay) return { ok: true, reason: null, n: 0 };
      if (!channel) return { ok: false, reason: 'offline', n: 0 };
      const n = await debug.sendToComputer(shellRequest(channel), 100).catch(() => 0);
      return { ok: n > 0, reason: n > 0 ? null : 'failed', n };
    },

    async demoDecide(id, decision) {
      if (!replay) return { ok: false, reason: 'not-demo' };
      const out = replay.decide(id, decision);
      refresh();
      return out;
    },

    demoReset() {
      if (!replay) return { ok: false, reason: 'not-demo' };
      replay.reset();
      stopView = { state: 'idle', ack: null, error: null, text: '', seq: stopView.seq };
      refresh();
      return { ok: true, reason: null };
    },

    async unlock(method, arg = null) {
      if (!lock) return { ok: false, reason: 'unavailable' };
      let result;
      if (method === 'biometric') result = await lock.unlockBiometric();
      else if (method === 'pin') result = await lock.unlockPin(arg);
      else if (method === 'passkey') result = await lock.unlockPasskey();
      else return { ok: false, reason: 'method' };
      if (result.ok) {
        for (const [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
        lockUnreadable = false;
        lockStatus = { ...lockStatus, ...(await lock.status()), locked: false };
        refresh();
        const saved = await store.meta.get(ACTIVE_META).catch(() => null);
        if (saved && computers.some(c => c.id === saved)) await connectNow(saved);
        // A link the page was opened with while locked runs now (a pairing, or a Stop from a notification).
        await runPendingLink();
        refresh();
      } else {
        lockStatus = { ...lockStatus, ...(await lock.status()) };
        refresh();
      }
      return { ok: result.ok, reason: result.reason ?? null, waitSec: result.waitSec ?? 0, failures: result.failures ?? 0 };
    },

    // Locks the app now. With no lock set there is nothing to unlock with, so nothing happens: the channel stays open and Stop stays reachable
    // (F4: locking without a lock used to close the channel and leave the phone locked until it was relaunched).
    async lockNow() {
      const status = lock ? await lock.status() : { mode: 'off' };
      if (!lock || status.mode === 'off') return { ok: false, reason: 'no-lock' };
      if (channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
      }
      unlockedKeys.clear();
      await refreshLockStop();
      lock.lock();
      lockStatus = { ...lockStatus, ...(await lock.status()), locked: true };
      refresh();
      return { ok: true, reason: null };
    },

    // The page went to the background or came back. The lock comes on after the time the person chose (prefs.lockAfter, five
    // minutes by default); "Immediately" locks on every return. The channel reconnects at once on return.
    async visibility(visible) {
      if (!visible) {
        hiddenAt = wall();
        return refresh();
      }
      const away = hiddenAt == null ? null : wall() - hiddenAt;
      hiddenAt = null;
      // The time is the person's (prefs.lockAfter) and this page keeps it. lock.js is not told about the background: its own fixed
      // five minutes would otherwise lock the app early (or leave it unlocked when the chosen time is longer).
      if (lock) {
        const after = S.lockAfter(prefs.lockAfter).ms;
        const locked = lockStatus.mode !== 'off' && away !== null && away >= after;
        if (locked && !lockStatus.locked) await api.lockNow();
      }
      channel?.reconnect();
      return refresh();
    },

    async runSelftest(options = {}) {
      if (!channel) return { ok: false, passed: 0, total: 5, steps: [], reason: 'not connected' };
      selftest = { running: true };
      refresh();
      const report = await selftestFn({
        channel,
        log: line => debug.log(line),
        ...options,
      });
      selftest = { ...report, running: false };
      // The report goes to the computer as the last debug line (POST /_bridge/log). The Bridge has no POST /_bridge/selftest.
      if (mode === 'selftest') await debug.sendToComputer(shellRequest(channel), 1).catch(() => 0);
      refresh();
      return report;
    },

    // A link the page was opened with, a fragment the service worker posts, a native deep link or a fragment typed into the address bar:
    // a pairing link (#pair=..., plenum://pair#...), or a notification link (see push.js parseNotificationHash). While the app is locked the
    // link waits for the unlock.
    async handleHash(hash) {
      const text = String(hash ?? '');
      // The shell page's own screens (from the UI page's Phone settings and Computers): the screens read screenRequest once the app is unlocked.
      // The UI page has no such screens and ignores these two.
      if (pageKind === 'shell' && (text === '#settings' || text === '#computers')) {
        if (booted) await lockRead;
        if (lockStatus.locked || lockUnreadable) {
          pendingLink = { text, at: wall() };
          return { ok: false, reason: 'locked' };
        }
        screenSeq += 1;
        screenRequest = { screen: text.slice(1), seq: screenSeq };
        refresh();
        return { ok: true, reason: null, kind: 'screen' };
      }
      // A #connect=<id> link (the UI page sends it here to show another computer, plan G2.6): the shell page connects that computer and shows its UI.
      const connectId = pageKind === 'shell' ? /^#connect=([0-9a-f]{64})$/.exec(text)?.[1] ?? null : null;
      if (connectId) {
        if (booted) await lockRead;
        if (lockStatus.locked || lockUnreadable) {
          pendingLink = { text, at: wall() };
          return { ok: false, reason: 'locked' };
        }
        if (!computers.some(c => c.id === connectId)) return { ok: false, reason: 'unknown', kind: 'connect' };
        forceUi = true;
        if (channel && activeId === connectId) {
          if (hello) afterHello();
          return { ok: true, reason: null, kind: 'connect' };
        }
        const opened = await connectNow(connectId);
        if (!opened.ok) forceUi = false;
        refresh();
        return { ...opened, kind: 'connect' };
      }
      const isPair = text.includes('pair=') || /^plenum:\/\/pair#/.test(text);
      const link = parseNotificationHash(text);
      if (!isPair && !link) return { ok: false, reason: 'no link' };
      if (booted) await lockRead;
      if (lockStatus.locked || lockUnreadable) {
        // A Stop does not wait for the unlock when this phone can send it without one (stop() parks it when it cannot).
        if (!isPair && link?.kind === 'stop') return api.stop();
        pendingLink = { text, at: wall() };
        return { ok: false, reason: 'locked' };
      }
      if (isPair) {
        // The pairing screens are the shell page's. From the UI page, the whole link goes there (the apps keep it for the shell page).
        if (pageKind === 'ui' && uiHost) {
          leaving = true;
          await uiHost.openShell(text).catch(() => {});
          return { ok: true, reason: null, kind: 'pair' };
        }
        // A pairing link from outside the app waits on the review screen until the person taps Pair; nothing is opened before that. The
        // &ci-confirm=1 marker (dev builds only) skips the review, and a release build strips it and still shows it.
        const marked = /&ci-confirm=1$/.test(text);
        const bare = marked ? text.replace(/&ci-confirm=1$/, '') : text;
        if (replay || (marked && devBuild)) return api.pair(bare);
        let payload;
        try {
          payload = parsePairingText(bare);
        } catch (err) {
          pairing = { state: 'failed', code: null, tried: [], reason: err?.code ?? 'not-plenum' };
          refresh();
          return { ...pairing };
        }
        const hosts = [];
        const addHost = (kind, url) => {
          const host = hostLabel(url);
          if (host && !hosts.some(h => h.kind === kind && h.host === host)) hosts.push({ kind, host });
        };
        for (const c of usableCarriers(payload.carriers)) for (const url of c.urls) addHost(c.kind, url);
        for (const c of pageCandidates(pageUrl, payload)) if (carrierUrlOk(c.kind, c.url)) addHost(c.kind, c.url);
        if (!hosts.length) {
          pairing = { state: 'failed', code: null, tried: [], reason: 'no-carrier' };
          refresh();
          return { ...pairing };
        }
        pendingPair = { text: bare };
        pairing = { state: 'review', code: null, tried: [], reason: null, review: { name: cleanName(payload.name) || 'Plenum computer', hosts } };
        refresh();
        return { ok: true, reason: null, kind: 'review' };
      }
      if (link.kind === 'stop') {
        // Sent at once. A computer that is away gets the STOP queued by the worker, which resends it on every reconnect for 60 s.
        if (channel) return api.stop();
        say('Nothing to stop: no computer is connected.', 'warn');
        refresh();
        return { ok: false, reason: 'not connected' };
      }
      if (link.kind === 'deny') {
        // A denial is sent as it is: the computer checks that the card still waits (a denial needs no first line).
        if (!(await whenConnected())) {
          say('Not connected. Open the approval to answer it.', 'warn');
          refresh();
          return { ok: false, reason: 'offline', kind: 'deny' };
        }
        const out = await postJson('/api/approve', { approvalId: link.id, allow: false });
        say(out.ok ? 'Denied.' : 'That card is no longer waiting. Open it to see what changed.', out.ok ? 'ok' : 'warn');
        refresh();
        return { ok: out.ok, reason: out.reason, kind: 'deny' };
      }
      if (link.kind === 'approve') {
        // An approval from a notification carries the first line the notification showed (&line=...). It is sent in the x-plenum-notify-line
        // header, with the same body an answer from the open card has; the computer approves only when this phone has the opt-in and the
        // card that waits still starts with that line, and answers 409 otherwise. Without the line it would be taken for an answer from the
        // open card, so nothing is sent: the card is opened instead.
        const reachable = link.line ? await whenConnected() : Boolean(channel);
        if (!link.line || !reachable) {
          say(reachable ? 'Open the approval to answer it.' : 'Not connected. Open the approval to answer it.', reachable ? 'info' : 'warn');
          emitRoute({ kind: 'waiting', id: link.id });
          return { ok: false, reason: reachable ? 'open-card' : 'offline', kind: 'approve' };
        }
        const out = await postJson('/api/approve', { approvalId: link.id, allow: true }, { 'x-plenum-notify-line': link.line });
        if (out.ok) {
          say('Approved.', 'ok');
          refresh();
          return { ok: true, reason: null, kind: 'approve' };
        }
        if (out.status === 409 || out.status === 403) {
          say(CARD_CHANGED, 'warn');
          emitRoute({ kind: 'waiting', id: link.id });
          return { ok: false, reason: 'changed', kind: 'approve' };
        }
        say('Could not reach your computer. Open the approval to answer it.', 'warn');
        emitRoute({ kind: 'waiting', id: link.id });
        return { ok: false, reason: out.reason, kind: 'approve' };
      }
      if (isRouteLink(link)) {
        emitRoute(link);
        return { ok: true, reason: null, kind: link.kind };
      }
      return { ok: false, reason: 'no link' };
    },

    // The desktop UI. On the shell page: pulls what the computer has and hands the page to it (it does that by itself after HELLO; this is for
    // "Open Plenum" on /?shell and for Try again).
    showUi,

    // The screens call this when the steps after a pairing are over (or were skipped): the page may go to the UI now.
    releaseUi() {
      if (!holdUi) return;
      holdUi = false;
      if (hello) afterHello();
    },

    // "Use the copy in this app": the UI that is already on the phone, without asking the computer.
    async useCopy() {
      if (!uiHost) return { ok: false, reason: 'unavailable' };
      ui = { ...ui, state: 'loading', cause: null };
      refresh();
      const out = await uiHost.useCopy();
      if (out.ok) ui = { ...ui, state: 'navigating' };
      else ui = { state: 'failed', cause: out.cause ?? 'worker', progress: null, hasCopy: false };
      refresh();
      return { ok: out.ok, reason: out.ok ? null : out.cause };
    },

    // From the UI page back to the shell's screens (Phone settings, the computer list, pairing).
    async openShell(hash = '') {
      if (!uiHost) return false;
      leaving = true;
      const done = await uiHost.openShell(hash).catch(() => false);
      if (!done) leaving = false;
      return done;
    },

    // The route a notification named, once: { kind, id?, project?, section?, seq } or null.
    takeRoute() {
      if (!intent || intent.taken) return null;
      intent = { ...intent, taken: true };
      const out = { ...intent };
      refresh();
      return out;
    },

    // Scans a pairing code with the phone's camera (native). { ok, text } or { ok: false, reason: 'denied' | 'cancelled' | 'failed' | 'unavailable' }.
    // The text is a pairing link: the caller hands it to pair().
    async scan() {
      if (!native?.BarcodeScanner) return { ok: false, reason: 'unavailable' };
      return native.BarcodeScanner.scan();
    },

    // Turns the dictation on the phone on or off: the plugin's start/stop. Result events go to boot.js (plenumShell.dictation).
    async dictation() {
      await loadDictation();
      return dictationState ? { ...dictationState } : { available: false, onDevice: false, permission: 'prompt' };
    },

    async start() {
      if (started) return snapshot;
      started = true;
      const hash = String(pageUrl && pageUrl.includes('#') ? pageUrl.slice(pageUrl.indexOf('#')) : '');
      // The link is read once and taken out of the address bar, so the pairing secret does not stay in the URL or in the history.
      if (hash.length > 1) {
        clearHash();
        pendingLink = { text: hash, at: wall() };
      } else if (typeof initialLink === 'string' && initialLink) {
        // No address to carry it (the apps): the link the UI page left for this page. It waits behind the lock like the address one.
        pendingLink = { text: initialLink, at: wall() };
      }
      await api.boot();
      // A pairing link or a notification action runs now, or at the unlock when the app is locked.
      await runPendingLink();
      return snapshot;
    },
  };
  return api;
}

// ----- the page -----

// H6: a real phone is a page with Capacitor's native bridge: the WebView carries window.androidBridge (Android) or
// window.webkit.messageHandlers.bridge (iPhone). Capacitor's registerPlugin is not a sign of one: the bridge script has none, and
// @capacitor/core sets itself up only inside the bundle, once native.js imports it.
export function hasNativeBridge(env) {
  return Boolean(env?.androidBridge || env?.webkit?.messageHandlers?.bridge);
}

// The native plugins are loaded on a phone: a native platform that has the bridge. The Electron harness stub (a Capacitor with no bridge)
// keeps the plain Capacitor.Plugins it was given.
export function wantsNativePlugins(env) {
  return isNative(env) && hasNativeBridge(env);
}

// The plugins of a native app (native.js), or null when this page is not a phone with the bridge. Not exported: the bundle's namespace can be
// imported by any script of the page, and this returns the secure-storage plugin. startShell is the one caller (the suites go through it).
async function loadNativePlugins(env) {
  if (!wantsNativePlugins(env)) return null;
  const mod = await import('./native.js');
  return mod.loadNativePlugins();
}

// A deep link of the native app to the fragment the shell runs: plenum://app/#stop|#deny=<id>|#approve=<id>&line=..., or the pairing link.
export function linkOfUrl(url) {
  const text = String(url ?? '');
  const app = /^plenum:\/\/app\/?(?:\?[^#]*)?(#.*)$/.exec(text);
  if (app) return app[1];
  if (/^plenum:\/\/pair#/.test(text)) return text;
  return null;
}

// M6: links that open the native app (a pairing QR, a notification action or tap from the push app) reach the shell, and the shell page
// handles the hardware Back button (the UI page's Back is boot.js). A link that arrives while the app is locked waits for the unlock (the
// shell's handleHash holds it). Returns afterStart(), which runs the link the app was launched with, once: call it when the shell has started.
// On iOS a plenum://app/ link (#stop, #deny, #approve) is ignored: the iPhone has no notification actions, and any web page can open the scheme.
// plenum://pair still reaches the review screen.
export function wireAppPlugin({ appPlugin, shell, env, pageKind, platform = null }) {
  const opened = new Set();
  let launchRan = false;
  const wanted = link => Boolean(link) && !(platform === 'ios' && link.startsWith('#'));
  if (appPlugin?.addListener) {
    appPlugin.addListener('appUrlOpen', event => {
      const url = String(event?.url ?? '');
      const link = linkOfUrl(url);
      if (!wanted(link)) return;
      opened.add(url);
      shell.handleHash(link).catch(() => {});
    });
    if (pageKind === 'shell') {
      appPlugin.addListener('backButton', () => {
        const event = typeof env?.CustomEvent === 'function' ? new env.CustomEvent('plenum-back', { cancelable: true }) : null;
        if (event && env.dispatchEvent?.(event) === false) return;
        if (typeof appPlugin.minimizeApp === 'function') appPlugin.minimizeApp();
        else appPlugin.exitApp?.();
      });
    }
  }
  return async function afterStart() {
    if (launchRan || !appPlugin?.getLaunchUrl) return;
    launchRan = true;
    try {
      const launched = await appPlugin.getLaunchUrl();
      const url = String(launched?.url ?? '');
      const link = linkOfUrl(url);
      // The system may also deliver the launching link as an appUrlOpen: it has run then.
      if (wanted(link) && !opened.has(url)) shell.handleHash(link).catch(() => {});
    } catch { /* no launch link */ }
  };
}

// The one-shot slot of a page object other than globalThis (the Node suites): the function boot.js installed, taken and removed.
function takeAttachSlot(env) {
  const f = env?.__plenumAttachShell;
  try { delete env.__plenumAttachShell; } catch { /* not configurable */ }
  return typeof f === 'function' ? f : null;
}

// Starts the shell in the page: the store (secure storage on native, IndexedDB on the web), the lock, the debug console and the
// visibility handling. The shell page's screens get the full core through the hand-over (giveCore, plan C6a) and the UI page's shim gets the
// facade through the one-shot slot (attach, plan C6b); only a dev build also sets window.plenumShellCore and window.plenumNative.
// Returns the shell, or null when the page is not allowed to start one (a frame, a page a same-origin window opened, or a page that has
// started already).
// loadPlugins, devBuild, attach and giveCore are for the Node suites (a phone whose plugins did not load, a release build, the slots): they
// apply to an env that is not the page global. On the page global the first start is the module's own (no options), a later one returns null,
// and devBuild is always the build-time constant, so a script of the page can neither get a second core nor switch the test hooks on.
export async function startShell(env = globalThis, { loadPlugins = loadNativePlugins, devBuild = DEV_BUILD, attach, giveCore } = {}) {
  const ofPage = env === globalThis;
  if (ofPage) {
    if (!takePageStart()) {
      // Only a hand-over the caller supplied hears of it; the page's own hand-over (giveShellCore) is never touched by a refused start.
      giveCore?.(null);
      return null;
    }
    devBuild = DEV_BUILD;
  }
  const give = giveCore ?? (ofPage ? giveShellCore : () => {});
  const attachFn = attach !== undefined ? attach : ofPage ? attachShim : takeAttachSlot(env);
  let handed = false;
  try {
    return await runStart(env, { loadPlugins, devBuild, attach: attachFn, give: value => { handed = true; give(value); } });
  } catch (error) {
    if (!handed) give(null);
    throw error;
  }
}

async function runStart(env, { loadPlugins, devBuild, attach, give }) {
  // A page in a frame, or one a same-origin window opened, is not a Plenum page: it starts nothing and opens no store.
  let framed = false;
  try { framed = env.top !== env.self; } catch { framed = true; }
  let sameOriginOpener = false;
  try { sameOriginOpener = Boolean(env.opener) && env.opener.location.origin === env.location.origin; } catch { sameOriginOpener = false; }
  if (framed || sameOriginOpener) {
    give(null);
    return null;
  }
  const { device, caps, native } = deviceFor(env);
  const cap = env.Capacitor;
  const pageKind = pageKindFor(env);
  const lan = isLanPage(env);
  const bridge = hasNativeBridge(env);
  let plugins = null;
  let pluginFailure = false;
  if (native) {
    try {
      plugins = await loadPlugins(env);
    } catch {
      pluginFailure = true;
    }
  }
  // Keys go to the Keychain or Keystore. On a phone (the bridge is there) that is the secure-storage plugin or nothing: if the plugins did not
  // load, nothing is stored (never IndexedDB, which any script of the page can read). Without the bridge (the harness stub) the page keeps the
  // Capacitor.Plugins it was given.
  const registered = plugins?.secureStorage ?? cap?.Plugins?.SecureStorage ?? null;
  const secureStorage = native || bridge ? (pluginFailure || (bridge && (!plugins || !registered)) ? NO_SECURE_STORAGE : registered) : null;
  const store = createPlatformStore({ secureStorage, indexedDB: env.indexedDB ?? null });
  const biometricPlugin = native ? plugins?.BiometricAuth ?? cap?.Plugins?.BiometricAuth ?? null : null;
  const lock = createLock({
    store,
    now: () => Date.now(),
    biometric: createBiometricGate({ plugin: biometricPlugin }),
    passkey: native ? null : createPasskeyGate({ credentials: env.navigator?.credentials, PublicKeyCredentialCtor: env.PublicKeyCredential, rpId: env.location?.hostname }),
  });
  const params = new URLSearchParams(String(env.location?.search ?? ''));
  const mode = modeFor(env.location?.search, devBuild);
  const stay = params.has(SHELL_QUERY);
  // A link for the shell page waits in the store (never in web storage); an older version left it in sessionStorage, which is cleared once.
  const linkStore = createLinkStore(store.meta);
  try { env.sessionStorage?.removeItem(SHELL_LINK_KEY); } catch { /* no session storage */ }
  // F1: the service worker, for the PWA. Not awaited: the page does not wait for the worker to activate.
  if (!native && pageKind === 'shell') registerServiceWorker(env);
  let shell = null;
  const kind = native ? (device.platform === 'android' ? 'android' : 'ios') : lan ? 'lan' : 'web';
  const uiHost = mode === 'normal' && env.location && (!native || plugins)
    ? createUiHost({ env, kind, native: plugins, channelOf: () => shell?.channel ?? null, log: line => shell?.debug.log(line, 'warn'), linkStore })
    : null;
  let initialIntent = null;
  try {
    const saved = pageKind === 'ui' ? env.sessionStorage?.getItem('plenum-intent') : null;
    if (saved) {
      env.sessionStorage.removeItem('plenum-intent');
      initialIntent = JSON.parse(saved);
    }
  } catch {
    initialIntent = null;
  }
  // M6: a link the UI page could not carry in an address (the apps): the shell page takes it out of the store once, then waits for the unlock.
  let initialLink = null;
  if (native && plugins && pageKind === 'shell') initialLink = await linkStore.take();
  shell = createShell({
    store,
    lock,
    device,
    caps,
    pageUrl: env.location?.href ?? null,
    mode,
    createWorker: defaultCreateWorker,
    notifications: env.Notification ?? null,
    serviceWorker: env.navigator?.serviceWorker ?? null,
    pushEnv: env,
    clearHash: () => clearAddressHash(env),
    native: plugins,
    uiHost,
    pageKind,
    stay,
    initialIntent,
    initialLink,
    // A notification route that arrives on the shell page is kept for the UI page, and the UI is opened.
    onIntent: link => {
      try { env.sessionStorage?.setItem('plenum-intent', JSON.stringify(link)); } catch { /* the route is then not shown */ }
      shell?.showUi({ force: true });
    },
    onReload: () => { env.location?.reload?.(); },
    devBuild,
    storage: secureStorage === NO_SECURE_STORAGE ? 'unavailable' : 'ok',
  });
  if (secureStorage === NO_SECURE_STORAGE) shell.debug.log('storage: unavailable', 'warn');
  // Test hooks, in dev builds only: the full core and the plugin registry on the page object.
  if (devBuild) {
    env.plenumShellCore = shell;
    env.plenumNative = plugins;
  }
  // The UI page's shim gets the facade; the shell page's screens get the core.
  attach?.(makeFacade(shell, plugins));
  give(shell);
  env.addEventListener?.('visibilitychange', () => {
    shell.visibility(env.document?.visibilityState !== 'hidden');
  });
  env.addEventListener?.('pagehide', () => shell.visibility(false));
  // A notification action while the app is open: the service worker posts the fragment; a fragment typed into the address bar too.
  env.addEventListener?.('hashchange', () => {
    const hash = String(env.location?.hash ?? '');
    if (hash.length > 1) {
      clearAddressHash(env);
      shell.handleHash(hash).catch(() => {});
    }
  });
  env.navigator?.serviceWorker?.addEventListener?.('message', event => {
    const data = event?.data;
    if (data?.op === 'plenum-hash' && typeof data.hash === 'string') shell.handleHash(data.hash).catch(() => {});
  });
  const afterStart = wireAppPlugin({ appPlugin: plugins?.App ?? null, shell, env, pageKind, platform: device.platform });
  await shell.start();
  await afterStart();
  if (mode === 'selftest') {
    const report = await shell.runSelftest();
    shell.debug.log(`selftest ${report.passed}/${report.total}`);
  }
  return shell;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  startShell(globalThis).catch(err => {
    giveShellCore(null);
    console.error(String(err?.message ?? err));
  });
}
