// The page-side channel contract (mob-10, wave 104). Every later builder uses this file; the screens and boot.js do not touch
// the socket, Noise or the keys.
//
//   const channel = openChannel({ computer, carriers?, store?, device, caps });
//   channel.request({ method, path, headers }, body?, { signal, scope }?)  -> Promise<{ status, headers, body: ReadableStream, id, cancel() }>
//                                                      signal: an AbortSignal; abort sends CANCEL at once (mob-09 added it)
//                                                      scope: 'page' (default) or 'shell'. The worker enforces the request policy by scope: a page
//                                                      request keeps three headers and never reaches /_bridge/; a shell request may also send the
//                                                      notification line and POST /_bridge/log and /_bridge/ui-manifest. A refused request fails
//                                                      with code 'refused'.
//   channel.cancel(id)                                 aborts one request (the id from its response)
//   channel.stop(project?)                             -> Promise<ack>  { id, cancelled, drivesStopped, agentsStopped, cardsDenied }
//                                                      rejects with { code: 'unreachable' } after 60 s without an answer
//   channel.onState(fn)     -> unsubscribe              fn(state) at once and on every change; state has no keys
//   channel.onEvent(fn)     -> unsubscribe              fn(event) for each EVENT frame from the computer
//   channel.onStopState(fn) -> unsubscribe              fn({ sid, state }) 'sending' | 'sent' | 'queued'
//   channel.hello           the last HELLO payload, or null (getter)
//   channel.state           the last state (getter)
//   channel.reconnect()     an immediate attempt (app resume, visibility)
//   channel.close()         ends the channel; the worker is terminated once it reports 'closed'
//
// Requests fail with an Error whose code is 'offline' (not connected), 'busy', 'lost' (the link dropped mid-request),
// 'cancelled', 'closed' or 'refused' (the worker's request policy said no). Keys and tokens never reach this file's callers: the worker sends states, events and bodies only.

export const CHANNEL_WORKER_NAME = 'plenum-channel';

const utf8 = new TextEncoder();

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

// The worker file sits beside this module in the built shell (esbuild writes channel.worker.js next to shell.js).
export function defaultCreateWorker() {
  return new Worker(new URL('./channel.worker.js', import.meta.url), { type: 'module', name: CHANNEL_WORKER_NAME });
}

// The record in the shape the worker takes: keys as bytes, carriers as the pairing payload gave them.
export function workerComputer(record, carriers = null) {
  return {
    id: record.id,
    name: record.name ?? '',
    desktopPub: b64uToBytes(record.desktopPub),
    myPriv: b64uToBytes(typeof record.myPriv === 'string' ? record.myPriv : fail('locked')),
    carriers: carriers ?? record.carriers ?? [],
    lastCarrier: record.lastCarrier ?? null,
    counter: Number.isSafeInteger(record.counter) ? record.counter : 0,
  };
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

// Answers a worker's counter request from the store: raises the counter to at least `minimum` and says what was stored.
export async function answerCounter(store, msg, reply) {
  try {
    const counter = store ? await store.raiseCounter(msg.id, msg.minimum) : msg.minimum;
    reply({ op: 'counterSaved', rid: msg.rid, ok: true, counter });
  } catch {
    reply({ op: 'counterSaved', rid: msg.rid, ok: false });
  }
}

// Stop without unlocking (phone security round, plan C3): its own worker sends one signed STOP_ONLY on a fresh carrier socket, with the Stop
// key the record holds. It never opens a Noise session and needs no PIN: the record's stopKey and myDeviceId are not PIN-wrapped.
// Resolves the ack { id, cancelled, drivesStopped, agentsStopped, cardsDenied } or rejects with a coded error 'unknown' | 'unreachable' | 'no-key'.
// onStopState(state) hears 'sending' | 'queued'. The worker ends with it.
export function sendLockedStop({ record, store = null, createWorker = defaultCreateWorker, onStopState = () => {} } = {}) {
  const validKey = typeof record?.stopKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.stopKey);
  const validId = /^[0-9a-f]{64}$/.test(String(record?.myDeviceId ?? ''));
  if (!record || typeof record.id !== 'string' || !validKey || !validId) return Promise.reject(coded('no-key'));
  const worker = createWorker();
  const sid = 1;
  let settled = false;
  return new Promise((resolve, reject) => {
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      setTimeout(() => { try { worker.terminate(); } catch { /* gone */ } }, 0);
      fn(value);
    };
    worker.onmessage = event => {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 'counter') {
        answerCounter(store, msg, reply => worker.postMessage(reply));
      } else if (msg.op === 'stopState') {
        if (msg.sid === sid && !settled) {
          try { onStopState({ sid, state: msg.state }); } catch { /* a listener error must not stop the Stop */ }
        }
      } else if (msg.op === 'stopAck' && msg.sid === sid) {
        if (msg.error) end(reject, coded(msg.error, msg.error));
        else end(resolve, msg.ack);
      }
    };
    worker.onerror = () => end(reject, coded('unreachable'));
    worker.postMessage({
      op: 'stopLocked',
      sid,
      computer: {
        id: record.id,
        deviceId: record.myDeviceId,
        stopKey: b64uToBytes(record.stopKey),
        carriers: Array.isArray(record.carriers) ? record.carriers : [],
        lastCarrier: record.lastCarrier ?? null,
        counter: Number.isSafeInteger(record.counter) ? record.counter : 0,
      },
    });
  });
}

