// Saved prompts: named templates that the composer sends in place of /name. They are kept in one file in the Plenum
// state folder, apart from state.json, keyed by project id. The file is written the way lib/store.mjs writes state:
// a temp file renamed into place, one write at a time. The routes are in lib/routes/prompts.mjs.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from './store.mjs';
import { publishState } from './events.mjs';

export const NAME_MAX = 32;
export const TEMPLATE_MAX = 4000;
export const DESCRIPTION_MAX = 200;
// Every occurrence of this in a template is replaced by the text typed after the command.
export const ARGUMENTS = '$ARGUMENTS';
const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

// Built-in command names: the palette list in public/app.js (its names and aliases), plus the commands runCommand answers
// that the palette does not list (computer, and the aliases limits and login). A saved prompt with one of these names would
// take the built-in's place, so the names are refused. Keep this list in step with public/app.js: the tests check that
// every name and alias in its COMMANDS array is here.
export const BUILT_IN_COMMANDS = [
  'help', 'commands', 'model', 'models', 'advisor', 'review', 'approvals', 'effort', 'plan', 'focus', 'ask', 'council', 'build', 'agents',
  'relay', 'rules', 'add', 'project', 'switch', 'remove', 'forget', 'usage', 'limits', 'compact', 'clear', 'reset', 'cancel', 'stop',
  'theme', 'settings', 'music', 'legal', 'accounts', 'login', 'keys', 'gemini', 'updates', 'status', 'computer',
];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// An error that carries the HTTP status the route answers with. The message is plain text for the panel to show.
export class PromptError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PromptError';
    this.status = status;
  }
}

// Checks one saved prompt and returns it in the stored shape. A bad value throws a PromptError with status 400.
export function validatePrompt(input) {
  if (!isObject(input)) throw new PromptError(400, 'A saved prompt needs a name and a template.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME_PATTERN.test(name)) {
    throw new PromptError(400, `The name must be 1 to ${NAME_MAX} lowercase letters, digits or hyphens, such as pr-review.`);
  }
  if (BUILT_IN_COMMANDS.includes(name)) throw new PromptError(400, `/${name} is a built-in command. Pick another name.`);
  const template = input.template;
  if (typeof template !== 'string' || template.trim() === '') throw new PromptError(400, 'The template is empty. Write the text to send.');
  if (template.length > TEMPLATE_MAX) throw new PromptError(400, `The template is ${template.length} characters. The limit is ${TEMPLATE_MAX}.`);
  const raw = input.description ?? '';
  if (typeof raw !== 'string') throw new PromptError(400, 'The description must be text.');
  const description = raw.trim();
  if (description.length > DESCRIPTION_MAX) throw new PromptError(400, `The description is ${description.length} characters. The limit is ${DESCRIPTION_MAX}.`);
  return { name, template, description };
}

// The text a saved prompt sends. Each $ARGUMENTS becomes the text typed after the name. The split and join keep any $ in
// that text as typed. A template with no placeholder gets the typed text after it, so nothing typed is dropped.
export function expandPrompt(template, typed = '') {
  const args = String(typed ?? '').trim();
  if (!template.includes(ARGUMENTS)) return args ? `${template}\n\n${args}` : template;
  return template.split(ARGUMENTS).join(args);
}

// The file holds every project's list: { "<project id>": [ { name, template, description }, ... ] }.
export function promptsFile(home = HOME) {
  return path.join(home, 'prompts.json');
}

