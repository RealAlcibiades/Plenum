// Pipelines: an ordered list of model steps, where each step's reply is passed to the next. A step has a model, an effort
// and a prompt template, and the template may use {input} (the user's message) and {previous} (the reply of the step before,
// empty for the first step). They are kept in one file in the Plenum state folder, apart from state.json, keyed by project id.
// The file is written the way lib/store.mjs writes state: a temp file renamed into place, one write at a time.
// A run is read-only. Every step goes through streamChat with readOnly true, no ctx (so no tools; see below for a step that may start agents), no session and an empty
// scratch folder that is deleted afterwards, so a pipeline never reaches the project folder. A Codex, Gemini or Muse Code
// step is read-only too (see streamChat).
// The routes are in lib/routes/pipelines.mjs.
//
// Agents (agent-roles). A step can be allowed to start read-only agents in Agents > Limits (the Pipeline steps row, or a per-model
// override). runPipeline is then given { project, agents, run } (or, when the route passes only the signal, finds the project by the
// signal that server.mjs registered, registerRunScope in lib/agent-run.mjs), and a step's model gets the tool context seatContext
// builds: the delegate tool alone, counted for that step. The step still has no file tool and still runs in its empty scratch folder.
// The agents' events (agent-start, agent-state, agent-done, tool, tool_result) go on the stream with `step` and `seat` set; the panel
// reads only step-start, delta, step-done and error, so it ignores them. A run that this function opened itself is closed when it ends.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, get as stateNow } from './store.mjs';
import { CATALOG, EFFORTS, labelFor, normalizeEffort, parseRef, streamChat } from './providers.mjs';
import { buildSystem } from './prompt.mjs';

export const NAME_MAX = 40;
export const MIN_STEPS = 1;
export const MAX_STEPS = 8;
export const TEMPLATE_MAX = 4000;
// The same cap as a chat turn (MAX_PROMPT in lib/providers.mjs). It applies to the message, and to each step's prompt once
// {input} and {previous} are filled in.
export const MAX_PROMPT = 150_000;
const PIPELINE_KEYS = ['name', 'steps'];
const STEP_KEYS = ['model', 'effort', 'template'];
// Said to every step. A step cannot open files, so it answers from the prompt alone.
const SYSTEM = 'This message is one step in a pipeline: several models work in turn, and your reply goes to the next model, or to the user if you are the last. You have no tools and cannot open or change any files, so answer from the message alone.';
const ABORTED = Symbol('aborted');

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// An error that carries the HTTP status the route answers with. The message is plain text for the panel to show.
export class PipelineError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PipelineError';
    this.status = status;
  }
}

// ---------- the checks ----------

function onlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PipelineError(400, `${where} has a field "${key.slice(0, 40)}" that Plenum does not know.`);
  }
}

// A model, as parseRef reads it, so a step accepts exactly what the model menus accept. parseRef does not take the form
// gemini:<id>, which the catalog and the menus use, so that one form is read from the catalog here. Returns provider:id.
export function checkRef(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Pick a model, for example anthropic:claude-sonnet-5-5.');
  let ref;
  try {
    ref = parseRef(raw);
  } catch (err) {
    const gemini = /^gemini:([a-z0-9._-]+)$/.exec(raw.trim().toLowerCase());
    if (!gemini || !CATALOG.some(c => c.provider === 'gemini' && c.id === gemini[1])) throw err;
    ref = `gemini:${gemini[1]}`;
  }
  return ref;
}

function validateStep(step, n) {
  const where = `Step ${n}`;
  if (!isObject(step)) throw new PipelineError(400, `${where} needs a model, an effort and a prompt.`);
  onlyKeys(step, STEP_KEYS, where);
  let model;
  try {
    model = checkRef(step.model);
  } catch (err) {
    throw new PipelineError(400, `${where}: ${err.message}`);
  }
  // An effort that is left out is high, as everywhere else. One that is sent must be on the list.
  const effort = step.effort === undefined ? normalizeEffort(step.effort) : String(step.effort).trim().toLowerCase();
  if (!EFFORTS.includes(effort)) throw new PipelineError(400, `${where}: effort is not one of ${EFFORTS.join(', ')}.`);
  const { template } = step;
  if (typeof template !== 'string' || template.trim() === '') throw new PipelineError(400, `${where}: the prompt is empty. Write the text to send.`);
  if (template.length > TEMPLATE_MAX) throw new PipelineError(400, `${where}: the prompt is ${template.length} characters. The limit is ${TEMPLATE_MAX}.`);
  return { model, effort, template };
}

