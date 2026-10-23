// Check command after each turn (pro-06): the project's check settings and the Run checks button. The rules are in lib/checks.mjs and
// the turn hook in lib/hooks/50-checks.mjs. See lib/routes/index.mjs for how a route module is loaded.
//   GET  /api/checks?project=ID   the saved settings, or nulls when the project has no check
//   POST /api/checks               { project, command, auto, autoFix, fixRounds, timeoutSec }: saves them (an empty command removes the
//                                  check), answers the saved values or 400 with the message
//   POST /api/checks/run           { project, thread }: runs the check once in the project folder as a server-sent stream and keeps the
//                                  result on the newest reply. Plan mode answers 409. The stream is kept by streamForProject, so a run that
//                                  is already going is refused with 409 there.
// A Run checks press is the person's own click, so it is allowed to run the command even when the turn's check would not run by itself
// (a changed file that defines the check). Plan mode is the one thing that refuses it, as the rest of the project's commands.
import { checkSettingsOf, checksOf, lastChatReply, normalizeChecks, runAndRecord } from '../checks.mjs';
import { chatModeOf } from '../projects.mjs';
import { scopeFor } from '../scope.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'GET', path: '/api/checks', handler: getRoute },
  { method: 'POST', path: '/api/checks', handler: saveRoute },
  { method: 'POST', path: '/api/checks/run', handler: runRoute },
];

// GET /api/checks?project=ID. A project id that is not known is refused by projectById.
function getRoute({ res, url, json, projectById, httpError }) {
  const id = url.searchParams.get('project');
  if (!id) throw httpError(400, 'Choose a project first.');
  return json(res, 200, checkSettingsOf(projectById(id)));
}

// POST /api/checks. The check is stored beside the spend record, never in project.settings, so the Project settings save cannot drop it.
async function saveRoute({ req, res, readBody, json, httpError, store, projectById }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the check settings.');
  const project = projectById(body.project);
  let next;
  try {
    next = normalizeChecks(body, project);
  } catch (err) {
    throw httpError(400, err.message);
  }
  if (next) project.checks = next;
  else delete project.checks;
  await store.saveOrFail();
  return json(res, 200, checkSettingsOf(project));
}

// POST /api/checks/run: one run, kept on the newest reply. The events are the same ones the turn hook sends (lib/checks.mjs runAndRecord).
async function runRoute({ req, res, readBody, httpError, store, projectById, streamForProject }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id.');
  const project = projectById(body.project);
  if (chatModeOf(project) === 'plan') throw httpError(409, 'This project is in plan mode, so Plenum will not run commands. Turn plan mode off first.');
  const cfg = checksOf(project);
  if (!cfg) throw httpError(400, 'Set a check command in Project settings first.');
  // The newest reply of the thread the press is in (each thread has its own chat); Main's scope id is the project's.
  const scope = scopeFor(store, project, typeof body.thread === 'string' ? body.thread : undefined);
  const reply = lastChatReply(store, scope.id);
  if (!reply) throw httpError(400, 'Send a message first. The check result is kept on the newest reply.');
  return streamForProject(req, res, project, async ({ signal }) => runEvents({ store, project, cfg, root: scope.root, signal, reply }), undefined, { kind: 'check' });
}

// The run as the events the stream sends, in order.
async function* runEvents({ store, project, cfg, root, signal, reply }) {
  const got = await runAndRecord({ project, cfg, root, signal, reply, store });
  for (const ev of got.events) yield ev;
}
