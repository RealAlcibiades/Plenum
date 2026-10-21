import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { runShell } from './proc.mjs';
import { shellFor } from './platform/index.mjs';
import { insideRoot } from './files.mjs';
import { checkAccess } from './guard.mjs';
import { capDetail, replaceText, unifiedDiff, writeDetail } from './diff.mjs';
import { runTask } from './delegate.mjs';
import { snapshotBeforeWrite } from './checkpoints.mjs';
import { checkCommand } from './denylist.mjs';

// Tools the Claude agent can call. Paths are relative to the project folder, or absolute.
// A path outside the project needs the user's approval (shown as a card), like an edit does.
// Credential folders and system folders are never allowed (see guard.mjs).
// Tools with a `plan` ask for approval unless approvals are set to auto; the plan is shown first.
// run_command uses the platform's own shell (shellFor in lib/platform/index.mjs): cmd.exe on Windows, /bin/sh -c elsewhere.

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '__pycache__']);
const MAX_READ = 2_000_000;
const MAX_SEARCH_FILE = 1_000_000;
const MAX_HITS = 100;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 900;

export const clip = (s, n = 24_000) => (s.length > n ? `${s.slice(0, n)}\n…[cut at ${n} characters]` : s);

// The reason a user typed when denying an approval card: one line of plain text, at most 300 characters. It is only ever
// added to the tool result the model reads, and it never changes the answer (see /api/approve in server.mjs).
export function cleanReason(raw) {
  if (typeof raw !== 'string') return '';
  // A cut can leave half of a surrogate pair at the end, which is not valid text, so that half goes too.
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300).replace(/[\ud800-\udbff]$/, '');
}

