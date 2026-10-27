// A phone, in Node, for the Bridge suites (mob-03). It speaks the real protocol: the global WebSocket (or the `ws` client when a test needs
// to set Origin), lib/remote/noise.mjs for the handshake and lib/remote/frames.mjs for the frames, so every byte it sends is what a
// phone would send. Nothing here is a shortcut around the Bridge.
//
//   const phone = createPhone({ name: "Will's iPhone", platform: 'ios' });
//   const paired = await phone.pair(decodeLink(link));       // IKpsk2 over the first URL of the first carrier; resolves after message 2
//   paired.code            the 6-digit check code the phone would show ('482913')
//   const live = await paired.hello                           // resolves with HELLO once the person pressed Allow (or rejects with the CLOSE)
//   const session = await phone.connect(desktopPublic, url)   // Noise IK for an already paired phone; session.hello is HELLO
//   const res = await session.request('GET', '/api/state');  // { status, headers, text(), json(), bytes }
//   const ack = await session.stop('0123abcd');              // STOP, resolves with the STOP_ACK
//
// Options that make a phone misbehave on purpose: pair(payload, { wrongFirst: true }) sends random bytes instead of the first transport
// message (a phone that does not hold the pairing secret), { skipFirst: true } sends nothing, { counter } sets the handshake counter.
import {
  deviceId, generateKeyPair, handshakeInitiator, parseCookieReply, prologue, sas as sasOf, sealMessage1,
} from '../../../lib/remote/noise.mjs';
import { FrameSession } from '../../../lib/remote/frames.mjs';

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export const b64uDecode = text => new Uint8Array(Buffer.from(text, 'base64url'));

// The pairing payload inside a link: https://host/p/<key>/#pair=<b64>, http://ip:port/p/<key>/#pair=<b64> or plenum://pair#<b64>.
export function decodeLink(link) {
  const m = /[#&]pair=([A-Za-z0-9_-]+)$/.exec(link) ?? /^plenum:\/\/pair#([A-Za-z0-9_-]+)$/.exec(link);
  if (!m) throw new Error('not a pairing link');
  return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(fn, label = 'a condition', ms = 8000, step = 10) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(step);
  }
}

