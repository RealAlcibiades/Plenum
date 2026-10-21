import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { insideRoot } from './files.mjs';
import { checkAccess, isCredentialPath } from './guard.mjs';
import { capDetail, unifiedDiff } from './diff.mjs';
import { snapshotBeforeWrite } from './checkpoints.mjs';
import { checkCommand } from './denylist.mjs';
import { credentialPaths, plenumDataDirs } from './platform/paths.mjs';
import { CODE_ROOT, listFiles } from './overlay.mjs';

// The engine behind the model's tools. Each tool is defined in one file in lib/tools/ (NN-name.mjs, loaded in file-name
// order by loadTools). The file shape is documented at the top of lib/tools/10-files.mjs. This file holds the registry,
// the approval flow (runTool) and the rules every tool shares: the scope gate for delegated coders, the fingerprint stamp
// that refuses a write when the file changed after its card was shown, checkpoints, the command deny list, and the
// credential-folder check for commands (B-17). A tool file declares what it is; the engine applies the rules.
// Paths are relative to the project folder, or absolute. A path outside the project needs the user's approval (shown as a
// card), like an edit does. Credential folders and system folders are never allowed (see guard.mjs).
// A tool with a `plan` asks for approval unless approvals are set to auto; the plan is shown first.

// The tool files are listed through lib/overlay.mjs, so a file that an applied update adds or replaces is found too.
const TOOL_DIR = path.join(CODE_ROOT, 'lib', 'tools');
const TOOL_FILE = /^\d\d-[a-z0-9-]+\.mjs$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const ENTRY_KEYS = new Set(['name', 'description', 'input_schema', 'run', 'plan', 'describe', 'command', 'stamped', 'scoped', 'refusal', 'when']);
const RAW_KEYS = new Set(['raw', 'when']);
const SCOPE_MODES = new Set(['off', 'refuse', 'write']);
const FULL_DIFF_MAX = 2_000_000;
const FULL_CUT_NOTE = '\n…cut at 2,000,000 characters, the rest is not shown';

// The registry, in the order the files were loaded. REGISTRY holds the checked entries; TOOL_DEFS holds what the model is
// sent for each one ({ name, description, input_schema }, or a raw object), kept for callers and tests.
const REGISTRY = [];
export const TOOL_DEFS = [];

export const clip = (s, n = 24_000) => (s.length > n ? `${s.slice(0, n)}\n…[cut at ${n} characters]` : s);

// The reason a user typed when denying an approval card: one line of plain text, at most 300 characters. It is only ever
// added to the tool result the model reads, and it never changes the answer (see /api/approve in server.mjs).
export function cleanReason(raw) {
  if (typeof raw !== 'string') return '';
  // A cut can leave half of a surrogate pair at the end, which is not valid text, so that half goes too.
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300).replace(/[\ud800-\udbff]$/, '');
}

// ---------- the registry ----------

// Checks one entry of a tool file and returns the registry item for it. Throws an Error with a plain message when it is not valid.
function checkEntry(entry, source) {
  const bad = why => new Error(`A tool in ${source} is not valid: ${why}.`);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw bad('it is not an object');
  const when = entry.when;
  if (when !== undefined && typeof when !== 'function') throw bad('when must be a function');
  if (entry.raw !== undefined) {
    for (const key of Object.keys(entry)) if (!RAW_KEYS.has(key)) throw bad(`a raw entry takes only raw and when, not ${key}`);
    if (!entry.raw || typeof entry.raw !== 'object' || Array.isArray(entry.raw)) throw bad('raw must be an object');
    return { raw: entry.raw, when, source, name: typeof entry.raw.name === 'string' ? entry.raw.name : undefined };
  }
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) throw bad(`unknown field ${key}`);
  const { name, description, input_schema: schema, run, plan, describe, command, stamped, scoped, refusal } = entry;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw bad('name must be lowercase letters, digits and underscores, starting with a letter');
  if (typeof run !== 'function') throw bad(`${name} needs a run function`);
  if (typeof description !== 'string' || !description) throw bad(`${name} needs a description`);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw bad(`${name} needs an input_schema object`);
  for (const [key, fn] of Object.entries({ plan, describe, command })) {
    if (fn !== undefined && typeof fn !== 'function') throw bad(`${name}: ${key} must be a function`);
  }
  if (stamped !== undefined && typeof stamped !== 'boolean') throw bad(`${name}: stamped must be true or false`);
  if (scoped !== undefined && !SCOPE_MODES.has(scoped)) throw bad(`${name}: scoped must be off, refuse or write`);
  if ((scoped === 'off' || scoped === 'refuse') && (typeof refusal !== 'string' || !refusal)) throw bad(`${name} needs a refusal text`);
  return { name, description, input_schema: schema, run, plan, describe, command, stamped: stamped === true, scoped, refusal, when, source };
}

