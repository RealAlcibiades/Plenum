// Suite for lib/remote/frames.mjs (mob-02, wave 101). Fake sockets and the fake clock from helpers/fake-clock.mjs; no network.
// Run it through the sealed runner: node build/mobile/run.mjs --id <name> frames.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from './helpers/fake-clock.mjs';
import {
  TYPE, FLAG, CHUNK, BUFFER_CAP, COALESCE_MS, MAX_PLAINTEXT, PING_INTERVAL_MS, PING_MISSES_TO_CLOSE, POLL_MS,
  FrameError, FrameSession, StreamTable, decodeFrame, encodeFrame, encodeJsonFrame,
} from '../../lib/remote/frames.mjs';

const T = TYPE;
const enc = text => new TextEncoder().encode(text);

function bytesOf(n, seed = 1) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function joinAll(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function same(a, b) {
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

// A message whose bytes are written exactly as given, for malformed input.
function raw(type, stream, flags, payload = new Uint8Array(0)) {
  const out = new Uint8Array(6 + payload.byteLength);
  new DataView(out.buffer).setUint32(1, stream, false);
  out[0] = type;
  out[5] = flags;
  out.set(payload, 6);
  return out;
}

// A socket that records what was written. instant: the socket drains at once, so bufferedAmount never grows.
// Otherwise bufferedAmount grows with each write and the test drains it. violations lists every non-priority frame
// written while bufferedAmount was at or over the cap.
function fakeSocket({ instant = false } = {}) {
  return {
    sent: [],
    violations: [],
    closed: null,
    buffered: 0,
    get bufferedAmount() {
      return this.buffered;
    },
    send(bytes) {
      if (this.closed) throw new Error('socket closed');
      const priority = (bytes[5] & FLAG.PRIORITY) !== 0;
      if (!priority && this.buffered >= BUFFER_CAP) this.violations.push(bytes[0]);
      this.sent.push(bytes);
      if (!instant) this.buffered += bytes.byteLength;
    },
    close(code, reason) {
      if (!this.closed) this.closed = { code, reason };
    },
  };
}

const frames = sock => sock.sent.map(bytes => decodeFrame(bytes));
const typesOf = sock => frames(sock).map(f => f.type);

// Two sessions joined by an in-memory link. Messages wait in queues until deliver() moves them, so no call re-enters
// another session. cut: true drops every message (a dead path).
class Link {
  constructor() {
    this.cut = false;
    this.toDesktop = [];
    this.toPhone = [];
    const link = this;
    const socket = side => ({
      bufferedAmount: 0,
      closed: null,
      send(bytes) {
        if (this.closed) throw new Error('socket closed');
        if (link.cut) return;
        (side === 'phone' ? link.toDesktop : link.toPhone).push(bytes.slice());
      },
      close(code, reason) {
        if (!this.closed) this.closed = { code, reason };
      },
    });
    this.phoneSock = socket('phone');
    this.desktopSock = socket('desktop');
  }

  deliver(phone, desktop) {
    let moved = true;
    while (moved) {
      moved = false;
      while (this.toDesktop.length) {
        desktop.receive(this.toDesktop.shift());
        moved = true;
      }
      while (this.toPhone.length) {
        phone.receive(this.toPhone.shift());
        moved = true;
      }
    }
  }
}

function linkedPair({ clock = createFakeClock(), phoneHandlers = {}, desktopHandlers = {} } = {}) {
  const link = new Link();
  const phone = new FrameSession({ role: 'phone', transport: link.phoneSock, clock, handlers: phoneHandlers });
  const desktop = new FrameSession({ role: 'desktop', transport: link.desktopSock, clock, handlers: desktopHandlers });
  return { clock, link, phone, desktop, deliver: () => link.deliver(phone, desktop) };
}

describe('encoding and the layout', () => {
  test('the header is type, then the stream as a big-endian u32, then flags', () => {
    const out = encodeFrame(T.BODY, 0x01020304, FLAG.FIN, Uint8Array.of(9, 8));
    assert.deepEqual([...out], [T.BODY, 1, 2, 3, 4, FLAG.FIN, 9, 8]);
    const frame = decodeFrame(out);
    assert.equal(frame.type, T.BODY);
    assert.equal(frame.stream, 0x01020304);
    assert.equal(frame.flags, FLAG.FIN);
    assert.deepEqual([...frame.payload], [9, 8]);
  });

  test('every type round-trips on the stream it belongs to', () => {
    const cases = [
      [T.HELLO, 0, { protocol: '1.0' }],
      [T.REQ, 1, { method: 'GET', path: '/api/state?x=1' }],
      [T.BODY, 1, Uint8Array.of(1, 2, 3)],
      [T.RES, 1, { status: 200, headers: {} }],
      [T.DATA, 1, Uint8Array.of(4, 5)],
      [T.CANCEL, 1, undefined],
      [T.STOP, 0, { id: 'a'.repeat(32) }],
      [T.STOP_ACK, 0, { id: 'a'.repeat(32), cancelled: 1 }],
      [T.PING, 0, new Uint8Array(8).fill(7)],
      [T.PONG, 0, new Uint8Array(8).fill(7)],
      [T.EVENT, 0, { type: 'phone', kind: 'presence' }],
      [T.CLOSE, 0, { reason: 'protocol' }],
    ];
    for (const [type, stream, value] of cases) {
      const bytes = value !== null && typeof value === 'object' && !(value instanceof Uint8Array)
        ? encodeJsonFrame(type, stream, 0, value)
        : encodeFrame(type, stream, 0, value);
      const frame = decodeFrame(bytes);
      assert.equal(frame.type, type);
      assert.equal(frame.stream, stream);
      if (value instanceof Uint8Array) assert.deepEqual([...frame.payload], [...value]);
      else if (value === undefined) assert.equal(frame.payload.byteLength, 0);
      else assert.deepEqual(frame.value, value);
    }
  });

  test('PRIORITY is set on the priority types and on no other', () => {
    for (const [type, stream, payload] of [
      [T.CANCEL, 1, undefined], [T.PING, 0, new Uint8Array(8)], [T.PONG, 0, new Uint8Array(8)],
    ]) {
      assert.equal(decodeFrame(encodeFrame(type, stream, 0, payload)).flags & FLAG.PRIORITY, FLAG.PRIORITY);
    }
    assert.equal(decodeFrame(encodeJsonFrame(T.STOP, 0, 0, { id: 'x' })).flags & FLAG.PRIORITY, FLAG.PRIORITY);
    assert.equal(decodeFrame(encodeJsonFrame(T.STOP_ACK, 0, 0, { id: 'x' })).flags & FLAG.PRIORITY, FLAG.PRIORITY);
    assert.equal(decodeFrame(encodeJsonFrame(T.REQ, 1, 0, { method: 'GET', path: '/' })).flags & FLAG.PRIORITY, 0);
    assert.equal(decodeFrame(encodeFrame(T.DATA, 1, 0, Uint8Array.of(1))).flags & FLAG.PRIORITY, 0);
  });

  test('the encoder refuses shapes the decoder would refuse', () => {
    assert.throws(() => encodeFrame(0x55, 1, 0), err => err instanceof FrameError && err.code === 'type');
    assert.throws(() => encodeFrame(T.BODY, 1, FLAG.COMPRESSED, Uint8Array.of(1)), err => err.code === 'flags');
    assert.throws(() => encodeFrame(T.PING, 0, 0, new Uint8Array(4)), err => err.code === 'payload');
    assert.throws(() => encodeJsonFrame(T.DATA, 1, 0, { a: 1 }), err => err.code === 'type');
    assert.throws(() => encodeJsonFrame(T.REQ, 1, 0, [1, 2]), err => err.code === 'json');
  });
});

describe('strict parser', () => {
  const refuses = (bytes, code) => assert.throws(() => decodeFrame(bytes), err => err instanceof FrameError && err.code === code);

  test('refuses short frames, oversize frames, unknown types and reserved flags', () => {
    refuses(Uint8Array.of(T.REQ, 0, 0), 'short');
    const oversize = new Uint8Array(MAX_PLAINTEXT + 1);
    oversize[0] = T.CLOSE;
    refuses(oversize, 'size');
    refuses(raw(0x55, 1, 0), 'type');
    refuses(raw(0x7e, 0, 0), 'type');
    refuses(raw(T.BODY, 1, FLAG.COMPRESSED), 'flags');
    refuses(raw(T.BODY, 1, 0x08), 'flags');
  });

  test('refuses control types off stream 0 and stream types on stream 0', () => {
    refuses(raw(T.STOP, 1, 0), 'stream');
    refuses(raw(T.PING, 1, 0, new Uint8Array(8)), 'stream');
    refuses(raw(T.BODY, 0, 0, Uint8Array.of(1)), 'stream');
    refuses(raw(T.CANCEL, 0, 0), 'stream');
  });

  test('refuses JSON payloads that are not UTF-8 JSON objects', () => {
    for (const bad of ['not json', '[1,2]', 'null', '"text"', '7', '']) refuses(raw(T.REQ, 1, 0, enc(bad)), 'json');
    refuses(raw(T.REQ, 1, 0, Uint8Array.of(0xff, 0xfe, 0x7b)), 'json');
  });

  test('PING and PONG carry exactly 8 bytes; BODY and DATA stop at one chunk', () => {
    refuses(raw(T.PING, 0, 0, new Uint8Array(4)), 'payload');
    refuses(raw(T.PONG, 0, 0, new Uint8Array(9)), 'payload');
    refuses(raw(T.BODY, 1, 0, new Uint8Array(CHUNK + 1)), 'payload');
    refuses(raw(T.DATA, 1, 0, new Uint8Array(CHUNK + 1)), 'payload');
    assert.equal(decodeFrame(raw(T.DATA, 1, 0, new Uint8Array(CHUNK))).payload.byteLength, CHUNK);
  });

  test('accepts the largest legal frame and refuses one byte more', () => {
    const pad = 'x'.repeat(MAX_PLAINTEXT - 6 - 8); // {"p":"..."} is 8 bytes around the padding
    const frame = encodeJsonFrame(T.CLOSE, 0, 0, { p: pad });
    assert.equal(frame.byteLength, MAX_PLAINTEXT);
    assert.equal(decodeFrame(frame).value.p.length, pad.length);
    assert.throws(() => encodeJsonFrame(T.CLOSE, 0, 0, { p: `${pad}x` }), err => err.code === 'size');
  });
});

describe('stream table', () => {
  test('phone ids are odd, desktop ids are even, and at most 32 streams are open', () => {
    const phone = new StreamTable({ localBit: 1 });
    const ids = [];
    for (let i = 0; i < 32; i++) ids.push(phone.allocate().id);
    assert.deepEqual(ids.slice(0, 3), [1, 3, 5]);
    assert.equal(ids[31], 63);
    assert.equal(phone.allocate(), null);
    phone.delete(1);
    assert.equal(phone.allocate().id, 65);
    const desktop = new StreamTable({ localBit: 0 });
    assert.deepEqual([desktop.allocate().id, desktop.allocate().id], [2, 4]);
  });

  test("a peer's stream must carry the peer's parity and a new id", () => {
    const table = new StreamTable({ localBit: 0 });
    assert.throws(() => table.admitRemote(2), err => err.code === 'parity');
    table.admitRemote(3);
    assert.throws(() => table.admitRemote(3), err => err.code === 'order');
    assert.throws(() => table.admitRemote(1), err => err.code === 'order');
    assert.equal(table.isStale(1), true);
    assert.equal(table.isStale(5), false);
  });
});

describe('streams and reassembly', () => {
  test('interleaved streams reassemble in order, and the round robin interleaves them in both directions', () => {
    const upBodies = new Map();
    const order = [];
    const downData = new Map();
    const p = linkedPair({
      desktopHandlers: {
        body(id, bytes) {
          order.push(id);
          upBodies.set(id, [...(upBodies.get(id) ?? []), bytes.slice()]);
        },
      },
      phoneHandlers: {
        data(id, bytes) {
          downData.set(id, [...(downData.get(id) ?? []), bytes.slice()]);
        },
      },
    });
    // Hold every frame behind the cap, then let the clock drain the queue.
    p.link.phoneSock.bufferedAmount = BUFFER_CAP;
    const a = p.phone.request({ method: 'POST', path: '/api/a' });
    const b = p.phone.request({ method: 'POST', path: '/api/b' });
    const A = bytesOf(70000, 3);
    const B = bytesOf(50000, 9);
    p.phone.body(a, A, { fin: true });
    p.phone.body(b, B, { fin: true });
    p.link.phoneSock.bufferedAmount = 0;
    p.clock.advance(POLL_MS);
    p.deliver();
    // REQ a, REQ b, then the body frames alternate between the two streams.
    assert.deepEqual(order, [a, b, a, b, a]);
    assert.ok(same(joinAll(upBodies.get(a)), A));
    assert.ok(same(joinAll(upBodies.get(b)), B));

    const C = bytesOf(70000, 11);
    const D = bytesOf(40000, 12);
    p.link.desktopSock.bufferedAmount = BUFFER_CAP;
    assert.equal(p.desktop.respond(a, { status: 200 }), true);
    assert.equal(p.desktop.respond(b, { status: 200 }), true);
    p.desktop.data(a, C, { fin: true });
    p.desktop.data(b, D, { fin: true });
    p.link.desktopSock.bufferedAmount = 0;
    p.clock.advance(POLL_MS);
    p.deliver();
    assert.ok(same(joinAll(downData.get(a)), C));
    assert.ok(same(joinAll(downData.get(b)), D));
    assert.equal(p.desktop.openStreams, 0, 'both streams finished in both directions');
    assert.equal(p.phone.openStreams, 0);
  });

  test('a 40 MB BODY chunks into 32768-byte frames with FIN on the last one only', () => {
    const sock = fakeSocket({ instant: true });
    const phone = new FrameSession({ role: 'phone', transport: sock, clock: createFakeClock() });
    const id = phone.request({ method: 'POST', path: '/api/chat' });
    const data = bytesOf(40_000_000, 5);
    assert.equal(phone.body(id, data, { fin: true }), true);
    const body = frames(sock).filter(f => f.type === T.BODY);
    const expected = Math.ceil(40_000_000 / CHUNK);
    assert.equal(body.length, expected);
    assert.ok(body.every(f => f.stream === id));
    assert.ok(body.slice(0, -1).every(f => f.payload.byteLength === CHUNK && f.flags === 0));
    const last = body.at(-1);
    assert.equal(last.payload.byteLength, 40_000_000 - (expected - 1) * CHUNK);
    assert.equal(last.flags, FLAG.FIN);
    assert.ok(same(joinAll(body.map(f => f.payload)), data));
    assert.deepEqual(sock.violations, []);
  });

  test('the REQ of a bodiless request carries FIN, and a frame after a peer FIN is a protocol error', () => {
    const sock = fakeSocket({ instant: true });
    const phone = new FrameSession({ role: 'phone', transport: sock, clock: createFakeClock() });
    phone.request({ method: 'GET', path: '/api/state' }, { fin: true });
    assert.equal(decodeFrame(sock.sent[0]).flags & FLAG.FIN, FLAG.FIN);

    let protocol = null;
    const desk = new FrameSession({
      role: 'desktop', transport: fakeSocket({ instant: true }), clock: createFakeClock(),
      handlers: { protocolError: m => { protocol = m; } },
    });
    desk.receive(encodeJsonFrame(T.REQ, 1, FLAG.FIN, { method: 'GET', path: '/' }));
    assert.equal(desk.receive(encodeFrame(T.BODY, 1, 0, Uint8Array.of(1))), false);
    assert.match(protocol, /after FIN/);
  });

  test('the 33rd open stream is refused, a retired stream frees its slot, and the 33rd REQ from a phone is a protocol error', () => {
    const p = linkedPair();
    const ids = [];
    for (let i = 0; i < 32; i++) ids.push(p.phone.request({ method: 'GET', path: '/' }));
    assert.equal(p.phone.request({ method: 'GET', path: '/' }), null);
    assert.equal(p.phone.openStreams, 32);
    p.deliver();
    assert.equal(p.desktop.openStreams, 32);
    p.phone.body(ids[0], new Uint8Array(0), { fin: true });
    p.deliver();
    assert.equal(p.desktop.respond(ids[0], { status: 204 }, { fin: true }), true);
    p.deliver();
    assert.equal(p.phone.openStreams, 31);
    assert.equal(p.desktop.openStreams, 31);
    assert.notEqual(p.phone.request({ method: 'GET', path: '/' }), null);

    const sock = fakeSocket({ instant: true });
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock: createFakeClock() });
    for (let i = 0; i < 32; i++) assert.equal(desk.receive(encodeJsonFrame(T.REQ, 2 * i + 1, 0, { method: 'GET', path: '/' })), true);
    assert.equal(desk.receive(encodeJsonFrame(T.REQ, 65, 0, { method: 'GET', path: '/' })), false);
    assert.equal(desk.isClosed, true);
    assert.equal(frames(sock).at(-1).value.reason, 'protocol');
  });

  test('the wrong side cannot send a frame type: REQ to the phone and RES to the desktop are protocol errors', () => {
    const clock = createFakeClock();
    const phone = new FrameSession({ role: 'phone', transport: fakeSocket({ instant: true }), clock });
    assert.equal(phone.receive(encodeJsonFrame(T.REQ, 1, 0, { method: 'GET', path: '/' })), false);
    const desk = new FrameSession({ role: 'desktop', transport: fakeSocket({ instant: true }), clock });
    assert.equal(desk.receive(encodeJsonFrame(T.RES, 1, 0, { status: 200 })), false);
    assert.equal(desk.isClosed, true);
  });

  test('only the side that sends a type may call its method', () => {
    const clock = createFakeClock();
    const phone = new FrameSession({ role: 'phone', transport: fakeSocket({ instant: true }), clock });
    const desk = new FrameSession({ role: 'desktop', transport: fakeSocket({ instant: true }), clock });
    assert.throws(() => phone.hello({}), TypeError);
    assert.throws(() => desk.request({}), TypeError);
    assert.throws(() => desk.body(1, new Uint8Array(1)), TypeError);
    assert.throws(() => phone.data(1, new Uint8Array(1)), TypeError);
    assert.throws(() => phone.respond(1, {}), TypeError);
    assert.throws(() => phone.stopAck({}), TypeError);
  });
});

