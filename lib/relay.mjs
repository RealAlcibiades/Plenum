import { createHash } from 'node:crypto';
import { COUNCIL_ROLES } from './council.mjs';
import { historyFor, labelFor, streamChat } from './providers.mjs';
import { buildSystem } from './prompt.mjs';
import { BUILD, OPENING_LINE, QUOTED_DATA, READ_ONLY, TEAM, quote } from './collab.mjs';

// Relays move a finished reply from one council seat to another, as the next turn in the same chat.
// Every hop calls streamChat with readOnly: true and no tools of the project (a ctx only when the hop may start agents; see below),
// so no hop gets the project's tools object. A hop cannot change the project: Codex runs with the read-only
// sandbox, Gemini in plan mode, Muse Code in an empty scratch folder, and Claude with no tools (see streamChat).
// This file runs the hops and yields events. The server saves the replies and keeps the log.
//
// Agents (agent-roles). A hop can be allowed to start read-only agents in Agents > Limits (the Relay hops row, or a per-model override).
// runSend, runBroadcast and runRoute are then given { project, agents, run }, and a hop's model gets the tool context seatContext
// (lib/agent-run.mjs) builds: the delegate tool alone, counted for that hop. The hop itself still has no file tool and runs where it
// always did. The agents' events (agent-start, agent-state, agent-done, tool, tool_result) are sent in the hop's stream with `seat` set.
// A run is one send, one broadcast or one route; the caller closes it (withRun).

const ROUTE_KINDS = ['chain', 'broadcast'];
const DEFAULT_COUNTDOWN = 3;
const MAX_COUNTDOWN = 10;
const MAX_NOTE = 2000;
const PAUSE_POLL_MS = 250;
const TICK_MS = 1000;
const LOG_LIMIT = 200;
const NEVER = new AbortController().signal;

// lib/agent-run.mjs is imported when a hop that may start agents needs it, never at load time.
let agentRunLib = null;
const agentRun = () => (agentRunLib ??= import('./agent-run.mjs'));
// What a hop needs to build its tool context, or null when the caller gave no project, agents block or run (no hop starts agents).
const agentOptsOf = ({ project, agents, run, denyPatterns, tools, mode, approve }) => (project && agents && run ? { project, agents, run, denyPatterns, tools, mode, approve } : null);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const seatList = seats => (Array.isArray(seats) ? seats : []);
const cleanId = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const oneLine = (s, max = 0) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return max && t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const seatLabel = seat => oneLine(seat.label) || (seat.ref ? labelFor(seat.ref) : '') || seat.id;
const seatInfo = seat => ({ seat: seat.id, label: seatLabel(seat) });
const modeOf = mode => (mode === 'auto' ? 'auto' : 'ask');

function findSeat(list, id) {
  const seat = list.find(s => s.id === id);
  if (!seat) throw new Error(`"${id}" is not a seat in this council.`);
  return seat;
}

// ---------- the system text of a hop ----------

const RELAY_INTRO = `${TEAM} A relay passes one model's finished reply to another so each can build on it, and the person reads every reply.`;

// The focus a member's role covers (lib/council.mjs), or '' when the role is not known.
const focusOf = m => (Object.hasOwn(COUNCIL_ROLES, m.role) ? COUNCIL_ROLES[m.role].focus : '');
// A member as a sentence names it: its label, and its role's focus in brackets when the role is known.
const named = m => (focusOf(m) ? `${m.label} (${focusOf(m)})` : m.label);

