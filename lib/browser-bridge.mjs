// The server's side of the Browser pane's channel to the desktop app (brw-02), on lib/shell.mjs like lib/pick-folder.mjs.
// The desktop side is desktop/handlers/browser.cjs (the messages) and desktop/browser.cjs (the views). Messages that go to the desktop
// are named browser-<action> and are answered with browser-<action>-result and the same id (shellRequest does the matching); the
// desktop also sends browser-event on its own whenever something changes.
//
//  - ask(type, payload, { timeoutMs }) posts one request and resolves the reply { ok, ...fields }. It rejects with status 504
//    'The desktop app did not answer.' when no reply comes in time, and with status 503 under plain Node.
//  - available() is true only inside the desktop app (there is a message channel).
//  - The listener for browser-event keeps the latest tabs snapshot, the last 50 notices (blocked pop-ups and downloads, saved and
//    failed downloads, with `at`) and the questions that wait for a person: downloads to save and permissions to allow. snapshot()
//    gives them out; onChange(fn) tells a listener each time one of them changes.
//  - brw-03 (the model driving the browser) uses setDriving({ agentDriving, takeover }) to tell the desktop who is driving, onDownload(fn)
//    to hear a download that waits while the model drives (it becomes an approval card in the chat), and answerDownload(id, allow, { dir })
//    to answer it. lib/routes/browser.mjs exports the same call with the download folder settings applied (answerDownload).
//  - brw-03 also keeps here, in memory only: the Actions log (a ring of the last 200 things the model did in each project, served by
//    GET /api/browser/log), the field that waits for the person to type a secret (setPendingSecret / typeSecret: the value goes to the
//    page and is kept nowhere), and the per-run switch "Ask me anyway" (setAskAnyway).
// Nothing here logs. A tab's address and title come from pages, so they are cut to a safe length here and the page draws them with
// textContent. No cookie and no page content passes through this module: addresses, titles, file names and sizes only (a snapshot or
// a screenshot passes through lib/browser-tools.mjs, which asks the desktop with ask(); this module never keeps one).
import { onShellMessage, shellAvailable, shellRequest } from './shell.mjs';

export const MAX_EVENTS = 50;
export const MAX_TABS = 16;
const NO_ANSWER = 'The desktop app did not answer.';
const DEFAULT_TIMEOUT_MS = 15_000;
// A question that has waited this long is dropped from memory (the desktop gives up on it after five minutes).
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const NOTICE_KINDS = new Set(['download-blocked', 'popup-blocked', 'download-saved', 'download-failed']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '');
const flag = v => v === true;
const count = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const mem = {
  known: false,
  tabs: [],
  activeTab: null,
  remembered: 0,
  notices: [],
  downloads: new Map(),
  permissions: new Map(),
  agentDriving: false,
  takeover: false,
};
const changeListeners = new Set();
const downloadListeners = new Set();

// True inside the desktop app.
export function available() {
  return shellAvailable();
}

// One request to the desktop app. Resolves the reply as the desktop sent it ({ type, id, ok, ...fields }).
export async function ask(type, payload = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, channel } = {}) {
  try {
    return await shellRequest(type, payload, { timeoutMs, channel });
  } catch (err) {
    if (err?.status === 504) throw Object.assign(new Error(NO_ANSWER), { status: 504 });
    throw err;
  }
}

// ---------- what the desktop tells us ----------

function cleanTab(t) {
  if (!isObject(t) || typeof t.id !== 'string' || !ID.test(t.id)) return null;
  const tab = {
    id: t.id,
    url: text(t.url, 2048),
    title: text(t.title, 300),
    loading: flag(t.loading),
    canGoBack: flag(t.canGoBack),
    canGoForward: flag(t.canGoForward),
  };
  if (t.crashed === true) tab.crashed = true;
  if (typeof t.error === 'string' && t.error) tab.error = text(t.error, 200);
  return tab;
}

function cleanDownload(d) {
  if (!isObject(d) || typeof d.id !== 'string' || !ID.test(d.id)) return null;
  return {
    id: d.id,
    filename: text(d.filename, 200) || 'download',
    size: count(d.size),
    host: text(d.host, 253),
    defaultDir: text(d.defaultDir, 1024),
    tab: typeof d.tab === 'string' && ID.test(d.tab) ? d.tab : null,
    driving: flag(d.driving),
    risky: flag(d.risky),
    at: Number.isFinite(d.at) ? d.at : Date.now(),
  };
}

