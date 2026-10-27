// The phone channel (mob-10, wave 104). One Web Worker owns the WebSocket, the Noise session and the frame session for one
// computer, or runs one pairing. The page never touches the socket: channel.js (the page contract) talks to this worker
// with the plain messages listed below, and only this file runs Noise. Built by scripts/build-mobile.mjs (esbuild, module
// worker, lib/remote/noise.mjs and frames.mjs bundled in). The core is pure: createChannelCore takes its socket class,
// clock and post function, so the Node suites drive it on a fake clock against a fake desktop.
//
// Page -> worker (op):
//   init         { computer: { id, name, desktopPub, myPriv, carriers, lastCarrier, counter }, device, caps, hasStopKey }   Uint8Array keys
//   request      { sid, method, path, headers, scope?, body? } body: Uint8Array, transferred. scope 'page' (default) or 'shell': the request
//                                                              policy below is enforced here, not in the page
//   cancel       { sid }
//   stop         { sid, project? }                             STOP with a 16-byte id; queued and retried for 60 s
//   stopLocked   { sid, computer: { id, deviceId, stopKey, carriers, lastCarrier, counter } }   Stop without unlocking: one signed STOP_ONLY
//                                                              on a fresh socket (lib/remote/stop-only.mjs); no Noise session is opened
//   reconnect    {}                                            an immediate attempt (app resume, visibility)
//   pair         { payload, device, caps, extraUrls? }         the pairing link's payload; keys are made here
//   pairCancel   {}                                            the codes did not match: CLOSE mismatch
//   counterSaved { rid, ok, counter }                          the page stored the raised counter
//   close        {}
// Worker -> page (op):
//   state        { state }                                     status, carrier, desktopName, lastSeen, since, nextRetryAt, failure
//   hello        { hello }                                     the desktop's HELLO payload (no keys)
//   event        { event }                                     EVENT frames from the desktop
//   res          { sid, status, headers }
//   data         { sid, bytes }                                ArrayBuffer, transferred
//   end          { sid, error?, cancelled? }
//   stopState    { sid, state }                                'sending' | 'sent' | 'queued'
//   stopAck      { sid, ack } | { sid, error }                 ack: { id, cancelled, drivesStopped, agentsStopped, cardsDenied };
//                                                              error: 'unreachable' | 'closed', and for stopLocked 'unknown'
//   counter      { rid, id, minimum }                          the page must store a counter >= minimum before any handshake
//   patch        { id, patch }                                 lastCarrier, lastSeen; stopKey and myDeviceId when HELLO said stopKeyNew
//   pairState    { state, code?, tried?, reason? }             state: confirm | allowed | denied | expired | mismatch | failed
//   paired       { computer }                                  pairing allowed: the new record, keys included (page store only)
//   log          { line }
//
// The keys: myPriv and desktopPub arrive as bytes and never leave this worker except in 'paired', which the page saves into
// its own store and nowhere else. The Stop key (noise.mjs stopKey) leaves it twice, to the same store: in 'paired', and in a 'patch' when the
// computer's HELLO says stopKeyNew. Nothing in a state or event message carries a key, a token, a psk or a nonce. The private key and the
// psk are zeroed once pairing is over, and a closed channel zeroes its private key.
//
// The request policy (the page is not trusted to keep it; MOBILE.json client_model): a 'page' request keeps the headers accept, content-type
// and x-plenum-client-id and never reaches a /_bridge/ path. A 'shell' request (the shell's own calls) may also send x-plenum-notify-line and
// POST /_bridge/log and /_bridge/ui-manifest. A path that does not start with '/', has a backslash or a '..' segment, or does not decode
// ends 'refused'.
//
// Rules this file keeps (MOBILE.json transport and client_model):
//   - The counter is raised and stored BEFORE every handshake; no handshake is sent until the page confirms the store.
//   - IK for a known computer (one round trip per connect); IKpsk2 only while pairing, with the offer's psk.
//   - Reconnect after a drop: 1, 2, 4, 8, then 10 s, trying the carrier used last, then the others.
//   - Three failed rounds: 'offline'. A relay CLOSE host-offline: 'asleep'. Revoked, update-app and update-desktop stop retries.
//   - Three rounds in which every carrier closes with 4401 (the computer does not know this phone, e.g. removed while it was away):
//     'not-known', which the screens show as revoked. Retried every 60 s and never given up: the close code is not authenticated.
//   - STOP: the same 16-byte id is sent until its STOP_ACK arrives, on every reconnect, for 60 s at most.
//   - A session renews after 1 h or 2^20 messages, whether or not streams are open: a new IK handshake carries new requests at
//     once, and the old socket keeps the streams it has for up to 60 s (RENEW_DRAIN_MS), then closes.
//   - Liveness: PING every 25 s, closed after 2 misses.

import {
  NoiseError, bytesToHex, deviceId, generateKeyPair, handshakeInitiator, parseCookieReply, prologue, pushKey, sas, sealMessage1, stopKey,
} from '../../lib/remote/noise.mjs';
import { FrameSession, systemClock } from '../../lib/remote/frames.mjs';
import { decodeStopAck, encodeStopOnly } from '../../lib/remote/stop-only.mjs';
import { carrierUrlOk, usableCarriers } from './carriers.js';