describe('priority lane, pacing and the buffer cap', () => {
  test('with a saturated socket a STOP is written at once and REQ frames wait for the drain', () => {
    const clock = createFakeClock();
    const sock = fakeSocket();
    const phone = new FrameSession({ role: 'phone', transport: sock, clock });
    sock.buffered = BUFFER_CAP + 1000;
    const a = phone.request({ method: 'GET', path: '/api/state' });
    const b = phone.request({ method: 'GET', path: '/api/events' });
    assert.equal(sock.sent.length, 0, 'the REQ frames wait behind the cap');
    assert.equal(phone.stop({ id: 'stop-1' }), true);
    assert.deepEqual(typesOf(sock), [T.STOP]);
    assert.equal(frames(sock)[0].flags & FLAG.PRIORITY, FLAG.PRIORITY);
    sock.buffered = 0;
    clock.advance(POLL_MS);
    assert.deepEqual(typesOf(sock), [T.STOP, T.REQ, T.REQ]);
    assert.deepEqual(frames(sock).slice(1).map(f => f.stream), [a, b]);
    assert.deepEqual(sock.violations, []);
  });

  test('pacing keeps every non-priority frame under the cap while a 40 MB body drains', () => {
    const clock = createFakeClock();
    const sock = fakeSocket();
    const phone = new FrameSession({ role: 'phone', transport: sock, clock });
    const id = phone.request({ method: 'POST', path: '/api/chat' });
    phone.body(id, bytesOf(40_000_000, 2), { fin: true });
    for (let step = 0; step < 100000 && sock.sent.length < 1222; step++) {
      clock.advance(POLL_MS);
      sock.buffered = Math.max(0, sock.buffered - 65536);
    }
    assert.equal(sock.sent.length, 1222);
    assert.deepEqual(sock.violations, []);
    assert.equal(frames(sock).at(-1).flags & FLAG.FIN, FLAG.FIN);
  });

  test('priority frames bypass a queued body and the cap; the queued RES and DATA follow the drain', () => {
    const clock = createFakeClock();
    const sock = fakeSocket();
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock });
    desk.receive(encodeJsonFrame(T.REQ, 1, 0, { method: 'GET', path: '/' }));
    sock.buffered = BUFFER_CAP;
    desk.respond(1, { status: 200 });
    desk.data(1, bytesOf(100000, 4));
    desk.stopAck({ id: 'abc', cancelled: 0 });
    desk.ping();
    desk.receive(encodeFrame(T.PING, 0, 0, new Uint8Array(8).fill(3)));
    assert.deepEqual(typesOf(sock), [T.STOP_ACK, T.PING, T.PONG]);
    assert.equal(frames(sock)[2].payload.every((v, i) => v === 3), true, 'the PONG echoes the nonce');
    sock.buffered = 0;
    clock.advance(POLL_MS);
    assert.deepEqual(typesOf(sock).slice(3), [T.RES, T.DATA, T.DATA, T.DATA, T.DATA]);
    assert.deepEqual(sock.violations, []);
  });

  test('the bufferedAmount option is read as a getter when the transport has no property', () => {
    const clock = createFakeClock();
    let level = BUFFER_CAP;
    const sent = [];
    const transport = { send: bytes => sent.push(bytes), close() {} };
    const phone = new FrameSession({ role: 'phone', transport, clock, bufferedAmount: () => level });
    phone.request({ method: 'GET', path: '/' });
    assert.equal(sent.length, 0);
    level = 0;
    clock.advance(POLL_MS);
    assert.equal(sent.length, 1);
  });
});

