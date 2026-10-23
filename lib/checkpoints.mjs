// File checkpoints. Before an agent write changes a file, lib/tools.mjs calls snapshotBeforeWrite, which keeps the file's
// original bytes in the Plenum state folder and never inside the project:
//   <state folder>/checkpoints/<project id>/<checkpoint id>/f0, f1, ...   the original bytes of each file
//   <state folder>/checkpoints/<project id>/<checkpoint id>/index.json    { id, time, label, files: [{ path, size, blob }] }
// path is relative to the project and uses forward slashes. A checkpoint exists only once its index.json is in place, and
// the index is renamed into place last, so a crash part way leaves nothing that lists or restores. The routes in
// lib/routes/checkpoints.mjs list the checkpoints and restore one after the user approves.
// Contract:
//   snapshotBeforeWrite({ projectId, projectPath, absPath, label }) -> { id } | null
// It never throws to the caller: a failure returns null and the write goes on without a checkpoint.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOME } from './store.mjs';
import { checkAccess, isCredentialPath } from './guard.mjs';
import { insideRoot } from './files.mjs';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 200 * 1024 * 1024;
// A count limit (B-45): the newest checkpoints of a project are kept up to this many, so zero-byte checkpoints, which cost no bytes,
// cannot pile up without limit. The oldest go first, as with the size limit. The newest is always kept.
export const MAX_CHECKPOINTS = 1000;
// The list shows this many of the newest checkpoints. Older ones stay on disk until the size limit prunes them.
export const LIST_LIMIT = 200;
const LABEL_MAX = 200;
const MAX_FILES = 50;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CHECKPOINT_ID = /^\d{13}-[0-9a-f]{8}$/;
const BLOB = /^f\d{1,2}$/;
// Windows device names. A file with one of these names is the device, not a file.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = s => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// An error that carries the HTTP status the route answers with. The message is plain text for the panel to show.
// restored lists the files a restore had already written when it failed.
export class CheckpointError extends Error {
  constructor(status, message, restored = []) {
    super(message);
    this.name = 'CheckpointError';
    this.status = status;
    this.restored = restored;
  }
}

const goodName = s => typeof s === 'string' && NAME.test(s) && !RESERVED.test(s);

// <state folder>/checkpoints/<project id>. The id becomes a folder name, so it must be a plain name.
export function projectCheckpointsDir(projectId, home = HOME) {
  if (!goodName(projectId)) throw new CheckpointError(400, 'That project id is not one Plenum can keep checkpoints under.');
  return path.join(home, 'checkpoints', projectId);
}

// <state folder>/checkpoints/<project id>/<checkpoint id>. The id comes from a request, so it must match the shape this file makes.
function checkpointDir(projectId, id, home) {
  if (typeof id !== 'string' || !CHECKPOINT_ID.test(id)) throw new CheckpointError(400, 'That is not a checkpoint id.');
  return path.join(projectCheckpointsDir(projectId, home), id);
}

// The segments of a project-relative path, or null when the path could name more than a plain file in the project: an empty,
// '.' or '..' segment, a drive or stream colon, a wildcard, a control character, a Windows device name, a trailing dot or
// space (Windows drops it, so the name means another file), or a .git folder.
function segmentsOf(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return null;
  const parts = rel.split('/');
  for (const s of parts) {
    if (!s || s === '.' || s === '..' || /[<>:"\\|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || RESERVED.test(s) || s.toLowerCase() === '.git') return null;
  }
  return parts;
}

// Reads and checks one checkpoint's index.json. Returns { id, time, label, files } or null when it is missing or not valid.
async function readIndex(dir, id) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(data) || data.id !== id || !Number.isFinite(data.time) || !Array.isArray(data.files)) return null;
  if (data.files.length < 1 || data.files.length > MAX_FILES) return null;
  const files = [];
  for (const f of data.files) {
    if (!isObject(f) || typeof f.path !== 'string' || !Number.isInteger(f.size) || f.size < 0) return null;
    if (typeof f.blob !== 'string' || !BLOB.test(f.blob)) return null;
    files.push({ path: f.path, size: f.size, blob: f.blob });
  }
  return { id, time: data.time, label: typeof data.label === 'string' ? data.label : '', files };
}