function cleanPermission(p) {
  if (!isObject(p) || typeof p.id !== 'string' || !ID.test(p.id)) return null;
  return {
    id: p.id,
    origin: text(p.origin, 300),
    kinds: Array.isArray(p.kinds) ? p.kinds.map(k => text(k, 40)).filter(Boolean).slice(0, 4) : [],
    label: text(p.label, 120),
    tab: typeof p.tab === 'string' && ID.test(p.tab) ? p.tab : null,
    embedded: flag(p.embedded),
    at: Number.isFinite(p.at) ? p.at : Date.now(),
  };
}

function setTabs(msg) {
  mem.tabs = (Array.isArray(msg.tabs) ? msg.tabs : []).slice(0, MAX_TABS).map(cleanTab).filter(Boolean);
  mem.activeTab = typeof msg.activeTab === 'string' && mem.tabs.some(t => t.id === msg.activeTab) ? msg.activeTab : null;
  if (msg.remembered !== undefined) mem.remembered = count(msg.remembered);
  mem.known = true;
}

function addNotice(kind, fields) {
  mem.notices.push({ kind, ...fields, at: Date.now() });
  if (mem.notices.length > MAX_EVENTS) mem.notices.splice(0, mem.notices.length - MAX_EVENTS);
}

function notify(change) {
  for (const fn of [...changeListeners]) {
    try {
      fn(change);
    } catch {
      // A listener that throws changes nothing for the others.
    }
  }
}

// One message from the desktop app: { type: 'browser-event', kind, ... }. Exported for the tests; the listener below calls it.
export function handleEvent(msg) {
  if (!isObject(msg) || msg.type !== 'browser-event' || typeof msg.kind !== 'string') return;
  switch (msg.kind) {
    case 'tabs':
      setTabs(msg);
      notify({ kind: 'tabs' });
      break;
    case 'popup-blocked':
      addNotice('popup-blocked', { url: text(msg.url, 300), reason: text(msg.reason, 100) });
      notify({ kind: 'notice' });
      break;
    case 'download-blocked':
      addNotice('download-blocked', { filename: text(msg.filename, 200) || 'a file' });
      notify({ kind: 'notice' });
      break;
    case 'download-saved':
      addNotice('download-saved', { filename: text(msg.filename, 200), folder: text(msg.folder, 200) });
      mem.downloads.delete(text(msg.id, 64));
      notify({ kind: 'notice' });
      break;
    case 'download-failed':
      addNotice('download-failed', { filename: text(msg.filename, 200), reason: text(msg.reason, 200) });
      mem.downloads.delete(text(msg.id, 64));
      notify({ kind: 'notice' });
      break;
    case 'download-request': {
      const d = cleanDownload(msg.download);
      if (!d) break;
      mem.downloads.set(d.id, d);
      notify({ kind: 'download', download: d });
      if (d.driving) {
        for (const fn of [...downloadListeners]) {
          try {
            fn({ ...d });
          } catch {
            // A listener that throws changes nothing for the others.
          }
        }
      }
      break;
    }
    case 'download-gone':
      mem.downloads.delete(text(msg.id, 64));
      notify({ kind: 'download' });
      break;
    case 'permission-request': {
      const p = cleanPermission(msg.permission);
      if (!p) break;
      mem.permissions.set(p.id, p);
      notify({ kind: 'permission', permission: p });
      break;
    }
    case 'permission-gone':
      mem.permissions.delete(text(msg.id, 64));
      notify({ kind: 'permission' });
      break;
    case 'key':
      // A shortcut pressed while the page had the focus (F6, Ctrl+L). The page acts on it; nothing is kept.
      notify({ kind: 'key', key: text(msg.key, 20), ctrl: flag(msg.ctrl), shift: flag(msg.shift), alt: flag(msg.alt), meta: flag(msg.meta) });
      break;
    default:
      break;
  }
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onShellMessage('browser-event', handleEvent);
}
listen();

// ---------- what the routes and brw-03 read ----------

function prune() {
  const old = Date.now() - PENDING_MAX_AGE_MS;
  for (const map of [mem.downloads, mem.permissions]) {
    for (const [id, item] of map) if (item.at < old) map.delete(id);
  }
}

