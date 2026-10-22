// Muse Code options for `muse exec` runs. Owned by the muse options builder.
// Every flag here was checked against `muse --help` and `muse exec --help` (Muse Code 1.4.7; --disable-approval was read again in
// `muse exec --help` of 1.4.8, where it is listed as "Disable tool approval prompts for this run").
// Muse also has --disable-approval, --disable-sandbox and --yolo, and an approval mode that turns prompts off. --disable-approval
// is sent in one case only: the app's Approve all mode (options.mode 'all'), never from a saved setting and never to a read-only
// run (lib/providers.mjs streamMuse passes mode 'ask' for those). --yolo and --disable-sandbox stay out on purpose: each one
// switches off a safety check, and a setting in the app must not be able to do that. For the same reason
// the app never sends --trust-workspace, --enable-shell-tool, --allow-workspace-switch, --base-url, --api-key-stdin, -c,
// --preset, --permission-profile or the worktree flags: each one loosens a check, moves the run off the project folder, or
// sends data to another host. The flags added for parity only take something away from a run or cap it.

const APPROVAL_MODES = ['untrusted', 'on-request'];
// The help lists restricted|enabled|proxy-only. `enabled` is left out because it is the open setting. The help does
// not say what each mode does, so this choice rests on the mode names.
const SANDBOX_NETWORK_MODES = ['restricted', 'proxy-only'];
// The help gives no range for --max-model-steps, so 1 to 200 is this module's own limit.
const MAX_STEPS = 200;
const STEPS_MESSAGE = 'Max model steps must be empty, or a whole number from 1 to 200.';
// The help says --max-tool-output-bytes takes 0 or at least 9. What 0 means is not stated, so it is not offered, and the
// 1000000 ceiling (about one megabyte) is this module's own limit.
const MIN_TOOL_BYTES = 9;
const MAX_TOOL_BYTES = 1000000;
const TOOL_BYTES_MESSAGE = 'Max tool output bytes must be empty, or a whole number from 9 to 1000000.';

export const OPTIONS = [
  {
    key: 'approvalMode',
    label: 'Approval mode',
    help: 'Untrusted is the stricter choice: Muse asks before more of its steps. On request, the default, asks only when a step needs approval; neither choice turns approvals off.',
    type: 'select',
    choices: [
      { value: 'untrusted', label: 'Untrusted' },
      { value: 'on-request', label: 'On request' },
    ],
    default: 'on-request',
    group: 'Permissions',
  },
  {
    key: 'sandboxNetwork',
    label: 'Sandbox network',
    help: 'Sets how shell commands reach the network. Proxy only is the default, and Restricted is stricter; the fully open setting is left out on purpose.',
    type: 'select',
    choices: [
      { value: 'restricted', label: 'Restricted' },
      { value: 'proxy-only', label: 'Proxy only' },
    ],
    default: 'proxy-only',
    group: 'Permissions',
  },
  {
    key: 'disableWebTools',
    label: 'Disable web tools',
    help: 'Stops Muse from searching or fetching web pages during a run, which stops it sending requests to websites. Off, the default, leaves Muse\'s own web setting in place.',
    type: 'boolean',
    default: false,
    group: 'Permissions',
  },
  {
    key: 'disableParallelToolCalls',
    label: 'Disable parallel tool calls',
    help: 'Makes Muse run one tool call at a time, so each step is easier to follow and to approve. Off, the default, leaves Muse\'s own setting in place, and it may run several at once.',
    type: 'boolean',
    default: false,
    group: 'Behaviour',
  },
  {
    key: 'maxModelSteps',
    label: 'Max model steps',
    help: 'Caps how many model steps one run may take, from 1 to 200. Empty, the default, leaves Muse\'s own limit in place.',
    type: 'text',
    max: 3,
    default: '',
    group: 'Behaviour',
  },
  {
    key: 'maxToolOutputBytes',
    label: 'Max tool output bytes',
    help: 'Caps how many bytes of tool output are fed back to the model, from 9 to 1000000. Empty, the default, leaves Muse\'s own limit in place.',
    type: 'text',
    max: 7,
    default: '',
    group: 'Behaviour',
  },
  {
    key: 'disableWrite',
    label: 'Disable file writes',
    help: 'Stops Muse\'s own file tools from writing in the workspace, while writes made through shell commands are a separate switch. Off, the default, leaves Muse\'s own setting in place.',
    type: 'boolean',
    default: false,
    group: 'Permissions',
  },
  {
    key: 'disableShell',
    label: 'Disable shell commands',
    help: 'Stops Muse from running shell commands in the workspace, so it can only use its other tools. Off, the default, leaves Muse\'s own setting in place.',
    type: 'boolean',
    default: false,
    group: 'Permissions',
  },
  {
    key: 'noForeignPersonalContext',
    label: 'Exclude foreign personal context',
    help: 'Keeps the foreign personal rules and skills out of the run, so less outside text reaches it. Off, the default, leaves Muse\'s own setting in place.',
    type: 'boolean',
    default: false,
    group: 'Behaviour',
  },
  {
    key: 'noSessionLog',
    label: 'Skip the session log',
    help: 'Stops Muse from saving the run\'s event log to disk. Off, the default, leaves Muse\'s own setting in place.',
    type: 'boolean',
    default: false,
    group: 'Behaviour',
  },
];