const totalSize = files => files.reduce((sum, f) => sum + f.size, 0);

// The ids in a project's folder, oldest first. An id starts with the time in milliseconds, so sorting the names sorts by time.
async function idsIn(pdir) {
  const names = await fs.readdir(pdir).catch(err => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  return names.filter(n => CHECKPOINT_ID.test(n)).sort();
}

// ---------- taking a checkpoint ----------

// Ids rise with each call even inside one millisecond, so the order they are taken in is the order they list in.
let lastStamp = 0;
function newId() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return { id: `${String(lastStamp).padStart(13, '0')}-${randomBytes(4).toString('hex')}`, time: lastStamp };
}

// Checkpoints are written and pruned one at a time, so two writes never prune each other's work.
let queue = Promise.resolve();
function queued(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// Keeps a file's current bytes as a checkpoint, then prunes the project's oldest checkpoints beyond the size limit or the count limit.
// Returns null, without writing anything, for every case that is not an error: a file that does not exist or is not a
// regular file, one over 5 MB, one outside the project or under .git, and one that isCredentialPath or checkAccess refuses.
// A second argument sets the state folder and the size and count limits; the tests use it, and the server leaves it out.
export async function snapshotBeforeWrite(args, opts) {
  try {
    return await take(args ?? {}, opts ?? {});
  } catch (err) {
    console.error('Checkpoints: no checkpoint was kept:', err.message);
    return null;
  }
}

async function take({ projectId, projectPath, absPath, label }, { home = HOME, maxProjectBytes = MAX_PROJECT_BYTES, maxCheckpoints = MAX_CHECKPOINTS }) {
  if (!goodName(projectId)) return null;
  if (typeof projectPath !== 'string' || !projectPath || typeof absPath !== 'string' || !path.isAbsolute(absPath)) return null;
  // The credential check on the path as written comes before the path is opened, so a credential file is never read.
  if (isCredentialPath(absPath)) return null;
  const realRoot = await fs.realpath(projectPath).catch(() => null);
  const real = await fs.realpath(absPath).catch(() => null);
  if (!realRoot || !real) return null;
  if (isCredentialPath(real)) return null;
  try {
    checkAccess(real, { write: true });
  } catch {
    return null;
  }
  if (!insideRoot(realRoot, real)) return null;
  const rel = path.relative(realRoot, real).split(path.sep).join('/');
  if (!segmentsOf(rel)) return null;
  // Checkpoints never go inside the project, and the state folder is never snapshotted into itself.
  const stateDir = await fs.realpath(home).catch(() => path.resolve(home));
  if (insideRoot(realRoot, stateDir) || insideRoot(stateDir, real)) return null;
  const info = await fs.stat(real);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
  const data = await fs.readFile(real);
  if (data.length > MAX_FILE_BYTES) return null;

  const pdir = projectCheckpointsDir(projectId, home);
  const note = typeof label === 'string' ? oneLine(label).slice(0, LABEL_MAX) : '';
  return queued(async () => {
    // The ledger is read before the new checkpoint is written, so a first scan does not count it twice.
    const ledger = await ledgerFor(pdir);
    const { id, time } = newId();
    const dir = path.join(pdir, id);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'f0'), data);
      const tmp = path.join(dir, `index.json.${process.pid}.tmp`);
      await fs.writeFile(tmp, JSON.stringify({ id, time, label: note, files: [{ path: rel, size: data.length, blob: 'f0' }] }, null, 2));
      await fs.rename(tmp, path.join(dir, 'index.json'));
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    ledger.ids.push(id);
    ledger.sizes.set(id, data.length);
    ledger.total += data.length;
    await prune(pdir, ledger, maxProjectBytes, maxCheckpoints).catch(err => console.error('Checkpoints: could not prune old checkpoints:', err.message));
    return { id };
  });
}

