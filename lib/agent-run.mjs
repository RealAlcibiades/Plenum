// The agent runner (agent-runner, with amendments 19, 20, 22 and 24). Every agent starts here: the delegate tool, /build's tasks, its
// planner and its reviewer, and Claude Code's Agent requests (offerFor). runAgent checks plan mode, the caller's allowed types, the
// nesting depth, the per-run ceiling and the caller's total, the model's capability, the type's folders, the spend cap and the optional
// start card; waits for a place (at most `concurrent` at once per caller, edit scopes that overlap one after another); then runs the
// model with the type's tools, counts tool steps, and stops at the type's step, time or idle limit, or when Stop is pressed. It adds
// the agent's API usage to the project's spend, and it never throws.
//
// The live registry below is the same table the runner counts with, so what a window shows (GET /api/agents/live, the `agent`
// events) is what the limits count.
//
// Events. An agent's own events go to the `emit` it was given, with `parent` set as the runs do: agent-state (queued, running,
// approval), agent-start, agent-done. The events channel (lib/events.mjs) also carries { type: 'agent', action: 'start' | 'state' |
// 'done', project, agent } for every change, `agent` being the live entry as liveAgents gives it (plus ok, error, stopped, elapsedMs,
// turns, changed and cost on 'done'), so a window that follows the channel needs no stream of its own.
//
// Nesting (amendment 20). limits.depth is how many levels exist (1: only the caller starts agents). limits.nested says what a nested
// agent may be: 'off' (no nesting), 'read' (read-only types only, the default when depth is 2 or more), or 'any' (any type the caller's
// row lists, an edit type only inside its parent's scope; the third level is read-only). When the saved block has no `nested`, it is
// 'read' for a depth of 2 or more and 'off' otherwise.
//
// Seats (agent-roles, with amendment 21). A council seat, the moderator, a relay hop, a quick compare column and a pipeline step are
// callers of their own. seatContext builds the tool context such a seat is given: the delegate tool alone (ctx.seatOnly), the limits of
// its role row and of the per-model overrides, and a count of its own (`${role}:${ref}:${seatId}`) inside the run's ceiling. It is
// undefined unless the seat may start something, so a council with the default settings makes no agent. While ROLE_META.cards is false
// for a role (no board routes the role's approval cards yet), limitsFor lets it start only read-only types that run no commands, the
// seat's approve answers no, and nothing here can show a card. When the Agents board lands and lib/agents.mjs sets cards for a role,
// seatContext hands that role the caller's approve and mode, and its edit and command types follow the ordinary rules (scope,
// folders, cards, the deny list). Nothing else in this file changes for that.
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamChat, labelFor, splitRef, normalizeEffort, billingFor } from './providers.mjs';
import { claudeRoute } from './claude-cli.mjs';
import { cleanReason, clip, normalizeScope, scopeAbs } from './tools.mjs';
import { typeByName, limitsFor, canRun, modelTools, agentSystem, describeTypes, ROLE_META } from './agents.mjs';
import { checkBudget, accrueReply } from './budget.mjs';
import { summarizeUsage } from './pricing.mjs';
import * as store from './store.mjs';
import { approveAllBlockedOf, chatModeOf } from './projects.mjs';
import { buildSystem, projectForRoot } from './prompt.mjs';
import { buildFocusOf } from './focus.mjs';
import { checkRef } from './pipelines.mjs';
import * as events from './events.mjs';

// ---------- snapshots (hash before and after a run), moved here from lib/delegate.mjs ----------

// Snapshots skip dependency and version-control folders; hashing a whole node_modules tree would be slow.
export const SNAP_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next']);
const SNAP_FILE_MAX = 2 * 1024 * 1024;
export const SNAP_FILES_MAX = 20_000;
const SNAP_KEEP_MAX = 64 * 1024 * 1024;

// Scope helpers for project-relative paths ("/" separators). Case is ignored on Windows.
export const fold = p => (process.platform === 'win32' ? p.toLowerCase() : p);
// True when rel is the scope entry itself or lies inside it.
export const within = (scope, rel) => fold(rel) === fold(scope) || fold(rel).startsWith(`${fold(scope)}/`);
// Two scopes overlap when one equals or lies inside the other. Overlapping tasks never run at once.
export const overlaps = (a, b) => a.some(x => b.some(y => within(x, y) || within(y, x)));

// Maps each project-relative file to its hash. With keep, the bytes of the files are kept too (up to a cap),
// so the review can diff against the state before the build.
export async function snapshot(root, { keep = false } = {}) {
  const files = new Map();
  let kept = 0;
  let truncated = false;
  const walk = async dir => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files.size >= SNAP_FILES_MAX) {
        truncated = true;
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SNAP_SKIP.has(e.name)) await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;
      // Very large files are compared by size and time instead of content.
      if (st.size > SNAP_FILE_MAX) {
        files.set(rel, { hash: `large:${st.size}:${st.mtimeMs}` });
        continue;
      }
      const data = await fs.readFile(full).catch(() => null);
      if (!data) continue;
      const entry = { hash: createHash('sha1').update(data).digest('hex') };
      if (keep && kept + data.length <= SNAP_KEEP_MAX) {
        entry.data = data;
        kept += data.length;
      }
      files.set(rel, entry);
    }
  };
  await walk(root);
  return { files, truncated };
}

// Project-relative paths that differ between two snapshots (added, removed or changed), sorted.
export function changedBetween(a, b) {
  const out = [];
  for (const [rel, entry] of b.files) {
    const old = a.files.get(rel);
    if (!old || old.hash !== entry.hash) out.push(rel);
  }
  for (const rel of a.files.keys()) if (!b.files.has(rel)) out.push(rel);
  return out.sort();
}

// Every agent that runs in this process, with its scope and when it ran. A file changed while two agents overlap belongs to the
// agent whose scope holds it, so concurrent agents (parallel delegate calls, or a build) do not report each other's files as out of scope.
const ledger = new Map(); // key -> { scope, start, end } (end is null while the agent runs)
let ledgerKeys = 0;
let ledgerTicks = 0;
export function enterLedger(scope, writes = false) {
  const key = ++ledgerKeys;
  const entry = { scope: scope ?? null, writes: Boolean(writes), start: ++ledgerTicks, end: null };
  ledger.set(key, entry);
  return { key, entry };
}
export function otherScopes(key, entry) {
  return [...ledger.entries()]
    .filter(([k, o]) => k !== key && o.scope && (o.end === null || o.end > entry.start))
    .map(([, o]) => o.scope);
}
// True when an agent that can write anywhere (it runs commands) was running at some point while this one ran. A change this agent sees
// may then be that agent's, so it is not blamed on a read-only agent.
export function otherWriters(key, entry) {
  return [...ledger.entries()].some(([k, o]) => k !== key && o.writes && !o.scope && (o.end === null || o.end > entry.start));
}
// A finished agent stays in the ledger while any other agent runs: that one may have overlapped it.
export function leaveLedger(entry) {
  if (entry) entry.end = ++ledgerTicks;
}
export function sweepLedger() {
  if (![...ledger.values()].some(o => o.end === null)) ledger.clear();
}

// ---------- texts ----------