export const TOOL_DEFS = [
  {
    name: 'list_dir',
    description: 'List the files and folders in a directory. Relative paths start at the project folder; absolute paths (for example C:\\Users\\name\\Documents) work too. Folders end with /.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory. Default "." (the project folder).' } },
      additionalProperties: false,
    },
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
  },
  {
    name: 'run_command',
    description: `Run a shell command in the project folder. ${shellFor().hint} Returns the exit code and output. Needs user approval unless approvals are on auto.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_seconds: { type: 'integer', description: 'Default 120, maximum 900.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_update',
    description: 'Send a change to Plenum itself. It becomes a pending bundle in the Updates panel, and the user applies it there (no file changes happen until then). Paths are relative to the Plenum source folder, for example lib/providers.mjs or public/app.js.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences on what changed and why.' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string', description: 'Full new content of the file.' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'delegate',
    description: 'Hand one well-defined coding task to a coder model that works only inside the scope you give. Use it for independent edits you can describe fully. The coder cannot see this chat, so put every fact it needs in instructions. Several delegate calls in one reply run in parallel, so give them scopes that do not overlap. Returns what the coder reported and the files it changed. Writes still need approval unless approvals are on auto.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the task.' },
        instructions: { type: 'string', description: 'Exactly what to change, and the facts the coder needs.' },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative files or folders the coder may change. Required. Never the whole project, and never absolute or containing "..".',
        },
        coder: {
          type: 'string',
          description: 'Optional. One of anthropic:claude-haiku-5-5 (the default), anthropic:claude-sonnet-5-5, gemini:gemini-2.5-flash, codex:default, muse:muse-spark-1.2.',
        },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional. Default high.' },
      },
      required: ['title', 'instructions', 'scope'],
      additionalProperties: false,
    },
  },
];

// A delegated coder gets no nested delegation and cannot queue Muse Console updates.
const CODER_OFF = new Set(['delegate', 'propose_update']);
// The tool list for a Claude request. Without ctx there are no tools (a plain reply).
export function toolsFor(ctx) {
  if (!ctx) return undefined;
  return ctx.scope ? TOOL_DEFS.filter(t => !CODER_OFF.has(t.name)) : TOOL_DEFS;
}

// Strict resolver for paths that must be inside the project (kept for callers that need that guarantee).
export async function resolveInRoot(root, rel, { write = false } = {}) {
  const realRoot = await fs.realpath(root);
  const raw = typeof rel === 'string' && rel.trim() ? rel.trim() : '.';
  const abs = path.resolve(realRoot, raw);
  if (!insideRoot(realRoot, abs)) throw new Error(`"${raw}" is outside the project folder.`);
  let probe = abs;
  for (;;) {
    if (await fs.lstat(probe).catch(() => null)) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = await fs.realpath(probe).catch(() => probe);
  if (!insideRoot(realRoot, real)) throw new Error(`"${raw}" resolves outside the project folder.`);
  const relFromRoot = path.relative(realRoot, abs);
  if (write && relFromRoot.split(path.sep).some(seg => seg.toLowerCase() === '.git')) {
    throw new Error('Writes inside .git are not allowed.');
  }
  return { abs, rel: relFromRoot.split(path.sep).join('/') || '.', realRoot };
}

// Resolves a path the agent was given, inside or outside the project. Symlinks are followed before the check.
export async function resolveTarget(root, rel, { write = false } = {}) {
  const realRoot = await fs.realpath(root);
  const raw = typeof rel === 'string' && rel.trim() ? rel.trim() : '.';
  const abs = path.resolve(realRoot, raw);
  let probe = abs;
  for (;;) {
    if (await fs.lstat(probe).catch(() => null)) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = await fs.realpath(probe).catch(() => probe);
  const realTarget = path.join(realProbe, path.relative(probe, abs));
  const outside = !insideRoot(realRoot, abs) || !insideRoot(realRoot, realTarget);
  checkAccess(realTarget, { write });
  if (!outside && write && path.relative(realRoot, abs).split(path.sep).some(seg => seg.toLowerCase() === '.git')) {
    throw new Error('Writes inside .git are not allowed.');
  }
  const rel2 = outside ? realTarget : (path.relative(realRoot, abs).split(path.sep).join('/') || '.');
  return { abs, realTarget, outside, realRoot, rel: rel2 };
}

const display = t => (t.outside ? `${t.realTarget} (outside the project)` : t.rel);

// ---------- scope for delegated coders ----------

const fold = p => (process.platform === 'win32' ? p.toLowerCase() : p);

// Absolute folders for project-relative scope entries (realRoot must already be a real path).
export const scopeAbs = (realRoot, rels) => rels.map(r => path.join(realRoot, ...r.split('/')));

// True when the real path is a scope entry or lies inside one.
export function scopeHas(scopes, abs) {
  const a = fold(abs);
  return scopes.some(s => {
    const b = fold(s);
    return a === b || a.startsWith(b + path.sep);
  });
}

// Checks the files and folders a delegated task may change. Returns project-relative paths ("/" separators).
// Rejects absolute paths, "..", the whole project, anything that leaves the project (after symlinks are
// followed), and anything checkAccess refuses (credential folders, Muse Console's own source, .git).
export async function normalizeScope(root, scope) {
  if (typeof scope === 'string') scope = [scope];
  if (!Array.isArray(scope)) throw new Error('Scope must be a list of files or folders in the project.');
  if (!scope.length) throw new Error('Scope is empty. Name the files or folders the task may change.');
  const realRoot = await fs.realpath(root);
  const out = [];
  for (const entry of scope) {
    const raw = typeof entry === 'string' ? entry.trim() : '';
    if (!raw) throw new Error('Scope has an empty entry. Name a file or folder in the project.');
    const slashed = raw.replace(/\\/g, '/');
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || slashed.startsWith('/')) {
      throw new Error(`Scope "${raw}" is an absolute path. Use a path relative to the project folder.`);
    }
    if (slashed.split('/').includes('..')) throw new Error(`Scope "${raw}" uses "..". Name a path inside the project folder.`);
    const rel = slashed.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!rel || rel === '.') throw new Error('Scope cannot be the whole project. Name the files or folders the task may change.');
    let t;
    try {
      t = await resolveTarget(realRoot, rel, { write: true });
    } catch (err) {
      throw new Error(`Scope "${raw}": ${err.message}`);
    }
    if (t.outside) throw new Error(`Scope "${raw}" is outside the project folder.`);
    if (!out.includes(t.rel)) out.push(t.rel);
  }
  return out;
}

// Coders cannot run commands (a command can write anywhere), delegate further, or queue Muse Console updates.
const SCOPED_REFUSED = {
  run_command: 'A delegated coder cannot run shell commands, because a command can change files outside its scope. Describe what should be checked in your summary instead.',
  delegate: 'A delegated coder cannot delegate further.',
  propose_update: 'A delegated coder cannot propose changes to Plenum.',
};
const SCOPED_WRITES = new Set(['write_file', 'edit_file']);

// Runs before any approval: a write outside the task's scope is refused here, with a message to the model.
async function scopeGate(name, input, ctx) {
  if (SCOPED_REFUSED[name]) {
    return { ok: false, denied: true, summary: 'Not allowed in this task', output: `${SCOPED_REFUSED[name]} Do not retry it.` };
  }
  if (!SCOPED_WRITES.has(name)) return null;
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  if (scopeHas(ctx.scope.abs, t.realTarget)) return null;
  return {
    ok: false,
    denied: true,
    summary: `Outside the task scope: ${display(t)}`,
    output: `This task may change only: ${ctx.scope.rel.join(', ')}. ${display(t)} is outside that, so the write was not made. Do not retry it. Change only files inside the scope, or say in your summary what else is needed.`,
  };
}

async function writeAtomic(abs, content) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, abs);
}

// ---------- the approval race, checkpoints and the command deny list ----------

const CHANGED = 'The file changed after the change was approved. Read it again and try once more.';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// What a file holds right now: the sha256 of its bytes, 'absent' when there is no file, or 'unreadable:<code>' when it
// cannot be read (a folder, no permission). Streamed, so a large file is not held in memory.
async function fingerprint(abs) {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(abs)) hash.update(chunk);
    return hash.digest('hex');
  } catch (err) {
    return err.code === 'ENOENT' ? 'absent' : `unreadable:${err.code ?? 'error'}`;
  }
}

// A write or an edit card shows a diff of the file as it is when the card is built, so the file is stamped with it:
// its path and fingerprint. The fingerprint is read before and after the card is built and the two must agree, or the
// diff and the stamp could describe different files. runWrite and runEdit compare the stamp when the approval returns.
async function planWithStamp(tool, input, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = await resolveTarget(ctx.root, input.path, { write: true });
    const before = await fingerprint(t.realTarget);
    const plan = await tool.plan(input, ctx);
    if (before === await fingerprint(t.realTarget)) return { plan, stamp: { file: t.realTarget, hash: before } };
  }
  throw new Error('The file keeps changing, so a preview of the change could not be made. Try again in a moment.');
}

// Refuses the write when the file (or the path it resolves to) is not what the approval card showed.
function assertUnchanged(stamp, file, hash) {
  if (stamp.file !== file || stamp.hash !== hash) throw new Error(CHANGED);
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

// Takes a checkpoint of a file just before an approved write changes it. snapshotBeforeWrite never throws; the catch
// is there so a checkpoint problem can never stop the write. ctx.projectId is optional (see the ctx notes at runTool).
export async function checkpointFile({ projectId, projectPath, absPath, label }) {
  try {
    return await snapshotBeforeWrite({ projectId, projectPath, absPath, label });
  } catch {
    return null;
  }
}

// A command that matches a built-in deny list rule always gets an approval card, in auto mode too, and Deny is the
// default: the card says so (defaultDeny), and a card nobody answers counts as a denial (see approvalRequester in
// server.mjs). Returns null when the command is not blocked, else the card to show and the refusal for the model.
// ctx is the tool ctx: ctx.denyPatterns are the project's own patterns, added to the built-in rules, and ctx.root is the
// project folder, which the rules treat as a project root (see checkCommand in denylist.mjs). Without a ctx only the built-in rules apply.
export function denyListHit(command, detail = command, ctx) {
  const hit = checkCommand(command, ctx?.denyPatterns ?? [], { projectRoot: ctx?.root });
  if (!hit?.blocked) return null;
  const rule = hit.rule || 'command deny list';
  // A project's own pattern is named as the project's rule, so the card does not call it a built-in one.
  const origin = rule.startsWith('custom pattern') ? 'a project rule' : 'a built-in rule';
  return {
    card: { summary: `Blocked by ${origin}: ${rule}. Approve to run anyway?`, detail: capDetail(`Rule: ${rule}\n\n${detail}`), rule, blocked: true, defaultDeny: true },
    refusal: `The user denied this command, which a built-in rule blocks (${rule}). Do not retry it or run it another way. Ask what they want instead.`,
  };
}

const timeoutFor = input => Math.min(MAX_TIMEOUT_S, Math.max(5, Math.floor(Number(input.timeout_seconds) || DEFAULT_TIMEOUT_S)));

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

// The card detail for an edit: the diff, capped for the card. When the cap cut lines off, the whole diff comes along as
// fullDetail (at most 2,000,000 characters). Only GET /api/approve/detail serves it, so Show all can read it before the user decides.
// The most of a full diff that Show all gets. A longer one is cut, and its last line says so: app.js reads FULL_CUT_NOTE to label it
// "Partial change shown", so the two texts must stay the same.
const FULL_DIFF_MAX = 2_000_000;
const FULL_CUT_NOTE = '\n…cut at 2,000,000 characters, the rest is not shown';

// The note counts toward the 2,000,000 characters, so the kept text never goes past them. lib/claude-cli.mjs uses this too.
export const cutFull = full => (full.length <= FULL_DIFF_MAX ? full : `${full.slice(0, FULL_DIFF_MAX - FULL_CUT_NOTE.length)}${FULL_CUT_NOTE}`);

export function editPlanDetail(text, updated, label) {
  const full = unifiedDiff(text, updated, label);
  const detail = capDetail(full);
  if (detail.length >= full.length) return { detail };
  return { detail, fullDetail: cutFull(full) };
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

async function planRun(input) {
  const command = String(input.command ?? '').trim();
  if (!command) throw new Error('Give a command to run.');
  // The summary clips a long command, so the full command goes in the detail.
  return { summary: `Run: ${clip(command, 300)}`, detail: capDetail(`${command}\n\nFolder: project root\nTimeout: ${timeoutFor(input)} seconds`) };
}

async function runCommand(input, ctx) {
  const command = String(input.command ?? '').trim();
  const seconds = timeoutFor(input);
  const r = await runShell(command, { cwd: ctx.root, timeoutMs: seconds * 1000, signal: ctx.signal, shell: shellFor() });
  const status = r.error ? `failed to start: ${r.error}`
    : r.timedOut ? `timed out after ${seconds}s`
      : r.aborted ? 'stopped'
        : `exit code ${r.code}`;
  return {
    ok: r.code === 0,
    summary: `${clip(command, 80)} → ${status}`,
    output: clip(`${status}\n${r.output}`.trimEnd()),
  };
}

// ---------- Muse Console self-update ----------

async function runPropose(input, ctx) {
  if (!ctx.queueUpdate) throw new Error('Updates are not available in this session.');
  const manifest = await ctx.queueUpdate({ summary: input.summary, files: input.files });
  return {
    ok: true,
    summary: `Queued update ${manifest.id}`,
    output: `Queued update ${manifest.id} with ${manifest.files.length} file(s): ${manifest.files.map(f => f.path).join(', ')}. The user can review it and apply it in the Updates panel.`,
  };
}

// ---------- delegation ----------

// Hands one scoped task to a coder (delegate.mjs). The coder's steps are shown nested under this call.
async function runDelegate(input, ctx) {
  const steps = new Map();
  const nested = ev => {
    ctx.emit?.(ev);
    if (ev.type === 'tool') steps.set(ev.id, { name: ev.name, summary: ev.summary, parent: ev.parent });
    if (ev.type === 'tool_result' && steps.has(ev.id)) {
      ctx.out?.tools.push({ ...steps.get(ev.id), ok: ev.ok, result: ev.summary });
    }
  };
  const r = await runTask({
    task: { id: ctx.parent ?? 'delegate', title: input.title, instructions: input.instructions, scope: input.scope, coder: input.coder, effort: input.effort },
    root: ctx.root,
    mode: ctx.mode,
    signal: ctx.signal,
    approve: ctx.approve,
    emit: nested,
    parent: ctx.parent,
    tools: ctx.tools,
    projectId: ctx.projectId,
    denyPatterns: ctx.denyPatterns,
  });
  const lines = [r.ok ? `Done. ${r.summary}`.trim() : `Not finished: ${r.error ?? 'no reason given'}`];
  if (!r.ok && r.summary) lines.push(`The coder said: ${r.summary}`);
  if (r.changed.length) lines.push(`Changed: ${r.changed.join(', ')}`);
  if (r.outOfScope.length) lines.push(`Changed outside the scope: ${r.outOfScope.join(', ')}`);
  const title = clip(String(input.title ?? 'Delegated task'), 120);
  return {
    ok: r.ok,
    summary: `${title}: ${r.ok ? 'done' : 'not finished'}${r.changed.length ? `, ${r.changed.length} file(s) changed` : ''}`,
    output: lines.join('\n'),
  };
}

const TOOLS = {
  list_dir: { plan: (i, c) => planOutside('List folder', i, c), run: listDir },
  read_file: { plan: (i, c) => planOutside('Read', i, c), run: readFileTool },
  search_text: { plan: (i, c) => planOutside('Search in', i, c), run: searchText },
  write_file: { plan: planWrite, run: runWrite },
  edit_file: { plan: planEdit, run: runEdit },
  run_command: { plan: planRun, run: runCommand },
  propose_update: { run: runPropose },
  delegate: { run: runDelegate },
};

// ctx: { root, mode ('ask'|'auto'), signal, approve(plan) -> Promise<boolean>, queueUpdate(payload) }
// Optional: scope ({ rel, abs }) limits a delegated coder's writes; parent is the id of the tool call that ran this;
// projectId files the checkpoints taken before writes (checkpoints.mjs); denyPatterns (an array of strings) are the
// project's own patterns for the command deny list. server.mjs sets both on every ctx, and a delegated coder's ctx carries them too.
// A write_file or edit_file card is stamped with the file's fingerprint, and the write is refused if the file has changed
// when the approval returns. A run_command that matches the deny list is asked about in auto mode too (denyListHit).
export async function runTool(name, input, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, summary: `Unknown tool ${name}`, output: `Unknown tool: ${name}` };
  try {
    // The scope check comes first, so an out-of-scope write is refused without ever being offered for approval.
    if (ctx.scope) {
      const refused = await scopeGate(name, input ?? {}, ctx);
      if (refused) return refused;
    }
    // SCOPED_WRITES is the two tools that write a file. Auto mode shows no card for them, so there is nothing to stamp.
    const stamped = SCOPED_WRITES.has(name) && ctx.mode !== 'auto';
    let plan = null;
    let stamp = null;
    if (stamped) ({ plan, stamp } = await planWithStamp(tool, input ?? {}, ctx));
    else if (tool.plan) plan = await tool.plan(input ?? {}, ctx);
    const blocked = name === 'run_command' ? denyListHit(String(input?.command ?? '').trim(), plan.detail, ctx) : null;
    if (plan && (ctx.mode !== 'auto' || blocked)) {
      // approvalRequester in server.mjs puts the user's reason for denying on the card object it was given.
      const card = blocked ? blocked.card : plan;
      const allowed = await ctx.approve(card);
      if (!allowed) {
        const reason = cleanReason(card.reason);
        const why = reason ? ` The user said: ${reason}` : '';
        // The chat step shows the reason too, so the user sees what the model was told. The model still reads only the output.
        return { ok: false, denied: true, summary: reason ? `Denied by user: ${reason}` : 'Denied by user', output: (blocked ? blocked.refusal : 'The user denied this action. Do not retry it. Ask what they want instead.') + why };
      }
    }
    return await tool.run(input ?? {}, ctx, stamp);
  } catch (err) {
    return { ok: false, summary: err.message, output: `Error: ${err.message}` };
  }
}

export function describeCall(name, input = {}) {
  switch (name) {
    case 'list_dir': return input.path || '.';
    case 'read_file': return String(input.path ?? '');
    case 'search_text': return `"${clip(String(input.pattern ?? ''), 80)}" in ${input.path || '.'}`;
    case 'write_file':
    case 'edit_file': return String(input.path ?? '');
    case 'run_command': return clip(String(input.command ?? ''), 200);
    case 'propose_update': return clip(String(input.summary ?? ''), 200);
    case 'delegate': return clip(String(input.title ?? 'Delegated task'), 200);
    default: return name;
  }
}
