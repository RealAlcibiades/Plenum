// Pairing: the offer state machine of MOBILE.json transport.pairing. Owned by mob-03.
//
// One offer at a time. An offer holds a 32-byte secret (the Noise IKpsk2 psk), a 16-byte id, a 120 second life on the monotonic clock
// (the injected clock, never the wall clock) and a flag that a device failed the code's proof (it never ends the offer). A phone that scans the code runs
// IKpsk2 against the Bridge; the Bridge learns that the phone holds the secret only when its first transport message decrypts, and only
// then does the offer move to 'confirm' and show the 6-digit check code. The person compares the code on the phone and on the computer and
// presses Allow or Deny at the desktop (the capture-protected window, or POST /api/phones/pair/confirm under plain node). Nothing is
// written to the registry before Allow, and the secret is wiped when the offer ends.
//
// States the view reports (the names the desktop window uses, desktop/handlers/phones.cjs SERVER_STATES):
//   idle        no offer
//   no-carrier  start() found no way for a phone to reach this computer; nothing was made
//   offer       the code is up, no phone has proved it holds the secret
//   confirm     a phone proved it; the check code and the phone's name wait for Allow or Deny
//   allowed     the phone was written to the registry and received HELLO
//   denied      the person denied (or cancelled while a phone waited): every waiting phone got CLOSE denied
//   expired     120 seconds passed: every waiting phone got CLOSE expired
//   failed3     no longer produced (three bad tries used to end the offer; now the view says tried: true and the offer stays open). Windows keep accepting it.
// A finished state (allowed, denied, expired, no-carrier) stays readable for a minute, then the view is idle again.
//
// Two phones with the same code each get their own check code; the window shows the first and says a second one used the code
// (view().second). Allow registers the one on screen and every other phone gets CLOSE denied; Deny closes them all. When the phone on screen
// goes away before an answer, the offer goes back to 'offer' with view().left true and every other waiting phone is closed (nobody is promoted
// in place): a new phone has to prove the code again.
//
// The secret appears only in the link start() returns (and link() while the offer is in 'offer') and never in a view. Nothing here logs.
import { bytesToHex, hexToBytes } from './noise.mjs';

export const OFFER_TTL_MS = 120_000;
export const MAX_ATTEMPTS = 4;
export const LINGER_MS = 60_000;
export const STATES = Object.freeze(['idle', 'no-carrier', 'offer', 'confirm', 'allowed', 'denied', 'expired', 'failed3']);
const LIVE = new Set(['offer', 'confirm']);
const MAX_LAN_URLS = 4;

const b64 = bytes => Buffer.from(bytes).toString('base64url');

// The pairing payload the QR and the link carry (MOBILE.json protocol.pairing_payload). `pub` is the hex of this computer's static key.
export function buildPayload({ name, pub, psk, offer, ttl = OFFER_TTL_MS / 1000, hints = [] }) {
  const carriers = [];
  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue;
    if (hint.kind === 'lan' && Array.isArray(hint.urls) && hint.urls.length > 0) carriers.push({ kind: 'lan', urls: hint.urls.filter(u => typeof u === 'string').slice(0, MAX_LAN_URLS) });
    else if ((hint.kind === 'tailscale' || hint.kind === 'relay') && typeof hint.url === 'string' && hint.url) carriers.push({ kind: hint.kind, url: hint.url });
  }
  return { v: 1, name: String(name ?? ''), pub: b64(hexToBytes(pub)), psk: b64(psk), offer, ttl, carriers, sas: '6' };
}

// Every form of the link. The fragment never reaches a server. `primary` is the one the QR carries: Tailscale's secure page first,
// then the LAN page, then the relay's page, then the app-only form.
export function buildLinks(payload, hints = []) {
  const fragment = b64(new TextEncoder().encode(JSON.stringify(payload)));
  const links = { native: `plenum://pair#${fragment}` };
  for (const hint of hints) {
    if (!hint || typeof hint.web !== 'string' || !hint.web || !['lan', 'tailscale', 'relay'].includes(hint.kind) || links[hint.kind]) continue;
    links[hint.kind] = `${hint.web}#pair=${fragment}`;
  }
  links.primary = links.tailscale ?? links.lan ?? links.relay ?? links.native;
  // Which link the QR carries, for the window: 'tailscale' | 'lan' | 'relay' | 'native'.
  links.primaryKind = links.tailscale ? 'tailscale' : links.lan ? 'lan' : links.relay ? 'relay' : 'native';
  return links;
}

