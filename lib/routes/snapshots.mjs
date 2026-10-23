// Rewind code (pro-05): puts a project's files back to how they were before a chat turn, and undoes that rewind. A rewind is a click in a
// panel, so it is the person's own change: plan mode does not refuse it (amend-31), and the approval card says what plan mode means
// here. It is refused while the project runs (streamForProject answers 409).
// The turn's snapshot is in lib/shadow.mjs, taken by lib/hooks/10-snapshot.mjs and kept on the chat message as snap.before.
//   POST /api/snapshots/rewind  { project, thread, index } rewinds to before the message at index; { project, thread, undo: true }
//                               undoes the last rewind of the scope. A server-sent stream: the approval card, then restored or declined.
//   GET  /api/snapshots/diff    ?project=&thread=&index= (or &undo=1) lists the files the rewind would change, each with its diff.
// The chat part of Rewind (cutting the chat back) is POST /api/chat/rewind in lib/routes/rewind.mjs; the client calls both.
// Every path a rewind writes or removes goes through checkRestoreTarget (lib/checkpoints.mjs), the same rules as a checkpoint restore,
// and one path that fails refuses the whole rewind. Files over 5 MB are never snapshotted, so they are never written back.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CheckpointError, checkRestoreTarget } from '../checkpoints.mjs';
import { snapshot, currentTree, changedBetween, diffFiles, diffText, readBlob, treeSizes, skipReason } from '../shadow.mjs';
import { capDetail } from '../diff.mjs';
import { cutFull } from '../review.mjs';
import { scopeFor } from '../scope.mjs';
import { chatModeOf } from '../projects.mjs';
import { requireToken } from '../auth.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_FILES = 2000;
const MAX_BYTES = 500 * 1024 * 1024;
const LIST_MAX = 200;
// Shown on the card while plan mode is on (amend-31). The same sentence the restore card shows.
const PLAN_NOTICE = 'Plan mode is on: the model will not write files, but your own change here is saved.';

export const routes = [
  { method: 'POST', path: '/api/snapshots/rewind', handler: rewindRoute },
  { method: 'GET', path: '/api/snapshots/diff', handler: diffRoute },
];

// The message's snapshot before its turn: { tree, turn }. A message that is not a plain question with a snapshot is refused.
function beforeTarget(store, projectId, index) {
  const log = store.transcript(projectId);
  const m = Number.isInteger(index) && index >= 0 && index < log.length ? log[index] : null;
  if (!(m && m.role === 'user' && m.kind === 'chat' && typeof m.snap?.before?.tree === 'string')) return null;
  const turn = log.slice(0, index + 1).filter(x => x.role === 'user' && x.kind === 'chat').length;
  return { tree: m.snap.before.tree, turn };
}

// The state a Code undo puts back: the files as they were before the last rewind of this scope, or null.
function undoTarget(store, scopeId) {
  const rw = store.get().rewinds?.[scopeId];
  return typeof rw?.tree === 'string' ? { tree: rw.tree, turn: null } : null;
}

// Maps a failure of the shadow repository or a checkpoint check to the answer the route gives.
function shadowError(httpError, err) {
  if (err instanceof CheckpointError) return httpError(err.status, err.message);
  return httpError(409, `Plenum could not compare the folder with the snapshot: ${err.message}`);
}

// GET /api/snapshots/diff. Compares only; nothing is written to the project or kept.
async function diffRoute({ url, res, json, projectById, httpError, store }) {
  const project = projectById(url.searchParams.get('project'));
  const scope = scopeFor(store, project, url.searchParams.get('thread') ?? undefined);
  const undo = url.searchParams.get('undo') === '1';
  const target = undo ? undoTarget(store, scope.id) : beforeTarget(store, project.id, Number(url.searchParams.get('index')));
  if (!target) throw httpError(404, undo ? 'There is no code rewind to undo.' : 'No snapshot was taken before this turn.');
  const root = await fs.realpath(scope.root).catch(() => null);
  if (!root) throw httpError(400, 'The project folder cannot be found.');
  const now = await currentTree(root).catch(err => { throw shadowError(httpError, err); });
  if (now.skipped) throw httpError(409, `Plenum could not compare the folder: ${skipReason(now.skipped)}.`);
  const out = await diffFiles(root, now.tree, target.tree).catch(err => { throw shadowError(httpError, err); });
  return json(res, 200, { files: out.files.map(f => ({ path: f.path, status: f.status, diff: f.diff })), total: out.total, truncated: out.truncated });
}

// POST /api/snapshots/rewind. Checks what can be checked before the card, then asks through the approval stream.
async function rewindRoute({ req, res, readBody, httpError, projectById, streamForProject, approvalRequester, store }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the message index, or with undo set.');
  const project = projectById(body.project);
  const scope = scopeFor(store, project, typeof body.thread === 'string' ? body.thread : undefined);
  const undo = body.undo === true;
  const target = undo ? undoTarget(store, scope.id) : beforeTarget(store, project.id, body.index);
  if (!target) throw httpError(404, undo ? 'There is no code rewind to undo.' : 'No snapshot was taken before this turn.');
  return streamForProject(req, res, project, async ({ signal, send }) => {
    const plan = await planRewind({ project, scope, target, undo, store, httpError });
    return rewinding(plan, approvalRequester(send, signal), store, httpError);
  }, undefined, { kind: 'rewind' });
}

