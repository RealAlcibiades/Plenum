// Saved prompts routes: list, save and delete, per project. The storage and the checks are in lib/prompts.mjs.
// The server checks X-Muse-Console on every POST before these handlers run, as it does for the other routes.
import { PromptError, deletePrompt, listPrompts, savePrompt } from '../prompts.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'GET', path: '/api/prompts', handler: listRoute },
  { method: 'POST', path: '/api/prompts', handler: saveRoute },
  { method: 'POST', path: '/api/prompts/delete', handler: deleteRoute },
];

// Runs one storage call. A PromptError keeps its status and message. Anything else is logged and answered with a plain
// line, so a file path from the system never reaches the panel.
async function run(task, httpError) {
  try {
    return await task();
  } catch (err) {
    if (err instanceof PromptError) throw httpError(err.status, err.message);
    console.error('Saved prompts:', err.message);
    throw httpError(500, 'Plenum could not read or save the saved prompts. Try again.');
  }
}

// GET /api/prompts?project=ID. A project id that is not known is refused by projectById.
async function listRoute({ res, url, json, projectById, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const prompts = await run(() => listPrompts(project.id), httpError);
  return json(res, 200, { prompts });
}

// POST /api/prompts with { project, prompt: { name, template, description } }. A prompt with the same name is replaced.
async function saveRoute({ req, res, readBody, json, projectById, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the prompt.');
  const project = projectById(body.project);
  const prompts = await run(() => savePrompt(project.id, body.prompt), httpError);
  return json(res, 200, { prompts });
}

// POST /api/prompts/delete with { project, name }.
async function deleteRoute({ req, res, readBody, json, projectById, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the prompt name.');
  const project = projectById(body.project);
  const prompts = await run(() => deletePrompt(project.id, body.name), httpError);
  return json(res, 200, { prompts });
}