export class ChannelClosed extends Error {
  constructor(code, reason) {
    super(`closed ${code} ${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

// One WebSocket. Before the handshake ends, messages are read with next(); afterwards onMessage takes them.
export function openChannel(url, { WebSocketImpl = globalThis.WebSocket, wsOptions } = {}) {
  return new Promise((resolve, reject) => {
    const ws = wsOptions ? new WebSocketImpl(url, wsOptions) : new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    const queue = [];
    let waiter = null;
    let closedInfo = null;
    let settled = false;
    let resolveClosed;
    const closed = new Promise(r => { resolveClosed = r; });
    let handler = null;
    const channel = {
      ws,
      closed,
      get onMessage() { return handler; },
      // Messages that arrived before a handler was set are given to it at once.
      set onMessage(fn) {
        handler = fn;
        while (handler && queue.length) handler(queue.shift());
      },
      onClose: null,
      get bufferedAmount() { return ws.bufferedAmount; },
      get isClosed() { return closedInfo !== null; },
      get closeInfo() { return closedInfo; },
      send(bytes) { ws.send(bytes); },
      close(code = 1000, reason = '') { try { ws.close(code, reason); } catch { /* already closed */ } },
      next(timeoutMs = 5000) {
        if (queue.length) return Promise.resolve(queue.shift());
        if (closedInfo) return Promise.reject(new ChannelClosed(closedInfo.code, closedInfo.reason));
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { waiter = null; rej(new Error('timed out waiting for a message')); }, timeoutMs);
          waiter = { resolve: v => { clearTimeout(timer); res(v); }, reject: e => { clearTimeout(timer); rej(e); } };
        });
      },
    };
    ws.addEventListener('message', event => {
      const bytes = new Uint8Array(event.data);
      if (handler) handler(bytes);
      else if (waiter) { const w = waiter; waiter = null; w.resolve(bytes); } else queue.push(bytes);
    });
    ws.addEventListener('close', event => {
      closedInfo = { code: event.code, reason: event.reason ?? '' };
      resolveClosed(closedInfo);
      if (waiter) { const w = waiter; waiter = null; w.reject(new ChannelClosed(closedInfo.code, closedInfo.reason)); }
      channel.onClose?.(closedInfo);
      if (!settled) { settled = true; reject(new ChannelClosed(closedInfo.code, closedInfo.reason)); }
    });
    ws.addEventListener('error', () => { /* a close event follows */ });
    ws.addEventListener('open', () => { settled = true; resolve(channel); });
  });
}

// The frame session of a finished handshake, with the response bookkeeping a test wants.
function liveSession({ channel, cs, hello: initialHello = null, now = () => performance.now(), keepRaw = false, rawFirst = null }) {
  const streams = new Map();
  const raw = rawFirst ? [rawFirst] : [];
  const events = [];
  const closeFrames = [];
  const stopAcks = new Map();
  const stopWaiters = new Map();
  let helloValue = initialHello;
  let helloResolve;
  let helloReject;
  const helloPromise = initialHello ? Promise.resolve(initialHello) : new Promise((res, rej) => { helloResolve = res; helloReject = rej; });
  helloPromise.catch(() => {});
  let resolveClosed;
  const closed = new Promise(r => { resolveClosed = r; });

  const settle = (entry, error) => {
    if (entry.settled) return;
    entry.settled = true;
    if (error) entry.rejectDone(error);
    else entry.resolveDone(entry);
  };

  const frames = new FrameSession({
    role: 'phone',
    transport: {
      send: bytes => channel.send(cs.send.encrypt(bytes)),
      close: (code, reason) => channel.close(code, reason),
      get bufferedAmount() { return channel.bufferedAmount; },
    },
    handlers: {
      hello: value => { helloValue = value; helloResolve?.(value); },
      res: (id, value, fin) => {
        const entry = streams.get(id);
        if (!entry) return;
        entry.status = value.status;
        entry.headers = value.headers ?? {};
        entry.headAt = now();
        entry.resolveHead(entry);
        if (fin) settle(entry);
      },
      data: (id, bytes, fin) => {
        const entry = streams.get(id);
        if (!entry) return;
        if (bytes.byteLength) {
          entry.chunks.push({ at: now(), bytes: new Uint8Array(bytes) });
          entry.onData?.(entry.chunks.at(-1));
        }
        if (fin) settle(entry);
      },
      event: value => events.push(value),
      stopAck: value => {
        stopAcks.set(value.id, { ...value, at: now() });
        stopWaiters.get(value.id)?.(stopAcks.get(value.id));
      },
      close: value => { closeFrames.push(value); helloReject?.(Object.assign(new Error(`CLOSE ${value?.reason}`), { reason: value?.reason })); },
      abort: id => {
        const entry = streams.get(id);
        if (entry) { entry.cancelled = true; entry.resolveHead(entry); settle(entry); }
      },
      closed: reason => {
        helloReject?.(Object.assign(new Error(`closed ${reason}`), { reason }));
        for (const entry of streams.values()) { entry.resolveHead(entry); settle(entry); }
        resolveClosed({ reason, frames: closeFrames.map(f => f?.reason), socket: channel.closeInfo });
      },
    },
  });

  const decorate = entry => {
    const bytes = () => {
      const total = entry.chunks.reduce((n, c) => n + c.bytes.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of entry.chunks) { out.set(c.bytes, at); at += c.bytes.byteLength; }
      return out;
    };
    entry.bytes = bytes;
    entry.text = () => utf8Decoder.decode(bytes());
    entry.json = () => JSON.parse(entry.text());
    return entry;
  };

  const open = (method, path, { body, headers = {}, bodyLength, fin } = {}) => {
    const payload = body === undefined || body === null ? null : (typeof body === 'string' ? utf8.encode(body) : body instanceof Uint8Array ? body : utf8.encode(JSON.stringify(body)));
    const sendHeaders = { ...(payload && !headers['content-type'] ? { 'content-type': 'application/json' } : {}), ...headers };
    let resolveHead;
    let resolveDone;
    let rejectDone;
    const entry = {
      id: 0, status: 0, headers: null, chunks: [], settled: false, cancelled: false, headAt: 0, openedAt: now(),
      head: new Promise(r => { resolveHead = r; }),
      done: new Promise((res, rej) => { resolveDone = res; rejectDone = rej; }),
      resolveHead, resolveDone, rejectDone,
    };
    entry.done.catch(() => {});
    const req = { method, path, headers: sendHeaders, ...(bodyLength !== undefined ? { bodyLength } : payload ? { bodyLength: payload.byteLength } : {}) };
    const id = frames.request(req, { fin: fin ?? !payload });
    if (id === null) throw new Error('no stream available');
    entry.id = id;
    streams.set(id, entry);
    decorate(entry);
    if (payload) frames.body(id, payload, { fin: true });
    return entry;
  };

  const session = {
    frames,
    channel,
    raw,
    events,
    closeFrames,
    closed,
    get hello() { return helloValue; },
    helloPromise,
    // Opens a stream and waits for the whole response.
    async request(method, path, options = {}) {
      const entry = open(method, path, options);
      await entry.done;
      return entry;
    },
    // Opens a stream and returns at once; entry.head resolves with the RES, entry.done at the last DATA.
    open,
    cancel(entry) { frames.cancel(entry.id); },
    // STOP on the priority lane. Resolves with the STOP_ACK and the milliseconds it took.
    stop(id, project) {
      const started = now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no STOP_ACK')), 8000);
        stopWaiters.set(id, ack => { clearTimeout(timer); resolve({ ...ack, ms: ack.at - started }); });
        frames.stop({ id, ...(project ? { project } : {}) });
      });
    },
    close(reason = 'normal') { frames.close(reason); },
  };
  channel.onMessage = bytes => {
    let plain;
    try {
      plain = cs.recv.decrypt(bytes);
    } catch {
      frames.close('protocol');
      return;
    }
    if (keepRaw) raw.push(plain);
    frames.receive(plain);
  };
  channel.onClose = () => { if (!frames.isClosed) frames.close('transport'); };
  return session;
}

export function createPhone(options = {}) {
  const keys = options.keys ?? generateKeyPair();
  const device = {
    name: options.name ?? 'Test phone',
    platform: options.platform ?? 'ios',
    app: options.app ?? 'pwa',
    appVersion: options.appVersion ?? '1.0.0',
    uiHash: '',
  };
  const caps = options.caps ?? ['ui-from-desktop', 'artifacts-iframe', 'push-webpush'];
  let counter = options.counter ?? 0;
  const id = deviceId(keys.publicKey);

  // Sends message 1 (with mac1) and reads message 2, answering one cookie reply on the way. Returns the finished handshake.
  async function handshake(channel, { desktopPublic, carrier, offerId, psk, payload }) {
    const hs = handshakeInitiator({
      staticPrivate: keys.privateKey,
      remoteStaticPublic: desktopPublic,
      prologue: prologue(carrier, offerId),
      ...(psk ? { psk } : {}),
    });
    const body = hs.writeMessage1(utf8.encode(JSON.stringify(payload)));
    channel.send(sealMessage1(desktopPublic, body));
    let reply = await channel.next();
    const cookie = parseCookieReply(reply);
    if (cookie) {
      channel.send(sealMessage1(desktopPublic, body, cookie));
      reply = await channel.next();
    }
    const message2 = hs.readMessage2(reply);
    const cs = hs.finish();
    return { cs, message2 };
  }

  return {
    keys,
    id,
    device,
    get counter() { return counter; },
    set counter(value) { counter = value; },

    // IKpsk2 against the first URL of the first carrier in the pairing payload (or opts.url).
    async pair(link, opts = {}) {
      const desktopPublic = b64uDecode(link.pub);
      const psk = opts.wrongPsk ? new Uint8Array(32).fill(7) : b64uDecode(link.psk);
      const carrier = opts.carrier ?? 'lan';
      const first = link.carriers?.find(c => c.kind === carrier) ?? link.carriers?.[0];
      const url = opts.url ?? first?.urls?.[0] ?? first?.url;
      const channel = await openChannel(url, { WebSocketImpl: opts.WebSocketImpl, wsOptions: opts.wsOptions });
      counter = opts.counter ?? counter + 1;
      const payload = { v: '1.0', kind: 'pair', counter, offer: link.offer, device: { ...device, ...(opts.device ?? {}) }, caps };
      const { cs, message2 } = await handshake(channel, { desktopPublic, carrier, offerId: link.offer, psk, payload });
      const state = JSON.parse(utf8Decoder.decode(message2));
      const session = liveSession({ channel, cs, keepRaw: opts.keepRaw === true });
      const code = sasOf(cs.handshakeHash);
      if (opts.wrongFirst) channel.send(new Uint8Array(40).fill(9));
      else if (!opts.skipFirst) session.frames.startLiveness({ intervalMs: 25000, misses: 2 }); // the first message is a PING
      return { code, state, session, hello: session.helloPromise, closed: session.closed, desktopPublic, channel };
    },

    // Noise IK for a phone the computer holds.
    async connect(desktopPublic, url, opts = {}) {
      const channel = await openChannel(url, { WebSocketImpl: opts.WebSocketImpl, wsOptions: opts.wsOptions });
      counter = opts.counter ?? counter + 1;
      const payload = {
        v: opts.version ?? '1.0', kind: 'session', counter, device: { ...device, ...(opts.device ?? {}) }, caps,
        ...(opts.stop ? { stop: opts.stop } : {}),
      };
      const { cs, message2 } = await handshake(channel, { desktopPublic, carrier: opts.carrier ?? 'lan', payload });
      const hello = JSON.parse(utf8Decoder.decode(message2));
      const session = liveSession({ channel, cs, hello, keepRaw: opts.keepRaw === true, rawFirst: opts.keepRaw ? utf8.encode(JSON.stringify(hello)) : null });
      if (opts.liveness !== false) session.frames.startLiveness({ intervalMs: 25000, misses: 2 });
      return session;
    },

    // For the DoS tests: only the handshake bytes, no session. Resolves what the desktop answered first.
    async sendMessage1(url, desktopPublic, opts = {}) {
      const channel = await openChannel(url, { WebSocketImpl: opts.WebSocketImpl, wsOptions: opts.wsOptions });
      counter = opts.counter ?? counter + 1;
      const hs = handshakeInitiator({ staticPrivate: keys.privateKey, remoteStaticPublic: desktopPublic, prologue: prologue(opts.carrier ?? 'lan', opts.offerId) });
      const body = hs.writeMessage1(utf8.encode(JSON.stringify({ v: '1.0', kind: 'session', counter, device, caps })));
      channel.send(sealMessage1(desktopPublic, body, opts.cookie));
      return { channel, hs, body };
    },
  };
}
