// The system prompt for every model call, built from parts. A part is one small piece of the prompt (the core line, the
// project's AGENTS.md, attached-file rules, the project file list, and later the focus, rules and delegation texts). Each
// file in lib/prompt-parts/ is named NN-name.mjs (NN two digits, name lowercase letters, digits and hyphens), is loaded by
// loadParts() in file-name order, and exports `parts`, an array of:
//   {
//     id: string,                  // 1 to 40 lower-case letters, digits or hyphens; unique across every part
//     order: number,               // parts run by order; equal orders keep file order
//     contexts: '*' | string[],    // which calls it joins; each name is in CONTEXTS
//     text: async ctx => string | null,  // the text, or null/'' for none; a throw leaves the part out (see buildSystem)
//   }
// buildSystem(context, ctx) returns the base texts first (ctx.base, the caller's own fixed text), then each matching part's
// text, joined with a blank line. Texts are not trimmed: a part's text goes into the prompt exactly as it is returned.
// Parts see ctx: root (the project folder), projectId and project when known, agent, readOnly, mode, ref, rules (the loaded
// AGENTS.md record, or null when the caller read it and found none), base, extra (context-specific) and emit.
// A part adds text only; nothing in a part approves an action, widens a folder or turns a tool on.
// Adding a part is one file in lib/prompt-parts/, with no edit here or in the callers.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as store from './store.mjs';
import { CODE_ROOT, listFiles } from './overlay.mjs';

// Every context a call can name. A part that names another one is refused at registration.
export const CONTEXTS = ['chat', 'advisor', 'compact', 'coder', 'planner', 'reviewer', 'council', 'moderator', 'relay', 'compare', 'pipeline'];
const CONTEXT_SET = new Set(CONTEXTS);

// The part files are listed through lib/overlay.mjs, so a file that an applied update adds or replaces is found too.
const PART_DIR = path.join(CODE_ROOT, 'lib', 'prompt-parts');
const PART_FILE = /^\d\d-[a-z0-9-]+\.mjs$/;
const PART_ID = /^[a-z0-9-]{1,40}$/;

// The registry, in the order the parts were registered. Each entry is checked; `seq` keeps registration order for ties.
const REGISTRY = [];
let registered = 0;

const isText = value => typeof value === 'string' && value.trim() !== '';
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Checks one part entry. Throws a plain message naming the part; nothing is added by this function.
function checkPart(entry, label) {
  const bad = why => new Error(`${label}: ${why}`);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw bad('each prompt part must be an object');
  const { id, order, contexts, text } = entry;
  if (typeof id !== 'string' || !PART_ID.test(id)) throw bad('a part id is 1 to 40 lower-case letters, digits or hyphens');
  if (typeof order !== 'number' || !Number.isFinite(order)) throw bad(`prompt part "${id}" needs a numeric order`);
  let names;
  if (contexts === '*') {
    names = '*';
  } else if (Array.isArray(contexts) && contexts.length) {
    for (const name of contexts) {
      if (!CONTEXT_SET.has(name)) throw bad(`prompt part "${id}" names an unknown context "${name}". The contexts are ${CONTEXTS.join(', ')}.`);
    }
    names = new Set(contexts);
  } else {
    throw bad(`prompt part "${id}" needs contexts: '*' or a list of context names`);
  }
  if (typeof text !== 'function') throw bad(`prompt part "${id}" needs a text function`);
  return { id, order, contexts: names, text, file: label };
}

// Adds a part file's parts to the registry. All of them are checked first, so a list with one bad entry adds nothing.
// A part id that is already registered is refused, with both files named.
export function registerParts(list, source) {
  const label = source ? path.basename(String(source)) : 'a prompt part list';
  if (!Array.isArray(list)) throw new Error(`${label} must export an array of prompt parts.`);
  const owners = new Map(REGISTRY.map(p => [p.id, p.file]));
  const items = [];
  for (const entry of list) {
    const item = checkPart(entry, label);
    if (owners.has(item.id)) throw new Error(`Prompt part "${item.id}" is defined twice (${owners.get(item.id)} and ${label}).`);
    owners.set(item.id, label);
    items.push(item);
  }
  for (const item of items) REGISTRY.push({ ...item, seq: ++registered });
}

