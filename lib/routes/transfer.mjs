// Export and import of saved prompts and pipelines, one JSON file per project. The storage and the checks are in
// lib/prompts.mjs and lib/pipelines.mjs. An import is checked entry by entry before anything is saved, and nothing in a
// file is ever run. The panels call these routes from public/ext-prompts.js and public/ext-pipelines.js. The server checks
// X-Muse-Console on every POST before these handlers run, as it does for the other routes.
//
// Threads (pro-01): GET /api/project/export?project=ID writes the project's threads list and each thread's chat into one file
// ({ kind: 'plenum-project', version: 1, threads, chats }), and POST /api/project/import { project, data } adds those threads to a project
// as new threads: their ids are made again for the target project (`${target id}-t${6 hex}`), names that are taken get a number, nothing
// existing is replaced, and a thread that would be over the limit of 8 open ones is added closed. A message is rebuilt from known fields
// on the way in and out, field by field (cleanMessage): the provider's blocks (api), snapshot references (snap) and computer-run records
// never travel in a file, a council or build card travels as the plain text of its reply, and a usage figure keeps only its numbers.
import { PromptError, listPrompts, savePrompt, validatePrompt } from '../prompts.mjs';
import { PipelineError, listPipelines, savePipeline, validatePipeline } from '../pipelines.mjs';
import { parseRef } from '../providers.mjs';
import { MAX_CLOSED, MAX_OPEN, NAME_MAX, checkName, closedThreads, ensureThreads, newThreadId, openThreads, threadsOf, threadsOff, OFF_TITLE } from '../threads.mjs';

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
  { method: 'GET', path: '/api/project/export', handler: exportProjectRoute },
  { method: 'POST', path: '/api/project/import', handler: importProjectRoute },
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

// ---------- threads: the project file ----------

const MAX_FILE_THREADS = 40;
const MAX_FILE_MESSAGES = 300;
const MAX_CONTENT = 400_000;
const KINDS = new Set(['chat', 'advisor']);
const REF = /^[a-z]+:[A-Za-z0-9._/:-]{1,160}$/;
const clipText = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const count = v => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e12) : 0);
const names = (list, n, each) => (Array.isArray(list) ? list.slice(0, n).filter(x => typeof x === 'string').map(x => x.slice(0, each)) : []);

// A reply's usage, rebuilt from the figures Plenum itself writes (lib/pricing.mjs summarizeUsage): the billing kind, whether tokens were
// reported, the token counts and the dollar figure. The record of each request (steps) is not kept. Anything else is dropped, so a file
// cannot put a shape into a reply that the totals or the cost line would trip on.
function cleanUsage(u) {
  if (!isObject(u) || (u.billing !== 'api' && u.billing !== 'plan')) return undefined;
  const out = { billing: u.billing, reported: u.reported === true };
  if (u.partial === true) out.partial = true;
  for (const key of ['input', 'cached', 'output', 'requests', 'cacheWrite']) if (u[key] !== undefined) out[key] = count(u[key]);
  if (isObject(u.cost)) {
    const cost = {};
    for (const [key, value] of Object.entries(u.cost).slice(0, 12)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9) cost[key] = value;
      else if (typeof value === 'boolean') cost[key] = value;
      else if (typeof value === 'string') cost[key] = value.slice(0, 200);
    }
    out.cost = cost;
  }
  return out;
}

// The pictures and files a message came with: names and sizes only, as the chat shows them (the bytes are never kept).
function cleanImages(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 50).filter(isObject).map(i => ({
    name: clipText(i.name, 120) || 'file',
    size: count(i.size),
    ...(typeof i.kind === 'string' ? { kind: i.kind.slice(0, 20) } : {}),
  }));
}

// One message rebuilt from the fields Plenum itself writes, field by field. Anything else in a file is left out: the provider's blocks
// (api), snapshot references (snap) and a computer run's record never come in, a council or build card comes in as its plain text (the
// verdict or the summary the reply carries), and a usage figure or a list is checked for its shape. Returns null for something that is not
// a message. Run on the way out as well, so an export holds nothing that an import would drop.
export function cleanMessage(m) {
  if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant')) return null;
  const out = { role: m.role, kind: KINDS.has(m.kind) ? m.kind : 'chat', content: clipText(m.content, MAX_CONTENT), ts: Number.isFinite(m.ts) ? m.ts : Date.now() };
  if (typeof m.model === 'string' && REF.test(m.model)) out.model = m.model;
  if (m.compact === true) out.compact = true;
  if (m.aborted === true) out.aborted = true;
  if (m.stop === 'length') out.stop = 'length';
  if (Array.isArray(m.tools)) {
    out.tools = m.tools.slice(0, 200).filter(isObject).map(t => ({ name: clipText(t.name, 80), summary: clipText(t.summary, 500), ok: t.ok !== false }));
  }
  if (Array.isArray(m.attached)) out.attached = names(m.attached, 100, 300);
  if (Array.isArray(m.context)) out.context = names(m.context, 50, 200);
  const images = cleanImages(m.images);
  if (images) out.images = images;
  const usage = m.role === 'assistant' ? cleanUsage(m.usage) : undefined;
  if (usage) out.usage = usage;
  if (isObject(m.relay)) {
    out.relay = {
      from: typeof m.relay.from === 'string' ? m.relay.from.slice(0, 40) : null,
      fromLabel: typeof m.relay.fromLabel === 'string' ? m.relay.fromLabel.slice(0, 120) : null,
      to: typeof m.relay.to === 'string' ? m.relay.to.slice(0, 40) : null,
      hop: count(m.relay.hop),
      kind: typeof m.relay.kind === 'string' ? m.relay.kind.slice(0, 20) : '',
      ...(typeof m.relay.requestTs === 'number' && Number.isFinite(m.relay.requestTs) ? { requestTs: m.relay.requestTs } : {}),
    };
  }
  return out;
}