const PLAN_TEXT = 'This project is in plan mode, so no agent can run. Turn plan mode off.';
const NO_NESTING = 'Agents cannot start agents here. To allow one level, turn on "Agents may start read-only agents" in Agents > Limits.';
const NESTED_READ = 'A nested agent must be read-only.';
const READ_PARENT = 'A read-only agent cannot start an agent that edits files.';
const CLI_OFF = 'Claude Code\'s own subagents are turned off in Agents > Limits (Chat).';
const seatOtherAgent = (name, offered) => `"${String(name ?? '').slice(0, 60)}" is not one of the agents this seat may start. It may start: ${offered.join(', ') || 'none'}.`;
const STOPPED_QUEUED = 'Stopped before it started.';
const MUSE_NOTICE = 'Muse Code has no read-only setting, so this agent runs in the project and Plenum checks afterwards whether it changed anything. Rewind can undo it.';
const MUSE_EMPTY = 'Muse Code has no read-only setting, so this agent ran in an empty folder.';
const CURSOR_EMPTY = 'Cursor has no read-only setting, so this agent ran in an empty folder.';
const GROK_EMPTY = 'Grok Build has no read-only setting, so this agent ran in an empty folder.';
const NO_WRITE_COMMANDS = provider => `${provider === 'codex' ? 'Codex' : 'Gemini'} runs this agent read-only, so commands that write files could not run.`;
const STOP_ERROR = {
  user: 'Stopped by the user.',
  parent: 'Stopped.',
};

const stopText = (why, type) => {
  if (why === 'timeout') return `Stopped after ${type.timeoutMin} minutes (the type's time limit).`;
  if (why === 'idle') return `Stopped after ${type.idleMin} minutes with no output (the type's idle limit).`;
  if (why === 'steps') return `Stopped at its limit of ${type.maxSteps} tool steps.`;
  return STOP_ERROR[why] ?? 'Stopped.';
};

