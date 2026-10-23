// The folder and the keys a request works in. Every route of the review pane and the later features resolves its folder through
// scopeFor, and accepts an optional `thread` (in the body or the query). A thread's id is its scope id (lib/threads.mjs): the project's
// first chat, Main, keeps the project's own id, and every other thread has `${projectId}-t${6 hex}`. The chat, the CLI sessions, the Undo
// entry, the checkpoints, the shadow refs and the run slot are all keyed by that scope id.
//
//   scopeFor(store, project, threadId) -> { id, projectId, threadId: id, name, root, worktree, chatMode, main, writer, model, writerId,
//                                           writerName, multiWriter }
// threadId missing or '' means the project's active thread. An id that is not an open thread of this project (an unknown one, a closed one,
// or another project's) throws an Error with status 404 'No such thread in this project.'. root is the project's folder until a thread has a
// folder of its own: a thread with an isolated copy (pro-02, lib/worktree.mjs) has worktree = { state, path, branch, base, sub, createdAt,
// error } and, while the copy is ready, root = the copy's folder (plus sub, the project's folder inside the repository, when the project is
// not at the top of it). writer is true when this thread may change files in the folder: it is the project's writer thread, or the project
// allows several writers, or its copy is ready (a copy is its own folder, so the project's one-writer rule does not apply to it). While the
// copy is being made, failed, missing or being kept or discarded, the thread is not the writer and works read-only in the project folder.
// chatMode is the thread's own plan flag ('plan' or null); Main's plan mode is the project's (chatModeOf in lib/projects.mjs).
//
// A copy's record is kept in state.json as worktrees[threadId] (lib/threads.mjs drops the fields it does not know from a thread's entry, so
// the record lives beside the threads, keyed by the same id): { state: 'creating' | 'ready' | 'failed', path, branch, base, baseKind, sub,
// requestedAt, createdAt, error }. worktreeOf reads it and works out what is true now: a copy whose folder is gone is 'missing', a copy that
// is being kept or discarded is 'closing', and one that was being made when Plenum closed is 'failed'.
import fs from 'node:fs';
import path from 'node:path';
import { canWrite, closedThreads, findThread, isOpen, openThreads, threadsOf, threadsOff, writerOf } from './threads.mjs';
import { chatModeOf } from './projects.mjs';
import { worktreeRoot } from './guard.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const NO_SUCH_THREAD = 'No such thread in this project.';

// ---------- isolated copies (pro-02) ----------

// A copy that was asked for gets this long to be started by the page before it counts as never started.
export const WORKTREE_GRACE_MS = 60_000;
export const WORKTREE_INTERRUPTED = 'Plenum was closed while the copy was being made.';
const COPY_NAME = /^[0-9a-f]{8}$/;
// A folder inside the repository, written with / and never leaving it.
const SUB_FOLDER = /^(?:[^\\/:*?"<>|\0]+\/)*[^\\/:*?"<>|\0]+$/;
// Thread ids whose copy is being made, kept or discarded right now (this process only).
const held = new Set();

// Marks a thread's copy as being changed. Returns a function that lets it go, or null when it is already held.
export function holdWorktree(id) {
  if (held.has(id)) return null;
  held.add(id);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    held.delete(id);
  };
}
export const worktreeHeld = id => held.has(id);

// True when p is exactly one folder under the copies folder with the name Plenum gives a copy (8 hex digits). A stored path that is anything
// else (a hand-edited state file) is never trusted as a copy.
export function ownWorktreePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  return COPY_NAME.test(path.relative(worktreeRoot(), p));
}

// A thread's stored record, or null.
export function worktreeRecord(st, id) {
  const rec = st?.worktrees?.[id];
  return isObject(rec) ? rec : null;
}

// The folder a run works in: the copy's folder, plus the project's own folder inside the repository when the project is not at the top.
export function worktreeFolder(wt) {
  return wt?.sub ? path.join(wt.path, ...String(wt.sub).split('/')) : wt?.path;
}

