// The review pane's endpoints (public/ext-review.js). Reading (GET) changes nothing. Changing (POST /api/review/hunk) acts on one
// hunk of one file, through git apply or git add, after the server has checked the answer the page holds:
//   GET  /api/review/changes?project=ID&thread=&since=   the changed files, in groups (git, or a turn snapshot, or none)
//   GET  /api/review/file?project=ID&thread=&group=&path= the full diff of one file (Show all)
//   POST /api/review/hunk  { project, thread, group, path, hunk, diffHash, action }  action: revert | stage | unstage
// The page sends only selectors: a group, a path git listed, a hunk number and the hash of the file's diff. The patch is built on
// the server from git's own output for that file, so nothing the page sends is given to git except as a selector.
// Plan mode does not stop a hunk action here: plan mode binds the model, not the person, so a click in this pane is allowed with the
// same checkpoint and confirm it has outside plan mode (DECISIONS item 16 as amended by amendment 31). A run in this thread still refuses.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkAccess } from '../guard.mjs';
import { MAX_FILE_BYTES } from '../checkpoints.mjs';
import { runGit } from '../git-run.mjs';
import { requireToken } from '../auth.mjs';
import { scopeFor } from '../scope.mjs';
import { checkpointFile } from '../tools.mjs';
import { insideRoot } from '../files.mjs';
import { ReviewError, collectChanges, cutFull, fullOf, patchFor, publicGroups, snapshotChanges } from '../review.mjs';

const GROUPS = new Set(['staged', 'unstaged', 'untracked']);
const ACTIONS = new Set(['revert', 'stage', 'unstage']);
const SHA256 = /^[0-9a-f]{64}$/;
const NOT_A_REPO = 'Review needs a git repository, or turn snapshots (which need git installed).';
const NO_FILE = 'That file has no changes now.';
const CHANGED = 'The file changed since the pane was drawn. Refresh and try again.';
const RUNNING = 'This thread is running. Use /cancel first.';
const NEED_REPO = 'Revert and Stage need a git repository.';
const NO_CHECKPOINT = 'Plenum could not keep a checkpoint of this file, so nothing was changed.';
const BIG_NEW_FILE = 'That new file is over 5 MB, so no checkpoint can be kept. Delete it yourself if you mean to.';
const BIG_FILE = 'That file is over 5 MB, so no checkpoint can be kept, and nothing was reverted.';
const APPLY_FAILED = 'That change could not be applied. Refresh and try again.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'GET', path: '/api/review/changes', handler: changesRoute },
  { method: 'GET', path: '/api/review/file', handler: fileRoute },
  { method: 'POST', path: '/api/review/hunk', handler: hunkRoute },
];

// Runs a read of the changes. A ReviewError keeps its status and message; anything else is logged and answered with a plain line.
async function read(task, httpError) {
  try {
    return await task();
  } catch (err) {
    if (err instanceof ReviewError) throw httpError(err.status, err.message);
    console.error('Review:', err?.message);
    throw httpError(500, 'Plenum could not read the changes. Try again.');
  }
}

// The changes as the page gets them: the source, the branch, the groups (no full text), truncated and a note.
async function currentAnswer(scope, since, httpError) {
  const state = await read(() => collectChanges(scope.root), httpError);
  if (state.repo) {
    return { source: 'git', branch: state.branch, groups: publicGroups(state.groups), truncated: state.truncated, note: null };
  }
  const snap = await snapshotChanges(scope.root, scope.id, since);
  if (snap) return { source: 'snapshot', branch: null, groups: snap.groups, truncated: snap.truncated, note: null };
  return { source: 'none', branch: null, groups: { staged: [], unstaged: [], untracked: [] }, truncated: false, note: NOT_A_REPO };
}

// The file as the server holds it now, with its full text, or null when it is not in the group.
async function findFile(scope, group, file, since, httpError) {
  if (group === 'snapshot') {
    const snap = await snapshotChanges(scope.root, scope.id, since);
    return snap ? snap.groups.snapshot.find(f => f.path === file) ?? null : null;
  }
  const state = await read(() => collectChanges(scope.root), httpError);
  if (!state.repo) return null;
  return state.groups[group]?.find(f => f.path === file) ?? null;
}

