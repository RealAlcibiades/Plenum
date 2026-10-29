import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, keyRoutesFrom, killTree, resolveLaunch, startChild, stripAnsi } from './proc.mjs';
import { get as stateNow } from './store.mjs';
import { agentShellTools, installHint } from './platform/index.mjs';
import { checkAccess } from './guard.mjs';
import { APP_ROOT } from './updates.mjs';
import { scopeAbs, scopeHas, normalizeScope, checkpointFile, denyListHit, commandCredentialHit, CREDENTIAL_REFUSED, cleanReason, cutFull, isOpenMode, answersBlocked, blockedAnsweredNotice } from './tools.mjs';
import { goneError, looksGone } from './sessions.mjs';
import { argsFor, runnableSettings } from './cli-options/claude.mjs';
import { capDetail, replaceText, unifiedDiff } from './diff.mjs';
import { reportUsage, tokensFromAnthropic } from './pricing.mjs';
import { imageBlocks } from './images.mjs';
import { pdfRefusal } from './attachments.mjs';
import { callerLine } from './collab.mjs';

// lib/agents.mjs reads lib/providers.mjs when it loads, and providers.mjs imports this file, so it is imported when a run needs it, never
// at load time.
let agentsLib = null;
const agentsApi = () => (agentsLib ??= import('./agents.mjs'));

// Claude through the Claude Code CLI (`claude`), signed in with the user's Claude account, in place
// of the Anthropic API. The CLI runs the tools itself and streams JSON events. Anything it wants
// permission for arrives here as a request, which becomes an approval card (or is allowed at once
// in auto-approve mode and in Approve all).
// The CLI is never started with a flag that skips its permission prompt (--permission-mode bypassPermissions,
// --dangerously-skip-permissions): Plenum answers the prompt itself in every mode, and that answer is where checkAccess, the
// credential-folder check, the deny list and the checkpoints run. Approve all changes only how the answer is given.
// Auto-approve still asks for a write outside the project folder; Approve all answers that card too.
// Agents (lib/agent-run.mjs). An agent that Plenum's runner starts on this route (ctx.agent) gets only the tools its type allows
// (cliToolsFor) and is held to its type in answer(): a read type cannot write, a type without commands cannot run one, an edit type
// writes inside its scope. The main chat can start Plenum's agent types as Claude Code subagents (ctx.agentsOffer, from offerFor): they are
// listed in the agents file, each Agent request is counted and gated by onAgent, and the two CLAUDE_CODE_MAX_* variables set the CLI's own
// depth and concurrency to the same numbers. The step limit is counted by the runner, not passed as --max-turns: the recorded
// `claude --help` (2.1.296) does not list that flag.
// Seats (agent-roles). A read-only run (a council seat, the moderator, a relay hop, a compare column or a pipeline step) whose ctx came
// from seatContext (ctx.seatOnly) and holds an offer gets `--tools Agent` and the agents file, and nothing else: it stays in plan mode
// with no allow entries and runs in its scratch folder. Its subagents are the offered types that read and run no commands, and they
// may read (Read, Glob, Grep) only inside the project folder, after checkAccess; every other request, and every request from the seat
// itself, is refused. Each offered type's prompt names the project folder, because the subagent reads by absolute path.

// The command tools are Bash everywhere, and PowerShell as well on Windows (see agentShellTools in lib/platform/index.mjs).
// The main chat's tools. Agent (Claude Code's subagent tool) is added only when the run has something to offer (ctx.agentsOffer).
const CHAT_TOOLS = `Read,Glob,Grep,Edit,Write,NotebookEdit,${agentShellTools()},WebFetch,WebSearch`;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const DENIED = 'The user denied this. Do not retry it; ask what they would like instead.';
// What the user typed when denying a card (approvalRequester in server.mjs puts it on the card), added to the text the model reads.
const userSaid = card => { const why = cleanReason(card.reason); return why ? ` The user said: ${why}` : ''; };
const READ_ONLY_DENIED = 'This run is read-only, so it cannot change files or run commands. Do not retry it; describe the change in your reply instead.';
const SIGN_IN = 'Claude Code is not signed in. Open Accounts and choose "Sign in to Claude Code".';
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const under = (dir, p) => {
  const a = dir.toLowerCase();
  const b = p.toLowerCase();
  return b === a || b.startsWith(a + path.sep);
};

// ---------- which route, and sign-in state ----------

// 'cli' (Claude Code with the subscription) or 'api' (the saved Anthropic key). The choice in Accounts (keyRoutes.claude, see
// keyRoutesFrom in lib/proc.mjs) is used as it was made. With no choice (null, the default) it is 'cli' when the Claude CLI is
// installed and 'api' otherwise. MUSE_CONSOLE_CLAUDE=api|cli forces one; the tests use it.
export async function claudeRoute() {
  const forced = process.env.MUSE_CONSOLE_CLAUDE;
  if (forced === 'api' || forced === 'cli') return forced;
  const choice = keyRoutesFrom(stateNow()).claude;
  if (choice) return choice;
  return (await findExecutable('claude')) ? 'cli' : 'api';
}

const AUTH_FRESH_MS = 20_000;
let authSeen = null;

function capture(command, args, timeoutMs = 15_000) {
  return new Promise(async resolve => {
    const launch = await resolveLaunch(command, args).catch(() => null);
    if (!launch) return resolve({ code: null, output: '' });
    const child = startChild('claude', launch, { env: cliKeyEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, output: '' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output: out }); });
  });
}

