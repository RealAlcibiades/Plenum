// Rewind code (pro-05): puts a project's files back to how they were before a chat turn, and undoes that rewind. A rewind is a click in a
// panel, so it is the person's own change: plan mode does not refuse it (amend-31), and the approval card says what plan mode means
// here. It is refused while the project runs (streamForProject answers 409).
// The turn's snapshot is in lib/shadow.mjs, taken by lib/hooks/10-snapshot.mjs and kept on the chat message as snap.before.
//   POST /api/snapshots/rewind  { project, thread, index } rewinds to before the message at index; { project, thread, undo: true }
//                               undoes the last rewind of the scope. A server-sent stream: the approval card, then restored or declined.
//   GET  /api/snapshots/diff    ?project=&thread=&index= (or &undo=1) lists the files the rewind would change, each with its diff.
// The chat part of Rewind (cutting the chat back) is POST /api/chat/rewind in lib/routes/rewind.mjs; the client calls both.
// Every path a rewind writes or removes goes through checkRestoreTarget (lib/checkpoints.mjs), the same rules as a checkpoint restore,
// and one path that fails refuses the whole rewind. Files over 5 MB are never snapshotted, so they are never written back: a restore that
// would replace one is named on the card as not kept. A link inside the project is followed, and the card names the place it writes. A
// nested git repository is left as it is. A turn whose snapshot is no longer kept (only the newest are) is refused with 410.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CheckpointError, checkRestoreTarget } from '../checkpoints.mjs';
import { snapshot, currentTree, changedBetween, diffFiles, diffText, readBlob, treeFor, treeSizes, skipReason } from '../shadow.mjs';
import { capDetail } from '../diff.mjs';
import { cutFull } from '../review.mjs';
import { scopeFor } from '../scope.mjs';
import { chatModeOf } from '../projects.mjs';
import { requireToken } from '../auth.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const MAX_FILES = 2000;
const MAX_BYTES = 500 * 1024 * 1024;
const LIST_MAX = 200;
const NAMES_MAX = 10;
// Shown on the card while plan mode is on (amend-31). The same sentence the restore card shows.
const PLAN_NOTICE = 'Plan mode is on: the model will not write files, but your own change here is saved.';
// What a card says about a path. A nested repository is left as it is; a file the snapshot does not keep is replaced without a copy.
const LEAVE = 'a nested git repository: its commits are not rewound';
const NOT_KEPT = 'not kept: replaced and cannot be undone';
// The answers when the snapshot a rewind or an undo needs is no longer kept (lib/shadow.mjs keeps the newest snapshots only).
const GONE_TURN = 'The code of that turn is no longer kept: only the last 50 turns can be rewound. Chat only still works.';
const GONE_UNDO = 'The files from before that rewind are no longer kept, so Undo code rewind cannot put them back.';

export const routes = [
  { method: 'POST', path: '/api/snapshots/rewind', handler: rewindRoute },
  { method: 'GET', path: '/api/snapshots/diff', handler: diffRoute },
];

// The message's snapshot before its turn: { tree, turn, id }. A message that is not a plain question with a snapshot is refused (null).
// scopeId is the thread the message is in (Main's is the project's id): each thread has its own transcript, and index counts in that one.
function beforeTarget(store, scopeId, index) {
  const log = store.transcript(scopeId);
  const m = Number.isInteger(index) && index >= 0 && index < log.length ? log[index] : null;
  if (!(m && m.role === 'user' && m.kind === 'chat' && typeof m.snap?.before?.tree === 'string')) return null;
  const turn = log.slice(0, index + 1).filter(x => x.role === 'user' && x.kind === 'chat').length;
  return { tree: m.snap.before.tree, turn, id: typeof m.snap.before.id === 'string' ? m.snap.before.id : null };
}

// The state a Code undo puts back: the files as they were before the last rewind of this scope, or null. id is the snapshot the record
// names; a record an older version kept names none (null), and such a record is no longer kept.
function undoTarget(store, scopeId) {
  const rw = store.get().rewinds?.[scopeId];
  return typeof rw?.tree === 'string' ? { tree: rw.tree, turn: null, id: typeof rw.id === 'string' ? rw.id : null } : null;
}