// Checks one pipeline and returns it in the stored shape: { name, steps: [{ model, effort, template }] }.
// A bad value throws a PipelineError with status 400 and a message the panel can show.
export function validatePipeline(input) {
  if (!isObject(input)) throw new PipelineError(400, 'A pipeline needs a name and a list of steps.');
  onlyKeys(input, PIPELINE_KEYS, 'The pipeline');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > NAME_MAX) throw new PipelineError(400, `The name must be 1 to ${NAME_MAX} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new PipelineError(400, 'The name cannot hold line breaks or control characters.');
  if (!Array.isArray(input.steps) || input.steps.length < MIN_STEPS || input.steps.length > MAX_STEPS) {
    const has = Array.isArray(input.steps) ? ` this one has ${input.steps.length}` : ' send them as a list';
    throw new PipelineError(400, `A pipeline needs ${MIN_STEPS} to ${MAX_STEPS} steps;${has}.`);
  }
  return { name, steps: input.steps.map((step, i) => validateStep(step, i + 1)) };
}

// The message a run starts from: trimmed, present, and no longer than a chat turn may be.
export function checkMessage(raw) {
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (!message) throw new PipelineError(400, 'Write a message first.');
  if (message.length > MAX_PROMPT) throw new PipelineError(400, `The message is ${message.length.toLocaleString('en-US')} characters. The limit is ${MAX_PROMPT.toLocaleString('en-US')}; shorten it.`);
  return message;
}

// The prompt of one step. Every {input} and {previous} is replaced in a single pass, so a placeholder that appears inside the
// message or the earlier reply stays as it was written, and a $ in either is never read as a replacement pattern.
export function fillTemplate(template, { input = '', previous = '' } = {}) {
  const values = { input, previous };
  return template.replace(/\{(input|previous)\}/g, (_, key) => values[key]);
}

// ---------- storage ----------

// The file holds every project's list: { "<project id>": [ { name, steps }, ... ] }.
export function pipelinesFile(home = HOME) {
  return path.join(home, 'pipelines.json');
}

// Reads and writes run one at a time, so a save and a delete can never overwrite each other.
let queue = Promise.resolve();
function queued(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// A file that is not a JSON object is refused rather than replaced, because the next save would throw its contents away.
async function readAll(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!isObject(data)) {
    throw new PipelineError(500, 'The saved pipelines file is not valid, so nothing was changed. Move pipelines.json out of the state folder, then try again.');
  }
  return data;
}

async function writeAll(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// One project's list. A project with nothing saved has none, so the answer is an empty array.
function listOf(data, projectId) {
  return Object.hasOwn(data, projectId) && Array.isArray(data[projectId]) ? data[projectId] : [];
}

// defineProperty, so an id such as "__proto__" is stored as an ordinary key and does not change the object's prototype.
function setList(data, projectId, list) {
  Object.defineProperty(data, projectId, { value: list, enumerable: true, writable: true, configurable: true });
}

// The saved pipelines for one project, in the order they were saved.
export function listPipelines(projectId, file = pipelinesFile()) {
  return queued(async () => listOf(await readAll(file), projectId));
}

// One saved pipeline by name, checked again before a run, so a hand-edited file cannot start a run the checks would refuse.
// An unknown name throws a PipelineError with status 404.
export async function getPipeline(projectId, name, file = pipelinesFile()) {
  const key = typeof name === 'string' ? name.trim() : '';
  const found = (await listPipelines(projectId, file)).find(p => isObject(p) && p.name === key);
  if (!found) throw new PipelineError(404, 'There is no saved pipeline with that name.');
  try {
    return validatePipeline(found);
  } catch (err) {
    throw new PipelineError(400, `The saved pipeline "${key}" is not valid. ${err.message} Open it, fix it and save it again.`);
  }
}

// Saves a pipeline. One with the same name is replaced where it sits, and a new name goes on the end. With
// { allowReplace: false } a same name is refused with 409 instead, so a New pipeline cannot overwrite a saved one (B-14).
// Import keeps the replace behaviour, which is the default. Returns the project's list after the save.
export async function savePipeline(projectId, input, file = pipelinesFile(), { allowReplace = true } = {}) {
  const pipeline = validatePipeline(input);
  return queued(async () => {
    const data = await readAll(file);
    const list = [...listOf(data, projectId)];
    const at = list.findIndex(p => isObject(p) && p.name === pipeline.name);
    if (at >= 0 && allowReplace !== true) {
      throw new PipelineError(409, `A pipeline named "${pipeline.name}" already exists. Pick another name, or edit that pipeline.`);
    }
    if (at >= 0) list[at] = pipeline;
    else list.push(pipeline);
    setList(data, projectId, list);
    await writeAll(file, data);
    return list;
  });
}

// Deletes a pipeline by name. Returns the project's list after the delete. An unknown name throws a PipelineError with status 404.
export async function deletePipeline(projectId, name, file = pipelinesFile()) {
  const key = typeof name === 'string' ? name.trim() : '';
  return queued(async () => {
    const data = await readAll(file);
    const list = listOf(data, projectId);
    const kept = list.filter(p => !(isObject(p) && p.name === key));
    if (kept.length === list.length) throw new PipelineError(404, 'There is no saved pipeline with that name.');
    setList(data, projectId, kept);
    await writeAll(file, data);
    return kept;
  });
}

// ---------- running ----------

// The message a step shows: the provider's own words when it gave them, cut to a readable length.
function errorText(err) {
  const api = err?.error?.error?.message;
  const text = String(api ? `${api}${err.status ? ` (HTTP ${err.status})` : ''}` : err?.message ?? err).trim();
  return text.length > 800 ? `${text.slice(0, 800)}…` : text || 'Unknown error.';
}

// Iterates a stream but gives up the moment the signal fires, even if the provider is slow to notice.
async function* abortable(iterable, signal) {
  const it = iterable[Symbol.asyncIterator]();
  let onAbort;
  const gone = new Promise(resolve => {
    onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const pending = it.next();
      pending.catch(() => {}); // if the abort wins the race, a later failure of this call is not news
      const r = await Promise.race([pending, gone]);
      if (r === ABORTED || r.done) return;
      yield r.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    Promise.resolve(it.return?.()).catch(() => {});
  }
}

const removeScratch = dir => (dir ? fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}) : null);

// What the steps need to start agents: the runner's helpers, the project, its agents block and the run. lib/agent-run.mjs and
// lib/agents.mjs both import this file, so they are imported when a run needs them, never at load time. The project is the one
// given, else the one server.mjs registered for this run's signal. null when there is none: no step starts agents.
async function agentSetup({ signal, project, agents, run }) {
  try {
    const lib = await import('./agent-run.mjs');
    const proj = project ?? lib.runScopeOf(signal)?.project ?? null;
    if (!proj) return null;
    const block = agents ?? (await import('./agents.mjs')).effectiveAgents(stateNow(), proj);
    const own = run ? null : lib.openRun({ projectId: proj.id, kind: 'pipeline', signal });
    return { lib, project: proj, agents: block, run: run ?? own, own };
  } catch {
    return null;
  }
}

// Runs the steps one after another and yields their events: step-start, a delta for each piece of text, then step-done
// ({ type: 'step-done', step, ok, text, error? }). The step index starts at 0. A step that fails ends the run, and the steps
// after it never start. The server's own final done event comes from streamForProject when this generator ends.
// `stream` is streamChat. A test passes a stub in its place.
// `root` is the project folder the run belongs to (for the prompt parts); the route passes it. It is not a folder the steps can reach.
// `project`, `agents` (effectiveAgents) and `run` (openRun) let a step start read-only agents within its limits; a caller that gives
// no run has the one this function opens closed when it ends. denyPatterns, tools, mode and approve matter only for a role whose cards are on.
export async function* runPipeline({ pipeline, input, signal, stream = streamChat, root, project, agents, run, denyPatterns, tools, mode, approve }) {
  const seats = await agentSetup({ signal, project, agents, run });
  try {
    let previous = '';
    for (let i = 0; i < pipeline.steps.length; i++) {
      if (signal.aborted) return;
      const step = pipeline.steps[i];
      yield { type: 'step-start', step: i, model: step.model, label: labelFor(step.model) };
      let text = '';
      let error = '';
      let scratch = null;
      try {
        const prompt = fillTemplate(step.template, { input, previous });
        if (prompt.length > MAX_PROMPT) {
          throw new Error(`The prompt for step ${i + 1} is ${prompt.length.toLocaleString('en-US')} characters once {input} and {previous} are filled in. The limit is ${MAX_PROMPT.toLocaleString('en-US')}; shorten the template or the earlier reply.`);
        }
        // A fresh, empty folder, so a CLI model cannot reach the project. No session is passed; a ctx only when the step may start agents.
        scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-pipeline-'));
        const base = await buildSystem('pipeline', { root, readOnly: true, ref: step.model, base: [SYSTEM], extra: { step: i } });
        let sideEmit = () => {};
        const ctx = await seats?.lib.seatContextFor({ role: 'pipeline', ref: step.model, seatId: String(i), label: `Step ${i + 1}`, project: seats.project, agents: seats.agents, run: seats.run, signal, emit: ev => sideEmit({ ...ev, step: i, seat: String(i) }), effort: step.effort, readOnlyCwd: scratch, denyPatterns, tools, mode, approve });
        const system = ctx ? seats.lib.seatSystemWith(base, ctx) : base;
        const replies = stream(step.model, { system, messages: [{ role: 'user', content: prompt }], cwd: scratch, signal, effort: step.effort, readOnly: true, ...(ctx ? { ctx } : {}) });
        if (ctx) {
          for await (const ev of seats.lib.pumped(signal, async push => {
            sideEmit = push;
            for await (const delta of abortable(replies, signal)) {
              if (!delta) continue;
              text += delta;
              push({ type: 'delta', step: i, text: delta });
            }
          })) yield ev;
        } else {
          for await (const delta of abortable(replies, signal)) {
            if (!delta) continue;
            text += delta;
            yield { type: 'delta', step: i, text: delta };
          }
        }
      } catch (err) {
        if (!signal.aborted) error = errorText(err);
      } finally {
        await removeScratch(scratch);
      }
      if (signal.aborted) error = 'Stopped.';
      else if (!error && !text.trim()) error = 'The model returned no answer.';
      yield { type: 'step-done', step: i, ok: !error, text, ...(error ? { error } : {}) };
      if (error) return;
      previous = text.trim();
    }
  } finally {
    seats?.own?.close();
  }
}
