// A fake computer for the shell-core suites (mob-10). It is the desktop side of the protocol, built from the same lib/remote code the
// Bridge uses: Noise responder (IK for known phones, IKpsk2 for an offer), the counter rule (strictly higher, stored per phone),
// the frame session in the desktop role, a STOP answered with STOP_ACK, a chat stream that echoes slowly enough to be stopped, an
// approval card, and the pairing decision (Allow, Deny, expiry). Sockets are in memory (createFakeNet); nothing touches a port.
// Options (createFakeDesktop): protocolMajor (2 makes the phone say update-app, 0 update-desktop), cookieReply (the first message 1 of each
// connection is answered with a cookie reply, as a desktop under load does, and message 1 must come again with a valid mac2),
// vapidPublicKey (carried in HELLO, as the Bridge does when it has a pusher), approveStatus (409 answers an approve that carries the notification
// line the way the Bridge answers a card that changed), ignoreStops, tier. stats.pushes holds every POST /api/phones/push body.
// Stop without unlocking (plan C3): a first message that isStopOnly is answered before any mac1 or DH check: the signature is checked with the
// device's Stop key (stopKeys, derived at pairing and again on a session whose message 1 says wantStopKey, which HELLO answers with stopKeyNew),
// the counter must rise (the handshake counter), and the answer is a signed STOP_ONLY_ACK followed by close 1000 'stopped'. stats.stopOnly holds
// every STOP_ONLY seen. Options: refuseStopOnly (close 4401 'unknown'), silentStopOnly (never answers), stopCounts (counts added to the ack).
// stats.logs holds the line of every POST /_bridge/log, stats.requests also the headers of each request.
import {
  checkMac1, checkMac2, cookieReply as makeCookieReply, deviceId, generateKeyPair, handshakeResponder, prologue, splitMessage1, stopKey as deriveStopKey,
} from '../../../../lib/remote/noise.mjs';
import { FrameSession, systemClock } from '../../../../lib/remote/frames.mjs';
import { decodeStopOnly, encodeStopAck, isStopOnly, verifyStopOnly } from '../../../../lib/remote/stop-only.mjs';

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// An in-memory network: endpoints by URL, WebSocket-like sockets for the phone side.
export function createFakeNet() {
  const endpoints = new Map(); // url -> accept(ws) handler
  const live = new Set();
  let down = false;
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'arraybuffer';
      this.bufferedAmount = 0;
      this.listeners = { open: [], message: [], close: [], error: [] };
      this.peer = null;
      queueMicrotask(() => {
        const accept = endpoints.get(url);
        if (down || !accept) {
          this.readyState = 3;
          this.emit('close', { code: 1006, reason: 'refused' });
          return;
        }
        this.readyState = 1;
        this.peer = accept(this);
        live.add(this);
        this.emit('open', {});
      });
    }
    addEventListener(type, fn) { this.listeners[type].push(fn); }
    emit(type, event) { for (const fn of this.listeners[type]) fn(event); }
    // The phone sends: the desktop reads it on a later microtask.
    send(bytes) {
      if (this.readyState !== 1) throw new Error('send on a closed socket');
      // Checked at the call only: a message sent before a close still arrives, as on a real socket.
      const copy = new Uint8Array(bytes);
      queueMicrotask(() => this.peer?.onMessage(copy));
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      live.delete(this);
      queueMicrotask(() => {
        this.emit('close', { code, reason });
        this.peer?.gone?.();
      });
    }
    // The desktop sends a message to this phone socket.
    deliver(bytes) {
      if (this.readyState !== 1) return;
      const copy = bytes.slice();
      queueMicrotask(() => this.emit('message', { data: copy.buffer }));
    }
    dropFromDesktop(code = 1006, reason = 'dropped') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      live.delete(this);
      queueMicrotask(() => { this.emit('close', { code, reason }); this.peer?.gone?.(); });
    }
  }
  return {
    WebSocket: FakeWebSocket,
    listen(url, accept) { endpoints.set(url, accept); },
    unlisten(url) { endpoints.delete(url); },
    setDown(value) { down = value; },
    get down() { return down; },
    // Drops every open socket from the computer's side, as a computer that went away would.
    dropAll(reason = 'restarted') {
      for (const ws of Array.from(live)) ws.dropFromDesktop(1006, reason);
      live.clear();
    },
    get openCount() { return live.size; },
  };
}