describe('CANCEL', () => {
  test('CANCEL drops the stream queued frames, goes out at once, and runs the abort hook once', () => {
    const clock = createFakeClock();
    const sock = fakeSocket();
    const aborts = [];
    const phone = new FrameSession({ role: 'phone', transport: sock, clock, handlers: { abort: (id, origin) => aborts.push([id, origin]) } });
    const a = phone.request({ method: 'POST', path: '/a' });
    sock.buffered = BUFFER_CAP;
    phone.body(a, bytesOf(100000, 8));
    const b = phone.request({ method: 'GET', path: '/b' });
    assert.equal(phone.cancel(a), true);
    assert.deepEqual(typesOf(sock), [T.REQ, T.CANCEL]);
    assert.deepEqual(aborts, [[a, 'local']]);
    assert.equal(phone.cancel(a), false);
    assert.deepEqual(aborts, [[a, 'local']]);
    assert.equal(phone.body(a, bytesOf(5)), false, 'a cancelled stream takes no more body');
    sock.buffered = 0;
    clock.advance(POLL_MS);
    assert.deepEqual(typesOf(sock), [T.REQ, T.CANCEL, T.REQ]);
    assert.equal(frames(sock)[2].stream, b);
  });

  test('a CANCEL from the peer retires the stream, its later frames are ignored, and the hook runs once', () => {
    const clock = createFakeClock();
    const sock = fakeSocket({ instant: true });
    const aborts = [];
    const bodies = [];
    const desk = new FrameSession({
      role: 'desktop', transport: sock, clock,
      handlers: { abort: (id, origin) => aborts.push([id, origin]), body: id => bodies.push(id) },
    });
    desk.receive(encodeJsonFrame(T.REQ, 1, 0, { method: 'POST', path: '/api/chat' }));
    assert.equal(desk.receive(encodeFrame(T.CANCEL, 1, 0)), true);
    assert.equal(desk.receive(encodeFrame(T.BODY, 1, FLAG.FIN, bytesOf(10))), true);
    assert.equal(desk.receive(encodeFrame(T.CANCEL, 1, 0)), true);
    assert.deepEqual(aborts, [[1, 'remote']]);
    assert.deepEqual(bodies, []);
    assert.equal(desk.isClosed, false);
    assert.deepEqual(sock.sent, [], 'a remote CANCEL is not answered');
  });

  test('a CANCEL from the peer drops the queued response frames of that stream', () => {
    const clock = createFakeClock();
    const sock = fakeSocket();
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock });
    desk.receive(encodeJsonFrame(T.REQ, 1, 0, { method: 'GET', path: '/' }));
    sock.buffered = BUFFER_CAP;
    desk.respond(1, { status: 200 });
    desk.data(1, bytesOf(70000, 2));
    desk.receive(encodeFrame(T.CANCEL, 1, 0));
    sock.buffered = 0;
    clock.advance(POLL_MS);
    assert.deepEqual(typesOf(sock), []);
  });

  test('a CANCEL on a stream the peer never opened is a protocol error', () => {
    const sock = fakeSocket({ instant: true });
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock: createFakeClock() });
    assert.equal(desk.receive(encodeFrame(T.CANCEL, 3, 0)), false);
    assert.equal(frames(sock).at(-1).value.reason, 'protocol');
  });
});

