// Which screen the shell shows, and what the screen is given (mob-10, wave 106; MOBILE-UI 6 and 9). Pure functions: no DOM, no
// store, no channel, no keys. main.js calls them with the shell's state (app.js shell.state()) and the router's own navigation
// record, and the Node suite calls them directly.
//
// nav (the router's record, all optional):
//   screen          the screen the person navigated to (welcome, consent, how, scan, paste, localnet, mismatch, ...)
//   forced          a screen the person chose while a pairing code is shown
//   pairingCancelled  the person pressed "The codes do not match": the code is no longer offered while the core still says confirm
//   dismissedKey    the stateKey() when the person last acted on a terminal screen (Try again, Pair again, Cancel). The terminal
//                   screen stays down until the core's state changes, so an action that moves on is not drawn back.
//   onboarding      the queue after a pairing is allowed: ['paired-lock', 'paired-notify'] (advanced by the person's choice)
//   codeSince       the wall time (ms) the code first showed; codeExpired is true after 120 s
//   uiState         'loading' | 'ui-failed' forced by a suite; the shell's own state.ui (app.js: loading, navigating, failed) does the same live
//   consentGiven    the iOS consent (6.2) was allowed on this run
//   lastDriving     the driving value seen before the lock dropped the hello (kept so the lock screens can show it)
//   local           what a screen keeps while it is open: phoneName, link, linkMessage, onboardMessage

import { ASLEEP_STRIP, CARRIER_LABEL, FAILED_LINES, FAILURE_LINES, FORWARDER_BUILD, fill } from './copy.js';
import { isLanPage } from '../device.js';

export const COUNTDOWN_S = 120;

const CARRIERS = Object.freeze(['lan', 'tailscale', 'relay']);
const STATUS_SCREENS = Object.freeze(['revoked', 'update-app', 'update-desktop']);
// The connection states of a computer that was connected and has gone away (the stand-in stays up for them).
const RECONNECT_STATES = Object.freeze(['connecting', 'reconnecting', 'offline', 'asleep']);

// What the core says now, as one string. A terminal screen the person dismissed stays dismissed while this string is the same.
export function stateKey(s) {
  return JSON.stringify([
    s?.locked === true,
    s?.pairing?.state ?? null,
    s?.pairing?.reason ?? null,
    s?.connection?.status ?? null,
    s?.activeId ?? null,
  ]);
}

// The screen the core's terminal states call for (a pairing that ended, or a connection that needs the person), or null.
function terminalScreen(s) {
  const p = s.pairing ?? null;
  if (p?.state === 'mismatch') return 'mismatch';
  if (p?.state === 'denied') return 'denied';
  if (p?.state === 'expired') return 'expired';
  if (p?.state === 'failed') return pairingFailureScreen(p.reason);
  const status = s.connection?.status ?? null;
  if (STATUS_SCREENS.includes(status)) return status;
  return null;
}

// The screen the shell shows for this state, or null when the connected phone (the desktop UI, wave 107) or a computer list
// (part 2) owns the page.
export function screenFor(s, nav = {}) {
  if (!s) return null;
  if (s.locked) return s.lock?.mode === 'pin' ? 'lock-pin' : 'lock-bio';
  const p = s.pairing ?? null;
  // A pairing link waiting for the person's Pair (D5). Checked before the code and the starting screen.
  if (p?.state === 'review') return 'pair-review';
  if (p?.state === 'confirm' && !nav.pairingCancelled) {
    if (nav.forced) return nav.forced;
    return nav.codeExpired ? 'expired' : 'code';
  }
  if (nav.pairingCancelled && nav.screen === 'mismatch') return 'mismatch';
  const dismissed = nav.dismissedKey != null && nav.dismissedKey === stateKey(s);
  if (p?.state === 'starting') return 'connecting';
  if (!dismissed) {
    const shown = terminalScreen(s);
    if (shown) return shown;
  }
  if (nav.onboarding?.length) return nav.onboarding[0];
  if (nav.uiState) return nav.uiState;
  // The UI hand-over (app.js showUi): pulling the computer's screens, the page leaving for them, or a pull that failed.
  if (s.ui?.state === 'loading' || s.ui?.state === 'navigating') return 'loading';
  if (s.ui?.state === 'failed') return 'ui-failed';
  if (!dismissed && s.activeId && !s.hello) {
    const status = s.connection?.status ?? null;
    // A computer this session was connected to keeps its stand-in while it comes back: the stand-in says it is reconnecting and the
    // strip says what is happening (MOBILE-UI 9). The pairing screens and the failed screen are for a computer not yet reached.
    if (nav.wasConnected === s.activeId && RECONNECT_STATES.includes(status)) return 'connected';
    if (status === 'connecting' || status === 'reconnecting') return 'connecting';
    if (status === 'offline' || status === 'asleep') return 'failed';
  }
  if (nav.screen === 'computers') return null;
  if (nav.screen) return nav.screen;
  if (!s.computers?.length) return 'welcome';
  return null;
}