// Adds a tool file's entries to the registry. All of them are checked first, so a list with one bad entry adds nothing.
// A name that is already registered is refused, with the two files named.
export function registerTools(list, source) {
  const label = source ? path.basename(String(source)) : 'a tool list';
  if (!Array.isArray(list)) throw new Error(`${label} must export an array of tools.`);
  const owners = new Map(REGISTRY.filter(t => t.name).map(t => [t.name, t.source]));
  const items = [];
  for (const entry of list) {
    const item = checkEntry(entry, label);
    if (item.name !== undefined) {
      if (owners.has(item.name)) throw new Error(`Tool "${item.name}" is defined twice (${owners.get(item.name)} and ${label}).`);
      owners.set(item.name, label);
    }
    items.push(item);
  }
  for (const item of items) {
    REGISTRY.push(item);
    TOOL_DEFS.push(item.raw ?? { name: item.name, description: item.description, input_schema: item.input_schema });
  }
}

// The named entry for a tool name, or undefined. Raw entries have no name a caller can run.
export function toolByName(name) {
  return REGISTRY.find(t => !t.raw && t.name === name);
}

// The tool files, in file-name order. Each name matches TOOL_FILE. A missing folder means no tools. The paths name the install
// folder; the module hook (lib/overlay/hooks.mjs) answers an import of one with the active generation's copy, and loads one that
// only the generation has.
export async function toolFiles() {
  return listFiles('lib/tools', n => TOOL_FILE.test(n), CODE_ROOT).sort().map(n => path.join(TOOL_DIR, n));
}

// Imports each file and registers its `tools`. A file that does not load, has no tools array, or is refused is skipped
// with a console warning, so one bad file does not stop the others.
export async function loadToolFiles(files) {
  for (const file of files) {
    const name = path.basename(file);
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      console.warn(`Tool file ${name} did not load and is skipped: ${err.message}`);
      continue;
    }
    if (!Array.isArray(mod.tools)) {
      console.warn(`Tool file ${name} exports no tools list, so it is skipped.`);
      continue;
    }
    try {
      registerTools(mod.tools, file);
    } catch (err) {
      console.warn(`Tool file ${name} was not registered: ${err.message}`);
    }
  }
}

// Loads every tool file once. It is lazy on purpose: the files import this module, so they cannot be loaded while it is
// still being evaluated. Callers that need the tool list (toolsFor, describeCall) run after a load, and runTool awaits it.
let loading = null;
export function loadTools() {
  loading ??= toolFiles().then(loadToolFiles);
  return loading;
}

// The tool list for a model request. Without ctx there are no tools (a plain reply). A delegated coder (ctx.scope) gets
// neither the 'off' entries nor raw ones. An entry with `when` is offered only when it returns true. Synchronous: call
// loadTools() first.
export function toolsFor(ctx) {
  if (!ctx) return undefined;
  return REGISTRY
    .filter(t => (!t.when || t.when(ctx)) && !(ctx.scope && (t.scoped === 'off' || t.raw)))
    .map(t => t.raw ?? { name: t.name, description: t.description, input_schema: t.input_schema });
}

// ---------- paths ----------

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

// The one-line name of a resolved path, for cards and results.
export const display = t => (t.outside ? `${t.realTarget} (outside the project)` : t.rel);

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

