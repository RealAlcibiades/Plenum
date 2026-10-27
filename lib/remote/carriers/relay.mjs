// The relay carrier (MOBILE.json desktop.new_files, lib/remote/carriers/relay.mjs; relay envelope in protocol.carriage; feature mob-04).
// Owned by mob-04.
//
// The desktop connects OUT to the user's relay (the Worker in the user's own Cloudflare account, relay/): a WebSocket to /room/<roomId>
// with the headers x-plenum-role: host and x-plenum-host-secret, opened with Node's global WebSocket. The room forwards phone frames with
// a 4-byte big-endian connection id in front of each frame it gives this host (relay/src/room.mjs). This module demultiplexes on that id:
// one handshake per phone connection (listener.mjs createHandshaker, carrier 'relay'), so the Noise session, the frames and STOP are the
// same bytes as on the LAN. Frames to a phone go back with the same id; the id 0 is control, JSON in the frame (host to room: rotate, kick; room to host: open, a phone joined and the room passed its address; closed, a phone's socket went away).
//
// Failures. A dropped host socket reconnects after about half a second, doubling to 30 s on repeated failure. A room taken by another
// host (close 4003) waits 60 s before the next try. A refused host secret (HTTP 403 on the upgrade) is reported as 'refused', found by a
// plain HTTP probe of the same upgrade that never completes a connection. When this host goes, the room itself closes every phone with
// 4001 'host-offline'; this module does not kick them one by one.
//
// Rotation. A registry 'reset' that keeps the room changes only the host secret: an open socket tells the room the new SHA-256 hash
// ('rotate' control); a socket that is down presents the old secret once more and rotates on its next open.
// A new room. Remove all (registry 'reset') and New room (registry 'relay-room') change the room id as well. The host socket to the old room
// is closed (no 'rotate' and no 'kick': that room is abandoned) and the carrier connects to the new room with the new host secret.
//
// The host secret travels only as a header and in the registry. It is never in a URL, a status, an error or a log. Status and hints carry
// the relay's origin and the room's wss:// address (which the pairing QR carries anyway), never the secret.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const CONTROL = 0;
const OPEN = 1;
const ROOM_RE = /^[0-9a-f]{32}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{22,128}$/;
export const FIRST_RETRY_MS = 500;
export const MAX_RETRY_MS = 30_000;
export const REPLACED_WAIT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const CLOSE_REPLACED = 4003;
const CLOSE_HOST_OFFLINE = 4001;
// The address the room passes for a joining phone (cf-connecting-ip, as text), and how many unclaimed ones a session keeps (a phone that joins
// and is closed by the room before its first frame is never reported, so the oldest entry goes first).
const ADDRESS_RE = /^[0-9a-f:.]{2,45}$/;
const MAX_ADDRESSES = 256;

export const sha256Hex = value => createHash('sha256').update(String(value), 'utf8').digest('hex');

// The relay address the user typed: https (or wss) for the Worker, or http/ws on this computer's loopback when a test allows it.
// Returns { origin, wsBase, basePath } or null. The Worker's routes sit at /room/<id> under an optional path prefix.
export function parseRelayUrl(text, { allowLoopbackHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const plain = (url.protocol === 'http:' || url.protocol === 'ws:') && loopback && allowLoopbackHttp;
  if (!secure && !plain) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.hostname || url.hostname.length > 253) return null;
  const basePath = url.pathname.replace(/\/+$/, '');
  return {
    origin: `${secure ? 'https:' : 'http:'}//${url.host}`,
    wsBase: `${secure ? 'wss:' : 'ws:'}//${url.host}`,
    basePath,
  };
}

// The wait before the next try after `attempt` failures in a row: 0.5 s, 1 s, 2 s ... to 30 s, each with +-25% jitter.
export function backoffFor(attempt, random = Math.random) {
  const base = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
}

