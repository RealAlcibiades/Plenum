// Checkpoint diffs: what a restore would change, read-only. GET /api/checkpoints/diff?project=ID&id=CHECKPOINT. The planning and
// the checks are in lib/checkpoints.mjs (planRestore) and the diff text is built in lib/diff.mjs. Nothing is written here, and a
// project in plan mode still gets its answer, because viewing a diff changes no file. The restore itself stays in lib/routes/checkpoints.mjs.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CheckpointError, MAX_FILE_BYTES, planRestore } from '../checkpoints.mjs';
import { capDetail, unifiedDiff } from '../diff.mjs';

const CHECKPOINT_ID = /^\d{13}-[0-9a-f]{8}$/;
const NOT_FOUND = 'There is no checkpoint with that id.';

export const routes = [
  { method: 'GET', path: '/api/checkpoints/diff', handler: diffRoute },
];

// Runs one storage call. A CheckpointError keeps its status and message. Anything else is logged and answered with a plain
// line, so a file path from the system never reaches the panel.
async function run(task, httpError) {
  try {
    return await task();
  } catch (err) {
    if (err instanceof CheckpointError) throw httpError(err.status, err.message);
    console.error('Checkpoint diff:', err.message);
    throw httpError(500, 'Plenum could not read the checkpoint to compare it. Try again.');
  }
}

// GET /api/checkpoints/diff?project=ID&id=CHECKPOINT. An id that is not shaped like a checkpoint id is answered as not found,
// the same as a well-formed id with no checkpoint behind it. A project id that is not known is refused by projectById.
async function diffRoute({ res, url, json, projectById, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const id = url.searchParams.get('id');
  if (typeof id !== 'string' || !CHECKPOINT_ID.test(id)) throw httpError(404, NOT_FOUND);
  const plan = await run(() => planRestore(project, id), httpError);
  const files = await run(() => compareFiles(plan), httpError);
  return json(res, 200, { id, time: plan.time, files });
}

// For each file the restore would write: the saved copy against the file as it is now. A NUL byte in either makes the file
// binary, and no text diff is made. An existing file that cannot be read counts as empty. A file that is now larger than the
// checkpoint size limit is not read at all: it is listed as too large to compare.
async function compareFiles(plan) {
  const out = [];
  for (const f of plan.files) {
    if (f.exists && (await sizeOf(f.real)) > MAX_FILE_BYTES) {
      out.push({ path: f.path, exists: true, binary: false, same: false, diff: '', tooLarge: true });
      continue;
    }
    const saved = await fs.readFile(path.join(plan.dir, f.blob));
    const current = f.exists ? await fs.readFile(f.real).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    if (saved.includes(0) || current.includes(0)) {
      out.push({ path: f.path, exists: f.exists, binary: true, same: false, diff: '' });
      continue;
    }
    const savedText = saved.toString('utf8');
    const currentText = current.toString('utf8');
    const same = currentText === savedText;
    // The direction is from the file as it is now to the saved copy, which is what a restore does.
    const diff = same ? '' : capDetail(unifiedDiff(currentText, savedText, f.path));
    out.push({ path: f.path, exists: f.exists, binary: false, same, diff });
  }
  return out;
}

// The size of a file in bytes. A file that cannot be stat-ed counts as empty, the same as one that cannot be read.
const sizeOf = file => fs.stat(file).then(info => info.size, () => 0);