// The paragraph that tells a hop the shape of this relay, its own place in it and who reads its reply.
// plan is { kind: 'send' | 'broadcast' | 'chain', order: [{ label, role }], at }: order[0] wrote the starting reply, order[at] is this hop.
function routeLines(plan) {
  if (!plan?.order?.length) return '';
  const { kind, order, at } = plan;
  const from = order[0];
  if (kind === 'chain') {
    const list = order.map((m, i) => `${i + 1}. ${m.label}${i === at ? ' (you)' : ''}${focusOf(m) ? `: ${focusOf(m)}` : ''}${i === 0 ? ' (wrote the starting reply)' : ''}`);
    const next = order[at + 1];
    const tail = next
      ? `Your reply goes next to ${next.label}, which sees the person's request and your reply but not the replies before yours, so make yours stand on its own.`
      : 'Yours is the last reply in this relay and goes to the person: make it an answer they can act on.';
    return `This relay is a chain, in order:\n${list.join('\n')}\n${tail} ${OPENING_LINE}`;
  }
  if (kind === 'broadcast') {
    const list = order.slice(1).map((m, i) => `- ${m.label}${i + 1 === at ? ' (you)' : ''}${focusOf(m) ? `: ${focusOf(m)}` : ''}`);
    return `This relay is a broadcast: the reply of ${named(from)} goes at the same time to:\n${list.join('\n')}\nEach of you answers on your own and none sees the others' replies. Your reply goes to the person. Cover your role fully rather than counting on the others to fill gaps. ${OPENING_LINE}`;
  }
  return `This relay sends one reply to one model: ${named(from)} wrote it, and you answer it. Your reply goes to the person: make it an answer they can act on. ${OPENING_LINE}`;
}

// The system text of one hop. Every hop gets one, with or without a known role.
export function hopSystem(to, plan) {
  const role = Object.hasOwn(COUNCIL_ROLES, to.role) ? COUNCIL_ROLES[to.role] : null;
  return [
    RELAY_INTRO,
    ...(role ? [`Your role on this council: ${role.label}. ${role.brief}`] : []),
    routeLines(plan),
    `${BUILD} ${READ_ONLY}`,
  ].filter(Boolean).join('\n\n');
}

// ---------- framing ----------

// The turn the target receives. The body is the source reply, unchanged; only the fence is added, and only when needed.
// `request` (optional) is the person's request the relay serves; `hop` (optional, default 1) is this hop's number in a chain.
// `requestAbove` (optional) says the request is already in the chat above this turn (the person's last message), so it is not repeated here.
export function frameRelay({ sourceLabel, text, note, request, hop = 1, requestAbove = false } = {}) {
  const label = oneLine(sourceLabel) || 'another seat';
  const head = oneLine(note, MAX_NOTE);
  const goal = String(request ?? '').trim();
  const about = requestAbove ? 'the person\'s request (their last message above)' : 'that request';
  const intro = goal
    ? `Another model (${label}) wrote the text between BEGIN and END below, in reply to ${about}${hop > 1 ? ' and to the reply before it in this chain' : ''}. Read it, then do your part in this relay as your system text says. ${QUOTED_DATA}`
    : `Another model (${label}) wrote the text between BEGIN and END below. Read it, then answer the question it raises or add what it misses. ${QUOTED_DATA}`;
  return [
    ...(head ? [head, ''] : []),
    ...(goal && !requestAbove ? ['The person\'s request:', goal, ''] : []),
    intro,
    '',
    quote(label, String(text ?? '')),
  ].join('\n');
}

// A relay member as the plan lists it: its label and role. The source is found in the list by its seat id.
const member = seat => ({ label: seatLabel(seat), role: seat.role ?? null });
const sourceMember = (list, from) => ({ label: from.label, role: list.find(s => s.id === from.seat)?.role ?? null });

export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

// ---------- validation ----------

function checkSource(source) {
  if (!isObject(source)) throw new Error('There is no reply to relay.');
  const text = String(source.text ?? '');
  if (!text.trim()) throw new Error(`${oneLine(source.label) || 'That seat'} has no reply in this chat yet, so there is nothing to relay.`);
  return { seat: cleanId(source.seat) || null, label: oneLine(source.label) || 'another seat', ref: source.ref, text, messageId: source.messageId, request: typeof source.request === 'string' ? source.request : '' };
}

// The source's seat id comes from `source.seat`, or is found from its label when only the label is known.
function fromOf(list, src) {
  const seat = src.seat ?? list.find(s => s.label === src.label)?.id ?? null;
  return { seat, label: src.label };
}

