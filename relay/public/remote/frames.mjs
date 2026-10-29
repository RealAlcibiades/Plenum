// Frames for the Plenum remote channel: encoding, decoding, the stream table and the per-socket session (send queue,
// priority lane, pacing, coalescing, CANCEL, liveness). Owned by the mobile track (mob-02, wave 101).
//
// Isomorphic: no node: imports and no Buffer, so the same file runs in Node (the Bridge and the tests), in the phone's
// channel Worker and in the browser. Time and the socket's buffered byte count come in through options, so tests drive
// them on a fake clock.
//
// Layout of every transport message, one frame per message: [type u8][stream u32 big-endian][flags u8][payload].
//   Stream 0 is the control stream. Phone-opened streams are odd, desktop-opened streams even.
//   Flags: bit0 FIN (last frame of this direction), bit1 PRIORITY (set automatically on the priority types),
//   bit2 COMPRESSED (reserved, unused in 1.0, so a frame that sets it is refused).
//   Payloads are described in MOBILE.json protocol.framing. Every frame is checked for type, flags, stream number,
//   direction, payload size and JSON object shape. Any violation is a protocol error.
//
// Session rules:
//   - Priority types (STOP, STOP_ACK, CANCEL, PING, PONG) are written at once, ahead of everything queued, and ignore the
//     socket's buffer cap. Every other frame waits in its stream's lane until bufferedAmount is under BUFFER_CAP.
//   - Lanes are served round robin, so a large body on one stream does not hold up a request on another.
//   - DATA chunks under COALESCE_BELOW bytes wait up to COALESCE_MS to be joined into one frame. A FIN or a larger
//     chunk on the same stream flushes them first.
//   - BODY and DATA payloads are cut into CHUNK-byte frames. FIN is set on the last frame of a direction only.
//   - CANCEL drops the queued frames of its stream, retires the stream and invokes handlers.abort once, in either
//     direction. A stream's later frames are ignored, not processed.
//   - A protocol error sends CLOSE { reason: 'protocol' }, closes the transport, and nothing after it is processed.
//   - Liveness: a PING goes out at start and at every interval. A PING still unanswered at the next tick is one miss;
//     at PING_MISSES_TO_CLOSE misses the session closes with reason 'timeout'.
//   - Wire budget (opt-in, options.wireBytesPerSecond): a token bucket for the non-priority frames, so a session over the relay stays under
//     the relay's per-phone limit (relay/src/limits.mjs phoneBytesPerSecond, 2 MiB a second counted at the encrypted size of each message).
//     Priority frames never wait for it. The default is no budget, which is what LAN and Tailscale sessions and every test use.
//
// Buffer ownership: a body or data chunk is held by reference until it is written, so the caller must not reuse
// the buffer after handing it over. Small DATA chunks are copied when they are coalesced.

export const TYPE = Object.freeze({
  HELLO: 0x01, REQ: 0x02, BODY: 0x03, RES: 0x04, DATA: 0x05, CANCEL: 0x06,
  STOP: 0x07, STOP_ACK: 0x08, PING: 0x09, PONG: 0x0a, EVENT: 0x0b, CLOSE: 0x0c, COOKIE: 0x7f,
});
export const FLAG = Object.freeze({ FIN: 0x01, PRIORITY: 0x02, COMPRESSED: 0x04 });
export const HEADER_BYTES = 6;
export const MAX_NOISE_MESSAGE = 65535;
export const MAX_PLAINTEXT = 65519;
export const CHUNK = 32768;
export const BUFFER_CAP = 262144;
export const COALESCE_MS = 30;
export const COALESCE_BELOW = 1024;
export const MAX_STREAMS = 32;
export const MAX_BODY_BYTES = 40000000;
export const PING_INTERVAL_MS = 25000;
export const PING_MISSES_TO_CLOSE = 2;
export const POLL_MS = 10;
// The relay budget of a phone session (B-123): under the relay's 2 MiB a second with room for the priority frames and the Noise tag of each message.
export const WIRE_BUDGET_BYTES_PER_SECOND = 1536 * 1024;
export const WIRE_BUDGET_BURST_BYTES = 128 * 1024;
export const NOISE_TAG_BYTES = 16;   // lib/remote/noise.mjs TAG_LEN, added to every transport message

