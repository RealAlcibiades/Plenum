// What every run and every waiting approval card is doing right now, for the Agents board (the Agents pane and Running now in the
// sidebar). Memory only: nothing here is written to disk, and a restart starts with nothing running. Nothing in it is a key, a token
// or a child environment; it carries what the page already shows for a run: the project and thread, the model, the last step and
// the counts, and for a waiting card the same text the chat card shows (the summary, the capped detail and the screenshot frame).
// The whole diff of a capped card is never kept here: GET /api/approve/detail serves it, and only while the approval waits.
//
// Every change is also published on the events channel (lib/events.mjs) as { type: 'activity', op, seq, ... }, so a window
// updates without polling. GET /api/activity (server.mjs) returns snapshot(), which carries the same seq, so a window can take
// the snapshot and then apply every event it has seen after it (public/ext-board.js does that).
//   op 'run-start'     { run }                  a run began (streamForProject, handleTurn, handleCompact)
//   op 'run-step'      { run }                  the model or the last step of a running run changed
//   op 'run-end'       { run }                  a run ended; run.status is done | error | stopped | cut-off | timed-out
//   op 'approval-add'  { card }                 a card started waiting
//   op 'approval-done' { approvalId, outcome, by, via? }  a card was answered or ended; by is 'board', 'chat' or '' (ended by the server);
//                                              via is the device id of the phone that answered it (absent for a desktop answer). The
//                                              run the card belongs to then carries run.via, the same id, until it ends.
//
// runs is keyed by scope id (the project id until threads land; a thread's own id after that).

import * as events from './events.mjs';

export const RECENT_MAX = 30;
const TEXT_MAX = 200;
const NAME_MAX = 80;
const KIND_MAX = 40;

const runs = new Map();       // scope id -> the run in progress
const recent = [];            // the last RECENT_MAX ended runs, newest first
const approvals = new Map();  // approval id -> the card waiting
const subscribers = new Set();
let seq = 0;

const clip = (value, n) => String(value ?? '').slice(0, n);
const count = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

// A copy that a caller may keep or change without touching the table.
const copyRun = run => ({ ...run, step: run.step ? { ...run.step } : null, tokens: run.tokens ? { ...run.tokens } : null });

// Tells the in-process subscribers and every window. A subscriber that throws is logged and skipped; the others still hear it.
function emit(op, data) {
  seq += 1;
  const msg = { op, seq, ...data };
  for (const fn of [...subscribers]) {
    try {
      fn(msg);
    } catch (err) {
      console.error('activity subscriber failed:', err.message);
    }
  }
  try {
    events.publish({ type: 'activity', ...msg });
  } catch (err) {
    console.error('activity could not be published:', err.message);
  }
}

// A run began. meta: { scope, projectId, projectName, threadName, kind, model, modelLabel }. The model may be unknown yet
// (a chat turn learns it with its start event, see runEvent).
export function runStarted(meta = {}) {
  const scope = String(meta.scope ?? meta.projectId ?? '');
  if (!scope) return null;
  const run = {
    scope,
    projectId: clip(meta.projectId ?? scope, 80),
    projectName: clip(meta.projectName, NAME_MAX),
    threadName: clip(meta.threadName || 'Main', NAME_MAX),
    kind: clip(meta.kind || 'run', KIND_MAX),
    model: typeof meta.model === 'string' ? meta.model : null,
    modelLabel: clip(meta.modelLabel, NAME_MAX),
    startedAt: Date.now(),
    step: null,
    tokens: null,
    status: null,
    error: '',
  };
  runs.set(scope, run);
  emit('run-start', { run: copyRun(run) });
  return copyRun(run);
}

// One event of a run's stream. start sets the model and its label; tool sets the last step; error and done set the status.
// Usage counts add to the run's tokens. Any other event changes nothing here.
export function runEvent(scope, ev) {
  const run = runs.get(String(scope ?? ''));
  if (!run || !ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'start': {
      if (typeof ev.model === 'string' && ev.model) run.model = clip(ev.model, 120);
      if (typeof ev.label === 'string' || typeof ev.modelLabel === 'string') run.modelLabel = clip(ev.label ?? ev.modelLabel, NAME_MAX);
      emit('run-step', { run: copyRun(run) });
      return;
    }
    case 'tool': {
      run.step = { name: clip(ev.name, KIND_MAX), summary: clip(ev.summary, TEXT_MAX), at: Date.now() };
      emit('run-step', { run: copyRun(run) });
      return;
    }
    case 'error': {
      run.status = 'error';
      run.error = clip(ev.message, TEXT_MAX);
      return;
    }
    case 'done': {
      const u = ev.usage && typeof ev.usage === 'object' ? ev.usage : null;
      if (u && (Number.isFinite(Number(u.input)) || Number.isFinite(Number(u.output)))) {
        run.tokens = {
          input: count(run.tokens?.input) + count(Number(u.input)),
          output: count(run.tokens?.output) + count(Number(u.output)),
        };
      }
      if (ev.timedOut) run.status = 'timed-out';
      else if (ev.aborted) run.status = 'stopped';
      else if (ev.stop === 'length') run.status = 'cut-off';
      else run.status = run.status === 'error' ? 'error' : 'done';
      return;
    }
    default:
      return;
  }
}