// m:ss
export const clock = ms => {
  const s = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const accessWord = type => (!type.files ? 'no file access' : type.kind === 'edit' ? 'edits files' : 'reads files');

// ---------- nesting ----------

// What the block says about agents that start agents: { mode: 'off' | 'read' | 'any', depth }. depth is the number of levels.
export function nestingOf(agents) {
  const raw = agents?.limits ?? {};
  const depth = Number.isInteger(raw.depth) ? raw.depth : 1;
  const mode = raw.nested === 'off' || raw.nested === 'read' || raw.nested === 'any' ? raw.nested : (depth >= 2 ? 'read' : 'off');
  if (mode === 'off') return { mode, depth: 1 };
  return { mode, depth: Math.min(3, Math.max(2, depth)) };
}

// The role whose row of Limits applies: a nested agent follows the role of the call that started the whole tree.
const rootRoleOf = caller => (caller.role === 'agent' ? (caller.rootRole ?? 'chat') : caller.role);

// Whether an agent of this type may be started by this caller, as to kind. null when it may, else the refusal.
function nestedRefusal(nest, caller, type) {
  if (caller.depth < 1 || type.kind === 'read') return null;
  if (nest.mode !== 'any' || caller.depth >= 2) return NESTED_READ;
  if (caller.kind !== 'edit') return READ_PARENT;
  return null;
}

// The types an agent at `depth` (the new agent's own depth) may start: none at the last level.
export function delegableFor({ agents, lim, depth, kind }) {
  const nest = nestingOf(agents);
  if (depth >= nest.depth) return [];
  const caller = { depth, kind };
  return lim.types
    .map(name => typeByName(agents, name))
    .filter(t => t && !t.buildOnly && nestedRefusal(nest, caller, t) === null);
}

// ---------- runs and the live registry ----------

// A run is one chat turn, one build, one council, one relay send or route, one compare, one pipeline run.
export function openRun({ projectId, kind = 'chat', signal } = {}) {
  const run = {
    id: randomUUID(),
    projectId,
    kind,
    signal: signal ?? null,
    total: 0,
    active: 0,
    callers: new Map(),
    queue: [],
    agents: new Map(),
    closed: false,
    // Aborts every agent still queued and takes the run's agents out of the live registry.
    close() {
      if (run.closed) return;
      run.closed = true;
      for (const waiter of [...run.queue]) waiter.abort('parent');
      run.queue.length = 0;
      for (const id of run.agents.keys()) live.delete(id);
    },
  };
  return run;
}

// agent id -> entry. The fields are listed at the top of this file's registry code; `stop` is never sent out.
const live = new Map();

const plain = entry => {
  const { stop, cancel, edit, scope, running, ...rest } = entry;
  void stop;
  void cancel;
  void edit;
  void scope;
  void running;
  return { ...rest, elapsedMs: Math.max(0, Date.now() - entry.startedAt) };
};

export function liveAgents(projectId) {
  return [...live.values()]
    .filter(e => e.projectId === projectId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(plain);
}

// Stops one running or queued agent of the project. True when it was found and can be stopped here.
export function stopAgent(projectId, id) {
  const entry = live.get(id);
  if (!entry || entry.projectId !== projectId || entry.stoppable === false) return false;
  entry.stop('user');
  return true;
}

// Stops every agent of the project that can be stopped here. Returns how many.
export function stopAll(projectId) {
  let n = 0;
  for (const entry of [...live.values()]) {
    if (entry.projectId !== projectId || entry.stoppable === false) continue;
    entry.stop('user');
    n += 1;
  }
  return n;
}

// How many agents of the project are in the registry now (queued or running).
export const liveCount = projectId => [...live.values()].filter(e => e.projectId === projectId).length;

function publish(action, entry, extra = {}) {
  try {
    events.publish({ type: 'agent', action, project: entry.projectId, agent: { ...plain(entry), ...extra } });
    events.publishState('agents');
  } catch {
    // The events channel must never stop an agent.
  }
}

// ---------- counters, the queue and admission ----------

const callerKey = caller => (caller.role === 'agent' ? `agent:${caller.parentId ?? ''}` : `${caller.role}:${caller.ref ?? ''}:${caller.seat ?? ''}`);
const callerOf = (run, key) => {
  let c = run.callers.get(key);
  if (!c) {
    c = { total: 0, active: 0 };
    run.callers.set(key, c);
  }
  return c;
};

// The refusals that come before a model is chosen: types, nesting depth, the run's ceiling and the caller's total. Returns
// { ok: true, lim, nest, key } or { ok: false, error }. `type` is null for a Claude Code subagent that Plenum does not define.
function precheck({ run, caller, agents, type, internal }) {
  const role = rootRoleOf(caller);
  if (!ROLE_META[role]) return { ok: false, error: `${caller.label} cannot start agents here: it is not a role that has limits.` };
  const lim = limitsFor(agents, role, caller.ref);
  const nest = nestingOf(agents);
  const key = callerKey(caller);
  if (internal) return { ok: true, lim, nest, key };
  if (type && !lim.types.includes(type.name)) {
    return { ok: false, error: `${caller.label} may not start the ${type.label} type here. It may start: ${lim.types.join(', ') || 'none'} (Agents > Limits).` };
  }
  if (lim.concurrent < 1 || lim.total < 1) {
    return { ok: false, error: `${caller.label} may not start agents here: At once or the per-run number is 0 (Agents > Limits).` };
  }
  if (caller.depth >= nest.depth) return { ok: false, error: NO_NESTING };
  if (type) {
    const why = nestedRefusal(nest, caller, type);
    if (why) return { ok: false, error: why };
  }
  if (run.total >= lim.perRun) {
    return { ok: false, error: `This run has already started ${lim.perRun} agents, the most allowed in one run (Agents > Limits).` };
  }
  if (callerOf(run, key).total >= lim.total) {
    return { ok: false, error: `${caller.label} has started ${lim.total} agents in this run, its limit. Finish with what you have.` };
  }
  return { ok: true, lim, nest, key };
}

// Counts the start at once, so several calls made together cannot all pass the check. undo() gives the count back when the agent
// never starts (a refusal, a denied card, a stop while it waited).
function reserve(run, key) {
  run.total += 1;
  const c = callerOf(run, key);
  c.total += 1;
  let undone = false;
  return {
    undo() {
      if (undone) return;
      undone = true;
      run.total -= 1;
      c.total -= 1;
    },
  };
}

const isAncestor = (run, ancestorId, entry) => {
  const seen = new Set();
  let at = entry.parentId;
  while (at && !seen.has(at)) {
    if (at === ancestorId) return true;
    seen.add(at);
    at = run.agents.get(at)?.parentId;
  }
  return false;
};

// Why this waiter cannot start now: 'slot' (the caller's At once, or the run's), 'scope' (an edit agent holds overlapping files), or null.
function blocker(run, w) {
  const c = callerOf(run, w.key);
  if (c.active >= w.lim.concurrent || run.active >= w.lim.perRun) return 'slot';
  if (w.entry.edit && w.entry.scope) {
    for (const other of run.agents.values()) {
      if (other === w.entry || !other.running || !other.edit || !other.scope) continue;
      if (isAncestor(run, other.id, w.entry)) continue;
      if (overlaps(other.scope, w.entry.scope)) return 'scope';
    }
  }
  return null;
}

// Starts every waiter that can start, in queue order.
function pump(run) {
  for (const w of [...run.queue]) {
    const why = blocker(run, w);
    if (why) {
      if (w.entry.why !== why) {
        w.entry.why = why;
        announce(w, 'agent-state');
      }
      continue;
    }
    run.queue.splice(run.queue.indexOf(w), 1);
    run.active += 1;
    callerOf(run, w.key).active += 1;
    w.entry.running = true;
    w.admitted = true;
    w.go();
  }
}

// Tells the run's stream and the events channel what an entry is now.
function announce(w, type) {
  const entry = w.entry;
  const ev = { type, id: entry.id, parent: w.parent, state: entry.state, why: entry.why, turns: entry.turns };
  try {
    w.emit?.(ev);
  } catch {
    // A broken stream must not stop an agent.
  }
  publish('state', entry);
}

// Registers an entry as queued and waits until it may start. Resolves { ok: true, release } or { ok: false, error, stopped }.
// The entry is in the live registry from here until release() (or a failed wait) takes it out.
function admit({ run, entry, lim, key, signal, emit, parent }) {
  live.set(entry.id, entry);
  run.agents.set(entry.id, entry);
  const finish = () => {
    live.delete(entry.id);
    run.agents.delete(entry.id);
  };
  return new Promise(resolve => {
    const w = { entry, lim, key, emit, parent, admitted: false, go: null, abort: null };
    const onAbort = () => w.abort('parent');
    signal?.addEventListener('abort', onAbort, { once: true });
    w.abort = why => {
      if (w.admitted) return;
      const at = run.queue.indexOf(w);
      if (at >= 0) run.queue.splice(at, 1);
      signal?.removeEventListener('abort', onAbort);
      finish();
      resolve({ ok: false, error: STOPPED_QUEUED, stopped: why });
    };
    w.go = () => {
      signal?.removeEventListener('abort', onAbort);
      let freed = false;
      resolve({
        ok: true,
        release() {
          if (freed) return;
          freed = true;
          run.active -= 1;
          callerOf(run, key).active -= 1;
          entry.running = false;
          finish();
          pump(run);
        },
      });
    };
    entry.cancel = why => w.abort(why);
    if (signal?.aborted) return w.abort('parent');
    const first = blocker(run, w);
    if (first) {
      entry.why = first;
      announce(w, 'agent-state');
    }
    run.queue.push(w);
    pump(run);
    return undefined;
  });
}

function newEntry({ run, caller, type, name, label, kind, ref, title, task, inside, stoppable, edit, scope, project }) {
  const now = Date.now();
  return {
    id: randomUUID(),
    projectId: project.id,
    runId: run.id,
    parentId: caller.parentId ?? null,
    parentLabel: caller.parentLabel ?? null,
    role: caller.role,
    callerRef: caller.ref ?? null,
    callerLabel: caller.label,
    seat: caller.seat ?? null,
    taskId: task?.id ?? null,
    agent: type?.name ?? name,
    label: type?.label ?? label,
    kind: type?.kind ?? kind,
    model: ref,
    modelLabel: ref ? labelFor(ref) : '',
    title,
    startedAt: now,
    lastAt: now,
    turns: 0,
    state: 'queued',
    why: null,
    inside,
    stoppable,
    edit: Boolean(edit),
    scope: scope ?? null,
    running: false,
    // Until the agent starts, Stop ends the wait; runInner replaces it with the real stop.
    stop(why) {
      this.cancel(why ?? 'user');
    },
    cancel: () => {},
  };
}

// ---------- the task prompt ----------

function taskPrompt(title, instructions, { edit, scope }) {
  return [
    `Task: ${title}`,
    edit
      ? `Scope (the only files and folders you may change): ${scope.join(', ')}`
      : `Focus: ${scope?.length ? scope.join(', ') : '(the whole project)'}`,
    'Instructions:',
    String(instructions).trim(),
  ].join('\n');
}

// What a project's "Coders that cannot ask" setting says: true to refuse such a coder. Unset or 'run' runs it, anything else
// refuses (the safe side). `explicit` ('run' or 'refuse') wins over the project's saved value. Same reading as codersCannotAskOf in
// lib/projects.mjs, which this file reads through the project record.
function refusesCodersThatCannotAsk(explicit, project) {
  const raw = explicit ?? project?.settings?.codersCannotAsk;
  if (raw === undefined || raw === null) return false;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return !(v === '' || v === 'run');
}

// Headless Gemini and Codex cannot ask before they write (amendment 22). In Ask first they edit on their own inside the project
// (Codex in its workspace-write sandbox, Gemini with auto_edit) unless the project's setting is refuse.
const CANNOT_ASK = { gemini: 'Gemini', codex: 'Codex' };
const REFUSE_TEXT = who => `${who} can only edit when approvals are set to Auto-approve or Approve all, because ${who === 'Gemini' ? 'headless Gemini' : 'Codex'} cannot ask before it writes, and this project is set to refuse coders that cannot ask. Switch the approval mode, change "Coders that cannot ask" in the project settings, or use another coder.`;
const NO_ASK_NOTICE = 'Codex and Gemini cannot ask before they write. In Ask first they edit on their own inside the project; Plenum lists what changed, and Rewind can undo it. Commit first.';

const openMode = mode => mode === 'auto' || mode === 'all';
const transcriptOf = project => store.get().chats?.[project?.id] ?? [];

// ---------- one agent ----------

// A stop ends the agent's stream at once, but the stream and the process behind it (a command, a CLI child) may still be writing for a
// moment. After a stop the runner waits this long for the stream to end before it takes the after-snapshot and frees the agent's place
// in the scope, so those last writes are listed with this agent. A stream that ignores the stop is left running after the wait.
const STOP_GRACE_MS = 1000;
// Resolves when promise settles, or after ms, whichever comes first. Never rejects, and the timer is cleared when the promise settles first.
function settleWithin(promise, ms) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => {}, () => {}), timeout]).finally(() => clearTimeout(timer));
}

