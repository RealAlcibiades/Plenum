import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, findExecutable, killTree, resolveLaunch, stripAnsi, streamProcess } from './proc.mjs';
import { runAcp } from './acp.mjs';
import { openSignIn } from './accounts.mjs';
import { checkAccess } from './guard.mjs';
import { capDetail } from './diff.mjs';
import { argsFor } from './cli-options/cursor.mjs';
import { SERVER_NAME } from './mcp-server.mjs';
import { CREDENTIAL_REFUSED, answersBlocked, blockedAnsweredNotice, cleanReason, commandCredentialHit, denyListHit, isOpenMode, scopeHas } from './tools.mjs';

// Cursor through its own CLI (`agent`, or `cursor-agent` where that name is on PATH). Two transports:
//   acp    (default) `agent acp`, the Agent Client Protocol over stdio (lib/acp.mjs). Cursor's permission requests become Plenum's
//          approval cards, so Ask first works: an edit or a command waits for Approve or Deny. Cursor keeps its own tools.
//   print  `agent -p --output-format stream-json`, the fallback for a Cursor CLI whose ACP mode does not start. It cannot answer
//          requests, so in Ask first Cursor only proposes its edits, and Plenum sees no card for them. MUSE_CONSOLE_CURSOR_TRANSPORT=print.
// The CLI signs in with the Cursor account (`agent login`, from Accounts). A saved CURSOR_API_KEY is removed from its environment
// (lib/proc.mjs childEnv), so a key never bills in place of the sign-in. Its own settings folder ~/.cursor is a credential folder.
// A read-only run (a council seat, a relay hop, a compare or pipeline step, plan mode) runs in an empty scratch folder and refuses
// every request. A coder of a build (lib/delegate.mjs) passes its scope in ctx, so a write outside the scope is refused before a card.
// A call of Plenum's own MCP bridge is let through without a card only when the bridge is attached to the run, the title names one of the
// bridge's own tools exactly, the kind is "other" or none, and it carries no command and no path; a request merely titled "plenum ..."
// gets the whole decision (the title is text, so it proves nothing alone).
// No flag that turns Cursor's prompts off is sent on the ACP transport. The print transport sends --force only in Auto-approve or
// Approve all (lib/cli-options/cursor.mjs).

