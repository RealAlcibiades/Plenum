// Ordered model-to-model pipelines: list, save, delete, run and keep, per project. The storage, the checks and the run are in
// lib/pipelines.mjs. The server checks X-Muse-Console on every POST before these handlers run, as it does for the other routes.
// A run is read-only (see runPipeline), and it is started through streamForProject, so a busy project is refused with 409
// and /api/cancel stops it by the same abort path a chat turn uses. See lib/routes/index.mjs.
import { PipelineError, checkMessage, checkRef, deletePipeline, getPipeline, listPipelines, runPipeline, savePipeline } from '../pipelines.mjs';
import { forgetSession as forgetNativeSession } from '../sessions.mjs';

// The longest reply Keep will write to the chat. The server checks it, so a client cannot write more.
const MAX_REPLY = 200_000;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'GET', path: '/api/pipelines', handler: listRoute },
  { method: 'POST', path: '/api/pipelines', handler: saveRoute },
  { method: 'POST', path: '/api/pipelines/delete', handler: deleteRoute },
  { method: 'POST', path: '/api/pipelines/run', handler: runRoute },
  { method: 'POST', path: '/api/pipelines/keep', handler: keepRoute },
];

// Runs one storage call. A PipelineError keeps its status and message. Anything else is logged and answered with a plain
// line, so a file path from the system never reaches the panel.
async function guarded(task, httpError) {
  try {
    return await task();
  } catch (err) {
    if (err instanceof PipelineError) throw httpError(err.status, err.message);
    console.error('Pipelines:', err.message);
    throw httpError(500, 'Plenum could not read or save the pipelines. Try again.');
  }
}

// GET /api/pipelines?project=ID. A project id that is not known is refused by projectById.
async function listRoute({ res, url, json, projectById, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const pipelines = await guarded(() => listPipelines(project.id), httpError);
  return json(res, 200, { pipelines });
}

// POST /api/pipelines with { project, pipeline: { name, steps } }. A pipeline with the same name is replaced.
async function saveRoute({ req, res, readBody, json, projectById, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the pipeline.');
  const project = projectById(body.project);
  const pipelines = await guarded(() => savePipeline(project.id, body.pipeline), httpError);
  return json(res, 200, { pipelines });
}

// POST /api/pipelines/delete with { project, name }.
async function deleteRoute({ req, res, readBody, json, projectById, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the pipeline name.');
  const project = projectById(body.project);
  const pipelines = await guarded(() => deletePipeline(project.id, body.name), httpError);
  return json(res, 200, { pipelines });
}

// POST /api/pipelines/run with { project, name, message }. Streams a step-start event, a delta event for each piece of text
// and a step-done event for every step it runs, then the server's own final done event. Nothing is written to the chat.
async function runRoute({ req, res, readBody, httpError, projectById, running, streamForProject }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id, the pipeline name and the message.');
  const project = projectById(body.project);
  // Like a chat turn, a run on a busy project is refused before anything is read. streamForProject checks again.
  if (running?.has(project.id)) throw httpError(409, 'This project is already running. Use /cancel first.');
  const { message, pipeline } = await guarded(async () => ({ message: checkMessage(body.message), pipeline: await getPipeline(project.id, body.name) }), httpError);
  return streamForProject(req, res, project, async ({ signal }) => runPipeline({ pipeline, input: message, signal }));
}

// POST /api/pipelines/keep with { project, prompt, model, text }. Writes the message and the final reply to the chat, in the
// shape a chat turn writes them, then forgets the model's native session, which never saw that exchange. The next turn
// rebuilds it from the chat. This is what Keep does for a quick compare (lib/routes/compare.mjs).
async function keepRoute({ req, res, readBody, httpError, store, projectById, running, publicState, json, forgetSession = forgetNativeSession }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id, the message, the model and the reply.');
  const project = projectById(body.project);
  // Like the other writes to a chat, it waits until the project is idle, so the kept turn cannot land in the middle of a reply.
  if (running?.has(project.id)) throw httpError(409, 'This project is busy. Use /cancel first.');
  let prompt;
  let ref;
  try {
    prompt = checkMessage(body.prompt);
    ref = checkRef(body.model);
  } catch (err) {
    throw httpError(err.status ?? 400, err.message);
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) throw httpError(400, 'That reply is empty, so there is nothing to keep.');
  if (text.length > MAX_REPLY) throw httpError(400, `The reply is ${text.length.toLocaleString('en-US')} characters. The limit is ${MAX_REPLY.toLocaleString('en-US')}, so it cannot be kept.`);
  store.addMessage(project.id, { role: 'user', kind: 'chat', content: prompt, attached: [] });
  store.addMessage(project.id, { role: 'assistant', kind: 'chat', model: ref, content: text });
  await store.persist();
  // Only after the transcript is saved. Without this, a native session would resume a CLI session that lacks the kept exchange.
  forgetSession(project.id, ref);
  return json(res, 200, publicState());
}