// Runs before any approval. A tool with scoped 'off' or 'refuse' is refused here with its refusal text, and a 'write' tool
// is refused when its path is outside the task's scope. The message is for the model.
async function scopeGate(entry, input, ctx) {
  if (entry.scoped === 'off' || entry.scoped === 'refuse') {
    return { ok: false, denied: true, summary: 'Not allowed in this task', output: `${entry.refusal} Do not retry it.` };
  }
  if (entry.scoped !== 'write') return null;
  const t = await resolveTarget(ctx.root, input.path, { write: true });
  if (scopeHas(ctx.scope.abs, t.realTarget)) return null;
  return {
    ok: false,
    denied: true,
    summary: `Outside the task scope: ${display(t)}`,
    output: `This task may change only: ${ctx.scope.rel.join(', ')}. ${display(t)} is outside that, so the write was not made. Do not retry it. Change only files inside the scope, or say in your summary what else is needed.`,
  };
}

// ---------- the approval race: fingerprints, stamps and checkpoints ----------

const CHANGED = 'The file changed after the change was approved. Read it again and try once more.';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// What a file holds right now: the sha256 of its bytes, 'absent' when there is no file, or 'unreadable:<code>' when it
// cannot be read (a folder, no permission). Streamed, so a large file is not held in memory.
export async function fingerprint(abs) {
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
async function planWithStamp(entry, input, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = await resolveTarget(ctx.root, input.path, { write: true });
    const before = await fingerprint(t.realTarget);
    const plan = await entry.plan(input, ctx);
    if (before === await fingerprint(t.realTarget)) return { plan, stamp: { file: t.realTarget, hash: before } };
  }
  throw new Error('The file keeps changing, so a preview of the change could not be made. Try again in a moment.');
}

