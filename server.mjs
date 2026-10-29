import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as store from './lib/store.mjs';
import * as events from './lib/events.mjs';
import * as activity from './lib/activity.mjs';
import { checkRequest, ensureToken, isRefusal, tokenSource, token } from './lib/auth.mjs';
import {
  CATALOG, ALIASES, parseRef, splitRef, labelFor, streamChat, providerStatus, ADVISOR_SYSTEM, advisorMessages, historyFor,
  anthropicKey, testAnthropicKey, EFFORTS, billingFor, isSubscriptionToken, SUBSCRIPTION_TOKEN_REFUSAL,
} from './lib/providers.mjs';
import { summarizeUsage, totalUsage } from './lib/pricing.mjs';
import { runCli, openSignIn, museSignedIn } from './lib/accounts.mjs';
import { imageSupport } from './lib/capabilities.mjs';
import { assertCanSave, connectKeyChannel, keyStorage, parentChannel, storeKey } from './lib/keys.mjs';
import { expandFileMentions, listTree, workingDiff } from './lib/files.mjs';
import { queueUpdate, listUpdates, applyUpdate, discardUpdate, rollbackUpdate, resetOverlay, overlayStatus, acknowledgeRollback } from './lib/updates.mjs';
import * as overlay from './lib/overlay.mjs';
import { readUsage } from './lib/usage.mjs';
import { claudeRoute, claudeCliStatus } from './lib/claude-cli.mjs';
import { cleanReason } from './lib/tools.mjs';
import { DEFAULT_COUNCIL, normalizeCouncil, runCouncil } from './lib/council.mjs';
import { checkTasks, coderRefs, planBuild, runBuild } from './lib/delegate.mjs';
import { effectiveAgents, typeByName } from './lib/agents.mjs';
import { liveAgents, offerFor, openRun, registerRunScope, withRun } from './lib/agent-run.mjs';
import { toolsAllowed } from './lib/tool-trust.mjs';
import { toolsOnFor } from './lib/tool-verify.mjs';
import { geminiSignIn, geminiUsage } from './lib/gemini.mjs';
import { normalizeRoute, runSend, runBroadcast, runRoute, RelayLog, hashText } from './lib/relay.mjs';
import { clipText } from './lib/collab.mjs';
import { effectiveSettings, storedSettings, denyPatternsOf, chatModeOf, approvalModeOf, approvalSummary, approveAllBlockedOf, approveAllCoversOf, codersCannotAskOf, normalizeAppCovers, normalizeProjectSettings } from './lib/projects.mjs';
import { forgetProjectSessions, forgetSession, sessionMode } from './lib/sessions.mjs';
import { buildFocusOf, FOCUS_REMINDER } from './lib/focus.mjs';
import { keepArchive, peekArchive } from './lib/archive.mjs';
import { accrueReply, budgetState, checkBudget, spendOf } from './lib/budget.mjs';
import { findExtRoute } from './lib/routes/index.mjs';
import { legalSummary, termsAccepted, termsGate } from './lib/legal.mjs';
import { canStart as canStartDrive, DEFAULT_IDLE_MINUTES, hotkeyStatus, listDrives, normalizeIdleMinutes, normalizeStopOverride } from './lib/drive.mjs';
import { bridge as computerBridge } from './lib/computer/bridge.mjs';
import { createComputerRun } from './lib/computer/run.mjs';
import { appName, normalizeLogDays, normalizeLogMB, normalizePaceMs, normalizeRunSettings, paceOf, retentionOf, settingsFromPrefs } from './lib/computer/policy.mjs';
import { computerSupportDetail } from './lib/computer/support.mjs';
import { NO_MODEL, resolveGeminiComputerModel } from './lib/computer/gemini.mjs';
import { driverFor } from './lib/computer/drivers.mjs';
import { clearPromptsHealth, promptsHealth } from './lib/prompts.mjs';
import { permissionHelp } from './lib/platform/computer.mjs';
import { available as browserAvailable } from './lib/browser-bridge.mjs';
import { folderRisk } from './lib/guard.mjs';
import { buildSystem } from './lib/prompt.mjs';
import { apiProvider } from './lib/api-providers.mjs';
import { loadGlobalRules, loadProjectRules } from './lib/rules.mjs';
import { IMAGE_REFUSAL, MAX_IMAGES, checkImages, describeImages, takesImages } from './lib/images.mjs';
import { checkMessageTotals, describeUploads, pdfRefusal, sortAttachments, splitUploads, takesDocuments, withInline } from './lib/attachments.mjs';
import { runAfter, runBefore, runExpand } from './lib/turn-hooks.mjs';
import { describeThreads, planModeOf, projectBusy, readOnlyNotice, readOnlyWhy, runningScopes, scopeFor, threadOf, worktreeHeld, worktreeOf } from './lib/scope.mjs';
import { ensureThreads, migrateThreads, threadsOf } from './lib/threads.mjs';
import { onShellMessage, shellPost } from './lib/shell.mjs';
import { forgetWorktree } from './lib/worktree.mjs';

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
const APPROVAL_VALUES = ['ask', 'auto', 'all'];
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
  // The bar of the computer-use overlay: the desktop app loads it into its own small window (desktop/computer/overlay.cjs).
  '/overlay.html': { file: 'overlay.html', type: 'text/html; charset=utf-8' },
  '/icon.png': { file: 'icon.png', type: 'image/png' },
  '/mark.svg': { file: 'mark.svg', type: 'image/svg+xml' },
};
// Files are read on each request, so interface changes show up on the next reload.
function staticAsset(pathname) {
  if (!Object.hasOwn(STATIC, pathname)) return null;
  const { file, type } = STATIC[pathname];
  return { file: overlay.filePath(`public/${file}`), type };
}

// Scope id -> AbortController for the run in progress. One run per thread (lib/scope.mjs): the project's Main thread uses the project's own
// id, any other thread `${project id}-t${6 hex}`, so several threads of one project can run at once. projectBusy(running, projectId) says
// whether any thread of a project runs.
const running = new Map();
// Project id -> { scope, kind } while a project-wide operation (a build, a checkpoint restore, a snapshot rewind, a merge of a thread's
// isolated copy into the base branch) is live. A thread of the same project does not start a run meanwhile, and the operation itself
// starts only when every thread is idle. A merge changes the project folder from the moment its card is shown until git has finished,
// and a turn that edits the folder meanwhile could be lost by the merge's own abort.
const exclusive = new Map();
const EXCLUSIVE_KINDS = { build: 'Builds', restore: 'Restores', rewind: 'Restores', 'worktree-merge': 'Merges' };
// What a live operation is called in "A ... is running in this project." (the run kind when it is not listed here).
const EXCLUSIVE_NAMES = { 'worktree-merge': 'merge' };
// True from the moment an update starts being applied until the server restarts (B-87). Run starters refuse while it is set, so no
// run can be cut off by the restart that follows an applied update.
let updating = false;
const UPDATING_TEXT = 'Plenum is applying an update and will restart. Try again in a moment.';
// True from the desktop app's shutdown message until the process ends (onShellMessage('shutdown') at the bottom). Run starters refuse
// while it is set, so no run begins during the drain only to be stopped a moment later.
let shuttingDown = false;
const CLOSING_TEXT = 'Plenum is closing.';
// Drive id -> the computer run that is live, so a route can reach the run of a drive (the "Type it for me" box, lib/routes/computer.mjs).
const liveComputerRuns = new Map();
// Approval id -> { finish, fullDetail, card, meta, at } for a tool call waiting on the user. fullDetail is the whole diff when the card shows
// a capped one, else null. card is the card the chat shows (no full diff); meta is the run's meta (lib/activity.mjs), or null.
const pendingApprovals = new Map();
// What the Agents board shows for a run, keyed by the run's abort signal (approvalRequester reads it for a card's project and model).
const runMeta = new WeakMap();
// Starts a run for a scope (lib/scope.mjs): marks it running and tells the Agents board (lib/activity.mjs). meta carries kind, model and modelLabel.
function beginRun(project, scope, ac, meta = {}) {
  running.set(scope.id, ac);
  const info = { scope: scope.id, projectId: project.id, projectName: project.name, threadName: scope.name, kind: 'run', ...meta };
  runMeta.set(ac.signal, info);
  activity.runStarted(info);
}
// Ends a run that is still the one marked running for its scope, and moves it to the board's recent list.
function endRun(scopeId, ac) {
  if (running.get(scopeId) !== ac) return;
  running.delete(scopeId);
  activity.runEnded(scopeId, { aborted: ac.signal.aborted });
}
// A project-wide operation (a build, a checkpoint restore, a snapshot rewind, a merge) that is live keeps every other thread of the project
// from starting a run meanwhile, so nothing writes while a restore or a merge waits for its card.
function refuseWhileExclusive(project, scope) {
  const op = exclusive.get(project.id);
  if (op && op.scope !== scope.id) throw httpError(409, `A ${EXCLUSIVE_NAMES[op.kind] ?? op.kind} is running in this project. Wait until it ends.`);
}

// A thread's isolated copy that is being kept, discarded or merged is not a folder a new run may start in. A starter reads its scope before
// it awaits (the folder check, a git preflight), so the copy may have changed hands since: this reads the scope again and refuses a copy that
// is held now. Called in the same synchronous stretch as the other checks and beginRun, so a Keep or Discard that begins later finds the run
// marked running and is refused by its own check, and one that began earlier is seen here. Returns the scope as it is now.
function refuseClosingCopy(project, scope) {
  const now = scopeFor(store, project, scope.id);
  if (worktreeHeld(now.id) || now.worktree?.state === 'closing') throw httpError(409, 'This thread\'s isolated copy is being kept or discarded.');
  return now;
}

// The 409 for a run that cannot start in this thread: the thread is busy itself, or (for a build, a restore, a rewind and a merge) any other
// thread of the project is. Returns null when it may start. what is 'Builds', 'Restores' or 'Merges'.
function busyRefusal(project, scope, what) {
  if (running.has(scope.id)) return httpError(409, 'This project is already running. Use /cancel first.');
  if (what && projectBusy(running, project.id)) return httpError(409, `Another thread in this project is running. ${what} wait until every thread is idle.`);
  return null;
}

// The model a run uses is known only once a turn has chosen it, after beginRun. Setting it here puts it on the run's meta, so a card
// the run raises afterwards shows the model on the Agents board (approvalRequester copies modelLabel from this meta).
function setRunModel(signal, ref) {
  const meta = runMeta.get(signal);
  if (meta) Object.assign(meta, { model: ref, modelLabel: labelFor(ref) });
}
// A request from another page is refused. A missing Origin is a same-window read (a GET the page makes itself), so only a different one is.
function refuseForeignOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw httpError(403, 'Cross-origin request blocked.');
}
// Said once at the start of every chat turn in a project that is in plan mode.
const PLAN_NOTICE = 'Plan mode: Plenum will not edit files or run commands in this project.';
// Said when a build is asked for in a project that is in plan mode (a build runs coders that write files).
const PLAN_BUILD_REFUSED = 'This project is in plan mode, so Plenum will not build or edit files. Turn plan mode off to build.';
// Said once per project (and thread) per launch, at the first chat turn that runs in Approve all (UI-ARCH: the notice is not
// repeated every turn; the red button and the Mode menu stay as the reminder). The second text is for a project that also lets
// Approve all answer blocked-command cards.
const APPROVE_ALL_NOTICE = 'Approve all is on for this project. Edits and commands run without asking; a command that a built-in rule blocks still shows its card. Credential folders and Plenum\'s own files stay off limits, and system folders stay read-only.';
const APPROVE_ALL_BLOCKED_NOTICE = 'Approve all is on for this project, and it also answers blocked-command cards. Edits and commands, including ones Plenum\'s rules block, run without asking. Credential folders and Plenum\'s own files stay off limits, and system folders stay read-only.';
const approveAllSaid = new Set();

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
  // A body of JSON null counts as an empty body (B-69): the routes read fields from the body, and null has none.
  try {
    const body = JSON.parse(text) ?? {};
    // Kept on the request so that streamForProject can read the thread the body names (lib/scope.mjs threadOf).
    req.plenumBody = body;
    return body;
  } catch {
    throw httpError(400, 'The request body is not valid JSON.');
  }
}

const projectId = abs => createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 12);

// Forgetting a project keeps what protects it, so adding the same folder again (the id is made from the path) brings it back:
// the spend limit and the running spend, plan mode, the deny patterns and the rest of its settings (B-30). The chat already
// survives, because transcripts are keyed by the id. What widens a run is not carried over: a project's own Auto-approve or
// Approve all, its "also answers blocked-command cards" switch and its Approve all coverage start again from the app's values,
// so re-adding a folder never turns a risky mode back on by itself. At most 50 forgotten projects are kept, oldest first out.
const KEEP_FORGOTTEN = 50;
// The longest project name kept (B-72): the same limit as the file-name and image-name caps elsewhere in Plenum.
const PROJECT_NAME_MAX = 80;
function keepForgotten(st, project) {
  if (!project || (!project.settings && !project.spend)) return;
  const settings = project.settings && typeof project.settings === 'object' && !Array.isArray(project.settings) ? { ...project.settings } : null;
  if (settings) {
    if (settings.approvals === 'auto' || settings.approvals === 'all') settings.approvals = null;
    delete settings.approveAllBlocked;
    delete settings.approveAllCovers;
  }
  st.forgotten ??= {};
  delete st.forgotten[project.id];
  st.forgotten[project.id] = { settings, spend: project.spend ?? null };
  const ids = Object.keys(st.forgotten);
  for (const old of ids.slice(0, Math.max(0, ids.length - KEEP_FORGOTTEN))) delete st.forgotten[old];
}

// The thread ids of a project that have an isolated copy on record (lib/scope.mjs: st.worktrees is keyed by thread id, and Main has none).
const copyIdsOf = (st, project) => Object.keys(st.worktrees ?? {}).filter(id => id.startsWith(`${project.id}-t`));
// Removing a project is refused while one of its copies is ready, or is being kept, discarded or merged: the work in it is on no branch
// of the project yet, and the folder lives outside the project (POST /api/projects/remove).
function refuseOpenCopies(st, project) {
  if (copyIdsOf(st, project).some(id => ['ready', 'closing'].includes(worktreeOf(st, id)?.state))) {
    throw httpError(409, 'Keep or Discard this project\'s isolated copies first.');
  }
}