// Refuses a target whose snapshot is no longer kept, before anything is kept or shown: its ref has left the newest ones (lib/shadow.mjs
// prune). An undo whose record is gone also clears the record (clear), so the Undo button stops offering it. A missing folder is left to
// the check that follows, which names it.
async function refuseIfGone({ root, scope, target, undo, store, httpError, clear = false }) {
  if (!root) return;
  const kept = target.id === null ? null : await treeFor(root, scope.id, target.id).catch(err => { throw shadowError(httpError, err); });
  if (kept !== null) return;
  if (undo && clear) {
    delete store.get().rewinds?.[scope.id];
    await store.saveOrFail();
  }
  throw httpError(410, undo ? GONE_UNDO : GONE_TURN);
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
  const target = undo ? undoTarget(store, scope.id) : beforeTarget(store, scope.id, Number(url.searchParams.get('index')));
  if (!target) throw httpError(404, undo ? 'There is no code rewind to undo.' : 'No snapshot was taken before this turn.');
  const root = await fs.realpath(scope.root).catch(() => null);
  if (!root) throw httpError(400, 'The project folder cannot be found.');
  await refuseIfGone({ root, scope, target, undo, store, httpError });
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
  const target = undo ? undoTarget(store, scope.id) : beforeTarget(store, scope.id, body.index);
  if (!target) throw httpError(404, undo ? 'There is no code rewind to undo.' : 'No snapshot was taken before this turn.');
  // A code that is no longer kept is refused before the card, so nothing is asked or kept for it.
  const root = await fs.realpath(scope.root).catch(() => null);
  await refuseIfGone({ root, scope, target, undo, store, httpError, clear: true });
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
  await refuseIfGone({ root, scope, target, undo, store, httpError, clear: true });
  const now = await snapshot(root, scope.id, undo ? 'before-undo' : 'before-rewind').catch(err => { throw shadowError(httpError, err); });
  if (now.skipped) throw httpError(409, `Plenum could not record the folder before the rewind: ${skipReason(now.skipped)}. Nothing was changed.`);
  // The changes from now to the target: a path that is only in the target is written back, a path only now is removed. A nested git
  // repository is listed apart, because its commits are not files of this folder: it is left as it is.
  const all = await changedBetween(root, now.tree, target.tree).catch(err => { throw shadowError(httpError, err); });
  const nested = all.filter(c => c.nested).map(c => c.path);
  const changes = all.filter(c => !c.nested);
  if (changes.length > MAX_FILES) throw httpError(413, 'More than 2,000 files differ from that point, so Plenum refused the rewind. Nothing was changed.');
  const sizes = await treeSizes(root, target.tree).catch(err => { throw shadowError(httpError, err); });
  // Every path is checked now, so a refused path is said before the card, and again before anything is written. The place each path really
  // is (a link inside the project followed) is kept: the card names it, and the write goes there.
  const planned = [];
  for (const c of changes) {
    const { real } = await checkRestoreTarget(root, c.path).catch(err => { throw shadowError(httpError, err); });
    planned.push({ ...c, real });
  }
  let bytes = 0;
  const notKept = new Set();
  for (const c of planned) {
    if (c.status !== 'D') bytes += sizes.get(c.path) ?? 0;
    const st = await fs.lstat(c.real).catch(() => null);
    if (!st?.isFile()) continue;
    bytes += st.size;
    // A file that is there now but not in the snapshot now (over 5 MB, ignored, or a secret file) is replaced with no copy kept: the card says so.
    if (c.status === 'A') notKept.add(c.path);
  }
  if (bytes > MAX_BYTES) throw httpError(413, 'More than 500 MB of files would change, so Plenum refused the rewind. Nothing was changed.');
  const full = await diffText(root, now.tree, target.tree).catch(() => '');
  return {
    root,
    scopeId: scope.id,
    target,
    undo,
    now: now.tree,
    nowId: now.id,
    changes: planned,
    nested,
    notKept,
    restore: planned.filter(c => c.status !== 'D').map(c => c.path),
    remove: planned.filter(c => c.status === 'D').map(c => c.path),
    full,
    planMode: chatModeOf(project) === 'plan',
  };
}

// The card's line for one changed path: its prefix (what is done), the path, and in brackets where a link inside the project leads it
// and whether the file is not kept.
function lineOf(plan, prefix, c) {
  const notes = [];
  if (!same(c.real, path.join(plan.root, ...c.path.split('/')))) notes.push(`writes ${path.relative(plan.root, c.real).split(path.sep).join('/')}`);
  if (plan.notKept.has(c.path)) notes.push(NOT_KEPT);
  return `${prefix}${c.path}${notes.length ? `  (${notes.join('; ')})` : ''}`;
}