// Saved settings come from a JSON file, so any value can arrive here. Each message says the rule in plain words,
// because the panel shows it to the person.
export function normalize(input) {
  const src = isObject(input) ? input : {};
  return {
    approvalMode: choice(src.approvalMode, APPROVAL_MODES, 'on-request', 'Approval mode must be one of: untrusted, on-request.'),
    sandboxNetwork: choice(src.sandboxNetwork, SANDBOX_NETWORK_MODES, 'proxy-only', 'Sandbox network must be one of: restricted, proxy-only.'),
    disableWebTools: flag(src.disableWebTools, 'Disable web tools'),
    disableParallelToolCalls: flag(src.disableParallelToolCalls, 'Disable parallel tool calls'),
    maxModelSteps: steps(src.maxModelSteps),
    maxToolOutputBytes: toolBytes(src.maxToolOutputBytes),
    disableWrite: flag(src.disableWrite, 'Disable file writes'),
    disableShell: flag(src.disableShell, 'Disable shell commands'),
    noForeignPersonalContext: flag(src.noForeignPersonalContext, 'Exclude foreign personal context'),
    noSessionLog: flag(src.noSessionLog, 'Skip the session log'),
  };
}

// Returns the flags for one run as an array, not a shell string, so a folder name with spaces stays one argument.
// The approval and sandbox flags are always sent, so a run does not depend on Muse's own defaults staying the same.
// options.mode ('ask', 'auto' or 'all') is accepted so every CLI shares one signature. Only 'all' changes the flags: it adds
// --disable-approval, because Muse's own approval prompts cannot be answered from the window and headless Muse would otherwise
// stop at the first one. No saved setting can name that flag (normalize drops unknown keys), and 'ask' and 'auto' cannot widen
// what Muse may do. The sandbox flags are not touched by any mode.
export function argsFor(settings, options = {}) {
  const s = normalize(settings);
  const args = ['--approval-mode', s.approvalMode, '--sandbox-network', s.sandboxNetwork];
  // Approve all only (see the header). The caller passes mode 'ask' for every read-only run, so none of them gets it.
  if (isObject(options) && options.mode === 'all') args.push('--disable-approval');
  if (s.disableWebTools) args.push('--disable-web-tools');
  if (s.disableParallelToolCalls) args.push('--no-parallel-tool-calls');
  if (s.maxModelSteps) args.push('--max-model-steps', s.maxModelSteps);
  if (s.maxToolOutputBytes) args.push('--max-tool-output-bytes', s.maxToolOutputBytes);
  if (s.disableWrite) args.push('--disable-write');
  if (s.disableShell) args.push('--disable-shell');
  if (s.noForeignPersonalContext) args.push('--no-foreign-personal-context');
  if (s.noSessionLog) args.push('--no-session-log');
  // The run's folder: Muse roots its workspace tools there.
  const cwd = isObject(options) ? options.cwd : undefined;
  if (typeof cwd === 'string' && cwd.trim()) args.push('--workspace', cwd);
  return args;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// An absent value (undefined or null) takes the default. Anything else must be one of the choices.
function choice(value, allowed, fallback, message) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(message);
  return value;
}

function flag(value, label) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

// Empty means no cap, so the flag is left out and Muse's own limit applies. Only plain digits pass, so nothing like
// "1e3" or "-5" can reach the command line. `digits` is the most digits allowed, which keeps the text value short.
function wholeNumber(value, digits, min, max, message) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') throw new Error(message);
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (!new RegExp(`^\\d{1,${digits}}$`).test(trimmed)) throw new Error(message);
  const n = Number(trimmed);
  if (n < min || n > max) throw new Error(message);
  return String(n);
}

const steps = value => wholeNumber(value, 3, 1, MAX_STEPS, STEPS_MESSAGE);
const toolBytes = value => wholeNumber(value, 7, MIN_TOOL_BYTES, MAX_TOOL_BYTES, TOOL_BYTES_MESSAGE);