// A failed pairing from a link (the paste screen shows why) or from the computer (the failed screen lists the ways tried).
export function pairingFailureScreen(reason) {
  if (reason === 'not-plenum' || reason === 'version' || reason === 'bad-link' || reason === 'expired') return 'paste';
  return 'failed';
}

// The paste error copy key for a failed pairing (MOBILE-UI 6.5), or null.
export function pasteError(pairing) {
  if (pairing?.state !== 'failed') return null;
  return pairing.reason === 'expired' ? 'expired' : 'not-plenum';
}

// The countdown in whole seconds left on the code, from the time the code first showed.
export function codeSecondsLeft(codeSince, now) {
  if (codeSince == null) return COUNTDOWN_S;
  const used = Math.floor((now - codeSince) / 1000);
  return Math.max(0, COUNTDOWN_S - used);
}

// The people on the phone's screens use these names. "Home PC" is the design's example; the real name comes from HELLO.
export function platformOf(env = {}) {
  const cap = env.Capacitor;
  if (cap?.isNativePlatform?.() === true) return cap.getPlatform?.() === 'android' ? 'android' : 'ios';
  return 'web';
}

// The plain-http page on the phone's own network, found by its origin (device.js: the UI document is at /, the shell's page at /p/<key>/).
export function lanPage(env = {}) {
  return isLanPage(env);
}

export function defaultPhoneName(platform) {
  if (platform === 'ios') return 'iPhone';
  if (platform === 'android') return 'Android phone';
  return 'Phone';
}

// A passkey can be offered only in a secure context where the browser has the WebAuthn constructor (MOBILE-UI 6.9).
export function passkeyAvailable(env = {}) {
  return env.isSecureContext === true && typeof env.PublicKeyCredential === 'function';
}

// The HELLO.pending.driving line: "Notepad, step 12 of 80" (MOBILE-UI 9.1). Null when nothing drives.
export function drivingText(driving) {
  if (!driving || typeof driving !== 'object') return null;
  const app = String(driving.app ?? '').trim();
  if (!app) return null;
  const step = Number(driving.step);
  const of = Number(driving.of);
  if (Number.isFinite(step) && Number.isFinite(of) && of > 0) return `${app}, step ${step} of ${of}`;
  return app;
}

// "14:02" for a last-seen time (local clock, 24 hours).
export function clockTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The connection strip (MOBILE-UI 9 table) for the shell's state, or null when no strip shows.
export function stripFor(conn, computer, env = {}) {
  if (env.navigator?.onLine === false) return { tone: 'muted', text: 'This phone is offline.' };
  const status = conn?.status ?? null;
  const when = conn?.lastSeen ? ` Last seen ${clockTime(conn.lastSeen)}.` : '';
  if (status === 'reconnecting') return { tone: 'warn', text: `Reconnecting to ${computer}…` };
  if (status === 'offline') return { tone: 'bad', text: `Can't reach ${computer}.${when}` };
  if (status === 'asleep') return { tone: 'muted', text: ASLEEP_STRIP(computer, when) };
  return null;
}