// opts: { run, caller: { role, ref, label, seat?, depth, parentId?, parentLabel?, rootRole?, kind?, scope? }, agents, type, task: { id?, title,
// instructions, scope, agent }, project, root, mode, signal, approve, emit, parent, tools, denyPatterns, focus, rules, fallbackRef,
// modelOverride, effortOverride, callerEffort, stream = streamChat, clocks, internal, system, codersCannotAsk, onDelta }.
// onDelta (optional) gets each piece of the agent's reply as it arrives (the build's review shows its text as it is written).
// internal marks a run that /build itself starts (its planner and reviewer): the caller's type list and totals do not apply to it, and
// `system` is the fixed text it runs on. clocks ({ timeoutMs, idleMs }) is for tests only.
// Returns { ok, summary, changed, outOfScope, error?, stopped?, elapsedMs, turns, cost, agentId, usage }. A start that was refused
// before the agent began also has refused: true (and why: 'settings' or 'input'); a start card that was denied has denied: true.
export async function runAgent(opts) {
  try {
    return await runInner(opts ?? {});
  } catch (err) {
    return { ok: false, summary: '', changed: [], outOfScope: [], error: err?.message || String(err), elapsedMs: 0, turns: 0, cost: null, usage: null, agentId: null };
  }
}

async function runInner(opts) {
  const {
    run, caller, agents, type, task = {}, project, root, mode = 'ask', signal, approve, emit, parent, tools, denyPatterns = [],
    rules, fallbackRef, modelOverride, effortOverride, callerEffort, stream = streamChat, clocks = {}, internal = false,
    system: systemOverride, codersCannotAsk,
  } = opts;
  const title = clip(String(task.title || task.id || 'Task').trim(), 120);
  const refuse = (error, why = 'settings', more = {}) => ({ ok: false, summary: '', changed: [], outOfScope: [], error, refused: true, why, elapsedMs: 0, turns: 0, cost: null, usage: null, agentId: null, ...more });
  if (!type || !run || !caller || !agents) return refuse('This agent could not start: the type, the run, the caller or the settings are missing.', 'input');
  if (!String(task.instructions ?? '').trim()) return refuse(`Task "${title}" has no instructions.`, 'input');

  // (1) plan mode. The planner reads only the text it is given and has been allowed in plan mode all along (handlePlan).
  if (chatModeOf(project) === 'plan' && !type.buildOnly) return refuse(PLAN_TEXT);
  // (2) to (5): types, depth, the run's ceiling and the caller's total.
  const pre = precheck({ run, caller, agents, type, internal });
  if (!pre.ok) return refuse(pre.error);
  const { lim, key } = pre;
  // A run that /build starts itself (its planner and reviewer) always gets a place, even when the row says 0 at once.
  const admitLim = internal ? { ...lim, concurrent: Math.max(1, lim.concurrent), perRun: Math.max(1, lim.perRun) } : lim;
  const reservation = internal ? null : reserve(run, key);
  const giveBack = () => reservation?.undo();
  const sorry = (error, why) => {
    giveBack();
    return refuse(error, why);
  };

  // (6) the model.
  let ref;
  try {
    ref = checkRef(modelOverride ?? type.model ?? fallbackRef ?? caller.ref);
  } catch (err) {
    return sorry(err.message, 'input');
  }
  const can = canRun(ref, type.kind);
  if (!can.ok) return sorry(can.why, 'input');
  const { provider } = splitRef(ref);
  const tcap = modelTools(ref);
  const edit = type.kind === 'edit';
  const textOnly = !type.files || tcap === 'no';
  const ownTools = !textOnly && tcap === 'yes';

  // (7) the scope.
  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch (err) {
    return sorry(`Task "${title}": ${err.message}`, 'input');
  }
  let scope = null;
  if (edit) {
    try {
      scope = await normalizeScope(realRoot, task.scope);
    } catch (err) {
      return sorry(`Task "${title}": ${err.message}`, 'input');
    }
    const stray = type.folders.length ? scope.find(rel => !type.folders.some(f => within(f, rel))) : null;
    if (stray) return sorry(`Scope "${stray}" is outside the folders this type may write in: ${type.folders.join(', ')}.`, 'input');
    if (caller.depth >= 1 && caller.kind === 'edit' && Array.isArray(caller.scope)) {
      const loose = scope.find(rel => !caller.scope.some(s => within(s, rel)));
      if (loose) return sorry(`Scope "${loose}" is outside the scope of the agent that asked: ${caller.scope.join(', ')}.`, 'input');
    }
  } else if (Array.isArray(task.scope) ? task.scope.length : task.scope) {
    try {
      scope = await normalizeScope(realRoot, task.scope);
    } catch (err) {
      return sorry(`Task "${title}": ${err.message}`, 'input');
    }
  }
  // Headless Gemini and Codex cannot ask before they write; the project can refuse them (amendment 22).
  const cannotAsk = edit && Object.hasOwn(CANNOT_ASK, provider) && !openMode(mode);
  if (cannotAsk && refusesCodersThatCannotAsk(codersCannotAsk, project)) return sorry(REFUSE_TEXT(CANNOT_ASK[provider]), 'input');

  // (8) the spend cap, for a model billed per token.
  const billing = await billingFor(ref);
  if (billing === 'api') {
    try {
      checkBudget(project, transcriptOf(project), 'api');
    } catch (err) {
      return sorry(err.message, 'settings');
    }
  }

  const effort = normalizeEffort(effortOverride ?? type.effort ?? callerEffort ?? 'high');

  // (9) the start card, when the caller's row asks first. Approve all answers it.
  if (!internal && lim.askToStart && typeof approve === 'function' && mode !== 'all') {
    const shown = scope?.length ? scope.join(', ') : 'whole project';
    const card = {
      summary: `Start ${type.label} agent: ${title}`,
      detail: [
        `Type: ${type.label} (${accessWord(type)}${type.commands ? ', runs commands' : ''})`,
        `Model: ${labelFor(ref)}`,
        `Effort: ${effort}`,
        `Scope: ${clip(shown, 400)}`,
        `Limits: ${type.maxSteps} tool steps, ${type.timeoutMin} min`,
        '',
        'Instructions:',
        clip(String(task.instructions ?? ''), 2000),
      ].join('\n'),
    };
    const allowed = await approve(card);
    if (!allowed) {
      giveBack();
      const reason = cleanReason(card.reason);
      const denied = {
        ...refuse(`The user did not allow this agent to start.${reason ? ` The user said: ${reason}` : ''}`),
        refused: false,
        denied: true,
        reason,
      };
      const gone = newEntry({ run, caller, type, ref, title, task, inside: 'plenum', stoppable: true, edit, scope, project });
      try {
        emit?.({ type: 'agent-done', id: gone.id, ...(parent ? { parent } : {}), ok: false, stopped: 'denied', elapsedMs: 0, turns: 0, changed: 0, cost: null, agent: gone.agent, label: gone.label, title, kind: gone.kind, model: ref, modelLabel: gone.modelLabel });
      } catch {
        // A broken stream must not change the answer.
      }
      return denied;
    }
  }

  // (10) the live entry, and the wait for a place.
  const entry = newEntry({ run, caller, type, ref, title, task, inside: 'plenum', stoppable: true, edit, scope, project });
  const nestedParent = parent;
  const outEmit = ev => {
    if (typeof emit !== 'function') return;
    emit(nestedParent ? { ...ev, parent: nestedParent } : ev);
  };
  const waiting = admit({ run, entry, lim: admitLim, key, signal: combine(signal, run.signal), emit: outEmit, parent: nestedParent });
  // admit() runs its first check before it returns, so a wait that is already known has set why by now.
  const wasQueued = entry.why !== null;
  const admitted = await waiting;
  if (!admitted.ok) {
    giveBack();
    const text = admitted.error;
    try {
      outEmit({ type: 'agent-done', id: entry.id, ok: false, error: text, stopped: admitted.stopped, elapsedMs: Date.now() - entry.startedAt, turns: 0, changed: 0, cost: null, agent: type.name, label: type.label, title, kind: type.kind, model: ref, modelLabel: entry.modelLabel });
    } catch {
      // A broken stream must not change the answer.
    }
    publish('done', entry, { ok: false, error: text, stopped: admitted.stopped, turns: 0, changed: 0, cost: null });
    return { ...refuse(text), refused: false, stopped: admitted.stopped, agentId: entry.id };
  }

  // From here the agent has started, and its count stays.
  entry.state = 'running';
  entry.why = null;
  if (wasQueued) announce({ entry, emit: outEmit, parent: nestedParent }, 'agent-state');
  const ranAt = Date.now();
  let stopped = null;
  const child = new AbortController();
  let abortedPromise;
  const aborted = new Promise(resolve => {
    abortedPromise = resolve;
  });
  child.signal.addEventListener('abort', () => abortedPromise(), { once: true });
  let pendingCard = null;
  const stopWith = why => {
    if (stopped) return;
    stopped = why;
    entry.state = 'running';
    child.abort();
    if (pendingCard?.approvalId && typeof approve?.close === 'function') {
      try {
        approve.close(pendingCard.approvalId, 'The agent was stopped.');
      } catch {
        // The card is already gone.
      }
    }
  };
  entry.stop = why => stopWith(why ?? 'user');
  const detach = [];
  for (const s of [signal, run.signal]) {
    if (!s) continue;
    if (s.aborted) stopWith('parent');
    else {
      const on = () => stopWith('parent');
      s.addEventListener('abort', on, { once: true });
      detach.push(() => s.removeEventListener('abort', on));
    }
  }

  // The clocks: the wall clock and the idle clock, both paused while a card waits.
  const wallMs = clocks.timeoutMs ?? type.timeoutMin * 60_000;
  const idleMs = clocks.idleMs ?? type.idleMin * 60_000;
  let wallLeft = wallMs;
  let wallFrom = 0;
  let wallTimer = null;
  let idleTimer = null;
  let cards = 0;
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (cards === 0 && !stopped) idleTimer = setTimeout(() => stopWith('idle'), idleMs);
  };
  const armWall = () => {
    clearTimeout(wallTimer);
    wallFrom = Date.now();
    wallTimer = setTimeout(() => stopWith('timeout'), Math.max(1, wallLeft));
  };
  const touch = () => {
    entry.lastAt = Date.now();
    armIdle();
  };
  const cardOpen = () => {
    cards += 1;
    if (cards !== 1) return;
    clearTimeout(idleTimer);
    clearTimeout(wallTimer);
    wallLeft = Math.max(1, wallLeft - (Date.now() - wallFrom));
    entry.state = 'approval';
    announce({ entry, emit: outEmit, parent: nestedParent }, 'agent-state');
  };
  const cardClosed = () => {
    cards = Math.max(0, cards - 1);
    if (cards !== 0) return;
    entry.state = 'running';
    announce({ entry, emit: outEmit, parent: nestedParent }, 'agent-state');
    armWall();
    armIdle();
  };
  armWall();
  armIdle();

  // (11) start.
  const childDepth = caller.depth + 1;
  const nowLim = limitsFor(agents, rootRoleOf(caller), ref);
  const delegable = delegableFor({ agents, lim: nowLim, depth: childDepth, kind: type.kind });
  const childCaller = {
    role: 'agent',
    rootRole: rootRoleOf(caller),
    ref,
    label: `${type.label} (${labelFor(ref)})`,
    depth: childDepth,
    parentId: entry.id,
    parentLabel: `${type.label} · ${title}`,
    kind: type.kind,
    scope: scope ?? undefined,
  };
  try {
    outEmit({ type: 'agent-start', id: entry.id, role: caller.role, caller: { ref: caller.ref ?? null, label: caller.label, seat: caller.seat ?? null }, agent: type.name, label: type.label, kind: type.kind, model: ref, modelLabel: entry.modelLabel, title, startedAt: entry.startedAt, limits: { maxSteps: type.maxSteps, timeoutMin: type.timeoutMin, idleMin: type.idleMin }, inside: 'plenum', state: 'running' });
  } catch {
    // A broken stream must not stop an agent.
  }
  publish('start', entry);

  // The child's events: every tool event counts a step, every event is activity, and the tool_result that reaches the step limit stops it.
  const nested = ev => {
    if (!ev || typeof ev !== 'object') return;
    const step = ev.type === 'tool' && !ev.parent;
    // After a stop no new step starts (its row would stay 'running' for good), but the result of the step in flight still goes out.
    if (step && stopped) return;
    touch();
    if (step) entry.turns += 1;
    try {
      outEmit(ev);
    } catch {
      // A broken stream must not stop an agent.
    }
    if (step) announce({ entry, emit: outEmit, parent: nestedParent }, 'agent-state');
    if (ev.type === 'tool_result' && !ev.parent && !stopped && entry.turns >= type.maxSteps) stopWith('steps');
  };
  if (cannotAsk) nested({ type: 'notice', kind: 'cli-no-ask', coder: ref, text: NO_ASK_NOTICE });

  // Every approval names the agent it belongs to. The clocks stand still while a card waits.
  const approveTask = async (plan, handle) => {
    if (!approve) return false;
    const card = { ...plan, summary: `${type.label} · ${title}: ${plan.summary}` };
    // The requester puts the card's id on this object, so Stop can close a card that is waiting.
    pendingCard = handle !== null && typeof handle === 'object' ? handle : {};
    cardOpen();
    let allowed = false;
    try {
      allowed = await approve(card, pendingCard);
    } finally {
      pendingCard = null;
      cardClosed();
    }
    if (card.reason) plan.reason = card.reason;
    return allowed;
  };
  if (typeof approve?.close === 'function') approveTask.close = (id, reason) => approve.close(id, reason);

  // (12) the context, the working folder and the tools by what the model can do.
  let ctx;
  let cwd = realRoot;
  let readOnly = false;
  let runMode = mode;
  let runTools = tools;
  const notes = [];
  const agentInfo = { name: type.name, label: type.label, kind: type.kind, files: type.files, commands: type.commands, web: type.web, folders: type.folders, returns: type.returns, maxSteps: type.maxSteps };
  const ctxBase = () => ({
    root: realRoot,
    projectId: project.id,
    ref,
    denyPatterns,
    answerBlocked: approveAllBlockedOf(project),
    mode,
    signal: child.signal,
    out: { api: [], tools: [] },
    emit: nested,
    approve: approveTask,
    scope: edit ? { rel: scope, abs: scopeAbs(realRoot, scope) } : null,
    agent: agentInfo,
    agents,
    agentRun: run,
    caller: childCaller,
    project,
    focus: opts.focus === true,
    rules,
    tools,
    effort,
    maxRequests: type.maxSteps,
    delegable,
    // Tests give a fake stream; the agents this agent starts use it too. Left out, they use the real providers.
    agentStream: opts.stream,
  });
  let scratchDir = null;
  if (textOnly) {
    // No tools at all: the model answers from the prompt, in an empty folder.
    readOnly = true;
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-agent-'));
    cwd = scratchDir;
    runMode = 'ask';
  } else if (ownTools) {
    ctx = ctxBase();
    runMode = mode;
  } else if (edit) {
    // Codex, Gemini, Muse Code, Cursor and Grok Build edit through their own tools. Cursor and Grok Build ask through the context (the
    // card, the task scope, the project's deny patterns and the blocked-answer rule); the others cannot ask, so the hash comparison
    // afterwards lists what they changed.
    if (provider === 'cursor' || provider === 'grok') ctx = ctxBase();
    if (provider === 'gemini' && mode !== 'all') runMode = 'coder';
  } else {
    // A read-only agent on a CLI model: Codex in its read-only sandbox and Gemini in plan mode, both in the project; Muse Code in the project
    // with its write and shell switches off (unless the project says otherwise); Cursor and Grok Build in an empty folder.
    runMode = 'ask';
    if (provider === 'muse') {
      const reads = project?.settings?.museReadsProject !== false;
      if (reads) {
        const saved = tools?.muse ?? {};
        runTools = { ...tools, muse: { ...saved, disableWrite: true, disableShell: !type.commands } };
        notes.push({ notice: MUSE_NOTICE });
      } else {
        readOnly = true;
        notes.push({ summary: MUSE_EMPTY });
      }
    } else if (provider === 'cursor' || provider === 'grok') {
      readOnly = true;
      notes.push({ summary: provider === 'grok' ? GROK_EMPTY : CURSOR_EMPTY });
    } else {
      readOnly = true;
      if (type.commands && (provider === 'codex' || provider === 'gemini')) notes.push({ summary: NO_WRITE_COMMANDS(provider) });
    }
  }
  if (provider === 'muse' && !textOnly) {
    // Muse Code's step count is capped by its own setting (the most it takes is 200).
    const saved = Number(runTools?.muse?.maxModelSteps) || 200;
    runTools = { ...runTools, muse: { ...(runTools?.muse ?? {}), maxModelSteps: String(Math.min(type.maxSteps, saved, 200)) } };
  }
  for (const n of notes) if (n.notice) nested({ type: 'notice', kind: 'muse-readonly', text: n.notice });

  // The agent that starts agents through Claude Code gets the Agent tool with the nested read-only types.
  if (ownTools && delegable.length) {
    ctx.agentsOffer = offerFor({ agents, caller: childCaller, run, project, root: realRoot, denyPatterns, mode, approve: approveTask, emit: nested, tools, rules, signal: child.signal });
  }

  // (13) the system text and the first message.
  const delegableText = delegable;
  const wantsFocus = buildFocusOf(project);
  const contextName = type.buildOnly ? 'planner' : (edit ? 'coder' : 'reviewer');
  // A read-only type that is not the Reviewer has its own focus line (agentSystem); the prompt parts add the Coder's, Planner's and Reviewer's.
  const ownFocus = !edit && !type.buildOnly && type.name !== 'reviewer';
  const before = type.files ? await snapshot(realRoot) : null;
  const lent = enterLedger(edit ? scope : null, type.commands || edit);
  let text = '';
  let error = null;
  let after = null;
  let claimed = [];
  let unclaimedWriters = false;
  const reports = [];
  try {
    try {
      const baseText = typeof systemOverride === 'string' ? systemOverride : agentSystem(type, { focus: ownFocus && wantsFocus, delegable: delegableText });
      const system = await buildSystem(contextName, {
        root: realRoot,
        projectId: project.id,
        project: ownFocus ? { ...project, buildFocus: false } : project,
        mode,
        ref,
        rules,
        readOnly: !edit,
        base: [baseText],
        extra: { task: { id: task.id, title, instructions: task.instructions }, scope },
      });
      const content = internal ? String(task.instructions) : taskPrompt(title, task.instructions, { edit, scope });
      const messages = [{ role: 'user', content }];
      if (!stopped) {
        const consume = (async () => {
          for await (const delta of stream(ref, { system, messages, cwd, signal: child.signal, ctx, mode: runMode, effort, tools: runTools, readOnly, onUsage: r => reports.push(r) })) {
            if (stopped) continue;
            text += delta;
            touch();
            try {
              opts.onDelta?.(delta);
            } catch {
              // A broken listener must not stop an agent.
            }
          }
        })();
        consume.catch(() => {});
        await Promise.race([consume, aborted]);
        if (stopped) await settleWithin(consume, STOP_GRACE_MS);
      }
    } catch (err) {
      if (!stopped) error = err?.message || String(err);
    }
    after = before ? await snapshot(realRoot) : null;
  } finally {
    leaveLedger(lent.entry);
    claimed = otherScopes(lent.key, lent.entry);
    unclaimedWriters = otherWriters(lent.key, lent.entry);
    sweepLedger();
    clearTimeout(wallTimer);
    clearTimeout(idleTimer);
    for (const off of detach) off();
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
  const finalText = text;

  // (14) what changed, and why it ended.
  let changed = [];
  let outOfScope = [];
  if (before && after) {
    const raw = changedBetween(before, after);
    if (edit) {
      const mine = rel => scope.some(s => within(s, rel)) && (!type.folders.length || type.folders.some(f => within(f, rel)));
      changed = raw.filter(rel => mine(rel) || !claimed.some(sc => sc.some(s => within(s, rel))));
      outOfScope = changed.filter(rel => !mine(rel));
    } else {
      changed = raw.filter(rel => !claimed.some(sc => sc.some(s => within(s, rel))));
    }
  }
  let summary = finalText.trim();
  if (stopped) error = stopText(stopped, type);
  else if (!error && edit && outOfScope.length) error = `Changed outside the scope: ${outOfScope.slice(0, 5).join(', ')}`;
  else if (!error && !edit && type.files && !type.commands && changed.length && !unclaimedWriters) {
    error = `A read-only agent changed files: ${changed.slice(0, 5).join(', ')}.`;
  } else if (!error && !edit && type.files && !type.commands && changed.length) {
    // An agent that runs commands was running too, and may have made the change: it is listed, not blamed on this one.
    summary = `${summary}${summary ? '\n\n' : ''}Files changed while it ran, possibly by another agent: ${changed.slice(0, 20).join(', ')}.`;
  } else if (!error && !edit && type.commands && changed.length) {
    summary = `${summary}${summary ? '\n\n' : ''}Files changed by its commands: ${changed.slice(0, 20).join(', ')}.`;
  }
  if (!summary && !error) summary = `(The ${type.label.toLowerCase()} gave no written summary.)`;
  for (const n of notes) if (n.summary) summary = `${summary}${summary ? '\n\n' : ''}${n.summary}`;

  // (15) spend.
  const usage = summarizeUsage(ref, reports, { billing, partial: Boolean(stopped) });
  try {
    accrueReply(project, transcriptOf(project), usage);
  } catch {
    // A spend record that cannot be written must not lose the agent's answer.
  }
  const cost = Number.isFinite(usage?.cost?.dollars) ? usage.cost.dollars : null;

  // (16) release.
  const elapsedMs = Date.now() - ranAt;
  const result = { ok: !error, summary, changed, outOfScope, ...(error ? { error } : {}), ...(stopped ? { stopped } : {}), elapsedMs, turns: entry.turns, cost, agentId: entry.id, usage, model: ref, modelLabel: entry.modelLabel };
  admitted.release();
  try {
    outEmit({ type: 'agent-done', id: entry.id, ok: result.ok, ...(error ? { error } : {}), ...(stopped ? { stopped } : {}), elapsedMs, turns: entry.turns, changed: changed.length, cost, agent: type.name, label: type.label, title, kind: type.kind, model: ref, modelLabel: entry.modelLabel });
  } catch {
    // A broken stream must not change the answer.
  }
  publish('done', entry, { ok: result.ok, error: error ?? undefined, stopped: stopped ?? undefined, elapsedMs, turns: entry.turns, changed: changed.length, cost });
  return result;
}