// GET /api/review/changes?project=ID&thread=&since=
async function changesRoute({ res, url, json, projectById, store, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const scope = scopeFor(store, project, url.searchParams.get('thread'));
  const since = url.searchParams.get('since') ?? undefined;
  return json(res, 200, await currentAnswer(scope, since, httpError));
}

// GET /api/review/file?project=ID&thread=&group=&path=. The path must be in the current changes of that group.
async function fileRoute({ res, url, json, projectById, store, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const scope = scopeFor(store, project, url.searchParams.get('thread'));
  const group = url.searchParams.get('group');
  const file = url.searchParams.get('path');
  if (!GROUPS.has(group) && group !== 'snapshot') throw httpError(400, 'Name the group of the file.');
  if (typeof file !== 'string' || !file) throw httpError(400, 'Name the file.');
  const found = await findFile(scope, group, file, url.searchParams.get('since') ?? undefined, httpError);
  if (!found) throw httpError(404, NO_FILE);
  return json(res, 200, { diff: cutFull(fullOf(found)) });
}

// POST /api/review/hunk. The server checks the token again, as the restore route does, because this writes files and the index.
async function hunkRoute({ req, res, readBody, json, projectById, store, running, httpError }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project, the file, the hunk and the action.');
  const project = projectById(body.project);
  const scope = scopeFor(store, project, body.thread);
  const { group, action, hunk, diffHash } = body;
  const file = body.path;
  if (!ACTIONS.has(action)) throw httpError(400, 'Choose Revert, Stage or Unstage.');
  if (!GROUPS.has(group)) throw httpError(400, 'Name the group of the file.');
  if (action === 'unstage' ? group !== 'staged' : group === 'staged') {
    throw httpError(400, action === 'unstage' ? 'Unstage works on staged changes.' : 'Revert and Stage work on changes that are not staged.');
  }
  if (typeof file !== 'string' || !file || file.length > 1024 || file.includes('\0')) throw httpError(400, 'Name the file.');
  if (!Number.isInteger(hunk) || hunk < 0) throw httpError(400, 'Name the hunk.');
  if (typeof diffHash !== 'string' || !SHA256.test(diffHash)) throw httpError(400, 'Name the version of the diff the pane shows.');
  // A thread that is running may be writing the same files, so its changes wait until the run ends.
  if (running.has(scope.id)) throw httpError(409, RUNNING);

  const root = scope.root;
  const state = await read(() => collectChanges(root), httpError);
  if (!state.repo) throw httpError(400, NEED_REPO);
  const found = state.groups[group].find(f => f.path === file);
  if (!found || found.diffHash !== diffHash) throw httpError(409, CHANGED);
  const abs = path.resolve(root, ...file.split('/'));
  if (!insideRoot(root, abs)) throw httpError(400, 'Name the file.');
  await guardTarget(abs, action === 'revert', httpError);

  const label = `Before reverting a hunk in ${file}`;
  if (group === 'untracked') {
    if (hunk !== 0) throw httpError(409, CHANGED);
    if (action === 'revert') {
      await revertNewFile({ scope, abs, file, label, httpError });
    } else {
      const added = await runGit(['--literal-pathspecs', 'add', '--', file], { cwd: root });
      if (!added.ok) throw httpError(409, APPLY_FAILED);
    }
  } else {
    const patch = patchFor(found.full, hunk);
    if (patch === null) throw httpError(409, CHANGED);
    if (action === 'revert') {
      await revertHunk({ scope, abs, label, patch, prefix: state.prefix, httpError });
    } else {
      const args = action === 'stage' ? ['--cached', '--recount', '-'] : ['--cached', '-R', '--recount', '-'];
      const applied = await runGit(applyArgs(state.prefix, args), { cwd: root, input: patch });
      if (!applied.ok) throw httpError(409, APPLY_FAILED);
    }
  }
  const after = await read(() => collectChanges(root), httpError);
  return json(res, 200, {
    ok: true,
    changes: { source: 'git', branch: after.branch ?? null, groups: publicGroups(after.groups ?? { staged: [], unstaged: [], untracked: [] }), truncated: after.truncated ?? false, note: null },
  });
}

// The argument list for git apply. The diffs are relative to the project folder, and git apply run from a folder inside a repository
// treats a path outside the folder as ignored, so a project that is a sub-folder names its prefix (--directory). The prefix comes
// from git (--show-prefix), not from the page.
function applyArgs(prefix, rest) {
  const directory = typeof prefix === 'string' && prefix !== '' ? [`--directory=${prefix.replace(/\/+$/, '')}`] : [];
  return ['apply', ...directory, ...rest];
}

// A write goes only to a place the guard allows: the real place of the path (links followed) must not be a credential folder,
// and a revert also must not be a system folder or Plenum's own source.
async function guardTarget(abs, write, httpError) {
  const real = await fs.realpath(abs).catch(() => null);
  try {
    checkAccess(real ?? abs, { write });
  } catch (err) {
    throw httpError(403, err.message);
  }
}

// Keeps a checkpoint of a file before a revert changes it. Without one, nothing is changed: a file over the size limit cannot be kept.
async function keepCheckpoint({ scope, abs, label, tooBig, tooBigMessage, httpError }) {
  if (tooBig) throw httpError(409, tooBigMessage);
  const kept = await checkpointFile({ projectId: scope.id, projectPath: scope.root, absPath: abs, label });
  if (!kept) throw httpError(409, NO_CHECKPOINT);
}

// Reverts one hunk of a file that has changes in the working tree. The file is checkpointed first, unless it is missing (a deleted
// file comes back with the hunk, so there is nothing to keep).
async function revertHunk({ scope, abs, label, patch, prefix, httpError }) {
  const info = await fs.stat(abs).catch(() => null);
  if (info?.isFile()) {
    await keepCheckpoint({ scope, abs, label, tooBig: info.size > MAX_FILE_BYTES, tooBigMessage: BIG_FILE, httpError });
  }
  const reverted = await runGit(applyArgs(prefix, ['--recount', '--whitespace=nowarn', '-R', '-']), { cwd: scope.root, input: patch });
  if (!reverted.ok) throw httpError(409, APPLY_FAILED);
}

// Reverts an untracked (new) file: it is checkpointed and then deleted. A file over 5 MB cannot be checkpointed, so it stays.
async function revertNewFile({ scope, abs, file, label, httpError }) {
  const info = await fs.lstat(abs).catch(() => null);
  if (!info?.isFile()) throw httpError(409, CHANGED);
  await keepCheckpoint({ scope, abs, label, tooBig: info.size > MAX_FILE_BYTES, tooBigMessage: BIG_NEW_FILE, httpError });
  try {
    await fs.unlink(abs);
  } catch {
    throw httpError(409, `Plenum could not remove ${file}. Refresh and try again.`);
  }
}