const { HELLO, REQ, BODY, RES, DATA, CANCEL, STOP, STOP_ACK, PING, PONG, EVENT, CLOSE, COOKIE } = TYPE;
const NAMES = new Map(Object.entries(TYPE).map(([name, code]) => [code, name]));
const PRIORITY_TYPES = new Set([STOP, STOP_ACK, CANCEL, PING, PONG]);
const CONTROL_TYPES = new Set([HELLO, STOP, STOP_ACK, PING, PONG, EVENT, CLOSE, COOKIE]);
const STREAM_TYPES = new Set([REQ, BODY, RES, DATA, CANCEL]);
const JSON_TYPES = new Set([HELLO, REQ, RES, STOP, STOP_ACK, EVENT, CLOSE]);
const FROM_PHONE = new Set([REQ, BODY, STOP]);
const FROM_DESKTOP = new Set([HELLO, RES, DATA, STOP_ACK, EVENT]);
const KNOWN_FLAGS = FLAG.FIN | FLAG.PRIORITY;
const EMPTY = new Uint8Array(0);
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

const hex = n => `0x${n.toString(16).padStart(2, '0')}`;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const tag = Object.prototype.toString.call(input);
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return new Uint8Array(input);
  throw new TypeError('a frame must be bytes');
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concatBytes(parts, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

// Shape rules shared by encoding and decoding. Messages name types and sizes only, never payload content.
function checkShape(type, stream, flags, length) {
  if (!NAMES.has(type)) throw new FrameError('type', `unknown frame type ${hex(type)}`);
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) throw new FrameError('stream', 'stream id out of range');
  if (flags & ~KNOWN_FLAGS) throw new FrameError('flags', `reserved flag bits ${hex(flags)} set`);
  if (CONTROL_TYPES.has(type) && stream !== 0) throw new FrameError('stream', `${NAMES.get(type)} belongs on stream 0`);
  if (STREAM_TYPES.has(type) && stream === 0) throw new FrameError('stream', `${NAMES.get(type)} needs a stream id`);
  if ((type === PING || type === PONG) && length !== 8) throw new FrameError('payload', `${NAMES.get(type)} carries an 8-byte nonce`);
  if ((type === BODY || type === DATA) && length > CHUNK) throw new FrameError('payload', `${NAMES.get(type)} payload over ${CHUNK} bytes`);
  if (HEADER_BYTES + length > MAX_PLAINTEXT) throw new FrameError('size', 'frame over max_plaintext');
}

function parseObject(bytes) {
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    throw new FrameError('json', 'payload is not UTF-8 JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FrameError('json', 'payload is not a JSON object');
  return value;
}

// The bytes of a JSON payload. The value must be a plain object, as every JSON type in the table is.
export function jsonBytes(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FrameError('json', 'JSON payload must be an object');
  return utf8Encoder.encode(JSON.stringify(value));
}

// Encodes one frame. The PRIORITY bit is set for the priority types whatever flags the caller passed.
export function encodeFrame(type, stream = 0, flags = 0, payload) {
  const body = payload == null ? EMPTY : toBytes(payload);
  checkShape(type, stream, flags, body.byteLength);
  const out = new Uint8Array(HEADER_BYTES + body.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream, false);
  out[5] = flags | (PRIORITY_TYPES.has(type) ? FLAG.PRIORITY : 0);
  out.set(body, HEADER_BYTES);
  return out;
}

export function encodeJsonFrame(type, stream, flags, value) {
  if (!JSON_TYPES.has(type)) throw new FrameError('type', `${NAMES.get(type) ?? hex(type)} does not carry JSON`);
  return encodeFrame(type, stream, flags, jsonBytes(value));
}

// Decodes one transport message. Returns { type, stream, flags, payload, value }; value is the parsed JSON object for the
// JSON types and undefined otherwise. payload is a view into the input. Throws FrameError on any violation.
export function decodeFrame(input) {
  const bytes = toBytes(input);
  if (bytes.byteLength < HEADER_BYTES) throw new FrameError('short', 'frame is shorter than its header');
  const type = bytes[0];
  const stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  const flags = bytes[5];
  const payload = bytes.subarray(HEADER_BYTES);
  checkShape(type, stream, flags, payload.byteLength);
  const value = JSON_TYPES.has(type) ? parseObject(payload) : undefined;
  return { type, stream, flags, payload, value };
}

// Clock used when none is injected. Timers are not unref'd, so a pending flush keeps a Node process alive.
export function systemClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: handle => globalThis.clearInterval(handle),
  };
}