// One signal that ends when either does (or null when neither is given).
function combine(a, b) {
  if (!a) return b ?? null;
  if (!b || a === b) return a;
  const joined = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) joined.abort();
    else s.addEventListener('abort', () => joined.abort(), { once: true });
  }
  return joined.signal;
}

// ---------- Claude Code's Agent requests ----------

// The offer the Claude CLI route reads from ctx.agentsOffer, or undefined when nothing may be offered (then the Agent tool is left out).
// types holds the Plenum types the caller may start whose model is Claude (only Claude models run inside Claude Code); cliSubagents says
// whether Claude Code's own subagents (Explore, Plan, ...) may be used and are counted. onAgent decides each Agent request; onAgentDone
// ends it. A Claude Code subagent cannot be stopped or timed by Plenum, so its entry has stoppable: false.
// readOnlySeat (a seat of agent-roles that has no approval cards) keeps only the read-only types that run no commands, leaves Claude
// Code's own subagents out, and says so in the refusal of any other name. The env numbers are the same as for the chat.
export function offerFor({ agents, caller, run, project, root, mode, approve, emit, signal, readOnlySeat = false } = {}) {
  void root;
  void mode;
  void approve;
  const role = rootRoleOf(caller);
  if (!ROLE_META[role]) return undefined;
  const lim = limitsFor(agents, role, caller.ref);
  const nest = nestingOf(agents);
  const top = caller.depth < 1;
  const types = new Map();
  if (caller.depth < nest.depth) {
    for (const name of lim.types) {
      const t = typeByName(agents, name);
      if (!t || t.buildOnly) continue;
      if (t.model && splitRef(t.model).provider !== 'anthropic') continue;
      if (nestedRefusal(nest, caller, t)) continue;
      if (readOnlySeat && (t.kind !== 'read' || t.commands)) continue;
      types.set(name, t);
    }
  }
  const cliSubagents = !readOnlySeat && top && caller.depth < nest.depth && lim.cliSubagents === true;
  if (!types.size && !cliSubagents) return undefined;
  const open = new Map(); // tool use id -> { entry, release, reservation }
  const parent = undefined;

  const start = async ({ name, type, kind, toolUseId, title }) => {
    const pre = precheck({ run, caller, agents, type, internal: false });
    if (!pre.ok) return { allow: false, message: pre.error };
    const reservation = reserve(run, pre.key);
    const label = type ? type.label : `Claude Code: ${name}`;
    const shownTitle = clip(String(title || name || 'Agent').trim(), 120);
    const entry = newEntry({ run, caller, type, name, label, kind: kind ?? type?.kind ?? 'read', ref: type?.model ?? caller.ref, title: shownTitle, task: null, inside: 'claude-cli', stoppable: false, edit: false, scope: null, project });
    const out = ev => {
      try {
        emit?.(parent ? { ...ev, parent } : ev);
      } catch {
        // A broken stream must not stop an agent.
      }
    };
    const admitted = await admit({ run, entry, lim: pre.lim, key: pre.key, signal: combine(signal, run.signal), emit: out, parent });
    if (!admitted.ok) {
      reservation.undo();
      return { allow: false, message: admitted.error };
    }
    entry.state = 'running';
    entry.why = null;
    open.set(toolUseId, { entry, release: admitted.release, ranAt: Date.now() });
    out({ type: 'agent-start', id: entry.id, role: caller.role, caller: { ref: caller.ref ?? null, label: caller.label, seat: caller.seat ?? null }, agent: entry.agent, label: entry.label, kind: entry.kind, model: entry.model, modelLabel: entry.modelLabel, title: shownTitle, startedAt: entry.startedAt, limits: null, inside: 'claude-cli', state: 'running' });
    publish('start', entry);
    return { allow: true };
  };

  return {
    types,
    cliSubagents,
    readOnlySeat: readOnlySeat === true,
    env: {
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(Math.max(1, nest.depth - caller.depth)),
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(Math.max(1, lim.concurrent)),
    },
    async onAgent({ type: name, toolUseId, title } = {}) {
      try {
        const t = types.get(name);
        if (t) return await start({ name, type: t, toolUseId, title });
        const known = typeByName(agents, name);
        if (known) {
          const why = precheck({ run, caller, agents, type: known, internal: false });
          if (!why.ok) return { allow: false, message: why.error };
          return { allow: false, message: `${known.label} runs on a model that cannot run inside Claude Code, so Claude Code cannot start it. Use the delegate tool, or give the type a Claude model.` };
        }
        if (!cliSubagents) return { allow: false, message: readOnlySeat ? seatOtherAgent(name, [...types.keys()]) : CLI_OFF };
        const kind = ['Explore', 'Plan', 'claude-code-guide'].includes(name) ? 'read' : 'edit';
        return await start({ name, type: null, kind, toolUseId, title });
      } catch (err) {
        return { allow: false, message: `Plenum could not start this agent: ${err.message}` };
      }
    },
    onAgentDone(toolUseId, ok) {
      const slot = open.get(toolUseId);
      if (!slot) return;
      open.delete(toolUseId);
      const { entry } = slot;
      const elapsedMs = Date.now() - slot.ranAt;
      slot.release();
      try {
        emit?.({ type: 'agent-done', id: entry.id, ok: ok !== false, ...(ok === false ? { error: 'The subagent ended with an error.' } : {}), elapsedMs, turns: 0, changed: 0, cost: null, agent: entry.agent, label: entry.label, title: entry.title, kind: entry.kind, model: entry.model, modelLabel: entry.modelLabel });
      } catch {
        // A broken stream must not change the answer.
      }
      publish('done', entry, { ok: ok !== false, elapsedMs, turns: 0, changed: 0, cost: null });
    },
  };
}

