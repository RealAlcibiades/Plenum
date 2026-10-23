// Cursor CLI options: what the project settings panel offers for Cursor, and the flags the print transport takes.
// The default transport is ACP (`agent acp`, lib/acp.mjs), where Plenum answers every permission request itself, so no flag
// is sent there: argsFor returns [] for 'acp'. The flags below are for the print fallback (`agent -p`, selected with
// MUSE_CONSOLE_CURSOR_TRANSPORT=print), and each one was checked against the Cursor CLI reference, not against a signed-in run.
//
// --force is not a setting. The print transport sends it only when the app's mode is Auto-approve or Approve all (isOpenMode),
// and never for a read-only run (lib/cursor.mjs passes mode 'ask' then). Without it Cursor only proposes its writes.
//
// The Plenum bridge (lib/mcp-server.mjs, amendment 10) reaches Cursor through ACP only. ACP's session/new takes the MCP servers of the
// session in its own request, so no file of Cursor's (~/.cursor/mcp.json, a credential folder, or a project's .cursor) is read or written:
// mcpServersFor(mcp) returns the entry lib/acp.mjs puts in `mcpServers`. The print transport has no way to define a server except those
// files, so it gets no bridge (--approve-mcps, below, only approves servers Cursor already has). A read-only run gets none either.

// The model id the print transport passes to --model. Empty means Cursor's own default.
const MODEL_MAX = 80;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const OPTIONS = Object.freeze([
  Object.freeze({
    key: 'model',
    label: 'Model (print transport)',
    help: 'Only the print transport (MUSE_CONSOLE_CURSOR_TRANSPORT=print) uses this: the model id passed to --model. Empty is the default, which lets Cursor choose its own model.',
    type: 'text',
    default: '',
    group: 'Model',
  }),
  Object.freeze({
    key: 'sandbox',
    label: 'Sandbox (print transport)',
    help: 'Only the print transport uses this: --sandbox enabled, which limits what Cursor can reach on this computer. Off is the default. The ACP transport does not use it.',
    type: 'boolean',
    default: false,
    group: 'Permissions',
  }),
  Object.freeze({
    key: 'approveMcps',
    label: 'Approve MCP servers (print transport)',
    help: 'Only the print transport uses this: --approve-mcps, which approves the MCP servers in your Cursor settings without asking. Off is the default, which keeps those servers from being approved automatically.',
    type: 'boolean',
    default: false,
    group: 'Tools',
  }),
]);

function modelOf(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('Model must be text.');
  const text = value.trim();
  if (!text) return '';
  if (text.length > MODEL_MAX || !MODEL.test(text)) {
    throw new Error(`Model must be a Cursor model id of up to ${MODEL_MAX} letters, digits, dots, underscores or hyphens.`);
  }
  return text;
}

function boolOf(label, value) {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

// Returns the cleaned settings. Unknown keys are dropped, missing keys get their defaults, and a bad value throws an Error with a
// plain message.
export function normalize(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('Cursor options must be an object.');
  }
  const src = input ?? {};
  return {
    model: modelOf(src.model),
    sandbox: boolOf('Sandbox', src.sandbox),
    approveMcps: boolOf('Approve MCP servers', src.approveMcps),
  };
}

// The flags for one run, as argument strings. transport is 'acp' (no flags) or 'print'. mode is the app's approval mode for the
// run: Auto-approve ('auto') and Approve all ('all') add --force to the print transport, and anything else leaves Cursor's
// prompts as they are, so it only proposes its writes.
export function argsFor(settings, { transport = 'acp', mode = 'ask' } = {}) {
  if (transport !== 'print') return [];
  const s = normalize(settings);
  const args = [];
  if (s.model) args.push('--model', s.model);
  if (s.sandbox) args.push('--sandbox', 'enabled');
  if (s.approveMcps) args.push('--approve-mcps');
  if (mode === 'auto' || mode === 'all') args.push('--force');
  return args;
}

// The MCP servers to send in ACP's session/new for a run: [] when there is no bridge, else the one entry
// { name, command, args, env: [{ name, value }] }. mcp is the bridge's descriptor (lib/mcp-server.mjs openBridge). The same entry is
// what Grok Build takes once its adapter lands, which is why the name and shape are not Cursor's alone.
export function mcpServersFor(mcp, { readOnly = false } = {}) {
  if (readOnly || !mcp || typeof mcp !== 'object') return [];
  const text = v => typeof v === 'string' && v.length > 0 && !/[\u0000-\u001f\u007f]/.test(v);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(String(mcp.name ?? '')) || !text(mcp.command)) return [];
  if (!Array.isArray(mcp.args) || !mcp.args.length || !mcp.args.every(text)) return [];
  const env = [];
  for (const [name, value] of Object.entries(mcp.env && typeof mcp.env === 'object' && !Array.isArray(mcp.env) ? mcp.env : {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || !text(value)) return [];
    env.push({ name, value });
  }
  return [{ name: mcp.name, command: mcp.command, args: [...mcp.args], env }];
}
