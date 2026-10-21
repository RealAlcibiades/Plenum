// The events channel: GET /api/events keeps one server-sent stream open per window, and everything that changes in Plenum is
// published to every window on it, so a window never has to poll. It carries the same data the page already fetches (the state
// without messages, the run events a chat stream shows, approval ids) and nothing more: no keys, no token.
//
// Event catalogue. Every event has `type` and `at` (milliseconds); every published event also has the SSE id `seq`.
//   hello     { pid, startedAt, version, state }   first event on a new stream (sent to that client only, with no id)
//   state     { reason, state }                    the state without messages: 'persist', 'run', 'approvals', ...
//   run       { runId, project, kind, event }      one event of a run, as its own stream carries it (event.runId is runId);
//                                                  kind: 'chat' | 'review' | 'compact' | 'council' | 'build' | 'relay' |
//                                                  'compare' | 'pipeline' | 'restore' | the kind a route module passes
//   approval  { action: 'answered' | 'expired' | 'stopped', approvalId, allow }
//   notice    { text, project? }
//   agent     { ... }                              reserved for the delegation work, which publishes it
// Any later feature may publish a type of its own through publish().

export const STARTED_AT = Date.now();

// A write buffer larger than this means the window stopped reading; it is dropped instead of growing without limit.
const MAX_BACKLOG = 8_000_000;
const PING_MS = 15_000;
const COALESCE_MS = 30;

const clients = new Set();
let seq = 0;
let pinger = null;
let provider = null;
let stateTimer = null;
let stateReason = '';

const frame = (ev, id) => `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(ev)}\n\n`;

function drop(client) {
  clients.delete(client);
  if (!clients.size && pinger) {
    clearInterval(pinger);
    pinger = null;
  }
}

function write(client, text) {
  try {
    client.res.write(text);
    if ((client.res.writableLength ?? 0) > MAX_BACKLOG) throw new Error('backlog');
  } catch {
    drop(client);
    try {
      client.res.end();
    } catch {
      // The connection is already gone.
    }
  }
}

// Opens the stream for one window: the SSE headers, the retry hint, then the hello event. The window is kept until its
// connection closes. One shared timer pings every window every 15 seconds while any is connected, so a dead connection is noticed.
export function subscribe(req, res, hello) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  // A long-lived stream must not be cut by a socket timeout, and a small event must not wait for more data.
  req?.socket?.setTimeout?.(0);
  req?.socket?.setNoDelay?.(true);
  const client = { res };
  clients.add(client);
  res.on('close', () => drop(client));
  write(client, 'retry: 2000\n\n');
  write(client, frame({ ...hello, at: Date.now() }));
  if (clients.has(client) && !pinger) {
    pinger = setInterval(() => {
      for (const c of [...clients]) write(c, ': ping\n\n');
    }, PING_MS);
    pinger.unref?.();
  }
  return client;
}

// Sends one event to every window. A window whose write throws is dropped.
export function publish(ev) {
  ev.at = Date.now();
  seq += 1;
  // With no window connected nothing is written, so the event is not even turned into text.
  if (!clients.size) return seq;
  const text = frame(ev, seq);
  for (const client of [...clients]) write(client, text);
  return seq;
}

export const clientCount = () => clients.size;

// Where the state event gets its data. server.mjs sets it once at start.
export function useStateProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

// Tells every window the state changed. Calls within 30 ms become one event (the reason of the first call). Nothing is built
// while no window is connected, because a window that connects later is sent the state in its hello event.
export function publishState(reason = 'state') {
  if (!provider || !clients.size) return;
  if (stateTimer) return;
  stateReason = reason;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    if (!provider || !clients.size) return;
    try {
      publish({ type: 'state', reason: stateReason, state: provider() });
    } catch (err) {
      // A state that cannot be read now is skipped; the next change publishes again. The timer must never throw.
      console.error('Could not publish the state:', err.message);
    }
  }, COALESCE_MS);
  stateTimer.unref?.();
}

// Wraps a run's events: the returned function stamps an event with the run id, publishes it as a run event and gives the stamped
// event back, so the run's own stream can write exactly what the events channel carries.
export function tag(runId, project, kind) {
  return obj => {
    const ev = { ...obj, runId };
    publish({ type: 'run', runId, project, kind, event: ev });
    return ev;
  };
}
