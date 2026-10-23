// Threads (pro-01): create, switch, rename, set the model, choose the writer, close, reopen and remove. See lib/threads.mjs for the data and
// lib/scope.mjs for how a request finds its thread. Every POST here also checks the Plenum token itself (requireToken), because several of
// them change what may write in the project folder. The server has already checked Host, Origin and the JSON type before a handler runs.
//
//   GET  /api/threads?project=ID                       the open threads, the closed ones and the writer of the project
//   POST /api/threads            { project, name?, model?, plan?, worktree? }   adds a thread and makes it active   (400 bad or duplicate name, 409 at 8 open;
//                                worktree: true asks for an isolated copy, 400 unless the project folder is a git repository)
//   POST /api/threads/activate   { project, thread }
//   POST /api/threads/update     { project, thread, name?, model? }  (Main's model: 400 'Main uses the app model from the model selector.')
//   POST /api/threads/writer     { project, thread }                 (409 while any thread of the project runs)
//   POST /api/threads/multiwriter { project, on }                    the per-project switch "Several threads may write in this folder" (409 while any runs)
//   POST /api/threads/close      { project, thread }                 (Main: 400 'Main cannot be closed.'; running: 409; the chat is kept)
//   POST /api/threads/reopen     { project, thread }
//   POST /api/threads/remove     { project, thread }                 closed threads only; deletes the chat, sessions, Undo entry, checkpoints and snapshot refs
// Every answer is the page state (publicState) with the thread's id as `thread` where one is made or changed.
//
// Isolated copies (pro-02, lib/worktree.mjs): POST /api/threads takes worktree: true, only for a git repository. The thread is then made with
// the record { state: 'creating' } in state.json worktrees[thread id] (lib/scope.mjs), and the page asks POST /api/worktrees/create to make the
// copy. A thread whose copy is ready cannot be closed (409): Keep branch or Discard comes first (lib/routes/worktrees.mjs). A thread whose copy
// failed or is missing closes, and what is left of the copy goes with it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseRef } from '../providers.mjs';
import { requireToken } from '../auth.mjs';
import { describeThreads, projectBusy, worktreeOf, worktreeRecord } from '../scope.mjs';
import { clearArchive } from '../archive.mjs';
import { forgetProjectSessions } from '../sessions.mjs';
import { locate } from '../shadow.mjs';
import { runGit } from '../git-run.mjs';
import { gitStatus } from '../git-status.mjs';
import { forgetWorktree } from '../worktree.mjs';
import {
  activateThread, closeThread, createThread, dropClosedThread, findThread, forgetThreadData, httpFail,
  reopenThread, setMultiWriter, setWriter, threadsOf, updateThread,
} from '../threads.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const BUSY_WRITER = 'Another thread in this project is running. The writer can change when every thread is idle.';
const COPY_CLOSE = 'This thread has an isolated copy. Choose Keep branch or Discard first.';
const COPY_MAKING = 'This thread\'s isolated copy is still being made.';

export const routes = [
  { method: 'GET', path: '/api/threads', handler: listRoute },
  { method: 'POST', path: '/api/threads', handler: createRoute },
  { method: 'POST', path: '/api/threads/activate', handler: activateRoute },
  { method: 'POST', path: '/api/threads/update', handler: updateRoute },
  { method: 'POST', path: '/api/threads/writer', handler: writerRoute },
  { method: 'POST', path: '/api/threads/multiwriter', handler: multiWriterRoute },
  { method: 'POST', path: '/api/threads/close', handler: closeRoute },
  { method: 'POST', path: '/api/threads/reopen', handler: reopenRoute },
  { method: 'POST', path: '/api/threads/remove', handler: removeRoute },
];

// The model a thread is given: a model the app knows, in its canonical form, or null for the app's model. A bad name is a 400.
function modelOf(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    return parseRef(raw);
  } catch (err) {
    throw httpFail(400, err.message);
  }
}

// The thread id a body names. It must be text; whether it is an open thread of the project is checked by the operation.
function threadParam(body) {
  const id = body.thread;
  if (typeof id !== 'string' || !id) throw httpFail(400, 'Say which thread.');
  return id;
}

// The body of a POST: an object with a project. Returns { body, project }.
async function open({ req, readBody, httpError, projectById }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the thread.');
  return { body, project: projectById(body.project) };
}

// Runs an operation that throws an Error with a status (lib/threads.mjs) and turns it into the server's error.
function guarded(task, httpError) {
  try {
    return task();
  } catch (err) {
    if (err?.status) throw httpError(err.status, err.message);
    throw err;
  }
}

async function listRoute({ res, url, json, store, projectById, running, httpError }) {
  const id = url.searchParams.get('project');
  if (!id) throw httpError(400, 'Choose a project first.');
  const project = projectById(id);
  return json(res, 200, { project: project.id, ...describeThreads(store.get(), project, running) });
}

async function createRoute(ctx) {
  const { res, json, store, httpError, publicState } = ctx;
  const { body, project } = await open(ctx);
  const model = modelOf(body.model);
  if (body.worktree !== undefined && typeof body.worktree !== 'boolean') throw httpError(400, 'Send worktree: true or worktree: false.');
  // An isolated copy is a git worktree, so the project folder must be a repository (and git must be there to make it).
  if (body.worktree === true) {
    const repo = await gitStatus(project.path);
    if (!repo.repo) throw httpError(400, repo.noGit ? 'git is not installed, so no isolated copy can be made.' : 'An isolated copy needs a git repository, and this folder is not one.');
  }
  const st = store.get();
  const entry = guarded(() => createThread(st, project, { name: body.name, model, plan: body.plan === true }), httpError);
  if (body.worktree === true) {
    if (!isObject(st.worktrees)) st.worktrees = {};
    st.worktrees[entry.id] = { state: 'creating', requestedAt: Date.now() };
  }
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: entry.id });
}

