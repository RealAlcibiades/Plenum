// File checkpoints: list and restore snapshots taken before agent writes. See lib/routes/index.mjs.
// The storage and the checks are in lib/checkpoints.mjs. A restore is a write, so it asks first: the answer is a
// server-sent stream (as for a build) that carries the approval card to the Checkpoints drawer and then the result.
// A restore is the person's own click in a panel, so plan mode does not refuse it (amend-31): the model still cannot write,
// and the card is the same one as outside plan mode. A restore while the project is running is refused by streamForProject.
import { CheckpointError, applyRestore, listCheckpoints, planRestore, restorePrompt } from '../checkpoints.mjs';
import { requireToken } from '../auth.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

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

// POST /api/checkpoints/restore with { project, id }. The server already refuses a request without the Plenum token, and this
// handler checks it again because the restore overwrites files. Everything that can refuse the restore is checked before the
// stream starts, so a restore that cannot go ahead is answered as plain JSON and no card is shown. A project that is already
// running is refused by streamForProject with 409.
async function restoreRoute({ req, res, readBody, httpError, projectById, streamForProject, approvalRequester }) {
  requireToken(req, httpError);
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the checkpoint id.');
  const project = projectById(body.project);
  return streamForProject(req, res, project, async ({ signal, send }) => {
    const plan = await run(() => planRestore(project, body.id), httpError);
    return restoring(plan, project, approvalRequester(send, signal), httpError);
  }, undefined, { kind: 'restore' });
}

// Asks, then writes. A denied card, a timeout or a closed drawer all end as "declined" with nothing written. A denial can carry
// the person's reason (cleaned and capped by the approval route, and it is set on the card object by approvalRequester). The
// reason goes back to the drawer only: a restore has no chat step and no model turn, so no model reads it.
async function* restoring(plan, project, ask, httpError) {
  const prompt = restorePrompt(plan);
  const allowed = await ask(prompt);
  if (!allowed) {
    yield { type: 'declined', reason: typeof prompt.reason === 'string' ? prompt.reason : '' };
    return;
  }
  const { restored } = await run(() => applyRestore(plan, project), httpError);
  yield { type: 'restored', files: restored };
}
