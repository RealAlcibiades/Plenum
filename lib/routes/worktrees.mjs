// Isolated copies of a project for its threads (pro-02). The git work is in lib/worktree.mjs; the record of a copy and how a thread finds its
// folder are in lib/scope.mjs. Every POST here checks the Plenum token itself (requireToken), because each one changes files on disk.
//
//   GET  /api/worktrees/info?project=ID              { repo, noGit, settings, root }  whether the New thread panel offers a copy, the project's
//                                                    copy settings and the folder the copies live in
//   GET  /api/worktrees/status?project=ID&thread=ID  { state, branch, base, files, clean, ... } for the chip (null state: no copy)
//   POST /api/worktrees/create     { project, thread }   server-sent stream: makes the copy (also "Try again" after a failure). 409 while the
//                                                        thread runs
//   POST /api/worktrees/use-project { project, thread }  a failed copy is dropped; the thread uses the project folder, read-only (pro-01's rule)
//   POST /api/worktrees/keep       { project, thread, message? }  commits the copy's changes on its branch, removes the folder, closes the thread
//   POST /api/worktrees/discard    { project, thread, deleteBranch? }  removes the folder (the branch is kept unless deleteBranch is true), closes
//   POST /api/worktrees/merge      { project, thread }   server-sent stream (Phase 2): merges the branch into the base after a click-only card
//   GET  /api/worktree-settings?project=ID           { setup, setupTimeoutSec, copy }
//   POST /api/worktree-settings    { project, setup, setupTimeoutSec, copy }  saved on the project (400 with the reason when refused)
// Keep, Discard and Merge answer 409 while the thread runs and 409 'Turn plan mode off first.' in plan mode. Merge is also project-wide
// (server.mjs EXCLUSIVE_KINDS): it starts only when every thread of the project is idle, and while its card waits and git merges no other
// thread of the project starts a run (409 'A merge is running in this project. Wait until it ends.').
import { requireToken } from '../auth.mjs';
import { chatModeOf } from '../projects.mjs';
import { runningScopes, scopeFor, worktreeRecord } from '../scope.mjs';
import { MAX_CLOSED, closeThread, closedThreads, threadsOf } from '../threads.mjs';
import {
  createWorktree, discardWorktree, forgetWorktree, keepWorktree, mergePreflight, mergeWorktree, normalizeSettings, repoInfo,
  settingsOf, storeSettings, worktreeRoot, worktreeStatus,
} from '../worktree.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const PLAN_OFF = 'Turn plan mode off first.';
const RUNNING = 'This thread is running. Stop it first.';
const STATUS_TTL_MS = 2000;

export const routes = [
  { method: 'GET', path: '/api/worktrees/info', handler: infoRoute },
  { method: 'GET', path: '/api/worktrees/status', handler: statusRoute },
  { method: 'POST', path: '/api/worktrees/create', handler: createRoute },
  { method: 'POST', path: '/api/worktrees/use-project', handler: useProjectRoute },
  { method: 'POST', path: '/api/worktrees/keep', handler: keepRoute },
  { method: 'POST', path: '/api/worktrees/discard', handler: discardRoute },
  { method: 'POST', path: '/api/worktrees/merge', handler: mergeRoute },
  { method: 'GET', path: '/api/worktree-settings', handler: settingsGetRoute },
  { method: 'POST', path: '/api/worktree-settings', handler: settingsSaveRoute },
];

// The body of a POST: an object with a project. Returns { body, project }.
async function open({ req, readBody, httpError, projectById }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the thread.');
  return { body, project: projectById(body.project) };
}

// The scope of the thread a body or a query names. A missing thread is a 400; an unknown or closed one is scopeFor's 404.
function scopeOf({ store, httpError }, project, thread) {
  if (typeof thread !== 'string' || !thread) throw httpError(400, 'Say which thread.');
  try {
    return scopeFor(store, project, thread);
  } catch (err) {
    if (err?.status) throw httpError(err.status, err.message);
    throw err;
  }
}

// Runs an operation of lib/worktree.mjs that throws an Error with a status and turns it into the server's error.
async function guarded(task, httpError) {
  try {
    return await task();
  } catch (err) {
    if (err?.status) throw httpError(err.status, err.message);
    throw err;
  }
}

// Keep, Discard and Merge change the copy or the branches: never while the thread runs, never in plan mode.
function refuseBusy({ running, httpError }, project, scope) {
  if (running?.has?.(scope.id)) throw httpError(409, RUNNING);
  if (chatModeOf(project) === 'plan' || scope.chatMode === 'plan') throw httpError(409, PLAN_OFF);
}

// ---------- reading ----------

async function infoRoute({ res, url, json, httpError, projectById }) {
  const id = url.searchParams.get('project');
  if (!id) throw httpError(400, 'Choose a project first.');
  const project = projectById(id);
  const info = await repoInfo(project);
  return json(res, 200, { repo: info.repo, noGit: info.noGit, branch: info.branch, detached: info.detached, settings: settingsOf(project), root: worktreeRoot() });
}

// thread id -> { at, value }: the last answer, so several windows and the page's timer never start more than one git process a moment.
const statusCache = new Map();

async function statusRoute(ctx) {
  const { res, url, json, httpError, projectById, store } = ctx;
  const id = url.searchParams.get('project');
  if (!id) throw httpError(400, 'Choose a project first.');
  const project = projectById(id);
  // No thread means the project's active one, as in every route that takes a thread.
  const asked = url.searchParams.get('thread');
  let scope;
  try {
    scope = asked ? scopeOf(ctx, project, asked) : scopeFor(store, project, undefined);
  } catch (err) {
    if (err?.status) throw httpError(err.status, err.message);
    throw err;
  }
  if (!scope.worktree) return json(res, 200, { state: null });
  const hit = statusCache.get(scope.id);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS && hit.state === scope.worktree.state) return json(res, 200, hit.value);
  const value = await worktreeStatus(store.get(), scope.id);
  statusCache.set(scope.id, { at: Date.now(), value, state: scope.worktree.state });
  return json(res, 200, value ?? { state: null });
}

