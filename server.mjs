import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as store from './lib/store.mjs';
import * as events from './lib/events.mjs';
import { checkRequest, ensureToken, isRefusal, tokenSource, token } from './lib/auth.mjs';
import {
  CATALOG, ALIASES, parseRef, splitRef, labelFor, streamChat, providerStatus, ADVISOR_SYSTEM, advisorMessages, historyFor,
  anthropicKey, testAnthropicKey, EFFORTS, billingFor,
} from './lib/providers.mjs';
import { summarizeUsage, totalUsage } from './lib/pricing.mjs';
import { runCli, openSignIn, museSignedIn } from './lib/accounts.mjs';
import { assertCanSave, connectKeyChannel, parentChannel, storeKey } from './lib/keys.mjs';
import { expandFileMentions, listTree, workingDiff } from './lib/files.mjs';
import { queueUpdate, listUpdates, applyUpdate, discardUpdate, rollbackUpdate, resetOverlay, overlayStatus, acknowledgeRollback } from './lib/updates.mjs';
import * as overlay from './lib/overlay.mjs';
import { readUsage } from './lib/usage.mjs';
import { claudeRoute, claudeCliStatus } from './lib/claude-cli.mjs';
import { cleanReason } from './lib/tools.mjs';
import { DEFAULT_COUNCIL, normalizeCouncil, runCouncil } from './lib/council.mjs';
import { CODER_REFS, planBuild, runBuild } from './lib/delegate.mjs';
import { geminiSignIn, geminiUsage } from './lib/gemini.mjs';
import { normalizeRoute, runSend, runBroadcast, runRoute, RelayLog, hashText } from './lib/relay.mjs';
import { effectiveSettings, denyPatternsOf, chatModeOf } from './lib/projects.mjs';
import { forgetProjectSessions, forgetSession } from './lib/sessions.mjs';
import { keepArchive, peekArchive } from './lib/archive.mjs';
import { accrueReply, budgetState, checkBudget, spendOf } from './lib/budget.mjs';
import { findExtRoute } from './lib/routes/index.mjs';
import { folderRisk } from './lib/guard.mjs';
import { buildSystem } from './lib/prompt.mjs';
import { apiProvider } from './lib/api-providers.mjs';
import { loadProjectRules } from './lib/rules.mjs';
import { IMAGE_REFUSAL, MAX_IMAGES, checkImages, takesImages } from './lib/images.mjs';
import { checkMessageTotals, describeUploads, pdfRefusal, sortAttachments, splitUploads, takesDocuments, withInline } from './lib/attachments.mjs';

// Under the desktop app this is an Electron utility process, which ends with the app, and the app sends it the saved API
// keys over its message channel (see connectKeyChannel at the bottom). The Electron binary is also what process.execPath
// names here, and the update check runs it as plain Node, so child processes are told to run it that way.
if (process.parentPort) process.env.ELECTRON_RUN_AS_NODE = '1';
// A launcher that runs the server as an ordinary child with a stdin pipe sets MUSE_CONSOLE_CHILD. If it goes away, the pipe
// closes and the server stops too, so it never blocks the port for the next start.
if (process.env.MUSE_CONSOLE_CHILD === '1') {
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4317;
// Host and Origin must match exactly. This blocks DNS rebinding and cross-site requests.
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
// Long audits at high effort can run for well over an hour; this only stops a run that is truly stuck.
const RUN_TIMEOUT_MS = 3 * 60 * 60 * 1000;
// The page counts down from the same five minutes (APPROVAL_SECONDS in public/app.js). PLENUM_APPROVAL_TIMEOUT_MS can only
// shorten it, for a test that has to see a card time out; a value outside 200 ms to 5 minutes is ignored.
const APPROVAL_TIMEOUT_MS = (() => {
  const ms = Number(process.env.PLENUM_APPROVAL_TIMEOUT_MS);
  return Number.isInteger(ms) && ms >= 200 && ms <= 5 * 60 * 1000 ? ms : 5 * 60 * 1000;
})();
// A chat message may carry up to 25 MB of files, which is about 33 MB in base64, and up to 14 million characters of text sit
// beside them in the same body; every other body is held to 16 MB.
const BODY_LIMIT = 16_000_000;
const CHAT_BODY_LIMIT = 40_000_000;
const THEMES = ['system', 'dark', 'light'];
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Static files come from this fixed map, so no request path is joined onto the disk. The file for an entry is found on each request
// (lib/overlay.mjs): the active applied update's copy when it has one, else the shipped file in public/.
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/markdown.js': { file: 'markdown.js', type: 'text/javascript; charset=utf-8' },
  '/music.js': { file: 'music.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/icon.png': { file: 'icon.png', type: 'image/png' },
  '/mark.svg': { file: 'mark.svg', type: 'image/svg+xml' },
};
// Files are read on each request, so interface changes show up on the next reload.
function staticAsset(pathname) {
  if (!Object.hasOwn(STATIC, pathname)) return null;
  const { file, type } = STATIC[pathname];
  return { file: overlay.filePath(`public/${file}`), type };
}

// Project id -> AbortController for the run in progress. One run per project.
const running = new Map();
// Approval id -> { finish, fullDetail } for a tool call waiting on the user. fullDetail is the whole diff when the card shows a capped one, else null.
const pendingApprovals = new Map();
// Said once at the start of every chat turn in a project that is in plan mode.
const PLAN_NOTICE = 'Plan mode: Plenum will not edit files or run commands in this project.';
// Said when a build is asked for in a project that is in plan mode (a build runs coders that write files).
const PLAN_BUILD_REFUSED = 'This project is in plan mode, so Plenum will not build or edit files. Turn plan mode off to build.';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// The version the events channel reports in its hello event, read once. A window that sees a different startedAt after a
// reconnect knows the server restarted (an applied update) and reloads itself.
const VERSION = await fs.readFile(path.join(overlay.APP_ROOT, 'package.json'), 'utf8').then(text => {
  try {
    return String(JSON.parse(text).version ?? '');
  } catch {
    return '';
  }
}, () => '');

// Extra panels and styles: plain names only (ext.js, ext-*.js, ext-*.css), served from public/.
async function extAsset(pathname) {
  const m = /^\/((?:ext-)?[a-z0-9-]{1,60}\.(?:js|css))$/.exec(pathname);
  if (!m) return null;
  const file = overlay.filePath(`public/${m[1]}`);
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  return { file, type: m[1].endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Large pasted documents are allowed (about 16 MB of JSON); anything bigger is refused with a clear message.
    if (size > limit) throw httpError(413, `That message is over ${limit / 1_000_000} MB. Split it up or attach the file with @path instead.`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  // Node's parse error can quote part of the input (a key, in a malformed key request), so its text is never sent back.
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'The request body is not valid JSON.');
  }
}

const projectId = abs => createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 12);

const findLastIndex = (list, pred) => {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
};