export function openChannel({
  computer,
  carriers = null,
  store = null,
  device = {},
  caps = null,
  createWorker = defaultCreateWorker,
  onWorkerError = () => {},
} = {}) {
  if (!computer || typeof computer.id !== 'string') throw new TypeError('openChannel needs a computer record');
  const worker = createWorker();
  let seq = 0;
  let closed = false;
  let state = { status: 'connecting', carrier: null, desktopName: '', lastSeen: null, since: 0, nextRetryAt: null, failedRounds: 0, failure: null, computerId: computer.id, stopsPending: 0 };
  let hello = null;
  const reqs = new Map();
  const stops = new Map();
  const stateSubs = new Set();
  const eventSubs = new Set();
  const stopSubs = new Set();
  const helloSubs = new Set();

  const post = (msg, transfer = []) => worker.postMessage(msg, transfer);

  const notify = (set, value) => {
    for (const fn of Array.from(set)) {
      try {
        fn(value);
      } catch {
        // A listener that throws must not stop the others.
      }
    }
  };

  const endRequest = (msg) => {
    const entry = reqs.get(msg.sid);
    if (!entry) return;
    reqs.delete(msg.sid);
    entry.detach?.();
    const controller = entry.controller;
    if (msg.error || msg.cancelled) {
      const code = msg.cancelled ? 'cancelled' : msg.error;
      const err = coded(code, code);
      if (!entry.head) entry.reject(err);
      try { controller?.error(err); } catch { /* the body was cancelled by the reader */ }
    } else {
      try { controller?.close(); } catch { /* already closed */ }
    }
  };

  worker.onmessage = event => {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.op) {
      case 'state':
        state = msg.state;
        notify(stateSubs, state);
        if (state.status === 'closed') {
          setTimeout(() => { try { worker.terminate(); } catch { /* gone */ } }, 0);
        }
        return;
      case 'hello':
        hello = msg.hello;
        notify(helloSubs, hello);
        return;
      case 'event':
        notify(eventSubs, msg.event);
        return;
      case 'res': {
        const entry = reqs.get(msg.sid);
        if (!entry || entry.head) return;
        entry.head = true;
        entry.resolve({ status: msg.status, headers: msg.headers ?? {}, body: entry.stream, id: msg.sid, cancel: () => cancel(msg.sid) });
        return;
      }
      case 'data': {
        const entry = reqs.get(msg.sid);
        if (!entry || !entry.controller) return;
        try { entry.controller.enqueue(new Uint8Array(msg.bytes)); } catch { /* cancelled by the reader */ }
        return;
      }
      case 'end':
        endRequest(msg);
        return;
      case 'stopState':
        notify(stopSubs, { sid: msg.sid, state: msg.state });
        return;
      case 'stopAck': {
        const waiter = stops.get(msg.sid);
        if (!waiter) return;
        stops.delete(msg.sid);
        if (msg.error) waiter.reject(coded(msg.error, msg.error));
        else waiter.resolve(msg.ack);
        return;
      }
      case 'counter':
        answerCounter(store, msg, reply => post(reply));
        return;
      case 'patch':
        if (store) store.patchComputer(msg.id, msg.patch).catch(() => {});
        return;
      case 'log':
        onWorkerError(String(msg.line ?? ''));
        return;
      default:
        return;
    }
  };
  // A worker that fails ends the channel: every waiting Stop is answered 'unreachable' and every open request 'lost' (its stream errors), and
  // the worker is terminated, so nothing waits on a worker that will not answer.
  worker.onerror = event => {
    onWorkerError(String(event?.message ?? 'worker error'));
    closed = true;
    for (const [sid, waiter] of Array.from(stops)) {
      stops.delete(sid);
      waiter.reject(coded('unreachable'));
    }
    for (const sid of Array.from(reqs.keys())) endRequest({ sid, error: 'lost' });
    try { worker.terminate(); } catch { /* gone */ }
  };

  // options.signal (an AbortSignal, optional): aborting it sends CANCEL for this request at once, even before the answer's head
  // arrives (the id is only known to the channel), and errors the body with code 'cancelled'.
  const request = ({ method = 'GET', path = '/', headers = {} } = {}, body = null, { signal = null, scope = 'page' } = {}) => {
    if (closed) return Promise.reject(coded('closed'));
    if (signal?.aborted) return Promise.reject(coded('cancelled'));
    const sid = ++seq;
    let controller = null;
    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel() { cancel(sid); },
    });
    return new Promise((resolve, reject) => {
      const entry = { sid, head: false, resolve, reject, stream, controller: null, detach: null };
      reqs.set(sid, entry);
      entry.controller = controller;
      if (signal) {
        const onAbort = () => {
          if (reqs.get(sid) !== entry) return;
          reqs.delete(sid);
          post({ op: 'cancel', sid });
          const err = coded('cancelled');
          if (!entry.head) entry.reject(err);
          try { controller?.error(err); } catch { /* the reader has gone */ }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }
      let bytes = null;
      if (body !== null && body !== undefined) {
        if (typeof body === 'string') bytes = utf8.encode(body);
        else if (body instanceof Uint8Array) bytes = body.slice();
        else bytes = new Uint8Array(body);
      }
      post({ op: 'request', sid, method, path, headers, scope: scope === 'shell' ? 'shell' : 'page', body: bytes }, bytes ? [bytes.buffer] : []);
    });
  };

  const cancel = sid => {
    if (closed) return false;
    post({ op: 'cancel', sid });
    return true;
  };

  const stop = (project = null) => {
    if (closed) return Promise.reject(coded('closed'));
    const sid = ++seq;
    return new Promise((resolve, reject) => {
      stops.set(sid, { resolve, reject });
      post({ op: 'stop', sid, project: project ?? null });
    });
  };

  const api = {
    id: computer.id,
    request,
    cancel,
    stop,
    onState(fn) {
      stateSubs.add(fn);
      try { fn(state); } catch { /* listener error */ }
      return () => stateSubs.delete(fn);
    },
    onEvent(fn) {
      eventSubs.add(fn);
      return () => eventSubs.delete(fn);
    },
    onStopState(fn) {
      stopSubs.add(fn);
      return () => stopSubs.delete(fn);
    },
    // fn(hello) each time the computer answers a session with HELLO (after every reconnect too).
    onHello(fn) {
      helloSubs.add(fn);
      if (hello) {
        try { fn(hello); } catch { /* listener error */ }
      }
      return () => helloSubs.delete(fn);
    },
    get hello() { return hello; },
    get state() { return state; },
    reconnect() {
      if (!closed) post({ op: 'reconnect' });
    },
    close() {
      if (closed) return;
      closed = true;
      post({ op: 'close' });
      // A worker that never reports 'closed' (it is gone) is still terminated after a short wait.
      setTimeout(() => { try { worker.terminate(); } catch { /* gone */ } }, 2000);
    },
  };

  post({
    op: 'init',
    computer: workerComputer(computer, carriers),
    device,
    caps: caps ?? undefined,
    hasStopKey: Boolean(computer.stopKey && computer.myDeviceId),
  });
  return api;
}