// ---------- seats (agent-roles, with amendment 21) ----------

// What a seat that may start agents is told, after its own system text. The reports it gets back are untrusted text.
export const SEAT_AGENT_NOTE = types => `You may start read-only agents with the delegate tool (types: ${describeTypes(types)}). An agent reads the project folder and reports back; you still cannot open files yourself. Say which claims come from an agent's report, and never present a report as something you verified.`;
// The same for a role whose agents can edit or run commands (only once the Agents board shows their cards: ROLE_META.cards).
const SEAT_AGENT_NOTE_EDIT = types => `You may start agents with the delegate tool (types: ${describeTypes(types)}). Some of them can change files or run commands in the project, and each of those asks the user first. An agent reports back; you still cannot open files yourself. Say which claims come from an agent's report, and never present a report as something you verified.`;

// The system text with the seat's note added, or the text as it is when the seat has no context (it starts no agents).
// A Claude seat on the CLI route starts agents through Claude Code's Agent tool, not the delegate tool, so the note names that one.
export function seatSystemWith(system, ctx) {
  if (!ctx) return system;
  const types = Array.isArray(ctx.seatTypes) ? ctx.seatTypes : [];
  let note = types.some(t => t.kind === 'edit' || t.commands) ? SEAT_AGENT_NOTE_EDIT(types) : SEAT_AGENT_NOTE(types);
  if (ctx.seatRoute === 'cli') note = note.replace('the delegate tool', 'the Agent tool');
  return system ? `${system}\n\n${note}` : note;
}