/**
 * @param {object} options
 * @param {{ add(input: object): Promise<object>, remove(id: string): Promise<boolean> }} options.registry
 * @param {{ now(): number, setTimeout(fn: Function, ms: number): any, clearTimeout(handle: any): void }} options.clock   monotonic ms
 * @param {(n: number) => Uint8Array} options.random   returns a NEW n-byte array each call
 * @param {(view: object, change: string) => void} [options.onChange]
 */
export function createPairing({ registry, clock, random, onChange = () => {}, ttlMs = OFFER_TTL_MS, maxAttempts = MAX_ATTEMPTS, lingerMs = LINGER_MS } = {}) {
  if (!registry || !clock || typeof random !== 'function') throw new TypeError('Pairing needs a registry, a clock and a random source.');

  const cur = {
    state: 'idle', id: '', psk: null, expiresAt: 0, expireTimer: null, lingerTimer: null, failures: 0, tried: false, left: false, link: '', qrKind: 'native', name: '',
    attempts: new Set(), shown: null, device: null, seq: 0,
  };
  let nextAttempt = 1;
  let allowing = false;

  const live = () => LIVE.has(cur.state) && clock.now() < cur.expiresAt;
  const remaining = () => (LIVE.has(cur.state) ? Math.max(0, Math.ceil((cur.expiresAt - clock.now()) / 1000)) : 0);

  function view() {
    const proven = [...cur.attempts].filter(a => a.proven);
    return {
      active: LIVE.has(cur.state),
      state: cur.state,
      expiresInS: remaining(),
      ...(cur.state === 'confirm' && cur.shown ? { code: cur.shown.code, device: { ...cur.shown.device } } : {}),
      ...((cur.state === 'allowed' || cur.state === 'denied') && cur.device ? { device: { ...cur.device } } : {}),
      second: cur.state === 'confirm' && proven.length > 1,
      tried: cur.tried === true,
      left: cur.left === true,
      name: cur.name,
    };
  }

  function notify(change) {
    try {
      onChange(view(), change);
    } catch {
      // The window or the page being gone changes nothing here.
    }
  }

  function wipeSecret() {
    if (cur.psk) cur.psk.fill(0);
    cur.psk = null;
    cur.link = '';
  }

  function clearTimers() {
    if (cur.expireTimer !== null) clock.clearTimeout(cur.expireTimer);
    if (cur.lingerTimer !== null) clock.clearTimeout(cur.lingerTimer);
    cur.expireTimer = null;
    cur.lingerTimer = null;
  }

  // Closes every phone of the offer with one reason ('denied' or 'expired') and forgets them.
  function closeAttempts(reason, except = null) {
    for (const attempt of [...cur.attempts]) {
      if (attempt === except) continue;
      cur.attempts.delete(attempt);
      attempt.data?.pushKey?.fill?.(0);
      attempt.data?.stopKey?.fill?.(0);
      try {
        attempt.closeFn(reason);
      } catch {
        // The socket was already gone.
      }
    }
  }

  function finish(state, reason, { keepShown = false } = {}) {
    clearTimers();
    wipeSecret();
    closeAttempts(reason, keepShown ? cur.shown : null);
    cur.state = state;
    cur.shown = keepShown ? cur.shown : null;
    cur.lingerTimer = clock.setTimeout(() => {
      cur.lingerTimer = null;
      if (!LIVE.has(cur.state)) {
        cur.state = 'idle';
        cur.device = null;
        cur.name = '';
        notify('idle');
      }
    }, lingerMs);
    notify(state);
  }

  /**
   * Makes a new offer (the old one, if any, is ended). `hints` are the ways a phone can reach this computer (carrier hints);
   * without any, nothing is made and the state is 'no-carrier'.
   * @returns {{ ok: boolean, state: string, offer?: string, link?: string, links?: object, expiresInS?: number }}
   */
  function start({ name, pub, hints }) {
    if (LIVE.has(cur.state)) {
      clearTimers();
      wipeSecret();
      closeAttempts('denied');
    } else {
      clearTimers();
    }
    cur.failures = 0;
    cur.tried = false;
    cur.left = false;
    cur.shown = null;
    cur.device = null;
    cur.name = String(name ?? '');
    if (!Array.isArray(hints) || hints.length === 0) {
      cur.state = 'no-carrier';
      cur.lingerTimer = clock.setTimeout(() => {
        cur.lingerTimer = null;
        if (cur.state === 'no-carrier') {
          cur.state = 'idle';
          notify('idle');
        }
      }, lingerMs);
      notify('no-carrier');
      return { ok: false, state: 'no-carrier' };
    }
    cur.seq += 1;
    cur.id = bytesToHex(random(16));
    cur.psk = random(32);
    cur.expiresAt = clock.now() + ttlMs;
    const payload = buildPayload({ name: cur.name, pub, psk: cur.psk, offer: cur.id, ttl: Math.round(ttlMs / 1000), hints });
    const links = buildLinks(payload, hints);
    cur.link = links.primary;
    cur.qrKind = links.primaryKind;
    cur.state = 'offer';
    cur.expireTimer = clock.setTimeout(() => {
      cur.expireTimer = null;
      if (LIVE.has(cur.state)) finish('expired', 'expired');
    }, ttlMs);
    notify('offer');
    return { ok: true, state: 'offer', offer: cur.id, link: links.primary, links, expiresInS: remaining() };
  }

  // The offer the Bridge answers handshakes with: { id, psk } (a copy the handshake wipes), or null when there is none.
  function current() {
    if (!live() || !cur.psk) return null;
    return { id: cur.id, psk: new Uint8Array(cur.psk) };
  }

  // The link while the code is up (Copy link), else ''.
  const link = () => (cur.state === 'offer' ? cur.link : '');
  const offerId = () => (LIVE.has(cur.state) ? cur.id : '');

  // A handshake that failed the code's proof. It is told to the window (tried) and never ends the offer: anyone who can reach the
  // listener could otherwise kill an offer with three bad messages. The handshake rate limits still apply.
  function failure() {
    if (!live()) return;
    cur.failures += 1;
    cur.tried = true;
    notify('failure');
  }

  /**
   * A phone ran IKpsk2 with the right offer and the Bridge answered message 2. Returns a handle, or null when the offer is gone or too
   * many phones are waiting. The handle is told what happened to its socket.
   * @param {(reason: string) => void} closeFn   closes that phone's session with CLOSE { reason }
   */
  function open(closeFn) {
    if (!live() || cur.attempts.size >= maxAttempts) return null;
    const attempt = { id: nextAttempt++, closeFn, proven: false, code: '', device: null, data: null, seq: cur.seq };
    cur.attempts.add(attempt);
    return Object.freeze({
      // The phone's first transport message decrypted: it holds the secret. `info`: { code, device, publicKey, counter, pushKey, stopKey, onAllowed }.
      prove(info) {
        if (!cur.attempts.has(attempt) || !live() || attempt.seq !== cur.seq) return false;
        attempt.proven = true;
        attempt.code = info.code;
        attempt.device = info.device;
        attempt.data = info;
        if (!cur.shown) {
          cur.shown = attempt;
          cur.state = 'confirm';
          cur.left = false;
        }
        notify('proven');
        return true;
      },
      // The phone failed to prove it (bad first message, no first message in time): counts against the offer.
      fail(reason = 'denied') {
        if (cur.attempts.delete(attempt)) {
          try {
            attempt.closeFn(reason);
          } catch {
            // Already closed.
          }
          failure();
        }
      },
      // The socket went away without a verdict: forget the phone; the offer lives on. When it was the phone on screen, the other waiting
      // phones are closed and nobody is promoted in place: the offer is back to 'offer' (left: true) and a phone has to prove the code again.
      gone() {
        if (!cur.attempts.delete(attempt)) return;
        // An Allow that is saving this phone right now still reads its keys; allowShown wipes them when it is done.
        if (!allowing) {
          attempt.data?.pushKey?.fill?.(0);
          attempt.data?.stopKey?.fill?.(0);
        }
        if (cur.shown === attempt) {
          cur.shown = null;
          closeAttempts('denied');
          if (cur.state === 'confirm') {
            cur.state = 'offer';
            cur.left = true;
          }
        }
        notify('gone');
      },
    });
  }

  /**
   * Allow: the phone on screen is written to the registry and receives HELLO; every other phone gets CLOSE denied.
   * @returns {Promise<{ ok: boolean, error?: string, status?: number, device?: object }>}
   */
  async function allow() {
    if (cur.state !== 'confirm' || !cur.shown || !live()) return { ok: false, status: 409, error: 'There is no phone waiting to be allowed.' };
    // A second click while the first is being saved changes nothing.
    if (allowing) return { ok: false, status: 409, error: 'That phone is already being allowed.' };
    allowing = true;
    try {
      return await allowShown();
    } finally {
      allowing = false;
    }
  }

  async function allowShown() {
    const attempt = cur.shown;
    const info = attempt.data;
    const seq = cur.seq;
    const existed = typeof registry.idOfPublic === 'function' ? registry.idOfPublic(info.publicKey) !== null : false;
    let record;
    try {
      record = await registry.add({
        publicKey: info.publicKey,
        name: info.device.name,
        platform: info.device.platform,
        app: info.device.app,
        appVersion: info.device.appVersion,
        counter: info.counter,
        carrier: info.device.carrier,
        pushKey: info.pushKey,
        stopKey: info.stopKey,
      });
    } catch (err) {
      return { ok: false, status: err?.status ?? 500, error: String(err?.message ?? 'The phone could not be saved.') };
    }
    if (cur.seq !== seq || cur.state !== 'confirm' || cur.shown !== attempt) {
      // The offer ended while the registry was saving: a phone that was new is not kept (one that was already paired stays as it was).
      if (!existed) {
        try {
          await registry.remove(record.id);
        } catch {
          // The registry reports its own storage trouble elsewhere.
        }
      }
      info.pushKey?.fill?.(0);
      info.stopKey?.fill?.(0);
      return { ok: false, status: 409, error: 'The code ended before the phone was allowed.' };
    }
    info.pushKey?.fill?.(0);
    info.stopKey?.fill?.(0);
    cur.device = { name: record.name, platform: record.platform, app: record.app, carrier: info.device.carrier };
    cur.attempts.delete(attempt);
    finish('allowed', 'denied');
    try {
      await info.onAllowed(record);
    } catch {
      // The phone's socket went away; the phone is paired all the same and connects again.
    }
    return { ok: true, device: record };
  }

  // Deny: the phone on screen and every other phone get CLOSE denied, the secret is wiped.
  function deny() {
    if (cur.state !== 'confirm') return { ok: false, status: 409, error: 'There is no phone waiting to be denied.' };
    cur.device = cur.shown?.device ? { ...cur.shown.device } : null;
    finish('denied', 'denied');
    return { ok: true };
  }

  // Cancel the offer (the window's Cancel, or the Add phone row's Cancel). A waiting phone gets CLOSE denied.
  function cancel() {
    if (!LIVE.has(cur.state)) return { ok: true, state: cur.state };
    clearTimers();
    wipeSecret();
    closeAttempts('denied');
    cur.state = 'idle';
    cur.shown = null;
    notify('cancelled');
    return { ok: true, state: 'idle' };
  }

  // Forget a finished state at once (the window was closed).
  function dismiss() {
    if (LIVE.has(cur.state)) return;
    clearTimers();
    cur.state = 'idle';
    cur.device = null;
    notify('idle');
  }

  // Ends everything without a word (the Bridge is stopping).
  function shutdown() {
    clearTimers();
    wipeSecret();
    closeAttempts('expired');
    cur.state = 'idle';
    cur.shown = null;
  }

  // Which link the QR shows ('tailscale' | 'lan' | 'relay' | 'native') and the public key of the phone on screen (not a secret), for the window.
  const qrKind = () => cur.qrKind;
  const shownPublicKey = () => (cur.state === 'confirm' && cur.shown?.data?.publicKey ? new Uint8Array(cur.shown.data.publicKey) : null);

  return { start, current, link, offerId, qrKind, shownPublicKey, failure, open, allow, deny, cancel, dismiss, shutdown, view, live: () => live(), maxAttempts };
}