// The per-project switch 'The model may start computer use itself' (off by default; Project settings). Read on its own, so only a stored
// true counts. When it is on, chat turns in the desktop app get ctx.startComputer, which the start_computer_use tool calls.
const computerSelfStartOf = project => project?.settings?.computerSelfStart === true;

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
  // Anchored to the drive root (B-55): a folder named windows or programdata deeper in a project path is not a system folder.
  if (/^[a-z]:\\(windows|program files( \(x86\))?|programdata)(\\|$)/.test(abs.toLowerCase())) {
    throw httpError(400, 'System folders are not allowed.');
  }
  // Home, Plenum's own folder, and any parent of a credential folder are refused, with the reason folderRisk gives.
  const risk = folderRisk(abs);
  if (risk) throw httpError(400, risk);
  return abs;
}

// The council a project uses, read through normalizeCouncil before use: the project's own council when it has one, else the
// app's saved one (B-4). A hand-edited state.json with a council that is not valid (for example one with no moderator) gets a
// plain message instead of a crash.
function savedCouncil(project) {
  try {
    return normalizeCouncil(effectiveSettings(store.get(), project).council ?? DEFAULT_COUNCIL);
  } catch (err) {
    throw httpError(400, `The saved council is not valid: ${err.message} Open the Council panel and save a valid one.`);
  }
}

function projectById(id) {
  const project = store.get().projects.find(p => p.id === id);
  if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
  return project;
}

// True when the project's folder is no longer there (moved, renamed or deleted). A route that reads or runs in the folder checks
// this first, so a missing folder is reported as such, not as an empty tree, "not a repo" or a raw tool error (B-73).
async function folderGone(project) {
  const info = await fs.stat(project.path).catch(() => null);
  return !info?.isDirectory();
}
const missingFolder = project => httpError(400, `The project folder is missing: ${project.path}. Put it back, or remove the project.`);

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
// How many approval cards a scope has waiting now (the tab of a hidden thread turns amber while it is more than 0).
const waitingFor = scopeId => {
  let n = 0;
  for (const entry of pendingApprovals.values()) if (entry.meta?.scope === scopeId) n += 1;
  return n;
};

// The scope of the project on screen: its active thread. A damaged thread record never breaks the state; it reads as Main.
function activeScopeOf(st, project) {
  if (!project) return null;
  try {
    return scopeFor(store, project, undefined);
  } catch {
    return scopeFor({ get: () => ({}) }, project, undefined);
  }
}

// The tokens and cost of a project: the replies of every thread of it (open or closed), since a thread's spend is the project's spend.
function projectMessages(st, project) {
  const record = threadsOf(st, project);
  const lists = record.list.map(t => st.chats?.[t.id]).filter(Array.isArray);
  return lists.length === 1 ? lists[0] : lists.flat();
}

function publicState({ messages = true } = {}) {
  const st = store.get();
  const active = st.projects.find(p => p.id === st.activeProject) ?? null;
  const scope = activeScopeOf(st, active);
  // st.chats is read directly so that asking for the count does not create an empty transcript. The transcript is the active thread's.
  const log = scope ? (messages ? store.transcript(scope.id) : (st.chats?.[scope.id] ?? [])) : [];
  return {
    // chatMode is 'normal' or 'plan' (see chatModeOf). The plan button in public/ext-plan.js reads it from here.
    // Each entry also says what the project's runs use now (B-4), so the composer can show what the server will do:
    //   approvals       the mode its runs use: 'ask', 'auto' or 'all' (approvalModeOf)
    //   ownApprovals    the project's own value, or null when it follows the app's (the Mode menu's "Use app default")
    //   model, effort   the model and effort its runs use (the project's own, else the app's)
    //   approveAllBlocked, approveAllCovers, codersCannotAsk   the project's Approve all and coder switches (lib/projects.mjs)
    //   buildFocus      whether Build focus is on for the project (lib/focus.mjs)
    projects: st.projects.map(p => {
      const eff = effectiveSettings(st, p);
      return { id: p.id, name: p.name, path: p.path, chatMode: chatModeOf(p), ...approvalSummary(st, p), model: eff.model ?? st.model, effort: eff.effort, buildFocus: buildFocusOf(p) };
    }),
    // The relay settings a route in the active project uses (its own, else the app's) and whether the project has its own (B-63), so the
    // route panel and its Start gate match what the server enforces. Kept beside the project list, which carries no settings.
    activeRelay: active ? { settings: { ...RELAY_DEFAULT, ...(effectiveSettings(st, active).relay ?? {}) }, own: Boolean(storedSettings(active)?.relay) } : null,
    // Each project's running total of tokens and cost, by project id, worked out from the replies still in its transcript
    // (totalUsage in lib/pricing.mjs). public/ext-cost.js shows it. st.chats is read directly so that listing a project
    // does not create an empty transcript for it. It is kept out of the project entries, which carry no counters.
    usage: Object.fromEntries(st.projects.map(p => [p.id, totalUsage(projectMessages(st, p))])),
    activeProject: active?.id ?? null,
    // How many threads each project has open and whether any of them runs now ({ [project id]: { count, busy } }): the sidebar says '3 threads'
    // and breathes while any thread of a project runs. Kept beside the project list, whose entries keep their own shape.
    projectThreads: Object.fromEntries(st.projects.map(p => [p.id, { count: threadsOf(st, p).list.filter(t => !t.closedAt).length, busy: projectBusy(running, p.id) }])),
    // running is the active thread's run (threads[].running says it for every thread of the project).
    running: scope ? running.has(scope.id) : false,
    // Threads (lib/threads.mjs): the active thread, the open threads of the active project with their state ({ id, name, model, main, writer,
    // chatMode, running, waiting }), the closed ones ({ id, name, closedAt }), whether any thread of the project runs (project-wide operations
    // wait), whether the project allows several writers, and whether threads are off (the dated copy of the state file failed).
    ...(active ? (() => {
      const info = describeThreads(st, active, running, waitingFor);
      return { activeThread: info.active, writerThread: info.writer, multiWriter: info.multiWriter, threads: info.threads, closedThreads: info.closedThreads, projectBusy: info.projectBusy, threadsOff: info.threadsOff };
    })() : { activeThread: null, writerThread: null, multiWriter: false, threads: [], closedThreads: [], projectBusy: false, threadsOff: false }),
    // The chat that /clear or /compact replaced, while Undo can still put it back (lib/archive.mjs). Only its summary goes out.
    archive: scope ? peekArchive(scope.id) : null,
    model: st.model,
    advisor: st.advisor,
    advisorAuto: st.advisorAuto,
    // The app's own approval mode ('ask', 'auto' or 'all'); a project may set its own (see the project entries above).
    approvals: APPROVAL_VALUES.includes(st.approvals) ? st.approvals : 'ask',
    // Whether Approve all also answers the computer-use and browser cards (the app's value; a project may override it).
    approveAllCovers: approveAllCoversOf(st, null),
    // How many approval cards are waiting for Approve or Deny now. The desktop app counts it to alert the user (desktop/alerts.cjs).
    approvalsWaiting: pendingApprovals.size,
    effort: st.effort,
    theme: st.theme,
    // Whether the License Agreement is accepted (lib/legal.mjs). The page and the desktop app read legal.required.
    legal: legalSummary(st),
    // The message of the last save that failed, or null (lib/store.mjs). While it is set, the change on screen is not in the file
    // and is lost on restart; public/ext-store-health.js shows it.
    saveFailure: store.saveFailure(),
    // A saved prompts file that was damaged and set aside when it was read (lib/prompts.mjs promptsHealth): only the name of the kept file.
    // The page tells the person once and then acknowledges it (POST /api/prompts/health/ack), so a reload does not repeat it (B-78).
    promptsHealth: promptsHealth() ? { file: path.basename(promptsHealth().corruptFile), at: promptsHealth().at } : null,
    council: st.council ?? DEFAULT_COUNCIL,
    music: st.music ?? MUSIC_DEFAULT,
    relay: st.relay ?? RELAY_DEFAULT,
    sessionMode: st.sessionMode ?? 'transcript',
    coders: coderRefs(),
    // How many agents of the active project are queued or running now (lib/agent-run.mjs). GET /api/agents/live lists them.
    agentsRunning: active ? liveAgents(active.id).length : 0,
    // The drives a model is running (lib/drive.mjs) and the state of the stop key. The drive bar and pill read them from here, and
    // every state event carries them, so a window that reconnects sees them at once.
    drives: listDrives(),
    driveHotkey: hotkeyStatus(),
    // How a computer run is paced and how much of its log is kept (each read with a default; lib/computer/policy.mjs).
    // idleMinutes is the pause limit (state.json driveIdleMinutes; Settings › Computer use).
    computerSettings: { paceMs: paceOf(st), logDays: retentionOf(st).days, logMB: retentionOf(st).maxBytes / (1024 * 1024), idleMinutes: Number.isInteger(st.driveIdleMinutes) ? st.driveIdleMinutes : DEFAULT_IDLE_MINUTES },
    ...(messages ? { messages: log } : { messageCount: log.length, lastMessageTs: log.at(-1)?.ts ?? 0 }),
  };
}

// A chosen theme is written into the page itself, so it never flashes the other theme while loading. While the terms are not
// accepted, data-legal="pending" is written the same way, and one rule in style.css hides the app behind the agreement screen.
// Both attributes go in with one replace of the opening tag.
function withTheme(html) {
  const st = store.get();
  const attrs = [];
  if (st.theme === 'dark' || st.theme === 'light') attrs.push(`data-theme="${st.theme}"`);
  if (!termsAccepted(st)) attrs.push('data-legal="pending"');
  return attrs.length ? html.replace('<html lang="en">', `<html lang="en" ${attrs.join(' ')}>`) : html;
}

// The phone that answered a request, from x-plenum-device. Only the Bridge sets that header (lib/remote/proxy.mjs), and it drops any
// x-plenum-* header a phone sends, so the value is the Bridge's own device id. It is never read from a body. '' for a desktop window.
const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;
function viaOf(req) {
  const value = req.headers['x-plenum-device'];
  return typeof value === 'string' && DEVICE_ID.test(value) ? value : '';
}

// Asks the user to approve a tool action. Resolves true/false, and false on timeout or stop.
// A denial can carry the user's reason: finish puts it on the payload (the card object the caller passed), where the caller
// reads it. Only the answer is resolved, so a reason can never turn a denial into an approval.
// A card of a computer run carries kind 'computer' and, when it is about a screenshot, frame { run, n, w, h, marker? } (the page
// draws the picture from /api/computer/frame and puts a ring at the marker). The optional second argument is an object that
// receives { approvalId }, so the caller can close the card itself. requester.close(approvalId, reason) answers one of this
// requester's waiting cards as denied and tells the page to remove it ({ type: 'approval-closed', approvalId }); a run that is
// stopped closes its cards that way.
function approvalRequester(send, signal) {
  const own = new Set();
  const request = (payload, handle) => new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    const approvalId = randomUUID();
    own.add(approvalId);
    if (handle !== null && typeof handle === 'object') handle.approvalId = approvalId;
    let expired = false;
    let settled = false;
    // by is 'board' when the Agents board answered the card (POST /api/approve with from: 'board'), else ''. It goes on the events
    // channel, so the chat card in another window says where it was answered. via is the phone that answered (viaOf), when one did.
    const finish = (allow, reason = '', by = '', via = '') => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(approvalId);
      own.delete(approvalId);
      if (!allow && reason) payload.reason = reason;
      resolve(allow);
      // Every window is told how the card ended, so one that did not answer it can replace the card. Said once.
      if (settled) return;
      settled = true;
      activity.approvalDone(approvalId, allow ? 'approved' : expired ? 'timed-out' : signal.aborted ? 'stopped' : 'denied', by, via);
      events.publish({ type: 'approval', action: allow ? 'answered' : (expired ? 'expired' : signal.aborted ? 'stopped' : 'answered'), approvalId, allow, ...(by ? { by } : {}), ...(via ? { via } : {}) });
      events.publishState('approvals');
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => { expired = true; finish(false); }, APPROVAL_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    // fullDetail stays here and is never sent with the card: GET /api/approve/detail serves it, and only while the approval is waiting.
    const fullDetail = typeof payload.fullDetail === 'string' && payload.fullDetail ? payload.fullDetail : null;
    // meta is the run this card belongs to (beginRun), which says the project, the thread and the model on the board.
    const meta = runMeta.get(signal) ?? null;
    // defaultDeny and blocked come from a deny list card (denyListHit in lib/tools.mjs). A plain card carries neither.
    // card is what the chat shows; the Agents board shows the same card (lib/activity.mjs), so it is kept here, without the full diff.
    // who is the model's label, for the "Codex wants to run:" line; it is left out until the run has a model.
    const card = {
      approvalId,
      summary: payload.summary,
      detail: payload.detail ?? '',
      ...(fullDetail ? { hasMore: true } : {}),
      ...(payload.defaultDeny ? { defaultDeny: true } : {}),
      ...(payload.blocked ? { blocked: true } : {}),
      ...(payload.frame ? { frame: payload.frame } : {}),
      // A card that only a click answers (a rewind or a restore, lib/checkpoints.mjs restorePrompt): Y and N do nothing on it.
      ...(payload.clickOnly === true ? { clickOnly: true } : {}),
      ...(meta?.modelLabel ? { who: String(meta.modelLabel).slice(0, 80) } : {}),
    };
    pendingApprovals.set(approvalId, { finish, fullDetail, card, meta, at: Date.now() });
    send({ type: 'approval', ...card, ...(payload.kind ? { kind: payload.kind } : {}) });
    activity.approvalAdded({
      ...card,
      ...(meta ? { scope: meta.scope, projectId: meta.projectId, projectName: meta.projectName, threadName: meta.threadName, modelLabel: meta.modelLabel, runKind: meta.kind } : {}),
      at: Date.now(),
    });
    events.publishState('approvals');
  });
  request.close = (approvalId, reason = '') => {
    if (!own.has(approvalId)) return false;
    const entry = pendingApprovals.get(approvalId);
    if (!entry) return false;
    entry.finish(false, cleanReason(reason));
    send({ type: 'approval-closed', approvalId });
    return true;
  };
  return request;
}

// The model that wrote the newest chat reply in this thread (scopeId is the thread's id; Main's is the project's). A CLI session resumes
// only if its own seat wrote it.
function lastChatModel(scopeId) {
  const log = store.transcript(scopeId);
  for (let i = log.length - 1; i >= 0; i--) if (log[i].role === 'assistant' && log[i].kind === 'chat' && log[i].draft !== true) return log[i].model ?? null;
  return null;
}

// The stored messages a model is shown as history. A reply that ended with an error, or that holds no text, no tool turn and no provider
// blocks, is left out: an empty assistant message makes Claude and the OpenAI-compatible APIs refuse the next turn (B-49). A draft (a reply
// still streaming, B-29) is left out too: it is not a finished reply. The stored transcript itself is not changed.
function replayable(log) {
  return log.filter(m => m.draft !== true && !(m.role === 'assistant' && (m.error || (!String(m.content ?? '').trim() && !(m.tools?.length) && !m.api && !m.computerRun))));
}