describe('malformed input closes the session', () => {
  test('a malformed frame sends CLOSE protocol, closes the transport, and nothing after it is processed', () => {
    const cases = {
      'unknown type': raw(0x55, 1, 0),
      'short header': Uint8Array.of(T.REQ, 0, 0),
      'reserved flag': raw(T.BODY, 1, FLAG.COMPRESSED, Uint8Array.of(1)),
      'bad JSON': raw(T.REQ, 3, 0, enc('{nope')),
      'control type on a stream': raw(T.PING, 1, 0, new Uint8Array(8)),
      'stream type on stream 0': raw(T.BODY, 0, 0, Uint8Array.of(1)),
      'oversize frame': (() => { const f = new Uint8Array(MAX_PLAINTEXT + 1); f[0] = T.CLOSE; return f; })(),
      'BODY over one chunk': raw(T.BODY, 1, 0, new Uint8Array(CHUNK + 1)),
    };
    for (const [name, bad] of Object.entries(cases)) {
      const sock = fakeSocket({ instant: true });
      const reqs = [];
      let protocol = null;
      const desk = new FrameSession({
        role: 'desktop', transport: sock, clock: createFakeClock(),
        handlers: { req: id => reqs.push(id), protocolError: m => { protocol = m; } },
      });
      assert.equal(desk.receive(encodeJsonFrame(T.REQ, 1, 0, { method: 'GET', path: '/' })), true, name);
      assert.equal(desk.receive(bad), false, name);
      assert.equal(desk.receive(encodeJsonFrame(T.REQ, 3, 0, { method: 'GET', path: '/' })), false, name);
      assert.deepEqual(reqs, [1], `${name}: the frame after the bad one was not processed`);
      const last = frames(sock).at(-1);
      assert.equal(last.type, T.CLOSE, name);
      assert.deepEqual(last.value, { reason: 'protocol' }, name);
      assert.equal(sock.closed.code, 1002, name);
      assert.ok(protocol, name);
    }
  });

  test('a COOKIE inside a session is a protocol error, and a PING is answered with its nonce', () => {
    const sock = fakeSocket({ instant: true });
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock: createFakeClock() });
    assert.equal(desk.receive(encodeFrame(T.PING, 0, 0, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))), true);
    assert.deepEqual(typesOf(sock), [T.PONG]);
    assert.deepEqual([...frames(sock)[0].payload], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(desk.receive(encodeFrame(T.COOKIE, 0, 0, new Uint8Array(16))), false);
    assert.equal(desk.isClosed, true);
  });
});

