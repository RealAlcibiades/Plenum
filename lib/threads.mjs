// Threads (pro-01): several chats per project, each with its own name, model, chat, queue, plan mode and CLI sessions.
//
// A thread's id is its scope id (lib/scope.mjs). The project's first chat is the thread "Main" and keeps the project's own id, so
// chats[projectId], sessions[projectId], archives[projectId], checkpoints/<projectId>, the shadow refs and the running map already belong
// to Main and nothing moves. A new thread gets `${projectId}-t${6 hex}`, which fits the checkpoint name rule /^[A-Za-z0-9_-]{1,64}$/.
//
// state.json gains
//   stateVersion: 2
//   threads: { [projectId]: { active, writer, multiWriter?, list: [{ id, name, model|null, chatMode?: 'plan', createdAt, closedAt?, main?: true }] } }
// Main's entry is { id: projectId, name: 'Main', main: true, model: null } (null = the app's model, as before). `active` is the thread the
// page shows, `writer` the one thread that may change files in the project folder (Main by default; the others are read-only until they
// are made the writer or get their own copy). multiWriter (amend-29) is the per-project switch "Several threads may write in this folder":
// when it is on, every thread writes in the folder and the writer concept goes for that project.
//
// Migration (migrateThreads): when stateVersion is not 2, state.json is copied to state.json.pre-threads-<YYYY-MM-DD> (or -2, -3 ... when that name is taken; never overwritten),
// and only after that copy exists are the Main entries added and stateVersion set to 2. If the copy cannot be made, Plenum runs with Main
// only (threadsOff) and "+ Thread" says why. Plenum 0.5.0 spreads unknown keys and ignores them, so it still reads Main at chats[projectId];
// revertThreads(state) removes the two new keys and leaves the other threads' chats under their own ids.
//
// Nothing here deletes or rewrites a chat except removeThread, which only runs for a thread the person closed and then chose to remove.
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const STATE_VERSION = 2;
export const MAX_OPEN = 8;
export const MAX_CLOSED = 20;
export const NAME_MAX = 40;
export const OFF_TITLE = 'Threads are off: Plenum could not back up the state file first.';
export const DEFAULT_PREFIX = 'Thread';

// Set when the dated copy of the state file could not be made. Threads then stay off until the next start.
let off = false;
export const threadsOff = () => off;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const httpFail = (status, message) => Object.assign(new Error(message), { status });

// ---------- ids and names ----------

export const newThreadId = projectId => `${projectId}-t${randomBytes(3).toString('hex')}`;

// True when id is shaped like a thread id of this project (the project's own id is Main, not a thread id).
export const isThreadIdOf = (projectId, id) => typeof id === 'string' && id.startsWith(`${projectId}-t`) && THREAD_ID.test(id);