// Reads and writes run one at a time, so a save and a delete can never overwrite each other.
let queue = Promise.resolve();
function queued(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// A damaged file (not a JSON object) is never replaced, so its contents are kept: it is renamed to prompts.json.corrupt-<time>
// (the way lib/store.mjs keeps a damaged state.json), the list reads as empty, and the page shows a notice from
// promptsHealth(). If the rename fails the file stays where it is and the call is refused with a 500, so a save cannot
// throw its contents away.
let health = null;

// What the last recovery did, or null. { corruptFile, at, home }. The store-health route reads it and clearPromptsHealth() acknowledges it.
export function promptsHealth() {
  return health ? { ...health } : null;
}

export function clearPromptsHealth() {
  health = null;
}

async function setAside(file) {
  const corruptFile = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await fs.rename(file, corruptFile);
  } catch {
    throw new PromptError(500, 'The saved prompts file is not valid, so nothing was changed. Move prompts.json out of the state folder, then try again.');
  }
  health = { corruptFile, at: new Date().toISOString(), home: path.dirname(file) };
  console.error(`Saved prompts: ${path.basename(file)} was not valid and was kept as ${path.basename(corruptFile)}.`);
  // Every open window gets the state now, which carries promptsHealth, so the person is told when it happens (server.mjs publicState).
  publishState('prompts');
  return {};
}

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
  if (!isObject(data)) return setAside(file);
  return data;
}

async function writeAll(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// One project's list as stored, entries and all. A project with nothing saved has none, so the answer is an empty array.
// Saves and deletes work on this list, so an entry that a person broke by hand is kept, not dropped by someone else's save.
function rawListOf(data, projectId) {
  return Object.hasOwn(data, projectId) && Array.isArray(data[projectId]) ? data[projectId] : [];
}

// The entries the page may show: an object with a text name and a text template. Anything else is left out, so a
// hand-broken entry cannot reach the composer (expandPrompt would throw on it).
function usable(list) {
  return list.filter(p => isObject(p) && typeof p.name === 'string' && typeof p.template === 'string');
}

// defineProperty, so an id such as "__proto__" is stored as an ordinary key and does not change the object's prototype.
function setList(data, projectId, list) {
  Object.defineProperty(data, projectId, { value: list, enumerable: true, writable: true, configurable: true });
}

// The saved prompts for one project, in the order they were saved.
export function listPrompts(projectId, file = promptsFile()) {
  return queued(async () => usable(rawListOf(await readAll(file), projectId)));
}

// Saves a prompt. A prompt with the same name is replaced where it sits, and a new name goes on the end.
// Returns the project's list after the save.
export async function savePrompt(projectId, input, file = promptsFile()) {
  const prompt = validatePrompt(input);
  return queued(async () => {
    const data = await readAll(file);
    const list = [...rawListOf(data, projectId)];
    const at = list.findIndex(p => isObject(p) && p.name === prompt.name);
    if (at >= 0) list[at] = prompt;
    else list.push(prompt);
    setList(data, projectId, list);
    await writeAll(file, data);
    return usable(list);
  });
}

// Saves several prompts in one write, in order, the way savePrompt saves one: a name already saved, or saved earlier in the
// same batch, is replaced where it sits, and a new name goes on the end. An import uses this, so a large file is written once.
// Returns the project's list after the save.
export async function savePrompts(projectId, inputs, file = promptsFile()) {
  const prompts = inputs.map(validatePrompt);
  return queued(async () => {
    const data = await readAll(file);
    const list = [...rawListOf(data, projectId)];
    for (const prompt of prompts) {
      const at = list.findIndex(p => isObject(p) && p.name === prompt.name);
      if (at >= 0) list[at] = prompt;
      else list.push(prompt);
    }
    setList(data, projectId, list);
    await writeAll(file, data);
    return usable(list);
  });
}

// Deletes a prompt by name. Returns the project's list after the delete. An unknown name throws a PromptError with status 404.
export async function deletePrompt(projectId, name, file = promptsFile()) {
  const key = typeof name === 'string' ? name.trim() : '';
  return queued(async () => {
    const data = await readAll(file);
    const list = rawListOf(data, projectId);
    const kept = list.filter(p => !(isObject(p) && p.name === key));
    if (kept.length === list.length) throw new PromptError(404, 'There is no saved prompt with that name.');
    setList(data, projectId, kept);
    await writeAll(file, data);
    return usable(kept);
  });
}
