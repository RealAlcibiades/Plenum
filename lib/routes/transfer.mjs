// Export and import of saved prompts and pipelines, one JSON file per project. The storage and the checks are in
// lib/prompts.mjs and lib/pipelines.mjs. An import is checked entry by entry before anything is saved, and nothing in a
// file is ever run. The panels call these routes from public/ext-prompts.js and public/ext-pipelines.js. The server checks
// X-Muse-Console on every POST before these handlers run, as it does for the other routes.
import { PromptError, listPrompts, savePrompt, validatePrompt } from '../prompts.mjs';
import { PipelineError, listPipelines, savePipeline, validatePipeline } from '../pipelines.mjs';

// The most entries one import takes. A longer list is refused before anything is saved.
const MAX_ENTRIES = 200;
// The longest name part of a download's file name.
const NAME_PART_MAX = 40;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'GET', path: '/api/prompts/export', handler: exportPromptsRoute },
  { method: 'POST', path: '/api/prompts/import', handler: importPromptsRoute },
  { method: 'GET', path: '/api/pipelines/export', handler: exportPipelinesRoute },
  { method: 'POST', path: '/api/pipelines/import', handler: importPipelinesRoute },
];

// Runs one storage call. A PromptError or PipelineError keeps its status and message. Anything else is logged and answered
// with a plain line, so a file path from the system never reaches the panel.
async function run(task, httpError, label) {
  try {
    return await task();
  } catch (err) {
    if (err instanceof PromptError || err instanceof PipelineError) throw httpError(err.status, err.message);
    console.error(`Transfer of ${label}:`, err.message);
    throw httpError(500, `Plenum could not read or save the ${label}. Try again.`);
  }
}

// The project name as a file name part: letters, digits, hyphens and underscores only, at most 40 characters.
// A name with none of them left is written as "project".
export function safeName(name) {
  const kept = String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, NAME_PART_MAX);
  return kept || 'project';
}

// The download. The name and the body are plain text, and nosniff stops a browser from reading it as another type.
function sendExport(res, filename, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'x-content-type-options': 'nosniff',
  });
  return res.end(JSON.stringify(body, null, 2));
}

// The entries of an import: a list of 1 to MAX_ENTRIES. Each entry goes through check before anything is saved, and a bad
// one is refused with its place in the list, so the user can find it in the file. Returns the checked entries in order.
function checkEntries(list, check, noun, httpError) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ENTRIES) {
    const count = Array.isArray(list) ? ` This file has ${list.length}.` : '';
    throw httpError(400, `An import needs 1 to ${MAX_ENTRIES} ${noun}.${count}`);
  }
  return list.map((entry, i) => {
    try {
      return check(entry);
    } catch (err) {
      if (err instanceof PromptError || err instanceof PipelineError) throw httpError(400, `Entry ${i + 1}: ${err.message}`);
      throw err;
    }
  });
}

// Saves each checked entry in order. A name that is already saved, or that an earlier entry of this file saved, is
// replaced by the save, so it counts as replaced. Returns how many were added and how many were replaced.
async function saveEach(items, existing, save) {
  const names = new Set(existing.map(p => p.name));
  let added = 0;
  let replaced = 0;
  for (const item of items) {
    if (names.has(item.name)) replaced++;
    else {
      added++;
      names.add(item.name);
    }
    await save(item);
  }
  return { added, replaced };
}

// GET /api/prompts/export?project=ID. The file holds every saved prompt of the project, and nothing else.
async function exportPromptsRoute({ res, url, projectById, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const prompts = await run(() => listPrompts(project.id), httpError, 'saved prompts');
  return sendExport(res, `plenum-prompts-${safeName(project.name)}.json`, {
    kind: 'plenum-prompts',
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts,
  });
}

// POST /api/prompts/import with { project, prompts }. Every entry is checked first; one bad entry refuses the whole file.
async function importPromptsRoute({ req, res, readBody, json, projectById, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the prompts.');
  const project = projectById(body.project);
  const checked = checkEntries(body.prompts, validatePrompt, 'saved prompts', httpError);
  const before = await run(() => listPrompts(project.id), httpError, 'saved prompts');
  const { added, replaced } = await run(() => saveEach(checked, before, item => savePrompt(project.id, item)), httpError, 'saved prompts');
  const prompts = await run(() => listPrompts(project.id), httpError, 'saved prompts');
  return json(res, 200, { added, replaced, prompts });
}

// GET /api/pipelines/export?project=ID. The same as the prompts export, for the pipelines of the project.
async function exportPipelinesRoute({ res, url, projectById, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const pipelines = await run(() => listPipelines(project.id), httpError, 'pipelines');
  return sendExport(res, `plenum-pipelines-${safeName(project.name)}.json`, {
    kind: 'plenum-pipelines',
    version: 1,
    exportedAt: new Date().toISOString(),
    pipelines,
  });
}

// POST /api/pipelines/import with { project, pipelines }. Every entry is checked first; nothing in the file is run.
async function importPipelinesRoute({ req, res, readBody, json, projectById, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the pipelines.');
  const project = projectById(body.project);
  const checked = checkEntries(body.pipelines, validatePipeline, 'pipelines', httpError);
  const before = await run(() => listPipelines(project.id), httpError, 'pipelines');
  const { added, replaced } = await run(() => saveEach(checked, before, item => savePipeline(project.id, item)), httpError, 'pipelines');
  const pipelines = await run(() => listPipelines(project.id), httpError, 'pipelines');
  return json(res, 200, { added, replaced, pipelines });
}
