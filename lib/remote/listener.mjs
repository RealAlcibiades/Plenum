// The Bridge's front door (MOBILE.json transport.bridge, desktop.listener). Owned by mob-03.
//
// Two parts that share this file:
//   createHandshaker(deps)   what happens to one connection once it is open, whatever carried it (a WebSocket here, a relay connection
//                            from lib/remote/carriers/relay.mjs): the first-message timeout, the half-open limit, the WireGuard-style
//                            DoS controls (mac1 before any DH, 10 handshakes per address and 100 in all per minute, 50 half-open,
//                            a cookie reply under load), Noise IK for known phones and IKpsk2 for a live pairing offer, the replay
//                            counter, HELLO, and the hand-over of a finished session to the multiplexer (lib/remote/proxy.mjs).
//   (Stop without unlocking: a first message of 90 bytes that starts 0x7e 0x01 is a STOP_ONLY, lib/remote/stop-only.mjs. It is signed with the
//                            device's Stop key, checked before any DH, must carry a counter that rises, and runs Stop everything. See onStopOnly.)
//   createListener(options)  the http.Server and the WebSocket upgrade: GET /p/<pathKey>/ serves the LAN web shell, an upgrade at
//                            /b/<pathKey> from an allowed Origin, Host and source address becomes a connection for the handshaker,
//                            and everything else is an empty 404.
//
// Addresses. The server always listens on 127.0.0.1:<port> (Tailscale's `serve` and the tests use it). With "Allow phones on this
// network" on it listens on the LAN hosts instead (default 0.0.0.0, and :: when the system has IPv6); the loopback address is still
// served by the wildcard. In LAN mode a source address must be private, link-local, CGNAT or loopback unless "Any address" is on; with
// LAN mode off only loopback sources are served. The bind hosts and the source-address reader are injected, so a test never binds a
// non-loopback address: a sealed test run (MOBILE_SEALED=1) refuses to bind anything but the loopback host unless
// PLENUM_TEST_REAL_LAN=1 is set (CI only).
//
// Close codes on the WebSocket before the handshake finishes (a phone cannot read a Noise CLOSE frame yet):
//   4400 protocol (malformed, replayed counter, failed mac1)   4401 unknown device or failed pairing   4403 not allowed
//   4408 timeout                                                4429 rate limit or too many waiting   4500 the Bridge could not keep the counter
//   4503 the Bridge is stopping
// After the handshake every close is a CLOSE frame { reason } inside the encrypted channel, then a normal WebSocket close.
//
// Nothing here logs a key, a token, an address, a name or a payload.
import http from 'node:http';
import net from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  NoiseError, bytesToHex, checkMac1, checkMac2, cookieReply, createCookieIssuer, deviceId, handshakeResponder, prologue, pushKey as pushKeyOf,
  sas as sasOf, splitMessage1, stopKey as stopKeyFrom,
} from './noise.mjs';
import { decodeStopOnly, encodeStopAck, isStopOnly, verifyStopOnly } from './stop-only.mjs';
import { FrameSession, MAX_PLAINTEXT, PING_INTERVAL_MS, PING_MISSES_TO_CLOSE } from './frames.mjs';
import { pathnameOf } from './tiers.mjs';
import { cleanName, APPS, PLATFORMS } from './registry.mjs';

export const CLOSE_CODES = Object.freeze({ protocol: 4400, unknown: 4401, forbidden: 4403, timeout: 4408, rate: 4429, storage: 4500, stopping: 4503 });
export const LIMITS = Object.freeze({
  perAddressPerMin: 10,
  globalPerMin: 100,
  halfOpen: 50,
  hardPerAddressPerMin: 30,
  cookiesPerAddressPerMin: 30,
  badMacPerAddressPerMin: 200,
  stopOnlyPerSourcePerMin: 20,
  firstMessageMs: 10_000,
  proofMs: 10_000,
  windowMs: 60_000,
  sessionMs: 3_600_000,
  renewGraceMs: 120_000,
  sessionMessages: 1_048_576,
  renewGraceMessages: 4096,
  maxSockets: 256,
  pingIntervalMs: PING_INTERVAL_MS,
  pingMisses: PING_MISSES_TO_CLOSE,
});
export const SHELL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const UI_COOKIE = 'plenum-ui';
const STATIC_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);
const CARRIER_BY_HOST = Object.freeze({ tailscale: 'tailscale', loopback: 'lan', lan: 'lan' });
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
});
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const HEX32 = /^[0-9a-f]{32}$/;
const VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}$/;

// ---------------------------------------------------------------------------------------------------------------------------------
// Addresses

// Lower-case, without a zone, with an IPv4-mapped IPv6 address reduced to the IPv4 address.
export function normalizeAddress(address) {
  let a = String(address ?? '').trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  return a;
}

function ipv4Parts(a) {
  return net.isIPv4(a) ? a.split('.').map(Number) : null;
}

export function isLoopbackAddress(address) {
  const a = normalizeAddress(address);
  const v4 = ipv4Parts(a);
  if (v4) return v4[0] === 127;
  return a === '::1';
}

function firstHextet(a) {
  if (a.startsWith('::')) return 0;
  const h = a.split(':')[0];
  return /^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : -1;
}

