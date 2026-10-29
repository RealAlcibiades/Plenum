// The shell screen router (mob-10, waves 106 and 107). The bundle entry is screens.js (built from this file). It runs in the shell page and
// takes the shell core from shell.js's one-shot hand-over (C6a), subscribes to the shell's state, and draws the screen that state calls for. It also
// owns the shell DOM pieces that float above every screen: the demo strip (MOBILE-UI 6.18), the LAN strip (6.12), the connection strip
// (9, C5) and #plenum-stop (9.1).
//
//   ?demo=1&screen=<id>&theme=light|dark   draws one of the 22 part 1 screens with the fixture values (fixtures.js); no computer.
//                                           Dev builds only (C7).
//   ?demo=1                                 the demo (MOBILE-UI 6.18): the replay of demo/session.json, offline, through the shell core.
//                                           Every build.
//   ?debug=1                                window.plenumScreensDebug for the suite: go(id, patch), setFixture(patch), advance(ms).
//                                           Dev builds only (C7).
//
// Nothing here stores a key, a token or a Noise value. The page's text is textContent only. The core calls (flows.js) move a screen on
// only when the core says the step worked.

import { el, setDocument } from './dom.js';
import { clock, LINK_UNAVAILABLE, LOCK_FAILED, SCREEN_IDS, SETTINGS_MANUAL, STOP_LABEL } from './copy.js';
import * as C from './copy.js';
import * as C2 from './copy2.js';
import * as S from './settings.js';
import { codeSecondsLeft, ctxFor, defaultPhoneName, drivingText, lanPage, passkeyAvailable, platformOf, screenFor, stateKey, clockTime } from './route.js';
import { fixtureCtx } from './fixtures.js';
import { STOP_FAILURE_TEXT } from '../stop.js';
import { renderScreen } from './views.js';
import { PART2_SCREEN_BUILDERS, renderPart2 } from './views2.js';
import {
  call,
  cleanPhoneName,
  enableLockFlow,
  enableNotificationsFlow,
  forgetFlow,
  LEGAL_LINKS,
  openLinkFlow,
  openSettingsFlow,
  STORE_LINKS,
  unlockAndStopFlow,
  unlockFlow,
} from './flows.js';

const LOCK_IDS = Object.freeze(['lock-bio', 'lock-pin']);
// Lock failures that are not a failed check: a cancel, a method the lock does not use, or a method this phone lacks.
const NOT_A_FAILED_CHECK = Object.freeze(['cancelled', 'mode', 'unavailable']);
// The part 2 screens (and the PIN setup) are reached by the person's own navigation.
const NAV_IDS = Object.freeze([...C2.PART2_IDS, 'pin-set']);
// What the scan screen says when the camera ran but nothing could be read (the paste screen is one tap away).
const SCAN_FAILED = 'The camera could not read a code. Hold it steady, or paste the link instead.';
// The release gate (C7): the fixture screens and the debug hooks exist only in a --dev build. An unbundled source (the Node suites) is a dev build.
const DEV_BUILD = typeof __PLENUM_DEV_BUILD__ !== 'undefined' ? __PLENUM_DEV_BUILD__ === true : true;

// window.plenumScreensDebug (?debug=1, or any ?demo=1 in a dev build) exists only in a dev build.
export function screensDebugOn(params, devBuild = DEV_BUILD) {
  return devBuild === true && (params.get('demo') === '1' || params.get('debug') === '1');
}

// The browser's own QR reading: BarcodeDetector over a camera stream. Resolves { ok, text } or { ok: false, reason }: 'unavailable' when the
// browser has no detector or no camera API (the person is sent to the paste screen), 'denied' when the camera was refused, 'failed' otherwise.
// getVideo() returns the <video> the camera shows in; `register` receives a function that stops the camera and the loop (the router calls it when the screen is left).
export async function scanWithBrowser(env, getVideo, register, { interval = 250 } = {}) {
  const videoNow = () => (typeof getVideo === 'function' ? getVideo() : getVideo);
  const Detector = env.BarcodeDetector;
  const media = env.navigator?.mediaDevices;
  if (typeof Detector !== 'function' || typeof media?.getUserMedia !== 'function') return { ok: false, reason: 'unavailable' };
  let stream = null;
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
    for (const track of stream?.getTracks?.() ?? []) track.stop?.();
    stream = null;
    const shown = videoNow();
    if (shown) shown.srcObject = null;
  };
  register(stop);
  try {
    stream = await media.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (err) {
    stop();
    return { ok: false, reason: /NotAllowed|Permission|Security/i.test(String(err?.name ?? err)) ? 'denied' : 'failed' };
  }
  if (stopped) { stop(); return { ok: false, reason: 'cancelled' }; }
  const shown = videoNow();
  if (shown) {
    shown.srcObject = stream;
    shown.play?.().catch?.(() => {});
  }
  let detector;
  try {
    detector = new Detector({ formats: ['qr_code'] });
  } catch {
    stop();
    return { ok: false, reason: 'unavailable' };
  }
  return new Promise(resolve => {
    const look = async () => {
      if (stopped) { resolve({ ok: false, reason: 'cancelled' }); return; }
      try {
        const found = await detector.detect(videoNow());
        const text = found?.find?.(c => typeof c?.rawValue === 'string' && c.rawValue)?.rawValue;
        if (text) { stop(); resolve({ ok: true, text }); return; }
      } catch {
        // A frame that cannot be read is skipped.
      }
      timer = env.setTimeout(look, interval);
    };
    look();
  });
}