// scope (lib/scope.mjs) is the thread the relay belongs to; its root is the folder, which is the project's until a thread has its own.
function folderOf(project, scope) {
  const dir = scope?.root ?? project?.path;
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Open a project folder first. A relay runs in it, the same as a chat turn.');
  return dir;
}

// The chat so far, as plain text. Relays never carry tool blocks, so this is the same for every seat. The chat is the thread's: its
// scope id keys the transcript (the project's own id for Main).
function historyOf(store, project, ref, scope) {
  const key = scope?.id ?? project?.id;
  if (typeof store?.transcript !== 'function' || !key) return [];
  return historyFor(store.transcript(key), ref, { textOnly: true });
}

function broadcastTargets(list, targets, fromId) {
  const asked = (Array.isArray(targets) ? targets : []).map(cleanId).filter(Boolean);
  if (!asked.length) throw new Error('Choose at least one seat to send to, or all of them.');
  if (new Set(asked).size !== asked.length) throw new Error('Each seat can be sent to once.');
  const ids = asked.includes('all') ? list.map(s => s.id).filter(id => id !== fromId) : asked;
  if (!ids.length) throw new Error('There is no other seat to send to.');
  for (const id of ids) findSeat(list, id);
  if (fromId && ids.includes(fromId)) throw new Error('A seat cannot relay its reply back to itself.');
  return ids;
}

// Checks a route and fills in its defaults. `seats` are the council seats, each with `reply` set to that seat's
// latest reply in the chat (empty or missing means the seat has no reply). Throws an Error with a plain message.
// Idempotent: a normalized route normalizes to itself.
export function normalizeRoute(input, seats) {
  if (!isObject(input)) throw new Error('A relay route needs a kind, a source seat and its targets.');
  const list = seatList(seats);
  const byId = new Map(list.map(s => [s.id, s]));
  if (!ROUTE_KINDS.includes(input.kind)) throw new Error('A route is a chain (one seat after another) or a broadcast (every other seat).');
  const from = cleanId(input.from);
  const source = byId.get(from);
  if (!source) throw new Error(from ? `"${from}" is not a seat in this council.` : 'Choose the seat whose reply starts the route.');
  if (typeof source.reply !== 'string' || !source.reply.trim()) {
    throw new Error(`${seatLabel(source)} has no reply in this chat yet, so there is nothing to relay.`);
  }

  let targets;
  if (input.kind === 'broadcast') {
    const others = list.map(s => s.id).filter(id => id !== from);
    if (!others.length) throw new Error('There is no other seat to send to.');
    const asked = (Array.isArray(input.targets) ? input.targets : []).map(cleanId).filter(Boolean);
    const takesAll = asked.length === 0 || (asked.length === 1 && asked[0] === 'all');
    const sameSeats = asked.length === others.length && others.every(id => asked.includes(id));
    if (!takesAll && !sameSeats) {
      throw new Error('A broadcast goes to every other seat. Leave the targets out, or use a chain to choose seats.');
    }
    targets = others;
  } else {
    if (!Array.isArray(input.targets) || !input.targets.length) throw new Error('A chain needs at least one target seat, listed in the order to send to.');
    targets = input.targets.map(cleanId);
    const visited = new Set([from]);
    for (const id of targets) {
      if (!byId.has(id)) throw new Error(`"${id}" is not a seat in this council.`);
      if (visited.has(id)) {
        throw new Error(id === from
          ? `A chain cannot send ${seatLabel(source)}'s reply back to ${seatLabel(source)}.`
          : `A chain visits each seat once, but ${seatLabel(byId.get(id))} comes up more than once.`);
      }
      visited.add(id);
    }
  }
  let hops = null;
  if (input.hops != null) {
    if (!Number.isInteger(input.hops) || input.hops < 1) throw new Error('Hops must be a whole number of 1 or more, or left empty for no limit.');
    hops = input.hops;
  }

  let countdownSec = DEFAULT_COUNTDOWN;
  if (input.countdownSec != null) {
    if (!Number.isInteger(input.countdownSec) || input.countdownSec < 0 || input.countdownSec > MAX_COUNTDOWN) {
      throw new Error(`The countdown must be a whole number of seconds from 0 to ${MAX_COUNTDOWN}.`);
    }
    countdownSec = input.countdownSec;
  }

  if (input.stopOnError != null && typeof input.stopOnError !== 'boolean') throw new Error('stopOnError must be true or false.');
  return { kind: input.kind, from, targets, hops, countdownSec, stopOnError: input.stopOnError ?? true };
}