export const CURSOR_HINT = "Install the Cursor CLI: on Windows run irm 'https://cursor.com/install?win32=true' | iex in PowerShell; on macOS or Linux run curl https://cursor.com/install -fsS | bash";
const SIGN_IN = 'Cursor is not signed in. Open Accounts and choose "Sign in to Cursor".';
const NOT_CURSOR = 'The agent program on PATH is not the Cursor CLI.';
// Words that mean "sign in" in a failed run. Only a run with no text is judged by them.
const AUTH_ERROR = /not logged in|not authenticated|please log in|unauthorized/i;
const NOT_SIGNED_IN_TEXT = /not logged in|not authenticated/i;
const CURSOR_COMMANDS = ['cursor-agent', 'agent'];
const STATUS_TTL_MS = 20_000;
const READ_ONLY_REFUSED = 'Not allowed in a read-only run.';
const NO_CARD = 'Plenum cannot ask in this run, so the request was refused. Do not retry it.';
const NOTE_ASK_PRINT = 'The print transport cannot ask before it writes, so in Ask first Cursor only proposes its edits in its reply.';
const NOTICE_ALL = 'In Approve all, Cursor and Grok Build run with their own prompts off. Plenum cannot see or stop those steps; their own settings files still apply. On Cursor\'s print transport (MUSE_CONSOLE_CURSOR_TRANSPORT=print) the deny list and credential floor do not apply either.';
const NOTICE_AUTO = 'In Auto-approve, Cursor runs with its own prompts off on its print transport (MUSE_CONSOLE_CURSOR_TRANSPORT=print). Plenum cannot see or stop those steps, and its deny list and credential floor do not apply there; Cursor\'s own settings files still apply.';
// The print transport takes the whole prompt as its last argument, so the most it may be is set by the command line that carries it:
// 100,000 characters elsewhere; on Windows 30,000 for a program of its own (about 32,000 is the limit) and 7,000 for a .cmd or .bat
// shim, which runs through cmd.exe, and cmd.exe refuses a line of 8,191 characters or more (printLimit).
const PRINT_PROMPT_MAX = 100_000;
const PRINT_PROMPT_WIN = 30_000;
const PRINT_PROMPT_CMD = 7_000;
const PRINT_EARLIER = '\n\nEarlier in this conversation';
const PRINT_CURRENT = 'Current request:\n';
const PRINT_CUT = 'Earlier messages were cut to fit Cursor\'s print transport.\n\n';
const PRINT_TOO_LONG = 'The newest message is too long for Cursor\'s print transport on this system (its command line holds a limited number of characters). Shorten it, or use Cursor\'s ACP transport.';
const TOOL_NAME = { read: 'Read', edit: 'Edit', execute: 'Bash', search: 'Grep', fetch: 'WebFetch' };
const PRINT_TOOL = {
  readToolCall: 'Read', editToolCall: 'Edit', writeToolCall: 'Edit', applyPatchToolCall: 'Edit', shellToolCall: 'Bash',
  runTerminalCommandToolCall: 'Bash', grepToolCall: 'Grep', globToolCall: 'Grep', searchToolCall: 'Grep', webFetchToolCall: 'WebFetch',
};
// The kinds that change files, so their paths are checked as writes.
const WRITE_KINDS = new Set(['edit', 'write', 'delete', 'move']);
// A call of the Plenum bridge (lib/mcp-server.mjs) asks its own cards inside the call (the site, the impact, the start card), so Cursor's
// permission request for it is not asked a second time. A title is text, so the shortcut is narrow (grok.mjs has the same rule): the
// bridge must be attached to this run, the title must be the server name and then exactly one tool the bridge registers (plenum__<tool>,
// the MCP form mcp__plenum__<tool>, or the same with another separator such as a colon or a space), the kind must be "other" or none, and
// the call must carry no command and no path. A request that fails any of these goes through the whole decision (credential check, deny
// list, scope and card) like any other request, the unreadable rule included. BRIDGE_TOOLS is every tool lib/routes/mcp.mjs can offer
// (the browser_* tools of lib/browser-tools.mjs, the computer_* actions of lib/computer/generic.mjs, delegate, confirm_with_user and
// hand_over); a test keeps the list in step with them.
export const BRIDGE_TOOL_NAMES = Object.freeze([
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll',
  'browser_wait', 'browser_back', 'browser_tabs', 'browser_screenshot',
  'computer_screenshot', 'computer_zoom', 'computer_click', 'computer_move', 'computer_drag', 'computer_scroll', 'computer_type',
  'computer_key', 'computer_hold', 'computer_wait',
  'delegate', 'confirm_with_user', 'hand_over',
]);
const TITLE_SEP = '(?:__|_|[ \\t]*[:./-][ \\t]*|[ \\t]+)';
const BRIDGE_TITLE = new RegExp(`^(?:mcp${TITLE_SEP})?${SERVER_NAME}${TITLE_SEP}(?:${BRIDGE_TOOL_NAMES.join('|')})$`, 'i');
const bridgeAttached = mcp => Array.isArray(mcp?.acpServers) && mcp.acpServers.some(s => s?.name === SERVER_NAME);
const isBridgeCall = ({ mcp, title, kind, command, targets }) => bridgeAttached(mcp) && (kind === '' || kind === 'other')
  && !command && targets.length === 0 && BRIDGE_TITLE.test(title.trim());

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const textString = v => (typeof v === 'string' ? v : '');
const userSaid = card => { const why = cleanReason(card.reason); return why ? ` The user said: ${why}` : ''; };
const inside = (dir, p) => {
  const a = dir.toLowerCase();
  const b = p.toLowerCase();
  return b === a || b.startsWith(a + path.sep);
};

// What a request names, all of it (the first one was not enough: a second path or a list command was read as empty). The raw input's
// path keys and paths list, the locations the call touches and the diffs in its content (lib/acp.mjs keeps those on the call).
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'source', 'destination'];
const locationsOf = call => (Array.isArray(call?.locations) ? call.locations.map(l => textString(l?.path)) : []);
const diffPathsOf = call => (Array.isArray(call?.content) ? call.content.filter(c => isObject(c) && c.type === 'diff').map(c => textString(c.path)) : []);
function pathsOf(input, locations, diffs) {
  const named = PATH_KEYS.map(key => textString(input[key]));
  if (Array.isArray(input.paths)) for (const p of input.paths) named.push(textString(p));
  return [...named, ...locations, ...diffs].map(p => p.trim()).filter(Boolean);
}
// The command text of a request: a string, or a list of words joined with spaces (a command given as argv).
function commandOf(input) {
  for (const key of ['command', 'cmd']) {
    const v = input[key];
    const text = Array.isArray(v) ? v.filter(w => typeof w === 'string').join(' ') : textString(v);
    if (text.trim()) return text.trim();
  }
  return '';
}

