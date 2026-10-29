import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, streamProcess } from './proc.mjs';
import { runAcp } from './acp.mjs';
import { openSignIn } from './accounts.mjs';
import { checkAccess } from './guard.mjs';
import { capDetail } from './diff.mjs';
import { argsFor } from './cli-options/grok.mjs';
import { SERVER_NAME } from './mcp-server.mjs';
import { usesCmdShim } from './platform/index.mjs';
import { CREDENTIAL_REFUSED, answersBlocked, blockedAnsweredNotice, cleanReason, commandCredentialHit, denyListHit, isOpenMode, scopeHas } from './tools.mjs';

// Grok Build through its own CLI (`grok`, from x.ai's installer). Two transports:
//   acp    (default) `grok agent stdio`, the Agent Client Protocol over stdio (lib/acp.mjs), the same client Cursor uses (lib/cursor.mjs).
//          Grok Build's permission requests become Plenum's approval cards, so Ask first works: an edit or a command waits for Approve
//          or Deny. Grok Build keeps its own tools.
//   print  `grok -p --output-format streaming-json`, the fallback. It cannot ask, so a call that needs approval fails rather than
//          prompts, and the adapter says so in a notice. MUSE_CONSOLE_GROK_TRANSPORT=print selects it.
// The CLI signs in with the SuperGrok or X Premium Plus account (`grok login`, from Accounts). Every XAI_ and GROK_ variable is removed
// from its environment (lib/proc.mjs childEnv), so a saved xAI key never bills in place of the sign-in. Its own folder ~/.grok is a
// credential folder: Plenum reads only the names of the files in it, to tell whether a sign-in is there.
// A read-only run (a council seat, a relay hop, a compare or pipeline step, plan mode) runs in an empty scratch folder and refuses every
// request. A coder of a build (lib/delegate.mjs) passes its scope in ctx, so a write outside the scope is refused before a card.
// A call of Plenum's own MCP bridge (lib/mcp-server.mjs) is let through without a card only when the bridge is attached to the run, the
// title names one of the bridge's own tools exactly, the kind is "other" or none, and it carries no command and no path; a request merely
// titled "plenum ..." gets the whole decision.
// No flag that turns Grok Build's prompts off is sent on the ACP transport. The print transport sends --always-approve only in Approve
// all (lib/cli-options/grok.mjs), and no approval flag is ever read from a saved setting.