function setHidden(node, flag) {
  if (flag) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

function applyTheme(doc, theme) {
  const root = doc.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

// The context fields that decide whether a screen must be drawn again. The countdown and the strip are updated in place. The lock
// screens also redraw when the Stop result changes, because they show it.
function signatureOf(ctx) {
  const { countdown, stripInfo, stopState, stopText, carrierLabel, ...rest } = ctx;
  return JSON.stringify(LOCK_IDS.includes(ctx.id) ? { ...rest, stopText } : rest);
}

// The message a lock screen shows for a failed unlock (MOBILE-UI 6.13). A PIN keeps its own message in the pad.
function lockMessage(method, result) {
  if (method === 'pin' || result?.ok === true) return null;
  return NOT_A_FAILED_CHECK.includes(result?.reason) ? null : LOCK_FAILED;
}

// hh:mm:ss.mmm-free clock for a debug line (local time).
function hhmmss(ms) {
  const d = new Date(Number(ms) || 0);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// "21 Oct 2026, 18:40" for a last-seen time (MOBILE-UI 6.11).
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
function seenText(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clockTime(ms)}`;
}

// Where the "Add to Home Screen" and "Install" guides apply: a web page on https, not yet installed (MOBILE-UI 6.12).
export function installHint(env = globalThis) {
  if (platformOf(env) !== 'web' || lanPage(env)) return null;
  if (String(env.location?.protocol ?? '') !== 'https:') return null;
  const standalone = env.matchMedia?.('(display-mode: standalone)')?.matches === true || env.navigator?.standalone === true;
  if (standalone) return null;
  const ua = String(env.navigator?.userAgent ?? '');
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return null;
}

// The view model the part 2 screens draw from: plain data built from the shell state and the phone's device (no functions, no keys).
export function buildVm(s, nav, env, core = null) {
  const platform = platformOf(env);
  const native = platform !== 'web';
  const ua = String(env.navigator?.userAgent ?? '');
  const iosWeb = !native && /iPhone|iPad|iPod/.test(ua);
  const prefs = s?.prefs ?? S.normalisePrefs(null);
  const hello = s?.hello ?? null;
  const conn = s?.connection ?? {};
  const lockMode = s?.lock?.mode ?? 'off';
  const push = S.pushValues(s?.pushKnown ?? null);
  const approveRule = S.approveSwitch({ tier: hello?.tier ?? 'full', firstLine: push.firstLine, lockMode, native });
  const approve = { ...approveRule, checked: S.approveChecked(s?.approveStored, approveRule) };
  const computers = (s?.computers ?? []).map(c => {
    const active = c.id === s.activeId;
    const connected = active && conn.status === 'connected' && Boolean(hello);
    return {
      id: c.id,
      name: String(c.name ?? ''),
      active,
      connected,
      status: active ? (conn.status ?? null) : null,
      lastSeen: c.lastSeen ?? null,
      dateText: c.lastSeen ? seenText(c.lastSeen) : null,
      carrierLabel: active ? (C.CARRIER_LABEL[conn.carrier] ?? null) : null,
      lastCarrierLabel: C.CARRIER_LABEL[c.lastCarrier] ?? null,
      version: active ? (hello?.desktopVersion || null) : null,
      carrierOrder: (Array.isArray(c.carriers) ? c.carriers : []).map(x => x.kind),
      ways: (Array.isArray(c.carriers) ? c.carriers : []).map(x => x.kind),
      waysDetail: null,
    };
  });
  const since = conn.since ? clockTime(conn.since) : null;
  const connectedCarrier = C.CARRIER_LABEL[conn.carrier] ?? null;
  const perm = core?.notificationPermission?.() ?? 'unknown';
  const lockLabel = lockMode === 'biometric' ? C.biometricName(platform) : lockMode === 'pin' ? 'PIN' : lockMode === 'passkey' ? 'passkey' : 'Off';
  const debugLines = core?.debug?.lines?.() ?? [];
  const demo = s?.demo ?? { computer: { name: 'Demo computer' }, projects: [], runs: [], approvals: [], agents: [], drive: null, diff: null, artifacts: [] };
  return {
    native,
    platform,
    computers,
    connected: { id: s?.activeId ?? null, since, carrierLabel: connectedCarrier },
    about: {
      appVersion: s?.device?.appVersion ?? '',
      protocol: s?.device?.protocol ?? '1.0',
      desktopVersion: hello?.desktopVersion || null,
      since,
      carrierLabel: connectedCarrier,
      screensLoaded: null,
      newerUi: false,
    },
    notify: { label: C2.NOTIFY_PERMISSION[perm] ?? C2.NOTIFY_PERMISSION.unknown, hint: perm === 'denied' ? C2.NOTIFY_DENIED_HINT : null },
    lock: { mode: lockMode, label: lockLabel, failures: Number(s?.lock?.failures) || 0, waitSec: Number(s?.lock?.waitSec) || 0, prefs: null },
    prefs,
    push,
    approve,
    haptics: { visible: !iosWeb },
    unifiedPush: platform === 'android' ? { supported: s?.androidPush?.supported === true, distributor: s?.androidPush?.distributor ?? null, registered: s?.androidPush?.registered === true, failure: s?.androidPush?.failure ?? null } : null,
    dictation: native ? { available: s?.dictation?.available === true, onDevice: s?.dictation?.onDevice === true, permission: s?.dictation?.permission ?? 'prompt', known: Boolean(s?.dictation) } : null,
    debug: { lines: debugLines.slice(-500).map(l => ({ level: l.level ?? 'info', time: hhmmss(l.at), text: String(l.text ?? '') })) },
    demo,
    replay: Boolean(s?.demo),
  };
}

export function mountScreens(env = globalThis) {
  const doc = env.document;
  if (!doc?.body) return null;
  setDocument(doc);
  const params = new URLSearchParams(env.location?.search ?? '');
  const demoParam = params.get('demo') === '1';
  const screenParam = params.get('screen');
  // ?demo=1&screen=<part 1 id> draws the fixtures (the wave 106 screenshots), in a dev build only. Any other ?demo=1 is the replay through the shell core.
  const fixtureMode = DEV_BUILD && demoParam && SCREEN_IDS.includes(screenParam);
  const replayMode = demoParam && !fixtureMode;
  const debug = screensDebugOn(params, DEV_BUILD);
  applyTheme(doc, params.get('theme'));
  doc.documentElement.setAttribute('data-shell-page', '');

  const nav = {
    screen: null,
    forced: null,
    pairingCancelled: false,
    dismissedKey: null,
    lastDriving: null,
    onboarding: null,
    codeSince: null,
    codeExpired: false,
    uiState: null,
    consentGiven: false,
    progress: null,
    uiCause: 'checksum',
    hasCopy: false,
    local: {},
    stack: [],
  };
  if (replayMode && NAV_IDS.includes(screenParam)) nav.screen = screenParam;
  let demoId = fixtureMode ? (screenParam ?? 'welcome') : null;
  let demoOverrides = {};
  let clockOffset = 0;
  // The shell core arrives once, from the hand-over taken at mount (C6a). coreKnown is true once the hand-over has answered.
  let core = null;
  let coreKnown = false;
  let snapshot = null;
  let lastId = null;
  let lastSig = '';
  let unsubscribe = null;
  let deferredInstall = null;
  let scanning = false;
  let scanStop = null;
  const stopScan = () => {
    scanning = false;
    const stop = scanStop;
    scanStop = null;
    stop?.();
  };
  const timers = new Set();
  const now = () => Date.now() + clockOffset;
  const later = (fn, ms) => {
    const t = env.setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  const stateKeyNow = () => stateKey(snapshot);

  // The shell DOM: the demo strip and the LAN strip above the screen, the connection strip, the view, and the Stop after everything.
  const host = doc.getElementById('sh-app') ?? doc.body.appendChild(el('div', { id: 'sh-app' }));
  const demoStrip = el('div', { id: 'plenum-demo-strip', class: 'plenum-demo-strip', role: 'status', hidden: true },
    el('span', { class: 'plenum-demo-text', text: C2.DEMO_STRIP }),
    el('button', { type: 'button', class: 'sh-link plenum-demo-exit', on: { click: () => actions.exitDemo() } }, C2.DEMO_EXIT));
  const lanStrip = el('div', { id: 'plenum-lan-strip', class: 'plenum-lan-strip', role: 'status', hidden: true },
    el('span', { class: 'plenum-lan-text' }),
    el('button', { type: 'button', class: 'sh-link plenum-lan-got', on: { click: () => actions.dismissLan() } }, 'Got it'));
  const strip = el('div', { id: 'plenum-conn-strip', class: 'plenum-conn-strip', role: 'status', hidden: true },
    el('span', { class: 'plenum-conn-text' }));
  const view = el('div', { id: 'sh-view', class: 'sh-view' });
  // The three strips stack at the top in one block. The block takes the notch inset once; the screen below keeps only its own padding
  // while the block shows (styles.css, data-strips on the host), so the strips never overlap each other or the screen's buttons.
  const stripStack = el('div', { id: 'plenum-strips', class: 'plenum-strips', hidden: true }, demoStrip, lanStrip, strip);
  host.replaceChildren(stripStack, view);
  const stop = el('button', {
    id: 'plenum-stop',
    class: 'plenum-stop',
    type: 'button',
    'aria-label': 'Stop everything on your computer',
    hidden: true,
    on: { click: () => { actions.stop(); } },
  },
  el('span', { class: 'plenum-stop-mark', 'aria-hidden': 'true' }),
  el('span', { class: 'plenum-stop-label', text: 'Stop' }),
  el('span', { class: 'plenum-stop-note', role: 'status' }));
  doc.body.appendChild(stop);
  // The Stop result (MOBILE-UI 9.1): a toast for a notice (the result of a Stop, a queued Stop, an answer), and a sheet when the
  // computer could not be reached. The toast is read out by a screen reader too; the sheet offers Try again.
  const toast = el('div', { id: 'plenum-toast', class: 'plenum-toast', role: 'status', hidden: true },
    el('span', { class: 'plenum-toast-text' }),
    el('button', { type: 'button', class: 'sh-link plenum-toast-close', on: { click: () => actions.dismissToast() } }, 'Close'));
  const sheet = el('div', {
    id: 'plenum-stop-sheet',
    class: 'plenum-stop-sheet',
    role: 'alertdialog',
    'aria-labelledby': 'plenum-stop-sheet-title',
    'aria-describedby': 'plenum-stop-sheet-body',
    hidden: true,
  },
  el('h2', { id: 'plenum-stop-sheet-title', class: 'plenum-stop-sheet-title', text: STOP_FAILURE_TEXT.title }),
  el('p', { id: 'plenum-stop-sheet-body', class: 'plenum-stop-sheet-body', text: STOP_FAILURE_TEXT.body }),
  el('div', { class: 'plenum-stop-sheet-actions' },
    el('button', { type: 'button', class: 'sh-btn sh-btn-primary plenum-stop-sheet-retry', on: { click: () => actions.retryStop() } }, 'Try again'),
    el('button', { type: 'button', class: 'sh-link plenum-stop-sheet-close', on: { click: () => actions.dismissStopSheet() } }, 'Close')));
  doc.body.append(toast, sheet);

  // How long a notice stays as a toast. A queued Stop keeps its toast until the Stop is sent or gives up.
  const TOAST_MS = 6000;
  // The toast and the sheet for the Stop and the notices, from the shell state. Paint runs every second, so the toast clears itself.
  function updateNotices() {
    if (fixtureMode) {
      setHidden(toast, true);
      setHidden(sheet, true);
      return;
    }
    const note = snapshot?.notice ?? null;
    if (note && note.seq !== nav.local.noticeSeq) {
      nav.local.noticeSeq = note.seq;
      nav.local.noticeAt = now();
    }
    const stopState = snapshot?.stop?.state ?? 'idle';
    const open = Boolean(note) && nav.local.noticeClosed !== note.seq;
    const fresh = open && (now() - (nav.local.noticeAt ?? 0) < TOAST_MS);
    const waiting = open && note.tone === 'warn' && stopState === 'queued';
    const showToast = fresh || waiting;
    setHidden(toast, !showToast);
    if (showToast) {
      toast.querySelector('.plenum-toast-text').textContent = note.text;
      toast.setAttribute('data-tone', note.tone ?? 'info');
    }
    const st = snapshot?.stop ?? null;
    setHidden(sheet, !(st?.state === 'failed' && nav.local.sheetClosed !== st.seq));
  }

  function focusTitle() {
    const title = doc.getElementById('sh-title');
    if (title) title.focus({ preventScroll: true });
  }

  // The note a page shows when the shell did not start on it (C6a): the one screen drawn in place of the rest.
  function showStartFailed() {
    if (lastId === 'start-failed') return;
    view.replaceChildren(el('div', { class: 'sh-screen sh-center', 'data-screen': 'start-failed' },
      el('main', { class: 'sh-main', id: 'sh-main' }, el('p', { class: 'sh-note', text: C2.START_FAILED }))));
    doc.body.setAttribute('data-screen', 'start-failed');
    lastId = 'start-failed';
    lastSig = '';
  }

  // The screen a null core answer falls back to: the computer list when the person asked for it, the demo home in the replay, the
  // connected stand-in (the shell's own page: /?shell, or a phone with no UI to hand over to), or the computer list when nothing is connected.
  function fallbackId(s) {
    if (nav.screen === 'computers') return 'computers';
    if (replayMode) return 'demo-home';
    if (s.activeId && s.connection?.status === 'connected' && s.hello) return 'connected';
    if (s.computers?.length) return 'computers';
    return null;
  }

  // Applies the phone's own preferences that the page shows (theme, text size, Stop side, the switcher cover). Fixtures keep the defaults.
  function applyPrefs(s) {
    if (fixtureMode || !s?.prefs) return;
    const p = s.prefs;
    if (!params.get('theme')) {
      if (p.theme === 'dark' || p.theme === 'light') applyTheme(doc, p.theme);
      else applyTheme(doc, null);
    }
    doc.documentElement.setAttribute('data-stop-side', p.stopSide === 'left' ? 'left' : 'right');
    const scale = p.textSize == null ? 1 : p.textSize / 100;
    doc.documentElement.style?.setProperty?.('--text-scale', String(scale));
  }

  function paint() {
    if (!fixtureMode) {
      snapshot = core ? core.state() : null;
      if (coreKnown && !core) {
        showStartFailed();
        return;
      }
    }
    if (!fixtureMode && snapshot) {
      // A pairing this page finished (from the link or from the paste) starts the onboarding once: the lock, then the notifications.
      if (snapshot.paired && snapshot.paired.seq > (nav.pairedSeq ?? 0)) {
        nav.pairedSeq = snapshot.paired.seq;
        nav.onboarding = lanPage(env) ? ['paired-lock'] : ['paired-lock', 'paired-notify'];
      }
      // The driving line outlives a lock, because a lock drops the hello that carries it.
      if (snapshot.hello) nav.lastDriving = snapshot.hello.pending?.driving ?? null;
      // The computer this session was connected to: its stand-in stays up while it reconnects (route.js screenFor).
      if (snapshot.hello && snapshot.activeId) nav.wasConnected = snapshot.activeId;
      if (!snapshot.activeId) nav.lastDriving = null;
      if (nav.pairingCancelled && snapshot.pairing?.state !== 'confirm') nav.pairingCancelled = false;
      // The shell's #settings or #computers link asks for a screen once per request (its seq). A request that comes while locked waits for the unlock.
      const request = snapshot.screenRequest ?? null;
      if (!snapshot.locked && request?.seq > (nav.screenSeq ?? 0)) {
        nav.screenSeq = request.seq;
        nav.stack = [];
        nav.screen = request.screen;
        nav.dismissedKey = null;
      }
      applyPrefs(snapshot);
    }
    const showingCode = fixtureMode ? demoId === 'code' : snapshot?.pairing?.state === 'confirm' && !nav.pairingCancelled;
    if (showingCode) {
      if (nav.codeSince == null) nav.codeSince = now();
      if (codeSecondsLeft(nav.codeSince, now()) === 0) nav.codeExpired = true;
    } else {
      nav.codeSince = null;
      nav.codeExpired = false;
      if (!fixtureMode) nav.forced = null;
    }
    let id;
    if (fixtureMode) {
      id = demoId;
      if (id === 'code' && nav.codeExpired) id = 'expired';
    } else if (snapshot?.locked || !snapshot) {
      id = screenFor(snapshot, nav);
    } else if (nav.screen === 'pin-set') {
      id = 'pin-set';
    } else {
      id = screenFor(snapshot, nav) ?? fallbackId(snapshot);
    }
    const ctx = fixtureMode ? fixtureCtx(id, demoOverrides) : ctxFor(snapshot, nav, env);
    if (!ctx) return;
    const isPart2 = PART2_SCREEN_BUILDERS[id] !== undefined;
    if (isPart2 && !snapshot) return;
    ctx.id = id;
    if (id !== 'scan' && scanning) stopScan();
    if (!fixtureMode) ctx.cameraDenied = Boolean(nav.local.cameraDenied);
    ctx.countdown = showingCode ? codeSecondsLeft(nav.codeSince, now()) : null;
    if (id === 'failed') ctx.stripInfo = null;
    // The messages travel in the context, so a change to one of them draws the screen again.
    ctx.bioMessage = nav.local.bioMessage ?? null;
    ctx.linkMessage = nav.local.linkMessage ?? null;
    ctx.onboardMessage = nav.local.onboardMessage ?? null;
    ctx.notifyNote = nav.local.notifyNote ?? null;
    ctx.install = fixtureMode ? null : installHint(env);
    ctx.vm = fixtureMode ? null : buildVm(snapshot, nav, env, core);

    updateChrome(ctx, id);
    if (!id) {
      view.replaceChildren();
      lastId = null;
      lastSig = '';
      doc.body.removeAttribute('data-screen');
      return;
    }
    const sig = `${id}|${signatureOf(ctx)}`;
    if (sig === lastSig && id === lastId) {
      const cd = view.querySelector('[data-countdown]');
      if (cd && ctx.countdown != null) cd.textContent = clock(ctx.countdown);
      return;
    }
    for (const t of timers) env.clearTimeout(t);
    timers.clear();
    const node = isPart2
      ? renderPart2(id, { ...ctx, id }, io)
      : renderScreen(id, { ...ctx, id }, io);
    if (node) view.replaceChildren(node);
    if (id !== lastId) focusTitle();
    lastId = id;
    lastSig = sig;
    doc.body.setAttribute('data-screen', id);
  }

  // The Stop control, the strips and the screen's own strip padding (MOBILE-UI 9.1, 9, 6.12 and 6.18).
  function updateChrome(ctx, id) {
    const locked = fixtureMode ? LOCK_IDS.includes(id) : Boolean(snapshot?.locked);
    const session = fixtureMode ? Boolean(ctx.session) : Boolean(snapshot?.activeId);
    const showStop = session && !locked;
    setHidden(stop, !showStop);
    const computer = ctx.computer || 'your computer';
    stop.setAttribute('aria-label', `Stop everything on ${computer}`);
    const state = fixtureMode ? ctx.stopState : (snapshot?.stop?.state ?? 'idle');
    stop.setAttribute('data-state', state);
    if (state === 'sending') stop.setAttribute('aria-busy', 'true');
    else stop.removeAttribute('aria-busy');
    const driving = ctx.driving ?? drivingText(snapshot?.hello?.pending?.driving);
    if (driving) {
      stop.setAttribute('data-driving', '');
      stop.setAttribute('aria-description', `A model is driving: ${driving}`);
    } else {
      stop.removeAttribute('data-driving');
      stop.removeAttribute('aria-description');
    }
    if (ctx.pending?.runs > 0 || driving || state === 'sending') stop.setAttribute('data-active', '');
    else stop.removeAttribute('data-active');
    stop.querySelector('.plenum-stop-label').textContent = STOP_LABEL[state] ?? 'Stop';
    stop.querySelector('.plenum-stop-note').textContent = (fixtureMode ? ctx.stopText : snapshot?.stop?.text) || '';
    updateNotices();

    setHidden(demoStrip, !replayMode);
    const lanOn = !fixtureMode && Boolean(ctx.lan) && !(snapshot?.prefs?.lanDismissed === true);
    setHidden(lanStrip, !lanOn);
    if (lanOn) lanStrip.querySelector('.plenum-lan-text').textContent = fill(C2.LAN_WEB_STRIP, computer);

    const info = ctx.stripInfo ?? null;
    setHidden(strip, !info);
    if (info) {
      strip.querySelector('.plenum-conn-text').textContent = info.text;
      if (info.tone === 'warn' || info.tone === 'bad') strip.setAttribute('data-tone', info.tone);
      else strip.removeAttribute('data-tone');
    }
    const stacked = replayMode || lanOn || Boolean(info);
    setHidden(stripStack, !stacked);
    if (stacked) host.setAttribute('data-strips', '');
    else host.removeAttribute('data-strips');
  }

  const fill = (text, computer) => C2.fillName(text, computer);

  // An opener's result is shown on the screen it came from, under its actions.
  function openFromScreen(result, failText) {
    nav.local.linkMessage = result.ok ? null : failText;
    paint();
    return result;
  }

  // The replay and the live core answer the same calls; the screens keep their own messages.
  function coreCall(name, ...args) {
    return call(core, name, ...args);
  }

  const actions = {
    stop: () => { if (!fixtureMode) core?.stop?.(); },
    // The sheet's Try again sends the Stop again; the sheet closes when the next result comes.
    retryStop: () => { if (!fixtureMode) core?.stop?.(); },
    dismissStopSheet: () => {
      if (snapshot?.stop) nav.local.sheetClosed = snapshot.stop.seq;
      paint();
    },
    dismissToast: () => {
      if (snapshot?.notice) nav.local.noticeClosed = snapshot.notice.seq;
      paint();
    },
    // Locks the app now (Settings and the lock screen use it): the channel closes and the keys leave memory, as the core does.
    lockNow: async () => {
      if (fixtureMode || !core?.lockNow) return { ok: false, reason: 'unavailable' };
      const out = await core.lockNow();
      paint();
      return { ok: out?.ok === true, reason: out?.reason ?? null };
    },
    tryDemo: () => { env.location?.assign?.(`${env.location.pathname}?demo=1`); },
    exitDemo: () => { env.location?.assign?.(String(env.location?.pathname ?? '/')); },
    consent: value => { nav.consentGiven = Boolean(value); },
    pair: async text => {
      if (fixtureMode) return null;
      if (replayMode) {
        nav.local.linkMessage = C2.DEMO_NO_PAIR;
        paint();
        return null;
      }
      nav.screen = null;
      nav.pairingCancelled = false;
      nav.dismissedKey = null;
      const name = cleanPhoneName(nav.local.phoneName, defaultPhoneName(platformOf(env)));
      const final = await core?.pair?.(String(text ?? ''), { name });
      if (final?.state === 'allowed') {
        nav.onboarding = lanPage(env) ? ['paired-lock'] : ['paired-lock', 'paired-notify'];
      }
      paint();
      return final;
    },
    readClipboard: setter => {
      const clipboard = env.navigator?.clipboard;
      if (!clipboard?.readText) return;
      clipboard.readText().then(text => setter(String(text ?? '')), () => {});
    },
    // Phone settings that are not in the web shell's own reach show the manual path.
    openSettings: section => {
      const result = openSettingsFlow(section);
      return openFromScreen(result, SETTINGS_MANUAL);
    },
    openLegal: name => openFromScreen(openLinkFlow(env, LEGAL_LINKS[name] ?? null), LINK_UNAVAILABLE),
    openStore: () => openFromScreen(openLinkFlow(env, STORE_LINKS[platformOf(env)] ?? null), LINK_UNAVAILABLE),
    chooseComputer: () => {
      io.go('computers');
    },
    cancelConnect: async () => {
      await coreCall('cancelConnect');
      nav.screen = null;
      nav.stack = [];
      nav.dismissedKey = stateKeyNow();
      io.go('welcome');
    },
    continueLocalNet: () => {},
    retry: () => {
      if (replayMode || !core) return;
      const s = core.state();
      // A UI pull that failed is pulled again; the connection is already up.
      if (s.ui?.state === 'failed' && s.hello) {
        core.showUi?.({ force: true });
        return;
      }
      const id = s.activeId ?? s.computers[0]?.id;
      if (id) core.connect(id);
    },
    // "Open Plenum" on the shell's own page (/?shell): the computer's UI is pulled and the page goes to it.
    openUi: () => { if (!fixtureMode && !replayMode) core?.showUi?.({ force: true }); },
    // "The codes do not match": the pairing is cancelled (a CLOSE goes to the computer), and the screen says it stopped.
    mismatch: async () => {
      if (fixtureMode) {
        io.go('mismatch');
        return;
      }
      nav.pairingCancelled = true;
      nav.screen = 'mismatch';
      nav.dismissedKey = null;
      paint();
      await coreCall('cancelPairing');
      paint();
    },
    enableLock: async mode => (fixtureMode ? { ok: true, reason: null } : enableLockFlow(core, mode)),
    enableNotifications: async () => {
      if (fixtureMode) return { ok: true, reason: null };
      const out = await enableNotificationsFlow(core);
      // B-128: another computer behind this address already holds the browser's one push subscription; the settings line says so.
      nav.local.notifyNote = out?.reason === 'other-computer' ? C.PUSH_OTHER_COMPUTER : null;
      paint();
      return out;
    },
    unlock: async (method, arg = null) => {
      if (fixtureMode || !core) return { ok: false, reason: 'demo' };
      const result = await unlockFlow(core, method, arg);
      if (method !== 'pin') {
        nav.local.bioMessage = lockMessage(method, result);
        paint();
      }
      return result;
    },
    // Unlocks with the method the lock uses, then stops everything (the stop is sent only after the unlock worked).
    unlockAndStop: async (method = 'biometric') => {
      if (fixtureMode || !core) return;
      const result = await unlockAndStopFlow(core, method);
      nav.local.bioMessage = lockMessage(method, result);
      paint();
    },
    // The pairing link that waits for review (D5): Pair starts it, Cancel drops it (C6c).
    confirmPair: async () => { await call(core, 'confirmPair'); paint(); },
    cancelPair: async () => { await call(core, 'cancelPairing'); paint(); },
    // Stop from a lock screen: sent without unlocking when this phone holds the computer's Stop key (C6c, C6f).
    stopLocked: async () => { await call(core, 'stop'); paint(); },
    forgetActive: async () => {
      if (fixtureMode || !core) return;
      const id = core.state().activeId;
      if (id) await forgetFlow(core, id);
      paint();
    },
    sendLog: () => {
      if (fixtureMode || !core?.channel) return;
      core.debug?.sendToComputer?.(core.channel.request, 60);
    },
    // "Use the copy in this app" on the failed-screens screen: the UI that is already on the phone.
    useCopy: () => { if (!fixtureMode && !replayMode) core?.useCopy?.(); },

    // ---- scanning (M7) ----
    // The pairing code is scanned with the phone's camera: the native apps use the scanner plugin (its own full-screen camera); the web
    // page uses the browser's BarcodeDetector over getUserMedia where both exist, and otherwise sends the person to the paste screen.
    // A denied camera is the scan-denied screen. Whatever is read goes to pair(), as a pasted link does.
    startScan: async videoArg => {
      if (fixtureMode || replayMode || scanning) return;
      scanning = true;
      nav.local.cameraDenied = false;
      nav.local.scanNote = null;
      const done = async result => {
        scanning = false;
        stopScan();
        if (result.ok) {
          await actions.pair(result.text);
          return;
        }
        if (result.reason === 'denied') nav.local.cameraDenied = true;
        else if (result.reason === 'cancelled') { nav.screen = nav.stack.length ? nav.stack.pop() : null; nav.dismissedKey = null; }
        else if (result.reason === 'unavailable') { nav.screen = 'paste'; nav.local.linkMessage = null; }
        else nav.local.scanNote = SCAN_FAILED;
        paint();
      };
      if (platformOf(env) !== 'web') {
        done(await (core?.scan?.() ?? { ok: false, reason: 'unavailable' }));
        return;
      }
      done(await scanWithBrowser(env, () => view.querySelector('.sh-video') ?? videoArg, stop => { scanStop = stop; }));
    },

    // ---- wave 107: computers, phone settings and the demo ----
    connect: async id => {
      if (replayMode) {
        io.go(null);
        return { ok: true, reason: null };
      }
      const result = await coreCall('connect', id);
      if (result.ok) { nav.screen = null; nav.stack = []; }
      paint();
      return result;
    },
    rename: async (id, name) => (replayMode ? { ok: false, reason: 'demo' } : coreCall('rename', id, name)),
    forget: async id => (replayMode ? { ok: false, reason: 'demo' } : forgetFlow(core, id)),
    moveWay: async (id, kind, dir) => (replayMode ? { ok: false, reason: 'demo' } : coreCall('moveWay', id, kind, dir)),
    testWays: async id => {
      if (replayMode) return { ok: false, reason: 'demo' };
      const out = await coreCall('testWays', id);
      // B-131: the button always answers: which way a connected phone is using, or that the ways are being tried.
      nav.local.waysNote = out?.reason === 'connected' ? C2.WAYS_CONNECTED(C2.WAYS_CARRIER[out.carrier] ?? 'a way') : out?.ok === true ? C2.WAYS_TRYING : null;
      paint();
      return out;
    },
    setPush: async (key, value) => {
      const patch = S.pushPatch(key, value, snapshot?.approveStored === true);
      return coreCall('setPush', patch);
    },
    setApprove: async value => coreCall('setApprove', value === true),
    testPush: async () => coreCall('testPush'),
    // Android: the system chooser for the push app UnifiedPush goes through (the settings line shows which one is chosen).
    chooseDistributor: async () => {
      const out = await coreCall('chooseDistributor');
      nav.local.notifyNote = out.ok ? null : S.unifiedPushLine(null);
      paint();
      return out;
    },
    lockOn: async mode => (fixtureMode ? { ok: true, reason: null } : enableLockFlow(core, mode)),
    lockOff: async pin => coreCall('lockOff', pin),
    setPin: async pin => coreCall('setPin', pin),
    afterPin: () => {
      // The PIN is set: the onboarding goes on (paired-notify), or the settings screen the person came from shows again.
      nav.screen = nav.stack.length ? nav.stack.pop() : null;
      if (nav.onboarding?.length) io.advance();
      else paint();
    },
    setPref: async patch => {
      if (fixtureMode) return { ok: true, reason: null };
      return coreCall('setPrefs', patch);
    },
    installApp: async () => {
      if (!deferredInstall) {
        nav.local.installNote = C2.INSTALL_NO_PROMPT;
        paint();
        return { ok: false, reason: 'unavailable' };
      }
      try {
        deferredInstall.prompt();
        const choice = await deferredInstall.userChoice;
        deferredInstall = null;
        nav.local.installNote = choice?.outcome === 'accepted' ? null : null;
        paint();
        return { ok: choice?.outcome === 'accepted', reason: choice?.outcome ?? null };
      } catch {
        nav.local.installNote = C2.INSTALL_NO_PROMPT;
        paint();
        return { ok: false, reason: 'failed' };
      }
    },
    dismissLan: () => {
      if (fixtureMode) return;
      coreCall('setPrefs', { lanDismissed: true });
    },
    debugCopy: async text => {
      const clipboard = env.navigator?.clipboard;
      if (!clipboard?.writeText) {
        nav.local.debugNote = C2.DEBUG_NO_CLIPBOARD;
      } else {
        try {
          await clipboard.writeText(String(text ?? ''));
          nav.local.debugNote = C2.DEBUG_COPIED;
        } catch {
          nav.local.debugNote = C2.DEBUG_NO_CLIPBOARD;
        }
      }
      paint();
    },
    debugSend: async () => {
      const result = fixtureMode || !core ? { ok: false, n: 0 } : await coreCall('debugSend');
      const computer = snapshot?.hello?.desktopName || snapshot?.computers?.find(c => c.id === snapshot?.activeId)?.name || 'your computer';
      nav.local.debugNote = result.ok ? C2.fillMany(C2.DEBUG_SENT, { n: result.n ?? 0, computer }) : C2.fillName(C2.DEBUG_SEND_FAILED, computer);
      paint();
      return result;
    },
    debugClear: () => { if (!fixtureMode) coreCall('debugClear'); },
    demoDecide: async (id, decision) => (replayMode ? coreCall('demoDecide', id, decision) : { ok: false, reason: 'demo' }),
    demoReset: () => { if (replayMode) coreCall('demoReset'); },
  };

  const io = {
    local: nav.local,
    act: actions,
    later,
    go: id => {
      if (fixtureMode) {
        demoOverrides = {};
        nav.codeSince = null;
        nav.codeExpired = false;
        demoId = id;
      } else {
        nav.stack.push(nav.screen);
        nav.screen = id;
        nav.forced = null;
        // A terminal screen the person just acted on stays down until the core's state changes.
        nav.dismissedKey = stateKeyNow();
        nav.local.linkMessage = null;
        nav.local.onboardMessage = null;
      }
      paint();
    },
    back: () => {
      if (fixtureMode) {
        demoId = 'welcome';
      } else {
        nav.screen = nav.stack.length ? nav.stack.pop() : null;
        nav.dismissedKey = null;
        nav.local.linkMessage = null;
      }
      paint();
    },
    advance: () => {
      if (nav.onboarding) nav.onboarding.shift();
      if (!nav.onboarding?.length) {
        nav.onboarding = null;
        // The steps after a pairing are over: the page may go to the computer's UI now (app.js holds it until here).
        core?.releaseUi?.();
      }
      nav.local.onboardMessage = null;
      paint();
    },
    repaint: () => paint(),
  };

  // The shell core is taken once, at mount (C6a). It is never read from the window. The core, or null when the shell did not start, comes
  // with the answer; live mode then subscribes to it.
  const take = typeof env.__plenumTakeShellCore === 'function' ? env.__plenumTakeShellCore : null;
  const handed = take ? take.call(env) : null;
  if (!fixtureMode && handed && typeof handed.then === 'function') {
    handed.then(
      answer => {
        core = answer ?? null;
        coreKnown = true;
        if (core) unsubscribe = core.subscribe(() => paint());
        paint();
      },
      () => {
        core = null;
        coreKnown = true;
        paint();
      });
  }

  // Hardware Back on the native apps (app.js dispatches this event from Capacitor's backButton): a screen that has somewhere to go back to goes
  // back, and the event is cancelled so the app is not left. From the first screen the event goes unhandled and the app is minimised.
  env.addEventListener?.('plenum-back', event => {
    if (fixtureMode) return;
    if (nav.stack.length || nav.screen) {
      event.preventDefault?.();
      io.back();
    }
  });

  // The install prompt, captured for the install guide (MOBILE-UI 6.12). Taken only once the page is ready to show it.
  env.addEventListener?.('beforeinstallprompt', event => {
    event.preventDefault?.();
    deferredInstall = event;
    paint();
  });

  // The app switcher shows only the mark when the switcher cover is on (6.13). The page hides its content while it is in the background.
  doc.addEventListener?.('visibilitychange', () => {
    const cover = snapshot?.prefs?.hideSwitcher === true && doc.visibilityState === 'hidden';
    if (cover) doc.documentElement.setAttribute('data-app-hidden', '');
    else doc.documentElement.removeAttribute('data-app-hidden');
  });

  // The countdown and any expiry are checked every second. The offline and online events update the strip.
  env.setInterval(() => { paint(); }, 1000);
  env.addEventListener?.('online', () => paint());
  env.addEventListener?.('offline', () => paint());
  paint();

  if (debug) {
    env.plenumScreensDebug = Object.freeze({
      ids: [...SCREEN_IDS, ...NAV_IDS],
      go(id, patch = {}) {
        if (!SCREEN_IDS.includes(id) && !NAV_IDS.includes(id)) return false;
        io.go(id);
        demoOverrides = { ...patch };
        paint();
        return lastId;
      },
      setFixture(patch = {}) {
        demoOverrides = { ...demoOverrides, ...patch };
        paint();
        return lastId;
      },
      advance(ms) {
        clockOffset += Number(ms) || 0;
        paint();
        return lastId;
      },
      current: () => lastId,
    });
  }
  return { paint, io, actions, nav, unsubscribe: () => unsubscribe?.() };
}

// The page starts the screens when this module loads in a document (screens.js).
if (typeof document !== 'undefined' && typeof window !== 'undefined' && !globalThis.__PLENUM_SCREENS_NO_AUTOSTART__) {
  try {
    mountScreens(globalThis);
  } catch (err) {
    console.error(String(err?.message ?? err));
  }
}