// The in-process ledger of each checkpoints folder (B-45): its checkpoint ids oldest first, the bytes of each and their total. The first
// take in this process reads the folder once; after that each take only adds its own checkpoint, and pruning only removes from the
// ledger, so no take reads index.json again. Writes are queued, so the ledger has one writer. A checkpoint folder removed by hand
// leaves the ledger overcounted until the process restarts, which only prunes early.
const ledgers = new Map();
async function ledgerFor(pdir) {
  const known = ledgers.get(pdir);
  if (known) return known;
  const ledger = { ids: [], sizes: new Map(), total: 0 };
  for (const id of await idsIn(pdir)) {
    const entry = await readIndex(path.join(pdir, id), id);
    const size = entry ? totalSize(entry.files) : 0;
    ledger.ids.push(id);
    ledger.sizes.set(id, size);
    ledger.total += size;
  }
  ledgers.set(pdir, ledger);
  return ledger;
}

// Removes the oldest checkpoints while the project is over the size limit or the count limit. The newest is always kept. A
// checkpoint that cannot be removed stays in the ledger, and the error goes to the caller, which logs it.
async function prune(pdir, ledger, maxBytes, maxCount) {
  while (ledger.ids.length > 1 && (ledger.total > maxBytes || ledger.ids.length > maxCount)) {
    const id = ledger.ids[0];
    await fs.rm(path.join(pdir, id), { recursive: true, force: true });
    ledger.ids.shift();
    ledger.total -= ledger.sizes.get(id) ?? 0;
    ledger.sizes.delete(id);
  }
}

// ---------- listing ----------

// A project's checkpoints, newest first: { id, time, path, size, label, count }. path is the first file's path and count
// the number of files in the checkpoint; size is the bytes of all of them. Folders that are not valid checkpoints are skipped.
export async function listCheckpoints(projectId, { home = HOME, limit = LIST_LIMIT } = {}) {
  const pdir = projectCheckpointsDir(projectId, home);
  const out = [];
  for (const id of (await idsIn(pdir)).reverse()) {
    if (out.length >= limit) break;
    const entry = await readIndex(path.join(pdir, id), id);
    if (entry) out.push({ id, time: entry.time, path: entry.files[0].path, size: totalSize(entry.files), label: entry.label, count: entry.files.length });
  }
  return out;
}

// ---------- restoring ----------

async function projectRoot(projectPath) {
  try {
    return await fs.realpath(projectPath);
  } catch {
    throw new CheckpointError(400, 'The project folder cannot be found, so nothing was restored.');
  }
}

