// File checkpoints: list and restore snapshots taken before agent writes. See lib/routes/index.mjs.
// The storage and the checks are in lib/checkpoints.mjs. A restore is a write, so it asks first: the answer is a
// server-sent stream (as for a build) that carries the approval card to the Checkpoints drawer and then the result.
import { CheckpointError, applyRestore, listCheckpoints, planRestore, restorePrompt } from '../checkpoints.mjs';
import { chatModeOf } from '../projects.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// A restore writes project files, so a project in plan mode (read-only) refuses it before anything is planned.
const PLAN_RESTORE_REFUSED = 'This project is in plan mode, so Plenum will not restore files. Turn plan mode off to restore.';

export const routes = [
  { method: 'GET', path: '/api/checkpoints', handler: listRoute },
  { method: 'POST', path: '/api/checkpoints/restore', handler: restoreRoute },
];

// Runs one storage call. A CheckpointError keeps its status and message. Anything else is logged and answered with a plain
// line, so a file path from the system never reaches the panel.
async function run(task, httpError) {
  try {
    return await task();
  } catch (err) {
    if (err instanceof CheckpointError) throw httpError(err.status, err.message);
    console.error('Checkpoints:', err.message);
    throw httpError(500, 'Plenum could not read or restore the checkpoints. Try again.');
  }
}

// GET /api/checkpoints?project=ID. A project id that is not known is refused by projectById.
async function listRoute({ res, url, json, projectById, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const checkpoints = await run(() => listCheckpoints(project.id), httpError);
  return json(res, 200, { checkpoints });
}

// POST /api/checkpoints/restore with { project, id }. The server already refuses a POST without X-Muse-Console, and this
// handler checks it again because the restore overwrites files. Everything that can refuse the restore is checked before the
// stream starts, so a restore that cannot go ahead is answered as plain JSON and no card is shown.
async function restoreRoute({ req, res, readBody, httpError, projectById, streamForProject, approvalRequester }) {
  if (req.headers['x-muse-console'] !== '1') throw httpError(403, 'Missing X-Muse-Console header.');
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the checkpoint id.');
  const project = projectById(body.project);
  if (chatModeOf(project) === 'plan') throw httpError(409, PLAN_RESTORE_REFUSED);
  return streamForProject(req, res, project, async ({ signal, send }) => {
    const plan = await run(() => planRestore(project, body.id), httpError);
    return restoring(plan, project, approvalRequester(send, signal), httpError);
  });
}

// Asks, then writes. A denied card, a timeout or a closed drawer all end as "declined" with nothing written.
async function* restoring(plan, project, ask, httpError) {
  const allowed = await ask(restorePrompt(plan));
  if (!allowed) {
    yield { type: 'declined' };
    return;
  }
  const { restored } = await run(() => applyRestore(plan, project), httpError);
  yield { type: 'restored', files: restored };
}
