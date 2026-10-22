// Claude Code options: the extra flags Muse Console adds to a `claude` run, from the project's tool
// settings. Every flag used here was checked against `claude --help` (CLI 2.1.296). Bypass modes and
// the flags that skip permission checks are never offered, and no value is allowed to name them.
// The flags added for parity only remove a capability, cap a run, or add one line of the user's own instructions.
// Left out on purpose: --settings, --plugin-dir, --plugin-url, --agent, --chrome, --cloud,
// --teleport, --remote-control, --worktree, --debug and --debug-file, because each one loads code or settings from
// somewhere the app cannot check, sends the work to another host, or leaves the project folder. The adapter sets
// --model, --effort, --tools, --agents and the session flags itself.
// An extra folder (addDirs) must also pass folderRisk (lib/guard.mjs), as Codex's and Gemini's must: not a drive, the user
// folder or one above it, a credential folder, Plenum's own folder or a system folder. The strict path (normalize) refuses it and
// the run-time path (runnableSettings) drops an already-saved entry that fails, so no migration is needed (B-1).

import { folderRisk } from '../guard.mjs';

export const OPTIONS = [
  {
    key: 'permissionMode',
    label: 'Permission mode',
    help: 'Manual, the default, asks before operations Claude treats as dangerous, and plan only makes no changes. Accept edits, auto and don\'t ask are not offered, so the app\'s approval and scope checks see every change.',
    type: 'select',
    choices: [
      { value: 'manual', label: 'Manual (ask first)' },
      { value: 'plan', label: 'Plan only (no changes)' },
    ],
    default: 'manual',
    group: 'Permissions',
  },
  {
    key: 'allowedTools',
    label: 'Always allowed tools',
    help: 'Empty by default, these are tools Claude may use without asking, such as WebFetch or mcp__github__create_issue. Edit, Write, NotebookEdit, Bash and PowerShell cannot be listed, since each would skip a check on writes or commands.',
    type: 'list',
    default: [],
    max: 20,
    group: 'Permissions',
  },
  {
    key: 'disallowedTools',
    label: 'Blocked tools',
    help: 'Empty by default, these are tools Claude may never use, such as WebFetch or Bash(rm *). Blocking a tool only takes away what Claude can do, so it adds no risk.',
    type: 'list',
    default: [],
    max: 20,
    group: 'Permissions',
  },
  {
    key: 'restricted',
    label: 'Restricted mode',
    help: 'Off by default. On, Claude confines its file tools to the project and the extra folders, ignores user, project and local settings files, and keeps the tool list the app sets.',
    type: 'boolean',
    default: false,
    group: 'Permissions',
  },
  {
    key: 'addDirs',
    label: 'Extra folders',
    help: 'Empty by default, these are full paths of folders outside the project that Claude may read and change. Each one gives Claude everything inside it, including files it could overwrite.',
    type: 'list',
    default: [],
    max: 20,
    group: 'Folders',
  },
  {
    key: 'settingSources',
    label: 'Settings files',
    help: 'Which Claude settings files load, and the default is user only, which reads just your own global settings. Project and local settings can auto-approve tools and run hooks from the repository, so choosing them is a trust decision.',
    type: 'select',
    choices: [
      { value: 'user', label: 'User only (your own settings)' },
      { value: 'project,local', label: 'Project and local' },
      { value: 'user,project,local', label: 'User, project and local' },
      { value: 'user,local', label: 'User and local (skip the project file)' },
    ],
    default: 'user',
    group: 'Settings',
  },
  {
    key: 'maxBudgetUsd',
    label: 'Spend limit (USD)',
    help: 'Empty by default, which sets no cap. A dollar amount from 0.01 to 1000 is the most one run may spend on API calls.',
    type: 'text',
    default: '',
    max: 7,
    group: 'Settings',
  },
  {
    key: 'fallbackModel',
    label: 'Fallback model',
    help: 'Empty by default. One model name, such as sonnet, that Claude switches to when the main model is overloaded or not available.',
    type: 'text',
    default: '',
    max: 80,
    group: 'Settings',
  },
  {
    key: 'appendSystemPrompt',
    label: 'Extra instructions',
    help: 'Empty by default. One line of your own instructions added to Claude\'s system prompt; a chat that has already started may keep the prompt it began with.',
    type: 'text',
    default: '',
    max: 300,
    group: 'Settings',
  },
  {
    key: 'disableSkills',
    label: 'Turn off skills',
    help: 'Off by default. On, all of Claude\'s skills are disabled for the run.',
    type: 'boolean',
    default: false,
    group: 'Settings',
  },
  {
    key: 'mcpConfig',
    label: 'MCP servers file',
    help: 'Path to a JSON file that starts extra MCP servers, which run programs on your computer. Leave it empty, the default, to start none; point it only at a file you wrote or trust.',
    type: 'text',
    default: '',
    max: 300,
    group: 'Integrations',
  },
  {
    key: 'strictMcpConfig',
    label: 'Only the MCP servers file',
    help: 'Off by default. On, only the servers in the MCP servers file load, and with no file set no MCP servers load at all.',
    type: 'boolean',
    default: false,
    group: 'Integrations',
  },
  {
    key: 'noChrome',
    label: 'Turn off Chrome integration',
    help: 'Off by default. On, the Claude in Chrome integration is switched off for the run.',
    type: 'boolean',
    default: false,
    group: 'Integrations',
  },
];