// { installed, loggedIn, email, plan }. Asking the CLI takes a moment, so the answer is kept briefly.
export async function claudeCliStatus({ fresh = false } = {}) {
  if (!(await findExecutable('claude'))) return { installed: false, loggedIn: false };
  if (!fresh && authSeen && Date.now() - authSeen.at < AUTH_FRESH_MS) return authSeen.value;
  const { output } = await capture('claude', ['auth', 'status']);
  let info = {};
  try {
    info = JSON.parse(output);
  } catch {
    // An older CLI prints text; treat it as signed out rather than guess.
  }
  const value = { installed: true, loggedIn: info.loggedIn === true, email: info.email ?? null, plan: info.subscriptionType ?? null };
  authSeen = { at: Date.now(), value };
  return value;
}

// The CLI signs in with the Claude account. API keys stay out of its environment (childEnv('claude') removes them in
// startChild), so a saved key is never billed by accident, and nothing here adds one for the app.
// MUSE_CONSOLE_TEST_ONLY_CLI_KEY is for tests only: the test that runs the real CLI sets it, and its value is passed as
// ANTHROPIC_API_KEY on top of that environment. A normal user never sets it.
function cliKeyEnv() {
  return process.env.MUSE_CONSOLE_TEST_ONLY_CLI_KEY ? { ANTHROPIC_API_KEY: process.env.MUSE_CONSOLE_TEST_ONLY_CLI_KEY } : {};
}

// ---------- limits ----------

let limitsSeen = null;
const LIMITS_FRESH_MS = 5 * 60 * 1000;

// The CLI mentions the plan's limits in passing while it works; the latest mention is kept for /usage.
function noteLimit(info) {
  if (!info || typeof info !== 'object') return;
  limitsSeen ??= { observedAt: 0, byType: {} };
  limitsSeen.observedAt = Date.now();
  limitsSeen.byType[info.rateLimitType ?? 'limit'] = info;
}

const LIMIT_NAMES = { five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit', overage: 'Extra usage' };

export const CLAUDE_NOT_SEEN = 'Not seen yet. Refresh to ask.';

// peek: the limits the last reply reported, read from memory. It starts no process at all (not the sign-in check and not the
// small request), so the plan meter can poll it. Without peek, the sign-in is checked and, when no reply is recent, one very
// small request is sent.
export async function claudeCliUsage({ peek = false } = {}) {
  if (peek) {
    if (!limitsSeen) return { unavailable: CLAUDE_NOT_SEEN };
    return limitsReading(authSeen?.value?.plan ?? null);
  }
  const status = await claudeCliStatus();
  if (!status.loggedIn) return { unavailable: SIGN_IN };
  // The limits arrive with replies, so when none is recent this sends one very small request.
  if (!limitsSeen || Date.now() - limitsSeen.observedAt > LIMITS_FRESH_MS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      for await (const _text of streamClaudeCli({ id: 'claude-haiku-5-5', prompt: 'Reply with the single word ok.', cwd: os.tmpdir(), signal: ac.signal, effort: 'low' })) { /* only the limits matter */ }
    } catch (err) {
      if (!limitsSeen) return { unavailable: `Claude did not report its limits: ${String(err.message).split('\n')[0].slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
    }
  }
  if (!limitsSeen) return { unavailable: 'Claude answered but did not report plan limits for this account.' };
  return limitsReading(status.plan);
}

// The remembered limits as { observedAt, plan, windows, facts }. limitsSeen must be set.
function limitsReading(plan) {
  const windows = [];
  const facts = [];
  for (const [type, info] of Object.entries(limitsSeen.byType)) {
    const name = LIMIT_NAMES[type] ?? type.replace(/_/g, ' ');
    const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null;
    if (typeof info.utilization === 'number') windows.push({ name, usedPercent: Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization), resetsAt });
    else facts.push([name, [info.status === 'allowed' ? 'Within limit' : String(info.status ?? 'reported').replace(/_/g, ' '), resetsAt ? `resets ${new Date(resetsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''].filter(Boolean).join(', ')]);
  }
  return { observedAt: limitsSeen.observedAt, plan, windows, facts };
}

// ---------- describing tool calls ----------

function shortPath(p, cwd) {
  if (typeof p !== 'string') return '';
  const abs = path.resolve(cwd, p);
  return under(cwd, abs) ? path.relative(cwd, abs) || '.' : abs;
}

function describe(name, input, cwd) {
  switch (name) {
    case 'Bash':
    case 'PowerShell': return clip(String(input.command ?? ''), 200);
    case 'Read':
    case 'Edit':
    case 'Write': return shortPath(input.file_path, cwd);
    case 'NotebookEdit': return shortPath(input.notebook_path, cwd);
    case 'Glob': return clip(String(input.pattern ?? ''), 200);
    case 'Grep': return clip(`${input.pattern ?? ''}${input.path ? `  in ${shortPath(input.path, cwd)}` : ''}`, 200);
    case 'WebFetch': return clip(String(input.url ?? ''), 200);
    case 'WebSearch': return clip(String(input.query ?? ''), 200);
    case 'Agent': return clip(`${input.subagent_type ?? 'agent'}: ${input.description ?? ''}`, 200);
    default: return clip(JSON.stringify(input ?? {}), 200);
  }
}

const VERBS = { Bash: 'Run command', PowerShell: 'Run command', Read: 'Read file', Edit: 'Edit file', Write: 'Write file', NotebookEdit: 'Edit notebook', Glob: 'Find files', Grep: 'Search', WebFetch: 'Fetch page', WebSearch: 'Search the web' };

// The text of a write or an edit card before the cap. diff.mjs builds the same text, but its file reader and its line
// numbering are not exported, so they are repeated here (a test checks that the two agree).
const COMPARE_MAX = 2_000_000; // the largest file a card compares (diff.mjs)

// The file as it is now: { text } when it can be compared, { missing: true } when there is no file, else { why }.
async function fileNow(file) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return { why: 'it is not a file' };
    if (st.size > COMPARE_MAX) return { why: 'it is too large to compare' };
    const text = await fs.readFile(file, 'utf8');
    return text.includes('\u0000') ? { why: 'it is not a text file' } : { text };
  } catch (err) {
    return err.code === 'ENOENT' ? { missing: true } : { why: 'it could not be read' };
  }
}