// The latest state the desktop has told us: { known, tabs, activeTab, events, downloads, permissions, remembered, takeover, agentDriving }, and
// what brw-03 keeps here: secret (the field that waits for the person, or null) and askAnyway.
// takeover stays false: the person's takeover is a pause of the model's drive (lib/drive.mjs, UI-ARCH 10.6), not a flag here.
// `known` is false until the desktop has said anything, and then refresh() asks it.
export function snapshot() {
  prune();
  return {
    known: mem.known,
    tabs: mem.tabs.map(t => ({ ...t })),
    activeTab: mem.activeTab,
    events: mem.notices.map(n => ({ ...n })),
    downloads: [...mem.downloads.values()].map(d => ({ ...d })),
    permissions: [...mem.permissions.values()].map(p => ({ ...p })),
    remembered: mem.remembered,
    takeover: mem.takeover,
    agentDriving: mem.agentDriving,
    secret: pendingSecret(),
    askAnyway,
  };
}

// Asks the desktop for the whole state (browser-state) and keeps it. Rejects like ask() when the desktop does not answer.
export async function refresh(options) {
  const reply = await ask('browser-state', {}, options);
  if (reply.ok === false) return snapshot();
  setTabs(reply);
  mem.downloads = new Map((Array.isArray(reply.downloads) ? reply.downloads : []).map(cleanDownload).filter(Boolean).map(d => [d.id, d]));
  mem.permissions = new Map((Array.isArray(reply.permissions) ? reply.permissions : []).map(cleanPermission).filter(Boolean).map(p => [p.id, p]));
  return snapshot();
}

// Tells a listener about each change: { kind: 'tabs' | 'notice' | 'download' | 'permission' | 'key', ... }. Returns a function that stops it.
export function onChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('onChange needs a function.');
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

// For brw-03: a listener for a download that waits while the model drives. It gets { id, filename, size, host, tab, risky, driving: true }
// and must end in answerDownload(id, allow) (or the desktop cancels the download after five minutes). Returns a function that stops it.
export function onDownload(fn) {
  if (typeof fn !== 'function') throw new TypeError('onDownload needs a function.');
  downloadListeners.add(fn);
  return () => downloadListeners.delete(fn);
}

// Answers a download that waits (browser-download-answer). `dir` is the folder the server has already checked; leave it out for the
// system Downloads folder. Resolves the desktop's reply { ok, message? }.
export async function answerDownload(id, allow, { dir, channel } = {}) {
  // The download's id goes as `download`: the message's own `id` is the request id, which lib/shell.mjs sets last.
  const payload = { download: id, allow: allow === true };
  if (allow === true && typeof dir === 'string' && dir) payload.dir = dir;
  return ask('browser-download-answer', payload, { channel });
}

// Answers a permission question (browser-permission-answer).
export async function answerPermission(id, allow, { channel } = {}) {
  return ask('browser-permission-answer', { permission: id, allow: allow === true }, { channel });
}

// For brw-03: tells the desktop who is driving. While the model drives, the desktop opens pop-ups in the background, asks about
// downloads through the model's approval card, and keeps every permission denied. Resolves false when the desktop did not confirm.
export async function setDriving({ agentDriving, takeover } = {}, { channel } = {}) {
  if (typeof agentDriving === 'boolean') mem.agentDriving = agentDriving;
  if (typeof takeover === 'boolean') mem.takeover = takeover;
  if (channel === undefined && !available()) return false;
  try {
    const reply = await ask('browser-driving', { agentDriving: mem.agentDriving }, { channel });
    return reply.ok === true;
  } catch {
    return false;
  }
}

// ---------- brw-03: the Actions log ----------

export const LOG_MAX = 200;
const LOG_PROJECTS_MAX = 50;
const logs = new Map(); // project id -> entries, oldest first

// Adds one thing the model did: { at, tool, url, summary, ok, note? }. Text is cut here. The ring keeps the last LOG_MAX per project.
// Returns the stored entry. The summary never holds typed text or a page's words beyond a control's name.
export function addLog(projectId, entry) {
  const project = typeof projectId === 'string' ? projectId.slice(0, 64) : '';
  const item = {
    at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
    tool: text(entry?.tool, 40),
    url: text(entry?.url, 300),
    summary: text(entry?.summary, 200),
    ok: entry?.ok !== false,
  };
  const note = text(entry?.note, 120);
  if (note) item.note = note;
  let list = logs.get(project);
  if (!list) {
    if (logs.size >= LOG_PROJECTS_MAX) logs.delete(logs.keys().next().value);
    list = [];
    logs.set(project, list);
  }
  list.push(item);
  if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
  notify({ kind: 'log', project, entry: { ...item } });
  return item;
}