// The part files, in file-name order. Each name matches PART_FILE. A missing folder means no parts. The paths name the install
// folder; the module hook (lib/overlay/hooks.mjs) answers an import of one with the active generation's copy.
export async function partFiles() {
  return listFiles('lib/prompt-parts', n => PART_FILE.test(n), CODE_ROOT).sort().map(n => path.join(PART_DIR, n));
}

// Imports each file and registers its `parts`. A file that does not load, has no parts array, or is refused is skipped
// with a console warning, so one bad file does not stop the prompt.
async function loadPartFiles(files) {
  for (const file of files) {
    const name = path.basename(file);
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      console.warn(`Prompt part file ${name} did not load and is skipped: ${err.message}`);
      continue;
    }
    if (!Array.isArray(mod.parts)) {
      console.warn(`Prompt part file ${name} exports no parts array, so it is skipped.`);
      continue;
    }
    try {
      registerParts(mod.parts, file);
    } catch (err) {
      console.warn(`Prompt part file ${name} was not registered: ${err.message}`);
    }
  }
}

// Loads every part file once and caches the promise. It is lazy for the same reason lib/tools.mjs is: a part file may import
// modules that import this one, so nothing is loaded at evaluation time. buildSystem and callers that need the list await it.
let loading = null;
export function loadParts() {
  loading ??= partFiles().then(loadPartFiles);
  return loading;
}

// The parts that run for a context, in the order they run. Synchronous: await loadParts() first.
function ordered(context) {
  return REGISTRY
    .filter(p => p.contexts === '*' || p.contexts.has(context))
    .sort((a, b) => a.order - b.order || compareText(a.file, b.file) || a.seq - b.seq);
}

// The ids of the parts that run for a context, in order. Synchronous: call loadParts() first, as buildSystem does.
export function partsFor(context) {
  return ordered(context).map(p => p.id);
}

// The project record whose folder is root, or null. On Windows the comparison ignores case. Never throws.
export function projectForRoot(root) {
  if (typeof root !== 'string' || !root) return null;
  const key = folderKey(root);
  let projects;
  try {
    projects = store.get().projects ?? [];
  } catch {
    return null;
  }
  return projects.find(p => typeof p?.path === 'string' && folderKey(p.path) === key) ?? null;
}

function folderKey(folder) {
  const resolved = path.resolve(folder);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Tells the caller a part was left out, when it can hear about it. A failing notice never stops the prompt.
function notify(ctx, text) {
  if (typeof ctx.emit !== 'function') return;
  try {
    ctx.emit({ type: 'notice', text });
  } catch {
    // The caller's stream is gone; the prompt still goes out without the part.
  }
}

// The system prompt for one call: ctx.base first, then every part that runs for the context, joined with a blank line.
// A part that throws is left out, with a console warning and one notice to ctx.emit naming it; the rest is intact.
// A text that is empty or only spaces adds nothing. The result is '' when neither the base nor any part has text.
export async function buildSystem(context, ctx = {}) {
  const c = ctx ?? {};
  await loadParts();
  const base = typeof c.base === 'string' ? [c.base] : (Array.isArray(c.base) ? c.base : []);
  const out = base.filter(isText);
  for (const part of ordered(context)) {
    let text;
    try {
      text = await part.text({ context, ...c });
    } catch (err) {
      const why = err?.message ?? String(err);
      console.warn(`Prompt part ${part.id} failed and was left out: ${why}`);
      notify(c, `A prompt part (${part.id}) failed and was left out: ${why}`);
      continue;
    }
    if (isText(text)) out.push(text);
  }
  return out.join('\n\n');
}
