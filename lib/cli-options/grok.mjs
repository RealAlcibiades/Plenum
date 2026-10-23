// Grok Build CLI options: what the project settings panel offers for Grok Build, and the flags the print transport takes.
// The default transport is ACP (`grok agent stdio`, lib/acp.mjs), where Plenum answers every permission request itself, so no flag
// is sent there: argsFor returns [] for 'acp'. The flags below are for the print fallback (`grok -p`, selected with
// MUSE_CONSOLE_GROK_TRANSPORT=print). That transport cannot ask, so a call that needs approval fails rather than prompts.
//
// --always-approve is not a setting. The print transport sends it only when the app's mode is Approve all ('all'), and never for a
// read-only run, so a saved value can never turn Grok Build's prompts off. --yolo (its alias) is never sent. Neither are the devbox
// and strict sandboxes: their effect on Windows is not documented, so the sandbox offers off, workspace and read-only only.
// Ask first and Auto-approve send no approval flag, so Grok Build keeps its own prompts there and a call that needs one fails.
//
// A read-only print run (a council seat, a relay hop, a compare or pipeline step, plan mode) runs in an empty folder of its own and
// adds --sandbox read-only on macOS and Linux only; Windows support for that sandbox is undocumented, so there it adds nothing.
//
// The Plenum bridge (lib/mcp-server.mjs) reaches Grok Build through ACP only (session/new takes its MCP servers). The print transport has
// no way to define a server, so it gets none.

// The model id the print transport passes to -m. Empty means Grok Build's own default.
const MODEL_MAX = 80;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SANDBOXES = Object.freeze(['off', 'workspace', 'read-only']);
const TURNS_MIN = 1;
const TURNS_MAX = 200;
const TURNS_DEFAULT = 30;

export const OPTIONS = Object.freeze([
  Object.freeze({
    key: 'model',
    label: 'Model (print transport)',
    help: 'Only the print transport (MUSE_CONSOLE_GROK_TRANSPORT=print) uses this: the model id passed with -m. Empty is the default. `grok models` lists the ids.',
    type: 'text',
    default: '',
    group: 'Model',
  }),
  Object.freeze({
    key: 'sandbox',
    label: 'Sandbox (print transport)',
    help: 'Only the print transport uses this: --sandbox, which limits what Grok Build can reach on this computer. Off is the default. The ACP transport does not use it.',
    type: 'select',
    choices: Object.freeze([
      Object.freeze({ value: 'off', label: 'Off' }),
      Object.freeze({ value: 'workspace', label: 'Project folder only' }),
      Object.freeze({ value: 'read-only', label: 'Read only' }),
    ]),
    default: 'off',
    group: 'Permissions',
  }),
  Object.freeze({
    key: 'maxTurns',
    label: 'Maximum turns (print transport)',
    help: 'Only the print transport uses this: --max-turns, the most model turns one reply may take (1 to 200). The default is 30. The ACP transport does not use it.',
    type: 'number',
    min: TURNS_MIN,
    max: TURNS_MAX,
    default: TURNS_DEFAULT,
    group: 'Limits',
  }),
]);

function modelOf(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('Model must be text.');
  const text = value.trim();
  if (!text) return '';
  if (text.length > MODEL_MAX || !MODEL.test(text)) {
    throw new Error(`Model must be a Grok Build model id of up to ${MODEL_MAX} letters, digits, dots, underscores or hyphens.`);
  }
  return text;
}

function sandboxOf(value) {
  if (value == null || value === '') return 'off';
  if (typeof value !== 'string' || !SANDBOXES.includes(value)) throw new Error('Sandbox must be off, workspace or read-only.');
  return value;
}

function turnsOf(value) {
  if (value == null) return TURNS_DEFAULT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < TURNS_MIN || value > TURNS_MAX) {
    throw new Error(`Maximum turns must be a whole number from ${TURNS_MIN} to ${TURNS_MAX}.`);
  }
  return value;
}

// Returns the cleaned settings. Unknown keys are dropped, missing keys get their defaults, and a bad value throws an Error with a
// plain message.
export function normalize(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('Grok Build options must be an object.');
  }
  const src = input ?? {};
  return {
    model: modelOf(src.model),
    sandbox: sandboxOf(src.sandbox),
    maxTurns: turnsOf(src.maxTurns),
  };
}

// The flags for one run, as argument strings. transport is 'acp' (no flags) or 'print'. mode is the app's approval mode for the run;
// only Approve all ('all') adds --always-approve, and only on a run that is not read-only. platform is the system the run is on, which
// decides the read-only sandbox (see above).
export function argsFor(settings, { transport = 'acp', mode = 'ask', readOnly = false, platform = process.platform } = {}) {
  if (transport !== 'print') return [];
  const s = normalize(settings);
  const args = [];
  if (s.model) args.push('-m', s.model);
  if (readOnly && (platform === 'darwin' || platform === 'linux')) args.push('--sandbox', 'read-only');
  else if (s.sandbox !== 'off') args.push('--sandbox', s.sandbox);
  args.push('--max-turns', String(s.maxTurns));
  if (!readOnly && mode === 'all') args.push('--always-approve');
  return args;
}
