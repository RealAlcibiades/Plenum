// Plenum relay, one Durable Object per room. The room is a blind forwarder of
// opaque frames: the phone and the computer encrypt everything with Noise, so
// this code never reads a payload. It uses the Hibernation API: sockets are
// accepted with acceptWebSocket, their identity lives in serializeAttachment,
// and the runtime answers the text ping with pong without waking the object.
//
// Wire contract (see README.md):
//   host -> room   [conn u32 big-endian][frame]   conn 0 is control, JSON in the frame
//   room -> host   [conn u32 big-endian][frame]   frame came from phone conn; conn 0 is control, JSON in the frame
//                  ({ op:'open', conn, ip } when a phone joins and the Worker passed its address; { op:'closed', conn } when a
//                  phone's socket went away, or this room closed it for a limit: a text frame, a frame too big or the rate limit)
//   room -> phone  [frame]                        plain frame, no prefix
import { DurableObject } from 'cloudflare:workers';
import { CLOSE, LIMITS } from './limits.mjs';

const CONTROL_CONN = 0;
const SECOND_MS = 1000;
const HEX64 = /^[0-9a-f]{64}$/;
// The text of an IPv4 or IPv6 address as Cloudflare writes it in cf-connecting-ip: nothing else goes to the host.
const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/;

