// Registry shape. lib/tools.mjs is the engine; each model tool lives in one file here.
// Every lib/tools/NN-name.mjs (NN two digits, name lowercase letters, digits and hyphens) is loaded by loadTools() in
// file-name order, and exports `tools`, an array of entries:
//   {
//     name: string,                     // lowercase letters, digits and underscores, starting with a letter
//     description: string,
//     input_schema: object,             // the Anthropic shape; lib/openai-compat.mjs converts it
//     run(input, ctx, stamp) -> { ok, summary, output, denied? },
//     plan?(input, ctx) -> card | null, // a card { summary, detail, fullDetail?, defaultDeny?, blocked? } asks for approval
//                                       // unless ctx.mode is 'auto' or 'all' (a scoped:'write' tool whose path is outside the
//                                       // project still asks in 'auto'; runTool decides that from input.path, not from the card)
//     describe?(input) -> string,       // one line for the step row (default: the name)
//     command?(input) -> string,        // the shell text the deny list checks (run_command); a hit always asks, Deny first
//     stamped?: true,                   // the card is fingerprint-stamped and run refuses a file that changed since
//     scoped?: 'off' | 'refuse' | 'write', // what a delegated coder (ctx.scope) gets: 'off' = not offered and refused with
//                                       // refusal if called; 'refuse' = offered but refused with refusal; 'write' = offered and
//                                       // limited to the task's scope; undefined = allowed
//     refusal?: string,                 // the text for 'off' and 'refuse'
//     when?(ctx) -> boolean,            // offered only when true (for example ctx.computer or ctx.browser)
//   }
// or a raw entry { raw: object, when? }: the object is sent to the model exactly as given (a computer toolset, say). A raw
// entry has no name, plan or run, is never offered to a delegated coder, and is skipped by describeCall.
// The approval, scope, stamp, checkpoint and deny-list rules are applied by runTool (lib/tools.mjs), never by a tool file.
// Names in a tool file's exports are checked by registerTools: a duplicate name is refused.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkpointFile, assertUnchanged, clip, display, editPlanDetail, fingerprint, resolveTarget, sha256 } from '../tools.mjs';
import { replaceText, writeDetail } from '../diff.mjs';

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '__pycache__']);
const MAX_READ = 2_000_000;
const MAX_SEARCH_FILE = 1_000_000;
const MAX_HITS = 100;

// ---------- helpers ----------

// Writes the content to a sibling temp file, then renames it over the target, so a half-written file is never left in place.
// B-88: a failed write or rename removes its temp file, so nothing is left in the project; the original error is still thrown.
async function writeAtomic(abs, content) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// True when the file already holds exactly these bytes.
async function holds(abs, bytes) {
  try {
    const st = await fs.stat(abs);
    return st.isFile() && st.size === bytes.length && (await fs.readFile(abs)).equals(bytes);
  } catch {
    return false;
  }
}

// For read-type tools: a plan (so approval is asked) only when the path is outside the project.
async function planOutside(verb, input, ctx) {
  const t = await resolveTarget(ctx.root, input.path ?? '.');
  if (!t.outside) return null;
  return {
    summary: `${verb} outside the project: ${t.realTarget}`,
    detail: 'This path is not in the project folder. Approve only if you want Claude to look at it.',
  };
}

// ---------- read-only tools ----------

async function listDir(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path ?? '.');
  const entries = await fs.readdir(t.realTarget, { withFileTypes: true });
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const shown = entries.slice(0, 400).map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  const more = entries.length > 400 ? `\n…${entries.length - 400} more` : '';
  return { ok: true, summary: `${entries.length} entries in ${display(t)}`, output: `${display(t)}/\n${shown.join('\n')}${more}` };
}

async function readFileTool(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path);
  const st = await fs.stat(t.realTarget);
  if (!st.isFile()) throw new Error(`${display(t)} is not a file.`);
  if (st.size > MAX_READ) throw new Error(`${display(t)} is ${st.size} bytes, over the ${MAX_READ} byte read limit. Use search_text to find the part you need.`);
  const text = await fs.readFile(t.realTarget, 'utf8');
  if (text.includes('\u0000')) throw new Error(`${display(t)} looks like a binary file.`);
  const lines = text.split('\n');
  const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
  const limit = Math.min(2000, Math.max(1, Math.floor(Number(input.limit) || 400)));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l}`).join('\n');
  const rest = lines.length - (offset - 1 + slice.length);
  const more = rest > 0 ? `\n…${rest} more lines. Call again with offset=${offset + slice.length}.` : '';
  return {
    ok: true,
    summary: `Read ${display(t)}, lines ${offset}-${offset + slice.length - 1} of ${lines.length}`,
    output: clip(`${numbered}${more}`),
  };
}

async function searchText(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path ?? '.');
  const pattern = String(input.pattern ?? '');
  if (!pattern) throw new Error('Give a pattern to search for.');
  const re = input.regex ? new RegExp(pattern) : null;
  const base = t.outside ? t.realTarget : t.realRoot;
  const hits = [];
  const walk = async dir => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (hits.length >= MAX_HITS) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const st = await fs.stat(full).catch(() => null);
        if (!st || st.size > MAX_SEARCH_FILE) continue;
        const text = await fs.readFile(full, 'utf8').catch(() => '');
        if (text.includes('\u0000')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
          const hit = re ? re.test(lines[i]) : lines[i].includes(pattern);
          if (hit) hits.push(`${path.relative(base, full).split(path.sep).join('/')}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
  };
  await walk(t.realTarget);
  return {
    ok: true,
    summary: `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${pattern.slice(0, 60)}" in ${display(t)}`,
    output: hits.length ? hits.join('\n') : 'No matches.',
  };
}