// A run ended: it leaves the running table and joins the recent list. opts.aborted and opts.timedOut settle a run whose stream
// never sent its own done (a run that was stopped before it reached the stream).
export function runEnded(scope, opts = {}) {
  const key = String(scope ?? '');
  const run = runs.get(key);
  if (!run) return null;
  runs.delete(key);
  if (!run.status) run.status = opts.timedOut ? 'timed-out' : opts.aborted ? 'stopped' : 'done';
  const ended = { ...copyRun(run), endedAt: Date.now() };
  recent.unshift(ended);
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  emit('run-end', { run: copyRun(ended) });
  return copyRun(ended);
}

// A card started waiting. card: the card the chat shows (approvalId, summary, detail, hasMore, defaultDeny, blocked, clickOnly,
// frame) plus the run's meta (scope, projectId, projectName, threadName, modelLabel, kind as runKind) and its time (at).
export function approvalAdded(card = {}) {
  const id = String(card.approvalId ?? '');
  if (!id) return null;
  const entry = {
    approvalId: id,
    summary: clip(card.summary, 1000),
    detail: typeof card.detail === 'string' ? card.detail : '',
    hasMore: card.hasMore === true,
    defaultDeny: card.defaultDeny === true,
    blocked: card.blocked === true,
    clickOnly: card.clickOnly === true,
    ...(card.frame && typeof card.frame === 'object' ? { frame: card.frame } : {}),
    scope: clip(card.scope ?? card.projectId, 80),
    projectId: clip(card.projectId ?? card.scope, 80),
    projectName: clip(card.projectName, NAME_MAX),
    threadName: clip(card.threadName || 'Main', NAME_MAX),
    modelLabel: clip(card.modelLabel, NAME_MAX),
    runKind: clip(card.runKind ?? card.kind ?? 'run', KIND_MAX),
    at: Number.isFinite(Number(card.at)) ? Number(card.at) : Date.now(),
  };
  approvals.set(id, entry);
  emit('approval-add', { card: { ...entry, ...(entry.frame ? { frame: { ...entry.frame } } : {}) } });
  return entry.approvalId;
}

// A card ended. outcome: approved | denied | timed-out | stopped. by: 'board' when the Agents board answered it, 'chat' when a chat
// card did (the page passes it on), '' when the server ended it. via: the device id of the phone that answered it ('' for a desktop
// answer; server.mjs passes it from x-plenum-device). A phone answer also sets run.via on the run the card belongs to, so the board
// can say via <device> for that run. Returns false for a card this table does not hold.
export function approvalDone(approvalId, outcome = 'denied', by = '', via = '') {
  const id = String(approvalId ?? '');
  const entry = approvals.get(id);
  if (!entry) return false;
  approvals.delete(id);
  const device = clip(via, 128);
  emit('approval-done', { approvalId: id, outcome: clip(outcome, 20), by: by === 'board' || by === 'chat' ? by : '', ...(device ? { via: device } : {}) });
  const run = device ? runs.get(entry.scope) : null;
  if (run) {
    run.via = device;
    emit('run-step', { run: copyRun(run) });
  }
  return true;
}

// Everything at once, for a window that has just connected. seq is the last change this snapshot includes.
export function snapshot() {
  return {
    seq,
    runs: [...runs.values()].map(copyRun),
    recent: recent.map(r => copyRun(r)),
    approvals: [...approvals.values()].sort((a, b) => a.at - b.at).map(c => ({ ...c, ...(c.frame ? { frame: { ...c.frame } } : {}) })),
  };
}

// How many cards wait now (every project).
export const waitingCount = () => approvals.size;

// Calls fn(message) for every change, in order. Returns the unsubscribe function.
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Tests only: clears every table and subscriber.
export function reset() {
  runs.clear();
  recent.length = 0;
  approvals.clear();
  subscribers.clear();
  seq = 0;
}