describe('coalescing of small DATA', () => {
  test('small chunks join for up to 30 ms; a larger chunk or a FIN flushes them at once', () => {
    const clock = createFakeClock();
    const sock = fakeSocket({ instant: true });
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock });
    desk.receive(encodeJsonFrame(T.REQ, 1, 0, { method: 'POST', path: '/api/chat' }));
    desk.respond(1, { status: 200 });
    const dataFrames = () => frames(sock).filter(f => f.type === T.DATA);
    const one = bytesOf(10, 1);
    const two = bytesOf(10, 2);
    const three = bytesOf(10, 3);
    desk.data(1, one);
    clock.advance(10);
    desk.data(1, two);
    clock.advance(10);
    desk.data(1, three);
    assert.equal(dataFrames().length, 0);
    clock.advance(COALESCE_MS - 20 - 1);
    assert.equal(dataFrames().length, 0);
    clock.advance(1);
    assert.deepEqual(dataFrames().map(f => f.payload.byteLength), [30]);
    assert.ok(same(dataFrames()[0].payload, joinAll([one, two, three])));
    desk.data(1, bytesOf(5, 4));
    desk.data(1, bytesOf(2000, 5));
    assert.deepEqual(dataFrames().map(f => f.payload.byteLength), [30, 5, 2000]);
    desk.data(1, bytesOf(7, 6), { fin: true });
    assert.deepEqual(dataFrames().map(f => f.payload.byteLength), [30, 5, 2000, 7]);
    assert.equal(frames(sock).at(-1).flags & FLAG.FIN, FLAG.FIN);
    assert.equal(clock.pending, 0, 'no flush timer is left behind');
  });

  test('pending small DATA flushes at 1 KiB without waiting for the timer', () => {
    const clock = createFakeClock();
    const sock = fakeSocket({ instant: true });
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock });
    desk.receive(encodeJsonFrame(T.REQ, 1, 0, { method: 'GET', path: '/' }));
    desk.data(1, bytesOf(600, 1));
    assert.equal(sock.sent.length, 0);
    desk.data(1, bytesOf(600, 2));
    assert.deepEqual(frames(sock).map(f => f.payload.byteLength), [1200]);
    assert.equal(clock.pending, 0);
  });
});