export const GROK_HINT = 'Install Grok Build: on Windows run irm https://x.ai/cli/install.ps1 | iex in PowerShell; on macOS or Linux run curl -fsSL https://x.ai/cli/install.sh | bash';
const SIGN_IN = 'Grok Build is not signed in. Open Accounts and choose "Sign in to Grok Build".';
// Words that mean "sign in" in a failed run. Only a run with no text is judged by them.
const AUTH_ERROR = /not logged in|login required|unauthori[sz]ed|sign in|authenticat/i;
const CREDENTIAL_NAME = /auth|credential|token|session/i;
const GROK_HOME = '.grok';
const READ_ONLY_REFUSED = 'Not allowed in a read-only run.';
const NO_CARD = 'Plenum cannot ask in this run, so the request was refused. Do not retry it.';
const NOTE_PRINT = 'Grok Build in print mode cannot ask for approval; actions that need one fail.';
const NOTICE_ALL = 'In Approve all, Cursor and Grok Build run with their own prompts off. Plenum cannot see or stop those steps; their own settings files still apply. On the print transport (MUSE_CONSOLE_GROK_TRANSPORT=print) the deny list and credential floor do not apply either.';
// The print transport takes the whole prompt as an argument, so the most it may be is set by the command line that carries it: 100,000
// characters elsewhere; on Windows 30,000 for a program of its own (about 32,000 is the limit).
// A .cmd or .bat shim runs through cmd.exe, which cannot pass any of " % ! ^ & | < > (lib/proc.mjs cmdArg) and refuses a line of 8,191
// characters or more. Every prompt Plenum builds has a double quote, so on a shim the print transport is refused up front, before a
// process starts, with a plain message (CMD_PROMPT_MAX is the length at which a prompt with none of those characters is refused too).
const PRINT_PROMPT_MAX = 100_000;
const PRINT_PROMPT_WIN = 30_000;
const CMD_UNSAFE = /["%!^&|<>]/;
const CMD_PROMPT_MAX = 8_000;
const PRINT_NEEDS_EXE = 'The print transport needs grok.exe on Windows. Use the ACP transport.';
const PRINT_EARLIER = '\n\nEarlier in this conversation';
const PRINT_CURRENT = 'Current request:\n';
const PRINT_CUT = 'Earlier messages were cut to fit Grok Build\'s print transport.\n\n';
const PRINT_TOO_LONG = 'The newest message is too long for Grok Build\'s print transport on this system (its command line holds a limited number of characters). Shorten it, or use the ACP transport.';
const TOOL_NAME = { read: 'Read', edit: 'Edit', execute: 'Bash', search: 'Grep', fetch: 'WebFetch' };
// The kinds that change files, so their paths are checked as writes.
const WRITE_KINDS = new Set(['edit', 'write', 'delete', 'move']);
// A call of the Plenum bridge asks its own cards inside the call (the site, the impact, the start card), so the CLI's permission request
// for it is not asked a second time. A title is text, so the shortcut is narrow (cursor.mjs has the same rule): the bridge must be
// attached to this run, the title must be the server name and then exactly one tool the bridge registers (plenum__<tool>, the MCP form
// mcp__plenum__<tool>, or the same with another separator such as a colon or a space), the kind must be "other" or none, and the call must
// carry no command and no path. A request that fails any of these goes through the whole decision like every other request, the
// unreadable rule included. BRIDGE_TOOLS is every tool lib/routes/mcp.mjs can offer (the browser_* tools of lib/browser-tools.mjs, the
// computer_* actions of lib/computer/generic.mjs, delegate, confirm_with_user and hand_over); a test keeps the list in step with them.
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
// Print events whose text is not the reply: tool steps, results, errors, usage and the like.
const NOT_REPLY = /tool|result|error|usage|system|init|status|done|start|stop/i;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const textString = v => (typeof v === 'string' ? v : '');
const inside = (dir, p) => {
  const a = dir.toLowerCase();
  const b = p.toLowerCase();
  return b === a || b.startsWith(a + path.sep);
};

// What a request names, all of it: the raw input's path keys and paths list, the locations the call touches and the diffs in its content.
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

// The Grok Build program on PATH, or null. The name it is started by is always `grok`.
export async function grokCommand() {
  return (await findExecutable('grok')) ? 'grok' : null;
}

// True when a file directly under ~/.grok has a name that reads as a sign-in (auth, credential, token or session). Only the names are
// read: no file is opened. A missing folder, or one that cannot be read, says nothing.
async function hasSignInFile() {
  try {
    const entries = await fs.readdir(path.join(os.homedir(), GROK_HOME), { withFileTypes: true });
    return entries.some(e => e.isFile() && CREDENTIAL_NAME.test(e.name));
  } catch {
    return false;
  }
}

// { installed, signedIn, email } for Accounts and the model picker. signedIn is true when a sign-in file is there, else null: Plenum
// cannot read the sign-in, so "not signed in" is never claimed here, and the first reply says when a sign-in is needed. email is null.
export async function grokStatus() {
  const installed = Boolean(await grokCommand());
  const signedIn = (await hasSignInFile()) ? true : null;
  return { installed, signedIn, email: null };
}

// Opens a terminal running `grok login` (the CLI opens the browser for the sign-in). Nothing is sent here.
export async function grokSignIn() {
  if (!(await grokCommand())) throw new Error(GROK_HINT);
  await openSignIn('grok', ['login'], 'Grok Build sign-in');
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
    // What the request names, all of it: the command and every path.
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
    // with no kind keeps its card in every mode, Approve all included.
    const unreadable = !command && targets.length === 0 && (!kind || WRITE_KINDS.has(kind) || kind === 'execute');
    // Approve all answers every card. Auto-approve answers all but a write outside the project folder, which keeps its card.
    if (isOpenMode(mode) && !unreadable) {
      const root = mode === 'auto' && write && reals.length ? await realTarget(path.resolve(cwd)) : null;
      const outsideWrite = root !== null && reals.some(real => !inside(root, real));
      if (!outsideWrite) return true;
    }
    if (typeof ctx?.approve !== 'function') return refused(id, NO_CARD);
    const card = { summary: `Grok Build: ${title}`, detail: capDetail(JSON.stringify(input, null, 2)) };
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
        // Kept with the reply, so the steps are still there after a reload (as lib/cursor.mjs keeps them).
        const was = seenCalls.get(ev.id) ?? {};
        ctx?.out?.tools?.push({ name: TOOL_NAME[textString(was.kind)] ?? 'tool', summary: clip(textString(was.title) || textString(was.kind) || 'action', 200), ok, result: clip(result, 300) });
      }
    }
  };

  const job = async (push, abortSignal) => {
    try {
      const result = await runAcp({
        command: name, args: ['agent', 'stdio'], cwd, prompt, signal: abortSignal, label: 'Grok Build',
        onText: piece => { text += piece; push(piece); },
        onTool,
        onPermission,
        mcpServers: mcp?.acpServers ?? [],
      });
      if (result.stopReason === 'refusal' && !text) throw new Error('Grok Build declined this request.');
      if (!text && calls) push('(Grok Build finished without a written reply.)');
    } catch (err) {
      // A failed run with no text that names a sign-in problem gets the plain sign-in message.
      if (!text && !abortSignal.aborted && AUTH_ERROR.test(err?.message ?? '')) throw new Error(SIGN_IN);
      throw err;
    }
  };
  yield* pumped(job, signal);
}