const cleanChat = list => (Array.isArray(list) ? list.slice(-MAX_FILE_MESSAGES).map(cleanMessage).filter(Boolean) : []);

// GET /api/project/export?project=ID. The threads list (open and closed) and every thread's chat, in one JSON file.
async function exportProjectRoute({ res, url, store, projectById, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const st = store.get();
  const record = threadsOf(st, project);
  const chats = {};
  for (const t of record.list) chats[t.id] = cleanChat(st.chats?.[t.id]);
  return sendExport(res, `plenum-project-${safeName(project.name)}.json`, {
    kind: 'plenum-project',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: { name: clipText(project.name, 80) },
    threads: record.list.map(t => ({
      id: t.id, name: t.name, model: t.model ?? null, ...(t.chatMode === 'plan' ? { chatMode: 'plan' } : {}), createdAt: t.createdAt,
      ...(t.closedAt ? { closedAt: t.closedAt } : {}), ...(t.main ? { main: true } : {}),
    })),
    chats,
  });
}

// A name for an imported thread that no thread of the project has: the exported name, then "name (2)", "name (3)" and so on, kept to the
// 40-character limit.
function freeName(record, wanted) {
  const taken = new Set(record.list.map(t => t.name.toLowerCase()));
  let base = wanted;
  try {
    base = checkName(wanted);
  } catch {
    base = 'Imported';
  }
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    const name = `${[...base].slice(0, NAME_MAX - suffix.length).join('')}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `Imported ${Date.now()}`;
}

// POST /api/project/import with { project, data }. Everything is checked before anything is added. Returns what was added.
async function importProjectRoute({ req, res, readBody, json, store, projectById, httpError, publicState }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the file.');
  const project = projectById(body.project);
  const data = body.data;
  if (!isObject(data) || data.kind !== 'plenum-project' || data.version !== 1) throw httpError(400, 'That is not a Plenum project file.');
  if (!Array.isArray(data.threads) || data.threads.length < 1 || data.threads.length > MAX_FILE_THREADS || !isObject(data.chats)) {
    throw httpError(400, `A project file lists 1 to ${MAX_FILE_THREADS} threads and their chats.`);
  }
  if (threadsOff()) throw httpError(409, OFF_TITLE);
  const st = store.get();
  const record = ensureThreads(st, project);
  const list = data.threads.filter(t => isObject(t) && typeof t.id === 'string' && typeof t.name === 'string');
  if (!list.length) throw httpError(400, 'The file lists no thread.');
  // Main first, so it is the first one added; the others keep the file's order.
  list.sort((a, b) => (b.main === true) - (a.main === true));
  let open = openThreads(record).length;
  let closed = closedThreads(record).length;
  const plan = list.map(t => {
    const wantsClosed = Number.isFinite(t.closedAt);
    const closeIt = wantsClosed || open >= MAX_OPEN;
    if (closeIt) closed += 1;
    else open += 1;
    return { from: t, closed: closeIt };
  });
  if (closed > MAX_CLOSED) throw httpError(400, `This import would leave more than ${MAX_CLOSED} closed threads in the project. Remove some closed threads first.`);
  const added = [];
  for (const { from, closed: closeIt } of plan) {
    // Main's chat comes in as a thread of its own, so the project's own Main chat is never touched.
    const name = freeName(record, from.main === true ? `${clipText(from.name, 30) || 'Main'} (imported)` : from.name);
    let model = null;
    if (typeof from.model === 'string' && from.model) {
      try {
        model = parseRef(from.model);
      } catch {
        model = null;
      }
    }
    const id = newThreadId(project.id);
    const entry = { id, name, model, createdAt: Number.isFinite(from.createdAt) ? from.createdAt : Date.now() };
    if (from.chatMode === 'plan') entry.chatMode = 'plan';
    if (closeIt) entry.closedAt = Number.isFinite(from.closedAt) ? from.closedAt : Date.now();
    record.list.push(entry);
    (st.chats ??= {})[id] = cleanChat(data.chats[from.id]);
    added.push({ id, name, closed: closeIt, messages: st.chats[id].length });
  }
  await store.saveOrFail();
  return json(res, 200, { ...publicState(), imported: added });
}