// What is true about a thread's copy now: null when it has none, else { state, path, branch, base, baseKind, sub, createdAt, error }.
// state is one of 'creating', 'ready', 'failed', 'missing' and 'closing'. exists and now are for a test.
export function worktreeOf(st, id, { exists = fs.existsSync, now = Date.now() } = {}) {
  const rec = worktreeRecord(st, id);
  if (!rec) return null;
  const out = {
    state: 'failed',
    path: typeof rec.path === 'string' ? rec.path : null,
    branch: typeof rec.branch === 'string' ? rec.branch : null,
    base: typeof rec.base === 'string' ? rec.base : null,
    baseKind: rec.baseKind === 'commit' ? 'commit' : 'branch',
    sub: typeof rec.sub === 'string' && SUB_FOLDER.test(rec.sub) && !rec.sub.split('/').includes('..') ? rec.sub : '',
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : null,
    // The project files that were copied into the copy (lib/worktree.mjs keeps them out of a commit when git does not track them).
    copied: Array.isArray(rec.copied) ? rec.copied.filter(p => typeof p === 'string').slice(0, 20) : [],
  };
  if (rec.state === 'creating') {
    const waiting = Number.isFinite(rec.requestedAt) && now - rec.requestedAt < WORKTREE_GRACE_MS;
    if (held.has(id) || waiting) return { ...out, state: 'creating' };
    return { ...out, state: 'failed', error: WORKTREE_INTERRUPTED };
  }
  if (rec.state === 'ready') {
    if (!ownWorktreePath(out.path)) return { ...out, state: 'missing', error: 'The copy is not where Plenum made it.' };
    if (held.has(id)) return { ...out, state: 'closing' };
    if (!exists(out.path)) return { ...out, state: 'missing' };
    return { ...out, state: 'ready' };
  }
  return { ...out, state: 'failed', error: typeof rec.error === 'string' && rec.error ? rec.error : 'The isolated copy could not be made.' };
}

// What the page is told about a copy.
export function publicWorktree(wt) {
  if (!wt) return null;
  return { state: wt.state, branch: wt.branch, base: wt.base, baseKind: wt.baseKind, path: wt.path, createdAt: wt.createdAt, ...(wt.error ? { error: wt.error } : {}) };
}

export function scopeFor(store, project, threadId) {
  const st = typeof store?.get === 'function' ? store.get() : null;
  const record = threadsOf(st, project);
  const wanted = threadId === undefined || threadId === null || threadId === '' ? record.active : threadId;
  if (typeof wanted !== 'string') throw fail(404, NO_SUCH_THREAD);
  const entry = findThread(record, wanted);
  if (!entry || !isOpen(entry)) throw fail(404, NO_SUCH_THREAD);
  const writer = writerOf(record);
  const wt = entry.main === true ? null : worktreeOf(st, entry.id);
  const ready = wt?.state === 'ready';
  return {
    id: entry.id,
    projectId: project.id,
    threadId: entry.id,
    name: entry.name,
    root: ready ? worktreeFolder(wt) : project.path,
    worktree: wt,
    chatMode: entry.chatMode === 'plan' ? 'plan' : null,
    main: entry.main === true,
    writer: wt ? ready : canWrite(record, entry.id),
    model: entry.model ?? null,
    writerId: writer.id,
    writerName: writer.name,
    multiWriter: record.multiWriter === true,
  };
}

// The Main scope of a project, for a caller that has no store (a test harness, a route called without its context).
export function mainScope(project) {
  return {
    id: project.id, projectId: project.id, threadId: project.id, name: 'Main', root: project.path, worktree: null, chatMode: null,
    main: true, writer: true, model: null, writerId: project.id, writerName: 'Main', multiWriter: false,
  };
}