// The lines of a text as a card counts them: a final newline does not start another line.
function linesOf(text) {
  const lines = text ? text.split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const numbered = lines => {
  const width = String(Math.max(lines.length, 1)).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}  ${line.replace(/\r$/, '')}`).join('\n');
};

// A write: a diff against the file as it is now, or, for a new file, its content with line numbers.
async function writeText(file, content, label) {
  const cur = await fileNow(file);
  if (cur.missing) {
    if (!content) return 'Creates an empty file.';
    const lines = linesOf(content);
    return `Creates a new file, ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} (${Buffer.byteLength(content)} bytes):\n\n${numbered(lines)}`;
  }
  if (cur.text === undefined) return `Replaces the existing file, which is not shown as a diff because ${cur.why}. New content:\n\n${numbered(linesOf(content))}`;
  if (cur.text === content) return 'Replaces the existing file with the same content, so nothing changes.';
  return `Replaces the existing file.\n\n${unifiedDiff(cur.text, content, label)}`;
}

// An edit: the diff of the file before and after the replacement. When the file cannot be compared or the old text is not
// in it, only the two snippets are shown, and the text says so.
async function editText(file, oldText, newText, replaceAll, label) {
  const cur = await fileNow(file);
  if (cur.text !== undefined) {
    const { updated, count } = replaceText(cur.text, oldText, newText, replaceAll);
    if (count) return unifiedDiff(cur.text, updated, label);
  }
  const why = cur.missing ? 'The file does not exist'
    : cur.text !== undefined ? 'The old text was not found in the file'
      : `The file was not compared, because ${cur.why}`;
  return `${why}. Only the two snippets are shown.\n\n${unifiedDiff(oldText, newText, label)}`;
}

// The card shows the capped text. When the cap cut lines off, the whole text comes along as fullDetail, as planEdit does in
// tools.mjs. Only GET /api/approve/detail serves it, and only while the approval waits (server.mjs).
function cardDetail(full) {
  const detail = capDetail(full);
  return detail.length < full.length ? { detail, fullDetail: cutFull(full) } : { detail };
}

// What the approval card shows under its heading: the exact command or change. A write or an edit shows a diff
// against the file as it is now, with line numbers (see diff.mjs). Only those two can carry fullDetail.
async function detail(name, input, cwd) {
  if (name === 'Bash' || name === 'PowerShell') return { detail: capDetail(String(input.command ?? '')) };
  if (name === 'Write' || name === 'Edit') {
    const file = path.resolve(cwd, String(input.file_path ?? ''));
    const label = shortPath(input.file_path, cwd);
    if (name === 'Write') return cardDetail(await writeText(file, String(input.content ?? ''), label));
    return cardDetail(await editText(file, String(input.old_string ?? ''), String(input.new_string ?? ''), !!input.replace_all, label));
  }
  return { detail: capDetail(JSON.stringify(input ?? {}, null, 2)) };
}

const resultText = content => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(b => (b?.type === 'text' ? b.text : `[${b?.type ?? 'data'}]`)).join('\n') : '');

// Follows symlinks as far as the path exists, so the guard judges where a write would really land.
async function realTarget(abs) {
  let tail = '';
  let dir = abs;
  for (;;) {
    try {
      return path.join(await fs.realpath(dir), tail);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      tail = path.join(path.basename(dir), tail);
      dir = parent;
    }
  }
}

async function filesUnder(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(full, base, out);
    else if (entry.isFile() && out.length < 60) out.push({ path: path.relative(base, full).split(path.sep).join('/'), content: await fs.readFile(full, 'utf8') });
  }
  return out;
}

// ---------- agents ----------

// An agent that runs on this route (ctx.agent), and a Claude Code subagent that Plenum defines (ctx.agentsOffer.types), is limited by its
// type: a read type cannot write, a type without commands cannot run one, a type that edits writes inside its scope (and inside the
// type's folders), and the main chat's own tools are unchanged. Claude Code's built-in subagents keep the behaviour they always had.
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const COMMAND_REFUSED = 'A delegated coder cannot run commands, because a command can change files outside its scope. Describe what should be checked in your reply instead.';
const agentCommandRefused = label => `${label} cannot run commands, because a command can change files outside its scope. Describe what should be checked in your reply instead.`;
const readAgentDenied = label => `${label} is a read-only agent: it cannot change files. Describe the change in your reply instead.`;
const NO_AGENTS = 'This agent cannot start agents.';
const CODER_TOOLS = 'Read,Glob,Grep,Edit,Write,NotebookEdit';
// Subagent statuses that mean it has finished.
const DONE_TASK = new Set(['completed', 'failed', 'killed', 'stopped', 'error']);

const modelId = ref => String(ref).slice(String(ref).indexOf(':') + 1);

// The tools Claude Code is given (--tools) for an agent of this type: file access gives Read, Glob and Grep; a type that edits adds Edit,
// Write and NotebookEdit; commands add the shell tools; the web adds WebFetch and WebSearch. A type with no file access gets none.
// `nested` adds the Agent tool, for an agent that may start agents of its own.
export function cliToolsFor(type, { nested = false } = {}) {
  const list = [];
  if (type?.files) {
    list.push('Read', 'Glob', 'Grep');
    if (type.kind === 'edit') list.push('Edit', 'Write', 'NotebookEdit');
    if (type.commands) list.push(...agentShellTools().split(','));
    if (type.web) list.push('WebFetch', 'WebSearch');
  }
  if (nested) list.push('Agent');
  return list.join(',');
}

// One entry of the agents file (--agents): a subagent the main chat can hand work to. A seat's subagent (seatRoot is the project folder)
// is given the read tools only and told where the project is, since the seat itself runs in a scratch folder. The seat's caller (a council
// seat, a relay hop, a column or a step) is named in that subagent's prompt too (lib/collab.mjs), so its report is read as one model's.
export function subagentFor(type, cwd, { agentSystem }, { seatRoot = null, caller = null } = {}) {
  const tools = cliToolsFor(type).split(',').filter(Boolean);
  return {
    description: `${type.description}${type.kind === 'edit' ? ' Its prompt must start with a line "Scope: <project-relative files or folders, comma separated>", and it can only write inside that scope.' : ''} Run it in the foreground (not in the background).`,
    prompt: seatRoot
      ? `${agentSystem(type, { root: cwd })}${callerLine(caller) ? `\n\n${callerLine(caller)}` : ''}\n\nProject folder: ${seatRoot}\nOpen files by their absolute path inside that folder. You may read only inside it.`
      : agentSystem(type, { root: cwd }),
    tools: seatRoot ? tools.filter(t => READ_TOOLS.has(t)) : tools,
    ...(type.model ? { model: modelId(type.model) } : {}),
  };
}

// What the agents file holds. A run whose ctx has no agentsOffer at all (an older caller) is offered the shipped Coder, as it always was;
// a run that was given an offer (the server gives one, or undefined when nothing may be offered) is offered exactly the types in it.
async function agentsFileObject(ctx, cwd) {
  const lib = await agentsApi();
  if (!('agentsOffer' in ctx)) return { coder: subagentFor(lib.resetTypeTo('coder'), cwd, lib) };
  const out = {};
  const seatRoot = ctx.seatOnly === true ? String(ctx.root ?? '') : null;
  for (const [name, type] of ctx.agentsOffer?.types ?? []) out[name] = subagentFor(type, cwd, lib, { seatRoot: seatRoot || null, caller: ctx.caller ?? null });
  return out;
}

// The Scope line a subagent that edits starts with. Without one it cannot write files or run commands. `folders` are the type's own
// folders: every scope entry must lie in one of them.
async function scopeFromPrompt(prompt, cwd, folders = []) {
  const line = String(prompt ?? '').match(/^\s*Scope:\s*(.+)$/im);
  if (!line) {
    return { error: 'This coder has no Scope line, so it cannot write files or run commands. Its prompt must start with a line "Scope: <files or folders>".' };
  }
  try {
    const rel = await normalizeScope(cwd, line[1].split(',').map(s => s.trim()).filter(Boolean));
    const stray = folders.length ? rel.find(r => !folders.some(f => r === f || r.startsWith(`${f}/`))) : null;
    if (stray) return { error: `The agent\'s Scope line is not allowed: scope "${stray}" is outside the folders this type may write in: ${folders.join(', ')}.` };
    return { rel, abs: scopeAbs(await fs.realpath(cwd), rel) };
  } catch (err) {
    return { error: `The coder\'s Scope line is not allowed: ${err.message}` };
  }
}