// Works out what the rewind would do, and checks every path. Nothing is written here. The folder's files as they are now are kept as a
// snapshot first (refs/plenum/<scope>/...), so the rewind can be undone.
async function planRewind({ project, scope, target, undo, store, httpError }) {
  const root = await fs.realpath(scope.root).catch(() => null);
  if (!root) throw httpError(400, 'The project folder cannot be found, so nothing was changed.');
  const now = await snapshot(root, scope.id, undo ? 'before-undo' : 'before-rewind').catch(err => { throw shadowError(httpError, err); });
  if (now.skipped) throw httpError(409, `Plenum could not record the folder before the rewind: ${skipReason(now.skipped)}. Nothing was changed.`);
  // The changes from now to the target: a path that is only in the target is written back, a path only now is removed.
  const changes = await changedBetween(root, now.tree, target.tree).catch(err => { throw shadowError(httpError, err); });
  const restore = changes.filter(c => c.status !== 'D').map(c => c.path);
  const remove = changes.filter(c => c.status === 'D').map(c => c.path);
  if (changes.length > MAX_FILES) throw httpError(413, 'More than 2,000 files differ from that point, so Plenum refused the rewind. Nothing was changed.');
  const sizes = await treeSizes(root, target.tree).catch(err => { throw shadowError(httpError, err); });
  let bytes = 0;
  for (const rel of restore) bytes += sizes.get(rel) ?? 0;
  for (const c of changes) {
    const st = await fs.lstat(path.join(root, ...c.path.split('/'))).catch(() => null);
    if (st?.isFile()) bytes += st.size;
  }
  if (bytes > MAX_BYTES) throw httpError(413, 'More than 500 MB of files would change, so Plenum refused the rewind. Nothing was changed.');
  // Every path is checked now, so a refused path is said before the card, and again before anything is written.
  for (const c of changes) {
    await checkRestoreTarget(root, c.path).catch(err => { throw shadowError(httpError, err); });
  }
  const full = await diffText(root, now.tree, target.tree).catch(() => '');
  return { root, scopeId: scope.id, target, undo, now: now.tree, changes, restore, remove, full, planMode: chatModeOf(project) === 'plan' };
}

// The approval card's text: what happens, which files, the diff, and the way back.
function cardOf(plan) {
  const { restore, remove, root, undo } = plan;
  const label = undo ? 'Undo code rewind' : `Rewind code to before turn ${plan.target.turn}`;
  const summary = `${label}: restore ${restore.length} ${restore.length === 1 ? 'file' : 'files'}, remove ${remove.length} ${remove.length === 1 ? 'file' : 'files'} added since`;
  const lines = [`Project folder: ${root}`];
  const shown = [...restore.map(p => `  restore  ${p}`), ...remove.map(p => `  remove   ${p}`)];
  lines.push(...shown.slice(0, LIST_MAX));
  if (shown.length > LIST_MAX) lines.push(`…and ${shown.length - LIST_MAX} more`);
  lines.push('', 'The files as they are now are kept as a snapshot first, so Undo code rewind can put them back.');
  if (plan.planMode) lines.push(PLAN_NOTICE);
  const detail = `${lines.join('\n')}\n\n${capDetail(plan.full)}`;
  return { summary, detail, fullDetail: cutFull(plan.full), clickOnly: true };
}

// The stream: the approval card, then the answer. A denial (or a card that times out) writes nothing.
async function* rewinding(plan, ask, store, httpError) {
  const card = cardOf(plan);
  const allowed = await ask(card);
  if (!allowed) {
    yield { type: 'declined', reason: typeof card.reason === 'string' ? card.reason : '' };
    return;
  }
  // A rewind keeps the files as they are now before it writes, so Undo code rewind can put them back. An undo clears that record once
  // it has finished; if it stops part way, the record stays and the undo can be tried again.
  const st = store.get();
  st.rewinds ??= {};
  if (!plan.undo) {
    st.rewinds[plan.scopeId] = { at: Date.now(), tree: plan.now };
    await store.saveOrFail();
  }
  const done = await apply(plan, httpError);
  if (plan.undo) {
    delete st.rewinds[plan.scopeId];
    await store.saveOrFail();
  }
  yield { type: 'restored', files: done.files, removed: done.removed };
}

// Checks every path again (the approval may have waited), then writes the files back and removes the added ones. A file that cannot
// be read back or written stops the rewind, and the answer says which files were already done.
async function apply(plan, httpError) {
  const { root } = plan;
  const checked = [];
  for (const c of plan.changes) {
    checked.push({ ...c, ...(await checkRestoreTarget(root, c.path).catch(err => { throw shadowError(httpError, err); })) });
  }
  const files = [];
  const removed = [];
  for (const c of checked) {
    if (c.status === 'D') continue;
    const bytes = await readBlob(root, plan.target.tree, c.path);
    if (bytes === null) throw new CheckpointError(500, `The saved copy of ${c.path} is missing or over 5 MB, so the rewind stopped.`, files);
    try {
      await fs.mkdir(path.dirname(c.real), { recursive: true });
      await fs.writeFile(c.real, bytes);
    } catch (err) {
      throw new CheckpointError(500, `${c.path} could not be written (${err.code ?? 'error'}).${files.length ? ` ${files.length} files were restored first.` : ''}`, files);
    }
    files.push(c.path);
  }
  for (const c of checked) {
    if (c.status !== 'D') continue;
    const st = await fs.lstat(c.real).catch(() => null);
    if (st?.isFile() || st?.isSymbolicLink()) await fs.rm(c.real, { force: true });
    removed.push(c.path);
  }
  return { files, removed };
}