// Quotes and cmd.exe characters are refused rather than passed on. The .cmd shim runs through cmd.exe,
// and winArg in lib/proc.mjs quietly turns these into other characters. Commas are refused because the
// CLI splits some list values on them.
const FORBIDDEN = /["%!^&|<>,\x00-\x1f\x7f]/;
// The same without the comma, for a value the CLI takes whole (the extra instructions), where a comma is ordinary text.
const FORBIDDEN_WHOLE = /["%!^&|<>\x00-\x1f\x7f]/;

// Any value naming a bypass mode or the skip-permissions flag is refused, so no output can carry one.
const SKIPS_PERMISSIONS = /bypass\s*permissions|dangerously[-_ ]?skip/i;

const LIST_ITEM_MAX = 120;
const TOOL_ENTRY = /^[A-Za-z][A-Za-z0-9_.-]*(\([^()]*\))?$/;
const FULL_PATH = /^([A-Za-z]:[\\/]|\\\\|\/)/;
// Edit, Write, NotebookEdit, Bash and PowerShell are never allowed without a prompt, even narrowed to a pattern such as
// Bash(git status). An allow entry for one would let a write or command skip the app's approval and a coder's scope check.
const WRITE_OR_COMMAND = new Set(['edit', 'write', 'notebookedit', 'bash', 'powershell']);
const toolName = s => s.split('(')[0].toLowerCase();
const ENTRY_RULES = {
  allowedTools: { ok: s => TOOL_ENTRY.test(s), no: s => WRITE_OR_COMMAND.has(toolName(s)), hint: 'one tool each, such as WebFetch or mcp__github__create_issue' },
  disallowedTools: { ok: s => TOOL_ENTRY.test(s), hint: 'one tool each, such as WebFetch or Bash(rm *)' },
  addDirs: { ok: s => FULL_PATH.test(s), hint: 'a full folder path, such as one starting with a drive letter' },
};

// The reason a list entry or text value cannot be used, or null when it can. The strict path (normalize) throws
// it and the clamping path (runnableSettings) drops or defaults the value instead. The value is passed as one
// argument, so a trailing backslash would escape the closing quote that Windows quoting adds, and a leading dash
// would read as a flag.
function argProblem(where, v, max, commasOk = false) {
  if (SKIPS_PERMISSIONS.test(v)) return `${where} cannot name a mode that skips permission checks.`;
  if (commasOk && FORBIDDEN_WHOLE.test(v)) return `${where} cannot contain quotes, %, !, ^, &, |, <, > or control characters.`;
  if (!commasOk && FORBIDDEN.test(v)) return `${where} cannot contain quotes, commas, %, !, ^, &, |, <, > or control characters.`;
  if (v.endsWith('\\')) return `${where} cannot end with a backslash.`;
  if (v.startsWith('-')) return `${where} cannot start with a dash.`;
  if (v.length > max) return `${where} can be at most ${max} characters.`;
  return null;
}

// The reason a list entry cannot be used, or null when it can.
function entryProblem(opt, v) {
  const where = `${opt.label} entries`;
  const rule = ENTRY_RULES[opt.key];
  const arg = argProblem(where, v, LIST_ITEM_MAX);
  if (arg) return arg;
  if (!rule.ok(v)) return `${where} must be ${rule.hint}.`;
  if (rule.no?.(v)) return `${where} cannot name Edit, Write, NotebookEdit, Bash or PowerShell.`;
  if (opt.key === 'addDirs') {
    const risk = folderRisk(v);
    if (risk) return `${where}: The folder cannot be given to Claude Code: ${risk}`;
  }
  return null;
}

// Checks for the text options that take more than a path. The spend limit is a plain dollar amount of at most four
// digits and two decimals, from 0.01 to 1000 (the help gives no range, so this is the module's own limit), and it is
// written back without padding, so 05.50 becomes 5.5. A model name is a single token with no spaces or commas.
// The extra instructions are one line of prose, so commas are allowed there. A rule's `problem` returns a message or null.
const DOLLARS = /^\d{1,4}(\.\d{1,2})?$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const TEXT_RULES = {
  maxBudgetUsd: {
    problem: (label, v) => (DOLLARS.test(v) && Number(v) >= 0.01 && Number(v) <= 1000 ? null : `${label} must be empty, or a dollar amount from 0.01 to 1000.`),
    canon: v => String(Number(v)),
  },
  fallbackModel: {
    problem: (label, v) => (MODEL_NAME.test(v) ? null : `${label} can use only letters, numbers, dots, dashes, underscores, colons and square brackets.`),
  },
  appendSystemPrompt: { commasOk: true },
};

// The reason a text value cannot be used, or null when it can.
function textProblem(opt, v) {
  const rule = TEXT_RULES[opt.key] ?? {};
  return argProblem(opt.label, v, opt.max, rule.commasOk) ?? rule.problem?.(opt.label, v) ?? null;
}

const canonText = (opt, v) => TEXT_RULES[opt.key]?.canon?.(v) ?? v;

const defaultOf = opt => (Array.isArray(opt.default) ? [...opt.default] : opt.default);

function cleanBoolean(opt, raw) {
  if (typeof raw !== 'boolean') throw new Error(`${opt.label} must be true or false.`);
  return raw;
}

function cleanSelect(opt, raw) {
  const values = opt.choices.map(c => c.value);
  if (!values.includes(raw)) throw new Error(`${opt.label} must be one of: ${values.join(', ')}.`);
  return raw;
}

function cleanList(opt, raw) {
  if (!Array.isArray(raw)) throw new Error(`${opt.label} must be a list.`);
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`${opt.label} entries must be text.`);
    const v = item.trim();
    if (!v) continue;
    const problem = entryProblem(opt, v);
    if (problem) throw new Error(problem);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > opt.max) throw new Error(`${opt.label} can have at most ${opt.max} entries.`);
  return out;
}