// The approval card's text: what happens, which files, the diff, and the way back.
function cardOf(plan) {
  const { restore, remove, nested, root, undo } = plan;
  const label = undo ? 'Undo code rewind' : `Rewind code to before turn ${plan.target.turn}`;
  const summary = `${label}: restore ${restore.length} ${restore.length === 1 ? 'file' : 'files'}, remove ${remove.length} ${remove.length === 1 ? 'file' : 'files'} added since`;
  const lines = [`Project folder: ${root}`];
  const shown = [
    ...plan.changes.filter(c => c.status !== 'D').map(c => lineOf(plan, '  restore  ', c)),
    ...plan.changes.filter(c => c.status === 'D').map(c => lineOf(plan, '  remove   ', c)),
    ...nested.map(p => `  leave    ${p}  (${LEAVE})`),
  ];
  lines.push(...shown.slice(0, LIST_MAX));
  if (shown.length > LIST_MAX) lines.push(`…and ${shown.length - LIST_MAX} more`);
  lines.push('', plan.notKept.size
    ? 'The files as they are now are kept as a snapshot first, except the ones marked not kept, so Undo code rewind can put them back.'
    : 'The files as they are now are kept as a snapshot first, so Undo code rewind can put them back.');
  if (plan.planMode) lines.push(PLAN_NOTICE);
  const detail = `${lines.join('\n')}\n\n${capDetail(plan.full)}`;
  return { summary, detail, fullDetail: cutFull(plan.full), clickOnly: true };
}

// Checks every path again, before anything is kept or written. A path that now leads to another place than the card names refuses the
// whole rewind: nothing was kept or written, so the rewind can be started again.
async function recheck(plan, httpError) {
  const checked = [];
  for (const c of plan.changes) {
    const now = await checkRestoreTarget(plan.root, c.path).catch(err => { throw shadowError(httpError, err); });
    if (!same(now.real, c.real)) throw new CheckpointError(409, 'The links changed while the approval was waiting, so nothing was rewound. Start the rewind again.');
    checked.push({ ...c, ...now });
  }
  return checked;
}

// The stream: the approval card, then the answer. A denial (or a card that times out) writes nothing.
async function* rewinding(plan, ask, store, httpError) {
  const card = cardOf(plan);
  const allowed = await ask(card);
  if (!allowed) {
    yield { type: 'declined', reason: typeof card.reason === 'string' ? card.reason : '' };
    return;
  }
  // The approval may have waited: the paths are checked again before anything is kept or written.
  const checked = await recheck(plan, httpError);
  // A rewind keeps the files as they are now before it writes, so Undo code rewind can put them back. An undo clears that record once
  // it has finished; if it stops part way, the record stays and the undo can be tried again.
  const st = store.get();
  st.rewinds ??= {};
  if (!plan.undo) {
    st.rewinds[plan.scopeId] = { at: Date.now(), tree: plan.now, id: plan.nowId };
    await store.saveOrFail();
  }
  let done;
  try {
    done = await apply(plan, checked);
  } catch (err) {
    // The record is kept, so the answer says Undo code rewind is offered for this error (undo: true).
    yield { type: 'error', message: err.message, undo: true };
    return;
  }
  if (plan.undo) {
    delete st.rewinds[plan.scopeId];
    await store.saveOrFail();
  }
  yield { type: 'restored', files: done.files, removed: done.removed };
}

// What a failed rewind says about the files it had already written: how many, their names (the first few), and that Undo can put them back.
function doneOf(files, undo) {
  if (!files.length) return ' No file was restored.';
  const shown = files.length > NAMES_MAX ? `${files.slice(0, NAMES_MAX).join(', ')} and ${files.length - NAMES_MAX} more` : files.join(', ');
  return ` ${files.length === 1 ? '1 file was' : `${files.length} files were`} restored first: ${shown}. Undo code rewind ${undo ? 'can be tried again' : 'can put them back'}.`;
}

// Writes the files back and removes the added ones, at the paths checked just before. A file that cannot be read back or written stops
// the rewind, and the answer says which files were already done.
async function apply(plan, checked) {
  const { root } = plan;
  const files = [];
  const removed = [];
  for (const c of checked) {
    if (c.status === 'D') continue;
    const bytes = await readBlob(root, plan.target.tree, c.path);
    if (bytes === null) throw new CheckpointError(500, `The saved copy of ${c.path} is missing or over 5 MB, so the rewind stopped.${doneOf(files, plan.undo)}`, files);
    try {
      await fs.mkdir(path.dirname(c.real), { recursive: true });
      await fs.writeFile(c.real, bytes);
    } catch (err) {
      throw new CheckpointError(500, `${c.path} could not be written (${err.code ?? 'error'}).${doneOf(files, plan.undo)}`, files);
    }
    files.push(c.path);
  }
  for (const c of checked) {
    if (c.status !== 'D') continue;
    const st = await fs.lstat(c.real).catch(() => null);
    try {
      if (st?.isFile() || st?.isSymbolicLink()) await fs.rm(c.real, { force: true });
    } catch (err) {
      throw new CheckpointError(500, `${c.path} could not be removed (${err.code ?? 'error'}).${doneOf(files, plan.undo)}`, files);
    }
    removed.push(c.path);
  }
  return { files, removed };
}