function randomNonce() {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

// The streams of one session. localBit is 1 for the phone (it opens odd ids) and 0 for the desktop (even ids).
export class StreamTable {
  constructor({ localBit, max = MAX_STREAMS }) {
    this.localBit = localBit ? 1 : 0;
    this.max = max;
    this.entries = new Map();
    this.nextLocal = this.localBit ? 1 : 2;
    this.lastRemote = 0;
  }

  get size() {
    return this.entries.size;
  }

  isLocal(id) {
    return (id & 1) === this.localBit;
  }

  get(id) {
    return this.entries.get(id);
  }

  // Opens a stream on this side. Returns its entry, or null when the table already holds max open streams.
  allocate() {
    if (this.entries.size >= this.max || this.nextLocal > 0xfffffffe) return null;
    const id = this.nextLocal;
    this.nextLocal += 2;
    this.entries.set(id, { id, opener: 'local', localFin: false, remoteFin: false, aborted: false });
    return this.entries.get(id);
  }

  // Admits a stream the other side opened. It must carry the other side's parity and a larger id than any before it.
  admitRemote(id) {
    if (this.isLocal(id)) throw new FrameError('parity', `stream ${id} has this side's parity`);
    if (id <= this.lastRemote) throw new FrameError('order', `stream ${id} is not a new stream`);
    if (this.entries.size >= this.max) throw new FrameError('cap', `more than ${this.max} open streams`);
    this.lastRemote = id;
    this.entries.set(id, { id, opener: 'remote', localFin: false, remoteFin: false, aborted: false });
    return this.entries.get(id);
  }

  delete(id) {
    this.entries.delete(id);
  }

  // True for an id this table once held and has retired. A frame for such an id crossed a CANCEL or a last FIN.
  isStale(id) {
    return this.isLocal(id) ? id < this.nextLocal : id <= this.lastRemote;
  }
}

export class FrameSession {
  constructor(options = {}) {
    const { role } = options;
    if (role !== 'phone' && role !== 'desktop') throw new TypeError("role must be 'phone' or 'desktop'");
    if (!options.transport || typeof options.transport.send !== 'function' || typeof options.transport.close !== 'function') {
      throw new TypeError('transport needs send(bytes) and close(code, reason)');
    }
    this.role = role;
    this.transport = options.transport;
    this.bufferedFn = typeof options.bufferedAmount === 'function' ? options.bufferedAmount : null;
    this.clock = options.clock ?? systemClock();
    this.handlers = options.handlers ?? {};
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.nonce = options.nonce ?? randomNonce;
    this.streams = new StreamTable({ localBit: role === 'phone' ? 1 : 0, max: options.maxStreams ?? MAX_STREAMS });
    this.lanes = new Map();
    this.ready = [];
    this.coalesce = new Map();
    this.pollTimer = null;
    this.live = { intervalMs: 0, limit: 0, outstanding: null, misses: 0, timer: null };
    const rate = Number(options.wireBytesPerSecond ?? Infinity);
    const burst = Number(options.wireBurstBytes ?? WIRE_BUDGET_BURST_BYTES);
    this.budget = { rate: rate > 0 ? rate : Infinity, burst, tokens: burst, last: this.clock.now() };
    this.closed = false;
    this.closeReason = null;
    this.counts = { written: 0, dropped: 0 };
  }

  get isClosed() {
    return this.closed;
  }

  get openStreams() {
    return this.streams.size;
  }

  // True while a PING has been sent and its PONG has not come back (the phone's probe of a session that may have died silently).
  get pingOutstanding() {
    return this.live.outstanding !== null;
  }

  // Takes one transport message in. Returns false once the session is closed.
  receive(input) {
    if (this.closed) return false;
    let frame;
    try {
      frame = decodeFrame(input);
    } catch (err) {
      this.#protocol(err.message);
      return false;
    }
    this.#dispatch(frame);
    return !this.closed;
  }

  // Phone: opens a stream with a REQ frame. Returns the stream id, or null at the stream cap or when closed.
  // { fin: true } marks a request without a body, so the REQ carries the FIN.
  request(value, { fin = false } = {}) {
    if (this.role !== 'phone') throw new TypeError('only the phone opens streams (REQ)');
    if (this.closed) return null;
    const payload = jsonBytes(value);
    const entry = this.streams.allocate();
    if (!entry) return null;
    if (fin) entry.localFin = true;
    this.#enqueue(entry.id, REQ, fin ? FLAG.FIN : 0, payload);
    this.#release(entry.id);
    return entry.id;
  }

  // Desktop: answers a stream the phone opened, with a RES frame.
  respond(id, value, { fin = false } = {}) {
    if (this.role !== 'desktop') throw new TypeError('only the desktop answers (RES)');
    const entry = this.#writable(id);
    if (!entry) return false;
    const payload = jsonBytes(value);
    if (fin) entry.localFin = true;
    this.#enqueue(id, RES, fin ? FLAG.FIN : 0, payload);
    this.#release(id);
    return true;
  }

  // Phone: request body bytes, cut into BODY frames of at most CHUNK bytes. { fin: true } ends the body.
  body(id, bytes, { fin = false } = {}) {
    if (this.role !== 'phone') throw new TypeError('only the phone sends BODY');
    return this.#sendStreamBytes(BODY, id, bytes, fin);
  }

  // Desktop: response bytes, cut into DATA frames. Small chunks are coalesced for up to COALESCE_MS.
  data(id, bytes, { fin = false } = {}) {
    if (this.role !== 'desktop') throw new TypeError('only the desktop sends DATA');
    const entry = this.#writable(id);
    if (!entry) return false;
    const view = toBytes(bytes);
    if (fin) entry.localFin = true;
    if (view.byteLength === 0 && !fin) return true;
    if (view.byteLength >= COALESCE_BELOW) {
      this.#flushCoalesce(id);
      this.#chunk(DATA, id, view, fin);
    } else {
      let pending = this.coalesce.get(id);
      if (!pending) {
        pending = { parts: [], bytes: 0, fin: false, timer: null };
        this.coalesce.set(id, pending);
      }
      pending.parts.push(view.slice());
      pending.bytes += view.byteLength;
      pending.fin = pending.fin || fin;
      if (pending.fin || pending.bytes >= COALESCE_BELOW) this.#flushCoalesce(id);
      else if (pending.timer === null) pending.timer = this.clock.setTimeout(() => this.#flushCoalesce(id), this.coalesceMs);
    }
    this.#release(id);
    return true;
  }

  // Either side: aborts a stream. Queued frames of the stream are dropped, a CANCEL goes out at once, and the abort
  // hook runs once. Returns false when the stream is not open here.
  cancel(id) {
    if (this.closed) return false;
    return this.#abort(id, 'local');
  }

  // Desktop: HELLO on stream 0, paced like other non-priority frames.
  hello(value) {
    if (this.role !== 'desktop') throw new TypeError('only the desktop sends HELLO');
    if (this.closed) return false;
    this.#enqueue(0, HELLO, 0, jsonBytes(value));
    return true;
  }

  // Desktop: EVENT on stream 0, paced like other non-priority frames.
  event(value) {
    if (this.role !== 'desktop') throw new TypeError('only the desktop sends EVENT');
    if (this.closed) return false;
    this.#enqueue(0, EVENT, 0, jsonBytes(value));
    return true;
  }

  // Phone: STOP on the priority lane.
  stop(value) {
    if (this.role !== 'phone') throw new TypeError('only the phone sends STOP');
    if (this.closed) return false;
    return this.#sendPriority(STOP, 0, jsonBytes(value));
  }

  // Desktop: STOP_ACK on the priority lane.
  stopAck(value) {
    if (this.role !== 'desktop') throw new TypeError('only the desktop sends STOP_ACK');
    if (this.closed) return false;
    return this.#sendPriority(STOP_ACK, 0, jsonBytes(value));
  }

  // PING on the priority lane. The nonce is remembered until its PONG arrives.
  ping() {
    if (this.closed) return false;
    const nonce = this.nonce();
    this.live.outstanding = nonce;
    return this.#sendPriority(PING, 0, nonce);
  }

  startLiveness({ intervalMs = PING_INTERVAL_MS, misses = PING_MISSES_TO_CLOSE } = {}) {
    if (this.closed) return false;
    this.#stopLiveness();
    this.live.intervalMs = intervalMs;
    this.live.limit = misses;
    this.live.misses = 0;
    this.live.outstanding = null;
    this.live.timer = this.clock.setInterval(() => this.#tick(), intervalMs);
    this.#tick(true);
    return true;
  }

  stopLiveness() {
    this.#stopLiveness();
  }

  // Sends CLOSE { reason } on the control stream, then closes the transport. Queued frames are dropped.
  close(reason = 'normal') {
    if (this.closed) return;
    this.#sendClose(String(reason));
    this.#shutdown(String(reason));
  }

  #dispatch({ type, stream, flags, payload, value }) {
    if ((this.role === 'phone' && FROM_PHONE.has(type)) || (this.role === 'desktop' && FROM_DESKTOP.has(type))) {
      return this.#protocol(`${NAMES.get(type)} is not sent to the ${this.role}`);
    }
    const fin = (flags & FLAG.FIN) !== 0;
    switch (type) {
      case REQ: return this.#onOpen(stream, value, fin);
      case BODY:
      case RES:
      case DATA: return this.#onStreamFrame(type, stream, payload, fin, value);
      case CANCEL: return this.#onCancel(stream);
      case HELLO: return void this.handlers.hello?.(value);
      case EVENT: return void this.handlers.event?.(value);
      case STOP: return void this.handlers.stop?.(value);
      case STOP_ACK: return void this.handlers.stopAck?.(value);
      case PING: return void this.#sendPriority(PONG, 0, payload);
      case PONG: return this.#onPong(payload);
      case CLOSE: return this.#onPeerClose(value);
      default: return this.#protocol(`${NAMES.get(type)} is not valid inside a session`);
    }
  }

  #onOpen(stream, value, fin) {
    let entry;
    try {
      entry = this.streams.admitRemote(stream);
    } catch (err) {
      return this.#protocol(err.message);
    }
    if (fin) entry.remoteFin = true;
    this.handlers.req?.(stream, value, fin);
    this.#release(stream);
  }

  #onStreamFrame(type, stream, payload, fin, value) {
    const entry = this.streams.get(stream);
    if (!entry) {
      if (this.streams.isStale(stream)) return;
      return this.#protocol(`${NAMES.get(type)} on stream ${stream} that was never opened`);
    }
    if (entry.remoteFin) return this.#protocol(`${NAMES.get(type)} after FIN on stream ${stream}`);
    if (fin) entry.remoteFin = true;
    if (type === BODY) this.handlers.body?.(stream, payload, fin);
    else if (type === DATA) this.handlers.data?.(stream, payload, fin);
    else this.handlers.res?.(stream, value, fin);
    this.#release(stream);
  }

  #onCancel(stream) {
    if (!this.streams.get(stream)) {
      if (this.streams.isStale(stream)) return;
      return this.#protocol(`CANCEL on stream ${stream} that was never opened`);
    }
    this.#abort(stream, 'remote');
  }

  #onPong(payload) {
    const outstanding = this.live.outstanding;
    if (outstanding && bytesEqual(outstanding, payload)) {
      this.live.outstanding = null;
      this.live.misses = 0;
    }
  }

  #onPeerClose(value) {
    this.handlers.close?.(value);
    const reason = typeof value?.reason === 'string' ? value.reason.slice(0, 64) : 'peer';
    this.#shutdown(reason);
  }

  #protocol(message) {
    if (this.closed) return;
    this.handlers.protocolError?.(message);
    this.#sendClose('protocol');
    this.#shutdown('protocol');
  }

  #sendClose(reason) {
    try {
      this.transport.send(encodeJsonFrame(CLOSE, 0, 0, { reason }));
    } catch {
      // The socket is already gone; the close below still runs.
    }
  }

  #shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.pollTimer !== null) {
      this.clock.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const pending of this.coalesce.values()) {
      if (pending.timer !== null) this.clock.clearTimeout(pending.timer);
    }
    this.coalesce.clear();
    this.#stopLiveness();
    this.lanes.clear();
    this.ready = [];
    try {
      this.transport.close(reason === 'protocol' ? 1002 : 1000, reason);
    } catch {
      // Already closed.
    }
    this.handlers.closed?.(reason);
  }

  #stopLiveness() {
    if (this.live.timer !== null) {
      this.clock.clearInterval(this.live.timer);
      this.live.timer = null;
    }
  }

  #tick(first = false) {
    if (this.closed) return;
    if (!first && this.live.outstanding !== null) {
      this.live.misses += 1;
      if (this.live.misses >= this.live.limit) {
        this.#sendClose('timeout');
        this.#shutdown('timeout');
        return;
      }
    }
    this.ping();
  }

  #buffered() {
    if (this.bufferedFn) return Number(this.bufferedFn()) || 0;
    return Number(this.transport.bufferedAmount) || 0;
  }

  #write(type, stream, flags, payload) {
    const bytes = encodeFrame(type, stream, flags, payload);
    try {
      this.transport.send(bytes);
    } catch {
      this.#shutdown('transport');
      return false;
    }
    this.counts.written += 1;
    return true;
  }

  #sendPriority(type, stream, payload) {
    if (this.closed) return false;
    return this.#write(type, stream, 0, payload);
  }

  #enqueue(stream, type, flags, payload) {
    checkShape(type, stream, flags, payload.byteLength);
    let lane = this.lanes.get(stream);
    if (!lane) {
      lane = { id: stream, frames: [], head: 0 };
      this.lanes.set(stream, lane);
    }
    lane.frames.push({ type, flags, payload });
    if (!this.ready.includes(lane)) this.ready.push(lane);
    this.#pump();
  }

  // Takes the wire bytes of one non-priority frame from the budget. False while the budget is spent; it refills with the clock.
  #admitWire(payloadBytes) {
    const b = this.budget;
    if (!Number.isFinite(b.rate)) return true;
    const now = this.clock.now();
    b.tokens = Math.min(b.burst, b.tokens + (Math.max(0, now - b.last) * b.rate) / 1000);
    b.last = now;
    const cost = HEADER_BYTES + payloadBytes + NOISE_TAG_BYTES;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  // Writes queued frames round robin while the socket's buffer is under the cap and the wire budget has room. When either is not, retries on a timer.
  #pump() {
    while (!this.closed && this.ready.length > 0) {
      if (this.#buffered() >= BUFFER_CAP) {
        this.#schedulePoll();
        return;
      }
      const head = this.ready[0];
      if (!this.#admitWire(head.frames[head.head].payload.byteLength)) {
        this.#schedulePoll();
        return;
      }
      const lane = this.ready.shift();
      const frame = lane.frames[lane.head];
      lane.frames[lane.head] = undefined;
      lane.head += 1;
      if (lane.head < lane.frames.length) {
        this.ready.push(lane);
      } else {
        lane.frames = [];
        lane.head = 0;
        if (this.lanes.get(lane.id) === lane) this.lanes.delete(lane.id);
      }
      this.#write(frame.type, lane.id, frame.flags, frame.payload);
    }
  }

  #schedulePoll() {
    if (this.pollTimer !== null) return;
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      this.#pump();
    }, this.pollMs);
  }

  #writable(id) {
    if (this.closed) return null;
    const entry = this.streams.get(id);
    if (!entry || entry.localFin || entry.aborted) return null;
    return entry;
  }

  #sendStreamBytes(type, id, bytes, fin) {
    const entry = this.#writable(id);
    if (!entry) return false;
    const data = toBytes(bytes);
    if (fin) entry.localFin = true;
    this.#chunk(type, id, data, fin);
    this.#release(id);
    return true;
  }

  #chunk(type, id, data, fin) {
    if (data.byteLength === 0) {
      this.#enqueue(id, type, fin ? FLAG.FIN : 0, EMPTY);
      return;
    }
    for (let offset = 0; offset < data.byteLength; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, data.byteLength);
      const last = end === data.byteLength;
      this.#enqueue(id, type, fin && last ? FLAG.FIN : 0, data.subarray(offset, end));
      if (this.closed) return;
    }
  }

  #flushCoalesce(id) {
    const pending = this.coalesce.get(id);
    if (!pending) return;
    this.coalesce.delete(id);
    if (pending.timer !== null) this.clock.clearTimeout(pending.timer);
    this.#chunk(DATA, id, concatBytes(pending.parts, pending.bytes), pending.fin);
  }

  #dropStream(id) {
    const lane = this.lanes.get(id);
    if (lane) {
      this.counts.dropped += lane.frames.length - lane.head;
      this.lanes.delete(id);
      this.ready = this.ready.filter(item => item !== lane);
    }
    const pending = this.coalesce.get(id);
    if (pending) {
      if (pending.timer !== null) this.clock.clearTimeout(pending.timer);
      this.coalesce.delete(id);
    }
  }

  #abort(id, origin) {
    const entry = this.streams.get(id);
    if (!entry || entry.aborted) return false;
    entry.aborted = true;
    this.#dropStream(id);
    this.streams.delete(id);
    if (origin === 'local') this.#sendPriority(CANCEL, id, EMPTY);
    this.handlers.abort?.(id, origin);
    return true;
  }

  #release(id) {
    const entry = this.streams.get(id);
    if (entry && entry.localFin && entry.remoteFin) this.streams.delete(id);
  }
}