function forbidden() {
  return new Response('Forbidden\n', {
    status: 403,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// Compares two equal-length hex strings without an early exit.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The phone's address from the cf-connecting-ip request header (the Worker passes it on), or '' when there is none or it is not an address.
function clientAddress(value) {
  return typeof value === 'string' && ADDRESS.test(value.trim()) ? value.trim().toLowerCase() : '';
}

function freshConnId(phones) {
  const used = new Set(phones.map((ws) => ws.deserializeAttachment()?.conn));
  const word = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(word);
    const id = word[0];
    if (id !== CONTROL_CONN && !used.has(id)) return id;
  }
}

function trySend(ws, data) {
  try {
    ws.send(data);
  } catch {
    // The socket is already closed; its close handler does the cleanup.
  }
}

// Marks a socket as closed before it is closed, so no later event treats it as
// a live host or phone, then closes it.
function closeSocket(ws, code, reason) {
  ws.serializeAttachment({ ...ws.deserializeAttachment(), role: 'closed' });
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Rate counters are in memory on purpose: an eviction resets them, which
    // only ever gives a flooding client a fresh second. Each phone connection
    // has its own windows, so one phone over its budget closes only itself.
    this.rates = new Map(); // conn -> { start, count, bytesStart, bytes }
  }

  // Overridden by the test support to move the clock.
  now() {
    return Date.now();
  }

  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Upgrade Required\n', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    const role = request.headers.get('x-relay-role');
    if (role === 'host') return this.acceptHost(request.headers.get('x-relay-host-hash'));
    if (role === 'phone') return this.acceptPhone(clientAddress(request.headers.get('cf-connecting-ip')));
    return forbidden();
  }

  liveHosts() {
    return this.ctx.getWebSockets('host').filter((ws) => ws.deserializeAttachment()?.role === 'host');
  }

  livePhones() {
    return this.ctx.getWebSockets('phone').filter((ws) => ws.deserializeAttachment()?.role === 'phone');
  }

  liveSockets() {
    return this.ctx.getWebSockets().filter((ws) => {
      const role = ws.deserializeAttachment()?.role;
      return role === 'host' || role === 'phone';
    });
  }

  async acceptHost(presented) {
    if (typeof presented !== 'string' || !HEX64.test(presented)) return forbidden();
    // The first host claims the room by storing the hash of its secret. The
    // check and the claim run as one block so two racing hosts cannot both claim.
    const admitted = await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get('hostHash');
      if (stored === undefined) {
        await this.ctx.storage.put('hostHash', presented);
        return true;
      }
      return sameText(stored, presented);
    });
    if (!admitted) return forbidden();

    // A new host replaces the old one and resets the phones, so each phone
    // starts a fresh Noise session with the desktop that is now connected.
    for (const old of this.liveHosts()) closeSocket(old, CLOSE.hostReplaced, 'host-replaced');
    for (const phone of this.livePhones()) closeSocket(phone, CLOSE.hostReset, 'host-reset');
    this.rates.clear();

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['host']);
    server.serializeAttachment({ role: 'host' });
    await this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  async acceptPhone(address = '') {
    const [client, server] = Object.values(new WebSocketPair());
    // Refused phones are accepted and closed at once, so the phone gets a
    // reason it can show. They are not tagged, so they never count as phones.
    if (this.liveHosts().length === 0) {
      server.accept();
      server.close(CLOSE.hostOffline, 'host-offline');
      return new Response(null, { status: 101, webSocket: client });
    }
    const phones = this.livePhones();
    if (phones.length >= LIMITS.maxPhonesPerRoom) {
      server.accept();
      server.close(CLOSE.policy, 'room-full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const conn = freshConnId(phones);
    this.ctx.acceptWebSocket(server, ['phone']);
    server.serializeAttachment({ role: 'phone', conn });
    // The host takes the address as the source of this connection's handshake limits, so one old pairing link cannot spend the
    // allowance of every relay phone. It arrives before the phone's first frame (the phone cannot send until this returns). Without an
    // address nothing is sent and the host uses its shared source.
    if (address) this.tellHosts({ op: 'open', conn, ip: address });
    await this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    if (typeof message === 'string') {
      if (att?.role === 'phone') this.dropPhone(ws, att.conn, CLOSE.unsupported, 'binary-only');
      else if (att?.role === 'host') closeSocket(ws, CLOSE.unsupported, 'binary-only');
      return;
    }
    if (att?.role === 'host') return this.fromHost(ws, message);
    if (att?.role === 'phone') return this.fromPhone(ws, att.conn, message);
  }

  fromPhone(ws, conn, message) {
    const size = message.byteLength;
    if (size > LIMITS.maxPhoneFrameBytes) return this.dropPhone(ws, conn, CLOSE.tooBig, 'frame-too-big');
    if (!this.admitPhoneFrame(conn, size)) return this.dropPhone(ws, conn, CLOSE.policy, 'rate-limit');
    const host = this.liveHosts()[0];
    if (!host) return closeSocket(ws, CLOSE.hostOffline, 'host-offline');
    const framed = new Uint8Array(4 + size);
    new DataView(framed.buffer).setUint32(0, conn, false);
    framed.set(new Uint8Array(message), 4);
    trySend(host, framed);
  }

  async fromHost(ws, message) {
    if (message.byteLength > LIMITS.maxWireFrameBytes) return closeSocket(ws, CLOSE.tooBig, 'frame-too-big');
    if (message.byteLength < 4) return; // malformed, dropped
    const conn = new DataView(message).getUint32(0, false);
    const payload = message.slice(4);
    if (conn === CONTROL_CONN) return this.control(payload);
    const target = this.livePhones().find((phone) => phone.deserializeAttachment().conn === conn);
    if (target) trySend(target, payload);
  }

  // Host-only control: { op:'rotate', secretHash } replaces the stored host
  // secret hash; { op:'kick', conn } closes one phone. Unknown or malformed
  // control frames are ignored so an older desktop never breaks the room.
  async control(payload) {
    let op;
    try {
      op = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (op?.op === 'rotate' && typeof op.secretHash === 'string' && HEX64.test(op.secretHash)) {
      await this.ctx.storage.put('hostHash', op.secretHash);
    } else if (op?.op === 'kick' && Number.isInteger(op.conn)) {
      const phone = this.livePhones().find((p) => p.deserializeAttachment().conn === op.conn);
      if (phone) closeSocket(phone, CLOSE.kicked, 'kicked');
    }
  }

  // A control frame to every live host: [conn 0][JSON]. Hosts are written to like phones: a socket that is closing is skipped.
  tellHosts(message) {
    const body = new TextEncoder().encode(JSON.stringify(message));
    const framed = new Uint8Array(4 + body.byteLength);
    framed.set(body, 4); // conn 0, the control connection
    for (const host of this.liveHosts()) trySend(host, framed);
  }

  // Closes a phone this room drops for a limit (a text frame, a frame too big, the rate limit). The hosts hear { op: 'closed' } for it first,
  // as they do when a phone hangs up, so the desktop stops listing the phone at once instead of after its liveness check (B-28). The notice
  // goes out before the close and the socket is marked closed, so the close event that follows sends no second notice.
  dropPhone(ws, conn, code, reason) {
    this.rates.delete(conn);
    this.tellHosts({ op: 'closed', conn });
    closeSocket(ws, code, reason);
  }

  // Admits one phone frame of this connection: the message count and the byte budget are both per phone connection (plan D9),
  // so a phone over its budget never makes another phone's frame fail.
  admitPhoneFrame(conn, size) {
    const now = this.now();
    let rate = this.rates.get(conn);
    if (!rate) {
      rate = { start: now, count: 0, bytesStart: now, bytes: 0 };
      this.rates.set(conn, rate);
    }
    if (now - rate.start >= SECOND_MS) {
      rate.start = now;
      rate.count = 0;
    }
    rate.count += 1;
    if (rate.count > LIMITS.phoneMessagesPerSecond) return false;
    if (now - rate.bytesStart >= SECOND_MS) {
      rate.bytesStart = now;
      rate.bytes = 0;
    }
    rate.bytes += size;
    return rate.bytes <= LIMITS.phoneBytesPerSecond;
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (att?.role === 'host' || att?.role === 'phone') {
      ws.serializeAttachment({ ...att, role: 'closed' });
    }
    if (att?.role === 'phone') {
      this.rates.delete(att.conn);
      // A phone that hung up or whose network dropped is reported to the host, so the desktop does not keep showing it as connected
      // until its own liveness check gives up. A phone this room closed itself already has role 'closed' here: a limit was reported by
      // dropPhone before its close, and a kick or a host reset is not reported (the host did that itself).
      this.tellHosts({ op: 'closed', conn: att.conn });
    }
    if (att?.role === 'host' && this.liveHosts().length === 0) {
      for (const phone of this.livePhones()) closeSocket(phone, CLOSE.hostOffline, 'host-offline');
    }
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    await this.touch();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // Records activity on connect and disconnect only. Frames are not written to
  // storage, so the free plan's rows-written allowance is never spent on traffic.
  async touch() {
    const now = this.now();
    await this.ctx.storage.put('lastSeen', now);
    await this.ctx.storage.setAlarm(now + LIMITS.idleMs);
  }

  // Deletes the room after 30 days with no socket connected and no connect or
  // disconnect in that time. A connected room is never deleted. The stored host
  // secret hash survives the deletion, so the next host with a different secret
  // gets 403 and nobody else can claim an idle room (plan D9).
  async alarm() {
    const now = this.now();
    if (this.liveSockets().length > 0) {
      await this.touch();
      return;
    }
    const last = await this.ctx.storage.get('lastSeen');
    if (last === undefined || now - last >= LIMITS.idleMs) {
      const hostHash = await this.ctx.storage.get('hostHash');
      await this.ctx.storage.deleteAll();
      if (hostHash !== undefined) await this.ctx.storage.put('hostHash', hostHash);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(last + LIMITS.idleMs);
  }
}