// ---------- running ----------

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

function errorText(err) {
  const api = err?.error?.error?.message;
  const text = String(api ? `${api}${err.status ? ` (HTTP ${err.status})` : ''}` : err?.message ?? err).trim();
  return text.length > 800 ? `${text.slice(0, 800)}…` : text || 'Unknown error.';
}

// Iterates a stream but gives up the moment the signal fires, even if the provider is slow to notice.
async function* abortable(iterable, signal) {
  const it = iterable[Symbol.asyncIterator]();
  let onAbort;
  const gone = new Promise(resolve => {
    onAbort = () => resolve(null);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const pending = it.next();
      pending.catch(() => {});
      const r = await Promise.race([pending, gone]);
      if (r === null || r.done) return;
      yield r.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    Promise.resolve(it.return?.()).catch(() => {});
  }
}

// Interleaves several generators as their events arrive. Every hop generator is built not to throw.
async function* merge(gens) {
  const queue = [];
  let open = gens.length;
  let wake = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  for (const gen of gens) {
    (async () => {
      try {
        for await (const ev of gen) {
          queue.push(ev);
          poke();
        }
      } catch (err) {
        queue.push({ type: 'error', message: errorText(err) });
      } finally {
        open -= 1;
        poke();
      }
    })();
  }
  for (;;) {
    if (queue.length) {
      yield queue.shift();
      continue;
    }
    if (!open) return;
    await new Promise(resolve => { wake = resolve; });
  }
}

async function* tagged(gen, seat) {
  for await (const ev of gen) yield { ...ev, seat };
}

// One hop. Yields hop-start, start, the target's deltas and hop-done, and fills `out` (done, ok, text, error, aborted).
// It never throws: a failed or stopped hop is reported in hop-done.
async function* hopEvents({ kind, hop, from, to, text, note, request, frameHop, plan, history, cwd, mode, onHop, agentOpts }, signal, out) {
  yield { type: 'hop-start', hop, from, to: seatInfo(to), chars: text.length };
  yield { type: 'start', kind: 'relay', model: to.ref, label: seatLabel(to) };
  let reply = '';
  let error = null;
  if (!signal.aborted) {
    // In a chain the hop's number is its place in the order (plan.at), so a later hop is told it follows the reply before it. frameHop
    // overrides that when the text this hop gets is not the reply before it (a failed hop before it left the starting reply in place).
    // The request is left out only when it is the person's last message in the chat above (the last user turn), so "their last message above"
    // is true. A request with newer messages of the person after it (a relay from an older reply, DECISIONS 73) keeps its heading. It is also
    // short enough for a CLI to see whole (promptText clips each earlier line to 3000 characters).
    const goal = String(request ?? '').trim();
    const lastUser = (history ?? []).findLast(m => m.role === 'user');
    const requestAbove = goal.length > 0 && goal.length <= 3000 && typeof lastUser?.content === 'string' && lastUser.content.trim() === goal;
    const messages = [...history, { role: 'user', content: frameRelay({ sourceLabel: from.label, text, note, request, hop: frameHop ?? (plan?.kind === 'chain' ? plan.at : 1), requestAbove }) }];
    try {
      const base = await buildSystem('relay', { root: cwd, readOnly: true, ref: to.ref, base: [hopSystem(to, plan)], extra: { to, plan, request } });
      // A hop that may start agents is given the delegate tool alone; the agents' events are sent while its stream is read.
      const lib = agentOpts ? await agentRun() : null;
      let sideEmit = () => {};
      const ctx = await lib?.seatContextFor({ ...agentOpts, role: 'relay', ref: to.ref, seatId: to.id, label: seatLabel(to), signal, mode, emit: ev => sideEmit({ ...ev, seat: to.id }), effort: to.effort });
      const system = ctx ? lib.seatSystemWith(base, ctx) : base;
      const stream = streamChat(to.ref, { system, messages, cwd, signal, mode, effort: to.effort, readOnly: true, ...(ctx ? { ctx } : {}) });
      if (ctx) {
        for await (const ev of lib.pumped(signal, async push => {
          sideEmit = push;
          for await (const delta of abortable(stream, signal)) {
            if (!delta) continue;
            reply += delta;
            push({ type: 'delta', text: delta });
          }
        })) yield ev;
      } else {
        for await (const delta of abortable(stream, signal)) {
          if (!delta) continue;
          reply += delta;
          yield { type: 'delta', text: delta };
        }
      }
    } catch (err) {
      if (!signal.aborted) error = errorText(err);
    }
  }
  if (signal.aborted) {
    error = 'Stopped.';
    out.aborted = true;
  } else if (!error && !reply.trim()) {
    error = 'The model returned no answer.';
  }
  out.ok = !error;
  out.text = reply;
  out.error = error;
  out.done = true;
  // The record keeps the size and hash of the text that was sent, never the text.
  onHop?.({ at: Date.now(), hop, kind, from, to: seatInfo(to), chars: text.length, sha256: hashText(text), ok: out.ok, ...(error ? { error } : {}) });
  yield { type: 'hop-done', hop, from, to: seatInfo(to), ok: out.ok, ...(error ? { error } : {}), text: reply };
}

// Waits while the route is paused. Returns 'ok', 'paused-forever' (stopped while paused) or 'user'.
async function* waitWhilePaused({ isPaused, signal }) {
  if (!isPaused()) return 'ok';
  yield { type: 'relay-paused' };
  while (isPaused()) {
    if (signal.aborted) return 'paused-forever';
    await sleep(PAUSE_POLL_MS, signal);
  }
  if (signal.aborted) return 'paused-forever';
  yield { type: 'relay-resumed' };
  return 'ok';
}

// One step of a route: a single hop, or a broadcast of several hops in parallel. The countdown runs first, one tick
// per second, and each hop gets its own countdown events. Returns { status, outs } where status is 'ok', 'user' or
// 'paused-forever'.
async function* routeStep(items, ctx) {
  const { signal } = ctx;
  const stopped = status => ({ status, outs: [] });
  if (signal.aborted) return stopped('user');
  let status = yield* waitWhilePaused(ctx);
  if (status !== 'ok') return stopped(status);
  for (let s = ctx.countdownSec; s >= 1; s -= 1) {
    if (signal.aborted) return stopped('user');
    for (const item of items) yield { type: 'hop-countdown', hop: item.hop, from: item.from, to: seatInfo(item.to), seconds: s };
    await sleep(TICK_MS, signal);
  }
  if (signal.aborted) return stopped('user');
  status = yield* waitWhilePaused(ctx);
  if (status !== 'ok') return stopped(status);
  if (signal.aborted) return stopped('user');
  const outs = items.map(() => ({}));
  if (items.length === 1) yield* hopEvents(items[0], signal, outs[0]);
  else yield* merge(items.map((item, i) => tagged(hopEvents(item, signal, outs[i]), item.to.id)));
  return { status: 'ok', outs };
}

const countDone = outs => outs.filter(o => o.done).length;

// Sends one reply to one seat. The caller saves the target's reply from hop-done.
export async function* runSend({ seats, source, target, note, project, scope, store, signal, mode, agents, run, denyPatterns, tools, approve } = {}) {
  const sig = signal ?? NEVER;
  const list = seatList(seats);
  const src = checkSource(source);
  const to = findSeat(list, cleanId(target));
  if (src.seat && to.id === src.seat) throw new Error('A seat cannot relay its reply back to itself.');
  const from = fromOf(list, src);
  const item = {
    kind: 'send',
    hop: 1,
    from,
    to,
    text: src.text,
    note,
    request: src.request,
    plan: { kind: 'send', order: [sourceMember(list, from), member(to)], at: 1 },
    history: historyOf(store, project, to.ref, scope),
    cwd: folderOf(project, scope),
    mode: modeOf(mode),
    agentOpts: agentOptsOf({ project, agents, run, denyPatterns, tools, mode: modeOf(mode), approve }),
  };
  yield { type: 'relay-start', kind: 'send', hops: 1 };
  const out = {};
  if (!sig.aborted) yield* hopEvents(item, sig, out);
  yield { type: 'relay-done', hops: countDone([out]), stopped: sig.aborted ? 'user' : out.ok ? 'finished' : 'error' };
}

// Sends the same reply to several seats at once. Each target is its own hop, and its events carry `seat`.
export async function* runBroadcast({ seats, source, targets, note, project, scope, store, signal, mode, agents, run, denyPatterns, tools, approve } = {}) {
  const sig = signal ?? NEVER;
  const list = seatList(seats);
  const src = checkSource(source);
  const from = fromOf(list, src);
  const ids = broadcastTargets(list, targets, from.seat);
  const cwd = folderOf(project, scope);
  const agentOpts = agentOptsOf({ project, agents, run, denyPatterns, tools, mode: modeOf(mode), approve });
  // Every target sees the same order: the source first, then each target in the order it was sent to.
  const order = [sourceMember(list, from), ...ids.map(id => member(findSeat(list, id)))];
  const items = ids.map((id, i) => {
    const to = findSeat(list, id);
    return { kind: 'broadcast', hop: i + 1, from, to, text: src.text, note, request: src.request, plan: { kind: 'broadcast', order, at: i + 1 }, history: historyOf(store, project, to.ref, scope), cwd, mode: modeOf(mode), agentOpts };
  });
  yield { type: 'relay-start', kind: 'broadcast', hops: items.length };
  const outs = items.map(() => ({}));
  if (!sig.aborted) yield* merge(items.map((item, i) => tagged(hopEvents(item, sig, outs[i]), item.to.id)));
  yield { type: 'relay-done', hops: countDone(outs), stopped: sig.aborted ? 'user' : 'finished' };
}

// Runs a route: a chain (one seat after another, each taking the latest good reply) or a broadcast (every other seat at once).
// `startText` is the reply the route starts from (its source seat must be in `route.from`). `route.hops` caps the number of
// hops, `route.countdownSec` is the wait before each hop, and `dedupe` skips a hop whose text was already sent in this route.
// `isPaused` is polled between hops. `onHop` gets one log record per finished hop. `history` is the chat so far (see historyFor).
// `startRef` is accepted for the caller's convenience and not used: the source seat's ref comes from `seats`.
export async function* runRoute({ route, seats, startText, startLabel, cwd, signal, isPaused, onHop, mode, history, dedupe = false, note, request = '', project, agents, run, denyPatterns, tools, approve } = {}) {
  const sig = signal ?? NEVER;
  const text = String(startText ?? '');
  if (!text.trim()) throw new Error('There is no reply to relay yet.');
  const fromId = cleanId(route?.from);
  const withReply = seatList(seats).map(s => (s.id === fromId ? { ...s, reply: text } : s));
  const r = normalizeRoute(route, withReply);
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Open a project folder first. A relay runs in it, the same as a chat turn.');
  const ctx = {
    signal: sig,
    isPaused: typeof isPaused === 'function' ? isPaused : () => false,
    countdownSec: r.countdownSec,
    cwd,
    mode: modeOf(mode),
    history: Array.isArray(history) ? history : [],
    note,
    onHop: typeof onHop === 'function' ? onHop : undefined,
    agentOpts: agentOptsOf({ project, agents, run, denyPatterns, tools, mode: modeOf(mode), approve }),
  };
  const first = { seat: r.from, label: oneLine(startLabel) || seatLabel(findSeat(withReply, r.from)) };
  // The order every hop is told: the source, then the targets that can be sent to (a hop cap leaves the rest out). A skipped or
  // failed hop keeps its line, so the order is the route as it was planned.
  const limit = r.hops ?? r.targets.length;
  const order = [sourceMember(withReply, first), ...r.targets.slice(0, limit).map(id => member(findSeat(withReply, id)))];
  yield { type: 'relay-start', kind: 'route', route: r, hops: r.hops };

  const sent = new Set();
  let counted = 0;
  let stopped = null;
  if (sig.aborted) {
    stopped = 'user';
  } else if (r.kind === 'chain') {
    let last = { ...first, text };
    // The starting reply, kept so a hop can tell whether the reply before it is the start or a reply from this chain (frameHop).
    const start = last;
    for (let i = 0; i < r.targets.length; i += 1) {
      const hop = i + 1;
      if (r.hops !== null && hop > r.hops) {
        stopped = 'limit';
        break;
      }
      const to = findSeat(withReply, r.targets[i]);
      const hash = hashText(last.text);
      if (dedupe && sent.has(hash)) {
        yield { type: 'hop-skipped', hop, from: { seat: last.seat, label: last.label }, to: seatInfo(to), reason: 'duplicate' };
        continue;
      }
      // A hop after a failed one still gets the last good reply, which may be the starting reply: then it is the first hop's framing.
      const item = { kind: 'route', hop, from: { seat: last.seat, label: last.label }, to, text: last.text, note, request, frameHop: last === start ? 1 : hop, plan: { kind: 'chain', order, at: hop }, history: ctx.history, cwd, mode: ctx.mode, onHop: ctx.onHop, agentOpts: ctx.agentOpts };
      const step = yield* routeStep([item], ctx);
      counted += countDone(step.outs);
      if (step.status !== 'ok') {
        stopped = step.status;
        break;
      }
      sent.add(hash);
      const out = step.outs[0];
      if (sig.aborted) {
        stopped = 'user';
        break;
      }
      if (out.ok) {
        last = { seat: to.id, label: seatLabel(to), text: out.text };
      } else if (r.stopOnError) {
        stopped = 'error';
        break;
      }
    }
  } else {
    // A broadcast route is one step: every target gets the same reply, in parallel. Targets past the hop cap are not sent.
    const items = [];
    let cut = false;
    r.targets.forEach((id, i) => {
      if (r.hops !== null && i + 1 > r.hops) {
        cut = true;
        return;
      }
      items.push({ kind: 'route', hop: i + 1, from: first, to: findSeat(withReply, id), text, note, request, plan: { kind: 'broadcast', order, at: i + 1 }, history: ctx.history, cwd, mode: ctx.mode, onHop: ctx.onHop, agentOpts: ctx.agentOpts });
    });
    const step = yield* routeStep(items, ctx);
    counted += countDone(step.outs);
    if (step.status !== 'ok') stopped = step.status;
    else if (sig.aborted) stopped = 'user';
    else if (r.stopOnError && step.outs.some(o => !o.ok)) stopped = 'error';
    else if (cut) stopped = 'limit';
  }
  yield { type: 'relay-done', hops: counted, stopped: stopped ?? 'finished' };
}

// ---------- log ----------

const seatRecord = s => ({ seat: s?.seat ?? null, label: oneLine(s?.label, 120) });

// The last 200 relay records for one project, in memory. Only the fields below are kept; text is never stored.
export class RelayLog {
  #records = [];

  push(record) {
    const r = isObject(record) ? record : {};
    const entry = {
      at: Number.isFinite(r.at) ? r.at : Date.now(),
      hop: r.hop,
      kind: r.kind,
      from: seatRecord(r.from),
      to: seatRecord(r.to),
      chars: r.chars,
      sha256: r.sha256,
      ok: r.ok === true,
    };
    if (r.error) entry.error = oneLine(r.error, 300);
    this.#records.push(entry);
    if (this.#records.length > LOG_LIMIT) this.#records.splice(0, this.#records.length - LOG_LIMIT);
  }

  // Oldest first. Returns copies, so callers cannot change the log.
  list() {
    return this.#records.map(r => ({ ...r, from: { ...r.from }, to: { ...r.to } }));
  }

  clear() {
    this.#records.length = 0;
  }
}