describe('liveness on a fake clock', () => {
  test('two missed PONGs close the socket within two ping intervals', () => {
    const clock = createFakeClock();
    const sock = fakeSocket({ instant: true });
    let reason = null;
    const phone = new FrameSession({ role: 'phone', transport: sock, clock, handlers: { closed: r => { reason = r; } } });
    phone.startLiveness({ intervalMs: PING_INTERVAL_MS });
    assert.deepEqual(typesOf(sock), [T.PING]);
    clock.advance(PING_INTERVAL_MS - 1);
    assert.equal(phone.isClosed, false);
    clock.advance(1);
    assert.equal(phone.isClosed, false, 'one miss is not enough');
    clock.advance(PING_INTERVAL_MS);
    assert.equal(phone.isClosed, true);
    assert.equal(reason, 'timeout');
    assert.equal(sock.closed.code, 1000);
    assert.ok(clock.now() <= 2 * PING_INTERVAL_MS);
    assert.equal(PING_MISSES_TO_CLOSE, 2);
    assert.equal(clock.pending, 0);
  });

  test('a PONG with the wrong nonce does not count as an answer', () => {
    const clock = createFakeClock();
    const sock = fakeSocket({ instant: true });
    const phone = new FrameSession({
      role: 'phone', transport: sock, clock, nonce: () => Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    });
    phone.startLiveness({ intervalMs: PING_INTERVAL_MS });
    clock.advance(PING_INTERVAL_MS);
    phone.receive(encodeFrame(T.PONG, 0, 0, new Uint8Array(8)));
    clock.advance(PING_INTERVAL_MS);
    assert.equal(phone.isClosed, true);
    assert.equal(sock.closed.code, 1000);
  });

  test('answered PINGs keep both ends open over ten intervals', () => {
    const p = linkedPair();
    p.phone.startLiveness({ intervalMs: PING_INTERVAL_MS });
    p.deliver();
    for (let i = 0; i < 10; i++) {
      p.clock.advance(PING_INTERVAL_MS);
      p.deliver();
    }
    assert.equal(p.phone.isClosed, false);
    assert.equal(p.desktop.isClosed, false);
  });

  test('a dead path closes the phone side in two intervals even when its own PINGs are lost', () => {
    const p = linkedPair();
    p.link.cut = true;
    let reason = null;
    p.phone.handlers.closed = r => { reason = r; };
    p.phone.startLiveness({ intervalMs: PING_INTERVAL_MS });
    p.clock.advance(2 * PING_INTERVAL_MS);
    assert.equal(p.phone.isClosed, true);
    assert.equal(reason, 'timeout');
  });
});

