import { folderRisk } from '../guard.mjs';

// gemini options. Owned by the gemini options builder.
// Every flag used here was checked against `gemini --help` of Gemini CLI 0.63.0 (names, choices, and the
// comma rule for list flags). Each list item gets its own --flag=value token, so a list can never take the
// token after it. The approve-all mode is never offered: it lets Gemini run every tool without a prompt.

// The CLI's approval modes, without the approve-all one.
const APPROVAL_MODES = [
  { value: 'default', label: 'Ask before acting' },
  { value: 'auto_edit', label: 'Auto-approve edits' },
  { value: 'plan', label: 'Read-only plan' },
];
// Higher rank means more freedom. The app's approval mode is a ceiling, so the stricter of the two wins.
const RANK = { plan: 0, default: 1, auto_edit: 2 };

const MAX_ITEMS = 20;
const MAX_ITEM_LENGTH = 120;
// Extension and MCP server names are plain identifiers, so nothing in them needs quoting on a command line.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Control characters, and the characters cmd.exe rewrites when a .cmd shim starts Gemini (lib/proc.mjs
// replaces them). A value holding one would reach Gemini changed, so it is refused with a plain message.
const CONTROL = /[\u0000-\u001f\u007f]/;
const CMD_UNSAFE = /["%!^&|<>]/;
// A full path: a drive letter, a network share, or a POSIX root. A relative path depends on where Gemini starts.
const FULL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

const pathCheck = (label, example) => item => {
  // Gemini splits its folder and policy lists on commas, so a comma would turn one path into two.
  if (CONTROL.test(item) || CMD_UNSAFE.test(item) || item.includes(',')) {
    throw new Error(`${label} cannot contain quotes, %, !, ^, &, |, <, >, commas or line breaks.`);
  }
  if (!FULL_PATH.test(item)) throw new Error(`${label} must be full paths, such as ${example}.`);
};

const nameCheck = what => item => {
  if (!NAME.test(item)) throw new Error(`${what} can use only letters, numbers, dots, underscores and hyphens.`);
};

// An extra folder must be a full path, and must pass folderRisk (lib/guard.mjs): not a drive, a credential folder or
// one above it, Plenum's own folder, a Windows system folder, or the user's folder. normalize runs this for every run,
// read-only plan runs included, so the refusals never depend on the approval mode.
const folderPath = pathCheck('Extra folders', 'C:\\Projects\\shared');
const folderCheck = item => {
  folderPath(item);
  const risk = folderRisk(item);
  if (risk) throw new Error(`The folder cannot be given to Gemini: ${risk}`);
};

const LISTS = {
  policyFiles: { label: 'Policy files', noun: 'policy file', check: pathCheck('Policy files', 'C:\\Policies\\read-only.toml') },
  allowedMcpServers: { label: 'Allowed MCP servers', noun: 'MCP server name', check: nameCheck('MCP server names') },
  extensions: { label: 'Extensions', noun: 'extension name', check: nameCheck('Extension names') },
  includeDirectories: { label: 'Extra folders', noun: 'folder', check: folderCheck },
};

export const OPTIONS = Object.freeze([
  Object.freeze({
    key: 'approvalMode',
    label: 'Approval mode',
    help: 'Controls what Gemini may do without asking. The default, Ask before acting, is the safest; Auto-approve edits lets Gemini change files without asking, and Read-only plan lets it look but change nothing.',
    type: 'select',
    choices: Object.freeze(APPROVAL_MODES.map(c => Object.freeze({ ...c }))),
    default: 'default',
    group: 'Permissions',
  }),
  Object.freeze({
    key: 'sandbox',
    label: 'Sandbox',
    help: 'Runs Gemini in a sandbox that limits what it can reach on this computer. Off is the default, which lets Gemini use your full account access; turning it on can stop runs if no sandbox is set up here.',
    type: 'boolean',
    default: false,
    group: 'Permissions',
  }),
  Object.freeze({
    key: 'policyFiles',
    label: 'Policy files',
    help: 'Extra Gemini policy files or folders, each a full path, that decide which tools Gemini may use. A policy can allow a tool as well as block it, so add only files you have read; the default is none.',
    type: 'list',
    default: Object.freeze([]),
    max: MAX_ITEMS,
    group: 'Permissions',
  }),
  Object.freeze({
    key: 'allowedMcpServers',
    label: 'Allowed MCP servers',
    help: 'Only the MCP servers named here may run for Gemini, and MCP servers can reach other programs and services. Empty is the default and lets every MCP server in your Gemini settings run.',
    type: 'list',
    default: Object.freeze([]),
    max: MAX_ITEMS,
    group: 'Tools',
  }),
  Object.freeze({
    key: 'extensions',
    label: 'Extensions',
    help: 'Only the installed Gemini extensions named here are used, and an extension can add tools. Empty is the default and uses every installed extension.',
    type: 'list',
    default: Object.freeze([]),
    max: MAX_ITEMS,
    group: 'Tools',
  }),
  Object.freeze({
    key: 'includeDirectories',
    label: 'Extra folders',
    help: 'Extra folders, each a full path, that Gemini can work in alongside the project folder. Each folder added is more of your computer that Gemini can change; the default is none.',
    type: 'list',
    default: Object.freeze([]),
    max: MAX_ITEMS,
    group: 'Folders',
  }),
]);

function approvalModeOf(value) {
  if (value == null) return 'default';
  const values = APPROVAL_MODES.map(c => c.value);
  if (!values.includes(value)) throw new Error(`Approval mode must be one of: ${values.join(', ')}.`);
  return value;
}

function sandboxOf(value) {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new Error('Sandbox must be true or false.');
  return value;
}

function listOf(spec, value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${spec.label} must be a list.`);
  const items = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error(`${spec.label} must be a list of text.`);
    // A blank entry (an empty input box left in the list) is dropped rather than refused.
    const item = raw.trim();
    if (!item) continue;
    if (item.length > MAX_ITEM_LENGTH) throw new Error(`Each ${spec.noun} can be at most ${MAX_ITEM_LENGTH} characters.`);
    spec.check(item);
    // The same item twice would just repeat a flag, so it is kept once.
    if (items.includes(item)) continue;
    items.push(item);
    if (items.length > MAX_ITEMS) throw new Error(`${spec.label} can hold at most ${MAX_ITEMS} items.`);
  }
  return items;
}

// Returns the cleaned settings. Unknown keys are dropped, missing keys get their defaults, and a bad value
// throws an Error with a plain message. The result always holds fresh arrays, never the shared defaults.
export function normalize(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('Gemini options must be an object.');
  }
  const src = input ?? {};
  return {
    approvalMode: approvalModeOf(src.approvalMode),
    sandbox: sandboxOf(src.sandbox),
    policyFiles: listOf(LISTS.policyFiles, src.policyFiles),
    allowedMcpServers: listOf(LISTS.allowedMcpServers, src.allowedMcpServers),
    extensions: listOf(LISTS.extensions, src.extensions),
    includeDirectories: listOf(LISTS.includeDirectories, src.includeDirectories),
  };
}

// The flags for one run, as argument strings (never a shell string). mode is the app's approval setting:
// 'auto' allows the auto-approve edit mode, 'plan' (a read-only run) allows only plan, and anything else
// (including a missing mode) asks first. The app's mode only ever caps the choice, so it can make the run
// stricter but never looser.
// cwd is not needed: folder and policy paths are full paths, so they do not depend on where Gemini starts.
// The approval flag is always sent, so Gemini's own saved settings cannot loosen it.
export function argsFor(settings, { mode = 'ask' } = {}) {
  const s = normalize(settings);
  const ceiling = mode === 'auto' ? 'auto_edit' : mode === 'plan' ? 'plan' : 'default';
  const approval = RANK[s.approvalMode] <= RANK[ceiling] ? s.approvalMode : ceiling;
  const args = [`--approval-mode=${approval}`];
  // Off adds nothing: the flag only turns the sandbox on.
  if (s.sandbox) args.push('-s');
  for (const file of s.policyFiles) args.push(`--policy=${file}`);
  for (const name of s.allowedMcpServers) args.push(`--allowed-mcp-server-names=${name}`);
  for (const name of s.extensions) args.push(`--extensions=${name}`);
  for (const dir of s.includeDirectories) args.push(`--include-directories=${dir}`);
  return args;
}