// scopeFor for a route that may be handed no store: the project's Main scope then.
export function scopeOrMain(store, project, threadId) {
  return typeof store?.get === 'function' ? scopeFor(store, project, threadId) : mainScope(project);
}

// The `thread` a request names: in the JSON body or the query string. A value that is not text counts as missing.
export function threadOf(source) {
  const raw = source instanceof URLSearchParams ? source.get('thread') : source?.thread;
  return typeof raw === 'string' && raw ? raw : undefined;
}

// True while any thread of the project runs. running is the server's map of scope id -> AbortController (or any Map/Set of scope ids).
export function projectBusy(running, projectId) {
  if (!running || typeof running.keys !== 'function' || typeof projectId !== 'string' || !projectId) return false;
  for (const key of running.keys()) if (key === projectId || (typeof key === 'string' && key.startsWith(`${projectId}-t`))) return true;
  return false;
}

// The scope ids of the project that run now.
export function runningScopes(running, projectId) {
  const out = [];
  if (!running || typeof running.keys !== 'function') return out;
  for (const key of running.keys()) if (key === projectId || (typeof key === 'string' && key.startsWith(`${projectId}-t`))) out.push(key);
  return out;
}

// Whether this turn is read-only: the project is in plan mode, this thread is in plan mode, or this thread is not the one that writes in
// the folder (two writers would share it). scope may come from scopeFor or mainScope.
export function planModeOf(project, scope) {
  return chatModeOf(project) === 'plan' || scope?.chatMode === 'plan' || scope?.writer === false;
}

// Why a turn is read-only, for the notice: 'plan' when plan mode (the project's or the thread's) is on, 'writer' when only the one-writer
// rule makes it so, or '' when it is not read-only.
export function readOnlyWhy(project, scope) {
  if (chatModeOf(project) === 'plan' || scope?.chatMode === 'plan') return 'plan';
  return scope?.writer === false ? 'writer' : '';
}

const COPY_NOTICES = {
  creating: "Read-only: this thread's isolated copy is still being made.",
  failed: "Read-only: this thread's isolated copy could not be made, so it only reads the project folder. Try again from the bar above the chat.",
  missing: "Read-only: this thread's isolated copy is missing. Discard it, or close the thread.",
  closing: "Read-only: this thread's isolated copy is being kept or discarded.",
};

// The notice a read-only turn starts with when only the one-writer rule (or a copy that is not ready) makes it read-only.
export const readOnlyNotice = scope => {
  const state = scope?.worktree?.state;
  if (state && COPY_NOTICES[state]) return COPY_NOTICES[state];
  return `Read-only: ${scope.writerName} is this project's writer, and two writers would share this folder.`;
};

// What the page shows about a project's threads (publicState and GET /api/threads): the active thread, the writer, the open threads with
// their state, the closed ones, whether any thread runs and whether threads are off. running is the server's map of scope id -> controller;
// waitingFor(scopeId) says how many approval cards that thread has waiting.
export function describeThreads(st, project, running, waitingFor = () => 0) {
  const record = threadsOf(st, project);
  const writer = writerOf(record);
  return {
    active: record.active,
    writer: writer.id,
    multiWriter: record.multiWriter === true,
    threads: openThreads(record).map(t => {
      const wt = t.main === true ? null : worktreeOf(st, t.id);
      return {
        id: t.id, name: t.name, model: t.model ?? null, main: t.main === true, writer: wt ? wt.state === 'ready' : canWrite(record, t.id),
        chatMode: t.chatMode === 'plan' ? 'plan' : null, running: Boolean(running?.has?.(t.id)), waiting: waitingFor(t.id),
        ...(wt ? { worktree: publicWorktree(wt) } : {}),
      };
    }),
    closedThreads: closedThreads(record).map(t => ({ id: t.id, name: t.name, closedAt: t.closedAt })),
    projectBusy: projectBusy(running, project.id),
    threadsOff: threadsOff(),
  };
}