// Refuses the write when the file (or the path it resolves to) is not what the approval card showed.
export function assertUnchanged(stamp, file, hash) {
  if (stamp.file !== file || stamp.hash !== hash) throw new Error(CHANGED);
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

// ---------- the command deny list and the credential-folder check for commands ----------

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

// The message a credential-folder refusal gives. It is the same text guard.mjs throws for a credential path.
export const CREDENTIAL_REFUSED = 'That folder holds credentials and is off limits.';

// B-17. True when a shell command names a credential folder, so it must not run in any mode. It is a safety net, not a
// sandbox: it reads the command as words, expands %VAR%, $env:VAR, $VAR and ~ from this machine, and checks each word
// as written and as it really is (links and junctions followed). A credential folder is one of the sign-in folders in the
// home folder or Plenum's data folder (lib/platform/paths.mjs), or a credential folder name (.ssh, .aws, ...) outside the
// project. A cd (chdir, pushd, Set-Location, sl) moves the folder that later words are read from, so `cd %USERPROFILE% &&
// type .ssh\id_rsa` is caught; the sign-in folders are checked from the project folder as well, so a cd that never took
// effect (it failed, or ran in a nested shell) hides nothing. A command built up at run time (set a=... then %a%) is not
// caught, so this does not replace OS-level isolation.
export function commandCredentialHit(command, { root } = {}) {
  const text = expandVariables(String(command ?? ''));
  const home = os.homedir();
  if (namedPlace(text, [...credentialPaths(home), ...plenumDataDirs({ home })])) return true;
  const base = path.resolve(root ?? process.cwd());
  return scanCommand(text, base, { home, root: base, realRoot: realPlaceOf(base) });
}

const CD_WORDS = new Set(['cd', 'chdir', 'pushd', 'push-location', 'set-location', 'sl']);
// A word after one of these starts a command of its own: `cmd /c cd ..`, `bash -c cd ..`, `powershell -Command cd ..`.
const SHELL_FLAGS = new Set(['/c', '/k', '-c', '-lc', '-ic', '-command']);
// Words that come before a command without being one.
const COMMAND_PREFIX = new Set(['{', 'then', 'do', 'else']);

// Walks the command in order with a running folder (start), the one a relative word is read from. Returns true on a hit.
function scanCommand(text, start, env) {
  const { home, root, realRoot } = env;
  let base = start;
  let atCommand = true; // the next word is the first word of a command
  let cdWait = false; // a cd word was read and its target has not come yet
  const tilde = word => (word === '~' || /^~[\\/]/.test(word) ? path.join(home, word.slice(1)) : word);
  const wordHit = word => {
    const written = tilde(word);
    if (/^(\\\\|\/\/)/.test(written)) return namesCredential(written);
    for (const from of new Set([root, base])) {
      const lexical = path.resolve(from, written);
      const real = realPlaceOf(lexical);
      if (isCredentialPath(lexical) || isCredentialPath(real)) return true;
      // The name check follows the cd: a ..\.claude after a cd into a folder of the project is the project's own.
      if (from === base && !insideRoot(realRoot, real) && (namesCredential(lexical) || namesCredential(real))) return true;
    }
    return false;
  };
  for (const [token] of commandTokens(text)) {
    if (/^[&|;\r\n]/.test(token)) {
      // A bare cd goes to the home folder in a POSIX shell.
      if (cdWait) base = home;
      cdWait = false;
      atCommand = true;
      continue;
    }
    const quoted = token[0] === '"' || token[0] === "'";
    const word = quoted ? token.slice(1, -1) : token;
    // A quoted piece with spaces or separators in it is a command line of its own (`bash -c "cd .. && type x"`) as well as,
    // possibly, one path. Its own cd does not carry on past the quote.
    if (quoted && /[\s"'`&|;<>(),=]/.test(word) && scanCommand(word, base, env)) return true;
    if (wordHit(word)) return true;
    const lower = word.toLowerCase();
    if (cdWait) {
      if (!quoted && /^-[a-z@]*$/i.test(word) && word !== '-') continue; // a flag: -P, -Path, -LiteralPath
      if (!quoted && lower === '/d') continue;
      cdWait = false;
      if (word !== '-') base = path.resolve(base, tilde(word));
      continue;
    }
    if (atCommand) {
      if (COMMAND_PREFIX.has(lower)) continue;
      atCommand = false;
      if (CD_WORDS.has(lower)) cdWait = true;
      // cmd takes the target right after the command: cd.. and cd\Users.
      const glued = !quoted && /^(?:cd|chdir)([.\\/].*)$/i.exec(word);
      if (glued) base = path.resolve(base, glued[1]);
      continue;
    }
    if (SHELL_FLAGS.has(lower)) atCommand = true;
  }
  return false;
}

// Replaces %NAME%, $env:NAME, ${NAME} and $NAME with the value this process sees. An unknown name is left as it is, and so is
// a list of paths (PATH and the like: ';' on Windows, ':' elsewhere), which would otherwise name every folder in it.
function expandVariables(text) {
  const value = name => {
    const v = process.env[name];
    if (typeof v !== 'string' || v.includes(';') || (process.platform !== 'win32' && v.includes(':'))) return undefined;
    return v;
  };
  return text
    .replace(/%([^%\r\n]+)%/g, (m, name) => value(name) ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, name) => value(name) ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => value(name) ?? m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => value(name) ?? m);
}

// The pieces of a command, in order: a word (split at spaces, quotes and the shell's other separators, with cmd's escape
// character removed), a run of command separators (& | ; and line breaks), or a quoted string whole, quotes included.
function commandTokens(text) {
  return text.replace(/\^/g, '').matchAll(/"[^"]*"|'[^']*'|[&|;\r\n]+|[^\s"'`&|;<>(),=]+/g);
}

// Slashes and case are the same for a place check: lower case, backslashes only, single backslashes.
const plain = s => s.toLowerCase().replace(/[\\/]+/g, '\\');

// True when a credential place (as a whole path or the start of one) appears in the command text.
function namedPlace(text, places) {
  const t = plain(text);
  return places.some(p => {
    const want = plain(p).replace(/\\+$/, '');
    return want !== '' && t.includes(want);
  });
}

// The credential folder names checked outside the project (a project's own .claude or .codex folder is not one of these).
const CREDENTIAL_NAMES = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.netrc', '.codex', '.claude', '.gemini', '.cursor', '.grok', '.muse-console']);
const CREDENTIAL_PAIRS = [['.config', 'gcloud'], ['.config', 'muse'], ['.config', 'plenum'], ['.docker', 'config.json'], ['roaming', 'plenum'], ['application support', 'plenum']];

// True when a path has a credential folder name in it, in either slash form, compared in lower case.
function namesCredential(p) {
  const segs = p.toLowerCase().split(/[\\/]+/);
  return segs.some((s, i) => CREDENTIAL_NAMES.has(s) || CREDENTIAL_PAIRS.some(([a, b]) => s === a && segs[i + 1] === b));
}

// The place a path really is: links and junctions are followed as far as the path exists, and the part that does not
// exist yet is kept as written after the part that does. Falls back to the path as written.
function realPlaceOf(p) {
  const full = path.resolve(p);
  let dir = full;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(dir), ...tail);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return full;
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

// ---------- the approval flow ----------

// ctx: { root, mode ('ask'|'auto'), signal, approve(plan) -> Promise<boolean>, queueUpdate(payload) }
// Optional: scope ({ rel, abs }) limits a delegated coder's writes; parent is the id of the tool call that ran this;
// projectId files the checkpoints taken before writes (checkpoints.mjs); denyPatterns (an array of strings) are the
// project's own patterns for the command deny list. server.mjs sets both on every ctx, and a delegated coder's ctx carries them too.
// A write_file or edit_file card is stamped with the file's fingerprint, and the write is refused if the file has changed
// when the approval returns. A run_command that matches the deny list is asked about in auto mode too (denyListHit).
// A command that names a credential folder is refused before any card, in every mode (commandCredentialHit).
export async function runTool(name, input, ctx) {
  await loadTools();
  const entry = toolByName(name);
  if (!entry) return { ok: false, summary: `Unknown tool ${name}`, output: `Unknown tool: ${name}` };
  try {
    // The scope check comes first, so an out-of-scope write is refused without ever being offered for approval.
    if (ctx.scope) {
      const refused = await scopeGate(entry, input ?? {}, ctx);
      if (refused) return refused;
    }
    const command = entry.command ? entry.command(input ?? {}) : null;
    if (command !== null && commandCredentialHit(command, { root: ctx.root })) throw new Error(CREDENTIAL_REFUSED);
    // A tool with `stamped` is stamped when a card is shown. Auto mode shows no card for it, so there is nothing to stamp.
    const stamped = entry.stamped && ctx.mode !== 'auto';
    let plan = null;
    let stamp = null;
    if (stamped) ({ plan, stamp } = await planWithStamp(entry, input ?? {}, ctx));
    else if (entry.plan) plan = await entry.plan(input ?? {}, ctx);
    const blocked = command !== null ? denyListHit(command, plan?.detail, ctx) : null;
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
    return await entry.run(input ?? {}, ctx, stamp);
  } catch (err) {
    return { ok: false, summary: err.message, output: `Error: ${err.message}` };
  }
}

// The one line a step row shows for a call: the tool's own describe, else the tool's name. Unknown and raw names give the name.
export function describeCall(name, input = {}) {
  const entry = toolByName(name);
  return entry?.describe?.(input ?? {}) ?? name;
}

// The card detail for an edit: the diff, capped for the card. When the cap cut lines off, the whole diff comes along as
// fullDetail (at most 2,000,000 characters). Only GET /api/approve/detail serves it, so Show all can read it before the user decides.
// lib/tools/10-files.mjs uses this for edit_file.
export function editPlanDetail(text, updated, label) {
  const full = unifiedDiff(text, updated, label);
  const detail = capDetail(full);
  if (detail.length >= full.length) return { detail };
  return { detail, fullDetail: cutFull(full) };
}

// The most of a full diff that Show all gets. A longer one is cut, and its last line says so: app.js reads FULL_CUT_NOTE to label it
// "Partial change shown", so the two texts must stay the same.
// The note counts toward the 2,000,000 characters, so the kept text never goes past them. lib/claude-cli.mjs uses this too.
export const cutFull = full => (full.length <= FULL_DIFF_MAX ? full : `${full.slice(0, FULL_DIFF_MAX - FULL_CUT_NOTE.length)}${FULL_CUT_NOTE}`);