// ---------- making a copy ----------

async function createRoute(ctx) {
  const { req, res, httpError, store, streamForProject } = ctx;
  const { body, project } = await open(ctx);
  const scope = scopeOf(ctx, project, body.thread);
  const rec = worktreeRecord(store.get(), scope.id);
  if (!rec) throw httpError(400, 'This thread was not made with an isolated copy.');
  if (!['creating', 'failed'].includes(rec.state)) throw httpError(409, 'This thread already has an isolated copy.');
  statusCache.delete(scope.id);
  return streamForProject(req, res, project, ({ signal, scope: live }) => createWorktree({ store, project, scope: live, signal }), undefined, { kind: 'worktree', scope });
}

async function useProjectRoute(ctx) {
  const { res, json, httpError, store, publicState, running } = ctx;
  const { body, project } = await open(ctx);
  const scope = scopeOf(ctx, project, body.thread);
  if (running?.has?.(scope.id)) throw httpError(409, RUNNING);
  if (scope.worktree?.state !== 'failed') throw httpError(409, 'Only a copy that could not be made can be given up this way.');
  const st = store.get();
  await forgetWorktree({ project, st, id: scope.id });
  delete st.worktrees[scope.id];
  statusCache.delete(scope.id);
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), thread: scope.id });
}

// ---------- Keep branch and Discard ----------

// The thread is closed with its chat kept. Both operations check first that there is room in the closed list, because the folder is gone
// once they have run.
function needRoom({ store, httpError }, project) {
  if (closedThreads(threadsOf(store.get(), project)).length >= MAX_CLOSED) {
    throw httpError(409, `This project keeps ${MAX_CLOSED} closed threads. Remove one from the New thread panel first.`);
  }
}

async function finishThread({ store }, project, scope) {
  const st = store.get();
  delete st.worktrees?.[scope.id];
  statusCache.delete(scope.id);
  closeThread(st, project, scope.id);
  await store.saveOrFail();
}

async function keepRoute(ctx) {
  const { res, json, httpError, publicState } = ctx;
  const { body, project } = await open(ctx);
  const scope = scopeOf(ctx, project, body.thread);
  if (body.message !== undefined && body.message !== null && typeof body.message !== 'string') throw httpError(400, 'The commit message is text.');
  refuseBusy(ctx, project, scope);
  needRoom(ctx, project);
  const kept = await guarded(() => keepWorktree({ project, scope, message: body.message }), httpError);
  await finishThread(ctx, project, scope);
  return json(res, 200, { ...publicState(), thread: scope.id, kept });
}

async function discardRoute(ctx) {
  const { res, json, httpError, publicState } = ctx;
  const { body, project } = await open(ctx);
  const scope = scopeOf(ctx, project, body.thread);
  if (body.deleteBranch !== undefined && typeof body.deleteBranch !== 'boolean') throw httpError(400, 'Send deleteBranch: true or deleteBranch: false.');
  refuseBusy(ctx, project, scope);
  needRoom(ctx, project);
  const discarded = await guarded(() => discardWorktree({ project, scope, deleteBranch: body.deleteBranch === true }), httpError);
  await finishThread(ctx, project, scope);
  return json(res, 200, { ...publicState(), thread: scope.id, discarded });
}

// ---------- Merge into the base (Phase 2) ----------

// A thread that writes in the project folder and runs now would be changing files under the merge. This gives the plain answer for it; the
// run itself is refused for every thread of the project by streamForProject (kind 'worktree-merge' is exclusive), which also covers a turn
// that starts after this check, while the card waits and while git merges.
function writerRunning({ running, store }, project, scope) {
  for (const id of runningScopes(running, project.id)) {
    if (id === scope.id) continue;
    try {
      const other = scopeFor(store, project, id);
      if (!other.worktree && other.writer) return true;
    } catch {
      // A scope that is gone is not running anything.
    }
  }
  return false;
}

async function mergeRoute(ctx) {
  const { req, res, httpError, streamForProject, approvalRequester } = ctx;
  const { body, project } = await open(ctx);
  const scope = scopeOf(ctx, project, body.thread);
  refuseBusy(ctx, project, scope);
  if (writerRunning(ctx, project, scope)) throw httpError(409, 'Another thread is changing the project folder. Merge when it is idle.');
  await guarded(() => mergePreflight({ project, scope }), httpError);
  statusCache.delete(scope.id);
  return streamForProject(
    req, res, project,
    ({ signal, send, scope: live }) => mergeWorktree({ project, scope: live, approve: approvalRequester(send, signal), signal }),
    undefined,
    { kind: 'worktree-merge', scope },
  );
}

// ---------- the project's copy settings ----------

async function settingsGetRoute({ res, url, json, httpError, projectById }) {
  const id = url.searchParams.get('project');
  if (!id) throw httpError(400, 'Choose a project first.');
  return json(res, 200, settingsOf(projectById(id)));
}

// Stored beside the project's other records (project.worktree), never in project.settings, which the Project settings save replaces.
async function settingsSaveRoute(ctx) {
  const { res, json, httpError, store } = ctx;
  const { body, project } = await open(ctx);
  let next;
  try {
    next = normalizeSettings(body, project);
  } catch (err) {
    throw httpError(400, err.message);
  }
  storeSettings(project, next);
  await store.saveOrFail();
  return json(res, 200, settingsOf(project));
}