describe('close', () => {
  test('close sends CLOSE with its reason, closes the transport, and refuses later work', () => {
    const clock = createFakeClock();
    const sock = fakeSocket({ instant: true });
    const closedAs = [];
    const phone = new FrameSession({ role: 'phone', transport: sock, clock, handlers: { closed: r => { closedAs.push(r); } } });
    phone.close('normal');
    const last = frames(sock).at(-1);
    assert.equal(last.type, T.CLOSE);
    assert.deepEqual(last.value, { reason: 'normal' });
    assert.equal(sock.closed.code, 1000);
    assert.deepEqual(closedAs, ['normal']);
    assert.equal(phone.request({ method: 'GET', path: '/' }), null);
    assert.equal(phone.stop({ id: 'x' }), false);
    assert.equal(phone.receive(encodeFrame(T.PING, 0, 0, new Uint8Array(8))), false);
    phone.close();
    assert.equal(sock.sent.length, 1, 'a second close sends nothing');
  });

  test('a CLOSE from the peer closes this side without a reply', () => {
    const sock = fakeSocket({ instant: true });
    let got = null;
    const desk = new FrameSession({ role: 'desktop', transport: sock, clock: createFakeClock(), handlers: { close: v => { got = v; } } });
    desk.receive(encodeJsonFrame(T.CLOSE, 0, 0, { reason: 'bye' }));
    assert.deepEqual(got, { reason: 'bye' });
    assert.equal(desk.closeReason, 'bye');
    assert.deepEqual(sock.sent, []);
    assert.equal(sock.closed.code, 1000);
  });
});

describe('the stream cap across a pair', () => {
  test('a pair keeps the stream tables in step through a full exchange', () => {
    const p = linkedPair({ desktopHandlers: { req: (id) => { p.desktop.respond(id, { status: 200 }, { fin: true }); } } });
    const id = p.phone.request({ method: 'GET', path: '/api/state' }, { fin: true });
    p.deliver();
    assert.equal(p.phone.openStreams, 0);
    assert.equal(p.desktop.openStreams, 0);
    assert.notEqual(id, null);
  });
});