// The log of one project, oldest first.
export function getLog(projectId) {
  return (logs.get(typeof projectId === 'string' ? projectId.slice(0, 64) : '') ?? []).map(e => ({ ...e }));
}

// The newest entry of a project's log, or null.
export function lastAction(projectId) {
  const list = logs.get(typeof projectId === 'string' ? projectId.slice(0, 64) : '') ?? [];
  return list.length ? { ...list[list.length - 1] } : null;
}

// ---------- brw-03: a secret field that waits for the person ----------

// The model asked for a password, code or card field and was refused. The pane then offers "Type it for me" for that field. Only where the
// field is (project, tab, ref, the control's kind and name, the site) is kept; never a value.
let pending = null;
const SECRET_WAIT_MS = 30 * 60 * 1000;

export function setPendingSecret(info) {
  if (!isObject(info)) return;
  pending = {
    project: typeof info.project === 'string' ? info.project.slice(0, 64) : '',
    tab: typeof info.tab === 'string' && ID.test(info.tab) ? info.tab : undefined,
    ref: typeof info.ref === 'string' && /^e\d{1,4}$/.test(info.ref) ? info.ref : undefined,
    role: text(info.role, 24),
    name: text(info.name, 80),
    host: text(info.host, 253),
    at: Date.now(),
  };
  notify({ kind: 'secret' });
}

// { project, host, name, at } of the waiting field (no tab or ref), or null.
export function pendingSecret() {
  if (pending && Date.now() - pending.at > SECRET_WAIT_MS) pending = null;
  return pending ? { project: pending.project, host: pending.host, name: pending.name, at: pending.at } : null;
}

export function clearPendingSecret() {
  if (!pending) return;
  pending = null;
  notify({ kind: 'secret' });
}

// Types the person's secret into the waiting field (browser-act type-secret). The value travels to the page and nowhere else: it is not
// logged, not stored, not part of any error, and the desktop reads nothing back. Throws an Error with a status and a plain sentence.
export async function typeSecret(value, { project, channel } = {}) {
  if (typeof value !== 'string' || value.length === 0) throw Object.assign(new Error('Type the value first.'), { status: 400 });
  if (value.length > 1000) throw Object.assign(new Error('That is too long for a field.'), { status: 400 });
  if (!pendingSecret() || (typeof project === 'string' && project && pending.project !== project)) {
    throw Object.assign(new Error('No field is waiting for you. Press Resume and ask the model again.'), { status: 409 });
  }
  const target = pending;
  const payload = { action: 'type-secret', text: value };
  if (target.tab) payload.tab = target.tab;
  if (target.ref) {
    payload.ref = target.ref;
    payload.expect = { role: target.role, name: target.name };
  }
  let reply;
  try {
    reply = await ask('browser-act', payload, { channel });
  } catch (err) {
    throw Object.assign(new Error(err?.status === 504 ? NO_ANSWER : 'The browser could not type that.'), { status: err?.status === 503 ? 503 : 502 });
  }
  if (reply?.ok === false) throw Object.assign(new Error(text(reply.message, 200) || 'The browser could not type that.'), { status: 400 });
  clearPendingSecret();
  return { ok: true };
}

// ---------- brw-03: "Ask me anyway this run" ----------

// While Approve all is on and covers the browser, its cards are answered for the person. This switch, for the run in progress, asks
// anyway. The model's tools reset it when a new run starts driving.
let askAnyway = false;
export const getAskAnyway = () => askAnyway;
export function setAskAnyway(on) {
  askAnyway = on === true;
  notify({ kind: 'ask-anyway' });
  return askAnyway;
}

// For the tests: forget everything.
export function resetForTests() {
  mem.known = false;
  mem.tabs = [];
  mem.activeTab = null;
  mem.remembered = 0;
  mem.notices = [];
  mem.downloads = new Map();
  mem.permissions = new Map();
  mem.agentDriving = false;
  mem.takeover = false;
  changeListeners.clear();
  downloadListeners.clear();
  logs.clear();
  pending = null;
  askAnyway = false;
}