// The HTTP status of an upgrade request to the room, without completing it. 101 means the room accepted (and the probe drops that socket
// at once); 403 means the room refused the secret; 0 means no answer. Used only after a socket failed before it opened.
export function probeUpgrade(url, headers = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve(0);
      return;
    }
    const secure = target.protocol === 'wss:' || target.protocol === 'https:';
    const transport = secure ? https : http;
    const req = transport.request({
      protocol: secure ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
      timeout: timeoutMs,
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

/**
 * @param {object} [options]
 * @param {typeof WebSocket} [options.WebSocket]     the WebSocket class (default the global one, Node 24)
 * @param {boolean} [options.allowLoopbackHttp]      tests only: accept http:// and ws:// on loopback (the Settings route accepts https only)
 * @param {(url, headers, ms) => Promise<number>} [options.probe]   the refusal probe (default probeUpgrade)
 * @param {() => number} [options.random]
 */
export function createRelayCarrier(options = {}) {
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const probe = options.probe ?? probeUpgrade;
  const random = options.random ?? Math.random;
  let ctx = null;
  let session = null; // see newSession
  let unsubscribe = null;
  let link = { connected: false, reason: '' };
  let queue = Promise.resolve();

  const serial = fn => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function newSession(cfg, roomId, secret) {
    return {
      cfg,
      roomId,
      url: `${cfg.wsBase}${cfg.basePath}/room/${roomId}`,
      secret,
      pending: null, // { old, next } when the secret rotated while the socket was down
      ws: null,
      opened: false,
      conns: new Map(), // connection id -> { handshake, transport }
      addrs: new Map(), // connection id -> the phone's address, from the room's 'open' control, until its first frame opens the connection
      attempt: 0,
      timer: null,
      closed: false,
      dropping: false,
    };
  }

  const headersFor = secret => ({ 'x-plenum-role': 'host', 'x-plenum-host-secret': secret });

  function setLink(connected, reason = '') {
    link = { connected, reason: connected ? '' : String(reason).slice(0, 40) };
  }

  function clearTimer(s) {
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = null;
  }

  function scheduleRetry(s, ms) {
    if (s.closed) return;
    clearTimer(s);
    s.timer = setTimeout(() => {
      s.timer = null;
      connect(s);
    }, ms);
    s.timer.unref?.();
  }

  function sendFrame(s, conn, bytes) {
    const ws = s.ws;
    if (!ws || ws.readyState !== OPEN) return;
    const framed = new Uint8Array(4 + bytes.byteLength);
    new DataView(framed.buffer).setUint32(0, conn, false);
    framed.set(bytes, 4);
    try {
      ws.send(framed);
    } catch {
      // The socket is going; its close event does the cleanup.
    }
  }

  function sendControl(s, op) {
    const ws = s.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    const body = new TextEncoder().encode(JSON.stringify(op));
    const framed = new Uint8Array(4 + body.byteLength);
    framed.set(body, 4);
    try {
      ws.send(framed);
      return true;
    } catch {
      return false;
    }
  }

  // The handshakes of this host's connections end. A kick is sent only when the room is still ours to tell (not when it is going).
  function dropConns(s) {
    const list = [...s.conns.values()];
    s.conns.clear();
    s.addrs.clear();
    for (const rec of list) {
      try {
        rec.handshake?.closed?.();
      } catch {
        // The handshake is already over.
      }
    }
  }

  function openConn(s, conn) {
    const transport = {
      send: bytes => sendFrame(s, conn, bytes),
      close: () => {
        s.conns.delete(conn);
        if (!s.dropping) sendControl(s, { op: 'kick', conn });
      },
      get bufferedAmount() {
        return s.ws?.bufferedAmount ?? 0;
      },
    };
    // The source of the per-source handshake, cookie and Stop-only limits is the phone's address when the room passed one, so a new
    // connection id does not start a new allowance (a phone cannot get past the limits by reconnecting) and one old pairing link cannot
    // spend the allowance of every relay phone. Without an address (an older room, or none seen) all relay phones share the source 'relay'.
    const address = s.addrs.get(conn);
    s.addrs.delete(conn);
    const handshake = ctx?.handshaker?.accept({ carrier: 'relay', source: address ? `relay:${address}` : 'relay', transport });
    if (!handshake) return null;
    const rec = { handshake, transport };
    s.conns.set(conn, rec);
    return rec;
  }

  // Control from the room: { op: 'open', conn, ip } gives the address of the phone that just joined, kept until its first frame opens the
  // connection; { op: 'closed', conn } says the phone on that connection went away (it hung up or its network dropped), so the
  // handshake ends now and the phone leaves the connected list at once. No kick goes back: the room already closed that socket. Any other
  // op, and anything that is not JSON, is ignored (a newer room may say more).
  function onControl(s, payload) {
    let op;
    try {
      op = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (!Number.isInteger(op?.conn) || op.conn <= CONTROL) return;
    if (op.op === 'open') {
      const ip = typeof op.ip === 'string' ? op.ip.toLowerCase() : '';
      if (!ADDRESS_RE.test(ip) || s.conns.has(op.conn)) return;
      s.addrs.delete(op.conn);
      s.addrs.set(op.conn, ip);
      if (s.addrs.size > MAX_ADDRESSES) s.addrs.delete(s.addrs.keys().next().value);
      return;
    }
    if (op.op !== 'closed') return;
    s.addrs.delete(op.conn);
    const rec = s.conns.get(op.conn);
    if (!rec) return;
    s.conns.delete(op.conn);
    try {
      rec.handshake?.closed?.();
    } catch {
      // The handshake is already over.
    }
  }

  function onMessage(s, ws, data) {
    if (s.ws !== ws || s.closed || !(data instanceof ArrayBuffer) || data.byteLength < 4) return;
    const conn = new DataView(data).getUint32(0, false);
    if (conn === CONTROL) {
      onControl(s, new Uint8Array(data.slice(4)));
      return;
    }
    const payload = new Uint8Array(data.slice(4));
    let rec = s.conns.get(conn);
    if (!rec) {
      rec = openConn(s, conn);
      if (!rec) {
        sendControl(s, { op: 'kick', conn });
        return;
      }
    }
    try {
      rec.handshake.receive(payload);
    } catch {
      s.conns.delete(conn);
      sendControl(s, { op: 'kick', conn });
    }
  }

  function onOpen(s, ws) {
    if (s.ws !== ws || s.closed) {
      try {
        ws.close(1000, 'stale');
      } catch {
        // Already closed.
      }
      return;
    }
    s.opened = true;
    s.attempt = 0;
    // The room closed the phones when this host claimed it, so every old handshake is over.
    dropConns(s);
    if (s.pending) {
      const next = s.pending.next;
      sendControl(s, { op: 'rotate', secretHash: sha256Hex(next) });
      s.secret = next;
      s.pending = null;
    }
    setLink(true);
  }

  function onClose(s, ws, event) {
    if (s.ws !== ws) return;
    s.ws = null;
    const wasOpen = s.opened;
    s.opened = false;
    dropConns(s);
    if (s.closed) return;
    const code = Number(event?.code) || 0;
    if (code === CLOSE_REPLACED) {
      setLink(false, 'replaced');
      scheduleRetry(s, 60_000);
      return;
    }
    if (wasOpen) {
      setLink(false, code === CLOSE_HOST_OFFLINE ? 'offline' : 'dropped');
      scheduleRetry(s, backoffFor(s.attempt++, random));
      return;
    }
    // It never opened: a refused secret (403) or a room or network that did not answer.
    const secret = s.pending ? s.pending.old : s.secret;
    probe(s.url, headersFor(secret), PROBE_TIMEOUT_MS).then(code2 => {
      if (s.closed || s.ws) return;
      const refused = code2 === 403 || code2 === 404 || code2 === 426;
      setLink(false, refused ? 'refused' : 'unreachable');
      scheduleRetry(s, refused ? Math.max(backoffFor(s.attempt++, random), 30_000) : backoffFor(s.attempt++, random));
    }, () => {
      if (s.closed || s.ws) return;
      setLink(false, 'unreachable');
      scheduleRetry(s, backoffFor(s.attempt++, random));
    });
  }

  function connect(s) {
    if (s.closed || s.ws) return;
    clearTimer(s);
    const secret = s.pending ? s.pending.old : s.secret;
    let ws;
    try {
      ws = new WebSocketImpl(s.url, { headers: headersFor(secret) });
    } catch {
      setLink(false, 'bad-address');
      return;
    }
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    ws.addEventListener('open', () => onOpen(s, ws));
    ws.addEventListener('message', event => onMessage(s, ws, event.data));
    ws.addEventListener('close', event => onClose(s, ws, event));
    ws.addEventListener('error', () => {
      // A close event follows.
    });
  }

  // Ends a session without telling the room anything: the sockets close, the handshakes end, no timer is left.
  function closeSession(s, reason) {
    s.closed = true;
    s.dropping = true;
    clearTimer(s);
    dropConns(s);
    const ws = s.ws;
    s.ws = null;
    try {
      ws?.close(1000, reason);
    } catch {
      // Already closed.
    }
  }

  // The room id changed (Remove all, New room): leave the old room and connect to the new one.
  function moveRoom(s, fresh) {
    closeSession(s, 'room-changed');
    session = newSession(s.cfg, fresh.roomId, fresh.hostSecret);
    setLink(false, 'connecting');
    connect(session);
  }

  function onReset() {
    const s = session;
    if (!s || s.closed) return;
    const fresh = ctx?.registry?.relay?.();
    if (!fresh || !ROOM_RE.test(String(fresh.roomId ?? '')) || !SECRET_RE.test(String(fresh.hostSecret ?? ''))) return;
    if (fresh.roomId !== s.roomId) {
      moveRoom(s, fresh);
      return;
    }
    const next = fresh.hostSecret;
    if (next === (s.pending ? s.pending.next : s.secret)) return;
    if (s.ws && s.opened && s.ws.readyState === OPEN) {
      sendControl(s, { op: 'rotate', secretHash: sha256Hex(next) });
      s.secret = next;
      s.pending = null;
    } else {
      s.pending = { old: s.pending ? s.pending.old : s.secret, next };
    }
  }

  function stopNow() {
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // Nothing to undo.
      }
    }
    unsubscribe = null;
    const s = session;
    session = null;
    if (s) closeSession(s, 'stopping');
    setLink(false, 'off');
  }

  function doStart(next) {
    ctx = next;
    const settings = next.settings?.() ?? {};
    if (settings.enabled !== true) {
      stopNow();
      return status();
    }
    const cfg = parseRelayUrl(settings.url, { allowLoopbackHttp });
    if (!cfg) {
      stopNow();
      setLink(false, 'bad-address');
      return status();
    }
    return Promise.resolve(next.registry.ensureRelay()).then(rec => {
      if (!rec || !ROOM_RE.test(String(rec.roomId ?? '')) || !SECRET_RE.test(String(rec.hostSecret ?? ''))) {
        stopNow();
        setLink(false, 'no-room');
        return status();
      }
      const url = `${cfg.wsBase}${cfg.basePath}/room/${rec.roomId}`;
      if (session && !session.closed && session.url === url) {
        // The same room, already followed: nothing to do (a rotation arrives through onReset).
        return status();
      }
      stopNow();
      session = newSession(cfg, rec.roomId, rec.hostSecret);
      const offs = ['reset', 'relay-room'].map(name => next.registry?.on?.(name, onReset)).filter(fn => typeof fn === 'function');
      unsubscribe = () => offs.forEach(fn => fn());
      setLink(false, 'connecting');
      connect(session);
      return status();
    });
  }

  function status() {
    const s = session;
    return {
      on: s !== null && !s.closed,
      connected: link.connected === true,
      reason: link.reason,
      phones: s ? s.conns.size : 0,
      origins: s ? [s.cfg.origin] : [],
    };
  }

  function start(next) {
    return serial(() => doStart(next));
  }

  function stop() {
    return serial(() => {
      stopNow();
      return status();
    });
  }

  async function hints() {
    const s = session;
    if (!s || s.closed) return [{ kind: 'relay', on: false, label: 'Your relay' }];
    return [{ kind: 'relay', on: true, label: 'Your relay', url: s.url, web: `${s.cfg.origin}${s.cfg.basePath}/` }];
  }

  return { start, stop, status, hints };
}

const carrier = createRelayCarrier();
export default carrier;