async function activateRoute(ctx) {
  const { res, json, store, httpError, publicState } = ctx;
  const { body, project } = await open(ctx);
  const id = threadParam(body);
  guarded(() => activateThread(store.get(), project, id), httpError);
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: id });
}

async function updateRoute(ctx) {
  const { res, json, store, httpError, publicState } = ctx;
  const { body, project } = await open(ctx);
  const id = threadParam(body);
  if (body.name === undefined && body.model === undefined) throw httpError(400, 'Send a name or a model to change.');
  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.model !== undefined) patch.model = modelOf(body.model);
  guarded(() => updateThread(store.get(), project, id, patch), httpError);
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: id });
}

async function writerRoute(ctx) {
  const { res, json, store, httpError, publicState, running } = ctx;
  const { body, project } = await open(ctx);
  const id = threadParam(body);
  if (projectBusy(running, project.id)) throw httpError(409, BUSY_WRITER);
  guarded(() => setWriter(store.get(), project, id), httpError);
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: id });
}

async function multiWriterRoute(ctx) {
  const { res, json, store, httpError, publicState, running } = ctx;
  const { body, project } = await open(ctx);
  if (typeof body.on !== 'boolean') throw httpError(400, 'Send on: true or on: false.');
  if (projectBusy(running, project.id)) throw httpError(409, BUSY_WRITER);
  guarded(() => setMultiWriter(store.get(), project, body.on), httpError);
  await store.saveOrFail();
  return json(res, 200, publicState());
}

async function closeRoute(ctx) {
  const { res, json, store, httpError, publicState, running } = ctx;
  const { body, project } = await open(ctx);
  const id = threadParam(body);
  const entry = findThread(threadsOf(store.get(), project), id);
  if (entry?.main) throw httpError(400, 'Main cannot be closed.');
  if (running?.has?.(id)) throw httpError(409, 'This thread is running. Stop it before closing it.');
  // A ready copy holds work that is not on the project's branches yet: the person chooses Keep branch or Discard before the thread closes.
  const copy = entry && !entry.main ? worktreeOf(store.get(), id) : null;
  if (copy && ['ready', 'closing'].includes(copy.state)) throw httpError(409, COPY_CLOSE);
  if (copy?.state === 'creating') throw httpError(409, COPY_MAKING);
  guarded(() => closeThread(store.get(), project, id), httpError);
  // A copy that failed or is missing goes with the thread: what is left of it is removed, and the branch only when it has no commits.
  if (copy) {
    await forgetWorktree({ project, st: store.get(), id });
    delete store.get().worktrees?.[id];
  }
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: id });
}

async function reopenRoute(ctx) {
  const { res, json, store, httpError, publicState } = ctx;
  const { body, project } = await open(ctx);
  const id = threadParam(body);
  guarded(() => reopenThread(store.get(), project, id), httpError);
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: id });
}

// Removes the snapshot refs a thread left in the project's private snapshot repository (lib/shadow.mjs keeps them under
// refs/plenum/<scope id>/). Best effort: a repository that is not there, or a ref that git cannot remove now, leaves them for the next prune.
async function dropShadowRefs(root, id) {
  const where = await locate(root).catch(() => null);
  if (!where) return;
  const present = await fs.stat(path.join(where.dir, 'HEAD')).then(() => true, () => false);
  if (!present) return;
  const env = {
    GIT_DIR: where.dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(where.dir, 'empty.gitconfig'),
    GIT_AUTHOR_NAME: 'Plenum',
    GIT_COMMITTER_NAME: 'Plenum',
    GIT_AUTHOR_EMAIL: 'plenum@localhost',
    GIT_COMMITTER_EMAIL: 'plenum@localhost',
  };
  const listed = await runGit(['for-each-ref', '--format=%(refname)', `refs/plenum/${id}/`], { cwd: where.real, env, timeoutMs: 20000 });
  if (!listed.ok) return;
  const refs = listed.stdout.split('\n').map(line => line.trim()).filter(ref => ref.startsWith(`refs/plenum/${id}/`));
  if (!refs.length) return;
  await runGit(['update-ref', '--stdin'], { cwd: where.real, env, input: refs.map(ref => `delete ${ref}\n`).join(''), timeoutMs: 60000 });
}

async function removeRoute(ctx) {
  const { res, json, store, httpError, publicState, running } = ctx;
  const { body, project } = await open(ctx);
  const id = threadParam(body);
  if (running?.has?.(id)) throw httpError(409, 'This thread is running. Stop it before removing it.');
  const st = store.get();
  const entry = guarded(() => dropClosedThread(st, project, id), httpError);
  if (worktreeRecord(st, entry.id)) delete st.worktrees[entry.id];
  const problems = await forgetThreadData(entry.id, {
    st,
    home: store.HOME,
    forgetSessions: forgetProjectSessions,
    clearArchive,
    root: project.path,
    dropShadowRefs,
  });
  if (problems.length) console.warn(`Threads: removed ${entry.id} with ${problems.length} cleanup problem(s): ${problems.join('; ')}`);
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: id, ...(problems.length ? { cleanup: problems } : {}) });
}