// The computer. `endpoint` is the URL the phone dials for a carrier; every desktop call returns what the Node suites check.
const COOKIE = new Uint8Array(16).fill(0x5c);

export function createFakeDesktop({
  net, url = 'ws://fake-pc.local/b/key', carrier = 'lan', name = 'Test PC', tier = 'full', protocolMajor = 1, clock = systemClock(), ignoreStops = false,
  cookieReply = false, vapidPublicKey = null, approveStatus = 200, uiManifestHash = '', refuseStopOnly = false, silentStopOnly = false, stopCounts = null,
} = {}) {
  if (!net) throw new TypeError('createFakeDesktop needs the fake net');
  const keys = generateKeyPair();
  const deviceIdOf = pub => deviceId(pub);
  const counters = new Map(); // phone device id -> last accepted counter
  const registry = new Map(); // phone device id -> { name, pub, pushKey }
  const offers = new Map();   // offer hex -> { psk, decision: null | 'allow' | 'deny' | 'expire', waiting: [] }
  const sessions = new Set();
  const stats = { handshakes: 0, refused: 0, stops: 0, stopsSeen: [], stopAcks: [], chats: 0, cancelled: 0, approvals: [], requests: [], closes: [], cookieReplies: 0, pushes: [], stopOnly: [], logs: [] };
  const stopKeys = new Map();    // phone device id -> its Stop key (32 bytes)
  const stoppedById = new Map(); // stopId hex -> the counts answered (a resend of one press gets the same counts)
  const running = new Map(); // project -> Set of { frames, streamId, timer }
  let approvalSeq = 0;
  const approvalStreams = new Set();

  const helloFor = phoneId => ({
    v: '1.0',
    protocol: { major: protocolMajor, minor: 1 },
    desktopVersion: '1.4.2',
    generation: 1,
    startedAt: 1,
    desktopName: name,
    deviceId: phoneId,
    tier,
    uiManifestHash,
    ...(vapidPublicKey ? { vapidPublicKey } : {}),
    caps: ['events', 'chat', 'approvals', 'stop-all', 'ui-manifest'],
    minShell: '1.0.0',
    pending: { approvals: approvalStreams.size, running: running.size },
  });

  function sessionFrames(s, phoneId, cs) {
    const frames = new FrameSession({
      role: 'desktop',
      clock,
      transport: {
        send: bytes => s.ws.deliver(cs.send.encrypt(bytes)),
        close: (code, reason) => s.ws.dropFromDesktop(code === 1002 ? 1002 : 1000, reason),
      },
      bufferedAmount: () => 0,
      handlers: {
        // A request with a body is answered only once its body has arrived (the FIN of the BODY frames).
        req: (stream, value, fin) => {
          if (!fin && String(value?.method ?? '').toUpperCase() === 'POST') {
            s.pending.set(stream, value);
            return;
          }
          onRequest(s, frames, stream, value, fin);
        },
        body: (stream, bytes, fin) => {
          s.bodies.set(stream, [...(s.bodies.get(stream) ?? []), ...bytes]);
          if (!fin) return;
          const value = s.pending.get(stream);
          s.pending.delete(stream);
          if (value) onRequest(s, frames, stream, value, true);
        },
        stop: value => onStop(s, frames, value),
        close: value => stats.closes.push(value?.reason ?? null),
        abort: stream => cancelStream(s, stream),
        hello: () => {},
      },
    });
    s.frames = frames;
    s.phoneId = phoneId;
    return frames;
  }

  function cancelStream(s, stream) {
    const found = running.get(s.project ?? '') ?? null;
    for (const set of running.values()) {
      for (const run of set) {
        if (run.frames === s.frames && run.streamId === stream) {
          clearTimeout(run.timer);
          set.delete(run);
          stats.cancelled += 1;
        }
      }
    }
    void found;
  }

  // Cancels the running chat turns (of one project, or all). Returns how many.
  function stopRuns(project = null) {
    let cancelled = 0;
    for (const [name, set] of running) {
      if (project && project !== name) continue;
      for (const run of Array.from(set)) {
        clearTimeout(run.timer);
        set.delete(run);
        if (run.frames) {
          run.frames.cancel(run.streamId);
          cancelled += 1;
        }
      }
    }
    return cancelled;
  }

  // A first message that is a STOP_ONLY (plan C3). Checks in the order the listener does, then stops everything and answers.
  function onStopOnly(s, wire) {
    const decoded = decodeStopOnly(wire);
    if (!decoded) {
      s.ws.close(4400, 'protocol');
      return;
    }
    stats.stopOnly.push({ deviceId: decoded.deviceId, counter: decoded.counter, stopId: decoded.stopId });
    if (silentStopOnly) return;
    const key = stopKeys.get(decoded.deviceId);
    if (refuseStopOnly || !key || !verifyStopOnly(key, wire)) {
      s.ws.close(4401, 'unknown');
      return;
    }
    if (decoded.counter <= (counters.get(decoded.deviceId) ?? 0)) {
      s.ws.close(4400, 'replay');
      return;
    }
    counters.set(decoded.deviceId, decoded.counter);
    let counts = stoppedById.get(decoded.stopId);
    if (!counts) {
      counts = { cancelled: stopRuns(), drivesStopped: 0, agentsStopped: 0, cardsDenied: 0, ...(stopCounts ?? {}) };
      stoppedById.set(decoded.stopId, counts);
    }
    s.ws.deliver(encodeStopAck({ stopKey: key, stopId: decoded.stopId, counts }));
    s.ws.close(1000, 'stopped');
  }

  function onStop(s, frames, value) {
    stats.stops += 1;
    stats.stopsSeen.push(value.id);
    if (ignoreStops) return;
    const cancelled = stopRuns(value.project);
    const ack = { id: value.id, cancelled, drivesStopped: 0, agentsStopped: 0, cardsDenied: 0 };
    stats.stopAcks.push(ack);
    frames.stopAck(ack);
  }

  function onRequest(s, frames, stream, value, fin) {
    const method = String(value?.method ?? 'GET');
    const path = String(value?.path ?? '/');
    stats.requests.push({ method, path, headers: { ...(value?.headers ?? {}) } });
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      frames.respond(stream, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      frames.data(stream, utf8.encode('<!doctype html><html><body>Desktop UI (fake)</body></html>'), { fin: true });
      return;
    }
    if (method === 'GET' && path === '/api/state') {
      frames.respond(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      frames.data(stream, utf8.encode(JSON.stringify({ projects: [{ id: 'p1', name: 'p1' }], activeProject: 'p1', running: [...running.keys()] })), { fin: true });
      return;
    }
    if (method === 'GET' && path === '/api/events') {
      frames.respond(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
      approvalStreams.add({ frames, stream });
      return;
    }
    if (method === 'POST' && path === '/api/approve') {
      const body = utf8Decode.decode(Uint8Array.from(s.bodies.get(stream) ?? []));
      s.bodies.delete(stream);
      let answer = null;
      try { answer = JSON.parse(body); } catch { answer = null; }
      const line = value?.headers?.['x-plenum-notify-line'] ?? null;
      stats.approvals.push({ approvalId: answer?.approvalId ?? null, allow: answer?.allow === true, line });
      // A refusal the way the Bridge words it for a notification approve that does not match a waiting card.
      if (line !== null && approveStatus === 409) {
        frames.respond(stream, { status: 409, headers: { 'content-type': 'application/json' } });
        frames.data(stream, utf8.encode(JSON.stringify({ error: 'That card changed. Open it to answer.', changed: true })), { fin: true });
        return;
      }
      frames.respond(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      frames.data(stream, utf8.encode('{"ok":true}'), { fin: true });
      return;
    }
    if (method === 'POST' && path === '/_bridge/log') {
      const body = utf8Decode.decode(Uint8Array.from(s.bodies.get(stream) ?? []));
      s.bodies.delete(stream);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      stats.logs.push(String(parsed.line ?? ''));
      frames.respond(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      frames.data(stream, utf8.encode('{"ok":true}'), { fin: true });
      return;
    }
    if (method === 'POST' && path === '/api/phones/push') {
      const body = utf8Decode.decode(Uint8Array.from(s.bodies.get(stream) ?? []));
      s.bodies.delete(stream);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      stats.pushes.push(parsed);
      frames.respond(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      frames.data(stream, utf8.encode(JSON.stringify({ ok: true, push: { approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false } })), { fin: true });
      return;
    }
    if (method === 'POST' && path === '/api/chat') {
      const body = utf8Decode.decode(Uint8Array.from(s.bodies.get(stream) ?? []));
      s.bodies.delete(stream);
      let project = 'p1';
      try { project = JSON.parse(body).project ?? 'p1'; } catch { /* default */ }
      stats.chats += 1;
      frames.respond(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const pieces = ['Echo (fake desktop). ', 'The prompt was received. ', 'This reply streams in small pieces. ', 'Stop cuts it short. ', 'End.'];
      const set = running.get(project) ?? new Set();
      running.set(project, set);
      const run = { frames, streamId: stream, timer: null };
      set.add(run);
      let i = 0;
      const next = () => {
        if (!set.has(run)) return;
        if (i >= pieces.length) {
          set.delete(run);
          frames.data(stream, utf8.encode(''), { fin: true });
          return;
        }
        frames.data(stream, utf8.encode(`data: ${JSON.stringify({ type: 'text', text: pieces[i] })}\n\n`));
        i += 1;
        run.timer = setTimeout(next, 15);
      };
      run.timer = setTimeout(next, 5);
      return;
    }
    frames.respond(stream, { status: 404, headers: { 'content-type': 'application/json' } });
    frames.data(stream, utf8.encode('{"error":"Not found."}'), { fin: true });
  }

  // Tries a known phone (IK) first, then each live offer (IKpsk2). Returns { r, payload, offer } or null.
  function readFirst(wire) {
    const body = splitMessage1(wire)?.body;
    if (!body) return null;
    const ik = handshakeResponder({ staticPrivate: keys.privateKey, prologue: prologue(carrier), lastCounter: pub => counters.get(deviceIdOf(pub)) });
    try {
      const payload = JSON.parse(utf8Decode.decode(ik.readMessage1(body)));
      return { r: ik, payload, offer: null };
    } catch {
      // not a known phone, or a pairing
    }
    for (const [hex, offer] of offers) {
      const r = handshakeResponder({ staticPrivate: keys.privateKey, prologue: prologue(carrier, hex), psk: offer.psk, lastCounter: () => undefined });
      try {
        const payload = JSON.parse(utf8Decode.decode(r.readMessage1(body)));
        return { r, payload, offer: hex };
      } catch {
        // wrong offer
      }
    }
    return null;
  }

  net.listen(url, ws => {
    const s = { ws, frames: null, phoneId: null, bodies: new Map(), pending: new Map(), first: true, closed: false };
    s.gone = () => {
      if (s.closed) return;
      s.closed = true;
      sessions.delete(s);
      if (s.frames && !s.frames.isClosed) s.frames.close('transport');
    };
    sessions.add(s);
    return {
      gone: () => s.gone(),
      onMessage(wire) {
        if (!s.first) {
          if (s.cs) {
            let plain = null;
            try {
              plain = s.cs.recv.decrypt(wire);
            } catch {
              s.frames?.close('protocol');
              return;
            }
            s.frames?.receive(plain);
          }
          return;
        }
        s.first = false;
        if (isStopOnly(wire)) {
          onStopOnly(s, wire);
          return;
        }
        if (!checkMac1(keys.publicKey, wire)) {
          stats.refused += 1;
          ws.close(1000, 'refused');
          return;
        }
        // Under load the desktop asks for a cookie first: message 1 must come again with a mac2 made from it.
        if (cookieReply) {
          if (!s.cookieSent) {
            s.cookieSent = true;
            s.first = true;
            stats.cookieReplies += 1;
            ws.deliver(makeCookieReply(COOKIE));
            return;
          }
          if (!checkMac2(COOKIE, wire)) {
            stats.refused += 1;
            ws.close(1000, 'refused');
            return;
          }
        }
        const found = readFirst(wire);
        if (!found) {
          // The listener's answer to an unknown static key (or a wrong psk): CLOSE 4401 before any Noise session exists.
          stats.refused += 1;
          ws.close(4401, 'unknown');
          return;
        }
        stats.handshakes += 1;
        const { r, payload, offer } = found;
        const remotePub = r.remoteStatic;
        const phoneId = deviceIdOf(remotePub);
        if (offer) {
          const entry = offers.get(offer);
          const out = utf8.encode(JSON.stringify({ v: '1.0', state: 'confirm', deviceId: phoneId }));
          const message2 = r.writeMessage2(out);
          s.cs = r.finish();
          s.phoneId = phoneId;
          s.pairing = { offer, payload, remotePub, phoneId };
          ws.deliver(message2);
          s.frames = sessionFrames(s, phoneId, s.cs);
          // The phone's first transport message (its PING) proves the psk; the decision waits for the person.
          entry.waiting.push(s);
          return;
        }
        counters.set(phoneId, r.counter);
        const wantsKey = payload?.wantStopKey === true;
        const message2 = r.writeMessage2(utf8.encode(JSON.stringify({ ...helloFor(phoneId), ...(wantsKey ? { stopKeyNew: true } : {}) })));
        s.cs = r.finish();
        // A phone that asked for a Stop key gets the one made from this session's handshake hash (it makes the same one).
        if (wantsKey) stopKeys.set(phoneId, deriveStopKey(s.cs.handshakeHash));
        ws.deliver(message2);
        s.frames = sessionFrames(s, phoneId, s.cs);
        return;
      },
    };
  });

  // The person presses Allow or Deny at the computer for an offer. Returns true when a waiting phone was answered.
  function decide(hex, decision) {
    const entry = offers.get(hex);
    if (!entry) return false;
    entry.decision = decision;
    const waiting = entry.waiting.splice(0);
    for (const s of waiting) {
      const { payload, remotePub, phoneId } = s.pairing;
      if (decision === 'allow') {
        registry.set(phoneId, { name: String(payload.device?.name ?? ''), pub: remotePub });
        counters.set(phoneId, payload.counter);
        stopKeys.set(phoneId, deriveStopKey(s.cs.handshakeHash));
        s.frames.hello(helloFor(phoneId));
      } else {
        s.frames.close(decision === 'expire' ? 'expired' : 'denied');
      }
    }
    return waiting.length > 0;
  }

  return {
    keys,
    url,
    carrier,
    stats,
    counters,
    registry,
    stopKeys,
    sessions,
    get pubBytes() { return keys.publicKey; },
    // Opens an offer. psk: 32 bytes, offer: 16 bytes as 32 hex characters.
    openOffer(psk, offerHex) {
      offers.set(offerHex, { psk, decision: null, waiting: [] });
      return offerHex;
    },
    allow: hex => decide(hex, 'allow'),
    deny: hex => decide(hex, 'deny'),
    expire: hex => decide(hex, 'expire'),
    // Pushes an approval card to every open events stream. extra is merged into the event (an 'answered' event carries an action).
    raiseApproval(summary = 'Write a file', extra = {}) {
      approvalSeq += 1;
      const id = `ap${approvalSeq}`;
      const bytes = utf8.encode(`data: ${JSON.stringify({ type: 'approval', approvalId: id, summary, ...extra })}\n\n`);
      for (const { frames, stream } of approvalStreams) frames.data(stream, bytes);
      return id;
    },
    // Revokes every phone that is connected: the computer sends CLOSE revoked on each session.
    revokeAll() {
      for (const s of Array.from(sessions)) if (s.frames && !s.frames.isClosed) s.frames.close('revoked');
    },
    // Kills every phone socket, as if the computer went away. Also refuses new sockets until setDown(false).
    killAll() {
      net.setDown(true);
      net.dropAll('restarted');
    },
    comeBack() {
      net.setDown(false);
    },
    // Live session counts for the Node suites.
    get sessionCount() { return sessions.size; },
    phoneIdOf: pub => deviceIdOf(pub),
  };
}

export function phoneSessionsOf(desktop) {
  return desktop.sessions.size;
}