// A card from one of a seat's agents names the seat, so the person knows where it came from. The reason the person types for a denial
// comes back to the card the runner holds, and Stop can still close a waiting card.
function seatApprove(approve, who) {
  const wrapped = async (card, handle) => {
    const copy = { ...card, summary: `${who}: ${card.summary}` };
    const allowed = await approve(copy, handle);
    if (copy.reason) card.reason = copy.reason;
    return allowed;
  };
  if (typeof approve.close === 'function') wrapped.close = (id, reason) => approve.close(id, reason);
  return wrapped;
}

// The tool context of one seat turn, or undefined when the seat starts no agents: plan mode on the project, no type in the seat's row
// (role row and per-model overrides, limitsFor), a number of 0, or a model whose tool calls Plenum cannot reach (Codex, Gemini, Muse
// Code, Cursor and text-only API models answer from the prompt as before). The ctx holds the delegate tool alone (seatOnly), a caller
// that counts this seat on its own inside the run, and, for a Claude model on the CLI route, the offer of the types it may start as
// subagents. Never throws: a seat that cannot be given a context stays text-only.
// role is a key of ROLE_META ('council', 'moderator', 'relay', 'compare', 'pipeline'); seatId and label name the seat in the limits and in
// the windows; emit gets the seat's tool steps and its agents' events (the caller tags them with the seat); readOnlyCwd is the seat's
// scratch folder, which a Claude CLI seat runs in. approve, mode, denyPatterns and tools matter only for a role whose cards are on.
export function seatContext({ role, ref, seatId, label, project, agents, run, signal, emit, effort, readOnlyCwd, approve, mode, denyPatterns, tools } = {}) {
  try {
    const meta = ROLE_META[role];
    if (!meta || !ref || !project || !agents || !run) return undefined;
    if (typeof project.path !== 'string' || !project.path) return undefined;
    if (chatModeOf(project) === 'plan') return undefined;
    const lim = limitsFor(agents, role, ref);
    if (!lim.types.length || lim.total < 1 || lim.concurrent < 1) return undefined;
    if (modelTools(ref) !== 'yes') return undefined;
    const types = lim.types.map(n => typeByName(agents, n)).filter(Boolean);
    if (!types.length) return undefined;
    // Without cards no card can be shown for the role, so its agents are read-only types that never ask, and the seat answers no to any.
    const cards = meta.cards === true;
    const caller = { role, ref, label: String(label || labelFor(ref)), seat: seatId === undefined || seatId === null ? undefined : String(seatId), depth: 0 };
    const sink = typeof emit === 'function' ? emit : () => {};
    const ask = cards && typeof approve === 'function' ? seatApprove(approve, caller.label) : async () => false;
    const runMode = cards && (mode === 'auto' || mode === 'all') ? mode : 'ask';
    const patterns = cards && Array.isArray(denyPatterns) ? denyPatterns : [];
    return {
      root: project.path,
      projectId: project.id,
      ref,
      denyPatterns: patterns,
      mode: runMode,
      signal,
      out: { api: [], tools: [] },
      emit: sink,
      approve: ask,
      agents,
      agentRun: run,
      caller,
      project,
      seatOnly: true,
      effort,
      callerEffort: effort,
      tools: cards ? tools : undefined,
      readOnlyCwd,
      seatTypes: types,
      agentsOffer: offerFor({ agents, caller, run, project, root: project.path, denyPatterns: patterns, mode: runMode, approve: ask, emit: sink, signal, readOnlySeat: !cards }),
    };
  } catch {
    return undefined;
  }
}