async function resolveFolder(input) {
  const raw = String(input ?? '').trim().replace(/^["']+|["']+$/g, '');
  if (!raw) throw httpError(400, 'Give a folder path, for example C:\\Projects\\my-app');
  if (!path.isAbsolute(raw)) throw httpError(400, 'Use an absolute path, for example C:\\Projects\\my-app');
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw httpError(400, 'Network (UNC) paths are not allowed.');
  const abs = await fs.realpath(raw).catch(() => null);
  if (!abs) throw httpError(400, `Folder not found: ${raw}`);
  if (!(await fs.stat(abs)).isDirectory()) throw httpError(400, `Not a folder: ${abs}`);
  if (path.parse(abs).root === abs) throw httpError(400, 'Drive roots are not allowed. Pick a project folder.');
  if (/\\(windows|program files( \(x86\))?|programdata)(\\|$)/.test(abs.toLowerCase())) {
    throw httpError(400, 'System folders are not allowed.');
  }
  // Home, Plenum's own folder, and any parent of a credential folder are refused, with the reason folderRisk gives.
  const risk = folderRisk(abs);
  if (risk) throw httpError(400, risk);
  return abs;
}

// The saved council, read through normalizeCouncil before use. A hand-edited state.json with a council that is not
// valid (for example one with no moderator) gets a plain message instead of a crash.
function savedCouncil() {
  try {
    return normalizeCouncil(store.get().council ?? DEFAULT_COUNCIL);
  } catch (err) {
    throw httpError(400, `The saved council is not valid: ${err.message} Open the Council panel and save a valid one.`);
  }
}

function projectById(id) {
  const project = store.get().projects.find(p => p.id === id);
  if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
  return project;
}

// Music settings: the style is whatever key the browser's music engine offers (checked there).
const MUSIC_DEFAULT = { on: false, style: 'synth', volume: 60, effects: true };
const RELAY_DEFAULT = { autoRoute: false, countdownSec: 3, hops: null, stopOnError: true, dedupe: false };
function normalizeMusic(m) {
  const style = typeof m.style === 'string' && /^[a-z0-9-]{1,24}$/.test(m.style) ? m.style : MUSIC_DEFAULT.style;
  const volume = Math.min(100, Math.max(0, Math.round(Number(m.volume ?? MUSIC_DEFAULT.volume)) || 0));
  return { on: m.on === true, style, volume, effects: m.effects !== false };
}

// messages: false leaves the transcript out and says how long it is (messageCount) and when its last message was written
// (lastMessageTs) instead. That is the state the events channel carries (lib/events.mjs), so a window reads the whole
// transcript only when it has changed.
function publicState({ messages = true } = {}) {
  const st = store.get();
  const active = st.projects.find(p => p.id === st.activeProject) ?? null;
  // st.chats is read directly so that asking for the count does not create an empty transcript.
  const log = active ? (messages ? store.transcript(active.id) : (st.chats?.[active.id] ?? [])) : [];
  return {
    // chatMode is 'normal' or 'plan' (see chatModeOf). The plan button in public/ext-plan.js reads it from here.
    projects: st.projects.map(p => ({ id: p.id, name: p.name, path: p.path, chatMode: chatModeOf(p) })),
    // Each project's running total of tokens and cost, by project id, worked out from the replies still in its transcript
    // (totalUsage in lib/pricing.mjs). public/ext-cost.js shows it. st.chats is read directly so that listing a project
    // does not create an empty transcript for it. It is kept out of the project entries, which carry no counters.
    usage: Object.fromEntries(st.projects.map(p => [p.id, totalUsage(st.chats?.[p.id])])),
    activeProject: active?.id ?? null,
    running: active ? running.has(active.id) : false,
    // The chat that /clear or /compact replaced, while Undo can still put it back (lib/archive.mjs). Only its summary goes out.
    archive: active ? peekArchive(active.id) : null,
    model: st.model,
    advisor: st.advisor,
    advisorAuto: st.advisorAuto,
    approvals: st.approvals,
    // How many approval cards are waiting for Approve or Deny now. The desktop app counts it to alert the user (desktop/alerts.cjs).
    approvalsWaiting: pendingApprovals.size,
    effort: st.effort,
    theme: st.theme,
    council: st.council ?? DEFAULT_COUNCIL,
    music: st.music ?? MUSIC_DEFAULT,
    relay: st.relay ?? RELAY_DEFAULT,
    sessionMode: st.sessionMode ?? 'transcript',
    coders: CODER_REFS,
    ...(messages ? { messages: log } : { messageCount: log.length, lastMessageTs: log.at(-1)?.ts ?? 0 }),
  };
}

// A chosen theme is written into the page itself, so it never flashes the other theme while loading.
function withTheme(html) {
  const { theme } = store.get();
  return theme === 'dark' || theme === 'light' ? html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`) : html;
}

// Asks the user to approve a tool action. Resolves true/false, and false on timeout or stop.
// A denial can carry the user's reason: finish puts it on the payload (the card object the caller passed), where the caller
// reads it. Only the answer is resolved, so a reason can never turn a denial into an approval.
function approvalRequester(send, signal) {
  return payload => new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    const approvalId = randomUUID();
    let expired = false;
    let settled = false;
    const finish = (allow, reason = '') => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(approvalId);
      if (!allow && reason) payload.reason = reason;
      resolve(allow);
      // Every window is told how the card ended, so one that did not answer it can replace the card. Said once.
      if (settled) return;
      settled = true;
      events.publish({ type: 'approval', action: allow ? 'answered' : (expired ? 'expired' : signal.aborted ? 'stopped' : 'answered'), approvalId, allow });
      events.publishState('approvals');
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => { expired = true; finish(false); }, APPROVAL_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    // fullDetail stays here and is never sent with the card: GET /api/approve/detail serves it, and only while the approval is waiting.
    const fullDetail = typeof payload.fullDetail === 'string' && payload.fullDetail ? payload.fullDetail : null;
    pendingApprovals.set(approvalId, { finish, fullDetail });
    // defaultDeny and blocked come from a deny list card (denyListHit in lib/tools.mjs). A plain card carries neither.
    send({
      type: 'approval',
      approvalId,
      summary: payload.summary,
      detail: payload.detail ?? '',
      ...(fullDetail ? { hasMore: true } : {}),
      ...(payload.defaultDeny ? { defaultDeny: true } : {}),
      ...(payload.blocked ? { blocked: true } : {}),
    });
    events.publishState('approvals');
  });
}

// The model that wrote the newest chat reply in this project. A CLI session resumes only if its own seat wrote it.
function lastChatModel(projectId) {
  const log = store.transcript(projectId);
  for (let i = log.length - 1; i >= 0; i--) if (log[i].role === 'assistant' && log[i].kind === 'chat') return log[i].model ?? null;
  return null;
}

// tools is the project's CLI options (effectiveSettings(...).tools). Only a chat turn passes it; the advisor stays read-only.
// denyPatterns is the project's own list (denyPatternsOf), added to the built-in deny list for every command this turn runs.
// readOnly is a chat turn in a project in plan mode, and every advisor call (a review or the auto-advisor), whether or not
// the project is in plan mode: streamChat gets readOnly, no ctx (so an API model gets no tools) and no
// native session (a resumed Codex session keeps the sandbox it started with, and a plan turn must not replace that session).
async function runTurn({ ref, system, messages, root, kind, projectId: pid, mode, effort, send, signal, requestApproval, agent, tools, denyPatterns = [], readOnly = false, images = [], documents = [] }) {
  send({ type: 'start', kind, model: ref, label: labelFor(ref) });
  const out = { api: [], tools: [] };
  const ctx = {
    root,
    projectId: pid, // files the checkpoints taken before a write (lib/checkpoints.mjs)
    denyPatterns, // the project's own deny patterns, read by denyListHit (lib/tools.mjs)
    mode,
    signal,
    out,
    emit: send,
    approve: requestApproval,
    queueUpdate: payload => queueUpdate({ home: store.HOME, summary: payload.summary, files: payload.files }),
    tools, // read by the delegate tool, which hands it on to the coder
  };
  let text = '';
  let error = false;
  // 'length' when the reply stopped at the model's output limit (see onStop in streamChat). The page marks such a reply.
  let stop = null;
  // One record per model request that reported its tokens (see onUsage in streamChat). They become the reply's usage below.
  const reports = [];
  try {
    const session = kind === 'chat' && !readOnly ? { projectId: pid, emit: send, lastReplyModel: lastChatModel(pid) } : null;
    for await (const delta of streamChat(ref, { system, messages, cwd: root, signal, ctx: agent ? ctx : undefined, mode, effort, readOnly, session, tools, images, documents, onUsage: rec => reports.push(rec), onStop: r => { stop = r; } })) {
      text += delta;
      send({ type: 'delta', text: delta });
    }
  } catch (err) {
    if (!signal.aborted) {
      error = true;
      send({ type: 'error', message: err.message });
    }
  }
  // A run that finished with nothing to show is reported, not silently dropped.
  if (!error && !signal.aborted && !text.trim() && !out.tools.length) {
    error = true;
    send({ type: 'error', message: `${labelFor(ref)} finished without a reply. Try again, or lower the effort (the Effort selector).` });
  }
  const api = out.api.length ? out.api : null;
  // What the reply used and cost (summarizeUsage in lib/pricing.mjs): tokens and an estimated price for an API model,
  // tokens only for a subscription CLI, and null for the offline echo model. A reply whose model reported no tokens is
  // kept as "not reported". A run that was stopped or failed is marked partial, since its last request may have used
  // tokens that were never reported.
  const usage = summarizeUsage(ref, reports, { billing: await billingFor(ref), partial: signal.aborted || error });
  // The reply's cost goes into the project's running spend once, here, before the reply is stored, so a spend record that
  // starts now begins from the transcript without this reply (lib/budget.mjs). A subscription CLI reply adds nothing.
  accrueReply(projectById(pid), store.transcript(pid), usage);
  if (text.trim() || out.tools.length || api) {
    store.addMessage(pid, {
      role: 'assistant',
      kind,
      model: ref,
      content: text,
      ...(out.tools.length ? { tools: out.tools } : {}),
      ...(api ? { api } : {}),
      ...(usage ? { usage } : {}),
      ...(stop ? { stop } : {}),
      ...(signal.aborted ? { aborted: true } : {}),
    });
  }
  return { text, error, usage, stop };
}

// A project at its spend cap refuses a send to an API-key model before anything is stored or any provider is called
// (lib/budget.mjs). The refusal is a 400 with the plain message. A subscription CLI and the offline model are never refused.
async function refuseAtCap(project, messages, ref) {
  const billing = await billingFor(ref);
  try {
    checkBudget(project, messages, billing);
  } catch (err) {
    throw httpError(400, err.message);
  }
}

// Chat turns and /review share this path. /review reviews the last answer plus the working-tree diff, and streams the
// answer as server-sent events. A message that arrives while the project is running is refused with 409. Follow-ups
// typed during a run wait in the page, which sends each one as a normal message when the run before it ends, so every
// message has its own stream for its approval cards.
async function handleTurn(req, res, { review }) {
  const body = await readBody(req, CHAT_BODY_LIMIT);
  const project = projectById(body.project);
  if (running.has(project.id)) throw httpError(409, 'This project is already running. Use /cancel first.');

  const ac = new AbortController();
  running.set(project.id, ac);
  events.publishState('run');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, RUN_TIMEOUT_MS);
  let streaming = false;
  // Every event of the run is also published on the events channel with the run's id, so another window can show the run
  // as it goes. The stream here carries the same events, each with that id.
  const runId = randomUUID();
  const tagged = events.tag(runId, project.id, review ? 'review' : 'chat');
  const send = obj => {
    const ev = tagged(obj);
    if (streaming && !res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    const st = store.get();
    const log = store.transcript(project.id);
    const root = project.path;
    let ref;
    let kind;
    let system;
    let messages;
    let question = '';
    let agent = false;
    let rules = null;
    // Notices from prompt parts (a part that failed is left out of the prompt). They are sent once the reply's stream opens.
    const promptNotices = [];
    let planMode = false;
    // Pictures and PDFs that came with this message (never kept: the transcript gets their names and sizes, see below).
    let images = [];
    let documents = [];

    if (review) {
      const answerIdx = findLastIndex(log, m => m.role === 'assistant' && m.kind === 'chat');
      if (answerIdx < 0) throw httpError(400, 'Nothing to review yet. Send a message first.');
      const questionIdx = findLastIndex(log.slice(0, answerIdx), m => m.role === 'user' && m.kind === 'chat');
      question = questionIdx >= 0 ? log[questionIdx].content : '(question not recorded)';
      ref = body.model ? parseRef(body.model) : st.advisor;
      if (!ref) throw httpError(400, 'Advisor is off. Turn it on with /advisor opus.');
      kind = 'advisor';
      await refuseAtCap(project, log, ref);
      system = await buildSystem('advisor', { root, projectId: project.id, project, ref, base: [ADVISOR_SYSTEM] });
      messages = advisorMessages({ question, answer: log[answerIdx].content, diff: await workingDiff(root), cwd: root });
    } else {
      const text = String(body.message ?? '').trim();
      if (!text) throw httpError(400, 'Empty message.');
      ref = body.model ? parseRef(body.model) : st.model;
      kind = 'chat';
      await refuseAtCap(project, log, ref);
      const { provider } = splitRef(ref);
      const api = apiProvider(provider);
      // Claude (through its API key) and an API provider whose tools are verified (toolsVerified in lib/api-providers.mjs)
      // run the server's own tool loop. The other API providers are text only.
      agent = provider === 'anthropic' || api?.toolsVerified === true;
      // Through the CLI, Claude brings its own tools and reads attached files itself.
      const ownTools = provider === 'anthropic' ? agent && (await claudeRoute()) === 'api' : agent;
      // Plan mode makes this turn read-only: no tool loop (so no ctx reaches streamChat), no tool instructions in the
      // prompt, and no earlier tool turns in the history, which an API request without tools would refuse.
      planMode = chatModeOf(project) === 'plan';
      const toolLoop = ownTools && !planMode;
      if (planMode) agent = false;
      // Files that came in the body: pictures in `images`, anything in `attachments`. Each is judged by its bytes. Text is
      // checked and wrapped here, a PDF is kept for Claude through an API key, and anything else is refused below.
      const uploads = splitUploads(body);
      const sent = Array.isArray(uploads.images) ? uploads.images : [];
      const got = sortAttachments(uploads.files, { counted: sent });
      // Only Claude through an API key takes a PDF.
      const pdfOk = takesDocuments(provider, provider === 'anthropic' ? await claudeRoute() : null);
      // Every API provider reads attached text from the prompt, because it cannot open a file on disk.
      const expanded = await expandFileMentions(text, root, { inline: ownTools || Boolean(api), imageRoom: Math.max(0, MAX_IMAGES - sent.length - got.images.length), takesPdf: pdfOk });
      // Images go only to a model that takes them (Claude or Codex). Any other model is refused before an image is decoded
      // and before anything is stored or sent. A PDF is refused the same way for every model but Claude through an API key.
      if ((sent.length || got.images.length || expanded.images.length || expanded.refused.length) && !takesImages(provider)) throw httpError(400, IMAGE_REFUSAL);
      if (got.documents.length && !pdfOk) throw httpError(400, pdfRefusal(got.documents.length === 1 ? got.documents[0].name : ''));
      const problems = [...expanded.refused, ...expanded.refusedDocuments, ...got.refused];
      if (problems.length) throw httpError(400, problems.join(' '));
      images = checkImages({ sent: uploads.images, named: [...got.images, ...expanded.images] });
      documents = [...got.documents, ...expanded.documents];
      const tooMuch = checkMessageTotals({ images, inline: got.inline, documents });
      if (tooMuch) throw httpError(400, tooMuch);
      question = expanded.text;
      // The text files go into the last user message for every model, after the message itself.
      messages = [...historyFor(log, ref, { textOnly: !toolLoop }), { role: 'user', content: withInline(expanded.text, got.inline) }];
      // The project's AGENTS.md, read on every chat turn so an edit shows on the next message. Null when there is none.
      rules = await loadProjectRules(root);
      system = await buildSystem('chat', { root, projectId: project.id, project, agent: toolLoop, readOnly: planMode, mode: st.approvals === 'auto' ? 'auto' : 'ask', ref, rules, emit: notice => promptNotices.push(notice) });
      // Only the name and size of each picture and file are saved, never its bytes.
      const kept = describeUploads(images, { inline: got.inline, documents });
      store.addMessage(project.id, { role: 'user', kind: 'chat', content: text, attached: expanded.attached, ...(kept.length ? { images: kept } : {}) });
      events.publishState('run');
    }

    streaming = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    // One notice per chat turn in a project in plan mode, then one when the project's AGENTS.md went into the prompt.
    // Same shape as the other notices.
    if (planMode) send({ type: 'notice', text: PLAN_NOTICE });
    if (rules) send({ type: 'notice', text: `Using AGENTS.md (${rules.text.length} characters) from this project.` });
    for (const notice of promptNotices) send(notice);

    const mode = st.approvals === 'auto' ? 'auto' : 'ask';
    const requestApproval = approvalRequester(send, ac.signal);
    // Only a chat turn gets the project's CLI options. A review (advisor) is read-only, like the council and the reviewers.
    // A plan-mode turn gets none either, as no relay hop does: nothing in the options can widen a read-only run.
    const tools = kind === 'chat' && !planMode ? effectiveSettings(st, project).tools : undefined;
    const denyPatterns = kind === 'chat' ? denyPatternsOf(project) : [];
    const turn = await runTurn({
      ref, system, messages, root, kind, projectId: project.id, mode, effort: st.effort, send, signal: ac.signal, requestApproval, agent: agent && kind === 'chat', tools, denyPatterns, readOnly: review || planMode, images, documents,
    });
    // A plan turn runs outside the model's native CLI session, so that session has not seen it. Forgetting the session makes
    // the next normal turn start a new one with the whole chat, plan included.
    if (planMode) forgetSession(project.id, ref);

    let advisorTurn = null;
    if (!review && st.advisor && st.advisorAuto && turn.text.trim() && !turn.error && !ac.signal.aborted) {
      // An advisor billed per token is one more paid call, so a project at its spend cap skips it. The chat reply is already saved.
      const advisorBilling = await billingFor(st.advisor);
      const capped = advisorBilling === 'api' && budgetState(project, log).level === 'cap';
      if (capped) {
        send({ type: 'notice', text: 'Advisor review skipped: this project is at its spend cap.' });
      } else {
        advisorTurn = await runTurn({
          ref: st.advisor,
          system: await buildSystem('advisor', { root, projectId: project.id, project, ref: st.advisor, base: [ADVISOR_SYSTEM] }),
          messages: advisorMessages({ question, answer: turn.text, diff: await workingDiff(root), cwd: root }),
          root,
          kind: 'advisor',
          projectId: project.id,
          mode,
          send,
          signal: ac.signal,
          requestApproval,
          agent: false,
          readOnly: true,
        });
      }
    }
    if (timedOut) {
      // Said in the chat and saved, so a run that hits the limit never just disappears.
      const note = `Stopped after ${RUN_TIMEOUT_MS / 3_600_000} hours, before ${labelFor(ref)} finished. Any files it created or changed are still on disk.`;
      if (turn.text.trim()) {
        send({ type: 'error', message: note });
      } else {
        store.addMessage(project.id, { role: 'assistant', kind: 'chat', model: ref, content: note, aborted: true });
        send({ type: 'delta', text: note });
      }
    }
    // usage is what this turn's reply used and cost (null when no model was called); advisorUsage is the same for the
    // advisor's review when "Review every reply" ran one. The page also reads both from the state it fetches afterwards.
    // stop is 'length' when the reply was cut at the output limit, so the page can offer Continue (public/ext-cutoff.js).
    send({ type: 'done', aborted: ac.signal.aborted, timedOut, usage: turn.usage ?? null, stop: turn.stop ?? null, ...(advisorTurn ? { advisorUsage: advisorTurn.usage ?? null } : {}) });
  } catch (err) {
    if (!streaming) throw err;
    send({ type: 'error', message: err.message });
    // A failed run ends with done too, as streamForProject does, so a window that draws this run from the events channel
    // knows it is over.
    send({ type: 'done', aborted: ac.signal.aborted, timedOut });
  } finally {
    clearTimeout(timer);
    running.delete(project.id);
    events.publishState('run');
    await store.persist();
    if (streaming) res.end();
  }
}

const COMPACT_SYSTEM = [
  'You compress a coding conversation so work can continue from your summary alone.',
  'Write a summary that keeps: what the user is trying to do, decisions made and why, files created or changed (with paths), commands run and their results, problems still open, and the next step.',
  'Quote exact names, paths, values and error messages where they matter. Leave out pleasantries and anything already superseded.',
  'Use short Markdown sections. Do not address the user, ask questions or call tools: output only the summary.',
].join(' ');
const COMPACT_LIMIT = 400_000;
const COMPACT_HEAD = 'Summary of the conversation so far (earlier messages were compacted):';

// The whole chat as plain text, newest kept if it is too long. Tool steps appear as one line each.
function transcriptText(log) {
  const parts = [];
  let size = 0;
  for (const m of [...log].reverse()) {
    if (m.kind !== 'chat') continue;
    const tools = (m.tools ?? []).map(t => `[${t.name}: ${t.summary}${t.ok ? '' : ' (failed)'}]`).join('\n');
    const body = [tools, String(m.content ?? '').slice(0, 20_000)].filter(Boolean).join('\n');
    if (!body) continue;
    const part = `${m.role === 'user' ? 'User' : 'Assistant'}:\n${body}`;
    if (size + part.length > COMPACT_LIMIT) break;
    parts.unshift(part);
    size += part.length;
  }
  return parts.join('\n\n');
}

// /compact: the main model summarises the chat, and the summary replaces it.
async function handleCompact(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  if (running.has(project.id)) throw httpError(409, 'This project is already running. Use /cancel first.');
  const log = store.transcript(project.id);
  const before = log.filter(m => m.kind === 'chat').length;
  if (before < 2) throw httpError(400, 'There is not enough conversation to compact yet.');

  const st = store.get();
  const ac = new AbortController();
  running.set(project.id, ac);
  events.publishState('run');
  // The summary is not streamed, so another window is told only that a compact started and ended.
  const tagged = events.tag(randomUUID(), project.id, 'compact');
  tagged({ type: 'start', kind: 'compact' });
  const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    // The summary is an API call on the main model, so a capped project refuses it the same way (before anything runs).
    // It is checked after the project is marked running, as a chat turn is, so no other run can start during the check.
    await refuseAtCap(project, log, st.model);
    let summary = '';
    const messages = [{ role: 'user', content: `Summarise this conversation.\n\n<<<CONVERSATION\n${transcriptText(log)}\nCONVERSATION>>>` }];
    // In plan mode the summary is written read-only like a plan turn, so a CLI model cannot touch the project folder here.
    const readOnly = chatModeOf(project) === 'plan';
    // The summary's own cost goes into the running spend (lib/budget.mjs) when the call ends, whether or not the summary is kept.
    const reports = [];
    const billing = await billingFor(st.model);
    try {
      const system = await buildSystem('compact', { root: project.path, projectId: project.id, project, ref: st.model, base: [COMPACT_SYSTEM] });
      for await (const delta of streamChat(st.model, { system, messages, cwd: project.path, signal: ac.signal, mode: 'ask', effort: 'low', readOnly, onUsage: rec => reports.push(rec) })) {
        summary += delta;
      }
    } finally {
      accrueReply(project, log, summarizeUsage(st.model, reports, { billing, partial: ac.signal.aborted }));
    }
    if (ac.signal.aborted) throw httpError(499, 'Compacting was cancelled. The chat is unchanged.');
    summary = summary.trim();
    if (!summary) throw httpError(502, `${labelFor(st.model)} returned an empty summary. The chat is unchanged.`);
    keepArchive(project.id, [...log], 'compact');
    log.length = 0;
    forgetProjectSessions(project.id);
    store.addMessage(project.id, { role: 'user', kind: 'chat', compact: true, content: `${COMPACT_HEAD}\n\n${summary}` });
    await store.persist();
    return json(res, 200, { ...publicState(), compacted: before });
  } finally {
    clearTimeout(timer);
    running.delete(project.id);
    tagged({ type: 'done', aborted: ac.signal.aborted });
    events.publishState('run');
  }
}

// ---------- council, build and plan ----------

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' };
const PLAN_TIMEOUT_MS = 10 * 60 * 1000;

// Runs one generator as a server-sent stream for a project. makeRun checks its input and may save
// the question first; anything it throws before the stream starts is answered as plain JSON.
// kind names the run on the events channel (lib/events.mjs): 'council', 'build', 'relay', or what a route module passes as
// { kind } in the last argument ('run' when none is given). Every event of the run carries the run's id, in the stream and there.
async function streamForProject(req, res, project, makeRun, onEvent, { kind = 'run' } = {}) {
  if (running.has(project.id)) throw httpError(409, 'This project is already running. Use /cancel first.');
  const ac = new AbortController();
  running.set(project.id, ac);
  events.publishState('run');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, RUN_TIMEOUT_MS);
  let streaming = false;
  const tagged = events.tag(randomUUID(), project.id, kind);
  const send = obj => {
    const ev = tagged(obj);
    if (streaming && !res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const run = await makeRun({ signal: ac.signal, send });
    streaming = true;
    res.writeHead(200, SSE_HEADERS);
    for await (const ev of run) {
      onEvent?.(ev);
      send(ev);
    }
    send({ type: 'done', aborted: ac.signal.aborted, timedOut });
  } catch (err) {
    if (!streaming) throw err;
    send({ type: 'error', message: err.message });
    send({ type: 'done', aborted: ac.signal.aborted, timedOut });
  } finally {
    clearTimeout(timer);
    running.delete(project.id);
    events.publishState('run');
    await store.persist();
    if (streaming) res.end();
  }
}

// The recent conversation as plain text, for the seats. Council and build results count as replies.
function councilHistory(log) {
  return log
    .filter(m => m.kind === 'chat' || m.kind === 'council' || m.kind === 'build')
    .slice(-8)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content ?? '').slice(0, 800)}`)
    .join('\n\n');
}

// What a council leaves in the chat: the verdict, then the recommended steps.
function councilText(result) {
  const steps = (result.recommendation ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  return [result.verdict, steps ? `Recommendation:\n${steps}` : ''].filter(Boolean).join('\n\n');
}

async function handleCouncil(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const question = String(body.question ?? '').trim();
  if (!question) throw httpError(400, 'Ask the council a question first.');
  let config;
  try {
    config = normalizeCouncil(body.config ?? store.get().council ?? DEFAULT_COUNCIL);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const history = councilHistory(store.transcript(project.id));
  // Kept as the run goes, so a cancelled council still leaves its answers in the chat.
  const saved = { seats: {}, result: null, seatMeta: [] };
  await streamForProject(req, res, project, async ({ signal }) => {
    store.addMessage(project.id, { role: 'user', kind: 'council', content: question });
    return runCouncil({ question, config, cwd: project.path, signal, history });
  }, ev => {
    if (ev.type === 'council-start') saved.seatMeta = ev.seats;
    if (ev.type === 'seat-done') saved.seats[ev.seat] = { ...(saved.seats[ev.seat] ?? {}), [`round${ev.round}`]: ev.text, error: ev.error };
    if (ev.type === 'consensus') saved.result = ev.result;
  }, { kind: 'council' });
  if (saved.result || Object.keys(saved.seats).length) {
    const content = saved.result ? councilText(saved.result) : 'The council was stopped before it reached a verdict.';
    const seats = saved.seatMeta.map(meta => ({ ...meta, ...(saved.seats[meta.id] ?? {}) }));
    store.addMessage(project.id, { role: 'assistant', kind: 'council', content, council: { question, seats, result: saved.result } });
    await store.persist();
  }
}

async function handlePlan(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const cfg = savedCouncil();
  const ref = body.planner ? parseRef(body.planner) : cfg.moderator.ref;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PLAN_TIMEOUT_MS);
  try {
    const plan = await planBuild({
      ref,
      effort: body.effort ?? cfg.moderator.effort ?? 'high',
      goal: String(body.goal ?? '').slice(0, 4000),
      recommendation: String(body.recommendation ?? '').slice(0, 8000),
      root: project.path,
      signal: ac.signal,
    });
    return json(res, 200, plan);
  } finally {
    clearTimeout(timer);
  }
}

async function handleBuild(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  // A build runs coders that write files and run commands, so a project in plan mode refuses it before anything else is
  // checked. The council and the planner stay read-only and are not touched by plan mode.
  if (chatModeOf(project) === 'plan') throw httpError(409, PLAN_BUILD_REFUSED);
  if (!Array.isArray(body.tasks) || !body.tasks.length) throw httpError(400, 'There are no tasks to run. Make a plan first.');
  const cfg = savedCouncil();
  const reviewer = body.reviewer
    ? { ref: parseRef(body.reviewer), effort: body.effort ?? 'high' }
    : { ref: cfg.moderator.ref, effort: cfg.moderator.effort };
  const goal = String(body.goal ?? '').trim().slice(0, 2000);
  // The coders get the project's CLI options. The reviewer is read-only and gets none (see delegate.mjs).
  const tools = effectiveSettings(store.get(), project).tools;
  // The coders also get the project's id (for checkpoints) and its own deny patterns. The reviewer gets neither.
  const denyPatterns = denyPatternsOf(project);
  const saved = { goal, tasks: [], results: {}, review: null };
  await streamForProject(req, res, project, async ({ signal, send }) => {
    store.addMessage(project.id, { role: 'user', kind: 'build', content: `Build: ${goal || 'the agreed plan'}` });
    const mode = store.get().approvals === 'auto' ? 'auto' : 'ask';
    return runBuild({ tasks: body.tasks, root: project.path, mode, signal, approve: approvalRequester(send, signal), reviewer, goal, tools, projectId: project.id, denyPatterns });
  }, ev => {
    if (ev.type === 'build-start') saved.tasks = ev.tasks;
    if (ev.type === 'task-done') saved.results[ev.id] = { ok: ev.ok, summary: ev.summary, changed: ev.changed, outOfScope: ev.outOfScope, error: ev.error };
    if (ev.type === 'review') saved.review = ev.result;
  }, { kind: 'build' });
  const done = Object.values(saved.results);
  if (done.length) {
    const ok = done.filter(r => r.ok).length;
    const verdict = saved.review ? ` Reviewer: ${saved.review.verdict === 'approve' ? 'approved' : 'changes needed'}.` : '';
    store.addMessage(project.id, { role: 'assistant', kind: 'build', content: `${ok} of ${done.length} tasks finished.${verdict}`, build: saved });
    await store.persist();
  }
}

// ---------- relay between seats ----------

// Settings for relays. Missing or bad values are refused with a plain message.
function normalizeRelay(input) {
  const r = { ...RELAY_DEFAULT, ...(store.get().relay ?? {}), ...(input ?? {}) };
  const countdownSec = Number(r.countdownSec);
  if (!Number.isInteger(countdownSec) || countdownSec < 0 || countdownSec > 10) throw httpError(400, 'The countdown must be a whole number from 0 to 10 seconds.');
  if (r.hops !== null && (!Number.isInteger(r.hops) || r.hops < 1 || r.hops > 50)) throw httpError(400, 'The hop limit must be empty (no limit) or a whole number from 1 to 50.');
  for (const key of ['autoRoute', 'stopOnError', 'dedupe']) {
    if (typeof r[key] !== 'boolean') throw httpError(400, `${key} must be true or false.`);
  }
  return { autoRoute: r.autoRoute, countdownSec, hops: r.hops, stopOnError: r.stopOnError, dedupe: r.dedupe };
}

const relayLogs = new Map();
const relayPaused = new Set();
function relayLogFor(projectId) {
  if (!relayLogs.has(projectId)) relayLogs.set(projectId, new RelayLog());
  return relayLogs.get(projectId);
}

// The council seats, each with its newest reply in this project's chat (empty when it has not answered).
function relaySeats(projectId) {
  const seats = normalizeCouncil(store.get().council ?? DEFAULT_COUNCIL).seats;
  const log = store.transcript(projectId);
  return seats.map(seat => {
    let reply = '';
    for (let i = log.length - 1; i >= 0 && !reply; i--) {
      const m = log[i];
      if (m.role !== 'assistant' || !m.content) continue;
      if (m.kind === 'chat' && (m.relay ? m.relay.to === seat.id : m.model === seat.ref)) reply = m.content;
      if (m.kind === 'council' && m.council?.seats) {
        const hit = m.council.seats.find(x => x.id === seat.id);
        if (hit) reply = hit.round2 ?? hit.round1 ?? '';
      }
    }
    return { ...seat, reply };
  });
}

function relaySource(seats, sourceId) {
  const seat = seats.find(x => x.id === sourceId);
  if (!seat) throw httpError(400, `There is no council seat called "${sourceId}".`);
  if (!seat.reply.trim()) throw httpError(400, `${seat.label} has not replied yet, so there is nothing to relay.`);
  return { seat: seat.id, label: seat.label, ref: seat.ref, text: seat.reply, messageId: null };
}

// A relayed reply is kept in the chat as the target seat's own reply, with where it came from.
function saveRelayHop(project, seats, ev, kind) {
  const target = seats.find(x => x.id === ev.to?.seat);
  store.addMessage(project.id, {
    role: 'assistant',
    kind: 'chat',
    model: target?.ref ?? null,
    content: ev.text,
    relay: { from: ev.from?.seat ?? null, fromLabel: ev.from?.label ?? null, to: ev.to?.seat ?? null, hop: ev.hop, kind },
  });
}

async function handleRelaySend(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const seats = relaySeats(project.id);
  const source = relaySource(seats, String(body.sourceId ?? ''));
  const targets = Array.isArray(body.targets) ? body.targets.map(String) : [];
  const broadcast = targets.length === 1 && targets[0] === 'all';
  if (!broadcast && targets.length !== 1) throw httpError(400, 'Choose one seat to send to, or all seats.');
  const note = String(body.note ?? '').trim().slice(0, 2000);
  const mode = store.get().approvals === 'auto' ? 'auto' : 'ask';
  const tools = effectiveSettings(store.get(), project).tools;
  const kind = broadcast ? 'broadcast' : 'send';
  return streamForProject(req, res, project, async ({ signal }) => {
    const common = { seats, source, note, project, store, signal, mode, tools };
    return broadcast ? runBroadcast({ ...common, targets: ['all'] }) : runSend({ ...common, target: targets[0] });
  }, ev => {
    if (ev.type !== 'hop-done') return;
    // A send keeps its own log record; a route's hops are logged through onHop instead.
    relayLogFor(project.id).push({
      at: Date.now(), hop: ev.hop, kind, from: ev.from, to: ev.to,
      chars: source.text.length, sha256: hashText(source.text), ok: ev.ok, error: ev.error,
    });
    if (ev.ok && ev.text) saveRelayHop(project, seats, ev, kind);
  }, { kind: 'relay' });
}

async function handleRelayRoute(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const seats = relaySeats(project.id);
  const source = relaySource(seats, String(body.sourceId ?? ''));
  const settings = normalizeRelay({});
  const input = body.route ?? {};
  let route;
  try {
    route = normalizeRoute({
      kind: input.kind, from: source.seat, targets: input.targets,
      hops: settings.hops, countdownSec: settings.countdownSec, stopOnError: settings.stopOnError,
    }, seats);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const note = String(body.note ?? '').trim().slice(0, 2000);
  const st = store.get();
  const mode = st.approvals === 'auto' ? 'auto' : 'ask';
  const log = relayLogFor(project.id);
  // A route starts unpaused. The pause is cleared only once streamForProject accepts the route, so a route refused for a busy
  // project leaves the pause of the run that is going on as it was.
  return streamForProject(req, res, project, async ({ signal }) => {
    relayPaused.delete(project.id);
    return runRoute({
      route, seats, startText: source.text, startLabel: source.label, cwd: project.path, signal,
      isPaused: () => relayPaused.has(project.id),
      onHop: rec => log.push(rec),
      mode,
      tools: effectiveSettings(st, project).tools,
      history: historyFor(store.transcript(project.id), st.model, { textOnly: true }),
      dedupe: settings.dedupe,
      note,
    });
  }, ev => {
    if (ev.type === 'hop-done' && ev.ok && ev.text) saveRelayHop(project, seats, ev, 'route');
  }, { kind: 'relay' });
}

// Exit code that tells the launcher (start.bat or the desktop app) to start the server again.
const RESTART_EXIT_CODE = 75;

// Restarts the server after an applied update. The launcher brings it back up.
function restartSoon() {
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
}

async function handleApi(req, res, url) {
  const st = store.get();
  // Route modules in lib/routes/ answer their own endpoints first.
  const ext = findExtRoute(req.method, url.pathname);
  if (ext) return await ext.handler({ req, res, url, json, readBody, httpError, store, projectById, streamForProject, publicState, approvalRequester, running, relaySeats, events });
  switch (`${req.method} ${url.pathname}`) {
    // One server-sent stream per window (lib/events.mjs). The first event is hello, with the state without messages.
    case 'GET /api/events':
      return events.subscribe(req, res, { type: 'hello', pid: process.pid, startedAt: events.STARTED_AT, version: VERSION, generation: overlay.active()?.generation ?? null, state: publicState({ messages: false }) });

    case 'GET /api/status':
      return json(res, 200, { providers: await providerStatus(), catalog: CATALOG, aliases: ALIASES });

    case 'GET /api/state':
      return json(res, 200, publicState());

    case 'GET /api/tree':
      return json(res, 200, { files: await listTree(projectById(url.searchParams.get('project')).path) });

    case 'POST /api/projects': {
      const body = await readBody(req);
      const abs = await resolveFolder(body.path);
      const id = projectId(abs);
      if (!st.projects.some(p => p.id === id)) {
        st.projects.push({ id, name: String(body.name ?? '').trim() || path.basename(abs), path: abs });
      }
      st.activeProject = id;
      await store.persist();
      return json(res, 200, publicState());
    }

    case 'POST /api/projects/remove': {
      const body = await readBody(req);
      if (running.has(body.project)) throw httpError(409, 'That project is busy. Use /cancel first.');
      st.projects = st.projects.filter(p => p.id !== body.project);
      if (st.activeProject === body.project) st.activeProject = st.projects[0]?.id ?? null;
      await store.persist();
      return json(res, 200, publicState());
    }

    case 'POST /api/settings': {
      const body = await readBody(req);
      if (body.model) st.model = parseRef(body.model);
      if (body.advisor === 'off') st.advisor = null;
      else if (body.advisor) st.advisor = parseRef(body.advisor);
      if (typeof body.advisorAuto === 'boolean') st.advisorAuto = body.advisorAuto;
      if (body.approvals === 'ask' || body.approvals === 'auto') st.approvals = body.approvals;
      if (body.effort !== undefined) {
        if (!EFFORTS.includes(body.effort)) throw httpError(400, `Effort must be one of: ${EFFORTS.join(', ')}.`);
        st.effort = body.effort;
      }
      if (body.theme !== undefined) {
        if (!THEMES.includes(body.theme)) throw httpError(400, `Theme must be one of: ${THEMES.join(', ')}.`);
        st.theme = body.theme;
      }
      if (body.council !== undefined) {
        try {
          st.council = normalizeCouncil(body.council);
        } catch (err) {
          throw httpError(400, err.message);
        }
      }
      if (body.music !== undefined) st.music = normalizeMusic({ ...(st.music ?? MUSIC_DEFAULT), ...body.music });
      if (body.relay !== undefined) st.relay = normalizeRelay(body.relay);
      if (body.sessionMode === 'native' || body.sessionMode === 'transcript') st.sessionMode = body.sessionMode;
      if (body.activeProject) st.activeProject = projectById(body.activeProject).id;
      await store.persist();
      return json(res, 200, publicState());
    }

    case 'POST /api/clear': {
      const body = await readBody(req);
      const project = projectById(body.project);
      if (running.has(project.id)) throw httpError(409, 'Busy. Use /cancel first.');
      keepArchive(project.id, [...store.transcript(project.id)], 'clear');
      store.transcript(project.id).length = 0;
      forgetProjectSessions(project.id);
      await store.persist();
      return json(res, 200, publicState());
    }

    case 'POST /api/compact':
      return await handleCompact(req, res);

    case 'GET /api/usage': {
      const [providers, key] = await Promise.all([providerStatus(), anthropicKey()]);
      const main = splitRef(st.model);
      const usage = await readUsage({
        muse: { installed: providers.muse.installed && museSignedIn(), model: main.provider === 'muse' ? main.id : 'muse-spark-1.2' },
        codex: { installed: providers.codex.installed },
        claude: { cli: providers.anthropic.route === 'cli', key: key.key, model: main.provider === 'anthropic' ? main.id : 'claude-opus-5-5' },
      });
      return json(res, 200, { ...usage, gemini: await geminiUsage() });
    }

    case 'POST /api/council':
      return await handleCouncil(req, res);

    case 'POST /api/plan':
      return await handlePlan(req, res);

    case 'POST /api/build':
      return await handleBuild(req, res);

    case 'POST /api/relay/send':
      return await handleRelaySend(req, res);

    case 'POST /api/relay/route':
      return await handleRelayRoute(req, res);

    case 'POST /api/relay/pause': {
      const p = projectById((await readBody(req)).project);
      relayPaused.add(p.id);
      return json(res, 200, { paused: true });
    }

    case 'POST /api/relay/resume': {
      const p = projectById((await readBody(req)).project);
      relayPaused.delete(p.id);
      return json(res, 200, { paused: false });
    }

    case 'GET /api/relay/log': {
      const p = projectById(url.searchParams.get('project'));
      return json(res, 200, { records: relayLogFor(p.id).list() });
    }

    case 'POST /api/cancel': {
      const body = await readBody(req);
      const ac = running.get(body.project);
      ac?.abort();
      return json(res, 200, { cancelled: !!ac });
    }

    case 'POST /api/approve': {
      const body = await readBody(req);
      const entry = pendingApprovals.get(body.approvalId);
      if (!entry) throw httpError(404, 'That approval is no longer waiting. It may have timed out.');
      // The reason is cleaned here and is used only for a denial. Approve never reads it.
      const reason = cleanReason(body.reason);
      entry.finish(body.allow === true, reason);
      return json(res, 200, { ok: true });
    }

    // The whole diff of a capped edit card, for Show all. Read-only, and only while that approval is still waiting.
    case 'GET /api/approve/detail': {
      const entry = pendingApprovals.get(url.searchParams.get('id'));
      if (!entry) throw httpError(404, 'That approval is no longer waiting.');
      return json(res, 200, { detail: entry.fullDetail ?? '' });
    }

    case 'GET /api/accounts': {
      const [providers, cli] = await Promise.all([providerStatus(), claudeCliStatus({ fresh: true })]);
      const codex = providers.codex.installed ? await runCli('codex', ['login', 'status']) : null;
      const codexText = (codex?.output || codex?.error || '').split('\n')[0].trim();
      return json(res, 200, {
        claude: providers.anthropic.route === 'cli'
          ? { route: 'cli', connected: cli.loggedIn, email: cli.email, plan: cli.plan }
          : { route: 'api', connected: providers.anthropic.credentials, source: providers.anthropic.source },
        muse: { installed: providers.muse.installed, signedIn: museSignedIn(), metaApiKey: providers.muse.metaApiKey },
        gemini: { installed: providers.gemini.installed, signedIn: providers.gemini.signedIn, email: providers.gemini.email },
        // The Codex CLI prints its login status on stderr, so both streams are checked.
        codex: { installed: providers.codex.installed, loggedIn: /logged in/i.test(`${codex?.output ?? ''}\n${codex?.error ?? ''}`), status: codexText },
      });
    }

    case 'POST /api/accounts/claude/key': {
      const body = await readBody(req);
      const key = String(body.key ?? '').trim();
      if (key.length < 20 || key.length > 300 || /\s/.test(key)) throw httpError(400, 'That does not look like an API key.');
      // A save that would be refused (no keychain, or a Node-only run) stops before the key is sent to Anthropic.
      try {
        assertCanSave();
      } catch (err) {
        return json(res, 200, { saved: false, message: err.message });
      }
      // The key is checked with one small request before it is saved.
      const check = await testAnthropicKey(key);
      if (!check.ok) return json(res, 200, { saved: false, message: check.message });
      try {
        const where = await storeKey('ANTHROPIC_API_KEY', key);
        return json(res, 200, { saved: true, message: `${check.message} ${where}`.trim() });
      } catch (err) {
        return json(res, 200, { saved: false, message: err.message });
      }
    }

    case 'POST /api/accounts/claude/test': {
      const { key } = await anthropicKey();
      if (!key) return json(res, 200, { ok: false, message: 'No key is saved yet.' });
      return json(res, 200, await testAnthropicKey(key));
    }

    case 'POST /api/accounts/claude/login':
      await openSignIn('claude', ['auth', 'login'], 'Claude sign-in');
      return json(res, 200, { ok: true });

    case 'POST /api/accounts/gemini/login':
      await geminiSignIn();
      return json(res, 200, { ok: true });

    case 'POST /api/accounts/muse/login':
      await openSignIn('muse', ['login'], 'Muse Code sign-in');
      return json(res, 200, { ok: true });

    case 'POST /api/accounts/codex/login':
      await openSignIn('codex', ['login'], 'Codex sign-in');
      return json(res, 200, { ok: true });

    case 'GET /api/updates':
      return json(res, 200, { updates: await listUpdates(store.HOME), overlay: overlayStatus(store.HOME) });

    case 'POST /api/updates/apply': {
      const body = await readBody(req);
      if (running.size) throw httpError(409, 'A run is in progress. Stop it before applying an update.');
      const result = await applyUpdate(store.HOME, String(body.id ?? ''));
      res.once('finish', restartSoon);
      return json(res, 200, { ...result, restarting: true });
    }

    // Back to the generation before the active one, or to the shipped files. Plenum restarts to load it.
    case 'POST /api/updates/rollback': {
      await readBody(req);
      if (running.size) throw httpError(409, 'A run is in progress. Stop it before rolling back an update.');
      const result = await rollbackUpdate(store.HOME);
      res.once('finish', restartSoon);
      return json(res, 200, { ...result, restarting: true });
    }

    // Stops using every applied update and deletes them; the shipped files run after the restart.
    case 'POST /api/updates/reset': {
      await readBody(req);
      if (running.size) throw httpError(409, 'A run is in progress. Stop it before removing the applied updates.');
      const result = await resetOverlay(store.HOME);
      res.once('finish', restartSoon);
      return json(res, 200, { ...result, restarting: true });
    }

    // The page has shown the notice about an automatic rollback.
    case 'POST /api/updates/ack-rollback':
      await readBody(req);
      acknowledgeRollback(store.HOME);
      return json(res, 200, { ok: true });

    case 'POST /api/updates/discard': {
      const body = await readBody(req);
      await discardUpdate(store.HOME, String(body.id ?? ''));
      return json(res, 200, { ok: true });
    }

    default:
      throw httpError(404, 'No such route.');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host)) throw httpError(421, `Open Plenum at http://${HOST}:${PORT}`);
    const url = new URL(req.url, `http://${req.headers.host}`);

    // A request from another site is refused before the token is looked at (the Host check above does the same for DNS rebinding).
    if (req.method === 'POST' && req.headers.origin && !ORIGINS.has(req.headers.origin)) throw httpError(403, 'Cross-origin request blocked.');
    // Every /api/ request, GET included, must carry this launch's token (lib/auth.mjs). The page and the other files are not gated.
    if (url.pathname.startsWith('/api/')) {
      const bad = checkRequest(req);
      if (bad) throw bad;
    }
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw httpError(415, 'Send JSON.');

    if (req.method === 'POST' && url.pathname === '/api/chat') return await handleTurn(req, res, { review: false });
    if (req.method === 'POST' && url.pathname === '/api/review') return await handleTurn(req, res, { review: true });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (req.method !== 'GET') throw httpError(405, 'Method not allowed.');
    const asset = staticAsset(url.pathname) ?? (await extAsset(url.pathname));
    if (!asset) throw httpError(404, 'Not found.');
    res.writeHead(200, {
      'content-type': asset.type,
      'cache-control': 'no-cache',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    const body = await fs.readFile(asset.file);
    return res.end(asset.type.startsWith('text/html') ? withTheme(body.toString('utf8')) : body);
  } catch (err) {
    if (res.headersSent) return res.end();
    // Marks the token refusal, so a page can tell it from a provider's own 401 (an invalid API key) that a route passes on.
    if (isRefusal(err)) res.setHeader('x-plenum-auth', 'token');
    json(res, err.status ?? 400, { error: err.message });
  }
});

// After an applied update the old process may still hold the port for a moment, so a restarted process retries.
async function listen() {
  const retryUntil = Date.now() + (process.env.MUSE_CONSOLE_RESTART ? 20_000 : 0);
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const onError = err => { server.off('listening', onListening); reject(err); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(PORT, HOST);
      });
      return;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || Date.now() > retryUntil) throw err;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

await store.load();
// Every project gets its spend record now, from its transcript as it stands, so a clear or compact later cannot reset the
// total (lib/budget.mjs). A project added later gets one the first time it is read or charged.
for (const p of store.get().projects) spendOf(p, store.get().chats?.[p.id] ?? []);
// The desktop app hands over the saved keys before the server accepts a request, so the first request already sees them.
// A plain Node run has no app to ask and reads keys from the environment (see lib/keys.mjs).
const keyChannel = parentChannel();
await connectKeyChannel(keyChannel);
// The per-launch token (lib/auth.mjs). Under the desktop app it arrived in the keys message above; otherwise PLENUM_TOKEN or a
// new random one is used. Nothing is accepted on /api/ without it.
ensureToken();
// What the events channel sends as the state: everything but the transcript (see publicState).
events.useStateProvider(() => publicState({ messages: false }));
await listen();
// The server is up, so an applied update that was waiting to prove it starts has done so (lib/overlay.mjs). Only a start that went
// through the bootstrap (plenum.mjs) proves anything: `node server.mjs` runs the shipped files and leaves pending.json alone.
if (process.env.PLENUM_OVERLAY_DIR !== undefined) overlay.markHealthy();
// The token is printed once, for a plain Node run, in a URL fragment (which a browser never sends to the server). Under the
// desktop app (its token came over the channel) nothing secret is printed, because the desktop keeps this output in its log
// file. The same holds for any launcher that gave the server a key channel: a token made here could not be used by it anyway.
if (tokenSource() === 'desktop' || keyChannel) console.log(`Plenum running at http://${HOST}:${PORT}`);
else console.log(`Open Plenum at http://${HOST}:${PORT}/#token=${token()}`);
console.log(`State file: ${path.join(store.HOME, 'state.json')}`);