export const PROTOCOL = '1.0';
export const DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000]);
export const RETRY_CAP_MS = 10000;
export const OFFLINE_ROUNDS = 3;
export const CONNECT_TIMEOUT_MS = 6000;
export const HANDSHAKE_TIMEOUT_MS = 6000;
export const COUNTER_TIMEOUT_MS = 10000;
export const STOP_WINDOW_MS = 60000;
export const STOP_RESEND_MS = 8000;
export const RENEW_AFTER_MS = 3600000;
export const RENEW_AFTER_MESSAGES = 1048576;
export const RENEW_CHECK_MS = 60000;
export const RENEW_DRAIN_MS = 60000;
export const NOT_KNOWN_ROUNDS = 3;
export const NOT_KNOWN_RETRY_MS = 60000;
export const PING_INTERVAL_MS = 25000;
export const PING_MISSES = 2;
export const DEFAULT_CAPS = Object.freeze(['ui-from-desktop', 'artifacts-iframe', 'push-none', 'share', 'save']);
const CARRIERS = Object.freeze(['lan', 'tailscale', 'relay']);
export const STOP_ONLY_WAIT_MS = 6000;
export const MAX_SOCKET_MESSAGE = 65535 + 64;
const PAGE_HEADERS = Object.freeze(['accept', 'content-type', 'x-plenum-client-id']);
const SHELL_HEADERS = Object.freeze([...PAGE_HEADERS, 'x-plenum-notify-line']);
const SHELL_BRIDGE_PATHS = Object.freeze(['/_bridge/log', '/_bridge/ui-manifest']);
const TERMINAL = Object.freeze(['revoked', 'update-app', 'update-desktop', 'closed']);

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

export function b64uToBytes(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function defaultRandom(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function asKey(value) {
  const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : null;
  if (!bytes || bytes.byteLength !== 32) throw new TypeError('key length');
  return new Uint8Array(bytes);
}

// The short name a failure gets in the state and the pairing list. Never the message of a Noise error (those are fixed sentences
// anyway) and never a key.
// The close codes the listener sends before any Noise session exists (lib/remote/listener.mjs CLOSE_CODES). They are not
// authenticated, so they only choose the retry rule; they never end the retries.
const CLOSE_CODE_FAILURES = Object.freeze({ 4400: 'replay', 4401: 'unknown', 4429: 'rate' });
const CODED_FAILURES = Object.freeze(['unknown', 'replay', 'rate']);

function closeCodeError(err, sock) {
  const name = CLOSE_CODE_FAILURES[sock.closed?.code];
  if (!name) return err;
  const coded = new Error('closed');
  coded.code = name;
  return coded;
}

function failureName(err) {
  if (CODED_FAILURES.includes(err?.code)) return err.code;
  if (err instanceof NoiseError) return 'handshake';
  const text = String(err?.message ?? err ?? '');
  if (/timeout|timed out/i.test(text)) return 'timeout';
  if (/closed|close/i.test(text)) return 'closed';
  if (/counter/i.test(text)) return 'counter';
  return 'error';
}

// One WebSocket as a socket with a queue: messages are read with next() before the handshake ends and handed to onMessage after.
export function openSocket(WebSocketImpl, url, { clock, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let openTimer = null;
    let ws = null;
    let closeInfo = null;
    let handler = null;
    let onCloseFn = null;
    let waiter = null;
    const queue = [];
    const fail = err => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(openTimer);
      reject(err);
    };
    const sock = {
      get bufferedAmount() { return ws?.bufferedAmount ?? 0; },
      get closed() { return closeInfo; },
      send(bytes) { ws.send(bytes); },
      close(code, reason) {
        try { ws?.close(code, reason); } catch { /* already closed */ }
      },
      set onMessage(fn) {
        handler = fn;
        while (handler && queue.length) handler(queue.shift());
      },
      set onClose(fn) {
        onCloseFn = fn;
        if (closeInfo) fn(closeInfo);
      },
      next(ms = HANDSHAKE_TIMEOUT_MS) {
        if (queue.length) return Promise.resolve(queue.shift());
        if (closeInfo) return Promise.reject(new Error('closed'));
        return new Promise((res, rej) => {
          const t = clock.setTimeout(() => { waiter = null; rej(new Error('timeout')); }, ms);
          waiter = {
            resolve: value => { clock.clearTimeout(t); res(value); },
            reject: err => { clock.clearTimeout(t); rej(err); },
          };
        });
      },
    };
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      fail(err);
      return;
    }
    ws.binaryType = 'arraybuffer';
    openTimer = clock.setTimeout(() => {
      fail(new Error('connect timeout'));
      try { ws.close(); } catch { /* not open */ }
    }, timeoutMs);
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(openTimer);
      resolve(sock);
    });
    ws.addEventListener('message', event => {
      // The size is checked before anything is allocated for the message.
      const size = event.data?.byteLength ?? 0;
      if (size > MAX_SOCKET_MESSAGE) {
        try { ws.close(1009, 'too-big'); } catch { /* already closed */ }
        return;
      }
      const bytes = new Uint8Array(event.data);
      if (handler) handler(bytes);
      else if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve(bytes);
      } else queue.push(bytes);
    });
    ws.addEventListener('close', event => {
      closeInfo = { code: event.code, reason: event.reason ?? '' };
      if (!settled) fail(new Error('closed before open'));
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(new Error('closed'));
      }
      onCloseFn?.(closeInfo);
    });
    ws.addEventListener('error', () => { /* a close event follows */ });
  });
}