// seatContext for a runner that can wait. A Claude seat that runs through the Claude CLI has no delegate tool: it can start only the
// types in its offer (Claude models only), through Claude Code's Agent tool. With none to offer it starts nothing, so it gets no context
// (and no note that would promise agents it cannot start). Every other seat is as seatContext gives it; the five seat runners call this.
export async function seatContextFor(opts) {
  const ctx = seatContext(opts);
  if (!ctx || splitRef(opts.ref).provider !== 'anthropic') return ctx;
  let route = 'api';
  try {
    route = await claudeRoute();
  } catch {
    route = 'api';
  }
  if (route !== 'cli') return ctx;
  const offered = ctx.agentsOffer ? [...ctx.agentsOffer.types.values()] : [];
  return offered.length ? { ...ctx, seatRoute: 'cli', seatTypes: offered } : undefined;
}

// Closes the run when the generator ends, whichever way it ends (the end, an error, or the consumer stopping early). The run's agents
// that are still queued are stopped and the run leaves the live registry.
export async function* withRun(run, gen) {
  try {
    yield* gen;
  } finally {
    run?.close();
  }
}

// A box that one side fills with events and the other drains in order, for a generator whose seat reports from inside a stream.
export function eventBox() {
  const items = [];
  let wake = null;
  let ended = false;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(ev) {
      items.push(ev);
      poke();
    },
    end() {
      ended = true;
      poke();
    },
    async* drain() {
      for (;;) {
        if (items.length) {
          yield items.shift();
          continue;
        }
        if (ended) return;
        await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

// Runs work(push, signal) in the background and yields what it pushes, in order, until it settles. The work's signal ends when the
// caller's does and when the consumer stops early, so a seat's stream is never left running behind a closed generator.
export async function* pumped(signal, work) {
  const box = eventBox();
  const inner = new AbortController();
  const link = () => inner.abort();
  if (signal?.aborted) inner.abort();
  else signal?.addEventListener('abort', link, { once: true });
  const job = (async () => {
    try {
      await work(ev => box.push(ev), inner.signal);
    } finally {
      box.end();
    }
  })();
  job.catch(() => {});
  try {
    yield* box.drain();
    await job;
  } finally {
    signal?.removeEventListener('abort', link);
    inner.abort();
    await job.catch(() => {});
  }
}

// The project and kind of a stream that server.mjs opened, found by the stream's own signal. A route module that builds a seat's
// generator without knowing the project (the pipelines route passes only the signal) is given its project this way.
const runScopes = new WeakMap();
export function registerRunScope(signal, scope) {
  if (signal && typeof signal === 'object' && scope) runScopes.set(signal, scope);
}
export function runScopeOf(signal) {
  return signal && typeof signal === 'object' ? (runScopes.get(signal) ?? null) : null;
}

export { describeTypes };