// Private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), unique-local (fc00::/7), CGNAT (100.64/10) and loopback.
export function isPrivateAddress(address) {
  const a = normalizeAddress(address);
  const v4 = ipv4Parts(a);
  if (v4) {
    const [x, y] = v4;
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (!net.isIPv6(a)) return false;
  if (a === '::1') return true;
  const h = firstHextet(a);
  return h >= 0 && ((h & 0xffc0) === 0xfe80 || (h & 0xfe00) === 0xfc00);
}

const safeEqualText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Handshake payloads

function readHandshakePayload(bytes) {
  let obj;
  try {
    obj = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.v !== 'string' || !VERSION_RE.test(obj.v)) return null;
  const device = obj.device !== null && typeof obj.device === 'object' && !Array.isArray(obj.device) ? obj.device : {};
  const caps = Array.isArray(obj.caps) ? obj.caps.filter(c => typeof c === 'string' && /^[a-z0-9-]{1,32}$/.test(c)).slice(0, 24) : [];
  return {
    major: Number(obj.v.split('.')[0]),
    kind: obj.kind === 'pair' ? 'pair' : obj.kind === 'session' || obj.kind === undefined ? 'session' : 'other',
    counter: obj.counter,
    offer: typeof obj.offer === 'string' ? obj.offer : '',
    stop: typeof obj.stop === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(obj.stop) ? obj.stop : '',
    // A phone with no Stop key of its own for this computer asks for one (C4); only a session may.
    wantStopKey: obj.kind !== 'pair' && obj.wantStopKey === true,
    caps,
    device: {
      name: cleanName(device.name, 60, 'Phone'),
      platform: PLATFORMS.includes(device.platform) ? device.platform : 'web',
      app: APPS.includes(device.app) ? device.app : 'pwa',
      appVersion: typeof device.appVersion === 'string' && /^[A-Za-z0-9._+-]{1,24}$/.test(device.appVersion) ? device.appVersion : '',
      uiHash: typeof device.uiHash === 'string' && /^[0-9a-f]{0,64}$/.test(device.uiHash) ? device.uiHash : '',
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The handshaker

/**
 * @param {object} deps
 * @param {object} deps.registry   counterOf, counterRises, idOfPublic, recordHandshake, get, touch (lib/remote/registry.mjs)
 * @param {object} deps.pairing    current, open, failure, view (lib/remote/pairing.mjs)
 * @param {() => ({ privateKey: Uint8Array, publicKey: Uint8Array } | null)} deps.identity   a copy of this computer's static key pair
 * @param {{ now(): number, setTimeout(fn: Function, ms: number): any, clearTimeout(h: any): void, setInterval(fn: Function, ms: number): any, clearInterval(h: any): void }} deps.clock   monotonic
 * @param {(ctx: { device: object, kind: string, payload: object, carrier: string, refused?: string }) => (object | Promise<object>)} deps.helloFor   builds HELLO
 * @param {(rec: object) => object} deps.makeHandlers   FrameSession handlers for a live session (lib/remote/proxy.mjs attach)
 * @param {(rec: object) => void} [deps.onSession]  a session is live (after HELLO was sent)
 * @param {(rec: object) => void} [deps.onClose]    a live session ended
 * @param {(ctx: { deviceId: string, stopId: string }) => Promise<{ cancelled: number, drivesStopped: number, agentsStopped: number, cardsDenied: number }>} [deps.onStopOnly]   runs Stop everything for a verified STOP_ONLY
 * @param {(line: string) => void} [deps.log]       a fixed sentence, never key material
 * @param {(n: number) => Uint8Array} [deps.random]
 */
export function createHandshaker(deps) {
  const {
    registry, pairing, identity, clock, helloFor, makeHandlers, onSession = () => {}, onClose = () => {}, onStopOnly: stopOnlyHook = null, log = () => {},
    limits: limitOverride = {}, random,
  } = deps;
  const limits = { ...LIMITS, ...limitOverride };
  const issuer = createCookieIssuer({ now: () => clock.now(), ...(random ? { random } : {}) });
  const handshakes = new Map(); // source -> [monotonic ms of processed handshakes]
  const cookies = new Map();
  const badMacs = new Map();
  const stopOnlys = new Map(); // source -> [monotonic ms of STOP_ONLY messages that failed shape, key or signature]; its own window, apart from the handshake ones
  const stopOnlyDevices = new Map(); // deviceId -> [monotonic ms of STOP_ONLY messages that carried a valid signature]
  let globalWindow = [];
  let halfOpen = 0;
  let nextConn = 1;
  const conns = new Set();
  let stopped = false;
  // The ephemeral public keys (the first 32 bytes of message 1) this Bridge has answered for the live pairing offer. Anyone on the
  // network can copy a message 1 and send it again; a copy is refused before any DH. The set starts again when the offer id changes.
  let answered = { id: '', keys: new Set() };
  const answeredFor = offerId => {
    if (answered.id !== offerId) answered = { id: offerId, keys: new Set() };
    return answered.keys;
  };

  const prune = (list, now) => {
    let i = 0;
    while (i < list.length && now - list[i] >= limits.windowMs) i += 1;
    return i ? list.slice(i) : list;
  };
  const touchWindow = (map, key, now, add) => {
    const list = prune(map.get(key) ?? [], now);
    if (add) list.push(now);
    if (list.length) map.set(key, list);
    else map.delete(key);
    if (map.size > 4096) for (const [k, v] of map) if (prune(v, now).length === 0) map.delete(k);
    return list.length;
  };

  function leaveHalfOpen(conn) {
    if (conn.half) {
      conn.half = false;
      halfOpen -= 1;
    }
  }

  function clearTimers(conn) {
    for (const key of ['t1', 'tProof', 'tRenew']) {
      if (conn[key] != null) clock.clearTimeout(conn[key]);
      conn[key] = null;
    }
  }

  // Ends a connection that has no encrypted channel to say goodbye in (or whose channel is already closed). Safe to call twice.
  function closeConn(conn, code, reason) {
    if (conn.phase === 'closed') return;
    const wasLive = conn.phase === 'live';
    conn.phase = 'closed';
    leaveHalfOpen(conn);
    clearTimers(conn);
    conns.delete(conn);
    try {
      conn.transport.close(code, String(reason).slice(0, 100));
    } catch {
      // The socket is gone already.
    }
    if (conn.cs) conn.cs.wipe?.();
    if (conn.attempt) conn.attempt.gone();
    if (conn.rec && (wasLive || conn.rec.opened)) {
      conn.rec.closedAt = clock.now();
      if (conn.rec.opened) {
        conn.rec.opened = false;
        try {
          onClose(conn.rec);
        } catch {
          // A listener that throws does not keep the connection open.
        }
      }
    }
  }

  // The transport the FrameSession writes to: every frame becomes one Noise transport message, one WebSocket binary message.
  function encryptedTransport(conn) {
    return {
      send(bytes) {
        const count = Number(conn.cs.send.nonce);
        if (count >= limits.sessionMessages + limits.renewGraceMessages) throw new Error('renew');
        conn.transport.send(conn.cs.send.encrypt(bytes));
      },
      close(code, reason) {
        // The FrameSession already sent its CLOSE frame; this ends the socket and releases the connection.
        const wasOpen = conn.phase !== 'closed';
        if (wasOpen) closeConn(conn, code === 1002 ? 1002 : 1000, reason);
      },
      get bufferedAmount() {
        return conn.transport.bufferedAmount;
      },
    };
  }

  function newFrames(conn, rec, handlers) {
    return new FrameSession({
      role: 'desktop',
      transport: encryptedTransport(conn),
      bufferedAmount: () => conn.transport.bufferedAmount,
      clock,
      handlers: {
        ...handlers,
        closed: reason => {
          try {
            handlers.closed?.(reason);
          } finally {
            closeConn(conn, 1000, reason ?? 'closed');
          }
        },
      },
    });
  }

  // A session lives an hour (the phone starts a new one before then); two minutes later the Bridge ends one that was not replaced.
  function armRenew(conn, rec) {
    if (conn.tRenew != null) clock.clearTimeout(conn.tRenew);
    conn.tRenew = clock.setTimeout(() => {
      conn.tRenew = null;
      if (!rec.frames.isClosed) rec.frames.close('renew');
    }, limits.sessionMs + limits.renewGraceMs);
  }

  function startLiveness(conn, rec) {
    rec.frames.startLiveness({ intervalMs: limits.pingIntervalMs, misses: limits.pingMisses });
    armRenew(conn, rec);
  }

  function goLive(conn, rec) {
    conn.phase = 'live';
    leaveHalfOpen(conn);
    rec.opened = true;
    try {
      onSession(rec);
    } catch {
      // The session still runs.
    }
  }

  // ----- message 1 -----

  async function onFirstMessage(conn, bytes) {
    const ids = identity();
    if (!ids) return closeConn(conn, CLOSE_CODES.stopping, 'not-ready');
    // Stop without unlocking: a signed STOP_ONLY is told apart by its length and first two bytes, and takes no mac1, no cookie and no DH.
    if (isStopOnly(bytes)) {
      ids.privateKey.fill(0);
      return onStopOnly(conn, bytes);
    }
    const now = clock.now();
    const addr = conn.source;
    try {
      // 1. The cheap filter: mac1 is an HMAC under a key derived from this computer's public key. No DH is spent on a message without it.
      if (!checkMac1(ids.publicKey, bytes)) {
        if (touchWindow(badMacs, addr, now, true) > limits.badMacPerAddressPerMin) return closeConn(conn, CLOSE_CODES.rate, 'rate');
        return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
      }
      // 2. Load. Under load a valid cookie (mac2) is required; without one the sender gets a cookie reply and may try again.
      const recent = touchWindow(handshakes, addr, now, false);
      globalWindow = prune(globalWindow, now);
      const underLoad = recent >= limits.perAddressPerMin || globalWindow.length >= limits.globalPerMin || halfOpen > limits.halfOpen;
      if (underLoad) {
        const cookie = issuer.cookie(addr);
        if (!checkMac2(cookie, bytes)) {
          if (touchWindow(cookies, addr, now, true) > limits.cookiesPerAddressPerMin) return closeConn(conn, CLOSE_CODES.rate, 'rate');
          conn.transport.send(cookieReply(cookie));
          return undefined; // the socket stays; the phone sends message 1 again with mac2
        }
        if (recent >= limits.hardPerAddressPerMin) return closeConn(conn, CLOSE_CODES.rate, 'rate');
      }
      touchWindow(handshakes, addr, now, true);
      globalWindow.push(now);
      // 3. The handshake itself.
      conn.phase = 'handshake';
      if (conn.t1 != null) clock.clearTimeout(conn.t1);
      conn.t1 = null;
      const body = splitMessage1(bytes).body;
      await runHandshake(conn, ids, body);
    } catch {
      closeConn(conn, CLOSE_CODES.protocol, 'protocol');
    } finally {
      ids.privateKey.fill(0);
    }
    return undefined;
  }

  // ----- Stop without unlocking -----

  // The first and only message of a socket (stop-only.mjs). Nothing here runs a DH or a cookie: a flood costs one HMAC per message and is
  // cut by its own per-source window. Steps 1 to 4 close without waiting for anything, so a message that is not signed by a Stop key this
  // computer holds never reaches the counter or the Stop. The conn leaves 'wait1' at once, so a second message on the socket is refused.
  async function onStopOnly(conn, bytes) {
    conn.phase = 'stopping';
    let key = null;
    try {
      // 1-4. Shape, key and signature come first: together they cost one HMAC, so they run for every message. Only a message that fails
      // them counts toward the per-source window (every relay phone shares the source 'relay'), so junk from someone who knows the room
      // can never use up a real phone's Stop. A signed message is limited per device instead, below.
      const now = clock.now();
      const refuse = (code, reason) => {
        if (touchWindow(stopOnlys, conn.source, now, true) > limits.stopOnlyPerSourcePerMin) return closeConn(conn, CLOSE_CODES.rate, 'rate');
        return closeConn(conn, code, reason);
      };
      const msg = decodeStopOnly(bytes);
      if (!msg) return refuse(CLOSE_CODES.protocol, 'protocol');
      if (typeof stopOnlyHook !== 'function') return closeConn(conn, CLOSE_CODES.unknown, 'unknown');
      key = registry.stopKeyOf(msg.deviceId);
      if (!key) return refuse(CLOSE_CODES.unknown, 'unknown');
      if (!verifyStopOnly(key, bytes)) return refuse(CLOSE_CODES.unknown, 'unknown');
      // A copy of a captured message has a valid signature but a counter that does not rise. Look at the counter before the per-device
      // window, without saving it: a replay counts toward the source window like junk and never toward the real phone's own window,
      // so a sniffer cannot use up the locked phone's Stop by sending copies (the LAN is plain ws://, the relay sees every message).
      if (!registry.counterRises(msg.deviceId, msg.counter)) return refuse(CLOSE_CODES.protocol, 'replay');
      // A phone that holds a real Stop key gets its own window (each one also writes the counter to disk).
      if (touchWindow(stopOnlyDevices, msg.deviceId, now, true) > limits.stopOnlyPerSourcePerMin) return closeConn(conn, CLOSE_CODES.rate, 'rate');
      // 5. Counter: the same rule as a handshake. A counter that was not kept would let the same message be played again.
      try {
        await registry.recordHandshake(msg.deviceId, msg.counter, conn.carrier);
      } catch (err) {
        return err?.status === 409 ? closeConn(conn, CLOSE_CODES.protocol, 'replay') : closeConn(conn, CLOSE_CODES.storage, 'storage');
      }
      // 6. Stop. It runs whether or not the phone is still on the line; runStop is cached by stopId, so a resend gets the same counts.
      let counts;
      try {
        counts = await stopOnlyHook({ deviceId: msg.deviceId, stopId: msg.stopId });
      } catch {
        return closeConn(conn, CLOSE_CODES.storage, 'stop');
      }
      // 7. Answer, then close.
      if (conn.phase !== 'stopping') return undefined;
      conn.transport.send(encodeStopAck({ stopKey: key, stopId: msg.stopId, counts }));
      return closeConn(conn, 1000, 'stopped');
    } catch {
      return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
    } finally {
      key?.fill(0);
    }
  }

  async function runHandshake(conn, ids, body) {
    const carrier = conn.carrier;
    // Known phones first: Noise IK with the carrier-only prologue.
    const ik = handshakeResponder({
      staticPrivate: ids.privateKey,
      prologue: prologue(carrier),
      lastCounter: pub => registry.counterOf(pub),
    });
    let payloadBytes = null;
    let responder = ik;
    let mode = 'session';
    try {
      payloadBytes = ik.readMessage1(new Uint8Array(body));
    } catch (err) {
      ik.wipe();
      if (!(err instanceof NoiseError)) return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
      if (err.code === 'UNKNOWN') return closeConn(conn, CLOSE_CODES.unknown, 'unknown');
      if (err.code === 'REPLAY' || err.code === 'PAYLOAD') return closeConn(conn, CLOSE_CODES.protocol, 'replay');
      if (err.code !== 'HANDSHAKE') return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
      // Not a known phone's message: a live pairing offer may own it.
      const offer = pairing.current();
      if (!offer) return closeConn(conn, CLOSE_CODES.unknown, 'unknown');
      // A copy of a message 1 this offer already answered is refused before any DH, and counts against nothing: the phone that sent
      // the original keeps its place in the offer.
      const seen = answeredFor(offer.id);
      const ephemeral = bytesToHex(body.subarray(0, 32));
      if (seen.has(ephemeral)) {
        offer.psk.fill(0);
        return closeConn(conn, CLOSE_CODES.protocol, 'replay');
      }
      const psk = handshakeResponder({
        staticPrivate: ids.privateKey,
        prologue: prologue(carrier, offer.id),
        psk: offer.psk,
        lastCounter: () => undefined,
      });
      offer.psk.fill(0);
      try {
        payloadBytes = psk.readMessage1(new Uint8Array(body));
      } catch {
        psk.wipe();
        pairing.failure();
        return closeConn(conn, CLOSE_CODES.unknown, 'unknown');
      }
      seen.add(ephemeral);
      responder = psk;
      mode = 'pair';
      conn.offerId = offer.id;
    }
    const payload = readHandshakePayload(payloadBytes);
    if (!payload || payload.kind === 'other' || (mode === 'pair') !== (payload.kind === 'pair')) {
      responder.wipe();
      if (mode === 'pair') pairing.failure();
      return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
    }
    if (mode === 'pair') return startPairing(conn, responder, payload);
    return startSession(conn, responder, payload);
  }

  // ----- a known phone -----

  async function startSession(conn, responder, payload) {
    const remoteStatic = responder.remoteStatic;
    const id = registry.idOfPublic(remoteStatic);
    if (!id) {
      responder.wipe();
      return closeConn(conn, CLOSE_CODES.unknown, 'unknown');
    }
    conn.phase = 'answering';
    try {
      await registry.recordHandshake(id, responder.counter, conn.carrier);
    } catch (err) {
      responder.wipe();
      return closeConn(conn, err?.status === 409 ? CLOSE_CODES.protocol : CLOSE_CODES.storage, 'storage');
    }
    if (conn.phase !== 'answering') {
      responder.wipe();
      return undefined;
    }
    const device = registry.get(id);
    if (!device) {
      responder.wipe();
      return closeConn(conn, CLOSE_CODES.unknown, 'unknown');
    }
    const refused = payload.major > 1 ? 'update-desktop' : '';
    let hello;
    try {
      hello = await helloFor({ device, kind: 'session', payload, carrier: conn.carrier, refused, stopKeyNew: payload.wantStopKey === true && !refused });
    } catch {
      responder.wipe();
      return closeConn(conn, CLOSE_CODES.storage, 'hello');
    }
    if (conn.phase !== 'answering') {
      responder.wipe();
      return undefined;
    }
    let wire;
    let session;
    try {
      const helloBytes = utf8.encode(JSON.stringify(hello));
      if (helloBytes.length > MAX_PLAINTEXT - 64) throw new Error('hello');
      wire = responder.writeMessage2(helloBytes);
      session = responder.finish();
    } catch {
      responder.wipe();
      return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
    }
    // A phone that asked for a Stop key (C4) gets this session's: both sides derive it from the same handshake hash. It is kept before
    // HELLO goes out, because HELLO tells the phone to keep its copy; a save that failed ends the attempt and the phone asks again.
    if (payload.wantStopKey === true && !refused) {
      const k = stopKeyFrom(session.handshakeHash);
      let kept = true;
      try {
        await registry.setStopKey(id, k);
      } catch {
        kept = false;
        log('phones: stop key not saved');
      } finally {
        k.fill(0);
      }
      if (!kept || conn.phase !== 'answering') {
        session.wipe?.();
        if (conn.phase === 'answering') closeConn(conn, CLOSE_CODES.storage, 'storage');
        return undefined;
      }
    }
    conn.cs = session;
    const rec = {
      id: bytesToHex(randomBytes(8)),
      device,
      deviceId: id,
      carrier: conn.carrier,
      source: conn.source,
      caps: payload.caps,
      uiHash: payload.device.uiHash,
      startedAt: clock.now(),
      pairing: false,
      frames: null,
      opened: false,
      closedAt: 0,
      lastReq: 0,
    };
    conn.rec = rec;
    const handlers = makeHandlers(rec);
    rec.frames = newFrames(conn, rec, handlers);
    conn.transport.send(wire);
    if (refused) {
      rec.frames.close(refused);
      return undefined;
    }
    goLive(conn, rec);
    startLiveness(conn, rec);
    return undefined;
  }

  // ----- a phone pairing -----

  function startPairing(conn, responder, payload) {
    const remoteStatic = responder.remoteStatic;
    if (payload.offer.length !== 32 || !HEX32.test(payload.offer) || !safeEqualText(payload.offer, conn.offerId)) {
      responder.wipe();
      pairing.failure();
      return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
    }
    const attempt = pairing.open(reason => closePairingConn(conn, reason));
    if (!attempt) {
      responder.wipe();
      return closeConn(conn, CLOSE_CODES.rate, 'busy');
    }
    conn.attempt = attempt;
    let wire;
    let session;
    try {
      wire = responder.writeMessage2(utf8.encode(JSON.stringify({ v: '1.0', state: 'confirm', deviceId: deviceId(remoteStatic) })));
      session = responder.finish();
    } catch {
      responder.wipe();
      attempt.fail();
      return closeConn(conn, CLOSE_CODES.protocol, 'protocol');
    }
    conn.cs = session;
    conn.pairData = { remoteStatic: new Uint8Array(remoteStatic), counter: responder.counter ?? payload.counter, payload };
    conn.phase = 'proof';
    conn.tProof = clock.setTimeout(() => {
      conn.tProof = null;
      if (conn.phase === 'proof') attempt.fail('timeout');
    }, limits.proofMs);
    conn.transport.send(wire);
    return undefined;
  }

  // The offer ended for this phone: CLOSE { reason } through the encrypted channel once it exists.
  function closePairingConn(conn, reason) {
    if (conn.phase === 'closed') return;
    if (conn.rec?.frames && !conn.rec.frames.isClosed) conn.rec.frames.close(reason);
    else closeConn(conn, reason === 'expired' || reason === 'timeout' ? CLOSE_CODES.timeout : CLOSE_CODES.unknown, reason);
  }

  // The phone's first transport message. It decrypts only if the phone holds the pairing secret.
  function onProofMessage(conn, bytes) {
    let plain;
    try {
      plain = conn.cs.recv.decrypt(bytes);
    } catch {
      conn.attempt.fail();
      return closeConn(conn, CLOSE_CODES.unknown, 'proof');
    }
    if (conn.tProof != null) clock.clearTimeout(conn.tProof);
    conn.tProof = null;
    const data = conn.pairData;
    const hash = conn.cs.handshakeHash;
    const code = sasOf(hash);
    const pushK = pushKeyOf(hash);
    const stopK = stopKeyFrom(hash);
    const rec = {
      id: bytesToHex(randomBytes(8)),
      device: { id: deviceId(data.remoteStatic), name: data.payload.device.name },
      deviceId: deviceId(data.remoteStatic),
      carrier: conn.carrier,
      source: conn.source,
      caps: data.payload.caps,
      uiHash: data.payload.device.uiHash,
      startedAt: clock.now(),
      pairing: true,
      frames: null,
      opened: false,
      closedAt: 0,
      lastReq: 0,
    };
    conn.rec = rec;
    // Until Allow, the phone may keep the channel alive and nothing else.
    const waiting = {
      req: () => rec.frames.close('protocol'),
      body: () => rec.frames.close('protocol'),
      stop: () => rec.frames.close('protocol'),
    };
    rec.frames = newFrames(conn, rec, waiting);
    conn.phase = 'confirm';
    rec.frames.receive(plain);
    if (rec.frames.isClosed) {
      pushK.fill(0);
      stopK.fill(0);
      return conn.attempt.fail();
    }
    const proven = conn.attempt.prove({
      code,
      device: { name: data.payload.device.name, platform: data.payload.device.platform, app: data.payload.device.app, appVersion: data.payload.device.appVersion, carrier: conn.carrier },
      publicKey: data.remoteStatic,
      counter: data.counter,
      pushKey: pushK,
      stopKey: stopK,
      onAllowed: async record => {
        if (conn.phase === 'closed' || rec.frames.isClosed) return;
        rec.device = record;
        const hello = await helloFor({ device: record, kind: 'pair', payload: data.payload, carrier: conn.carrier });
        if (conn.phase === 'closed' || rec.frames.isClosed) return;
        const real = makeHandlers(rec);
        rec.frames.handlers = {
          ...real,
          closed: reason => {
            try {
              real.closed?.(reason);
            } finally {
              closeConn(conn, 1000, reason ?? 'closed');
            }
          },
        };
        rec.frames.hello(hello);
        goLive(conn, rec);
        armRenew(conn, rec);
      },
    });
    data.remoteStatic = new Uint8Array(data.remoteStatic);
    if (!proven) {
      pushK.fill(0);
      stopK.fill(0);
      rec.frames.close('expired');
      return undefined;
    }
    leaveHalfOpen(conn);
    rec.frames.startLiveness({ intervalMs: limits.pingIntervalMs, misses: limits.pingMisses });
    return undefined;
  }

  // ----- the connection a carrier hands over -----

  /**
   * @param {{ carrier: 'lan'|'tailscale'|'relay', source: string, transport: { send(bytes: Uint8Array): void, close(code: number, reason: string): void, bufferedAmount: number } }} options
   * @returns {{ receive(bytes: Uint8Array): void, closed(): void } | null}   null when the Bridge is stopping or full
   */
  function accept({ carrier, source, transport }) {
    if (stopped) return null;
    const conn = {
      id: nextConn++, carrier, source: String(source || 'unknown'), transport, phase: 'wait1', half: true,
      t1: null, tProof: null, tRenew: null, cs: null, rec: null, attempt: null, offerId: '', pairData: null,
    };
    conns.add(conn);
    halfOpen += 1;
    conn.t1 = clock.setTimeout(() => {
      conn.t1 = null;
      if (conn.phase === 'wait1') closeConn(conn, CLOSE_CODES.timeout, 'timeout');
    }, limits.firstMessageMs);
    return {
      receive(bytes) {
        if (conn.phase === 'closed') return;
        try {
          if (conn.phase === 'wait1') {
            void onFirstMessage(conn, bytes);
          } else if (conn.phase === 'proof') {
            onProofMessage(conn, bytes);
          } else if (conn.phase === 'live' || conn.phase === 'confirm') {
            const count = Number(conn.cs.recv.nonce);
            if (count >= limits.sessionMessages + limits.renewGraceMessages) return conn.rec.frames.close('renew');
            let plain;
            try {
              plain = conn.cs.recv.decrypt(bytes);
            } catch {
              return conn.rec.frames.close('protocol');
            }
            conn.rec.frames.receive(plain);
          } else {
            closeConn(conn, CLOSE_CODES.protocol, 'protocol');
          }
        } catch {
          closeConn(conn, CLOSE_CODES.protocol, 'protocol');
        }
        return undefined;
      },
      closed() {
        if (conn.phase === 'closed') return;
        if (conn.rec?.frames && !conn.rec.frames.isClosed) {
          try {
            conn.rec.frames.close('transport');
          } catch {
            // The channel is gone; the connection is released below.
          }
        }
        closeConn(conn, 1000, 'closed');
      },
    };
  }

  // Closes every connection (the Bridge is stopping, or the key was replaced).
  function closeAll(reason = 'stopping') {
    for (const conn of [...conns]) {
      if (conn.rec?.frames && !conn.rec.frames.isClosed) conn.rec.frames.close(reason);
      else closeConn(conn, CLOSE_CODES.stopping, reason);
    }
  }

  function shutdown() {
    stopped = true;
    closeAll('stopping');
  }

  return { accept, closeAll, shutdown, halfOpen: () => halfOpen, connections: () => conns.size, limits };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The listener

function emptyNotFound(res) {
  try {
    res.writeHead(404, { 'content-length': '0', connection: 'close', 'cache-control': 'no-store' });
    res.end();
  } catch {
    res.destroy?.();
  }
}

function rejectSocket(socket) {
  try {
    socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  } catch {
    // Nothing to tell a socket that is already gone.
  }
  socket.destroy();
}

function ipLiteralHost(hostHeader, port) {
  const suffix = `:${port}`;
  if (!hostHeader.endsWith(suffix)) return false;
  const h = hostHeader.slice(0, -suffix.length);
  if (net.isIPv4(h)) return true;
  return h.startsWith('[') && h.endsWith(']') && net.isIPv6(h.slice(1, -1).split('%')[0]);
}

/**
 * @param {object} options
 * @param {ReturnType<typeof createHandshaker>} options.handshaker
 * @param {() => string} options.getPathKey         this computer's path key (changes on Remove all)
 * @param {object} options.clock                    monotonic clock (fake in tests)
 * @param {string} [options.host]                   the loopback bind host (default 127.0.0.1)
 * @param {number} [options.port]                   0 for any
 * @param {string[]} [options.lanHosts]             the hosts bound in LAN mode (default 0.0.0.0 and ::)
 * @param {(req) => string} [options.remoteAddress] the source address of a request (default the socket's)
 * @param {() => string} [options.getTailscaleName] the ts.net name, '' when there is none
 * @param {() => string[]} [options.getOrigins]     origins the active carriers add
 * @param {string|null} [options.shellRoot]         the folder served at /p/<pathKey>/ (mobile/www)
 * @param {(req, res, pathname: string) => (boolean|Promise<boolean>)} [options.uiPull]   serves the UI to a LAN page that holds the cookie
 */
export function createListener(options) {
  const {
    handshaker, getPathKey, clock, host = '127.0.0.1', port: wantPort = 0, remoteAddress = req => req.socket.remoteAddress,
    getTailscaleName = () => '', getOrigins = () => [], shellRoot = null, uiPull = null, shellCsp = SHELL_CSP,
  } = options;
  const sealed = process.env.MOBILE_SEALED === '1' && process.env.PLENUM_TEST_REAL_LAN !== '1';
  const lanHosts = sealed ? [host] : [...new Set(options.lanHosts ?? ['0.0.0.0', '::'])];
  const cookieSecret = randomBytes(32);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65535 + 64, perMessageDeflate: false, clientTracking: false });
  const sockets = new Map(); // ws -> { address }
  let servers = []; // { server, host }
  let boundPort = 0;
  let lan = { enabled: false, anyAddress: false };
  let listening = false;

  const uiCookieValue = () => createHmac('sha256', cookieSecret).update(`plenum-ui|${getPathKey()}`).digest('base64url').slice(0, 32);

  function hostKind(req) {
    const h = String(req.headers.host ?? '').toLowerCase();
    if (!h) return null;
    const ts = String(getTailscaleName() ?? '').toLowerCase();
    // F5: Tailscale's serve reaches this server from the loopback address. A ts.net Host from any other address is not Tailscale.
    if (ts && (h === ts || h === `${ts}:443`)) return isLoopbackAddress(req.socket?.remoteAddress) ? 'tailscale' : null;
    if (h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}` || h === `[::1]:${boundPort}`) return 'loopback';
    if (lan.enabled && ipLiteralHost(h, boundPort)) return 'lan';
    return null;
  }

  function addressOk(address) {
    const a = normalizeAddress(address);
    if (!a) return false;
    if (!lan.enabled) return isLoopbackAddress(a);
    if (lan.anyAddress) return true;
    return isPrivateAddress(a);
  }
  const sourceOk = req => addressOk(remoteAddress(req));

  function originOk(req, kind) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (typeof origin !== 'string') return false;
    if (STATIC_ORIGINS.has(origin)) return true;
    if (getOrigins().includes(origin)) return true;
    if ((kind === 'lan' || kind === 'loopback') && origin === `http://${req.headers.host}`) return true;
    if (kind === 'tailscale' && origin === `https://${String(req.headers.host).replace(/:443$/, '')}`) return true;
    return false;
  }

  function sourceKey(req, kind) {
    const a = normalizeAddress(remoteAddress(req));
    if (kind === 'tailscale' && isLoopbackAddress(a)) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (forwarded && forwarded.length <= 64 && /^[0-9a-fA-F:.]+$/.test(forwarded)) return `ts:${normalizeAddress(forwarded)}`;
    }
    return a;
  }

  const pathKeyOf = pathname => {
    const m = /^\/(p|b)\/([0-9a-f]{32})(\/.*)?$/.exec(pathname);
    if (!m) return null;
    const key = getPathKey();
    if (!key || !safeEqualText(m[2], key)) return null;
    return { kind: m[1], rest: m[3] ?? '' };
  };

  function hasUiCookie(req) {
    const header = String(req.headers.cookie ?? '');
    for (const part of header.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === UI_COOKIE && safeEqualText(value.join('='), uiCookieValue())) return true;
    }
    return false;
  }

  async function serveShell(req, res, rest, kind) {
    if (!shellRoot) return emptyNotFound(res);
    let rel = rest === '' || rest === '/' ? 'index.html' : rest.slice(1);
    try {
      rel = decodeURIComponent(rel);
    } catch {
      return emptyNotFound(res);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\\:]/.test(rel) || rel.split('/').some(seg => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'))) return emptyNotFound(res);
    const file = path.resolve(shellRoot, rel);
    const root = path.resolve(shellRoot) + path.sep;
    if (!file.startsWith(root)) return emptyNotFound(res);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return emptyNotFound(res);
    }
    if (!stat.isFile()) return emptyNotFound(res);
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'content-length': String(stat.size),
      'cache-control': 'no-cache',
      'content-security-policy': shellCsp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-resource-policy': 'same-origin',
    };
    if (rel === 'sw.js') headers['service-worker-allowed'] = '/';
    if (rel === 'index.html' && kind !== 'tailscale') {
      // The plain-http LAN page proves it was opened through the path key; only then may it pull the UI (uiPull).
      headers['set-cookie'] = `${UI_COOKIE}=${uiCookieValue()}; HttpOnly; SameSite=Strict; Path=/`;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }

  async function onRequest(req, res) {
    try {
      const kind = hostKind(req);
      if (!kind || !sourceOk(req)) return emptyNotFound(res);
      if (req.method !== 'GET' && req.method !== 'HEAD') return emptyNotFound(res);
      const parsed = pathnameOf(req.url);
      if (!parsed) return emptyNotFound(res);
      const hit = pathKeyOf(parsed.pathname);
      if (hit && hit.kind === 'p') {
        if (hit.rest === '') {
          res.writeHead(308, { location: `/p/${getPathKey()}/`, 'content-length': '0', 'cache-control': 'no-store' });
          return res.end();
        }
        return await serveShell(req, res, hit.rest, kind);
      }
      // The plain-http LAN page holds the cookie from the shell's index. With it, the UI document and its files are pulled from the loopback
      // server (uiPull), and the shim the UI's index tag names, /shell/<file>, is the shell's own file.
      if (!hit && kind !== 'tailscale' && hasUiCookie(req)) {
        if (parsed.pathname.startsWith('/shell/') && parsed.pathname.length > '/shell/'.length) return await serveShell(req, res, parsed.pathname.slice('/shell'.length), kind);
        if (!uiPull) return emptyNotFound(res);
        const handled = await uiPull(req, res, parsed.pathname, parsed.search);
        if (handled) return undefined;
      }
      return emptyNotFound(res);
    } catch {
      return emptyNotFound(res);
    }
  }

  function onUpgrade(req, socket, head) {
    // A reset between the request and the answer must not become an uncaught error.
    socket.on('error', () => {});
    try {
      const kind = hostKind(req);
      const parsed = pathnameOf(req.url);
      const hit = parsed && !parsed.search ? pathKeyOf(parsed.pathname) : null;
      if (!kind || !hit || hit.kind !== 'b' || hit.rest !== '' || req.method !== 'GET' || !sourceOk(req) || !originOk(req, kind) || sockets.size >= LIMITS.maxSockets) {
        return rejectSocket(socket);
      }
      const source = sourceKey(req, kind);
      const address = remoteAddress(req);
      return wss.handleUpgrade(req, socket, head, ws => adopt(ws, kind, source, address));
    } catch {
      return rejectSocket(socket);
    }
  }

  function adopt(ws, kind, source, address) {
    sockets.set(ws, { address, kind });
    ws.binaryType = 'nodebuffer';
    ws.on('error', () => {});
    const conn = handshaker.accept({
      carrier: CARRIER_BY_HOST[kind] ?? 'lan',
      source,
      transport: {
        send: bytes => ws.send(bytes, { binary: true }),
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            ws.terminate();
          }
          const t = setTimeout(() => ws.terminate(), 2000);
          t.unref?.();
        },
        get bufferedAmount() {
          return ws.bufferedAmount;
        },
      },
    });
    if (!conn) {
      sockets.delete(ws);
      ws.close(CLOSE_CODES.stopping, 'stopping');
      return;
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        ws.close(1003, 'binary');
        return;
      }
      conn.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
    ws.on('close', () => {
      sockets.delete(ws);
      conn.closed();
    });
  }

  function makeServer() {
    const server = http.createServer(onRequest);
    server.on('upgrade', onUpgrade);
    server.on('clientError', (_err, socket) => socket.destroy());
    server.on('error', () => {});
    server.headersTimeout = 10_000;
    server.requestTimeout = 20_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = 512;
    return server;
  }

  function bind(bindHost, portNumber, ipv6Only = false) {
    return new Promise((resolve, reject) => {
      const server = makeServer();
      const failed = err => reject(err);
      server.once('error', failed);
      server.listen({ host: bindHost, port: portNumber, exclusive: true, ...(net.isIPv6(bindHost) || bindHost === '::' ? { ipv6Only } : {}) }, () => {
        server.off('error', failed);
        resolve(server);
      });
    });
  }

  // Stops a server from accepting. It does not wait for its connections: a phone that is connected keeps its WebSocket, and waiting for
  // it to leave would hold a change of LAN mode for as long as the phone stays.
  const stopListening = async list => {
    for (const { server } of list) {
      try {
        server.close();
        server.closeIdleConnections?.();
      } catch {
        // Already closed.
      }
    }
    await new Promise(resolve => setImmediate(resolve));
  };

  async function start() {
    if (listening) return boundPort;
    const server = await bind(host, wantPort);
    servers = [{ server, host }];
    boundPort = server.address().port;
    listening = true;
    return boundPort;
  }

  const sameHosts = (x, y) => x.length === y.length && x.every(h => y.includes(h));

  // Binds each host in `want` on the listener's port. The first must bind; an IPv6 wildcard on a system without IPv6 is skipped.
  async function bindAll(want) {
    const fresh = [];
    try {
      for (const [i, h] of want.entries()) {
        try {
          fresh.push({ server: await bind(h, boundPort, true), host: h });
        } catch (err) {
          if (i === 0) throw err;
        }
      }
    } catch (err) {
      await stopListening(fresh);
      throw err;
    }
    return fresh;
  }

  // The phones whose source the current filter no longer allows are disconnected: turning "Allow phones on this network" off, or Any
  // address off, must not leave a phone from the network connected.
  function enforceSources() {
    for (const [ws, info] of [...sockets]) {
      if (isLoopbackAddress(info.address) || addressOk(info.address)) continue;
      try {
        ws.close(CLOSE_CODES.forbidden, 'forbidden');
      } catch {
        ws.terminate();
      }
      const t = setTimeout(() => ws.terminate(), 2000);
      t.unref?.();
    }
  }

  // Switches LAN mode. Binding changes only when the LAN hosts differ from the loopback host (a sealed test never rebinds). The new
  // servers are bound next to the old ones where the system allows it; where it does not (Windows refuses a wildcard bind while a specific
  // address holds the port) the old ones let go first, and as a last resort the connections that hold the port are dropped. If nothing
  // binds, the loopback server is restored, LAN mode is off and the error is thrown.
  async function setLan(next = {}) {
    const wasHosts = servers.map(s => s.host);
    lan = { enabled: next.enabled === true, anyAddress: next.anyAddress === true };
    if (!listening) return status();
    const want = lan.enabled ? lanHosts : [host];
    if (sameHosts(wasHosts, want)) {
      enforceSources();
      return status();
    }
    const old = servers;
    let fresh = null;
    let failure = null;
    try {
      fresh = await bindAll(want);
      await stopListening(old);
    } catch (err) {
      failure = err;
      await stopListening(old);
      servers = [];
      try {
        fresh = await bindAll(want);
      } catch (second) {
        failure = second;
        for (const ws of sockets.keys()) ws.terminate();
        await new Promise(resolve => setTimeout(resolve, 20));
        try {
          fresh = await bindAll(want);
        } catch (third) {
          failure = third;
        }
      }
    }
    if (!fresh) {
      lan = { enabled: false, anyAddress: false };
      servers = [];
      try {
        servers = [{ server: await bind(host, boundPort), host }];
      } catch {
        // Nothing listens until the next start.
      }
      throw failure;
    }
    servers = fresh;
    enforceSources();
    return status();
  }

  function status() {
    return { listening, port: boundPort, host, lan: { ...lan, hosts: servers.map(s => s.host) }, sockets: sockets.size };
  }

  async function stop() {
    listening = false;
    handshaker.shutdown();
    for (const ws of sockets.keys()) {
      try {
        ws.terminate();
      } catch {
        // Gone already.
      }
    }
    sockets.clear();
    const old = servers;
    servers = [];
    await stopListening(old);
    for (const s of old) s.server.closeAllConnections?.();
  }

  // Closes every live phone connection but keeps listening (Remove all: the key changed).
  function closeConnections(reason) {
    handshaker.closeAll(reason);
  }

  return { start, stop, setLan, status, port: () => boundPort, closeConnections, uiCookieValue, wss };
}