// The request policy. Returns { path, headers } for a request the worker may send, or null when it is refused.
export function requestPolicy(msg) {
  const scope = msg?.scope === 'shell' ? 'shell' : 'page';
  const path = String(msg?.path || '/');
  let pathname;
  try {
    if (!path.startsWith('/') || path.includes('\\')) return null;
    const probe = new URL(path, 'https://x');
    if (probe.origin !== 'https://x') return null;
    const rawPath = decodeURIComponent(path.split(/[?#]/, 1)[0]);
    if (rawPath.includes('\\') || rawPath.split('/').includes('..')) return null;
    pathname = decodeURIComponent(probe.pathname);
  } catch {
    return null;
  }
  if (pathname.toLowerCase().startsWith('/_bridge/') && !(scope === 'shell' && SHELL_BRIDGE_PATHS.includes(pathname))) return null;
  const allowed = scope === 'shell' ? SHELL_HEADERS : PAGE_HEADERS;
  const headers = {};
  if (msg?.headers && typeof msg.headers === 'object') {
    for (const [key, value] of Object.entries(msg.headers)) {
      const name = String(key).toLowerCase();
      if (allowed.includes(name)) headers[name] = String(value);
    }
  }
  return { path, headers };
}

// The worker core. Every collaborator is injected: post(message, transfer), the socket class, the clock and a random source.
export function createChannelCore(options = {}) {
  const post = options.post;
  if (typeof post !== 'function') throw new TypeError('createChannelCore needs post(message, transfer)');
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const clock = options.clock ?? systemClock();
  const random = options.random ?? defaultRandom;

  let computer = null; // { id, name, desktopPub, myPriv, carriers, lastCarrier, counter, device, caps }
  let phase = 'idle';
  let session = null;
  let desktopName = '';
  let lastSeen = null;
  let since = clock.now();
  let failedRounds = 0;
  let retryTimer = null;
  let nextRetryAt = null;
  let attempting = false;
  let renewTimer = null;
  let lastFailure = null;
  let closedByPage = false;
  let pairing = null;
  let ridSeq = 0;
  const rids = new Map();
  const pendingStops = new Map();
  const draining = new Set();   // sessions renewed away whose open streams are still running
  let unknownRounds = 0;        // consecutive rounds in which every carrier closed with 4401

  const transition = next => {
    if (next !== phase) {
      phase = next;
      since = clock.now();
    }
  };

  const snapshot = () => ({
    status: phase,
    carrier: session?.carrier ?? null,
    desktopName,
    lastSeen,
    since,
    nextRetryAt,
    failedRounds,
    failure: lastFailure,
    computerId: computer?.id ?? null,
    stopsPending: pendingStops.size,
  });
  const emitState = () => post({ op: 'state', state: snapshot() });

  // ----- the counter: raised and stored before any handshake -----

  function counterRequest(id, minimum) {
    return new Promise((resolve, reject) => {
      const rid = ++ridSeq;
      const timer = clock.setTimeout(() => {
        rids.delete(rid);
        reject(new Error('counter not saved'));
      }, COUNTER_TIMEOUT_MS);
      rids.set(rid, {
        resolve: value => { clock.clearTimeout(timer); resolve(value); },
        reject: err => { clock.clearTimeout(timer); reject(err); },
      });
      post({ op: 'counter', rid, id, minimum });
    });
  }

  async function raiseCounter(id, current) {
    const answer = await counterRequest(id, current + 1);
    if (!answer || answer.ok !== true || !Number.isSafeInteger(answer.counter) || answer.counter <= current) {
      throw new Error('counter not saved');
    }
    return answer.counter;
  }

  // ----- one handshake over one socket -----

  // opts: { remotePub, myPriv, psk, offer, payloadFor() -> Promise<payload> }. The payload is built (and the counter stored) only
  // after the socket is open, and before message 1 is written.
  async function handshake(kind, url, opts) {
    const sock = await openSocket(WebSocketImpl, url, { clock });
    try {
      const payload = await opts.payloadFor();
      const hs = handshakeInitiator({
        staticPrivate: opts.myPriv,
        remoteStaticPublic: opts.remotePub,
        prologue: prologue(kind, opts.offer ?? null),
        ...(opts.psk ? { psk: opts.psk } : {}),
      });
      const body = hs.writeMessage1(utf8.encode(JSON.stringify(payload)));
      sock.send(sealMessage1(opts.remotePub, body));
      let reply = await sock.next(HANDSHAKE_TIMEOUT_MS);
      const cookie = parseCookieReply(reply);
      if (cookie) {
        sock.send(sealMessage1(opts.remotePub, body, cookie));
        reply = await sock.next(HANDSHAKE_TIMEOUT_MS);
      }
      const message2 = hs.readMessage2(reply);
      const cs = hs.finish();
      return { sock, cs, message2 };
    } catch (err) {
      sock.close(1000, 'handshake');
      throw closeCodeError(err, sock);
    }
  }

  function makeSession({ sock, cs, kind, url }) {
    const s = {
      kind,
      url,
      carrier: kind,
      sock,
      cs,
      frames: null,
      sidOf: new Map(),
      streamOf: new Map(),
      messages: 0,
      startedAt: clock.now(),
      closed: false,
      retired: false,
      drainTimer: null,
      hello: null,
    };
    s.frames = new FrameSession({
      role: 'phone',
      clock,
      transport: {
        send: bytes => {
          s.messages += 1;
          try { sock.send(cs.send.encrypt(bytes)); } catch { /* the socket is gone; the close path follows */ }
        },
        close: (code, reason) => sock.close(code, reason),
      },
      bufferedAmount: () => sock.bufferedAmount,
      handlers: {
        hello: value => onSessionHello(s, value),
        res: (id, value, fin) => onRes(s, id, value, fin),
        data: (id, bytes, fin) => onData(s, id, bytes, fin),
        event: value => onEvent(s, value),
        stopAck: value => onStopAck(value),
        close: value => onPeerClose(s, value),
        abort: id => endStream(s, id, null, true),
        closed: reason => onSessionClosed(s, reason),
      },
    });
    sock.onMessage = bytes => {
      let plain;
      try {
        plain = cs.recv.decrypt(bytes);
      } catch {
        s.frames.close('protocol');
        return;
      }
      s.messages += 1;
      s.frames.receive(plain);
    };
    sock.onClose = () => {
      if (!s.frames.isClosed) s.frames.close('transport');
    };
    return s;
  }

  // ----- streams -----

  function onRes(s, id, value, fin) {
    const sid = s.sidOf.get(id);
    if (sid === undefined) return;
    post({ op: 'res', sid, status: Number(value?.status) || 0, headers: value?.headers ?? {} });
    if (fin) endStream(s, id, null, false);
  }

  function onData(s, id, bytes, fin) {
    const sid = s.sidOf.get(id);
    if (sid === undefined) return;
    if (bytes && bytes.byteLength) {
      const copy = new Uint8Array(bytes);
      post({ op: 'data', sid, bytes: copy.buffer }, [copy.buffer]);
    }
    if (fin) endStream(s, id, null, false);
  }

  function endStream(s, id, error, cancelled) {
    const sid = s.sidOf.get(id);
    if (sid === undefined) return;
    s.sidOf.delete(id);
    s.streamOf.delete(sid);
    post({ op: 'end', sid, error, cancelled });
    if (draining.has(s) && s.sidOf.size === 0) drainOld(s);
  }

  function startRequest(msg) {
    const sid = msg.sid;
    const policy = requestPolicy(msg);
    if (!policy) {
      post({ op: 'end', sid, error: 'refused', cancelled: false });
      return;
    }
    const s = session;
    if (!s || phase !== 'connected') {
      post({ op: 'end', sid, error: 'offline', cancelled: false });
      return;
    }
    const body = msg.body ? new Uint8Array(msg.body) : null;
    const value = {
      method: String(msg.method || 'GET').toUpperCase(),
      path: policy.path,
      headers: policy.headers,
      ...(body ? { bodyLength: body.byteLength } : {}),
    };
    const id = s.frames.request(value, { fin: !body });
    if (id === null) {
      post({ op: 'end', sid, error: 'busy', cancelled: false });
      return;
    }
    s.sidOf.set(id, sid);
    s.streamOf.set(sid, id);
    if (body) s.frames.body(id, body, { fin: true });
  }

  // A stream may still run on a session that was renewed away, so both are looked at.
  function cancelRequest(sid) {
    for (const s of [session, ...draining]) {
      const id = s?.streamOf.get(sid);
      if (id !== undefined) {
        s.frames.cancel(id);
        return;
      }
    }
  }

  // ----- events, HELLO and close -----

  function onSessionHello(s, value) {
    if (pairing && pairing.session === s) pairing.resolve?.({ ok: true, hello: value });
  }

  function onEvent(s, value) {
    post({ op: 'event', event: value });
    if (value && value.type === 'phone' && value.kind === 'revoked') {
      transition('revoked');
      emitState();
      s.frames.close('revoked');
    }
  }

  function onPeerClose(s, value) {
    const reason = typeof value?.reason === 'string' ? value.reason.slice(0, 64) : 'peer';
    if (pairing && pairing.session === s) {
      pairing.resolve?.({ ok: false, reason: pairing.cancelled ?? reason });
      return;
    }
    lastFailure = reason;
    if (reason === 'revoked') transition('revoked');
    else if (reason === 'update-desktop') transition('update-desktop');
    else if (reason === 'host-offline') transition('asleep');
    emitState();
  }

  function onSessionClosed(s, reason) {
    if (s.closed) return;
    s.closed = true;
    if (s.retired) return;
    if (pairing && pairing.session === s) {
      pairing.resolve?.({ ok: false, reason: pairing.cancelled ?? `closed:${reason}` });
      return;
    }
    for (const id of Array.from(s.sidOf.keys())) endStream(s, id, 'lost', false);
    draining.delete(s);
    // A drained session that drops does not touch the session that carries on; only the current one starts a retry.
    if (session !== s) {
      emitState();
      return;
    }
    session = null;
    lastSeen = clock.now();
    for (const entry of pendingStops.values()) post({ op: 'stopState', sid: entry.sid, state: 'queued' });
    lastFailure = String(reason ?? 'lost');
    if (closedByPage) {
      emitState();
      return;
    }
    if (TERMINAL.includes(phase)) {
      emitState();
      return;
    }
    failedRounds = 0;
    scheduleRetry();
  }

  // ----- connecting, retrying, adopting a session -----

  // The carriers of the computer, every URL, the carrier used last first.
  function carrierCandidates(comp) {
    const out = [];
    for (const c of usableCarriers(comp.carriers)) {
      for (const url of c.urls) out.push({ kind: c.kind, url });
    }
    return [...out.filter(c => c.kind === comp.lastCarrier), ...out.filter(c => c.kind !== comp.lastCarrier)];
  }

  function clearRetry() {
    clock.clearTimeout(retryTimer);
    retryTimer = null;
    nextRetryAt = null;
  }

  function scheduleRetry() {
    if (closedByPage || !computer || TERMINAL.includes(phase)) return;
    clearRetry();
    const slow = phase === 'not-known';
    const delay = slow ? NOT_KNOWN_RETRY_MS : (DELAYS_MS[failedRounds] ?? RETRY_CAP_MS);
    nextRetryAt = clock.now() + delay;
    if (phase !== 'asleep' && !slow) transition(failedRounds >= OFFLINE_ROUNDS ? 'offline' : 'reconnecting');
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      nextRetryAt = null;
      attempt().catch(() => {});
    }, delay);
    emitState();
  }

  async function connectSession(candidate, comp) {
    const { sock, cs, message2 } = await handshake(candidate.kind, candidate.url, {
      remotePub: comp.desktopPub,
      myPriv: comp.myPriv,
      psk: null,
      offer: null,
      payloadFor: async () => {
        const counter = await raiseCounter(comp.id, comp.counter);
        comp.counter = counter;
        return { v: PROTOCOL, kind: 'session', counter, device: comp.device, caps: comp.caps, ...(comp.hasStopKey ? {} : { wantStopKey: true }) };
      },
    });
    const s = makeSession({ sock, cs, kind: candidate.kind, url: candidate.url });
    try {
      s.hello = JSON.parse(utf8Decode.decode(message2));
    } catch {
      sock.close(1002, 'hello');
      throw new Error('handshake: HELLO is not JSON');
    }
    return s;
  }

  async function attempt() {
    if (attempting || closedByPage || !computer || session || TERMINAL.includes(phase)) return;
    attempting = true;
    try {
      const candidates = carrierCandidates(computer);
      if (!candidates.length) {
        lastFailure = 'no-carrier';
        unknownRounds = 0;
        failedRounds += 1;
        scheduleRetry();
        return;
      }
      const reasons = [];
      for (const candidate of candidates) {
        if (closedByPage || TERMINAL.includes(phase)) return;
        try {
          const s = await connectSession(candidate, computer);
          adopt(s);
          return;
        } catch (err) {
          lastFailure = failureName(err);
          reasons.push(lastFailure);
        }
      }
      // Every carrier answered 4401 in this round: the computer does not know this phone (removed while the phone was away).
      unknownRounds = reasons.length > 0 && reasons.every(r => r === 'unknown') ? unknownRounds + 1 : 0;
      failedRounds += 1;
      if (unknownRounds >= NOT_KNOWN_ROUNDS) transition('not-known');
      else if (phase === 'not-known') transition('reconnecting');
      scheduleRetry();
    } finally {
      attempting = false;
    }
  }

  function adopt(s) {
    session = s;
    failedRounds = 0;
    unknownRounds = 0;
    nextRetryAt = null;
    lastFailure = null;
    lastSeen = clock.now();
    desktopName = String(s.hello?.desktopName ?? desktopName).slice(0, 60);
    const major = s.hello?.protocol?.major;
    if (major !== 1) {
      // The phase is set before the close, so the close path sees a terminal state and does not retry.
      transition(major > 1 ? 'update-app' : 'update-desktop');
      s.frames.close(major > 1 ? 'update-app' : 'update-desktop');
      emitState();
      return;
    }
    transition('connected');
    computer.lastCarrier = s.carrier;
    topUpStopKey(s);
    post({ op: 'hello', hello: s.hello });
    post({ op: 'patch', id: computer.id, patch: { lastCarrier: s.carrier, lastSeen } });
    s.frames.startLiveness({ intervalMs: PING_INTERVAL_MS, misses: PING_MISSES });
    for (const entry of pendingStops.values()) sendStop(entry);
    scheduleRenewCheck(RENEW_CHECK_MS);
    emitState();
  }

  // The computer says stopKeyNew when this phone asked for a Stop key (wantStopKey) and the computer stored one made from this session's
  // handshake hash: the phone makes the same key and keeps it in its record with its own id there. The page's store saves it (op 'patch').
  function topUpStopKey(s) {
    if (s.hello?.stopKeyNew !== true || !computer) return;
    const k = stopKey(s.cs.handshakeHash);
    post({ op: 'patch', id: computer.id, patch: { stopKey: bytesToB64u(k), myDeviceId: String(s.hello.deviceId ?? '') } });
    k.fill(0);
    computer.hasStopKey = true;
  }

  function reconnectNow() {
    if (!computer || closedByPage || session || attempting || TERMINAL.includes(phase)) return;
    clearRetry();
    attempt().catch(() => {});
  }

  // ----- session renewal -----

  function scheduleRenewCheck(delay) {
    clock.clearTimeout(renewTimer);
    renewTimer = clock.setTimeout(() => {
      renewTimer = null;
      maybeRenew();
    }, delay);
  }

  function maybeRenew() {
    const s = session;
    if (!s || closedByPage || phase !== 'connected') return;
    const due = clock.now() - s.startedAt >= RENEW_AFTER_MS || s.messages >= RENEW_AFTER_MESSAGES;
    if (!due) {
      scheduleRenewCheck(RENEW_CHECK_MS);
      return;
    }
    renew(s);
  }

  // A new IK handshake becomes the session for new requests at once, whether or not streams are open (the page keeps its event
  // stream open for the life of the page, so waiting for idle would never renew). The old session keeps the streams it carries
  // and closes when they have ended, or after RENEW_DRAIN_MS.
  async function renew(old) {
    let made = null;
    try {
      const { sock, cs, message2 } = await handshake(old.kind, old.url, {
        remotePub: computer.desktopPub,
        myPriv: computer.myPriv,
        psk: null,
        offer: null,
        payloadFor: async () => {
          const counter = await raiseCounter(computer.id, computer.counter);
          computer.counter = counter;
          return { v: PROTOCOL, kind: 'session', counter, device: computer.device, caps: computer.caps, ...(computer.hasStopKey ? {} : { wantStopKey: true }) };
        },
      });
      made = makeSession({ sock, cs, kind: old.kind, url: old.url });
      made.hello = JSON.parse(utf8Decode.decode(message2));
      topUpStopKey(made);
      if (session !== old || closedByPage || made.hello?.protocol?.major !== 1) {
        made.retired = true;
        made.frames.close('normal');
        scheduleRenewCheck(RENEW_CHECK_MS);
        return;
      }
      session = made;
      draining.add(old);
      made.frames.startLiveness({ intervalMs: PING_INTERVAL_MS, misses: PING_MISSES });
      if (old.sidOf.size === 0) drainOld(old);
      else old.drainTimer = clock.setTimeout(() => drainOld(old), RENEW_DRAIN_MS);
      post({ op: 'hello', hello: made.hello });
      scheduleRenewCheck(RENEW_CHECK_MS);
      emitState();
    } catch {
      if (made && made !== session) {
        made.retired = true;
        made.frames.close('normal');
      }
      scheduleRenewCheck(RENEW_CHECK_MS);
    }
  }

  // Closes a session that was renewed away. Streams still open on it end as 'lost' (the page asks again), then the socket closes.
  function drainOld(old) {
    if (old.retired) return;
    old.retired = true;
    clock.clearTimeout(old.drainTimer);
    old.drainTimer = null;
    draining.delete(old);
    for (const id of Array.from(old.sidOf.keys())) endStream(old, id, 'lost', false);
    old.frames.close('renewed');
  }

  // ----- STOP -----

  function sendStop(entry) {
    if (!session || phase !== 'connected' || !pendingStops.has(entry.id)) {
      post({ op: 'stopState', sid: entry.sid, state: 'queued' });
      return;
    }
    const payload = { id: entry.id, ...(entry.project ? { project: entry.project } : {}) };
    const sent = session.frames.stop(payload);
    post({ op: 'stopState', sid: entry.sid, state: sent ? 'sent' : 'queued' });
    clock.clearTimeout(entry.resend);
    entry.resend = clock.setTimeout(() => {
      entry.resend = null;
      if (pendingStops.has(entry.id)) sendStop(entry);
    }, STOP_RESEND_MS);
  }

  function clearStop(entry) {
    pendingStops.delete(entry.id);
    clock.clearTimeout(entry.resend);
    clock.clearTimeout(entry.expire);
  }

  function startStop({ sid, project }) {
    const id = bytesToHex(random(16));
    const entry = { id, sid, project: typeof project === 'string' && project ? project : null, resend: null, expire: null };
    pendingStops.set(id, entry);
    entry.expire = clock.setTimeout(() => {
      if (!pendingStops.has(entry.id)) return;
      clearStop(entry);
      post({ op: 'stopAck', sid: entry.sid, error: 'unreachable' });
      emitState();
    }, STOP_WINDOW_MS);
    sendStop(entry);
    // A Stop pressed while the phone is away does not wait for the retry timer: it tries to reconnect now.
    if (!session) reconnectNow();
    emitState();
  }

  function onStopAck(value) {
    const entry = pendingStops.get(value?.id);
    if (!entry) return;
    clearStop(entry);
    const count = key => (Number.isSafeInteger(value[key]) ? value[key] : 0);
    post({
      op: 'stopAck',
      sid: entry.sid,
      ack: {
        id: entry.id,
        cancelled: count('cancelled'),
        drivesStopped: count('drivesStopped'),
        agentsStopped: count('agentsStopped'),
        cardsDenied: count('cardsDenied'),
      },
    });
    emitState();
  }

  // ----- Stop without unlocking (plan C3, the phone's half) -----

  // One signed STOP_ONLY per try, on a fresh socket for each carrier URL: carriers in carrierCandidates order, the counter raised and stored
  // before every send (as for a handshake), the same stopId on every resend. A verified STOP_ONLY_ACK ends the press with the counts. A round in
  // which every URL closed with 4401 ends it 'unknown' (the computer does not know this phone's Stop key). Any other round ends with 'queued'
  // and the next round starts STOP_RESEND_MS later; STOP_WINDOW_MS after the press it ends 'unreachable'. No Noise session is ever opened and
  // the Stop key is zeroed at the end.
  async function stopLocked(msg) {
    const sid = msg.sid;
    const c = msg.computer && typeof msg.computer === 'object' ? msg.computer : {};
    let key;
    try {
      key = asKey(c.stopKey);
      if (typeof c.id !== 'string' || !c.id || !/^[0-9a-f]{64}$/.test(String(c.deviceId ?? ''))) throw new TypeError('record');
    } catch {
      post({ op: 'stopAck', sid, error: 'no-key' });
      return;
    }
    const comp = {
      id: c.id,
      carriers: Array.isArray(c.carriers) ? c.carriers : [],
      lastCarrier: typeof c.lastCarrier === 'string' ? c.lastCarrier : null,
    };
    let counter = Number.isSafeInteger(c.counter) && c.counter >= 0 ? c.counter : 0;
    const stopId = random(16);
    let done = false;
    let windowTimer = null;
    let sleepTimer = null;
    let wake = null;
    let activeSock = null;
    const finish = detail => {
      if (done) return;
      done = true;
      clock.clearTimeout(windowTimer);
      clock.clearTimeout(sleepTimer);
      try { activeSock?.close(1000, 'stopped'); } catch { /* already closed */ }
      activeSock = null;
      key.fill(0);
      post({ op: 'stopAck', sid, ...detail });
      wake?.();
    };
    const sleep = ms => new Promise(resolve => {
      wake = resolve;
      sleepTimer = clock.setTimeout(resolve, ms);
    });
    windowTimer = clock.setTimeout(() => finish({ error: 'unreachable' }), STOP_WINDOW_MS);
    post({ op: 'stopState', sid, state: 'sending' });
    while (!done) {
      const candidates = carrierCandidates(comp);
      let unknown = candidates.length > 0;
      for (const candidate of candidates) {
        if (done) return;
        let sock = null;
        try {
          counter = await raiseCounter(comp.id, counter);
          if (done) return;
          sock = await openSocket(WebSocketImpl, candidate.url, { clock });
          activeSock = sock;
          if (done) {
            sock.close(1000, 'stopped');
            return;
          }
          sock.send(encodeStopOnly({ stopKey: key, deviceId: c.deviceId, counter, stopId }));
          const first = await sock.next(STOP_ONLY_WAIT_MS);
          if (done) return;
          const ack = decodeStopAck(key, first, stopId);
          sock.close(1000, 'done');
          activeSock = null;
          if (ack) {
            finish({ ack: { id: bytesToHex(stopId), ...ack } });
            return;
          }
          unknown = false;
        } catch {
          if (sock) sock.close(1000, 'stop');
          activeSock = null;
          if (done) return;
          if (sock?.closed?.code !== 4401) unknown = false;
        }
      }
      if (done) return;
      if (unknown) {
        finish({ error: 'unknown' });
        return;
      }
      post({ op: 'stopState', sid, state: 'queued' });
      await sleep(STOP_RESEND_MS);
    }
  }

  // ----- pairing (IKpsk2 with the offer's psk; nothing is stored until the person allowed it at the computer) -----

  // The pairing link's carriers and the page's own address, only the URLs that pass the carrier rules (carriers.js).
  function pairCandidates(payload, extraUrls) {
    const out = [];
    for (const url of extraUrls ?? []) if (url && typeof url.url === 'string' && carrierUrlOk(url.kind, url.url)) out.push({ kind: url.kind, url: url.url });
    for (const c of usableCarriers(payload.carriers)) {
      for (const url of c.urls) out.push({ kind: c.kind, url });
    }
    return out;
  }

  function waitPairOutcome(ms) {
    return new Promise(resolve => {
      const timer = clock.setTimeout(() => resolve({ ok: false, reason: 'expired' }), Math.max(0, ms));
      pairing.resolve = value => {
        clock.clearTimeout(timer);
        resolve(value);
      };
    });
  }

  function finishPairing(detail) {
    const current = pairing;
    pairing = null;
    current?.psk?.fill(0);
    current?.keys?.privateKey?.fill(0);
    if (current?.session && !current.session.closed) {
      current.session.retired = true;
      current.session.frames.close('normal');
    }
    post({ op: 'pairState', ...detail });
  }

  async function startPairing(msg) {
    if (pairing || computer) {
      post({ op: 'pairState', state: 'failed', reason: 'busy' });
      return;
    }
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    let pub;
    let psk;
    let offer;
    try {
      pub = asKey(b64uToBytes(payload.pub));
      psk = asKey(b64uToBytes(payload.psk));
      offer = String(payload.offer ?? '');
      if (!/^[0-9a-f]{32}$/.test(offer)) throw new TypeError('offer');
    } catch {
      post({ op: 'pairState', state: 'failed', reason: 'bad-link' });
      return;
    }
    const keys = generateKeyPair(options.random);
    const id = deviceId(pub);
    const ttlMs = (Number(payload.ttl) > 0 ? Math.min(Number(payload.ttl), 600) : 120) * 1000;
    const deadline = clock.now() + ttlMs;
    pairing = { id, keys, psk, session: null, resolve: null, tried: [], cancelled: null, active: true };
    const candidates = pairCandidates(payload, msg.extraUrls);
    if (!candidates.length) {
      finishPairing({ state: 'failed', tried: [], reason: 'no-carrier' });
      return;
    }
    for (const candidate of candidates) {
      if (!pairing || !pairing.active) return;
      if (clock.now() >= deadline) break;
      let pairCounter = 0;
      try {
        const { sock, cs, message2 } = await handshake(candidate.kind, candidate.url, {
          remotePub: pub,
          myPriv: keys.privateKey,
          psk,
          offer,
          payloadFor: async () => {
            pairCounter = await raiseCounter(id, 0);
            return { v: PROTOCOL, kind: 'pair', counter: pairCounter, offer, device: msg.device ?? {}, caps: msg.caps ?? DEFAULT_CAPS };
          },
        });
        if (!pairing) { sock.close(); return; }
        const reply = JSON.parse(utf8Decode.decode(message2));
        if (reply?.state !== 'confirm') {
          sock.close(1002, 'pairing');
          throw new Error('pairing: no confirm');
        }
        const s = makeSession({ sock, cs, kind: candidate.kind, url: candidate.url });
        pairing.session = s;
        post({ op: 'pairState', state: 'confirm', code: sas(cs.handshakeHash) });
        // The first transport message (a PING) is what proves to the computer that this phone holds the psk.
        s.frames.startLiveness({ intervalMs: PING_INTERVAL_MS, misses: PING_MISSES });
        const outcome = await waitPairOutcome(deadline - clock.now());
        if (outcome.ok) {
          const name = String(outcome.hello?.desktopName ?? payload.name ?? '').slice(0, 60);
          const record = {
            id,
            name,
            desktopPub: bytesToB64u(pub),
            myPriv: bytesToB64u(keys.privateKey),
            counter: pairCounter,
            carriers: usableCarriers(payload.carriers),
            lastCarrier: candidate.kind,
            lastSeen: clock.now(),
            pairedAt: clock.now(),
            pushKey: bytesToB64u(pushKey(cs.handshakeHash)),
            stopKey: bytesToB64u(stopKey(cs.handshakeHash)),
            myDeviceId: deviceId(keys.publicKey),
          };
          s.retired = true;
          const done = pairing;
          pairing = null;
          post({ op: 'paired', computer: record });
          // The record has gone to the page's store; this worker keeps neither key.
          keys.privateKey.fill(0);
          psk.fill(0);
          s.frames.close('normal');
          done.active = false;
          post({ op: 'pairState', state: 'allowed', computerId: id });
          return;
        }
        const reason = String(outcome.reason ?? 'closed');
        const state = /denied/.test(reason) ? 'denied' : /expired/.test(reason) ? 'expired' : /mismatch/.test(reason) ? 'mismatch' : 'failed';
        finishPairing({ state, reason: state === 'failed' ? reason : undefined });
        return;
      } catch (err) {
        if (!pairing) return;
        pairing.tried.push({ carrier: candidate.kind, reason: failureName(err) });
      }
    }
    if (pairing) finishPairing({ state: clock.now() >= deadline ? 'expired' : 'failed', tried: pairing.tried });
  }

  function cancelPairing() {
    if (!pairing) return;
    pairing.cancelled = 'mismatch';
    if (pairing.session && !pairing.session.closed) pairing.session.frames.close('mismatch');
    else {
      const current = pairing;
      pairing = null;
      current.active = false;
      post({ op: 'pairState', state: 'mismatch' });
    }
  }

  // ----- init, close and the dispatcher -----

  function init(msg) {
    if (computer) return;
    const c = msg.computer && typeof msg.computer === 'object' ? msg.computer : {};
    try {
      computer = {
        id: String(c.id ?? ''),
        name: String(c.name ?? ''),
        desktopPub: asKey(c.desktopPub),
        myPriv: asKey(c.myPriv),
        carriers: Array.isArray(c.carriers) ? c.carriers : [],
        lastCarrier: typeof c.lastCarrier === 'string' ? c.lastCarrier : null,
        counter: Number.isSafeInteger(c.counter) && c.counter >= 0 ? c.counter : 0,
        device: msg.device && typeof msg.device === 'object' ? msg.device : {},
        caps: Array.isArray(msg.caps) ? msg.caps : DEFAULT_CAPS,
        hasStopKey: msg.hasStopKey === true,
      };
    } catch {
      computer = null;
      transition('failed');
      lastFailure = 'bad-computer';
      emitState();
      return;
    }
    transition('connecting');
    emitState();
    attempt().catch(() => {});
  }

  function closeChannel() {
    if (closedByPage) return;
    closedByPage = true;
    clearRetry();
    clock.clearTimeout(renewTimer);
    renewTimer = null;
    for (const entry of Array.from(pendingStops.values())) {
      clearStop(entry);
      post({ op: 'stopAck', sid: entry.sid, error: 'closed' });
    }
    if (pairing) cancelPairing();
    for (const old of Array.from(draining)) drainOld(old);
    const s = session;
    session = null;
    if (s && !s.closed) s.frames.close('normal');
    transition('closed');
    computer?.myPriv?.fill(0);
    emitState();
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    try {
      switch (msg.op) {
        case 'init': return init(msg);
        case 'pair': return void startPairing(msg).catch(() => {
          pairing = null;
          post({ op: 'pairState', state: 'failed', reason: 'error' });
        });
        case 'request': return startRequest(msg);
        case 'cancel': return cancelRequest(msg.sid);
        case 'stop': return startStop(msg);
        case 'stopLocked': return void stopLocked(msg).catch(() => post({ op: 'stopAck', sid: msg.sid, error: 'unreachable' }));
        case 'reconnect': return reconnectNow();
        case 'pairCancel': return cancelPairing();
        case 'counterSaved': {
          const waiter = rids.get(msg.rid);
          if (waiter) {
            rids.delete(msg.rid);
            waiter.resolve(msg);
          }
          return undefined;
        }
        case 'close': return closeChannel();
        default: return undefined;
      }
    } catch (err) {
      post({ op: 'log', line: `worker: ${failureName(err)}` });
      return undefined;
    }
  }

  return {
    handle,
    snapshot,
    get phase() { return phase; },
    get session() { return session; },
  };
}

// Inside a dedicated worker, wire the core to the page. Nothing runs in Node or on the main thread.
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
if (inWorker) {
  const core = createChannelCore({
    post: (message, transfer = []) => self.postMessage(message, transfer),
    WebSocketImpl: globalThis.WebSocket,
  });
  self.onmessage = event => core.handle(event.data);
}