// Fits a prompt into the print transport's one argument. A prompt that fits goes whole. A longer one keeps its system text, a note that
// earlier messages were cut, the last characters of the earlier conversation and the newest message whole. When the system text and the
// newest message cannot both fit, it throws a plain error and nothing is sent. Exported for the tests.
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

// True when the Grok Build program is a .cmd or .bat shim, which Windows runs through cmd.exe (see PRINT_PROMPT_MAX).
async function behindCmdShim(name, platform) {
  return platform === 'win32' && usesCmdShim((await findExecutable(name)) ?? '', platform);
}

// The text a parsed print event carries as its reply, or '' when it carries none. The field names of `grok -p --output-format
// streaming-json` are not in the official docs, so this reads defensively: a string in text, content, delta or message is reply text,
// and so is a list of text parts under message.content. Tool, result, error and usage events are never reply text.
function replyOf(ev) {
  if (typeof ev.type === 'string' && NOT_REPLY.test(ev.type)) return '';
  for (const key of ['text', 'content', 'delta', 'message']) {
    const v = ev[key];
    if (typeof v === 'string' && v) return v;
  }
  const msg = ev.message;
  if (isObject(msg)) {
    if (typeof msg.text === 'string' && msg.text) return msg.text;
    if (Array.isArray(msg.content)) {
      return msg.content.map(p => (isObject(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
    }
  }
  return '';
}

async function* printRun({ name, cwd, prompt, signal, mode, readOnly, tools, tell, platform = process.platform }) {
  const text = printPromptFor(prompt, platform === 'win32' ? PRINT_PROMPT_WIN : PRINT_PROMPT_MAX);
  // Refused before anything starts: a prompt cmd.exe cannot carry would otherwise fail inside the launch (lib/proc.mjs cmdArg).
  if ((CMD_UNSAFE.test(text) || text.length >= CMD_PROMPT_MAX) && (await behindCmdShim(name, platform))) throw new Error(PRINT_NEEDS_EXE);
  if (!readOnly) tell({ type: 'notice', text: NOTE_PRINT });
  if (!readOnly && mode === 'all') tell({ type: 'notice', kind: 'cli-no-ask', text: NOTICE_ALL });
  const args = ['-p', text, '--output-format', 'streaming-json', '--no-auto-update', ...argsFor(tools?.grok, { transport: 'print', mode, readOnly, platform })];
  let buffer = '';
  let sawText = false;
  let failure = '';
  let final = null;
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
    if (ev.type === 'error' || ev.is_error === true) {
      failure = textString(ev.message) || textString(ev.error?.message) || textString(ev.error) || textString(ev.result) || failure;
    }
    if (ev.type === 'result') final = ev;
    const piece = replyOf(ev);
    if (piece) sawText = true;
    return piece;
  };
  try {
    for await (const chunk of streamProcess({ command: name, args, cwd, signal, hint: GROK_HINT })) {
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
  if (final?.is_error === true || failure) {
    const reason = clip(failure || textString(final?.result) || 'unknown error', 400);
    if (!sawText && AUTH_ERROR.test(reason)) throw new Error(SIGN_IN);
    if (!sawText) throw new Error(`Grok Build stopped with an error: ${reason}`);
    yield `\n\n[Grok Build stopped with an error: ${clip(reason, 300)}]`;
    return;
  }
  if (!sawText && textString(final?.result).trim()) {
    yield final.result;
    return;
  }
  if (!sawText) throw new Error('Grok Build ended without a reply.');
}

// Runs one Grok Build turn and yields its reply text. prompt is the whole prompt (lib/providers.mjs promptText). ctx (optional) is the
// tool context of the run: its approve, root, denyPatterns, mode and scope are used. emit (optional) receives the step events; without
// it, ctx.emit is used. id is always 'default' (the CLI picks its own model; lib/providers.mjs refuses any other id).
export async function* streamGrok({ id, prompt, cwd, signal, ctx, mode = 'ask', readOnly = false, tools, emit, mcp = null } = {}) {
  void id;
  const tell = ev => {
    try {
      (emit ?? ctx?.emit)?.(ev);
    } catch {
      // A broken hook must not break the reply.
    }
  };
  if (signal?.aborted) return;
  if (!String(prompt ?? '').trim()) throw new Error('There is nothing to send to Grok Build.');
  const name = await grokCommand();
  if (!name) throw new Error(GROK_HINT);
  if (signal?.aborted) return;
  const transport = process.env.MUSE_CONSOLE_GROK_TRANSPORT === 'print' ? 'print' : 'acp';
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