// The name the CLI is started by: cursor-agent when it is on PATH, else agent. null when neither is found.
export async function cursorCommand() {
  for (const name of CURSOR_COMMANDS) if (await findExecutable(name)) return name;
  return null;
}

// The short calls (--version and status) have a time limit. A Cursor CLI that stalls (its own update, a network that is down) must not
// hold up the page's status or a turn: the process tree is killed when the time is up or the signal aborts (lib/proc.mjs killTree).
const PROBE_MS = 5_000;
const SLOW = 'The Cursor CLI did not answer in time. Try again.';
async function probeRun(name, args, signal) {
  if (signal?.aborted) return { code: null, output: '', timedOut: true };
  const launch = await resolveLaunch(name, args);
  if (!launch) return { code: null, output: '', timedOut: false };
  return new Promise(resolve => {
    let out = '';
    let settled = false;
    let timer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
      resolve(result);
    };
    const giveUp = () => {
      killTree(child);
      finish({ code: null, output: '', timedOut: true });
    };
    const child = spawn(launch.file, launch.argv, { env: childEnv(name), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: launch.verbatim });
    timer = setTimeout(giveUp, PROBE_MS);
    signal?.addEventListener('abort', giveUp, { once: true });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ code: null, output: '', timedOut: false }));
    child.on('close', code => finish({ code, output: stripAnsi(out).trim(), timedOut: false }));
  });
}

// Each executable is checked once with `--version`: an `agent` on PATH that is not the Cursor CLI is refused before any run.
const verified = new Set();
async function checkVersion(name, signal) {
  const exe = await findExecutable(name);
  if (verified.has(exe)) return;
  const r = await probeRun(name, ['--version'], signal);
  if (r.timedOut) {
    if (signal?.aborted) return;
    throw new Error(SLOW);
  }
  if (r.code !== 0 || !String(r.output ?? '').trim()) throw new Error(NOT_CURSOR);
  verified.add(exe);
}

// The path a write names, with symlinks followed as far as the path exists, so the check judges where the write would really land.
async function realTarget(abs) {
  let tail = '';
  let dir = abs;
  for (;;) {
    try {
      const real = await fs.realpath(dir);
      return tail ? path.join(real, tail) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      tail = tail ? path.join(path.basename(dir), tail) : path.basename(dir);
      dir = parent;
    }
  }
}

// ---------- sign-in and status ----------

// Reads `agent status --format json` (or its text). Returns { signedIn, email }: signedIn true or false when the output says so,
// null when it does not. An explicit loggedIn or authenticated flag wins, then an account email, then the words "not logged in".
export function parseStatus(text) {
  const raw = String(text ?? '').trim();
  let obj = null;
  try {
    const v = JSON.parse(raw);
    if (isObject(v)) obj = v;
  } catch {
    obj = null;
  }
  if (!obj) return { signedIn: NOT_SIGNED_IN_TEXT.test(raw) ? false : null, email: null };
  const email = [obj.email, obj.user?.email].map(v => textString(v).trim()).find(Boolean) ?? null;
  const flag = typeof obj.loggedIn === 'boolean' ? obj.loggedIn : typeof obj.authenticated === 'boolean' ? obj.authenticated : null;
  let signedIn = null;
  if (flag !== null) signedIn = flag;
  else if (email) signedIn = true;
  else if (NOT_SIGNED_IN_TEXT.test(raw)) signedIn = false;
  return { signedIn, email };
}

let statusCache = null;
let statusFlight = null;

// { installed, signedIn, email } for Accounts and the model picker. Makes no change; the CLI's status command reads its sign-in.
// Cached for 20 seconds. Callers that ask while a read is running share it, and each call is time-limited (probeRun): a CLI that
// does not answer reads as installed with the sign-in unknown, and an `agent` that is not Cursor reads as not installed.
export function cursorStatus() {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return Promise.resolve(statusCache.value);
  if (!statusFlight) statusFlight = readStatus().finally(() => { statusFlight = null; });
  return statusFlight;
}