function cleanText(opt, raw) {
  if (typeof raw !== 'string') throw new Error(`${opt.label} must be text.`);
  const v = raw.trim();
  const problem = v ? textProblem(opt, v) : null;
  if (problem) throw new Error(problem);
  return v ? canonText(opt, v) : v;
}

function cleanValue(opt, raw) {
  if (raw === undefined || raw === null) return defaultOf(opt);
  if (opt.type === 'boolean') return cleanBoolean(opt, raw);
  if (opt.type === 'select') return cleanSelect(opt, raw);
  if (opt.type === 'list') return cleanList(opt, raw);
  return cleanText(opt, raw);
}

// The clamping twin of cleanValue, for settings already saved. Nothing here throws: a select or text value that
// normalize would refuse takes its default, and a list keeps only its safe entries (at most opt.max of them).
function clampList(opt, raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length === opt.max) break;
    const v = typeof item === 'string' ? item.trim() : '';
    if (!v || entryProblem(opt, v) || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

function clampValue(opt, raw) {
  if (raw === undefined || raw === null) return defaultOf(opt);
  if (opt.type === 'boolean') return typeof raw === 'boolean' ? raw : opt.default;
  if (opt.type === 'select') return opt.choices.some(c => c.value === raw) ? raw : opt.default;
  if (opt.type === 'list') return clampList(opt, raw);
  if (typeof raw !== 'string') return opt.default;
  const v = raw.trim();
  if (!v) return v;
  return textProblem(opt, v) ? opt.default : canonText(opt, v);
}

// The saved settings for this CLI, cleaned: unknown keys dropped, defaults filled in. A bad value throws
// an Error with a plain message that the settings panel can show as it is.
export function normalize(input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Claude Code options must be an object.');
  const out = {};
  for (const opt of OPTIONS) out[opt.key] = cleanValue(opt, input[opt.key]);
  return out;
}

// The same shape as normalize, for settings already saved. It never throws, so a project saved under an older rule
// still runs: an unsafe permission mode becomes manual, unsafe list entries are dropped, and any other value that
// normalize would refuse takes its default. argsFor reads its settings through this.
export function runnableSettings(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const opt of OPTIONS) out[opt.key] = clampValue(opt, src[opt.key]);
  return out;
}