// The notices said once per thread per launch (the rule for Build focus and the global rules): the key is kept in memory, so a restart
// says them again. Returns true the first time for a thread and key.
const noticed = new Set();
function noticeOnce(scopeId, key) {
  const id = `${scopeId}\u0000${key}`;
  if (noticed.has(id)) return false;
  noticed.add(id);
  return true;
}
const FOCUS_NOTICE = 'Build focus: only the checks that are strictly needed will run.';
const RULES_CHANGED_NOTICE = 'The rules changed, so this reply starts a new session with the chat so far.';
// The most text one reply keeps and sends (B-51). A CLI reply had no limit before, and the page redraws the whole reply on every frame. An
// API reply is already bounded by its max_tokens. The cut is marked in the reply itself.
const MAX_REPLY_CHARS = 256_000;
const REPLY_CAP_NOTE = '\n\n[Reply cut at 256,000 characters. The rest was not kept.]';
// The note a chat reply keeps when its run hit the time limit (RUN_TIMEOUT_MS).
const timeLimitNote = ref => `Stopped after ${RUN_TIMEOUT_MS / 3_600_000} hours, before ${labelFor(ref)} finished. Any files it created or changed are still on disk.`;

// The hash of the rules text (AGENTS.md and the global rules) each project's chat last sent. A change made outside Plenum shows up as a
// different hash on the next message, and that message starts a new Native session (prompt-wiring). The Rules panel forgets the sessions
// itself when it saves.
const rulesSeen = new Map();
// Forgets the Native sessions of every thread of a project, Main included, so the next message starts a new session with the chat so far.
function forgetRulesSessions(st, project) {
  forgetProjectSessions(project.id);
  for (const entry of threadsOf(st, project).list) forgetProjectSessions(entry.id);
}

// Saves the state file at the end of a run and, when the save fails, says so in the run's stream as an error event (B-28): the reply is
// on screen but is lost on restart. It never throws, so a failed save cannot replace the error a handler is already reporting; the
// failure also stays in publicState().saveFailure. send is the run's send, or null when no stream is open. At the start of a run
// (the question or goal saved at once, B-29) asNotice is true: the run goes on, and the stream says so in a notice instead of an error.
async function saveReporting(send, asNotice = false) {
  try {
    await store.saveOrFail();
    return true;
  } catch (err) {
    try {
      send?.(asNotice ? { type: 'notice', text: err.message } : { type: 'error', message: err.message });
    } catch {
      // The stream is gone; saveFailure still tells every window.
    }
    return false;
  }
}

// How often a reply that is still streaming is saved as its draft row (runTurn): the draft is saved at once when it starts, then again when
// its text, steps or spend have changed, at most this often (B-29).
const DRAFT_SAVE_MS = 4000;