async function readStatus() {
  const name = await cursorCommand();
  let value;
  if (!name) {
    value = { installed: false, signedIn: null, email: null };
  } else {
    try {
      await checkVersion(name, null);
      const r = await probeRun(name, ['status', '--format', 'json'], null);
      value = r.timedOut ? { installed: true, signedIn: null, email: null } : { installed: true, ...parseStatus(r.output ?? '') };
    } catch (err) {
      value = err?.message === NOT_CURSOR
        ? { installed: false, signedIn: null, email: null, note: NOT_CURSOR }
        : { installed: true, signedIn: null, email: null };
    }
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// Opens a terminal running `agent login` (the CLI opens the browser for the sign-in). Nothing is sent here.
export async function cursorSignIn() {
  const name = await cursorCommand();
  if (!name) throw new Error(CURSOR_HINT);
  await checkVersion(name, null);
  statusCache = null;
  await openSignIn(name, ['login'], 'Cursor sign-in');
}

// ---------- running ----------

// Runs a callback-driven job in the background and yields the pieces it pushes, so a run that reports by callbacks reads as a stream.
// The job gets its own abort signal: it ends when the caller stops reading or the outer signal aborts. An error the job throws is
// thrown after the pieces it had pushed.
async function* pumped(job, signal) {
  const ac = new AbortController();
  const pieces = [];
  let wake = null;
  let done = false;
  let failure = null;
  const poke = () => {
    const go = wake;
    wake = null;
    go?.();
  };
  const outer = () => ac.abort();
  if (signal?.aborted) ac.abort();
  signal?.addEventListener('abort', outer, { once: true });
  const running = Promise.resolve()
    .then(() => job(piece => { pieces.push(piece); poke(); }, ac.signal))
    .catch(err => { failure = err; })
    .finally(() => { done = true; poke(); });
  try {
    for (;;) {
      if (pieces.length) {
        yield pieces.shift();
        continue;
      }
      if (done) break;
      await new Promise(resolve => { wake = resolve; });
    }
  } finally {
    signal?.removeEventListener('abort', outer);
    ac.abort();
  }
  await running;
  if (failure) throw failure;
}

// The ACP transport. tell() sends a step event; ctx (null for a read-only run) carries approve, root, denyPatterns, mode and scope.
async function* acpRun({ name, cwd, prompt, signal, ctx, mode, readOnly, tell, mcp = null }) {
  const gate = { ...(ctx ?? {}), mode, root: ctx?.root ?? cwd };
  const open = new Set();   // tool call ids whose step has been shown
  const closed = new Set(); // tool call ids whose step has a result
  let text = '';
  let calls = 0;

  const showCall = (id, toolName, summary) => {
    if (!id || open.has(id)) return;
    open.add(id);
    calls++;
    tell({ type: 'tool', id, name: toolName, summary: clip(summary, 200) });
  };
  const showResult = (id, ok, summary, denied = false) => {
    if (!id || closed.has(id)) return false;
    closed.add(id);
    tell({ type: 'tool_result', id, ok, summary: clip(summary, 300), ...(denied ? { denied: true } : {}) });
    return true;
  };
  // What each call's updates said about it, by id: the permission request may carry only the id, so decide joins these under it.
  const seenCalls = new Map();
  const noteCall = ev => {
    const next = { ...(seenCalls.get(ev.id) ?? {}) };
    for (const key of ['title', 'kind', 'rawInput', 'locations', 'content']) {
      const v = ev[key];
      if (v !== undefined && v !== null && v !== '') next[key] = v;
    }
    seenCalls.set(ev.id, next);
  };

  // Refused by Plenum before any card: the step says why. A user's answer keeps its reason, as the Claude gate does.
  const refused = (id, message) => { showResult(id, false, message); return false; };
  // A denial is marked denied, so the chat labels the step Denied and not Failed (C-5). A card that Stop closed says Stopped, with no reason.
  const deniedByUser = (id, reason, stopped = false) => {
    if (stopped) showResult(id, false, 'Stopped');
    else showResult(id, false, reason ? `Denied by user: ${reason}` : 'Denied by user', true);
    return false;
  };
  // The card goes to the person through ctx.approve, which answers true or false. A run with no approve function has no card.
  const ask = async card => {
    if (typeof ctx?.approve !== 'function') return { allowed: false, reason: '', stopped: false };
    const allowed = await ctx.approve(card);
    return { allowed: allowed === true, reason: cleanReason(card.reason), stopped: card.stopped === true };
  };

  const decide = async toolCall => {
    const id = textString(toolCall.toolCallId) || textString(toolCall.id);
    // The request may carry only the id; what the call's updates said about it is joined under what the request says.
    const prior = seenCalls.get(id) ?? {};
    const kind = textString(toolCall.kind) || textString(prior.kind);
    const title = textString(toolCall.title) || textString(prior.title) || kind || 'action';
    const input = {
      ...(isObject(prior.rawInput) ? prior.rawInput : {}),
      ...(isObject(toolCall.rawInput) ? toolCall.rawInput : {}),
    };
    showCall(id, TOOL_NAME[kind] ?? 'tool', title);
    if (readOnly) return refused(id, READ_ONLY_REFUSED);
    // What the request names, all of it: the command and every path (the raw input, the call's locations and the diffs in its content).
    const command = commandOf(input);
    const write = WRITE_KINDS.has(kind);
    const targets = pathsOf(input, [...locationsOf(toolCall), ...locationsOf(prior)], [...diffPathsOf(toolCall), ...diffPathsOf(prior)]);
    // A bridge call has nothing for Plenum to check here (the bridge runs its own checks), so it is answered before the card rules below.
    if (isBridgeCall({ mcp, title, kind, command, targets })) return true;
    if (typeof ctx?.approve !== 'function' && !isOpenMode(mode)) return refused(id, NO_CARD);

    // A command: a credential folder is refused in every mode, and a deny-list rule always asks (Deny is the default).
    if (command) {
      if (commandCredentialHit(command, { root: gate.root })) return refused(id, CREDENTIAL_REFUSED);
      const hit = denyListHit(command, command, gate);
      if (hit) {
        if (answersBlocked(gate)) {
          tell({ type: 'notice', text: blockedAnsweredNotice(hit.card.rule) });
          return true;
        }
        if (typeof ctx?.approve !== 'function') return refused(id, NO_CARD);
        const answer = await ask(hit.card);
        return answer.allowed ? true : deniedByUser(id, answer.reason, answer.stopped);
      }
    }

    // Every path the request names: checkAccess refuses a credential, system or Plenum folder before any card, in every mode. A write
    // also has to lie in a delegated task's scope.
    const reals = [];
    for (const target of targets) {
      const real = await realTarget(path.resolve(cwd, target));
      try {
        // copyRoot is the folder the agent runs in: a write into another thread's isolated copy is refused in every mode (pro-02).
        checkAccess(real, { write, copyRoot: cwd });
      } catch (err) {
        return refused(id, err.message);
      }
      if (ctx?.scope && write && !scopeHas(ctx.scope.abs, real)) {
        return refused(id, `Outside this task's scope (${(ctx.scope.rel ?? []).join(', ')}): ${target}`);
      }
      reals.push(real);
    }

    // A request Plenum cannot read (no command and no path) is judged by its kind: an edit, a delete, a move, a command or a request
    // with no kind keeps its card in every mode, Approve all included. (An unread request used to pass Approve all unasked.)
    const unreadable = !command && targets.length === 0 && (!kind || WRITE_KINDS.has(kind) || kind === 'execute');
    // Approve all answers every card. Auto-approve answers all but a write outside the project folder, which keeps its card.
    if (isOpenMode(mode) && !unreadable) {
      const root = mode === 'auto' && write && reals.length ? await realTarget(path.resolve(cwd)) : null;
      const outsideWrite = root !== null && reals.some(real => !inside(root, real));
      if (!outsideWrite) return true;
    }
    if (typeof ctx?.approve !== 'function') return refused(id, NO_CARD);
    const card = { summary: `Cursor: ${title}`, detail: capDetail(JSON.stringify(input, null, 2)) };
    const answer = await ask(card);
    return answer.allowed ? true : deniedByUser(id, answer.reason, answer.stopped);
  };

  const onPermission = async toolCall => {
    try {
      return await decide(isObject(toolCall) ? toolCall : {});
    } catch (err) {
      return refused(textString(toolCall?.toolCallId), err?.message || 'Plenum could not check this request.');
    }
  };

  const onTool = ev => {
    if (!ev.id) return;
    noteCall(ev);
    if (ev.status === 'running') {
      showCall(ev.id, TOOL_NAME[ev.kind] ?? 'tool', ev.title || ev.kind || 'action');
    } else if (ev.status === 'completed' || ev.status === 'failed') {
      const ok = ev.status === 'completed';
      const result = ev.text || (ev.status === 'failed' ? 'Failed' : 'Done');
      if (showResult(ev.id, ok, result)) {
        // Kept with the reply, as the Claude CLI keeps its steps (lib/claude-cli.mjs), so they are still there after a reload.
        const was = seenCalls.get(ev.id) ?? {};
        ctx?.out?.tools?.push({ name: TOOL_NAME[textString(was.kind)] ?? 'tool', summary: clip(textString(was.title) || textString(was.kind) || 'action', 200), ok, result: clip(result, 300) });
      }
    }
  };

  const job = async (push, abortSignal) => {
    try {
      const result = await runAcp({
        command: name, args: ['acp'], cwd, prompt, signal: abortSignal, label: 'Cursor',
        onText: piece => { text += piece; push(piece); },
        onTool,
        onPermission,
        mcpServers: mcp?.acpServers ?? [],
      });
      if (result.stopReason === 'refusal' && !text) throw new Error('Cursor declined this request.');
      if (!text && calls) push('(Cursor finished without a written reply.)');
    } catch (err) {
      // A failed run with no text that names a sign-in problem gets the plain sign-in message.
      if (!text && !abortSignal.aborted && AUTH_ERROR.test(err?.message ?? '')) throw new Error(SIGN_IN);
      throw err;
    }
  };
  yield* pumped(job, signal);
}

const summaryOf = value => {
  const v = isObject(value?.args) ? value.args : value;
  if (!isObject(v)) return '';
  const key = ['path', 'command', 'pattern', 'query', 'url', 'target_file', 'file_path'].find(k => typeof v[k] === 'string' && v[k]);
  return key ? clip(v[key], 200) : '';
};

// The print transport: `agent -p --output-format stream-json`. Assistant text is the reply; tool_call events are steps; the result
// event says how the run ended. It has no permission requests, so its approval is the flags (see lib/cli-options/cursor.mjs).
// Fits a prompt into the print transport's one argument. A prompt that fits goes whole. A longer one keeps its system text (everything
// before the earlier conversation), a note that earlier messages were cut, the last characters of the earlier conversation and the
// newest message whole, so the end of the chat is never the part that is lost. When the system text and the newest message cannot
// both fit, it throws a plain error and nothing is sent. Exported for the tests.
export function printPromptFor(prompt, max = PRINT_PROMPT_MAX) {
  const text = String(prompt);
  if (text.length <= max) return text;
  const at = text.indexOf(PRINT_EARLIER);
  const cur = text.lastIndexOf(PRINT_CURRENT);
  if (at < 0 || cur < at) throw new Error(PRINT_TOO_LONG);
  const head = text.slice(0, at + 2);
  const newest = text.slice(cur);
  const room = max - head.length - PRINT_CUT.length - newest.length - 2;
  if (room < 0) throw new Error(PRINT_TOO_LONG);
  const earlier = text.slice(at + 2, cur);
  return `${head}${PRINT_CUT}${room > 0 ? earlier.slice(-room) : ''}\n\n${newest}`;
}

// The longest prompt the command line that starts the CLI can carry (see PRINT_PROMPT_MAX).
async function printLimit(name) {
  if (process.platform !== 'win32') return PRINT_PROMPT_MAX;
  const exe = await findExecutable(name);
  return /\.(cmd|bat)$/i.test(exe ?? '') ? PRINT_PROMPT_CMD : PRINT_PROMPT_WIN;
}

async function* printRun({ name, cwd, prompt, signal, mode, readOnly, tools, tell }) {
  const text = printPromptFor(prompt, await printLimit(name));
  if (!readOnly && mode === 'all') tell({ type: 'notice', kind: 'cli-no-ask', text: NOTICE_ALL });
  else if (!readOnly && mode === 'auto') tell({ type: 'notice', kind: 'cli-no-ask', text: NOTICE_AUTO });
  else if (!readOnly && mode === 'ask') tell({ type: 'notice', text: NOTE_ASK_PRINT });
  const args = ['-p', '--output-format', 'stream-json', ...argsFor(tools?.cursor, { transport: 'print', mode }), text];
  let buffer = '';
  let sawText = false;
  let sawTool = false;
  let final = null;
  const calls = new Map();
  const handle = line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return '';
    }
    if (!isObject(ev)) return '';
    if (ev.type === 'assistant') {
      const parts = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const piece = parts.map(p => (isObject(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
      if (piece) sawText = true;
      return piece;
    }
    if (ev.type === 'tool_call') {
      const id = textString(ev.call_id) || textString(ev.id) || textString(ev.tool_call_id);
      const sub = isObject(ev.tool_call) ? ev.tool_call : {};
      const key = Object.keys(sub)[0] ?? '';
      if (!id) return '';
      if (ev.subtype === 'started') {
        sawTool = true;
        calls.set(id, true);
        tell({ type: 'tool', id, name: PRINT_TOOL[key] ?? 'tool', summary: summaryOf(sub[key]) });
      } else if (ev.subtype === 'completed' && calls.has(id)) {
        calls.delete(id);
        const err = isObject(sub[key]?.result) ? sub[key].result.error : null;
        tell({ type: 'tool_result', id, ok: !err, summary: err ? clip(textString(err.message) || 'Failed', 300) : 'Done' });
      }
      return '';
    }
    if (ev.type === 'result') final = ev;
    return '';
  };
  try {
    for await (const chunk of streamProcess({ command: name, args, cwd, signal, hint: CURSOR_HINT })) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const out = handle(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (out && !signal?.aborted) yield out;
      }
    }
    const last = handle(buffer);
    if (last && !signal?.aborted) yield last;
  } catch (err) {
    if (signal?.aborted) return;
    if (!sawText && AUTH_ERROR.test(err?.message ?? '')) throw new Error(SIGN_IN);
    throw err;
  }
  if (signal?.aborted) return;
  if (final?.is_error) {
    const reason = clip(textString(final.result) || 'unknown error', 400);
    if (!sawText && AUTH_ERROR.test(reason)) throw new Error(SIGN_IN);
    if (!sawText) throw new Error(`Cursor stopped with an error: ${reason}`);
    yield `\n\n[Cursor stopped with an error: ${clip(reason, 300)}]`;
    return;
  }
  if (!sawText && textString(final?.result).trim()) {
    yield final.result;
    return;
  }
  if (!sawText && sawTool) yield '(Cursor finished without a written reply.)';
  else if (!sawText && !final) throw new Error('Cursor ended without a reply.');
}

// Runs one Cursor turn and yields its reply text. prompt is the whole prompt (lib/providers.mjs promptText). ctx (optional) is the
// tool context of the run: its approve, root, denyPatterns, mode and scope are used. emit (optional) receives the step events; without
// it, ctx.emit is used. id is always 'default' (the CLI picks its own model; lib/providers.mjs refuses any other id).
export async function* streamCursor({ id, prompt, cwd, signal, ctx, mode = 'ask', readOnly = false, tools, emit, mcp = null } = {}) {
  void id;
  const tell = ev => {
    try {
      (emit ?? ctx?.emit)?.(ev);
    } catch {
      // A broken hook must not break the reply.
    }
  };
  if (signal?.aborted) return;
  if (!String(prompt ?? '').trim()) throw new Error('There is nothing to send to Cursor.');
  const name = await cursorCommand();
  if (!name) throw new Error(CURSOR_HINT);
  await checkVersion(name, signal);
  if (signal?.aborted) return;
  const transport = process.env.MUSE_CONSOLE_CURSOR_TRANSPORT === 'print' ? 'print' : 'acp';
  // A read-only run starts in an empty folder of its own, never the project, and is judged as ask.
  const scratch = readOnly ? await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-readonly-')) : null;
  try {
    const runMode = readOnly ? 'ask' : mode;
    const run = transport === 'print' ? printRun : acpRun;
    yield* run({ name, cwd: scratch ?? cwd, prompt, signal, ctx: readOnly ? null : ctx, mode: runMode, readOnly, tools, tell, mcp: readOnly ? null : mcp });
  } finally {
    if (scratch) await removeScratch(scratch);
  }
}

// Removes a read-only run's scratch folder. Windows refuses while the agent still has it as its working folder, so a refused
// removal is tried again for a moment; the run has already ended the agent (lib/acp.mjs waits for it).
async function removeScratch(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