// Windows paths are case-insensitive, accept either slash and may end with one, so compare them in one form.
const folderKey = p => String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();

// The argument strings for one `claude` run. Each value is its own array item, never a shell string.
// `mode` (ask or auto) is not read here. The app answers permission requests itself (the run passes
// --permission-prompt-tool stdio), so the approval setting decides how those answers are given, while
// the permission mode above decides which requests are made.
export function argsFor(settings, { cwd } = {}) {
  // runnableSettings has already clamped every permission mode and allow entry that decision 3 rules out, so none reach these flags.
  const s = runnableSettings(settings);
  const dirs = s.addDirs.filter(dir => !cwd || folderKey(dir) !== folderKey(cwd));
  const args = [];
  // The CLI reads a list flag's values up to the next flag. The list flags come first and the single-value
  // flags close the array, so a positional argument added after this array is never taken as a list entry.
  if (s.allowedTools.length) args.push('--allowedTools', ...s.allowedTools);
  if (s.disallowedTools.length) args.push('--disallowedTools', ...s.disallowedTools);
  if (dirs.length) args.push('--add-dir', ...dirs);
  if (s.mcpConfig) args.push('--mcp-config', s.mcpConfig);
  // The switches and single values added for parity. Each starts with a flag of its own, so they also end the
  // --mcp-config list above. None is sent while it is off or empty, so a default run has the same arguments as before.
  if (s.strictMcpConfig) args.push('--strict-mcp-config');
  if (s.restricted) args.push('--restricted');
  if (s.noChrome) args.push('--no-chrome');
  if (s.disableSkills) args.push('--disable-slash-commands');
  if (s.maxBudgetUsd) args.push('--max-budget-usd', s.maxBudgetUsd);
  if (s.fallbackModel) args.push('--fallback-model', s.fallbackModel);
  if (s.appendSystemPrompt) args.push('--append-system-prompt', s.appendSystemPrompt);
  args.push('--permission-mode', s.permissionMode, '--setting-sources', s.settingSources);
  return args;
}