// tools is the project's CLI options (effectiveSettings(...).tools). Only a chat turn passes it; the advisor stays read-only.
// denyPatterns is the project's own list (denyPatternsOf), added to the built-in deny list for every command this turn runs.
// readOnly is a chat turn in a project in plan mode, and every advisor call (a review or the auto-advisor), whether or not
// the project is in plan mode: streamChat gets readOnly, no ctx (so an API model gets no tools) and no
// native session (a resumed Codex session keeps the sandbox it started with, and a plan turn must not replace that session).
// mode is 'ask', 'auto' or 'all' (approvalModeOf in lib/projects.mjs); a read-only run is never given more than the caller's mode
// can do for it: streamChat maps Gemini to plan and Muse Code to ask for every read-only run, so none gets yolo or --disable-approval.
// answerBlocked is the project's "Approve all also answers blocked-command cards" switch (it matters only when mode is 'all').
// covers is { computer, browser }: whether Approve all also answers those cards (approveAllCoversOf); ctx.covers carries it to the
// computer-use and browser tools, which ask lib/tools.mjs coveredByApproveAll(ctx, 'computer' | 'browser').
// computer is { settings, task } when the person started a computer run with this message (Start in the Computer panel is the
// consent; settings come from normalizeRunSettings), else null. The run is made here, where the turn's stream, its tool list and its
// approvals are, and it is ctx.computer for the whole turn: run.start() comes before the first model request, the system text gains
// the run's rules, and run.finish() comes before the reply is stored. The reply keeps computerRun (what the run did) and never the
// provider's blocks, which hold the screenshots. selfStart is true when the model may start a run itself (the project's switch):
// ctx.startComputer(input) then builds one from the project's remembered choices and shows the start card first.
// browser is true when the model may use the Browser pane this turn (ctx.browser; the tools register themselves with a `when`).
// focus and rules are what a coder this turn delegates to is given (ctx.focus, ctx.rules; lib/tools/40-delegate.mjs): focus is Build focus
// for the project, rules the project's AGENTS.md record (loadProjectRules) or null.
// stoppedNote() returns the note of a run that hit its time limit, or null (B-49). The reply keeps it, with the error and the partial text.
// The reply is capped at MAX_REPLY_CHARS (B-51): past it the text is cut, a notice says so, and the stop reason is 'capped'.
async function runTurn({ ref, system, messages, root, kind, scope, mode, effort, send, signal, requestApproval, agent, tools, denyPatterns = [], answerBlocked = false, covers, readOnly = false, images = [], documents = [], computer = null, selfStart = false, browser = false, mcpBridge = false, focus = false, rules = null, stoppedNote = null }) {
  send({ type: 'start', kind, model: ref, label: labelFor(ref) });
  const out = { api: [], tools: [] };
  // scope is the thread this reply belongs to (lib/scope.mjs): its id keys the chat, the CLI sessions and the checkpoints, and the project
  // record is the project's. Computer runs and agents stay per project.
  const sid = scope.id;
  const pid = scope.projectId;
  // One run for this reply: every agent it starts counts against the same limits and shares the same places (lib/agent-run.mjs).
  const project = projectById(pid);
  const agents = effectiveAgents(store.get(), project);
  const agentRun = openRun({ projectId: pid, kind, signal });
  const caller = { role: 'chat', ref, label: labelFor(ref), depth: 0 };
  const ctx = {
    root,
    ref, // the model asking; the delegate tool reads it for the per-model agent limits (lib/tools/40-delegate.mjs)
    effort, // the effort of this reply: an agent whose type names none uses it
    agents, // the agent types and limits in force for this project (effectiveAgents)
    agentRun, // the run the agents of this reply belong to
    caller, // who is asking, for the limits: the chat, with the model
    project, // the project record, for the spend cap and the project switches
    // Claude Code's Agent requests on the CLI route: the types the chat may start there, counted by the same run (undefined when none)
    agentsOffer: agent ? offerFor({ agents, caller, run: agentRun, project, root, denyPatterns, mode, approve: requestApproval, emit: send, tools, signal }) : undefined,
    projectId: sid, // files the checkpoints taken before a write (lib/checkpoints.mjs): the thread's id, Main's is the project's
    denyPatterns, // the project's own deny patterns, read by denyListHit (lib/tools.mjs)
    answerBlocked, // Approve all answers blocked-command cards too (lib/tools.mjs answersBlocked)
    covers, // Approve all also answers computer-use and browser cards (lib/tools.mjs coveredByApproveAll)
    mode,
    signal,
    out,
    emit: send,
    approve: requestApproval,
    queueUpdate: payload => queueUpdate({ home: store.HOME, summary: payload.summary, files: payload.files }),
    tools, // read by the delegate tool, which hands it on to the coder
    browser: browser === true, // the model may use the Browser pane this turn (lib/tools/60-browser.mjs offers its tools on it)
    vision: imageSupport(ref).ok === true, // the model takes pictures, so browser_screenshot is offered (lib/tools/60-browser.mjs)
    mcpBridge: mcpBridge === true, // a CLI agent of this turn may reach Plenum through the bridge (lib/mcp-server.mjs, openBridge)
    focus: focus === true, // Build focus is on: a coder this turn delegates to gets the focus text (lib/tools/40-delegate.mjs)
    rules: rules ?? null, // the project's AGENTS.md record, which a coder this turn delegates to gets (lib/tools/40-delegate.mjs)
  };
  // A computer run on a model whose project tools are not allowed (an API model without a verified provider or a passed tool test; see
  // toolsAllowed) still gets a ctx, because the run lives on it, but only the two questions of the run are offered or answered, never
  // the project's file and command tools (ctx.only: lib/tools.mjs). Allow tools in Accounts is what grants those.
  const computerOnly = Boolean(computer) && !agent;
  if (computerOnly) ctx.only = new Set(['confirm_with_user', 'hand_over']);
  // The computer run of this turn, if any: the one the person started, or the one the model starts through ctx.startComputer.
  let run = null;
  const makeRun = (settings, task, consent) => {
    const project = projectById(pid);
    return createComputerRun({
      project, settings, task, ref, modelName: labelFor(ref), bridge: computerBridge, approve: requestApproval, closeApproval: requestApproval.close,
      emit: send, out, signal, budget: { project, log: store.transcript(sid), ref }, mode, covers, consent,
    });
  };
  if (computer) {
    run = makeRun(computer.settings, computer.task, 'drawer');
    ctx.computer = run;
    system = `${system}\n\n${run.systemText}`;
  } else if (selfStart) {
    ctx.startComputer = async (input = {}) => {
      const refuse = output => ({ ok: false, summary: 'Computer use not started', output });
      if (run) return refuse('A run is already going.');
      try {
        const support = await computerSupportFor(ref);
        if (support.level === 'no') return refuse(support.message);
        const probe = await computerBridge.probe();
        if (!probe.supported) return refuse(probe.reason || 'Computer use is not available on this computer.');
        const busy = canStartDrive('computer', pid);
        if (busy) return refuse(busy);
        const windows = await computerBridge.windows();
        const chosen = settingsFromPrefs(store.get().computerPrefs?.[pid], { windows, displays: probe.displays, app: input.app, scope: input.scope });
        const settings = normalizeRunSettings(chosen, { windows, displays: probe.displays, defaults: { paceMs: paceOf(store.get()) } });
        const task = String(input.task ?? '').trim().slice(0, 2000);
        if (!task) return refuse('Say what the computer run is for.');
        run = makeRun(settings, task, 'card');
        const begun = await run.start();
        if (!begun.ok) {
          // A run that could not start at all (busy, no desktop) is dropped, so the model may try again; a declined one stays, since
          // the person said no for this message.
          if (!begun.declined) run = null;
          return refuse(begun.declined ? 'The user did not allow computer use. Do not ask again; say what you need instead.' : begun.message);
        }
        if (run.drive) liveComputerRuns.set(run.drive.id, run);
        ctx.computer = run;
        return { ok: true, summary: 'Computer use started', output: `Computer use is on for this task. ${run.systemText} Take a screenshot to begin.` };
      } catch (err) {
        return refuse(err.message);
      }
    };
  }
  let text = '';
  let error = false;
  // What ended the reply with an error, when something did (a failed request, or a reply with no text). Stored with the reply (B-49).
  let failure = null;
  // 'length' when the reply stopped at the model's output limit (see onStop in streamChat). The page marks such a reply.
  // 'capped' when the reply passed MAX_REPLY_CHARS (B-51); a later onStop does not replace it.
  let stop = null;
  let capped = false;
  // One record per model request that reported its tokens (see onUsage in streamChat). They become the reply's usage below.
  const reports = [];
  // B-29: the reply is a draft row in the transcript while it streams. Each save puts the text, the steps and the spend so far on the
  // draft and saves the file quietly (the stream already shows the reply), so a kill or a crash keeps them; the row is finished at the
  // end, not added again (store.finishMessage). draftUsd is the spend the drafts have already added to the project, so the end adds only
  // the rest (accrueReply in lib/budget.mjs). The draft is never sent back as history (replayable).
  const billing = await billingFor(ref);
  const draft = store.addMessage(sid, { role: 'assistant', kind, model: ref, content: '', draft: true });
  let draftUsd = 0;
  let draftSig = null;
  const draftNow = () => {
    const sig = `${text.length}|${out.tools.length}|${reports.length}|${capped}`;
    if (sig === draftSig) return;
    draftSig = sig;
    const partial = summarizeUsage(ref, reports, { billing, partial: true });
    const dollars = partial?.cost?.dollars;
    if (billing === 'api' && Number.isFinite(dollars) && dollars > draftUsd) {
      accrueReply(projectById(pid), store.transcript(sid), { billing, cost: { dollars: dollars - draftUsd } });
      draftUsd = dollars;
    }
    draft.content = text;
    if (out.tools.length) draft.tools = out.tools.slice();
    else delete draft.tools;
    if (partial) draft.usage = partial;
    else delete draft.usage;
    store.persistQuiet();
  };
  // Best-effort: a save that throws is not allowed to end the process from a timer; the final save reports what failed.
  const draftTick = () => {
    try {
      draftNow();
    } catch {
      // The reply carries on; its end is saved as usual.
    }
  };
  draftTick();
  const draftTimer = setInterval(draftTick, DRAFT_SAVE_MS);
  try {
    // The computer run starts before the first model request: its checks (and, for a run the model started, its card) come first, and a
    // run that is not allowed to start ends the turn with a plain note instead of a model call.
    let go = true;
    if (run) {
      const begun = await run.start();
      if (!begun.ok) {
        go = false;
        if (!begun.declined) {
          error = true;
          send({ type: 'error', message: begun.message });
        }
      } else if (run.drive) {
        liveComputerRuns.set(run.drive.id, run);
      }
    }
    const session = kind === 'chat' && !readOnly ? { projectId: sid, emit: send, lastReplyModel: lastChatModel(sid) } : null;
    if (go) {
      // Cursor and Grok Build always get the ctx: their approval cards (ask first, the default) are asked through ctx.approve, and they keep
      // their own tools (lib/cursor.mjs, lib/grok.mjs). A read-only run of either ignores the ctx there.
      const cardTurn = ['cursor', 'grok'].includes(splitRef(ref).provider);
      for await (const delta of streamChat(ref, { system, messages, cwd: root, signal, ctx: agent || computerOnly || cardTurn || mcpBridge ? ctx : undefined, mode, effort, readOnly, session, tools, images, documents, onUsage: rec => reports.push(rec), onStop: r => { if (!capped) stop = r; } })) {
        // Past the cap the rest of the stream is read but neither kept nor sent, so the process and its tool calls still finish (B-51).
        if (capped || !delta) continue;
        if (text.length + delta.length > MAX_REPLY_CHARS) {
          const shown = delta.slice(0, Math.max(0, MAX_REPLY_CHARS - text.length)) + REPLY_CAP_NOTE;
          text += shown;
          send({ type: 'delta', text: shown });
          capped = true;
          stop = 'capped';
          continue;
        }
        text += delta;
        send({ type: 'delta', text: delta });
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      error = true;
      failure = err.message;
      send({ type: 'error', message: err.message });
    }
  } finally {
    // Every agent of this reply is over: any that still waits is stopped, and the run's agents leave the live list. No draft is saved after this.
    clearInterval(draftTimer);
    agentRun.close();
  }
  // The run ends before the reply is stored: it releases the keys, hides the on-screen bar and closes its log, and says what it did.
  // A stop reason the run already has (Stop, the stop key, a limit) wins over the way the turn ended.
  let computerRun = null;
  if (run) {
    try {
      computerRun = await run.finish(error ? 'error' : signal.aborted ? 'cancelled' : 'done');
    } catch (err) {
      send({ type: 'notice', kind: 'computer', text: `The computer run could not be closed cleanly: ${err.message}` });
    }
    for (const [id, live] of liveComputerRuns) if (live === run) liveComputerRuns.delete(id);
  }
  // A run that finished with nothing to show is reported, not silently dropped.
  if (!error && !signal.aborted && !text.trim() && !out.tools.length && !run?.declined) {
    error = true;
    failure = `${labelFor(ref)} finished without a reply. Try again, or lower the effort (the Effort selector).`;
    send({ type: 'error', message: failure });
  }
  // The provider's blocks of a computer run hold the screenshots and the toolset calls, so they are never kept: a later request
  // without the toolset would refuse them, and the frames belong to the run log, not to state.json.
  const api = run ? null : out.api.length ? out.api : null;
  // What the reply used and cost (summarizeUsage in lib/pricing.mjs): tokens and an estimated price for an API model,
  // tokens only for a subscription CLI, and null for the offline echo model. A reply whose model reported no tokens is
  // kept as "not reported". A run that was stopped or failed is marked partial, since its last request may have used
  // tokens that were never reported.
  const usage = summarizeUsage(ref, reports, { billing, partial: signal.aborted || error });
  // The reply's cost goes into the project's running spend once, here, before the reply is stored, so a spend record that
  // starts now begins from the transcript without this reply (lib/budget.mjs). A subscription CLI reply adds nothing. The drafts
  // added what they had already, so only the rest is added here (B-29).
  accrueReply(projectById(pid), store.transcript(sid), usage?.cost && Number.isFinite(usage.cost.dollars) ? { ...usage, cost: { ...usage.cost, dollars: usage.cost.dollars - draftUsd } } : usage);
  // A reply that failed, was stopped or hit the time limit is still stored (B-49): the partial text stays, the error is kept with it, and
  // the page can say so after a reload. A run that hit its limit with no text keeps the limit note as its content (the note is not added
  // a second time by the caller). A stopped reply with nothing in it is stored as an empty stopped reply.
  const note = typeof stoppedNote === 'function' ? stoppedNote() : null;
  const kept = failure ?? (note && text.trim() ? note : null);
  const content = !text.trim() && note && !kept ? note : text;
  // The draft row becomes the reply, in place (B-29). A reply with nothing to keep leaves no row, as before.
  if (text.trim() || out.tools.length || api || (computerRun && computerRun.id) || kept || signal.aborted) {
    store.finishMessage(sid, draft, {
      role: 'assistant',
      kind,
      model: ref,
      content,
      ...(out.tools.length ? { tools: out.tools } : {}),
      ...(api ? { api } : {}),
      ...(computerRun && computerRun.id ? { api: null, computerRun } : {}),
      ...(usage ? { usage } : {}),
      ...(stop ? { stop } : {}),
      ...(kept ? { error: kept } : {}),
      ...(signal.aborted ? { aborted: true } : {}),
    });
  } else {
    store.removeMessage(sid, draft);
  }
  return { text, error, usage, stop };
}

// A project at its spend cap refuses a send to an API-key model before anything is stored or any provider is called
// (lib/budget.mjs). The refusal is a 400 with the plain message, marked policy: true (the error body carries it) so the page shows it as
// a notice from Plenum and puts the typed text back, not as a failure (B-105). A subscription CLI and the offline model are never refused.
async function refuseAtCap(project, messages, ref) {
  const billing = await billingFor(ref);
  try {
    checkBudget(project, messages, billing);
  } catch (err) {
    throw Object.assign(httpError(400, err.message), { policy: true });
  }
}

// A Google AI run needs a computer-use model that answers with this key. It is looked for here, before the overlay, the bar and the key are
// started, so a key with no such model is refused at the start instead of after the run has begun (lib/computer/gemini.mjs).
async function googleComputerModel(ref, detail) {
  const { provider, id } = splitRef(ref);
  if (detail.level === 'no' || provider !== 'googleai') return detail;
  const model = await resolveGeminiComputerModel(id).catch(() => null);
  return model ? detail : { level: 'no', message: NO_MODEL, note: 'no computer-use model answers for this key' };
}

// Whether a model can run the computer, and how: lib/computer/support.mjs for the models with a computer tool of their own, and when it
// says no, the generic screenshot-and-act loop (lib/computer/generic.mjs) for any other API model with a saved key. Same shape as
// computerSupportDetail: { level: 'toolset' | 'unverified' | 'native' | 'generic' | 'no', message, note }.
async function computerSupportFor(ref) {
  const detail = await googleComputerModel(ref, await computerSupportDetail(ref));
  if (detail.level !== 'no') return detail;
  const generic = await driverFor('generic');
  return (typeof generic?.genericSupportDetail === 'function' ? await generic.genericSupportDetail(ref) : null) ?? detail;
}

// A phone's send carries x-plenum-client-id (the phone layer sets it, lib/remote/proxy.mjs passes it on), so a retry after a dropped
// connection cannot send the same message twice. A repeat within SEND_REPEAT_MS of the first is refused with the usual 409. A send is
// recorded when its run starts (see handleTurn), so one refused before that (busy, folder gone) can be sent again.
const SEND_REPEAT_MS = 60_000;
const SEND_IDS_MAX = 256;
const CLIENT_SEND_ID = /^[A-Za-z0-9._-]{1,64}$/;
const sentClientIds = new Map(); // x-plenum-client-id -> when its send started
function noteSend(req) {
  const id = req.headers['x-plenum-client-id'];
  if (typeof id !== 'string' || !CLIENT_SEND_ID.test(id)) return;
  const now = Date.now();
  for (const [key, at] of sentClientIds) if (now - at >= SEND_REPEAT_MS) sentClientIds.delete(key);
  if (sentClientIds.has(id)) throw httpError(409, 'That message was already sent.');
  sentClientIds.set(id, now);
  while (sentClientIds.size > SEND_IDS_MAX) sentClientIds.delete(sentClientIds.keys().next().value);
}

// Chat turns and /review share this path. /review reviews the last answer plus the working-tree diff, and streams the
// answer as server-sent events. A message that arrives while the project is running is refused with 409. Follow-ups
// typed during a run wait in the page, which sends each one as a normal message when the run before it ends, so every
// message has its own stream for its approval cards.
async function handleTurn(req, res, { review }) {
  const body = await readBody(req, CHAT_BODY_LIMIT);
  const project = projectById(body.project);
  // The thread this turn belongs to: body.thread, else the project's active thread. An id that is not an open thread of this project
  // (an unknown one, or another project's) answers 404 before anything is stored.
  let scope = scopeFor(store, project, threadOf(body));
  // Checked before anything is stored, so no message is saved against a folder that is not there (B-73).
  if (await folderGone(project)) throw missingFolder(project);
  if (updating) throw httpError(409, UPDATING_TEXT);
  if (shuttingDown) throw httpError(409, CLOSING_TEXT);
  if (running.has(scope.id)) throw httpError(409, 'This project is already running. Use /cancel first.');
  refuseWhileExclusive(project, scope);
  // The scope was read before the folder check awaited: a Keep or Discard of this thread's copy may have begun since, so it is read again
  // here, with nothing awaited between this and beginRun.
  scope = refuseClosingCopy(project, scope);

  // Nothing is awaited between the checks above and beginRun, so a repeat cannot pass the check while the first is being started.
  if (!review) noteSend(req);
  const ac = new AbortController();
  beginRun(project, scope, ac, { kind: review ? 'review' : 'chat' });
  events.publishState('run');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, RUN_TIMEOUT_MS);
  let streaming = false;
  // Every event of the run is also published on the events channel with the run's id, so another window can show the run
  // as it goes. The stream here carries the same events, each with that id and the id of the thread the run belongs to (thread).
  // The Agents board reads the same events (lib/activity.mjs).
  const runId = randomUUID();
  const tagged = events.tag(runId, project.id, review ? 'review' : 'chat');
  const send = obj => {
    const ev = tagged({ ...obj, thread: scope.id });
    activity.runEvent(scope.id, ev);
    if (streaming && !res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    const st = store.get();
    // What this project's runs use (B-4): its own model, effort and approval mode where it sets them, the app's where it does not.
    // 'all' is Approve all. Settings that no longer validate read as ask (approvalModeOf).
    const eff = effectiveSettings(st, project);
    const mode = approvalModeOf(st, project);
    const log = store.transcript(scope.id);
    const root = scope.root;
    let ref;
    let kind;
    let system;
    let messages;
    let question = '';
    let agent = false;
    // The project's AGENTS.md record and the global rules this turn's prompt carries (null when there is none), and Build focus (lib/focus.mjs).
    let rules = null;
    let globalRules = null;
    let focus = false;
    // True when the rules differ from the ones the last message of this project was sent with (see rulesSeen).
    let rulesChanged = false;
    // False when saving the question at once failed (see below); the stream says so in a notice.
    let questionSaved = true;
    // Notices from prompt parts (a part that failed is left out of the prompt). They are sent once the reply's stream opens.
    const promptNotices = [];
    let planMode = false;
    // The settings of the computer run this message starts (normalizeRunSettings), or null, and the task the person typed.
    let computerSettings = null;
    let computerTask = '';
    // Pictures and PDFs that came with this message (never kept: the transcript gets their names and sizes, see below).
    let images = [];
    let documents = [];
    // Whether this chat turn runs the model's own tool loop (set with planMode below).
    let toolLoop = false;
    // What the turn hooks (lib/turn-hooks.mjs) add to the message: blocks for the model, labels for the stored message, notices.
    let extra = { blocks: [], labels: [], notes: [] };
    // The context the turn hooks get (lib/turn-hooks.mjs). Set for a chat turn only, never for a review.
    let hookCtx = null;

    if (review) {
      const answerIdx = findLastIndex(log, m => m.role === 'assistant' && m.kind === 'chat');
      if (answerIdx < 0) throw httpError(400, 'Nothing to review yet. Send a message first.');
      const questionIdx = findLastIndex(log.slice(0, answerIdx), m => m.role === 'user' && m.kind === 'chat');
      question = questionIdx >= 0 ? log[questionIdx].content : '(question not recorded)';
      ref = body.model ? parseRef(body.model) : st.advisor;
      if (!ref) throw httpError(400, 'Advisor is off. Turn it on with /advisor opus.');
      kind = 'advisor';
      setRunModel(ac.signal, ref);
      await refuseAtCap(project, log, ref);
      system = await buildSystem('advisor', { root, projectId: project.id, project, ref, base: [ADVISOR_SYSTEM] });
      messages = advisorMessages({ question, answer: log[answerIdx].content, diff: await workingDiff(root), cwd: root });
    } else {
      // A message that is not text (an object, a number) used to be sent on as "[object Object]" (B-71).
      if (body.message != null && typeof body.message !== 'string') throw httpError(400, 'The message must be text.');
      const text = String(body.message ?? '').trim();
      if (!text) throw httpError(400, 'Empty message.');
      // A thread other than Main has the model it was given; Main follows the project's model, else the app's.
      ref = body.model ? parseRef(body.model) : (scope.model ?? eff.model ?? st.model);
      kind = 'chat';
      setRunModel(ac.signal, ref);
      await refuseAtCap(project, log, ref);
      const { provider } = splitRef(ref);
      const api = apiProvider(provider);
      // Claude (through its API key) and an API model whose tools are allowed (toolsAllowed in lib/tool-trust.mjs: a verified
      // provider, or a model that passed the tool test and has its switch on, or a provider whose live tool-call check passed and the
      // model's own switch is not Off (toolsOnFor in lib/tool-verify.mjs, xAI once Check tool calls succeeds)) run the server's own tool
      // loop. The rest are text only.
      agent = provider === 'anthropic' || toolsAllowed(ref) || toolsOnFor(ref);
      // Through the CLI, Claude brings its own tools and reads attached files itself.
      const ownTools = provider === 'anthropic' ? agent && (await claudeRoute()) === 'api' : agent;
      // Plan mode makes this turn read-only: no tool loop (so no ctx reaches streamChat), no tool instructions in the
      // prompt, and no earlier tool turns in the history, which an API request without tools would refuse.
      // Plan mode makes the turn read-only: the project's, the thread's own, or a thread that is not the one that writes in the folder.
      planMode = planModeOf(project, scope);
      toolLoop = ownTools && !planMode;
      if (planMode) agent = false;
      // The turn hooks (lib/turn-hooks.mjs) see the message before its files are read: expandMessage adds what the model reads with it.
      // A hook that refuses the message (a 400 error) ends the request here, before anything is stored.
      hookCtx = { project, scope, kind: 'chat', ref, planMode, send: null, signal: ac.signal, store, record: null, changed: null, followUp: null, busy: () => running.has(scope.id) };
      extra = await runExpand(hookCtx, text);
      // A computer run is started by the person for this one message (Start in the Computer panel is the consent). Everything that
      // can refuse it does so here, before the message is stored and before anything is shown on the screen.
      if (body.computer !== undefined && body.computer !== null && body.computer !== false) {
        if (planMode) throw httpError(400, 'Plan mode is on, so Plenum will not control the computer here.');
        const support = await computerSupportFor(ref);
        if (support.level === 'no') throw httpError(400, support.message);
        if (!computerBridge.available) throw httpError(400, 'Computer use needs the desktop app.');
        const probe = await computerBridge.probe();
        if (!probe.supported) throw httpError(400, [probe.reason, permissionHelp(process.platform, probe)].filter(Boolean).join(' ') || 'Computer use is not available on this computer.');
        const busy = canStartDrive('computer', project.id);
        if (busy) throw httpError(409, busy);
        computerSettings = normalizeRunSettings(body.computer, { windows: await computerBridge.windows(), displays: probe.displays, defaults: { paceMs: paceOf(st) } });
        computerTask = text;
      }
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
      // Build focus (lib/focus.mjs): the newest message carries the one-line reminder for every model, so a resumed Native session, whose
      // system text went with its first turn, is reminded too. The stored message keeps the text as typed, so the transcript never shows it.
      focus = buildFocusOf(project);
      const focusReminder = focus ? `\n\n${FOCUS_REMINDER}` : '';
      messages = [...historyFor(replayable(log), ref, { textOnly: !toolLoop }), { role: 'user', content: withInline(expanded.text, [...got.inline, ...extra.blocks.map(block => ({ block }))]) + focusReminder }];
      // The project's AGENTS.md and the global rules (Plenum's Rules panel), read on every chat turn so an edit shows on the next message.
      // Null when there is none. They go into the prompt through the prompt parts (lib/prompt-parts/30 and 35), which also say so in a notice.
      rules = await loadProjectRules(root);
      globalRules = await loadGlobalRules();
      // A notice the parts send about the global rules is said once per thread per launch, as the Build focus notice is.
      const emitPromptNotice = notice => {
        if (typeof notice?.text === 'string' && notice.text.startsWith('Using your global rules') && !noticeOnce(scope.id, 'global-rules')) return;
        promptNotices.push(notice);
      };
      system = await buildSystem('chat', { root, projectId: project.id, project, agent: toolLoop, readOnly: planMode, mode, ref, rules, globalRules, emit: emitPromptNotice });
      // A change to AGENTS.md or the global rules since the project's last message starts its Native sessions again, so the model sees the
      // new rules (the session keeps the rules it started with). Only a Native session is affected; the transcript is resent by the next turn.
      const rulesKey = hashText(`${rules?.text ?? ''}\n\u0000\n${globalRules?.text ?? ''}`);
      rulesChanged = sessionMode(st) === 'native' && rulesSeen.has(project.id) && rulesSeen.get(project.id) !== rulesKey;
      if (rulesChanged) forgetRulesSessions(st, project);
      rulesSeen.set(project.id, rulesKey);
      // Only the name and size of each picture and file are saved, never its bytes.
      const kept = describeUploads(images, { inline: got.inline, documents });
      // A computer run shows as a chip under the message: the apps it may use and whether it sees one window or a display.
      const computerNote = computerSettings
        ? { computer: { task: true, apps: computerSettings.scope === 'window' ? [appName(computerSettings.targetWindow.exe)] : computerSettings.allow.map(a => appName(a.exe)), scope: computerSettings.scope } }
        : {};
      // context: the labels a turn hook gives for what it added to the message (lib/turn-hooks.mjs), shown under it.
      store.addMessage(scope.id, { role: 'user', kind: 'chat', content: text, attached: expanded.attached, ...(kept.length ? { images: kept } : {}), ...computerNote, ...(extra.labels.length ? { context: extra.labels } : {}) });
      // Saved now, not when the reply ends, so a kill or a crash during the reply keeps the question (B-29). The stream is not open yet, so a
      // failed save is said in a notice once it is (questionSaved), and the reply goes on.
      questionSaved = await saveReporting(null);
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
    // A thread that is only read-only because another thread is the writer says that instead (the notice names the writer).
    if (planMode) send({ type: 'notice', text: readOnlyWhy(project, scope) === 'writer' ? readOnlyNotice(scope) : PLAN_NOTICE });
    if (rules) send({ type: 'notice', text: `Using AGENTS.md (${rules.text.length} characters) from this project.` });
    for (const notice of promptNotices) send(notice);
    if (focus && noticeOnce(scope.id, 'focus')) send({ type: 'notice', text: FOCUS_NOTICE });
    if (rulesChanged) send({ type: 'notice', text: RULES_CHANGED_NOTICE });
    if (!questionSaved) send({ type: 'notice', text: `${store.saveFailure() ?? 'Plenum could not save its state file.'} Your message is shown but is lost on restart until a save works.` });
    // The notes of the turn hooks that ran before the stream opened, and the hooks' own sends from here on.
    for (const note of extra.notes) send({ type: 'notice', text: note });
    if (hookCtx) hookCtx.send = send;
    // Approve all is announced once per project (and thread) per launch, on a chat turn that can act. The red button and the Mode
    // menu keep saying it after that. A plan-mode turn changes nothing, so it does not use up the notice.
    const answerBlocked = approveAllBlockedOf(project);
    if (mode === 'all' && kind === 'chat' && !planMode) {
      const key = scope.id;
      if (!approveAllSaid.has(key)) {
        approveAllSaid.add(key);
        send({ type: 'notice', kind: 'approve-all', text: answerBlocked ? APPROVE_ALL_BLOCKED_NOTICE : APPROVE_ALL_NOTICE });
      }
    }

    const requestApproval = approvalRequester(send, ac.signal);
    // Only a chat turn gets the project's CLI options. A review (advisor) is read-only, like the council and the reviewers.
    // A plan-mode turn gets none either, as no relay hop does: nothing in the options can widen a read-only run.
    const tools = kind === 'chat' && !planMode ? effectiveSettings(st, project).tools : undefined;
    const denyPatterns = kind === 'chat' ? denyPatternsOf(project) : [];
    if (hookCtx) {
      // The stored message is this turn's record: the turn snapshot goes on it (lib/hooks/10-snapshot.mjs). followUp lets a hook start
      // a further chat turn with this one's settings (pro-06 and pro-09): null when the run was stopped or the project is in plan mode,
      // refused with a notice at the spend cap, and otherwise the result of that turn.
      hookCtx.record = store.transcript(scope.id).at(-1);
      hookCtx.followUp = async (followText, { marker } = {}) => {
        if (ac.signal.aborted || planMode) return null;
        try {
          await refuseAtCap(project, store.transcript(scope.id), ref);
        } catch {
          send({ type: 'notice', text: 'Auto-fix stopped: this project is at its spend cap.' });
          return null;
        }
        const history = historyFor(replayable(store.transcript(scope.id)), ref, { textOnly: !toolLoop });
        store.addMessage(scope.id, { role: 'user', kind: 'chat', content: String(followText), auto: marker });
        hookCtx.record = store.transcript(scope.id).at(-1);
        await runBefore(hookCtx);
        return runTurn({
          ref, system, messages: [...history, { role: 'user', content: String(followText) }], root, kind: 'chat', scope, mode, effort: eff.effort, send, signal: ac.signal,
          requestApproval, agent: agent && kind === 'chat', tools, denyPatterns, answerBlocked, covers: approveAllCoversOf(st, project), readOnly: false, images: [], documents: [],
          focus, rules,
        });
      };
      await runBefore(hookCtx);
    }
    // The model this turn uses, for the Agents board (lib/activity.mjs). Its own start event carries no model.
    activity.runEvent(scope.id, { type: 'start', model: ref, label: labelFor(ref) });
    const turn = await runTurn({
      ref, system, messages, root, kind, scope, mode, effort: eff.effort, send, signal: ac.signal, requestApproval, agent: agent && kind === 'chat', tools, denyPatterns, answerBlocked, covers: approveAllCoversOf(st, project), readOnly: review || planMode, images, documents,
      // The computer run this message starts (the person pressed Start in the Computer panel), the project's switch that lets the model
      // start one itself, and whether the model may use the Browser pane (on unless the pane's switch is off; desktop app only).
      computer: computerSettings ? { settings: computerSettings, task: computerTask } : null,
      selfStart: kind === 'chat' && !planMode && !computerSettings && computerSelfStartOf(project) && computerBridge.available,
      browser: kind === 'chat' && !planMode && browserAvailable() && st.browser?.agent !== false,
      mcpBridge: kind === 'chat' && !planMode,
      focus, rules,
      // A run that hit its time limit keeps this note in its stored reply (runTurn), so the chat shows it after a reload (B-49).
      stoppedNote: () => (timedOut ? timeLimitNote(ref) : null),
    });
    // A plan turn runs outside the model's native CLI session, so that session has not seen it. Forgetting the session makes
    // the next normal turn start a new one with the whole chat, plan included.
    if (planMode) forgetSession(scope.id, ref);
    // The turn's 'after' snapshot and the hooks after it. A run that was stopped or timed out takes none.
    if (hookCtx && !ac.signal.aborted) await runAfter(hookCtx, turn);

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
          scope,
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
      // The note is stored with the reply by runTurn (stoppedNote), so a run that hits the limit never just disappears. Here it is only
      // shown on the stream, as the reply or as an error after the partial text.
      const note = timeLimitNote(ref);
      if (turn.text.trim()) send({ type: 'error', message: note });
      else send({ type: 'delta', text: note });
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
    endRun(scope.id, ac);
    events.publishState('run');
    await saveReporting(streaming ? send : null);
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
  const scope = scopeFor(store, project, threadOf(body));
  if (updating) throw httpError(409, UPDATING_TEXT);
  if (shuttingDown) throw httpError(409, CLOSING_TEXT);
  if (running.has(scope.id)) throw httpError(409, 'This project is already running. Use /cancel first.');
  refuseWhileExclusive(project, scope);
  const log = store.transcript(scope.id);
  const before = log.filter(m => m.kind === 'chat').length;
  if (before < 2) throw httpError(400, 'There is not enough conversation to compact yet.');

  // st is the app state with this project's own model applied (B-4): st.model is the model the summary is written by.
  const app = store.get();
  const st = { ...app, model: scope.model ?? effectiveSettings(app, project).model ?? app.model };
  const ac = new AbortController();
  beginRun(project, scope, ac, { kind: 'compact' });
  events.publishState('run');
  // The summary is not streamed, so another window is told only that a compact started and ended.
  const tagged = events.tag(randomUUID(), project.id, 'compact');
  tagged({ type: 'start', kind: 'compact', thread: scope.id });
  const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    // The summary is an API call on the main model, so a capped project refuses it the same way (before anything runs).
    // It is checked after the project is marked running, as a chat turn is, so no other run can start during the check.
    await refuseAtCap(project, log, st.model);
    let summary = '';
    const messages = [{ role: 'user', content: `Summarise this conversation.\n\n<<<CONVERSATION\n${transcriptText(log)}\nCONVERSATION>>>` }];
    // The summary is always written read-only, in every chat mode (B-53): it is text only, so no feature is lost, and a CLI model cannot
    // touch the project folder here. A Codex project's Read only setting is therefore not overridden by a compact.
    const readOnly = true;
    // The summary's own cost goes into the running spend (lib/budget.mjs) when the call ends, whether or not the summary is kept.
    const reports = [];
    const billing = await billingFor(st.model);
    try {
      const system = await buildSystem('compact', { root: scope.root, projectId: project.id, project, ref: st.model, base: [COMPACT_SYSTEM] });
      for await (const delta of streamChat(st.model, { system, messages, cwd: scope.root, signal: ac.signal, mode: 'ask', effort: 'low', readOnly, onUsage: rec => reports.push(rec) })) {
        summary += delta;
      }
    } finally {
      accrueReply(project, log, summarizeUsage(st.model, reports, { billing, partial: ac.signal.aborted }));
      // Saved on every outcome, as a chat turn and a build are (B-44), so a failed summary keeps its billed cost across a restart.
      // saveReporting never throws, so a failed save here cannot replace the error this run is reporting (B-28).
      await saveReporting(null);
    }
    if (ac.signal.aborted) throw httpError(499, 'Compacting was cancelled. The chat is unchanged.');
    summary = summary.trim();
    if (!summary) throw httpError(502, `${labelFor(st.model)} returned an empty summary. The chat is unchanged.`);
    keepArchive(scope.id, [...log], 'compact');
    log.length = 0;
    forgetProjectSessions(scope.id);
    store.addMessage(scope.id, { role: 'user', kind: 'chat', compact: true, content: `${COMPACT_HEAD}\n\n${summary}` });
    await store.saveOrFail();
    return json(res, 200, { ...publicState(), compacted: before });
  } finally {
    clearTimeout(timer);
    endRun(scope.id, ac);
    tagged({ type: 'done', aborted: ac.signal.aborted, thread: scope.id });
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
// after, when given, is called once the run's events are over and before done, whether the run ended well or not; it stores what the run
// leaves in the chat. The state file is saved at the end (saveReporting), so a failed save is an error event in this stream (B-28).
// opts.scope is the thread the run belongs to (lib/scope.mjs); without it, the thread the request names (body.thread, kept on the request by
// readBody, or the thread query), else the project's active thread. A build, a restore, a rewind and a merge are project-wide: they start only
// when every thread of the project is idle (409 'Another thread in this project is running. Builds wait until every thread is idle.'), and
// while one is live no other thread of the project starts a run. makeRun is given { signal, send, scope }.
async function streamForProject(req, res, project, makeRun, onEvent, { kind = 'run', after, scope: given } = {}) {
  let asked;
  try {
    asked = threadOf(req.plenumBody) ?? threadOf(new URL(req.url, 'http://localhost').searchParams);
  } catch {
    asked = undefined;
  }
  let scope = given ?? scopeFor(store, project, asked);
  // A run in a folder that is not there is refused before it starts (B-73: council, build, compare and relay). This check comes
  // before the busy check, so nothing awaits between that check and the run being marked as running.
  if (await folderGone(project)) throw missingFolder(project);
  if (updating) throw httpError(409, UPDATING_TEXT);
  if (shuttingDown) throw httpError(409, CLOSING_TEXT);
  const busy = busyRefusal(project, scope, EXCLUSIVE_KINDS[kind]);
  if (busy) throw busy;
  refuseWhileExclusive(project, scope);
  // The scope may be older than this moment (a route read it before its own awaits, a merge before its git preflight): it is read again,
  // so a copy that a Keep or Discard holds now is refused, and the run gets the scope as it is.
  scope = refuseClosingCopy(project, scope);
  const ac = new AbortController();
  beginRun(project, scope, ac, { kind });
  if (EXCLUSIVE_KINDS[kind]) exclusive.set(project.id, { scope: scope.id, kind });
  events.publishState('run');
  // A route module that builds a seat's generator from the signal alone (pipelines) finds its project this way (agent-roles).
  registerRunScope(ac.signal, { project, kind, scope });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, RUN_TIMEOUT_MS);
  let streaming = false;
  const tagged = events.tag(randomUUID(), project.id, kind);
  const send = obj => {
    const ev = tagged({ ...obj, thread: scope.id });
    activity.runEvent(scope.id, ev);
    if (streaming && !res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  // What the run leaves in the chat is stored here, once, however the run ended. A failure of the hook is reported in the stream.
  const finishRun = async () => {
    if (typeof after !== 'function') return;
    try {
      await after();
    } catch (err) {
      send({ type: 'error', message: err.message });
    }
  };
  try {
    const run = await makeRun({ signal: ac.signal, send, scope });
    streaming = true;
    res.writeHead(200, SSE_HEADERS);
    for await (const ev of run) {
      onEvent?.(ev);
      send(ev);
    }
    await finishRun();
    send({ type: 'done', aborted: ac.signal.aborted, timedOut });
  } catch (err) {
    if (!streaming) throw err;
    // What the run left in the chat is stored before the stream says anything more, as in the normal end.
    await finishRun();
    send({ type: 'error', message: err.message });
    send({ type: 'done', aborted: ac.signal.aborted, timedOut });
  } finally {
    clearTimeout(timer);
    endRun(scope.id, ac);
    if (exclusive.get(project.id)?.scope === scope.id) exclusive.delete(project.id);
    events.publishState('run');
    await saveReporting(streaming ? send : null);
    if (streaming) res.end();
  }
}

// The recent conversation as plain text, for the seats. Council and build results count as replies.
function councilHistory(log) {
  return log
    .filter(m => (m.kind === 'chat' || m.kind === 'council' || m.kind === 'build') && m.draft !== true)
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
  const scope = scopeFor(store, project, threadOf(body));
  const question = String(body.question ?? '').trim();
  if (!question) throw httpError(400, 'Ask the council a question first.');
  let config;
  let images;
  try {
    // The project's own council when it has one (B-4), else the app's saved one; a council sent in the body wins.
    config = normalizeCouncil(body.config ?? effectiveSettings(store.get(), project).council ?? DEFAULT_COUNCIL);
    // The pictures that go with the question (pro-07 step 2): checked like a chat message's, before anything is stored.
    images = checkImages({ sent: body.images });
  } catch (err) {
    throw httpError(400, err.message);
  }
  const kept = describeImages(images);
  const history = councilHistory(store.transcript(scope.id));
  // Kept as the run goes, so a cancelled council still leaves its answers in the chat. error is the reason the run ended without a
  // verdict (its error event), and rounds is the number of rounds it was set to run (B-52).
  const saved = { seats: {}, result: null, seatMeta: [], error: null, rounds: null };
  await streamForProject(req, res, project, async ({ signal, send }) => {
    // The question keeps the names and sizes of its pictures, never their bytes.
    store.addMessage(scope.id, { role: 'user', kind: 'council', content: question, ...(kept.length ? { images: kept } : {}) });
    // Saved now, so a kill during the council keeps the question (B-29). A failed save is said in a notice and the council goes on.
    await saveReporting(send, true);
    // One run for the whole council (every seat, every round and the moderator): the agents a seat starts count against the Council
    // seats and Moderator rows and the per-run ceiling, and the run is closed when the stream ends (lib/agent-run.mjs seatContext).
    const agents = effectiveAgents(store.get(), project);
    const run = openRun({ projectId: project.id, kind: 'council', signal });
    return withRun(run, runCouncil({
      question, config, cwd: scope.root, signal, history, project, agents, run, images,
      denyPatterns: denyPatternsOf(project), tools: effectiveSettings(store.get(), project).tools, mode: approvalModeOf(store.get(), project), approve: approvalRequester(send, signal),
    }));
  }, ev => {
    if (ev.type === 'council-start') {
      saved.seatMeta = ev.seats;
      saved.rounds = ev.rounds ?? null;
    }
    // A failed round keeps no text, so a reload never shows an empty answer as a finished one (B-52). ok<n> records the outcome (B-13).
    if (ev.type === 'seat-done') {
      const seat = (saved.seats[ev.seat] ??= {});
      seat[`ok${ev.round}`] = ev.ok === true;
      if (ev.ok) seat[`round${ev.round}`] = ev.text;
      else seat.error = ev.error ?? 'The seat did not answer.';
    }
    if (ev.type === 'consensus') saved.result = ev.result;
    // The run's error event: fewer than two seats answered, or the moderator failed. Its message is the reason shown after a reload.
    if (ev.type === 'error') saved.error = ev.message;
  }, {
    kind: 'council',
    scope,
    // Stored before the stream says done, and saved with the run's final save, so a failed save shows in the stream (B-28).
    after: () => {
      if (!(saved.result || saved.error || Object.keys(saved.seats).length)) return;
      const content = saved.result ? councilText(saved.result) : (saved.error ?? 'The council was stopped before it reached a verdict.');
      const seats = saved.seatMeta.map(meta => ({ ...meta, ...(saved.seats[meta.id] ?? {}) }));
      store.addMessage(scope.id, { role: 'assistant', kind: 'council', content, council: { question, seats, result: saved.result, error: saved.error, rounds: saved.rounds } });
    },
  });
}

async function handlePlan(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const scope = scopeFor(store, project, threadOf(body));
  const cfg = savedCouncil(project);
  const ref = body.planner ? parseRef(body.planner) : cfg.moderator.ref;
  // The agents block in force (the project's own, else the app's, else the defaults): the Planner type's limits and the types a task may name.
  const agents = effectiveAgents(store.get(), project);
  const limit = Math.min(PLAN_TIMEOUT_MS, typeByName(agents, 'planner').timeoutMin * 60_000);
  // A plan is a run of its thread, like a chat turn and a compact (B-34): it is marked running, so /cancel stops it, the page shows the
  // thread as busy, another run in the thread is refused, and a build waits for it. The checks come before anything starts.
  if (updating) throw httpError(409, UPDATING_TEXT);
  if (shuttingDown) throw httpError(409, CLOSING_TEXT);
  const busy = busyRefusal(project, scope, undefined);
  if (busy) throw busy;
  refuseWhileExclusive(project, scope);
  const ac = new AbortController();
  beginRun(project, scope, ac, { kind: 'plan' });
  events.publishState('run');
  // A page that closes stops the planner (before, it ran on to its time limit with nothing to show it).
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const timer = setTimeout(() => ac.abort(), limit);
  try {
    const plan = await planBuild({
      ref,
      effort: body.effort ?? cfg.moderator.effort ?? 'high',
      goal: String(body.goal ?? '').slice(0, 4000),
      recommendation: String(body.recommendation ?? '').slice(0, 8000),
      root: scope.root,
      signal: ac.signal,
      agents,
      project,
      // Build focus and the rules files reach the planner as they reach the chat (prompt-wiring).
      focus: buildFocusOf(project),
      rules: await loadProjectRules(scope.root),
      // A planner the person picked for this plan wins over the Planner type's own model.
      explicit: Boolean(body.planner),
    });
    return json(res, 200, plan);
  } finally {
    clearTimeout(timer);
    endRun(scope.id, ac);
    events.publishState('run');
  }
}

async function handleBuild(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const scope = scopeFor(store, project, threadOf(body));
  // A build runs coders that write files and run commands, so a project (or a thread) in plan mode refuses it before anything else is
  // checked. The council and the planner stay read-only and are not touched by plan mode.
  if (chatModeOf(project) === 'plan' || scope.chatMode === 'plan') throw httpError(409, PLAN_BUILD_REFUSED);
  // Only the thread that writes in the folder builds (every thread, when the project allows several writers).
  if (!scope.writer) throw httpError(409, 'Only the writer thread can build. Make this thread the writer first.');
  // A build is project-wide: it starts only when every thread of the project is idle.
  const busy = busyRefusal(project, scope, 'Builds');
  if (busy) throw busy;
  if (!Array.isArray(body.tasks) || !body.tasks.length) throw httpError(400, 'There are no tasks to run. Make a plan first.');
  // The plan is checked here, before the goal is stored, so a refused plan leaves no "Build:" message without its build card (B-35).
  // runBuild checks it again with the same limits, so a plan that passes here is the plan that runs.
  if (await folderGone(project)) throw missingFolder(project);
  try {
    await checkTasks(body.tasks, scope.root, effectiveAgents(store.get(), project));
  } catch (err) {
    throw httpError(400, err.message);
  }
  const cfg = savedCouncil(project);
  // The effort chosen in the panel goes to the reviewer; with none, the Reviewer type's effort applies. A reviewer the person picked wins over
  // the Reviewer type's own model.
  const reviewer = body.reviewer
    ? { ref: parseRef(body.reviewer), effort: body.effort ?? null, explicit: true }
    : { ref: cfg.moderator.ref, effort: cfg.moderator.effort ?? null };
  const agents = effectiveAgents(store.get(), project);
  const goal = String(body.goal ?? '').trim().slice(0, 2000);
  // The coders get the project's CLI options. The reviewer is read-only and gets none (see delegate.mjs).
  const tools = effectiveSettings(store.get(), project).tools;
  // The coders also get the project's id (for checkpoints) and its own deny patterns. The reviewer gets neither.
  const denyPatterns = denyPatternsOf(project);
  // The mode the coders run in is the project's (B-4): Gemini and Codex coders no longer need Auto-approve (amend-22), and
  // "Coders that cannot ask" can still make a project refuse them.
  const mode = approvalModeOf(store.get(), project);
  const codersCannotAsk = codersCannotAskOf(project);
  const saved = { goal, tasks: [], results: {}, review: null };
  // Build focus and the project's AGENTS.md and global rules reach the coders, the planner and the reviewer (prompt-wiring). The rules are read
  // here, before the run starts, so the build sees the files as they are when it is started.
  const focus = buildFocusOf(project);
  const rules = await loadProjectRules(scope.root);
  await streamForProject(req, res, project, async ({ signal, send }) => {
    store.addMessage(scope.id, { role: 'user', kind: 'build', content: `Build: ${goal || 'the agreed plan'}` });
    // Saved now, so a kill during the build keeps its goal (B-29). A failed save is said in a notice and the build goes on.
    await saveReporting(send, true);
    // The build's turn snapshot (lib/hooks/10-snapshot.mjs) is taken once its message is stored, before any coder runs.
    await runBefore({ project, scope, kind: 'build', ref: null, planMode: false, send, signal, store, record: store.transcript(scope.id).at(-1), changed: null, followUp: null, busy: () => running.has(scope.id) });
    return runBuild({ tasks: body.tasks, root: scope.root, mode, signal, approve: approvalRequester(send, signal), reviewer, goal, tools, projectId: project.id, denyPatterns, codersCannotAsk, agents, project, focus, rules });
  }, ev => {
    if (ev.type === 'build-start') saved.tasks = ev.tasks;
    if (ev.type === 'task-done') saved.results[ev.id] = { ok: ev.ok, summary: ev.summary, changed: ev.changed, outOfScope: ev.outOfScope, error: ev.error };
    if (ev.type === 'review') saved.review = ev.result;
  }, {
    kind: 'build',
    scope,
    // Stored before the stream says done, and saved with the run's final save, so a failed save shows in the stream (B-28).
    after: () => {
      const done = Object.values(saved.results);
      if (!done.length) return;
      const ok = done.filter(r => r.ok).length;
      const verdict = saved.review ? ` Reviewer: ${saved.review.verdict === 'approve' ? 'approved' : 'changes needed'}.` : '';
      store.addMessage(scope.id, { role: 'assistant', kind: 'build', content: `${ok} of ${done.length} tasks finished.${verdict}`, build: saved });
    },
  });
}

// ---------- relay between seats ----------

// Settings for relays. Missing or bad values are refused with a plain message. `base` is what a missing value falls back to: the
// app's saved relay settings by default, or a project's effective relay (B-4) when a run is for one project.
function normalizeRelay(input, base = store.get().relay) {
  const r = { ...RELAY_DEFAULT, ...(base ?? {}), ...(input ?? {}) };
  const countdownSec = Number(r.countdownSec);
  if (!Number.isInteger(countdownSec) || countdownSec < 0 || countdownSec > 10) throw httpError(400, 'The countdown must be a whole number from 0 to 10 seconds.');
  if (r.hops !== null && (!Number.isInteger(r.hops) || r.hops < 1 || r.hops > 50)) throw httpError(400, 'The hop limit must be empty (no limit) or a whole number from 1 to 50.');
  for (const key of ['autoRoute', 'stopOnError', 'dedupe']) {
    if (typeof r[key] !== 'boolean') throw httpError(400, `${key} must be true or false.`);
  }
  return { autoRoute: r.autoRoute, countdownSec, hops: r.hops, stopOnError: r.stopOnError, dedupe: r.dedupe };
}

// The relay log is kept per project (the Relay log panel lists the last hops of the project); a pause belongs to one thread's route.
const relayLogs = new Map();
const relayPaused = new Set();
function relayLogFor(projectId) {
  if (!relayLogs.has(projectId)) relayLogs.set(projectId, new RelayLog());
  return relayLogs.get(projectId);
}

// The text of a council seat's newest round that has text, from the last round down (B-13: a three-round council relays round 3). A round
// saved as failed (ok<n> false) is skipped even when it has text, so the partial text of a failed round is never relayed.
function newestRoundText(hit) {
  const rounds = Object.keys(hit).map(k => /^round(\d+)$/.exec(k)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => b - a);
  for (const n of rounds) {
    if (hit[`ok${n}`] === false) continue;
    const t = hit[`round${n}`];
    if (typeof t === 'string' && t.trim()) return t;
  }
  return '';
}

// The council seats of this project (its own council when it has one, else the app's: B-4), each with its newest reply in the
// thread's chat (empty when it has not answered). `project` is a project record or a project id; `scope` is the thread (the active one
// when it is left out). A seat's reply is its newest council answer or its newest relayed reply in this thread. A plain chat reply is not
// a seat's answer here (B-12): Send to names the reply the person clicked (relaySource). The scan stops at the newest entry for the seat even
// when that entry is empty, so an older answer never stands in for a seat that has not answered in the newest council (B-12).
function relaySeats(project, scope) {
  const record = typeof project === 'string' ? projectById(project) : project;
  const seats = normalizeCouncil(effectiveSettings(store.get(), record).council ?? DEFAULT_COUNCIL).seats;
  const log = store.transcript((scope ?? scopeFor(store, record, undefined)).id);
  return seats.map(seat => {
    let reply = '';
    let found = false;
    for (let i = log.length - 1; i >= 0 && !found; i--) {
      const m = log[i];
      if (m.role !== 'assistant') continue;
      if (m.kind === 'chat' && m.relay && m.relay.to === seat.id) {
        found = true;
        reply = String(m.content ?? '');
      } else if (m.kind === 'council' && m.council?.seats) {
        const hit = m.council.seats.find(x => x.id === seat.id);
        if (hit) {
          found = true;
          reply = newestRoundText(hit);
        }
      }
    }
    return { ...seat, reply };
  });
}

// The person's request a relay serves: the newest message the person typed before the source reply in this thread's log (a chat turn or a
// council question, both store the text as content). Only typed messages count: an auto-fix follow-up holds raw check output and a compact
// summary is written by a model. A reply that a relay saved keeps the request that relay served (requestTs, saveRelayHop), and that message
// is used while it is still in the log, so a relay from the reply is not told a newer question. Returns { text, ts }; the text is empty and
// the ts null when there is none.
const MAX_RELAY_REQUEST = 40_000;
const isTypedRequest = m => m.role === 'user' && (m.kind === 'chat' || m.kind === 'council') && !m.auto && !m.compact && String(m.content ?? '').trim();
function requestBefore(log, index) {
  const pinned = log[index]?.relay?.requestTs;
  const kept = pinned != null ? log.find(m => m.ts === pinned && isTypedRequest(m)) : null;
  if (kept) return { text: clipText(String(kept.content).trim(), MAX_RELAY_REQUEST), ts: kept.ts ?? null };
  for (let i = index - 1; i >= 0; i--) {
    const m = log[i];
    if (isTypedRequest(m)) return { text: clipText(String(m.content).trim(), MAX_RELAY_REQUEST), ts: m.ts ?? null };
  }
  return { text: '', ts: null };
}
const isSeatReply = (m, seatId) => m.role === 'assistant' && ((m.kind === 'chat' && m.relay?.to === seatId) || (m.kind === 'council' && Array.isArray(m.council?.seats) && m.council.seats.some(x => x.id === seatId)));

// The source of a relay. With messageTs (the chat message the person clicked, sent by the page), that reply is the source when it is a chat
// reply of this thread; otherwise the seat's own newest reply is (relaySeats). A message that is no longer in the chat is refused.
function relaySource(seats, sourceId, { messageTs = null, log = [] } = {}) {
  const seat = seats.find(x => x.id === sourceId);
  if (!seat) throw httpError(400, `There is no council seat called "${sourceId}".`);
  let text = seat.reply;
  let messageId = null;
  let hit = null;
  if (messageTs !== null && messageTs !== undefined && String(messageTs) !== '') {
    hit = log.find(m => m.ts !== undefined && String(m.ts) === String(messageTs)) ?? null;
    if (!hit) throw httpError(400, 'That reply is no longer in this chat, so there is nothing to relay.');
    if (hit.role === 'assistant' && hit.kind === 'chat' && String(hit.content ?? '').trim()) {
      text = String(hit.content);
      messageId = hit.ts;
    }
  }
  if (!text.trim()) throw httpError(400, `${seat.label} has not replied yet, so there is nothing to relay.`);
  const at = messageId !== null ? log.indexOf(hit) : log.findLastIndex(m => isSeatReply(m, seat.id));
  const req = at >= 0 ? requestBefore(log, at) : { text: '', ts: null };
  return { seat: seat.id, label: seat.label, ref: seat.ref, text, messageId, request: req.text, requestTs: req.ts };
}

// A relayed reply is kept in the chat as the target seat's own reply, with where it came from. The target's native session has not seen
// this reply, so it is forgotten: its next turn starts a new session with the chat, this reply included (B-56), as compare and pipelines do.
// requestTs is the ts of the person's request the relay served (relaySource), so a relay from this reply is told that request (requestBefore).
function saveRelayHop(scope, seats, ev, kind, requestTs = null) {
  const target = seats.find(x => x.id === ev.to?.seat);
  store.addMessage(scope.id, {
    role: 'assistant',
    kind: 'chat',
    model: target?.ref ?? null,
    content: ev.text,
    relay: { from: ev.from?.seat ?? null, fromLabel: ev.from?.label ?? null, to: ev.to?.seat ?? null, hop: ev.hop, kind, ...(requestTs != null ? { requestTs } : {}) },
  });
  if (target?.ref) forgetSession(scope.id, target.ref);
}

async function handleRelaySend(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const scope = scopeFor(store, project, threadOf(body));
  const seats = relaySeats(project, scope);
  // A draft (a reply still streaming, B-29) is not a reply to send on.
  const source = relaySource(seats, String(body.sourceId ?? ''), { messageTs: body.messageTs, log: store.transcript(scope.id).filter(m => m.draft !== true) });
  const targets = Array.isArray(body.targets) ? body.targets.map(String) : [];
  const broadcast = targets.length === 1 && targets[0] === 'all';
  if (!broadcast && targets.length !== 1) throw httpError(400, 'Choose one seat to send to, or all seats.');
  const note = String(body.note ?? '').trim().slice(0, 2000);
  // Relay hops are read-only runs: whatever the mode, Gemini gets plan and Muse Code ask (lib/providers.mjs), and relay.mjs maps
  // 'all' to 'ask' anyway. The project's mode is still what is passed.
  const mode = approvalModeOf(store.get(), project);
  const tools = effectiveSettings(store.get(), project).tools;
  const kind = broadcast ? 'broadcast' : 'send';
  return streamForProject(req, res, project, async ({ signal, send }) => {
    // One run per send or broadcast: the agents a hop starts count against the Relay hops row and the per-run ceiling (agent-roles).
    const agents = effectiveAgents(store.get(), project);
    const run = openRun({ projectId: project.id, kind: 'relay', signal });
    const common = { seats, source, note, project, scope, store, signal, mode, tools, agents, run, denyPatterns: denyPatternsOf(project), approve: approvalRequester(send, signal) };
    return withRun(run, broadcast ? runBroadcast({ ...common, targets: ['all'] }) : runSend({ ...common, target: targets[0] }));
  }, ev => {
    if (ev.type !== 'hop-done') return;
    // A send keeps its own log record; a route's hops are logged through onHop instead.
    relayLogFor(project.id).push({
      at: Date.now(), hop: ev.hop, kind, from: ev.from, to: ev.to,
      chars: source.text.length, sha256: hashText(source.text), ok: ev.ok, error: ev.error,
    });
    if (ev.ok && ev.text) saveRelayHop(scope, seats, ev, kind, source.requestTs);
  }, { kind: 'relay', scope });
}

async function handleRelayRoute(req, res) {
  const body = await readBody(req);
  const project = projectById(body.project);
  const scope = scopeFor(store, project, threadOf(body));
  const seats = relaySeats(project, scope);
  // A draft (a reply still streaming, B-29) is not a reply to send on.
  const source = relaySource(seats, String(body.sourceId ?? ''), { messageTs: body.messageTs, log: store.transcript(scope.id).filter(m => m.draft !== true) });
  const st = store.get();
  const eff = effectiveSettings(st, project);
  // A route may send its own hops, countdownSec and stopOnError; each one it leaves out takes the project's value (or the app's).
  // The values sent are checked the same way the saved ones are, so a bad one is refused with a 400 (B-86).
  const input = body.route ?? {};
  const sent = Object.fromEntries(['hops', 'countdownSec', 'stopOnError'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const settings = normalizeRelay(sent, eff.relay);
  let route;
  try {
    // The route starts from the source this request names (the reply the person clicked, or the seat's newest), so the seat's reply in
    // the route check is that source's text (B-12).
    const routeSeats = seats.map(seat => (seat.id === source.seat ? { ...seat, reply: source.text } : seat));
    route = normalizeRoute({
      kind: input.kind, from: source.seat, targets: input.targets,
      hops: settings.hops, countdownSec: settings.countdownSec, stopOnError: settings.stopOnError,
    }, routeSeats);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const note = String(body.note ?? '').trim().slice(0, 2000);
  const mode = approvalModeOf(st, project);
  const log = relayLogFor(project.id);
  // A route starts unpaused. The pause is cleared only once streamForProject accepts the route, so a route refused for a busy
  // project leaves the pause of the run that is going on as it was.
  return streamForProject(req, res, project, async ({ signal, send }) => {
    relayPaused.delete(scope.id);
    // One run per route: every hop's agents count against the Relay hops row and the per-run ceiling (agent-roles).
    const agents = effectiveAgents(store.get(), project);
    const run = openRun({ projectId: project.id, kind: 'relay', signal });
    return withRun(run, runRoute({
      route, seats, startText: source.text, startLabel: source.label, request: source.request, cwd: scope.root, signal,
      isPaused: () => relayPaused.has(scope.id),
      onHop: rec => log.push(rec),
      mode,
      tools: eff.tools,
      history: historyFor(replayable(store.transcript(scope.id)), scope.model ?? eff.model ?? st.model, { textOnly: true }),
      dedupe: settings.dedupe,
      note,
      project, agents, run, denyPatterns: denyPatternsOf(project), approve: approvalRequester(send, signal),
    }));
  }, ev => {
    if (ev.type === 'hop-done' && ev.ok && ev.text) saveRelayHop(scope, seats, ev, 'route', source.requestTs);
  }, { kind: 'relay', scope });
}

// Exit code that tells the launcher (start.bat or the desktop app) to start the server again.
const RESTART_EXIT_CODE = 75;

// Restarts the server after an applied update. The launcher brings it back up.
function restartSoon() {
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
}

// The scope ids POST /api/cancel stops. Which one: body.thread (a thread of body.project) when it is sent; else the run whose scope id
// body.project names (a project's Main, or a thread, which is how Stop all and the Agents pane name a run); else the project's active thread
// if it runs, else every thread of the project that runs. The page sends body.thread, so Stop acts on the thread on screen only.
function cancelTargets(body) {
  const named = threadOf(body);
  if (named) return [scopeFor(store, projectById(body.project), named).id];
  if (typeof body.project === 'string' && running.has(body.project)) return [body.project];
  const project = typeof body.project === 'string' ? store.get().projects.find(p => p.id === body.project) : null;
  if (!project) return [];
  const active = activeScopeOf(store.get(), project);
  return active && running.has(active.id) ? [active.id] : runningScopes(running, project.id);
}

async function handleApi(req, res, url) {
  const st = store.get();
  // Route modules in lib/routes/ answer their own endpoints first.
  const ext = findExtRoute(req.method, url.pathname);
  // scopeFor(project, threadId) finds the thread a request names (lib/scope.mjs; the project's active thread when threadId is left out,
  // a 404 for a thread that is not an open thread of the project), and projectBusy(projectId) says whether any thread of it runs.
  if (ext) return await ext.handler({ req, res, url, json, readBody, httpError, store, projectById, streamForProject, publicState, approvalRequester, running, relaySeats, events, scopeFor: (project, threadId) => scopeFor(store, project, threadId), projectBusy: projectId => projectBusy(running, projectId), computerRun: id => liveComputerRuns.get(id) ?? null });
  switch (`${req.method} ${url.pathname}`) {
    // One server-sent stream per window (lib/events.mjs). The first event is hello, with the state without messages.
    case 'GET /api/events': {
      // Only this page's own windows listen: a request from another page is refused. There is no cap on windows: the Agents board
      // shares this channel (lib/activity.mjs publishes on it), so no separate listener limit applies to it.
      refuseForeignOrigin(req);
      return events.subscribe(req, res, { type: 'hello', pid: process.pid, startedAt: events.STARTED_AT, version: VERSION, generation: overlay.active()?.generation ?? null, state: publicState({ messages: false }) });
    }

    // What the Agents board shows now: every run, the recent ones and the cards waiting (lib/activity.mjs). seq is the change it includes,
    // and the events of the same channel carry theirs, so a window applies only what the snapshot does not hold.
    case 'GET /api/activity':
      refuseForeignOrigin(req);
      return json(res, 200, activity.snapshot());

    case 'GET /api/status':
      return json(res, 200, { providers: await providerStatus(), catalog: CATALOG, aliases: ALIASES });

    case 'GET /api/state':
      return json(res, 200, publicState());

    case 'GET /api/tree': {
      const project = projectById(url.searchParams.get('project'));
      const scope = scopeFor(store, project, threadOf(url.searchParams));
      if (await folderGone(project)) throw missingFolder(project);
      return json(res, 200, { files: await listTree(scope.root) });
    }

    case 'POST /api/projects': {
      const body = await readBody(req);
      const abs = await resolveFolder(body.path);
      const id = projectId(abs);
      if (!st.projects.some(p => p.id === id)) {
        // The name is capped (B-72) after the fallback, so both the typed name and the folder's name are bounded.
        const name = (String(body.name ?? '').trim() || path.basename(abs)).slice(0, PROJECT_NAME_MAX).replace(/[\ud800-\udbff]$/, '');
        const project = { id, name, path: abs };
        // A folder that was forgotten and is added again (the id comes from the path) gets back what it had saved: its limits,
        // its running spend, plan mode, deny patterns and the rest of its settings (B-30; see keepForgotten).
        const kept = st.forgotten?.[id];
        if (kept) {
          if (kept.settings) project.settings = kept.settings;
          if (kept.spend) project.spend = kept.spend;
          delete st.forgotten[id];
        }
        st.projects.push(project);
        // A project added after the threads migration gets its Main entry now (lib/threads.mjs ensureThreads).
        ensureThreads(st, project);
      }
      st.activeProject = id;
      await store.saveOrFail();
      return json(res, 200, publicState());
    }

    case 'POST /api/projects/remove': {
      const body = await readBody(req);
      // Any thread of the project that runs keeps it from being forgotten.
      if (projectBusy(running, body.project)) throw httpError(409, 'That project is busy. Use /cancel first.');
      const going = st.projects.find(p => p.id === body.project);
      // A copy that is ready holds work that is on no branch of the project yet, so the person chooses Keep branch or Discard first. A copy
      // that failed or is missing has nothing to lose: what is left of it is removed, as closing its thread does, and its record goes. The
      // cleanup awaits, so the checks are made again after it, with nothing awaited between them and the removal.
      if (going) {
        refuseOpenCopies(st, going);
        for (const id of copyIdsOf(st, going)) {
          await forgetWorktree({ project: going, st, id });
          delete st.worktrees[id];
        }
        if (projectBusy(running, body.project)) throw httpError(409, 'That project is busy. Use /cancel first.');
        refuseOpenCopies(st, going);
      }
      keepForgotten(st, going);
      st.projects = st.projects.filter(p => p.id !== body.project);
      if (st.activeProject === body.project) st.activeProject = st.projects[0]?.id ?? null;
      await store.saveOrFail();
      return json(res, 200, publicState());
    }

    case 'POST /api/prompts/health/ack':
      clearPromptsHealth();
      return json(res, 200, { ok: true });

    case 'POST /api/settings': {
      const body = await readBody(req);
      // Every field is checked and kept in `next` first, and st is changed only when all of them passed (B-32). A refused save
      // leaves the live state, and so the next run, exactly as it was.
      const next = {};
      if (body.model) next.model = parseRef(body.model);
      if (body.advisor === 'off') next.advisor = null;
      else if (body.advisor) next.advisor = parseRef(body.advisor);
      if (typeof body.advisorAuto === 'boolean') next.advisorAuto = body.advisorAuto;
      // 'all' is Approve all. A value that is not one of the three is refused, not ignored.
      if (body.approvals !== undefined) {
        if (!APPROVAL_VALUES.includes(body.approvals)) throw httpError(400, 'Approvals must be ask, auto or all.');
        next.approvals = body.approvals;
      }
      // Whether Approve all also answers the computer-use and browser cards (both on unless turned off). A project may override it.
      if (body.approveAllCovers !== undefined) {
        try {
          next.approveAllCovers = normalizeAppCovers(body.approveAllCovers, st.approveAllCovers);
        } catch (err) {
          throw httpError(400, err.message);
        }
      }
      if (body.effort !== undefined) {
        if (!EFFORTS.includes(body.effort)) throw httpError(400, `Effort must be one of: ${EFFORTS.join(', ')}.`);
        next.effort = body.effort;
      }
      if (body.theme !== undefined) {
        if (!THEMES.includes(body.theme)) throw httpError(400, `Theme must be one of: ${THEMES.join(', ')}.`);
        next.theme = body.theme;
      }
      if (body.council !== undefined) {
        try {
          next.council = normalizeCouncil(body.council);
        } catch (err) {
          throw httpError(400, err.message);
        }
      }
      if (body.music !== undefined) next.music = normalizeMusic({ ...(st.music ?? MUSIC_DEFAULT), ...body.music });
      if (body.relay !== undefined) next.relay = normalizeRelay(body.relay);
      if (body.sessionMode === 'native' || body.sessionMode === 'transcript') next.sessionMode = body.sessionMode;
      // The pause limit of a model-driven run, in minutes, and the stop key's override (null for the default key). Both are
      // checked by lib/drive.mjs and read there from state.json (driveIdleMinutes, driveStopKey).
      if (body.driveIdleMinutes !== undefined) next.driveIdleMinutes = normalizeIdleMinutes(body.driveIdleMinutes);
      if (body.driveStopKey !== undefined) next.driveStopKey = normalizeStopOverride(body.driveStopKey);
      // How a computer run is paced and how long its log is kept (lib/computer/policy.mjs): the pause between actions in milliseconds
      // (100 to 2000), and the days (1 to 90) and megabytes (50 to 5000) of run log to keep. null puts the default back.
      if (body.computerPaceMs !== undefined) next.computerPaceMs = normalizePaceMs(body.computerPaceMs);
      if (body.computerLogDays !== undefined) next.computerLogDays = normalizeLogDays(body.computerLogDays);
      if (body.computerLogMB !== undefined) next.computerLogMB = normalizeLogMB(body.computerLogMB);
      if (body.activeProject) next.activeProject = projectById(body.activeProject).id;
      const switchedTo = next.activeProject && next.activeProject !== st.activeProject ? projectById(next.activeProject).name : '';
      Object.assign(st, next);
      await store.saveOrFail();
      // A phone that switched the project says so on the events channel, so a desktop window can tell the person where the switch came from
      // (MOBILE-UI 15.9; public/app.js shows "Switched to <project> from <phone>" once per phone). A desktop window's own switch is silent, and
      // so is a phone that asks for the project that is already active.
      const via = switchedTo ? viaOf(req) : '';
      if (via) events.publish({ type: 'project', action: 'switched', project: switchedTo, via });
      return json(res, 200, publicState());
    }

    // Changes only the approval settings of one project and leaves every other setting of it as it is (POST /api/project-settings
    // replaces the whole object, so the Mode menu uses this). Every key is optional, and at least one must be sent:
    //   approvals          'ask', 'auto' or 'all'; null or '' follows the app ("Use app default")
    //   approveAllBlocked  true or false: Approve all also answers blocked-command cards
    //   approveAllCovers   { computer, browser }, each true, false or null (null follows the app)
    //   codersCannotAsk    'run' or 'refuse'
    // The answer is the project's approvalSummary (lib/projects.mjs), the same fields its entry in the page state carries.
    case 'POST /api/project-approvals': {
      const body = await readBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Send an object with the project id and the approval setting to change.');
      const project = projectById(body.project);
      const next = project.settings && typeof project.settings === 'object' && !Array.isArray(project.settings) ? { ...project.settings } : {};
      let changed = false;
      try {
        if (body.approvals !== undefined) {
          next.approvals = normalizeProjectSettings({ approvals: body.approvals }).approvals;
          changed = true;
        }
        if (body.approveAllBlocked !== undefined) {
          if (normalizeProjectSettings({ approveAllBlocked: body.approveAllBlocked }).approveAllBlocked) next.approveAllBlocked = true;
          else delete next.approveAllBlocked;
          changed = true;
        }
        if (body.approveAllCovers !== undefined) {
          if (body.approveAllCovers === null || typeof body.approveAllCovers !== 'object' || Array.isArray(body.approveAllCovers)) {
            if (body.approveAllCovers !== null) normalizeProjectSettings({ approveAllCovers: body.approveAllCovers });
            delete next.approveAllCovers;
          } else {
            const merged = { ...(next.approveAllCovers && typeof next.approveAllCovers === 'object' ? next.approveAllCovers : {}) };
            for (const [key, value] of Object.entries(body.approveAllCovers)) {
              if (value === null) delete merged[key];
              else merged[key] = value;
            }
            const covers = normalizeProjectSettings({ approveAllCovers: merged }).approveAllCovers;
            if (covers) next.approveAllCovers = covers;
            else delete next.approveAllCovers;
          }
          changed = true;
        }
        if (body.codersCannotAsk !== undefined) {
          if (normalizeProjectSettings({ codersCannotAsk: body.codersCannotAsk }).codersCannotAsk === 'refuse') next.codersCannotAsk = 'refuse';
          else delete next.codersCannotAsk;
          changed = true;
        }
      } catch (err) {
        throw httpError(400, err.message);
      }
      if (!changed) throw httpError(400, 'Send approvals, approveAllBlocked, approveAllCovers or codersCannotAsk.');
      // A project that is left with nothing but "follow the app" goes back to having no settings.
      if (Object.entries(next).some(([key, value]) => !(key === 'approvals' && value === null))) project.settings = next;
      else delete project.settings;
      await store.saveOrFail();
      events.publishState('settings');
      return json(res, 200, { project: project.id, ...approvalSummary(store.get(), project) });
    }

    // Clears the chat of one thread (body.thread, else the active one); the other threads of the project keep theirs.
    case 'POST /api/clear': {
      const body = await readBody(req);
      const project = projectById(body.project);
      const scope = scopeFor(store, project, threadOf(body));
      if (running.has(scope.id)) throw httpError(409, 'Busy. Use /cancel first.');
      keepArchive(scope.id, [...store.transcript(scope.id)], 'clear');
      store.transcript(scope.id).length = 0;
      forgetProjectSessions(scope.id);
      await store.saveOrFail();
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
      const body = await readBody(req);
      relayPaused.add(scopeFor(store, projectById(body.project), threadOf(body)).id);
      return json(res, 200, { paused: true });
    }

    case 'POST /api/relay/resume': {
      const body = await readBody(req);
      relayPaused.delete(scopeFor(store, projectById(body.project), threadOf(body)).id);
      return json(res, 200, { paused: false });
    }

    case 'GET /api/relay/log': {
      const p = projectById(url.searchParams.get('project'));
      return json(res, 200, { records: relayLogFor(p.id).list() });
    }

    // Stops runs (see cancelTargets for which). The abort is the signal the tools and the CLI adapters were given.
    case 'POST /api/cancel': {
      const body = await readBody(req);
      const keys = cancelTargets(body);
      const cancelled = keys.some(key => running.has(key));
      const ac = running.get(keys[0]);
      ac?.abort();
      for (const key of keys.slice(1)) running.get(key)?.abort();
      return json(res, 200, { cancelled });
    }

    case 'POST /api/approve': {
      const body = await readBody(req);
      const entry = pendingApprovals.get(body.approvalId);
      if (!entry) throw httpError(404, 'That approval is no longer waiting. It may have timed out.');
      // The reason is cleaned here and is used only for a denial. Approve never reads it.
      const reason = cleanReason(body.reason);
      // from: 'board' marks an answer given on the Agents board, so the chat card says where it was answered (lib/activity.mjs).
      // The phone that answered (viaOf) goes on the answered event, so the card can say "Approved on <phone>".
      entry.finish(body.allow === true, reason, body.from === 'board' ? 'board' : '', viaOf(req));
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
          // refused is set when the only credential found is a Claude subscription token, which the API route does not send.
          // storage and storageNote say where a saved key is kept on this computer (lib/keys.mjs keyStorage), so the card does not claim
          // the Windows account on a Mac or in a plain Node run (B-95).
          : { route: 'api', connected: providers.anthropic.credentials, source: providers.anthropic.source, storage: keyStorage().mode, storageNote: keyStorage().message, ...(providers.anthropic.refused ? { refused: providers.anthropic.refused } : {}) },
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
      // A Claude subscription token (sk-ant-oat...) is never saved or sent to the API; it works only inside Claude Code.
      if (isSubscriptionToken(key)) throw httpError(400, SUBSCRIPTION_TOKEN_REFUSAL);
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
      if (updating) throw httpError(409, 'An update is already being applied.');
      if (running.size) throw httpError(409, 'A run is in progress. Stop it before applying an update.');
      // Set before the await, so no run can start while the update is written and the server is about to restart (B-87).
      updating = true;
      let result;
      try {
        result = await applyUpdate(store.HOME, String(body.id ?? ''));
      } catch (err) {
        updating = false;
        throw err;
      }
      res.once('finish', restartSoon);
      return json(res, 200, { ...result, restarting: true });
    }

    // Back to the generation before the active one, or to the shipped files. Plenum restarts to load it.
    case 'POST /api/updates/rollback': {
      await readBody(req);
      if (updating) throw httpError(409, 'An update is already being applied.');
      if (running.size) throw httpError(409, 'A run is in progress. Stop it before rolling back an update.');
      const result = await rollbackUpdate(store.HOME);
      res.once('finish', restartSoon);
      return json(res, 200, { ...result, restarting: true });
    }

    // Stops using every applied update and deletes them; the shipped files run after the restart.
    case 'POST /api/updates/reset': {
      await readBody(req);
      if (updating) throw httpError(409, 'An update is already being applied.');
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
    // One GET is let through without it: an artifact preview, which a sandboxed frame loads and which cannot send a header
    // (lib/routes/artifacts.mjs). Its address holds a random id (122 bits) that lives for an hour, the content is the model's own
    // reply, and its response carries its own policy (sandbox, no network, frame-ancestors 'self'), so it reaches nothing else.
    // Two POSTs are let through as well: the MCP bridge's routes (lib/routes/mcp.mjs). A CLI's child process holds the bridge's own
    // secret and never the launch token, so those routes check that secret themselves. The Host, Origin, JSON and terms checks still apply.
    const tokenFree = (req.method === 'GET' && url.pathname === '/api/artifacts/view')
      || (req.method === 'POST' && (url.pathname === '/api/mcp/tools' || url.pathname === '/api/mcp/call'));
    if (url.pathname.startsWith('/api/') && !tokenFree) {
      const bad = checkRequest(req);
      if (bad) throw bad;
    }
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw httpError(415, 'Send JSON.');

    // The terms gate (lib/legal.mjs): until the License Agreement is accepted, every POST except the legal ones, and the reads that
    // reach a provider, answer 403 with terms: true. It runs before any route, so no provider can be reached around it.
    const gate = termsGate({ method: req.method, pathname: url.pathname, route: findExtRoute(req.method, url.pathname), st: store.get() });
    if (gate) throw gate;

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
    json(res, err.status ?? 400, { error: err.message, ...(err.terms === true ? { terms: true } : {}), ...(err.policy === true ? { policy: true } : {}) });
  }
});

// Phones (lib/remote/index.mjs, MOBILE.json desktop.server_mjs_lines). The Bridge gets this server's running map and publicState, so
// stop.mjs can abort a run in this process. It starts only when "Let phones connect" is on in the saved state; with it off nothing is
// bound, and lib/routes/remote.mjs starts the Bridge on the first phone request. The module is loaded by import(), so a build without
// the phone packages (@noble, ws) still starts: its phone routes answer 503 "Phones need a newer Plenum build.".
async function startPhones() {
  let remote;
  try {
    remote = await import('./lib/remote/index.mjs');
  } catch (err) {
    console.error(`Phones are not available in this build (${err?.code ?? 'load error'}).`);
    return;
  }
  if (store.get().phones?.enabled !== true) return;
  // Not awaited: the start reads the keys and binds the phones' port, and the server answers meanwhile.
  remote.startRemote({ running, publicState, port: PORT, options: { log: line => console.error(String(line).slice(0, 200)) } })
    .catch(() => console.error('Phones could not start. Settings > Phones shows why.'));
}

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
// Threads (lib/threads.mjs): a state file from before this version is copied to state.json.pre-threads-<date> first, and only then do the
// projects get their Main entries and stateVersion 2. If the copy cannot be made, threads stay off for this run and Main works as before.
await migrateThreads(store);
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
await startPhones();
// A clean stop before the desktop app quits (B-29). Every run is stopped the way Stop stops it, so its reply is stored with what it had;
// the state is saved; then the app is told it may end the process. Only the desktop channel can ask (lib/shell.mjs), so no page, phone
// or route can stop the server this way. The app ends the process anyway if this takes longer than its own wait.
const SHUTDOWN_WAIT_MS = 3000;
onShellMessage('shutdown', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const ac of running.values()) ac.abort();
  const until = Date.now() + SHUTDOWN_WAIT_MS;
  while (running.size && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  // A save that fails is kept in saveFailure as usual; the quit goes on, and the last save that worked is still on disk.
  await saveReporting(null);
  shellPost({ type: 'shutdown-done' });
});
// The server is up, so an applied update that was waiting to prove it starts has done so (lib/overlay.mjs). Only a start that went
// through the bootstrap (plenum.mjs) proves anything: `node server.mjs` runs the shipped files and leaves pending.json alone.
if (process.env.PLENUM_OVERLAY_DIR !== undefined) overlay.markHealthy();
// The token is printed once, for a plain Node run, in a URL fragment (which a browser never sends to the server). Under the
// desktop app (its token came over the channel) nothing secret is printed, because the desktop keeps this output in its log
// file. The same holds for any launcher that gave the server a key channel: a token made here could not be used by it anyway.
if (tokenSource() === 'desktop' || keyChannel) console.log(`Plenum running at http://${HOST}:${PORT}`);
else console.log(`Open Plenum at http://${HOST}:${PORT}/#token=${token()}`);
console.log(`State file: ${path.join(store.HOME, 'state.json')}`);