// The context a screen is drawn from. Plain data only (no functions, no keys, no tokens).
export function ctxFor(s, nav = {}, env = {}) {
  const platform = platformOf(env);
  const lan = lanPage(env);
  const hello = s?.hello ?? null;
  const active = (s?.computers ?? []).find(c => c.id === s?.activeId) ?? null;
  const computer = String(hello?.desktopName || active?.name || 'your computer');
  const conn = s?.connection ?? {};
  const pairing = s?.pairing ?? null;
  const tried = pairing?.tried ?? conn.failure?.tried ?? [];
  const driving = hello?.pending?.driving ?? nav.lastDriving ?? null;
  return {
    platform,
    lan,
    computer,
    session: Boolean(s?.activeId) || Boolean(s?.locked && s?.computers?.length),
    phoneName: nav.local?.phoneName ?? defaultPhoneName(platform),
    code: pairing?.code ?? null,
    carrier: conn.carrier ?? pairing?.carrier ?? null,
    failReason: pairing?.state === 'failed' ? (pairing.reason ?? null) : null,
    tried: (Array.isArray(tried) ? tried : []).map(t => ({ carrier: String(t?.carrier ?? t?.kind ?? ''), reason: t?.reason ?? null })),
    lock: { mode: s?.lock?.mode ?? 'off', failures: Number(s?.lock?.failures) || 0, waitSec: Number(s?.lock?.waitSec) || 0 },
    pending: hello?.pending ?? null,
    driving: drivingText(driving),
    // True while a computer this session was connected to is coming back (the stand-in says so, and no "Connected").
    reconnecting: Boolean(s?.activeId) && !hello && nav.wasConnected === s?.activeId,
    pasteError: pasteError(pairing),
    desktopVersion: hello?.desktopVersion || null,
    minVersion: conn.failure?.minimum ?? null,
    haveVersion: conn.failure?.have ?? hello?.desktopVersion ?? null,
    appVersion: env.plenumAppVersion ?? null,
    cause: s?.ui?.cause ?? nav.uiCause ?? 'checksum',
    hasCopy: Boolean(s?.ui?.hasCopy ?? nav.hasCopy),
    forwarder: FORWARDER_BUILD,
    consentGiven: Boolean(nav.consentGiven),
    passkeyAvailable: passkeyAvailable(env),
    bundled: s?.ui?.kind === 'ios',
    progress: s?.ui?.progress ?? nav.progress ?? null,
    // The shell page can open the desktop's UI ("Open Plenum") when it has a UI host; /?shell keeps the person on the shell's own screens.
    uiAvailable: Boolean(s?.ui?.kind),
    stopState: s?.stop?.state ?? 'idle',
    // The Stop result text shows only while a Stop is sending, queued, done or failed (C6d).
    stopText: ['sending', 'queued', 'done', 'failed'].includes(s?.stop?.state) ? (s.stop.text ?? '') : '',
    review: pairing?.review ?? null,
    lockStop: s?.lockStop ?? { ready: false, computerName: '' },
    storageUnavailable: s?.storage === 'unavailable',
    lockUnknown: s?.lock?.mode === 'unknown',
    stripInfo: stripFor(conn, computer, env),
    alreadyPaired: false,
    localDenied: false,
    cameraDenied: Boolean(nav.local?.cameraDenied),
    carrierLabel: CARRIER_LABEL[conn.carrier] ?? null,
    onboardMessage: nav.local?.onboardMessage ?? null,
    linkMessage: nav.local?.linkMessage ?? null,
  };
}

// The carriers the failed screen lists: the ones the QR offered, in the QR's order. With no list, all three.
export function offeredCarriers(tried) {
  const seen = [];
  for (const t of Array.isArray(tried) ? tried : []) {
    if (CARRIERS.includes(t?.carrier) && !seen.includes(t.carrier)) seen.push(t.carrier);
  }
  return seen.length ? seen : [...CARRIERS];
}

// The lines of the failed screen (MOBILE-UI 6.7), one per carrier that was offered, in the QR's order. A web page cannot open the
// same-network address, so that line says so. A reason that is not about a carrier (save, locked, worker) is the only line.
// Returns [{ kind, text }].
export function failedLines(ctx) {
  const alone = FAILURE_LINES[ctx.failReason ?? ''];
  if (alone) return [{ kind: 'reason', text: alone }];
  const notOffered = ctx.platform === 'web' && !ctx.lan;
  return offeredCarriers(ctx.tried).map(kind => {
    const reason = (ctx.tried ?? []).find(t => t.carrier === kind)?.reason ?? null;
    let text;
    if (reason === 'busy') text = FAILED_LINES.busy;
    else if (kind === 'lan') text = notOffered ? FAILED_LINES.notOffered : FAILED_LINES.lan;
    else if (kind === 'tailscale') text = FAILED_LINES.tailscale;
    else text = FAILED_LINES.relayOff;
    return { kind, text: fill(text, ctx.computer) };
  });
}