// Where a path really is. The nearest part that exists is resolved with fs.realpath (links and junctions followed), and the
// part that does not exist yet is kept as written after it. A link that leads nowhere is refused, because a write through
// it would land at its far end.
async function realPlace(abs) {
  let probe = abs;
  const tail = [];
  for (;;) {
    let found = true;
    try {
      await fs.lstat(probe);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      found = false;
    }
    if (found) {
      try {
        return path.join(await fs.realpath(probe), ...tail);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        throw new CheckpointError(403, 'A link in the way leads nowhere, so nothing was restored.');
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) return abs;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
}

// The checks on one project-relative path before anything is written to it. Returns { real, exists }: the place the path really
// is, and whether a file is there now. Throws a CheckpointError (and writes nothing) when the path is not a plain file inside the
// project, when it is a credential folder, when checkAccess refuses a write, when it is inside .git, or when it is a folder now.
// Restores (resolveTargets below) and the turn snapshot rewind (lib/routes/snapshots.mjs) both use it, so every path that is written
// back passes the same rules.
export async function checkRestoreTarget(realRoot, rel) {
  const parts = segmentsOf(rel);
  if (!parts) throw new CheckpointError(400, `"${oneLine(rel).slice(0, 120)}" is not a plain path inside the project, so nothing was restored.`);
  const abs = path.join(realRoot, ...parts);
  const real = await realPlace(abs);
  if (!insideRoot(realRoot, real) || same(real, realRoot)) {
    throw new CheckpointError(403, `${rel} would be written outside the project folder, so nothing was restored.`);
  }
  if (isCredentialPath(abs) || isCredentialPath(real)) {
    throw new CheckpointError(403, `${rel} is in a folder that holds credentials, so nothing was restored.`);
  }
  try {
    checkAccess(real, { write: true });
  } catch (err) {
    throw new CheckpointError(403, `${rel}: ${err.message} Nothing was restored.`);
  }
  if (path.relative(realRoot, real).split(path.sep).some(s => s.toLowerCase() === '.git')) {
    throw new CheckpointError(403, `${rel} is inside .git, so nothing was restored.`);
  }
  const info = await fs.lstat(real).catch(() => null);
  if (info?.isDirectory()) throw new CheckpointError(400, `${rel} is a folder now, so nothing was restored.`);
  return { real, exists: Boolean(info) };
}

// Checks every file of a checkpoint and returns it with the place it would be written: { path, size, blob, real, exists }.
// Any file that fails refuses the whole restore, so a restore never writes some files and refuses others.
async function resolveTargets(realRoot, entries) {
  const seen = new Set();
  const out = [];
  for (const f of entries) {
    const { real, exists } = await checkRestoreTarget(realRoot, f.path);
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) throw new CheckpointError(400, `${f.path} appears twice in the checkpoint, so nothing was restored.`);
    seen.add(key);
    out.push({ path: f.path, size: f.size, blob: f.blob, real, exists });
  }
  return out;
}

// Looks at a checkpoint and the project, and returns what a restore would do, or throws a CheckpointError. Nothing is written.
// project is { id, path }. Call this before asking the user, so a restore that cannot go ahead is never offered.
export async function planRestore(project, id, { home = HOME } = {}) {
  const dir = checkpointDir(project?.id, id, home);
  const entry = await readIndex(dir, id);
  if (!entry) throw new CheckpointError(404, 'There is no checkpoint with that id.');
  const realRoot = await projectRoot(project.path);
  const files = await resolveTargets(realRoot, entry.files);
  return { id, time: entry.time, label: entry.label, dir, realRoot, entries: entry.files, files };
}

// The approval card for a plan: it names every file the restore overwrites and says a restore cannot be undone.
export function restorePrompt(plan) {
  const when = new Date(plan.time).toLocaleString();
  const n = plan.files.length;
  const summary = n === 1 ? `Restore ${plan.files[0].path} to its state from ${when}` : `Restore ${n} files to their state from ${when}`;
  const lines = [`Project folder: ${plan.realRoot}`];
  if (plan.label) lines.push(`Checkpoint: ${oneLine(plan.label)}`);
  lines.push('This restore overwrites:');
  for (const f of plan.files) lines.push(`  ${f.path}  (${f.exists ? 'replaces the current file' : 'the file is missing now, so it is created'})`);
  lines.push('', 'A restore cannot itself be undone. The current contents of these files are replaced and are not saved first.');
  // clickOnly: the card is answered by a click only, so Y and N do nothing (the approval card keys in app.js and the drawer's card).
  return { summary, detail: lines.join('\n'), clickOnly: true };
}

// Writes the checkpoint's files back, once the user has approved. The targets are checked again first, because the approval
// may have waited minutes: a link swapped in meanwhile, or a changed folder, refuses the restore. Every saved copy is read and
// checked against its recorded size before the first file is written. Returns { restored: [path, ...] }.
export async function applyRestore(plan, project) {
  const realRoot = await projectRoot(project.path);
  const files = await resolveTargets(realRoot, plan.entries);
  if (files.length !== plan.files.length || files.some((f, i) => !same(f.real, plan.files[i].real))) {
    throw new CheckpointError(409, 'The files changed while the approval was waiting, so nothing was restored. Start the restore again.');
  }
  const bytes = [];
  for (const f of files) {
    const data = await fs.readFile(path.join(plan.dir, f.blob)).catch(() => null);
    if (!data || data.length !== f.size) {
      throw new CheckpointError(500, `The saved copy of ${f.path} is missing or damaged, so nothing was restored.`);
    }
    bytes.push(data);
  }
  const restored = [];
  for (let i = 0; i < files.length; i++) {
    try {
      await fs.mkdir(path.dirname(files[i].real), { recursive: true });
      await fs.writeFile(files[i].real, bytes[i]);
      restored.push(files[i].path);
    } catch (err) {
      console.error('Checkpoints: restore failed:', err.message);
      const done = restored.length ? ` ${restored.length} of ${files.length} files were restored first: ${restored.join(', ')}.` : '';
      throw new CheckpointError(500, `${files[i].path} could not be written (${err.code ?? 'error'}).${done}`, restored);
    }
  }
  return { restored };
}