// The name a person typed, checked: 1 to 40 characters after trimming, no control characters. Returns the trimmed name or throws a 400.
export function checkName(raw) {
  if (typeof raw !== 'string') throw httpFail(400, 'A thread name is text, 1 to 40 characters.');
  const name = raw.trim();
  if (!name) throw httpFail(400, 'Give the thread a name.');
  if (CONTROL.test(name)) throw httpFail(400, 'A thread name cannot hold control characters or line breaks.');
  if ([...name].length > NAME_MAX) throw httpFail(400, `A thread name is at most ${NAME_MAX} characters.`);
  return name;
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// ---------- the record of a project ----------

function mainEntry(project) {
  return { id: project.id, name: 'Main', main: true, model: null, createdAt: Date.now() };
}

// Repairs a stored entry in place, so a hand-edited state file cannot crash a request: only known fields, sane types. The same object is
// kept (a caller that holds an entry keeps seeing the record), and null is returned for something that is not a thread of this project.
function cleanEntry(raw, projectId) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !THREAD_ID.test(raw.id)) return null;
  const main = raw.id === projectId;
  if (!main && !isThreadIdOf(projectId, raw.id)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? [...raw.name.replace(CONTROL, ' ').trim()].slice(0, NAME_MAX).join('') : (main ? 'Main' : raw.id);
  const keep = {
    id: raw.id,
    name: main ? 'Main' : name,
    model: !main && typeof raw.model === 'string' && raw.model ? raw.model : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
  if (main) keep.main = true;
  if (!main && raw.chatMode === 'plan') keep.chatMode = 'plan';
  if (!main && Number.isFinite(raw.closedAt)) keep.closedAt = raw.closedAt;
  for (const key of Object.keys(raw)) delete raw[key];
  return Object.assign(raw, keep);
}

// Makes the stored record of a project valid and returns it: Main is always the first, open entry; ids are unique; active and writer name
// open threads (Main otherwise). Run on every read, it changes nothing in a record that is already right.
function repair(record, project) {
  const seen = new Set();
  const list = [];
  const raw = Array.isArray(record.list) ? record.list : [];
  const main = cleanEntry(raw.find(e => isObject(e) && e.id === project.id), project.id) ?? mainEntry(project);
  delete main.closedAt;
  seen.add(main.id);
  list.push(main);
  for (const e of raw) {
    const entry = cleanEntry(e, project.id);
    if (!entry || entry.main || seen.has(entry.id)) continue;
    seen.add(entry.id);
    list.push(entry);
  }
  record.list = list;
  const open = id => list.some(e => e.id === id && !e.closedAt);
  if (!open(record.active)) record.active = project.id;
  if (!open(record.writer)) record.writer = project.id;
  if (record.multiWriter !== true) delete record.multiWriter;
  return record;
}

// The record of a project, read only. A project that has none yet gets a transient one (Main alone) that is not stored, so reading
// never changes the state file. The stored record, when there is one, is repaired in place.
export function threadsOf(st, project) {
  const stored = st?.threads?.[project.id];
  if (isObject(stored)) return repair(stored, project);
  return repair({}, project);
}

// The record of a project, stored. A project added after the migration gets its Main entry on first use (this). While threads are off
// (the dated copy failed) nothing is stored, and the transient record is returned.
export function ensureThreads(st, project) {
  if (off) return threadsOf(st, project);
  if (!isObject(st.threads)) st.threads = {};
  if (!isObject(st.threads[project.id])) st.threads[project.id] = {};
  return repair(st.threads[project.id], project);
}

export const isOpen = entry => !entry.closedAt;
export const openThreads = record => record.list.filter(isOpen);
export const closedThreads = record => record.list.filter(e => !isOpen(e)).sort((a, b) => b.closedAt - a.closedAt);
export const findThread = (record, id) => record.list.find(e => e.id === id) ?? null;

// The thread that writes in the project folder: the writer thread, or every thread when the project allows several writers.
export const writerOf = record => findThread(record, record.writer) ?? record.list[0];
export const canWrite = (record, id) => record.multiWriter === true || record.writer === id;

// The next free default name: 'Thread 2', 'Thread 3' and so on (the lowest number whose name no thread of the project has).
export function defaultName(record) {
  for (let n = 2; n < 1000; n++) {
    const name = `${DEFAULT_PREFIX} ${n}`;
    if (!record.list.some(e => sameName(e.name, name))) return name;
  }
  return `${DEFAULT_PREFIX} ${Date.now()}`;
}

function checkUnique(record, name, exceptId) {
  if (record.list.some(e => e.id !== exceptId && sameName(e.name, name))) throw httpFail(400, `This project already has a thread called "${name}". Pick another name.`);
}

function offGuard() {
  if (off) throw httpFail(409, OFF_TITLE);
}

// ---------- changes (the caller saves) ----------

// Adds a thread and makes it the active one. model is the ref the thread uses (null for the app's model); plan starts it in plan mode.
// Throws a 400 for a bad or duplicate name and a 409 at the limit.
export function createThread(st, project, { name, model = null, plan = false } = {}) {
  offGuard();
  const record = ensureThreads(st, project);
  if (openThreads(record).length >= MAX_OPEN) throw httpFail(409, `This project has ${MAX_OPEN} open threads. Close one first.`);
  const chosen = name === undefined || name === null || name === '' ? defaultName(record) : checkName(name);
  checkUnique(record, chosen, null);
  const entry = { id: newThreadId(project.id), name: chosen, model: typeof model === 'string' && model ? model : null, createdAt: Date.now() };
  if (plan === true) entry.chatMode = 'plan';
  record.list.push(entry);
  record.active = entry.id;
  return entry;
}

function openEntry(record, id) {
  const entry = findThread(record, id);
  if (!entry || !isOpen(entry)) throw httpFail(404, 'No such thread in this project.');
  return entry;
}

export function activateThread(st, project, id) {
  const record = ensureThreads(st, project);
  openEntry(record, id);
  record.active = id;
  return record;
}

// Renames a thread and/or sets its model. Main's name stays "Main" and its model is the app's (400 'Main uses the app model ...').
export function updateThread(st, project, id, { name, model } = {}) {
  const record = ensureThreads(st, project);
  const entry = openEntry(record, id);
  if (name !== undefined) {
    if (entry.main) throw httpFail(400, 'Main keeps its name.');
    const chosen = checkName(name);
    checkUnique(record, chosen, entry.id);
    entry.name = chosen;
  }
  if (model !== undefined) {
    if (entry.main) throw httpFail(400, 'Main uses the app model from the model selector.');
    entry.model = typeof model === 'string' && model ? model : null;
  }
  return entry;
}

export function setThreadMode(st, project, id, mode) {
  const record = ensureThreads(st, project);
  const entry = openEntry(record, id);
  if (entry.main) throw httpFail(400, 'Main follows the project\'s plan mode.');
  if (mode === 'plan') entry.chatMode = 'plan';
  else delete entry.chatMode;
  return entry;
}

export function setWriter(st, project, id) {
  const record = ensureThreads(st, project);
  openEntry(record, id);
  record.writer = id;
  return record;
}

export function setMultiWriter(st, project, on) {
  offGuard();
  const record = ensureThreads(st, project);
  if (on === true) record.multiWriter = true;
  else delete record.multiWriter;
  return record;
}

// Closes a thread: its chat is kept, and it joins the closed list. Main cannot be closed. Closing the writer makes Main the writer, and
// closing the active thread makes Main the active one.
export function closeThread(st, project, id) {
  const record = ensureThreads(st, project);
  const entry = findThread(record, id);
  if (!entry) throw httpFail(404, 'No such thread in this project.');
  if (entry.main) throw httpFail(400, 'Main cannot be closed.');
  if (!isOpen(entry)) throw httpFail(400, 'That thread is already closed.');
  if (closedThreads(record).length >= MAX_CLOSED) throw httpFail(409, `This project keeps ${MAX_CLOSED} closed threads. Remove one from the New thread panel first.`);
  entry.closedAt = Date.now();
  if (record.active === id) record.active = project.id;
  if (record.writer === id) record.writer = project.id;
  return entry;
}

export function reopenThread(st, project, id) {
  const record = ensureThreads(st, project);
  const entry = findThread(record, id);
  if (!entry || isOpen(entry)) throw httpFail(404, 'No such closed thread in this project.');
  if (openThreads(record).length >= MAX_OPEN) throw httpFail(409, `This project has ${MAX_OPEN} open threads. Close one first.`);
  delete entry.closedAt;
  record.active = entry.id;
  return entry;
}

// Takes a closed thread out of the record and returns the entry (the caller then deletes its data, see forgetThreadData).
export function dropClosedThread(st, project, id) {
  const record = ensureThreads(st, project);
  const entry = findThread(record, id);
  if (!entry) throw httpFail(404, 'No such thread in this project.');
  if (entry.main) throw httpFail(400, 'Main cannot be removed.');
  if (isOpen(entry)) throw httpFail(400, 'Close the thread before removing it.');
  record.list = record.list.filter(e => e.id !== id);
  return entry;
}

// ---------- the data of a thread ----------

// Everything a thread keeps besides its record: the chat, the CLI sessions, the Undo entry, the code-rewind record, the checkpoint folder
// and the snapshot refs. Used when a closed thread is removed. Each step is best effort and reports a failure in the returned list; none of
// them touches the project folder or another thread. deps = { st, home, forgetSessions, clearArchive, shadowRefs } so a test can run it alone.
export async function forgetThreadData(id, { st, home, forgetSessions, clearArchive, root, dropShadowRefs } = {}) {
  const problems = [];
  if (!THREAD_ID.test(String(id))) return ['That is not a thread id.'];
  if (isObject(st?.chats)) delete st.chats[id];
  if (isObject(st?.rewinds)) delete st.rewinds[id];
  try {
    forgetSessions?.(id);
  } catch (err) {
    problems.push(`sessions: ${err.message}`);
  }
  try {
    clearArchive?.(id);
  } catch (err) {
    problems.push(`undo: ${err.message}`);
  }
  if (home) {
    try {
      await fs.rm(path.join(home, 'checkpoints', id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      problems.push(`checkpoints: ${err.code ?? err.message}`);
    }
  }
  if (root && typeof dropShadowRefs === 'function') {
    try {
      await dropShadowRefs(root, id);
    } catch (err) {
      problems.push(`snapshots: ${err.message}`);
    }
  }
  return problems;
}

// ---------- migration ----------

const pad = n => String(n).padStart(2, '0');
export const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The copy is written to the first free name of: state.json.pre-threads-<date>, then -2, -3 and so on up to -99. A name that exists is
// never overwritten, and the name written is the one reported.
async function copyToFreeName(file, dated, copy) {
  for (let n = 1; n <= 99; n++) {
    const name = n === 1 ? dated : `${dated}-${n}`;
    const there = await fs.stat(name).then(info => info, err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (there) {
      if (n === 1 && !there.isFile()) throw Object.assign(new Error('the dated copy name is taken by a folder'), { code: 'EISDIR' });
      continue;
    }
    try {
      // COPYFILE_EXCL: an existing copy is never overwritten, whatever happens between the check above and here.
      if (typeof copy === 'function') await copy(file, name);
      else await fs.copyFile(file, name, fsc.COPYFILE_EXCL);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    return name;
  }
  throw Object.assign(new Error('no free name for the dated copy'), { code: 'EEXIST' });
}

// Version 1 -> 2. See the top of this file. store is lib/store.mjs (or a stand-in with get(), persist() and HOME). Resolves to
// { migrated, off, copy, error }. It never throws: a failure turns threads off and says so.
export async function migrateThreads(store, { home = store.HOME, today = new Date(), copy } = {}) {
  const st = store.get();
  off = false;
  if (st.stateVersion >= STATE_VERSION) return { migrated: false, off: false };
  const file = path.join(home, 'state.json');
  const dated = `${file}.pre-threads-${dayStamp(today)}`;
  let made = null;
  try {
    const present = await fs.stat(file).then(() => true, err => {
      if (err.code === 'ENOENT') return false;
      throw err;
    });
    if (present) made = await copyToFreeName(file, dated, copy);
  } catch (err) {
    off = true;
    console.error(`Threads: the state file could not be backed up first (${err.code ?? err.message}), so threads are off for this run.`);
    return { migrated: false, off: true, error: err.code ?? err.message };
  }
  for (const project of st.projects ?? []) ensureThreads(st, project);
  st.stateVersion = STATE_VERSION;
  await store.persist();
  return { migrated: true, off: false, copy: made };
}

// Undoes the migration on a state object, for the test and for a person who goes back to 0.5.0: threads and stateVersion go, and
// every other thread's chat stays under its own id (chats[`${projectId}-t...`]) where nothing reads it. Returns the same object.
export function revertThreads(state) {
  if (isObject(state)) {
    delete state.threads;
    delete state.stateVersion;
  }
  return state;
}

// Tests only: puts the threads-off flag back.
export function _resetOff() {
  off = false;
}