// ---------- tools that need approval ----------

async function planWrite(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  const content = String(input.content ?? '');
  const bytes = Buffer.byteLength(content);
  return { summary: `Write ${display(t)} (${bytes} bytes)`, detail: await writeDetail(t.realTarget, content, display(t)) };
}

// stamp (set when a card was shown) is what the file held then. If it holds something else now, nothing is written.
async function runWrite(input, ctx, stamp) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  const content = String(input.content ?? '');
  if (stamp) assertUnchanged(stamp, t.realTarget, await fingerprint(t.realTarget));
  // A write that leaves the file as it is changes nothing, so it needs no checkpoint.
  if (!(await holds(t.realTarget, Buffer.from(content)))) {
    await checkpointFile({ projectId: ctx.projectId, projectPath: ctx.root, absPath: t.realTarget, label: `Write ${t.rel}` });
  }
  await writeAtomic(t.realTarget, content);
  return { ok: true, summary: `Wrote ${display(t)}`, output: `Wrote ${Buffer.byteLength(content)} bytes to ${display(t)}.` };
}

async function planEdit(input, ctx) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  const oldS = String(input.old_string ?? '');
  const newS = String(input.new_string ?? '');
  if (!oldS) throw new Error('old_string must not be empty.');
  if (oldS === newS) throw new Error('old_string and new_string are identical; nothing to change.');
  const text = await fs.readFile(t.realTarget, 'utf8').catch(() => {
    throw new Error(`${display(t)} does not exist. Use write_file to create it.`);
  });
  const count = text.split(oldS).length - 1;
  if (count === 0) throw new Error(`old_string was not found in ${display(t)}. Read the file again and copy the text exactly.`);
  if (count > 1 && !input.replace_all) {
    throw new Error(`old_string matches ${count} times in ${display(t)}. Add surrounding lines to make it unique, or set replace_all.`);
  }
  // The card shows the file before and after the same replacement that runEdit makes.
  const updated = replaceText(text, oldS, newS, !!input.replace_all).updated;
  return {
    summary: `Edit ${display(t)} (${count} replacement${count > 1 ? 's' : ''})`,
    ...editPlanDetail(text, updated, display(t)),
  };
}

// The edit is made on the bytes that are compared with the stamp, so it cannot land on a newer version of the file.
async function runEdit(input, ctx, stamp) {
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  const oldS = String(input.old_string);
  const newS = String(input.new_string);
  let raw = null;
  try {
    raw = await fs.readFile(t.realTarget);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stamp) assertUnchanged(stamp, t.realTarget, raw ? sha256(raw) : 'absent');
  if (!raw) throw new Error(`${display(t)} does not exist. Use write_file to create it.`);
  const { updated, count } = replaceText(raw.toString('utf8'), oldS, newS, !!input.replace_all);
  // Without a stamp (auto mode) the file may still have changed since the plan, so a missing match is an error, not a silent no-op.
  if (!count) throw new Error(`old_string was not found in ${display(t)}. Read the file again and copy the text exactly.`);
  await checkpointFile({ projectId: ctx.projectId, projectPath: ctx.root, absPath: t.realTarget, label: `Edit ${t.rel}` });
  await writeAtomic(t.realTarget, updated);
  return { ok: true, summary: `Edited ${display(t)}`, output: `Replaced ${count} occurrence${count > 1 ? 's' : ''} in ${display(t)}.` };
}

export const tools = [
  {
    name: 'list_dir',
    description: 'List the files and folders in a directory. Relative paths start at the project folder; absolute paths (for example C:\\Users\\name\\Documents) work too. Folders end with /.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory. Default "." (the project folder).' } },
      additionalProperties: false,
    },
    describe: input => input.path || '.',
    plan: (i, c) => planOutside('List folder', i, c),
    run: listDir,
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers. Accepts relative or absolute paths. Use offset and limit to page through long files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project folder or absolute.' },
        offset: { type: 'integer', description: '1-based line to start at. Default 1.' },
        limit: { type: 'integer', description: 'Maximum lines to return. Default 400, maximum 2000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    describe: input => String(input.path ?? ''),
    plan: (i, c) => planOutside('Read', i, c),
    run: readFileTool,
  },
  {
    name: 'search_text',
    description: 'Search text files under a directory for a pattern. Returns up to 100 matches as path:line: text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search. Default "." (the project folder).' },
        regex: { type: 'boolean', description: 'Treat pattern as a JavaScript regular expression. Default false.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    describe: input => `"${clip(String(input.pattern ?? ''), 80)}" in ${input.path || '.'}`,
    plan: (i, c) => planOutside('Search in', i, c),
    run: searchText,
  },
  {
    name: 'write_file',
    description: 'Create a file or overwrite it with the full content. Relative or absolute path. Needs user approval unless approvals are on auto.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    stamped: true,
    scoped: 'write',
    describe: input => String(input.path ?? ''),
    plan: planWrite,
    run: runWrite,
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in an existing file. Relative or absolute path. old_string must match exactly once unless replace_all is true. Needs user approval unless approvals are on auto.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace, including whitespace.' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every match. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    stamped: true,
    scoped: 'write',
    describe: input => String(input.path ?? ''),
    plan: planEdit,
    run: runEdit,
  },
];