const outsideScope = (rel, target) => `This task may change only: ${rel.join(', ')}. ${target} is outside that, so the write was not made. Do not retry it. Change only files inside the scope, or say in your reply what else is needed.`;

const rmDirs = dirs => Promise.all(dirs.filter(Boolean).map(d => fs.rm(d, { recursive: true, force: true }).catch(() => {})));

// A scoped run (a delegated coder) is always in manual mode with no write or command allow entries, so each of its
// writes reaches answer(), where the scope is checked.
function scopedClaude(settings) {
  const s = runnableSettings(settings);
  const plain = t => t.split('(')[0];
  return { ...s, permissionMode: 'manual', allowedTools: s.allowedTools.filter(t => !WRITE_TOOLS.has(plain(t)) && !COMMAND_TOOLS.has(plain(t))) };
}

// A read-only run (council seat, planner, reviewer) is in plan mode with no allow entries, whatever the settings say.
function readOnlyClaude(settings) {
  return { ...runnableSettings(settings), permissionMode: 'plan', allowedTools: [] };
}

// ---------- the run ----------

// Yields the reply text. ctx (optional) turns tools on and receives tool steps and approvals:
// { mode, emit, approve, queueUpdate, out }. Without ctx the reply is text only (advisor, /compact).
// readOnly (council seats, planner, reviewer): plan mode, no tools, no allow entries, and any request that still
// arrives is refused.
// sessionId (native mode): the first turn starts that session with --session-id; resume (true after that)
// continues it with --resume, and the prompt is then only the new message.
// onUsage (optional) gets { at, input, cached, output } once, from the usage block of the CLI's result event: the tokens the
// whole run used. A run signed in with a Claude account is plan use, so this is tokens only. The result event also carries
// a dollar figure (total_cost_usd); it is deliberately not read, and no dollar amount is ever shown for plan use.
// images (optional) are sent as image content blocks in front of the text in the user message of the stream-json input. The
// text is written as before, and the images are not kept anywhere.
// documents (PDFs) are not sent through the CLI in Plenum yet (its stdin document block is not documented): a call that
// arrives with any is refused before the CLI is started. Text files are in the prompt already.
export async function* streamClaudeCli({ id, prompt, cwd, signal, effort, ctx, sessionId, resume = false, readOnly = false, tools, onUsage, images, documents, mcp = null }) {
  if (documents?.length) throw new Error(pdfRefusal(documents.length === 1 ? documents[0].name : ''));
  // An agent that Plenum's runner started (ctx.agent, lib/agent-run.mjs) gets the tools its type allows and nothing else. A delegated coder
  // from an older caller (ctx.scope with no agent) gets the coder tools. Neither gets a staging folder; their writes are scope-checked instead.
  const agent = ctx?.agent && typeof ctx.agent === 'object' ? ctx.agent : null;
  const scoped = !!ctx?.scope;
  // A read-only run gets no staging folder either, because it cannot write.
  const contained = Boolean(agent) || scoped || readOnly;
  // The project's Claude options (tools.claude) as CLI flags. Read before any folder is created, so bad settings leave none behind.
  const cliFlags = argsFor(readOnly ? readOnlyClaude(tools?.claude) : (agent || scoped) ? scopedClaude(tools?.claude) : tools?.claude, { cwd, mode: ctx?.mode, mcp: mcp?.descriptor });
  const staging = ctx && !contained ? await fs.mkdtemp(path.join(os.tmpdir(), 'muse-console-update-')) : null;
  // The subagents this run may start are listed in a file of its own (--agents): the main chat's offer (every type its row of Limits lists
  // that runs on a Claude model), or the nested read-only types of an agent. With nothing to offer there is no Agent tool at all.
  const offer = ctx?.agentsOffer;
  // A seat (agent-roles) is a read-only run whose ctx came from seatContext; it is offered the Agent tool only when the offer holds a type.
  const seatOffered = Boolean(ctx) && readOnly && !agent && !scoped && ctx.seatOnly === true && Boolean(offer?.types?.size);
  const offered = seatOffered || (Boolean(ctx) && !readOnly && (agent ? Boolean(offer?.types?.size) : (!scoped && (offer ? Boolean(offer.types?.size || offer.cliSubagents) : !('agentsOffer' in ctx)))));
  const agentsDir = offered ? await fs.mkdtemp(path.join(os.tmpdir(), 'muse-console-agents-')) : null;
  const agentsFile = agentsDir ? path.join(agentsDir, 'agents.json') : null;
  const agentsObject = agentsFile ? await agentsFileObject(agent ? { agentsOffer: offer } : ctx, cwd) : null;
  if (agentsFile) await fs.writeFile(agentsFile, JSON.stringify(agentsObject));
  const toolList = !ctx || readOnly ? (seatOffered ? 'Agent' : '') : agent ? cliToolsFor(agent, { nested: offered }) : scoped ? CODER_TOOLS : `${CHAT_TOOLS}${offered ? ',Agent' : ''}`;
  // A native session must be saved to disk, or --resume could not find it, so --no-session-persistence is left out then.
  const args = ['-p', '--model', id, '--effort', effort, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', ...(sessionId ? [] : ['--no-session-persistence']),
    ...cliFlags, '--tools', toolList];
  if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);
  if (agentsFile && Object.keys(agentsObject).length) args.push('--agents', agentsFile);
  const launch = await resolveLaunch('claude', args);
  if (!launch) await rmDirs([staging, agentsDir]);
  if (!launch) throw new Error(`The Claude CLI is not installed. Install it with: ${installHint('@anthropic-ai/claude-code')}`);
  // The only variables added to the child are the key the tests set and the two numbers that cap Claude Code's own subagents.
  const child = startChild('claude', launch, { cwd, env: { ...cliKeyEnv(), ...(offered && offer?.env ? offer.env : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  let spawnError = null;
  const closed = new Promise(resolve => {
    child.on('close', resolve);
    child.on('error', err => { spawnError = err; resolve(null); });
  });
  const stop = () => killTree(child);
  signal?.addEventListener('abort', stop, { once: true });
  const send = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);

  // Muse Console's own files are changed through the Updates panel, so Claude is pointed at a
  // staging folder; whatever it writes there is queued as an update when the run ends.
  const note = staging
    ? `Note from Plenum: its own source folder (${APP_ROOT}) is read-only to you. To change Plenum itself, write each complete new file under ${staging} using the same relative path (for example ${path.join(staging, 'public', 'style.css')}); the user reviews and applies those files in the Updates panel.\n\n`
    : '';
  send({ type: 'user', message: { role: 'user', content: images?.length ? [...imageBlocks(images), { type: 'text', text: note + prompt }] : note + prompt } });

  // Subagents are matched to the Agent call that started them, so their steps and requests can be scoped.
  const agentInput = new Map(); // Agent tool_use id -> its input
  const agentType = new Map(); // Agent tool_use id -> subagent type
  const taskCall = new Map(); // subagent task id -> Agent tool_use id
  const parentOf = new Map(); // tool_use id inside a subagent -> Agent tool_use id
  const subagentOf = request => {
    const callId = (request.agent_id && taskCall.get(request.agent_id)) || parentOf.get(request.tool_use_id);
    if (!callId) return null;
    return { type: agentType.get(callId) ?? null, prompt: String(agentInput.get(callId)?.prompt ?? '') };
  };

  const answer = async request => {
    const { tool_name: name } = request;
    // B-82. A missing input is an empty one, as before. A null or other non-object input is refused below, before any card, so
    // no later read of input.file_path can throw (the default in a destructuring applies to undefined only).
    const input = request.input === undefined ? {} : request.input;
    const allow = { behavior: 'allow', updatedInput: input };
    const deny = message => ({ behavior: 'deny', message });
    // A read-only run has no tools, so nothing should ask. If a request still comes, it is refused before any approval. A seat that may
    // start agents (ctx.seatOnly) is the one exception: its Agent requests go through the offer, and a subagent of a type that reads and
    // runs no commands may read inside the project folder. Everything else stays refused.
    if (readOnly) {
      if (ctx?.seatOnly !== true || input === null || typeof input !== 'object') return deny(READ_ONLY_DENIED);
      if (name === 'Agent') {
        if (!ctx.agentsOffer) return deny(NO_AGENTS);
        const r = await ctx.agentsOffer.onAgent({ type: input.subagent_type, toolUseId: request.tool_use_id, title: input.description });
        return r && r.allow === false ? deny(r.message) : allow;
      }
      const sub = subagentOf(request);
      const ptype = sub && ctx.agentsOffer?.types?.get(sub.type);
      if (!ptype || ptype.kind !== 'read' || ptype.commands || !READ_TOOLS.has(name)) return deny(READ_ONLY_DENIED);
      const outside = `${ptype.label} may read only inside the project folder: ${ctx.root}.`;
      // A Glob pattern that names a place of its own (a drive, a home folder or a parent) could leave the folder whatever path it is given.
      if (name === 'Glob') {
        const pattern = String(input.pattern ?? '');
        if (path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.startsWith('~') || pattern.split(/[\\/]+/).includes('..')) return deny(outside);
      }
      const given = input.file_path ?? input.path;
      const blank = typeof given !== 'string' || !given.trim();
      // A Glob or Grep with no path searches the project folder, not the scratch folder the seat runs in.
      if (blank) return name === 'Read' ? deny(outside) : { behavior: 'allow', updatedInput: { ...input, path: ctx.root } };
      const abs = await realTarget(path.resolve(cwd, given));
      try {
        checkAccess(abs);
      } catch (err) {
        return deny(err.message);
      }
      return under(await realTarget(path.resolve(ctx.root)), abs) ? allow : deny(outside);
    }
    if (input === null || typeof input !== 'object') return deny('This tool request had no readable input, so it was refused. Do not retry it; ask what the user would like instead.');
    // Starting a subagent needs no card here: the offer decides (the type, the depth, the totals and the places), and each write or
    // command the subagent makes is checked on its own. A run with no offer key at all (an older caller) may start the coder; a run
    // that was given none, and an agent that may not start agents, may not.
    if (name === 'Agent') {
      if (ctx.agentsOffer) {
        const r = await ctx.agentsOffer.onAgent({ type: input.subagent_type, toolUseId: request.tool_use_id, title: input.description });
        return r && r.allow === false ? deny(r.message) : allow;
      }
      return agent || 'agentsOffer' in ctx ? deny(NO_AGENTS) : allow;
    }
    const sub = subagentOf(request);
    // A Plenum type that runs as a subagent is held to its type (an older caller's coder is the shipped Coder). Claude Code's own
    // subagents and the main chat are not. An agent run is held to its own type, and so are the subagents it starts.
    const subType = sub ? (ctx.agentsOffer?.types?.get(sub.type) ?? (!('agentsOffer' in ctx) && sub.type === 'coder' ? (await agentsApi()).resetTypeTo('coder') : null)) : null;
    const held = subType ?? agent;
    const write = WRITE_TOOLS.has(name);
    const command = COMMAND_TOOLS.has(name);
    if (held) {
      if (write && (held.kind !== 'edit' || !held.files)) return deny(readAgentDenied(held.label));
      if (command && !held.commands) return deny(agentCommandRefused(held.label));
    }
    // The scopes a write must stay in, all of them: a delegated task's (an editing agent's), and an editing subagent's Scope line.
    const scopes = [];
    if (ctx.scope) scopes.push(ctx.scope);
    if (subType?.kind === 'edit') scopes.push(await scopeFromPrompt(sub.prompt, cwd, subType.folders));
    const bad = scopes.find(sc => sc.error);
    if (bad) {
      if (write || command) return deny(bad.error);
    } else if (scopes.length && command && !held?.commands) {
      return deny(COMMAND_REFUSED);
    }
    const target = input.file_path ?? input.notebook_path ?? input.path;
    const abs = typeof target === 'string' ? await realTarget(path.resolve(cwd, target)) : null;
    // Scope comes before any approval: a write outside it is refused here, and the model is told why.
    if (!bad && write) {
      const miss = scopes.find(sc => !(abs && scopeHas(sc.abs, abs)));
      if (miss) return deny(outsideScope(miss.rel, String(target ?? '(no path)')));
    }
    if (typeof target === 'string') {
      // The staging folder is temporary and outside the project, so a write there gets no checkpoint.
      if (write && staging && under(await realTarget(staging), abs)) return allow;
      if (write && under(APP_ROOT, abs)) {
        return deny(`Plenum's own files are not written directly. Write the complete new file to ${path.join(staging, path.relative(APP_ROOT, abs))} instead.`);
      }
      try {
        // copyRoot is the folder the CLI runs in (a thread's isolated copy, or the project folder): a write into another thread's copy is refused in every mode (pro-02).
        checkAccess(abs, { write, copyRoot: cwd });
      } catch (err) {
        return deny(err.message);
      }
    }
    // B-17. A command that names a credential folder is refused before any card, in every mode (the floor), the same as
    // run_command in tools.mjs. cwd is the project folder, so it stands in when ctx has no root.
    if (COMMAND_TOOLS.has(name) && commandCredentialHit(String(input.command ?? '').trim(), { root: ctx.root ?? cwd })) return deny(CREDENTIAL_REFUSED);
    // A command that matches the deny list (built-in rules plus the project's own patterns in ctx.denyPatterns) always
    // asks, in auto and all mode too, and Deny is the default. Only a project that turned on "Approve all also answers
    // blocked-command cards" has this card answered for it, and only in Approve all. cwd is the project folder, so it stands
    // in when ctx has no root.
    if (COMMAND_TOOLS.has(name)) {
      const hit = denyListHit(String(input.command ?? '').trim(), undefined, ctx.root ? ctx : { ...ctx, root: cwd });
      if (hit && answersBlocked(ctx)) {
        ctx.emit?.({ type: 'notice', text: blockedAnsweredNotice(hit.card.rule) });
        return allow;
      }
      if (hit) return (await ctx.approve(hit.card)) ? allow : deny(hit.refusal + userSaid(hit.card));
    }
    // Every write that is allowed is checkpointed first (see checkpoints.mjs), which never throws.
    // Known limit: the CLI writes the file itself after this allows the request, so, unlike write_file and edit_file in
    // tools.mjs, this route cannot compare the file with what the card showed. A file that changes between the card and
    // the CLI's write is overwritten with the newer content, and only the checkpoint keeps what it replaced.
    const allowChecked = async () => {
      if (write && abs) await checkpointFile({ projectId: ctx.projectId, projectPath: cwd, absPath: abs, label: `${name} ${shortPath(target, cwd)}` });
      return allow;
    };
    // Auto-approve and Approve all answer ordinary cards at once. A write outside the project folder is the exception in auto:
    // it shows its card (the card names the path). Approve all answers it.
    const outsideWrite = ctx.mode === 'auto' && write && abs && !under(await realTarget(path.resolve(cwd)), abs);
    if (isOpenMode(ctx.mode) && !outsideWrite) return allowChecked();
    const label = subType ? `${subType.label}: ` : '';
    const card = { summary: `${label}${VERBS[name] ?? name}: ${describe(name, input, cwd)}`, ...(await detail(name, input, cwd)) };
    const allowed = await ctx.approve(card);
    return allowed ? allowChecked() : deny(DENIED + userSaid(card));
  };

  // B-82, hardening: an error thrown while one request is answered refuses that request only. Without this the throw ends the
  // whole run, and the CLI is killed before it can get a control response.
  const answerSafely = async request => {
    try {
      return await answer(request);
    } catch {
      return { behavior: 'deny', message: 'Plenum could not decide this request, so it was refused. Do not retry it; ask what the user would like instead.' };
    }
  };

  const calls = new Map();
  let wrote = '';
  let final = null;
  let synthetic = '';
  // Subagents still running. The main reply can finish while a background coder works on, and that coder's
  // permission requests need the stream open, so the input closes only when nothing is left running.
  const openTasks = new Set();
  let grace = null;
  // B-50. Once the input is closed the CLI should exit by itself. If it does not, it is killed 10 seconds later: the stdout loop
  // then ends, and the reply that came only in the result still reaches the chat. The timer is cleared when the run ends.
  let exitWait = null;
  const closeInput = () => {
    child.stdin.end();
    exitWait ??= setTimeout(() => killTree(child), 10_000);
    exitWait.unref?.();
  };
  const endWhenIdle = () => {
    if (!final) return;
    if (openTasks.size === 0) {
      closeInput();
      return;
    }
    grace ??= setTimeout(closeInput, 15 * 60_000);
    grace.unref?.();
  };
  try {
    // B-80. The text of the line being read is kept in pieces and joined only when its newline arrives, so each chunk is searched
    // once. Joining the whole line on every chunk copied it again each time, which made a long line cost time in its square.
    let parts = [];
    for await (const chunk of child.stdout) {
      let start = 0;
      let end;
      while ((end = chunk.indexOf('\n', start)) >= 0) {
        parts.push(chunk.slice(start, end));
        const line = parts.join('');
        parts = [];
        start = end + 1;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
          const ev = msg.event;
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && wrote && !wrote.endsWith('\n\n')) {
            const gap = wrote.endsWith('\n') ? '\n' : '\n\n';
            wrote += gap;
            yield gap;
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            wrote += ev.delta.text;
            yield ev.delta.text;
          }
        } else if (msg.type === 'assistant') {
          const blocks = msg.message?.content ?? [];
          if (msg.message?.model === '<synthetic>') synthetic = resultText(blocks);
          // Steps inside a subagent carry the id of the Agent call that started it; they are shown nested under it.
          const parent = msg.parent_tool_use_id || undefined;
          for (const b of blocks) {
            if (b.type !== 'tool_use' || !ctx) continue;
            if (parent) parentOf.set(b.id, parent);
            if (b.name === 'Agent') agentInput.set(b.id, b.input ?? {});
            if (calls.has(b.id)) continue;
            const call = { name: b.name, summary: describe(b.name, b.input ?? {}, cwd), parent };
            calls.set(b.id, call);
            ctx.emit({ type: 'tool', id: b.id, name: b.name, summary: call.summary, ...(parent ? { parent } : {}) });
          }
        } else if (msg.type === 'system' && msg.subtype === 'task_started' && ctx) {
          // A subagent has started: remember its type, so its permission requests can be scoped.
          agentType.set(msg.tool_use_id, msg.subagent_type ?? null);
          taskCall.set(msg.task_id, msg.tool_use_id);
          openTasks.add(msg.task_id);
        } else if (msg.type === 'system' && (msg.subtype === 'task_notification' || (msg.subtype === 'task_updated' && DONE_TASK.has(msg.patch?.status)))) {
          openTasks.delete(msg.task_id);
          endWhenIdle();
        } else if (msg.type === 'user' && ctx) {
          for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            const call = b.type === 'tool_result' && calls.get(b.tool_use_id);
            if (!call || call.done) continue;
            call.done = true;
            if (call.name === 'Agent') ctx.agentsOffer?.onAgentDone?.(b.tool_use_id, !b.is_error);
            const result = clip(resultText(b.content).trim(), 300);
            const nest = call.parent ? { parent: call.parent } : {};
            ctx.emit({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, summary: result, ...nest });
            ctx.out.tools.push({ name: call.name, summary: call.summary, ok: !b.is_error, result, ...nest });
          }
        } else if (msg.type === 'control_request') {
          const known = msg.request?.subtype === 'can_use_tool' && ctx;
          const response = known
            ? { subtype: 'success', request_id: msg.request_id, response: await answerSafely(msg.request) }
            : { subtype: 'error', request_id: msg.request_id, error: 'Plenum does not handle this request.' };
          send({ type: 'control_response', response });
        } else if (msg.type === 'rate_limit_event') {
          noteLimit(msg.rate_limit_info);
        } else if (msg.type === 'result') {
          final = msg;
          endWhenIdle();
        }
      }
      if (start < chunk.length) parts.push(chunk.slice(start));
    }
    const code = await closed;
    if (spawnError) throw spawnError;
    // Reported before the checks below, so a run that ended in an error still counts the tokens it used.
    const tokens = tokensFromAnthropic(final?.usage);
    if (tokens) reportUsage(onUsage, { at: Date.now(), ...tokens });
    if (signal?.aborted) return;
    const said = String(final?.result ?? synthetic ?? '');
    // The saved session is gone. Nothing was shown yet, so the caller can start a fresh session.
    if (resume && !wrote.trim() && looksGone(`${said}\n${stderr}`)) throw goneError('Claude has no saved session with that id.');
    if (/not logged in|please run \/login|invalid api key|authentication/i.test(said) && !wrote.trim()) {
      authSeen = null;
      throw new Error(SIGN_IN);
    }
    if (final?.is_error && !wrote.trim()) throw new Error(`Claude stopped with an error: ${clip(said || final.subtype || 'unknown', 400)}`);
    if (!final && code !== 0 && !wrote.trim()) {
      throw new Error(`claude exited with code ${code}${stderr.trim() ? `:\n${stripAnsi(stderr).trim().slice(-1500)}` : ''}`);
    }
    // Text that arrived only in the final result (no streamed pieces) still reaches the chat.
    if (!wrote.trim() && said.trim() && !final?.is_error) yield said;
  } finally {
    clearTimeout(grace);
    clearTimeout(exitWait);
    signal?.removeEventListener('abort', stop);
    killTree(child);
    // A seat's Agent call that never got its result (the process was stopped) ends here, so its agent leaves the windows' lists.
    if (seatOffered) {
      for (const [id, call] of calls) {
        if (call.name !== 'Agent' || call.done) continue;
        call.done = true;
        try {
          ctx.agentsOffer.onAgentDone?.(id, false);
        } catch {
          // The offer is already gone.
        }
      }
    }
    await rmDirs([agentsDir]);
    if (staging) {
      try {
        const files = await filesUnder(staging);
        if (files.length && !signal?.aborted) {
          const queued = await ctx.queueUpdate({ summary: `Changes to Plenum proposed by Claude (${files.length} file${files.length === 1 ? '' : 's'})`, files });
          ctx.emit({ type: 'tool', id: queued.id, name: 'propose_update', summary: queued.summary });
          ctx.emit({ type: 'tool_result', id: queued.id, ok: true, summary: 'Queued. Open Updates to review and apply.' });
          ctx.out.tools.push({ name: 'propose_update', summary: queued.summary, ok: true, result: 'Queued. Open Updates to review and apply.' });
        }
      } catch (err) {
        ctx.emit({ type: 'error', message: `The proposed update could not be queued: ${err.message}` });
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
