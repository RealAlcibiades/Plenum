const $ = id => document.getElementById(id);

// The desktop app draws its own title bar, so the stylesheet keeps the window buttons clear.
if (/\bElectron\//.test(navigator.userAgent)) {
  document.documentElement.dataset.shell = 'desktop';
  // macOS draws its window buttons at the top left, so the title bar keeps clear of them there (B-68).
  document.documentElement.dataset.platform = /Macintosh/.test(navigator.userAgent) ? 'darwin' : 'other';
}

const el = {
  projects: $('projects'),
  addForm: $('addForm'),
  addPath: $('addPath'),
  addProjectBtn: $('addProjectBtn'),
  addCancel: $('addCancel'),
  projName: $('projName'),
  projPath: $('projPath'),
  model: $('modelSel'),
  advisor: $('advisorSel'),
  auto: $('autoAdv'),
  effort: $('effortSel'),
  // The Mode menu's button (ext-approvals.js builds the menu). It replaces the Ask first and Auto-approve buttons.
  modeBtn: $('modeBtn'),
  modeBtns: [...document.querySelectorAll('.seg-btn[data-mode]')],
  board: $('board'),
  boardSeats: $('boardSeats'),
  boardSummary: $('boardSummary'),
  roundsSel: $('roundsSel'),
  relayOpenBtn: $('relayOpenBtn'),
  relayLogBtn: $('relayLogBtn'),
  relayBar: $('relayBar'),
  rbText: $('rbText'),
  rbToggle: $('rbToggle'),
  rbStop: $('rbStop'),
  music: $('music'),
  musicOn: $('musicOn'),
  musicStyle: $('musicStyle'),
  musicVol: $('musicVol'),
  musicVolOut: $('musicVolOut'),
  musicHint: $('musicHint'),
  chat: $('chat'),
  form: $('composer'),
  input: $('input'),
  send: $('send'),
  hint: $('hint'),
  palette: $('palette'),
  statusbar: $('statusbar'),
  accountsBtn: $('accountsBtn'),
  updatesBtn: $('updatesBtn'),
  updatesBadge: $('updatesBadge'),
  helpBtn: $('helpBtn'),
  settingsBtn: $('settingsBtn'),
  themeBtn: $('themeBtn'),
  themeValue: $('themeValue'),
  settingsPage: $('settingsPage'),
  settingsPick: $('settingsPick'),
  settingsBack: $('settingsBack'),
  settingsSearch: $('settingsSearch'),
  settingsClose: $('settingsClose'),
  settingsNav: $('settingsNav'),
  settingsContent: $('settingsContent'),
  settingsStash: $('settingsStash'),
  composerWrap: $('composerWrap'),
  drawer: $('drawer'),
  drawerTitle: $('drawerTitle'),
  drawerBody: $('drawerBody'),
  drawerClose: $('drawerClose'),
  scrim: $('scrim'),
  toasts: $('toasts'),
  pane: $('pane'),
  paneGrip: $('paneGrip'),
  paneBack: $('paneBack'),
  paneTabs: $('paneTabs'),
  paneButtons: $('paneButtons'),
  paneExpand: $('paneExpand'),
  paneSlot: $('paneSlot'),
  titlebarSlot: $('titlebarSlot'),
  bannerSlot: $('bannerSlot'),
  paneClose: $('paneClose'),
  paneBody: $('paneBody'),
};

const DEFAULT_HINT = el.hint.textContent;
// Shown while a run is going: Enter then queues what is typed (see queueFollowUp).
const BUSY_HINT = 'Working… Esc stops · Enter queues what you type';
const MAX_QUEUED = 5;
const GROUPS = [['muse', 'Muse Code'], ['anthropic', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['xai', 'Grok'], ['openai', 'OpenAI'], ['deepseek', 'DeepSeek'], ['mistral', 'Mistral'], ['googleai', 'Google AI'], ['openrouter', 'OpenRouter'], ['echo', 'Test']];
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const EFFORT_NOTES = { low: 'Fastest replies', medium: 'A little more thought', high: 'Recommended', xhigh: 'Deeper reasoning', max: 'Slowest and most thorough' };
// Newer browsers let a menu be styled; there each choice gets a provider dot and a note.
const RICH_MENUS = CSS.supports('appearance', 'base-select');
const SVG_NS = 'http://www.w3.org/2000/svg';
// The brand loop, drawn while a reply is on its way.
const LOOP_PATH = 'M32 32C27.5 22 23 15.5 18.5 15.5C13 15.5 10 23 10 32C10 41 13 48.5 18.5 48.5C23 48.5 27.5 42 32 32C36.5 22 41 15.5 45.5 15.5C51 15.5 54 23 54 32C54 41 51 48.5 45.5 48.5C41 48.5 36.5 42 32 32Z';
const THINKING = `<span class="thinking"><svg class="loop" viewBox="6 12 52 40" aria-hidden="true"><path class="loop-track" d="${LOOP_PATH}"/><path class="loop-run" pathLength="100" d="${LOOP_PATH}"/></svg><span class="thinking-text">Thinking</span></span>`;

// Council seats, the build coders and the relay settings (see CONTRACTS.md and RELAY-CONTRACT.md).
const SEAT_IDS = ['a', 'b', 'c', 'd'];
const ROLE_LABELS = { architect: 'Architect', engineer: 'Engineer', skeptic: 'Skeptic', generalist: 'Generalist' };
// Used only until the server's state arrives; the server always sends the saved council.
const DEFAULT_COUNCIL = {
  seats: [
    { ref: 'anthropic:claude-opus-5-5', effort: 'high', role: 'architect' },
    { ref: 'muse:muse-wonder-full-1.0', effort: 'high', role: 'skeptic' },
    { ref: 'codex:default', effort: 'high', role: 'engineer' },
  ],
  moderator: { ref: 'anthropic:claude-fable-5-1', effort: 'high' },
  rounds: 2,
};
const CODERS = [
  { ref: 'anthropic:claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'default' },
  { ref: 'anthropic:claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { ref: 'gemini:gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { ref: 'codex:default', label: 'Codex' },
  { ref: 'muse:muse-spark-1.2', label: 'Muse Spark 1.2' },
];
const DEFAULT_CODER = CODERS[0].ref;
const RELAY_DEFAULTS = { autoRoute: false, countdownSec: 3, hops: null, stopOnError: true, dedupe: false };
const HOP_CHOICES = [['none', 'No limit'], ['2', '2'], ['4', '4'], ['8', '8'], ['custom', 'Custom']];
const STOP_TEXT = { finished: 'every hop ran', limit: 'the hop limit was reached', user: 'stopped by you', error: 'a hop failed', 'paused-forever': 'left paused' };
const STATE_WORDS = { waiting: 'Waiting', skipped: 'Skipped', stopped: 'Stopped' };
const GEMINI_EDIT = 'Gemini edits files only when Auto-approve or Approve all is on. Headless Gemini cannot ask first.';
// The approval modes of a project: Ask first (the default), Auto-approve, and Approve all (every card answered for you; the
// credential and system folders, Plenum's own source and the built-in rules stay as the server enforces them). See DECISIONS 22.
const APPROVAL_MODES = ['ask', 'auto', 'all'];
const APPROVAL_WORDS = { ask: 'ask first', auto: 'auto-approve', all: 'approve all' };
const APPROVAL_NAMES = { ask: 'Ask first', auto: 'Auto-approve', all: 'Approve all' };
const APPROVE_ALL_TITLE = 'Approve all answers every card for you';
const APPROVE_ALL_ACTION = 'Turn on Approve all';
const APPROVE_ALL_CONFIRM = 'Edits and commands run at once, inside and outside the project. Gemini runs in its yolo mode and Muse Code with its own prompts off, so Plenum cannot check what they run. Credential folders, system folders and Plenum\'s own source stay off limits. The built-in rules that can wipe a disk or the system still show their card, and nothing answers that card for you unless you turn on "Approve all also answers blocked-command cards" in Project settings. You are responsible for everything that runs while it is on.';
const GEMINI_EFFORT = 'The Gemini CLI sets its own thinking depth';
const GEMINI_INSTALL = 'Install the Gemini CLI with npm install --prefix "%USERPROFILE%\\.muse-console\\tools" @google/gemini-cli on Windows, or npm install --prefix "$HOME/.muse-console/tools" @google/gemini-cli on macOS and Linux, then come back here.';

// aliases are other words that run the same command (/stop runs /cancel). They are found by the palette and the drawer too.
const COMMANDS = [
  { name: 'help', aliases: ['commands'], args: '', desc: 'Show all commands' },
  { name: 'model', args: '[name]', desc: 'Switch the model that answers' },
  { name: 'models', args: '', desc: 'List models and short names' },
  { name: 'advisor', args: '[sonnet|opus|fable|off|auto]', desc: 'Pick the reviewer model. Try /advisor sonnet' },
  { name: 'review', args: '', desc: 'Review the last answer against the working changes' },
  { name: 'approvals', args: '[ask|auto|all]', desc: 'Ask before edits and commands, auto-approve them, or approve all for this project' },
  { name: 'effort', args: '[low|medium|high|xhigh|max]', desc: 'How hard the main model thinks (higher is slower and more thorough)' },
  { name: 'plan', args: '<task>', desc: 'Ask for a plan. Edits still follow the approval setting.' },
  { name: 'ask', args: '<model> <message>', desc: 'Ask one model without switching' },
  { name: 'council', args: '<question> | off', desc: 'Ask every seat, then a moderator sums up. /council off returns to Chat' },
  { name: 'build', args: '', desc: 'Turn the last council recommendation into tasks, then run them' },
  { name: 'relay', args: '', desc: 'Pass a finished reply from one seat to another, once or as a route' },
  { name: 'add', args: '<folder>', desc: 'Add a project folder' },
  { name: 'project', aliases: ['switch'], args: '[name]', desc: 'Switch project' },
  { name: 'remove', aliases: ['forget'], args: '<name>', desc: 'Forget a project (files are kept)' },
  { name: 'usage', aliases: ['limits'], args: '', desc: 'Show your limits for Muse Code, Codex and Claude' },
  { name: 'compact', args: '', desc: 'Replace this chat with a summary, to free up room' },
  { name: 'clear', aliases: ['reset'], args: '', desc: 'Clear this project’s chat' },
  { name: 'cancel', aliases: ['stop'], args: '', desc: 'Stop the running request' },
  { name: 'theme', args: '[system|dark|light]', desc: 'Follow Windows, or always use the dark or light look' },
  { name: 'settings', args: '', desc: 'Open Settings: appearance, accounts, safety, updates and the rest' },
  { name: 'legal', args: '', desc: 'License agreement, privacy, open-source licences and safety notices' },
  { name: 'music', args: '[on|off|style]', desc: 'Background music: turn it on or off, or pick a style' },
  { name: 'accounts', aliases: ['login', 'keys'], args: '', desc: 'Sign in and manage keys' },
  { name: 'gemini', args: '', desc: 'Open Accounts at the Gemini card' },
  { name: 'updates', args: '', desc: 'Review updates to Plenum' },
  { name: 'status', args: '', desc: 'Check what is connected' },
];

// Title, description, the text put in the composer, and an icon from the sprite in index.html.
const SUGGESTIONS = [
  ['Explain this project', 'How it is organised and where it starts.', 'Explain how this project is organised and where the main entry points are.', 'layers'],
  ['Find risky code', 'Bugs, missing error handling, security gaps.', 'Look for bugs, missing error handling and security problems. List them by priority.', 'shield'],
  ['Plan a change first', 'Files involved and risks, before any edits.', '/plan ', 'list'],
  ['Run the tests', 'Run them and fix whatever fails.', 'Run the project tests. If something fails, fix it and run them again.', 'play'],
];

// The first row is Claude's tools through the Anthropic API; the second is the Claude CLI's own tools.
const TOOL_NAMES = {
  list_dir: 'List folder', read_file: 'Read file', search_text: 'Search', write_file: 'Write file',
  edit_file: 'Edit file', run_command: 'Run command', propose_update: 'Propose update',
  Read: 'Read file', Glob: 'Find files', Grep: 'Search', Write: 'Write file', Edit: 'Edit file', NotebookEdit: 'Edit notebook',
  Bash: 'Run command', PowerShell: 'Run command', WebFetch: 'Fetch page', WebSearch: 'Search the web',
  // The steps of a computer run (lib/computer/run.mjs names them computer.<action>), and the two tools it adds.
  'computer.click': 'Click', 'computer.right_click': 'Right-click', 'computer.middle_click': 'Middle-click', 'computer.double_click': 'Double-click',
  'computer.triple_click': 'Triple-click', 'computer.drag': 'Drag', 'computer.move': 'Move pointer', 'computer.scroll': 'Scroll',
  'computer.mouse_down': 'Mouse down', 'computer.mouse_up': 'Mouse up', 'computer.type': 'Type', 'computer.key': 'Key', 'computer.hold': 'Hold key',
  'computer.screenshot': 'Screenshot', 'computer.zoom': 'Zoom', 'computer.cursor': 'Pointer position', 'computer.wait': 'Wait',
  confirm_with_user: 'Confirm', hand_over: 'Your turn',
};
const TOOL_ICONS = {
  list_dir: 'folder', read_file: 'file', search_text: 'search', write_file: 'file-plus',
  edit_file: 'pencil', run_command: 'terminal', propose_update: 'update',
  Read: 'file', Glob: 'folder', Grep: 'search', Write: 'file-plus', Edit: 'pencil', NotebookEdit: 'pencil',
  Bash: 'terminal', PowerShell: 'terminal', WebFetch: 'layers', WebSearch: 'search',
  'computer.click': 'play', 'computer.right_click': 'play', 'computer.middle_click': 'play', 'computer.double_click': 'play', 'computer.triple_click': 'play',
  'computer.drag': 'play', 'computer.move': 'play', 'computer.scroll': 'play', 'computer.mouse_down': 'play', 'computer.mouse_up': 'play',
  'computer.type': 'pencil', 'computer.key': 'pencil', 'computer.hold': 'pencil', 'computer.screenshot': 'expand', 'computer.zoom': 'expand',
  'computer.cursor': 'gauge', 'computer.wait': 'gauge', confirm_with_user: 'shield', hand_over: 'user',
};

const THEMES = { system: 'System', dark: 'Dark', light: 'Light' };
// Page background per theme (--bg in style.css). The desktop app tints its window buttons from it.
const THEME_COLORS = { dark: '#0a0a11', light: '#f6f6fb' };
const systemIsLight = matchMedia('(prefers-color-scheme: light)');

let S = { projects: [], activeProject: null, messages: [], model: 'muse:muse-spark-1.2', advisor: null, advisorAuto: false, approvals: 'ask', running: false };
let catalog = [];
let aliases = {};
let providers = null;
let notes = [];
// The text of the last chat send and the project it went to, kept until the run is known to have gone through (B-5). Retry in
// ext-connection.js puts this text back in the composer after a refused or failed send; it is never sent again by itself.
let lastSent = null;
// The run this page has in flight for each project, keyed by project id (B-8). Stop, Esc and a finished run touch only their own
// project's controller, so an idle project never stops another project's reply.
const runs = new Map();
const activeRun = () => runs.get(S.activeProject) ?? null;
let updates = [];
// The overlay of applied updates, as GET /api/updates reports it ({ active, generations, rollback }), and the automatic rollback this
// window still shows in the Updates panel after it told the server it had seen it.
let overlayInfo = null;
let rollbackNotice = null;
let rollbackSeen = '';
let streamEl = null;
let paletteItems = [];
let paletteIndex = 0;
let drawerRender = null;
// Counts every opening, closing and refresh of the drawer. A renderer whose answer comes late compares it with the count it
// started under, and writes nothing when the drawer has moved on (B-62). Comparing the renderer alone is not enough: the same
// drawer can be opened again while an older answer is still on its way.
let drawerGen = 0;
let mode = 'chat';        // what Send does: 'chat' asks the main model, 'council' asks every seat
let routeRun = null;      // the auto relay that is running: { limit, hop, paused }
let routeDraft = null;    // the route panel's choices, kept while it is open
let accountsFocus = '';   // a card the Accounts drawer scrolls to when it opens
let boardPills = [];      // the seat pills on the board, updated in place
let followUps = [];       // messages typed during a run, oldest first: [{ project, text }], at most MAX_QUEUED (see queueFollowUp)
let queueLine = null;     // the line above the composer that counts queued follow-ups; built when first needed
let queueDrawn = [];      // the follow-ups the rows in the queue line show, so a redraw that changes nothing keeps focus on a button
let liveRunId = '';       // the id of the run this window started (from the first event of its own stream)
let foreign = null;       // a chat, review or relay run started in another window that this window is drawing: { runId, ready, queue, onEvent }
const foreignDone = new Set(); // ids of foreign runs that have ended here, so a late event does not draw them again
const noted = new Set();  // ids of other runs this window has already said one line about
const claimed = new Set(); // ids of runs a panel of this window started with its own request (MuseUI.claimRun)

// ---------- the launch token and requests ----------

// Every /api/ call carries this launch's token in the x-plenum-token header (lib/auth.mjs). Under the desktop app the preload
// bridge (desktop/preload.cjs) hands it over. Started with plain Node, it comes from the link Plenum prints (#token=...), and
// this tab keeps it in session storage so a reload keeps working. It is held in memory, and this page never puts it in a URL.
const TOKEN_RE = /^[a-f0-9]{64}$/;
const TOKEN_KEY = 'plenum-token';
let TOKEN = '';
let readyDone = () => {};
// Resolves once the token has been looked for (see loadToken), so a panel that fetches as it loads can wait for it.
const ready = new Promise(resolve => { readyDone = resolve; });

// The token from the link's fragment. The fragment leaves the address bar at once.
function tokenFromHash() {
  const m = /[#&]token=([a-f0-9]{64})\b/.exec(location.hash);
  if (!m) return '';
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    // The address bar keeps the fragment; nothing else is affected.
  }
  return m[1];
}

// Session storage is used only on the plain-node path. The desktop app never reads web storage: the first read held up startup
// for seconds there. Both calls return quietly when storage is blocked.
function rememberToken(t) {
  if (window.plenumShell) return false;
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
    return true;
  } catch {
    return false;
  }
}

function recallToken() {
  if (window.plenumShell) return '';
  try {
    const t = sessionStorage.getItem(TOKEN_KEY) ?? '';
    return TOKEN_RE.test(t) ? t : '';
  } catch {
    return '';
  }
}

async function loadToken() {
  if (window.plenumShell) {
    try {
      const t = await window.plenumShell.token();
      if (typeof t === 'string' && TOKEN_RE.test(t)) TOKEN = t;
    } catch {
      // No token: the calls below answer 401 and the message says so.
    }
    return;
  }
  const fromHash = tokenFromHash();
  if (fromHash) {
    TOKEN = fromHash;
    rememberToken(fromHash);
    return;
  }
  TOKEN = recallToken();
}

const headers = (extra = {}) => ({ 'x-plenum-token': TOKEN, ...extra });

// True for the server's refusal of a request that carries no valid token. A 401 that a model provider sent back (an invalid API
// key) has no x-plenum-auth header, so it is an ordinary error and never asks for a token.
const tokenRefused = res => res.status === 401 && res.headers?.get?.('x-plenum-auth') === 'token';

// The one way this page (and every panel, as MuseUI.request) calls the server: the token, JSON when there is a body, never cached.
// Resolves to the Response.
async function request(path, { method = 'GET', body, signal, headers: extra = {} } = {}) {
  return fetch(path, {
    method,
    cache: 'no-store',
    signal,
    headers: headers({ ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The card for a tab with no token (plain Node only; the desktop never shows it). Without a token the page can do nothing, so
// it has no close button. A good token is remembered and the page loads again with it.
function showTokenCard() {
  if (window.plenumShell || document.querySelector('.token-card')) return;
  const card = document.createElement('section');
  card.className = 'token-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tokenTitle');
  const mark = document.createElementNS(SVG_NS, 'svg');
  mark.setAttribute('class', 'mark');
  mark.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#mark');
  mark.append(use);
  const title = document.createElement('h2');
  title.id = 'tokenTitle';
  title.textContent = 'Open Plenum with its link';
  const head = document.createElement('div');
  head.className = 'token-head';
  head.append(mark, title);
  const text = document.createElement('p');
  text.className = 'token-text';
  text.textContent = 'Plenum was started with node, so this tab needs the link printed where it started. It looks like http://127.0.0.1:4317/#token=... Paste the token here, or open that link.';
  const form = document.createElement('form');
  form.className = 'token-row';
  const input = document.createElement('input');
  input.className = 'token-input';
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '64 letters and digits';
  input.setAttribute('aria-label', 'Token');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary';
  submit.textContent = 'Use token';
  form.append(input, submit);
  const problem = document.createElement('p');
  problem.className = 'token-error';
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  card.append(head, text, form, problem);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const value = input.value.trim();
    if (!TOKEN_RE.test(value)) {
      problem.textContent = 'A token is 64 letters and digits.';
      problem.hidden = false;
      input.focus();
      return;
    }
    TOKEN = value;
    const kept = rememberToken(value);
    card.remove();
    $('app')?.removeAttribute('inert');
    // Panels that loaded before there was a token have nothing to show, so the page starts over with it. When this tab cannot
    // keep the token, it loads what it can in place.
    if (kept) location.reload();
    else loadAll();
  });
  document.body.append(card);
  // Nothing behind the card can be reached by keyboard or screen reader while it is open.
  $('app')?.setAttribute('inert', '');
  input.focus();
}

async function api(path, body) {
  const res = await request(path, body === undefined ? {} : { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (tokenRefused(res)) showTokenCard();
  if (data.terms === true) window.dispatchEvent(new CustomEvent('plenum:terms-required'));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// A download link into /api/ cannot carry the token, so a click on one is turned into a request that does, and the file is saved
// from memory. The panels' Export buttons make such links (history, prompts, pipelines); the server names the file.
async function downloadApi(href) {
  const res = await request(href);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = '';
  try {
    name = star ? decodeURIComponent(star) : (/filename="([^"]+)"/i.exec(disposition)?.[1] ?? '');
  } catch {
    name = '';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, '_') || 'download';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

document.addEventListener('click', e => {
  const link = e.target instanceof Element ? e.target.closest('a[download][href^="/api/"]') : null;
  if (!link) return;
  e.preventDefault();
  downloadApi(link.getAttribute('href')).catch(err => toast(err.message, 'bad'));
}, true);

const span = (cls, text) => {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text ?? '';
  return s;
};

const button = (cls, text) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  return b;
};

const para = text => {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
};

// A small note that sits quietly under a card's content.
const quietNote = (text, cls = 'note-quiet') => Object.assign(document.createElement('p'), { className: cls, textContent: text });

const preEl = (cls, text) => Object.assign(document.createElement('pre'), { className: cls, textContent: text });

const capEl = text => Object.assign(document.createElement('h5'), { className: 'cons-cap', textContent: text });

// An icon from the sprite in index.html, for example icon('folder').
function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `ic ${cls}` : 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// The app mark with its glow, for the welcome screens.
function hero() {
  const wrap = span('hero');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#mark');
  svg.append(use);
  wrap.append(svg);
  return wrap;
}

// A headline whose last words carry the brand gradient.
function headline(plain, bright) {
  const h = document.createElement('h1');
  h.append(plain, Object.assign(document.createElement('em'), { textContent: bright }));
  return h;
}

// "C:\Users\me\Desktop\app" -> "…\me\Desktop": where a project lives, without repeating its name.
function parentHint(fullPath) {
  const parts = fullPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return fullPath;
  return `…\\${parts.slice(-3, -1).join('\\')}`;
}

function providerOf(ref) {
  return ref ? ref.slice(0, ref.indexOf(':')) : '';
}

// Short display name, for example "anthropic:claude-sonnet-5-5" -> "Sonnet 5.5".
function modelName(ref) {
  if (!ref) return '';
  const hit = catalog.find(c => `${c.provider}:${c.id}` === ref);
  const label = hit ? hit.label : ref;
  return label.replace(/\s*\(.*\)$/, '').replace(/^Claude\s+/, '');
}

const fmtTime = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const clockText = secs => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

// Music cues are a courtesy: a window without sound simply stays quiet.
function cue(name) {
  try {
    window.MuseMusic?.cue(name);
  } catch {
    // no sound in this window
  }
}

function busyNow() {
  return Boolean(activeRun()) || S.running;
}

// A details element whose open state survives redraws: the choice is kept in `store` under `key`.
function trackOpen(store, key, d, fallback) {
  d.open = store[key] ?? fallback;
  d.addEventListener('toggle', () => { store[key] = d.open; });
  return d;
}

// ms is how long the toast stays; the default is 3.2 s, or 5.2 s for a problem.
function toast(message, kind = 'ok', ms) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  el.toasts.append(t);
  setTimeout(() => t.remove(), ms ?? (kind === 'bad' ? 5200 : 3200));
}

function stickBottom() {
  const c = el.chat;
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 180) c.scrollTop = c.scrollHeight;
}

function stream() {
  return streamEl;
}

// The box a project's live run draws into (B-9). It sits in the transcript only while its project is on screen. renderChat puts it
// back after every redraw, so a settings change, or a switch away and back, never wipes a reply, approval card or tool line that is
// still arriving (B-10). The box is dropped when its run ends, and then the saved transcript shows the reply.
const runBoxes = new Map();
function runBox(project = S.activeProject) {
  let box = runBoxes.get(project);
  if (!box) {
    box = document.createElement('div');
    box.className = 'run-box';
    runBoxes.set(project, box);
  }
  if (project === S.activeProject && streamEl && !box.isConnected) streamEl.append(box);
  return box;
}

function dropRunBox(project) {
  const box = runBoxes.get(project);
  runBoxes.delete(project);
  box?.remove();
}

// Swaps a card for its rebuilt copy. A control that had the focus keeps it: the control at the same place in the new card takes it,
// and what was typed in a field is carried over. A rebuild therefore never drops the focus to the page (B-11).
function replaceKeepingFocus(oldNode, newNode) {
  const FOCUSABLE = 'button, input, textarea, select, [tabindex]';
  const at = document.activeElement;
  const focused = oldNode.isConnected && at instanceof Element && oldNode.contains(at) ? at : null;
  const index = focused ? [...oldNode.querySelectorAll(FOCUSABLE)].indexOf(focused) : -1;
  const oldFields = [...oldNode.querySelectorAll('input, textarea')];
  const newFields = [...newNode.querySelectorAll('input, textarea')];
  oldFields.forEach((field, i) => {
    if (newFields[i] && newFields[i].type === field.type && field.value) newFields[i].value = field.value;
  });
  oldNode.replaceWith(newNode);
  if (index >= 0) [...newNode.querySelectorAll(FOCUSABLE)][index]?.focus({ preventScroll: true });
}

// A menu chip (a select inside a .pick label): a click on the chip's icon or label opens the menu.
function pickable(pick) {
  const select = pick.querySelector('select');
  pick.addEventListener('click', e => {
    if (e.target.closest('select')) return;
    e.preventDefault();
    select.focus();
    try {
      select.showPicker();
    } catch {
      // Older browsers: the menu still opens from the keyboard or its own arrow.
    }
  });
}

// ---------- transcript pieces ----------

function makeTurn(kind, { label = '', provider = '', when = null } = {}) {
  const article = document.createElement('article');
  article.className = `turn ${kind}`;
  if (provider) article.dataset.p = provider;
  const head = document.createElement('div');
  head.className = 'turn-head';
  const sw = span('sw');
  sw.hidden = kind === 'user' || kind === 'system' || kind === 'summary';
  head.append(sw, span('who', label));
  if (when) head.append(span('when', fmtTime(when)));
  const body = document.createElement('div');
  body.className = 'turn-body';
  article.append(head, body);
  return { article, body };
}

function systemTurn(text, cls = '') {
  const t = makeTurn('system', { label: 'Plenum' });
  if (cls) t.article.classList.add(cls);
  t.body.textContent = text;
  return t.article;
}

function toolEl(name, summary, state = 'running', result = '') {
  const d = document.createElement('details');
  d.className = `tool ${state}`;
  const s = document.createElement('summary');
  const mark = span('t-icon');
  mark.append(icon(TOOL_ICONS[name] ?? 'terminal'));
  const status = span('t-state');
  status.append(...stateNodes(state));
  s.append(mark, span('t-name', TOOL_NAMES[name] ?? name), span('t-sum', summary ?? ''), status, icon('chevron', 't-chev'));
  d.append(s);
  if (result) {
    const out = document.createElement('pre');
    out.className = 't-out';
    out.textContent = result;
    d.append(out);
  }
  return d;
}

// A finished step shows only a tick; the word stays available to screen readers.
function stateNodes(state) {
  if (state === 'running') return [span('spinner'), 'Running'];
  if (state === 'done') return [icon('check'), span('sr', 'Done')];
  if (state === 'failed') return [icon('x'), 'Failed'];
  return [];
}

function setToolState(d, state, result) {
  d.className = `tool ${state}`;
  d.querySelector('.t-state').replaceChildren(...stateNodes(state));
  if (result) {
    let out = d.querySelector('.t-out');
    if (!out) {
      out = document.createElement('pre');
      out.className = 't-out';
      d.append(out);
    }
    out.textContent = result;
  }
}

// The approval card. The keys Y (approve), N (deny) and Enter work only while focus is inside the card. The card takes focus when
// it first appears, so a stray key typed into the composer cannot answer it: a composer that already holds text keeps its
// focus, and keys pressed in the first moments after the card takes focus are ignored.
// Pass { reason: false } to leave out the reason box (the build view: its cards are rebuilt on every update, and its coders do not read a reason).
const APPROVAL_SECONDS = 300;   // the server stops waiting after the same time (APPROVAL_TIMEOUT_MS in server.mjs)
const APPROVAL_KEY_DELAY = 400; // milliseconds after the card takes focus before Y, N and Enter count
// The last line of a full change that the server cut at 2,000,000 characters (editPlanDetail in lib/tools.mjs writes the same text).
const FULL_CUT_NOTE = '\n…cut at 2,000,000 characters, the rest is not shown';

function approvalEl(ev, { reason: askReason = true } = {}) {
  const card = document.createElement('div');
  card.className = 'approval fresh';
  card.setAttribute('role', 'alertdialog');
  card.tabIndex = -1;
  // Lets a window that did not answer this card find it when the events channel says it was answered elsewhere (events.on('approval')).
  card.dataset.approvalId = ev.approvalId;
  const head = span('approval-head', 'Approval needed');
  head.prepend(icon('shield'));
  card.append(head, span('approval-summary', ev.summary));
  // A card of a computer run can carry the screenshot the model is acting on, with a ring at the point.
  if (ev.frame && typeof ev.frame.run === 'string' && Number.isInteger(ev.frame.n)) card.append(frameShot(ev.frame));
  let pre = null;
  if (ev.detail) {
    pre = document.createElement('pre');
    pre.className = 'approval-detail';
    pre.textContent = ev.detail;
    card.append(pre);
  }
  // A built-in rule blocked this command (defaultDeny): Deny becomes the primary, focused button and Approve steps back.
  const denyFirst = ev.defaultDeny === true;
  // The line above the buttons says why Deny is the default.
  if (denyFirst) card.append(span('approval-note', 'A built-in rule blocked this command. Deny is the default.'));
  // Why the user said no. It goes to the model with a denial and is never read when the action is approved.
  const why = document.createElement('input');
  why.type = 'text';
  why.className = 'approval-reason';
  why.maxLength = 300;
  why.placeholder = 'Reason for denying (optional), sent to the model';
  why.setAttribute('aria-label', why.placeholder);
  if (askReason) card.append(why);
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const yes = button(denyFirst ? 'ghost' : 'primary', 'Approve');
  const no = button(denyFirst ? 'primary' : 'ghost', 'Deny');
  // Y does nothing on a blocked-command card (see the keys below), so it is only advertised on the others.
  if (!denyFirst) yes.setAttribute('aria-keyshortcuts', 'Y');
  no.setAttribute('aria-keyshortcuts', 'N');
  const hint = span('hint', '');
  // The keys are named while the card waits. Y does nothing on a blocked-command card, so that card names only N.
  const keysHint = denyFirst ? ' · Click the card, then N denies' : ' · Click the card, then Y approves, N denies';
  let answered = false; // set once the card is decided or has timed out; nothing can answer it after that
  let tick = 0;
  // A capped diff (hasMore) gets a Show all button under it. The server keeps the whole diff only while this card waits, and viewing it
  // answers nothing. The text is kept on the event, so a card that is built again (the build view does that on every update) still shows it.
  let more = null; // the Show all button, until the whole diff is shown
  if (pre && ev.hasMore === true) {
    const row = document.createElement('div');
    row.className = 'approval-actions approval-more';
    const showFull = text => {
      const focused = more !== null && document.activeElement === more;
      pre.textContent = text;
      pre.tabIndex = 0; // the long diff can be scrolled with the keyboard
      pre.setAttribute('aria-label', 'Full change');
      // A diff the server cut ends with FULL_CUT_NOTE, so its label says only part of the change is shown.
      row.replaceChildren(span('note-quiet', text.endsWith(FULL_CUT_NOTE) ? 'Partial change shown' : 'Full change shown'));
      more = null;
      if (focused) pre.focus({ preventScroll: true });
    };
    if (typeof ev.fullText === 'string') {
      showFull(ev.fullText);
    } else {
      more = button('ghost small', 'Show all');
      more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          const data = await api(`/api/approve/detail?id=${encodeURIComponent(ev.approvalId)}`);
          if (typeof data.detail !== 'string' || !data.detail) throw new Error('The full change is not available.');
          ev.fullText = data.detail;
          // The build view rebuilds this card on every update, so it may be off the page by now. The card built in its place
          // takes the text from the event, so the repaint shows it there.
          ev.onChange?.();
          if (!card.isConnected) return;
          showFull(ev.fullText);
        } catch (err) {
          // A card that was answered meanwhile is gone, so there is nobody to tell.
          if (!answered && more) more.disabled = false;
          if (!answered) toast(err.message, 'bad');
        }
      });
      row.append(more);
    }
    pre.after(row);
  }
  const decide = async allow => {
    if (answered) return;
    answered = true;
    // This window answered, so the 'answered' event that comes back on the events channel must not replace the card with
    // "in another window".
    card.dataset.answeredHere = '1';
    clearInterval(tick);
    yes.disabled = true;
    no.disabled = true;
    why.disabled = true;
    try {
      await api('/api/approve', allow ? { approvalId: ev.approvalId, allow: true } : { approvalId: ev.approvalId, allow: false, reason: why.value.trim().slice(0, 300) });
    } catch (err) {
      toast(err.message, 'bad');
    }
    // The button that answered is disabled, and a disabled button holds no focus once the card leaves the page. The composer takes
    // the focus then, so the next typing goes somewhere.
    const hadFocus = card.contains(document.activeElement);
    card.remove();
    ev.onDone?.();
    if (hadFocus || document.activeElement === document.body) el.input.focus({ preventScroll: true });
  };
  yes.addEventListener('click', () => decide(true));
  no.addEventListener('click', () => decide(false));
  // The moment the key delay ends. It is set when the card first takes focus, and kept on the event, so a card built again keeps it.
  let keysFrom = ev.keysFrom ?? 0;
  card.addEventListener('keydown', e => {
    if (e.target === why) {
      if (e.key === 'Enter' && !answered && !e.isComposing && !e.repeat) {
        e.preventDefault();
        decide(false);
      }
      return;
    }
    const key = e.key.toLowerCase();
    const answers = key === 'y' || key === 'n';
    // The card answers its own Y and N, so the page-wide keys in ext-shortcuts.js never see them and cannot answer around the checks below.
    if (answers && !e.ctrlKey) e.stopPropagation();
    if (answered || e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    // Right after the card takes focus no key counts, and an Enter held down from sending a message must not press the new button.
    if (performance.now() < keysFrom) {
      if (answers || e.key === 'Enter' || e.key === ' ') e.preventDefault();
      return;
    }
    // Enter inside the full diff only reads it: it answers nothing and presses no button. Space stays a scroll key there.
    if (e.key === 'Enter' && pre?.contains(e.target)) return;
    // On a card for a blocked command Deny is the default, so a key can only deny it: Approve has to be clicked.
    if (answers && !(key === 'y' && denyFirst)) {
      e.preventDefault();
      decide(key === 'y');
    } else if (e.key === 'Enter' && !e.target.closest?.('button')) {
      // Enter on a button presses that button. Anywhere else on the card it presses the primary one.
      e.preventDefault();
      (denyFirst ? no : yes).click();
    }
  });
  // The hint counts down to the server's timeout. The time is kept on the event, so a card that is built again (the build view
  // does that on every update) carries on from where it was. The timer stops when the card is answered or leaves the page.
  const first = ev.shownAt === undefined;
  ev.shownAt ??= Date.now();
  const paint = () => {
    const left = Math.max(0, Math.ceil((ev.shownAt + APPROVAL_SECONDS * 1000 - Date.now()) / 1000));
    if (left > 0) {
      hint.textContent = `Waiting for you. Times out in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}${keysHint}`;
      return;
    }
    answered = true;
    clearInterval(tick);
    yes.disabled = true;
    no.disabled = true;
    why.disabled = true;
    if (more) more.disabled = true; // the server has dropped the approval, and its full diff with it
    hint.textContent = 'Timed out: the action was denied.';
  };
  paint();
  if (!answered) {
    tick = setInterval(() => {
      if (card.isConnected) paint();
      else clearInterval(tick);
    }, 1000);
  }
  actions.append(yes, no, hint);
  card.append(actions);
  // A command card (run_command, or a Bash or PowerShell request) gets the untrusted-commands strip above Approve and Deny. It informs; the card still asks.
  if (/^(?:Coder: )?(?:Run: |Run command: )/.test(ev.summary ?? '')) window.MuseUI?.notice?.('untrusted-commands', { before: actions });
  // The card is not in the page yet, so scrolling and focus wait one frame. A new card scrolls into view and takes focus, unless
  // the user may be typing: a text field, a select or an editable area outside the card has the focus (even an empty one, as
  // after a send), or a drawer is open over the chat. Then the card only scrolls into view, so a word typed there cannot answer it.
  // A card built again keeps the page where it is and takes focus only if nothing has it.
  requestAnimationFrame(() => {
    if (answered) return;
    const at = document.activeElement;
    const idle = !at || at === document.body;
    const drawerOpen = !el.drawer.hidden;
    const typing = drawerOpen || (!idle && !card.contains(at) && (at.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName)));
    if (first) card.scrollIntoView({ block: 'nearest' });
    // Only the first showing takes the focus. A card built again (a build view repaints on every event) never does (B-11).
    if (!typing && first) {
      (denyFirst ? no : yes).focus({ preventScroll: true });
      // The delay starts only the first time the card takes focus. A card built again on the next update keeps the same moment.
      ev.keysFrom ??= performance.now() + APPROVAL_KEY_DELAY;
      keysFrom = ev.keysFrom;
    }
  });
  return card;
}

function errorEl(message) {
  const t = makeTurn('system', { label: 'Something went wrong' });
  t.article.classList.add('error');
  t.article.querySelector('.turn-head').prepend(icon('alert'));
  t.body.textContent = message;
  return t.article;
}

// "Relayed from <label>" above a reply that a seat wrote from another seat's text.
function relayLine(from) {
  const d = document.createElement('div');
  d.className = 'relay-from';
  d.append('Relayed from ', Object.assign(document.createElement('b'), { textContent: from }));
  return d;
}

const sizeText = n => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The images that came with a message, as chips with a name and a size. The picture itself is not kept, so there is nothing to show.
function imageChips(list) {
  const row = document.createElement('div');
  row.className = 'chips msg-images';
  for (const image of list) {
    const chip = span('chip', '');
    chip.title = `${image.name}, ${sizeText(image.size)}`;
    chip.append(icon('file'), span('img-name', image.name), span('img-size', sizeText(image.size)));
    row.append(chip);
  }
  return row;
}

function messageNodes(m) {
  if (m.compact) {
    const t = makeTurn('summary', { label: 'Conversation summary', when: m.ts });
    t.article.querySelector('.turn-head').prepend(icon('layers'));
    t.body.innerHTML = md(m.content.replace(/^Summary of the conversation so far[^\n]*\n+/, ''));
    return [t.article];
  }
  // The build's own note ("Build: goal") is bookkeeping; the build card says the same thing.
  if (m.role === 'user' && m.kind === 'build') return [];
  if (m.role === 'user') {
    const t = makeTurn('user', { label: 'You', when: m.ts });
    t.body.textContent = m.content;
    if (m.images?.length) t.body.append(imageChips(m.images));
    // A message that started a computer run says so under its text: the apps the model may use.
    if (m.computer) {
      const chip = span('chip', '');
      chip.append(icon('shield'), span('img-name', `Computer use${Array.isArray(m.computer.apps) && m.computer.apps.length ? ` · ${m.computer.apps.join(', ')}` : ''}`));
      const row = document.createElement('div');
      row.className = 'chips msg-images';
      row.append(chip);
      t.body.append(row);
    }
    return [t.article];
  }
  if (m.kind === 'advisor') {
    const t = makeTurn('advisor', { label: `Advisor · ${modelName(m.model)}`, provider: 'advisor', when: m.ts });
    t.body.innerHTML = md(m.content);
    return [t.article];
  }
  if (m.kind === 'council') return [councilEl(councilFromSaved(m))];
  if (m.kind === 'build') return [buildEl(buildFromSaved(m))];
  const nodes = [];
  const toolRows = (m.tools ?? []).map(tool => toolEl(tool.name, tool.summary, tool.ok ? 'done' : 'failed', tool.result));
  if (m.computerRun) {
    // A finished computer run takes three lines of the transcript: what it did, a way to see the runs, and its steps folded away.
    const run = m.computerRun;
    const head = document.createElement('div');
    head.className = 'computer-run';
    head.append(icon('shield'), span('cr-text', ` Computer run · ${(run.apps ?? []).join(', ') || 'no app'} · ${run.actions ?? 0} actions · ${stopWordOf(run.stopReason)}`));
    const review = button('ghost small', 'Past runs');
    review.addEventListener('click', () => openComputerRuns());
    head.append(review);
    nodes.push(head);
    if (toolRows.length) {
      const steps = document.createElement('details');
      steps.className = 'computer-steps';
      const sum = document.createElement('summary');
      sum.textContent = `Show ${toolRows.length} ${toolRows.length === 1 ? 'step' : 'steps'}`;
      steps.append(sum, ...toolRows);
      nodes.push(steps);
    }
  } else {
    nodes.push(...toolRows);
  }
  if ((m.content ?? '').trim() || !nodes.length) {
    const t = makeTurn('assistant', { label: modelName(m.model) || 'Assistant', provider: providerOf(m.model), when: m.ts });
    t.body.innerHTML = md(m.content ?? '');
    if (m.relay) t.article.insertBefore(relayLine(m.relay.fromLabel ?? seatLabelById(m.relay.from)), t.body);
    const seat = seatOfReply(m);
    if (seat && (m.content ?? '').trim()) t.article.append(replyActions(m, seat));
    nodes.push(t.article);
  }
  return nodes;
}

// Under a reply from a seat: send it on to other seats, or put it in the composer to edit.
function replyActions(m, seat) {
  const row = document.createElement('div');
  row.className = 'reply-actions';
  const sendBtn = button('ghost small reply-send', 'Send to');
  sendBtn.setAttribute('aria-haspopup', 'menu');
  sendBtn.setAttribute('aria-expanded', 'false');
  sendBtn.title = 'Pass this reply to another seat. Anything in the composer goes with it as a note';
  sendBtn.append(icon('chevron', 'rv'));
  const menu = document.createElement('div');
  menu.className = 'relay-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  for (const s of seatList()) {
    if (s.id === seat.id) continue;
    const item = button('relay-item', s.label);
    item.setAttribute('role', 'menuitem');
    item.dataset.target = s.id;
    menu.append(item);
  }
  const all = button('relay-item', 'All seats');
  all.setAttribute('role', 'menuitem');
  all.dataset.target = 'all';
  all.title = 'Every other seat, at once';
  menu.append(all);
  sendBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.hidden;
    closeRelayMenus();
    menu.hidden = !open;
    sendBtn.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', e => {
    const item = e.target.closest('button[data-target]');
    if (!item) return;
    closeRelayMenus();
    relayReply(seat.id, item.dataset.target === 'all' ? ['all'] : [item.dataset.target]);
  });
  const insertBtn = button('ghost small', 'Insert into composer');
  insertBtn.title = 'Put this reply in the composer to edit. It never overwrites text you have typed';
  insertBtn.addEventListener('click', () => insertReply(m.content ?? ''));
  row.append(sendBtn, insertBtn, menu);
  return row;
}

function closeRelayMenus() {
  for (const menu of document.querySelectorAll('.relay-menu')) menu.hidden = true;
  for (const b of document.querySelectorAll('.reply-send[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
}

// Puts a reply in the composer for editing. A non-empty composer is never overwritten.
function insertReply(text) {
  if (el.input.value.trim()) return toast('The composer already has text. Clear it first, then insert the reply.', 'bad');
  el.input.value = text;
  autosize();
  el.input.focus();
  toast('Reply inserted. Edit it, then send.');
}

// ---------- welcome screens ----------

function welcomeNoProject() {
  const w = document.createElement('section');
  w.className = 'welcome';
  w.append(hero(), headline('Welcome to ', 'Plenum'));
  w.append(para('Add a project folder to start. Claude can read and change files there and run commands. Muse Code, Codex and Gemini work in the same folder.'));
  const add = button('primary', 'Add a project folder');
  add.addEventListener('click', openAddForm);
  w.append(add);
  return w;
}

function welcomeProject(p) {
  const w = document.createElement('section');
  w.className = 'welcome';
  w.append(hero(), headline('What should we ', 'build?'));
  const where = document.createElement('p');
  where.append('Working in ', Object.assign(document.createElement('code'), { textContent: p.name }), '. Pick a suggestion or type below.');
  w.append(where);
  const grid = document.createElement('div');
  grid.className = 'suggest';
  for (const [title, desc, text, glyph] of SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    const tile = span('s-ic');
    tile.append(icon(glyph));
    b.append(tile, Object.assign(document.createElement('b'), { textContent: title }), span('', desc));
    b.addEventListener('click', () => {
      el.input.value = text;
      autosize();
      el.input.focus();
      updatePalette();
    });
    grid.append(b);
  }
  w.append(grid);
  const tips = document.createElement('div');
  tips.className = 'tips';
  tips.append('Try ', Object.assign(document.createElement('code'), { textContent: '/advisor sonnet' }), ' to pick a reviewer, ', Object.assign(document.createElement('code'), { textContent: '/review' }), ' after a change, or ', Object.assign(document.createElement('code'), { textContent: '/council' }), ' to ask every seat at once.');
  w.append(tips);
  return w;
}

// ---------- rendering ----------

function renderAll() {
  renderTop();
  renderProjects();
  renderChat();
  renderStatus();
  renderBadge();
  renderBoard();
  renderMusic();
}

// Everything renderAll draws except the transcript, so a reply that is streaming into it is never wiped by a settings change.
function renderShell() {
  renderTop();
  renderProjects();
  renderStatus();
  renderBadge();
  renderBoard();
  renderMusic();
}

function renderTop() {
  const p = S.projects.find(x => x.id === S.activeProject);
  el.projName.textContent = p ? p.name : 'No project';
  el.projPath.textContent = p ? p.path : '';
  el.projPath.title = p ? p.path : '';
  document.title = p ? `${p.name} · Plenum` : 'Plenum';
  if (!el.model.options.length && catalog.length) {
    fillModels(el.model, false);
    fillModels(el.advisor, true);
  }
  if (!el.effort.options.length) {
    el.effort.replaceChildren(...menuHead(), ...effortOptions());
  }
  el.model.value = S.model;
  el.advisor.value = S.advisor ?? 'off';
  el.auto.checked = !!S.advisorAuto;
  el.effort.value = S.effort ?? 'high';
}

// "Muse Wonder (new, Oct 2026)" -> ["Muse Wonder", "new, Oct 2026"].
function splitLabel(label) {
  const m = label.match(/^(.*?)\s*\((.*)\)$/);
  return m ? [m[1], m[2]] : [label, ''];
}

// One choice in a menu. A provider adds its coloured dot.
function menuOption(value, name, note = '', provider = null) {
  if (!RICH_MENUS) return new Option(note && provider ? `${name} (${note})` : name, value);
  const o = document.createElement('option');
  o.value = value;
  if (provider !== null) {
    const dot = span('o-dot');
    dot.dataset.p = provider;
    o.append(dot);
  }
  const text = span('o-text');
  text.append(span('o-name', name));
  if (note) text.append(' ', span('o-note', note));
  o.append(text);
  return o;
}

// The closed menu shows a copy of the chosen option; this is the element the browser copies it into.
function menuHead() {
  if (!RICH_MENUS) return [];
  const b = button('', '');
  b.append(document.createElement('selectedcontent'));
  return [b];
}

function effortOptions() {
  return Object.entries(EFFORT_LABELS).map(([value, name]) => menuOption(value, name, EFFORT_NOTES[value]));
}

function fillModels(select, withOff) {
  const nodes = menuHead();
  if (withOff) nodes.push(menuOption('off', 'Off', 'No second opinion', ''));
  for (const [provider, name] of GROUPS) {
    const items = catalog.filter(x => x.provider === provider);
    if (!items.length) continue;
    const group = document.createElement('optgroup');
    group.label = name;
    for (const c of items) group.append(menuOption(`${c.provider}:${c.id}`, ...splitLabel(c.label), provider));
    nodes.push(group);
  }
  select.replaceChildren(...nodes);
}

// Makes sure a saved model is an option even before the catalog has loaded.
function ensureOption(select, ref) {
  if (ref && ![...select.options].some(o => o.value === ref)) select.append(new Option(modelName(ref) || ref, ref));
}

function renderProjects() {
  el.projects.replaceChildren();
  if (!S.projects.length) {
    el.projects.append(Object.assign(document.createElement('div'), { className: 'empty-side', textContent: 'No projects yet. Use + to add a folder.' }));
    return;
  }
  for (const p of S.projects) {
    const active = p.id === S.activeProject;
    const row = document.createElement('div');
    row.className = `proj-item${active ? ' active' : ''}`;
    row.title = p.path;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    if (active) row.setAttribute('aria-current', 'true');
    const tile = span('pi');
    tile.append(icon('folder'));
    const forget = button('forget', '');
    forget.append(icon('x'));
    forget.title = 'Forget this project (files are kept)';
    forget.setAttribute('aria-label', `Forget ${p.name}`);
    forget.addEventListener('click', e => { e.stopPropagation(); removeProject(p); });
    row.append(tile, span('pn', p.name), span('pp', parentHint(p.path)), forget);
    // The status dot: breathing while this project runs in this window (or the server reports it running on screen).
    if (runs.has(p.id) || (active && S.running)) {
      const dot = span('pi-dot', '');
      dot.dataset.tone = 'running';
      dot.setAttribute('aria-hidden', 'true');
      row.append(dot);
      row.dataset.running = '';
    }
    row.addEventListener('click', () => switchProject(p));
    row.addEventListener('keydown', e => {
      if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      switchProject(p);
    });
    el.projects.append(row);
  }
}

function renderChat() {
  streamEl = document.createElement('div');
  streamEl.className = 'stream';
  if (!S.activeProject) streamEl.append(welcomeNoProject());
  else if (!S.messages.length && !notes.length) streamEl.append(welcomeProject(S.projects.find(p => p.id === S.activeProject)));
  // A build belongs to the council card just above it, so its plan, run and review sit together.
  let host = null;
  for (const m of S.messages) {
    if (m.kind === 'build' && m.role === 'user') continue;
    if (m.kind === 'build' && m.role === 'assistant' && host) {
      host.querySelector('.council-slot')?.append(buildEl(buildFromSaved(m)));
      continue;
    }
    const nodes = messageNodes(m);
    for (const node of nodes) streamEl.append(node);
    host = m.kind === 'council' && m.role === 'assistant' ? nodes[0] : null;
  }
  for (const n of notes) streamEl.append(n.startsWith('Error: ') ? errorEl(n.slice(7)) : systemTurn(n));
  // The live run of this project, if it has one, goes back under the saved messages (B-9, B-10).
  const live = S.activeProject ? runBoxes.get(S.activeProject) : null;
  if (live) streamEl.append(live);
  el.chat.replaceChildren(streamEl);
  el.chat.scrollTop = el.chat.scrollHeight;
}

function renderStatus() {
  el.statusbar.replaceChildren();
  const item = (ok, label, title) => {
    const b = button(`st ${ok ? 'ok' : 'bad'}`, label);
    b.prepend(span('dot'));
    b.title = title;
    b.addEventListener('click', () => openAccounts());
    return b;
  };
  if (providers) {
    el.statusbar.append(
      item(providers.muse.installed, providers.muse.installed ? 'Muse Code' : 'Muse Code not installed', 'Muse Code: open Accounts'),
      item(providers.anthropic.credentials, providers.anthropic.credentials ? 'Claude' : providers.anthropic.route === 'cli' ? 'Claude sign-in needed' : 'Claude key needed', 'Claude: open Accounts'),
      item(providers.codex.installed, providers.codex.installed ? 'Codex' : 'Codex not found', 'Codex: open Accounts'),
    );
    const g = providers.gemini;
    if (g) {
      el.statusbar.append(item(g.installed && g.signedIn, !g.installed ? 'Gemini not installed' : g.signedIn ? 'Gemini' : 'Gemini sign-in needed', `Gemini: open Accounts. ${GEMINI_EDIT}`));
    }
  }
  if (S.running || activeRun()) {
    const working = span('run-state', 'Working…');
    working.prepend(span('spinner'));
    el.statusbar.append(working);
  }
  syncQueue();
}

function renderBadge() {
  el.updatesBadge.textContent = String(updates.length);
  el.updatesBadge.hidden = !updates.length;
}

function setBusy(busy) {
  el.send.classList.toggle('stop', busy);
  el.send.title = busy ? 'Stop' : 'Send';
  el.send.setAttribute('aria-label', el.send.title);
  el.hint.textContent = busy ? BUSY_HINT : idleHint();
  renderStatus();
  // The project's status dot follows its run (renderProjects reads the runs map).
  renderProjects();
}

function idleHint() {
  return mode === 'council' ? 'Council · Enter asks every seat · /council off returns to Chat' : DEFAULT_HINT;
}

// ---------- palette ----------

function autosize() {
  el.input.style.height = 'auto';
  const full = el.input.scrollHeight;
  el.input.style.height = `${Math.min(full, 224)}px`;
  // The box scrolls only once it has reached its full height.
  el.input.style.overflowY = full > 224 ? 'auto' : 'hidden';
}

function hidePalette() {
  el.palette.hidden = true;
}

// The command name and its arguments, kept on one line so long argument lists never squeeze the description.
function commandHead(c) {
  const head = document.createElement('span');
  head.className = 'cmd-head';
  head.append(span('cn', `/${c.name}`));
  if (c.args) head.append(span('ca', c.args));
  return head;
}

function paletteRow(c, i) {
  const row = document.createElement('div');
  row.className = `cmd${i === paletteIndex ? ' sel' : ''}`;
  const head = commandHead(c);
  // A command found by one of its other words says which one, so the match is not a surprise.
  if (c.via === 'alias') head.append(span('ca', `also /${c.alias}`));
  row.append(head, span('cd', c.desc));
  row.addEventListener('mousedown', e => {
    e.preventDefault();
    pickCommand(i);
  });
  return row;
}

function pickCommand(i) {
  const c = paletteItems[i];
  if (!c) return;
  el.input.value = `/${c.name}${c.args ? ' ' : ''}`;
  autosize();
  hidePalette();
  el.input.focus();
  commandHint();
}

// The commands a typed word finds, in this order: names that start with it, aliases that start with it, then (two letters
// or more) descriptions that contain it. Each command appears once. Pure, so the test can run it on its own.
function matchCommands(commands, q) {
  const out = [];
  const seen = new Set();
  const add = (c, via, alias) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    out.push({ ...c, via, alias });
  };
  for (const c of commands) if (c.name.startsWith(q)) add(c, 'name');
  for (const c of commands) {
    const alias = (c.aliases ?? []).find(a => a.startsWith(q));
    if (alias) add(c, 'alias', alias);
  }
  if (q.length >= 2) for (const c of commands) if (c.desc.toLowerCase().includes(q)) add(c, 'desc');
  return out;
}

function updatePalette() {
  const m = el.input.value.match(/^\/([\w-]*)$/);
  if (!m) return hidePalette();
  const q = m[1].toLowerCase();
  paletteItems = matchCommands(COMMANDS, q);
  if (!paletteItems.length) {
    if (!q) return hidePalette();
    // Nothing matches: say so once. Enter then submits the text as typed, and the arrows do nothing.
    el.palette.replaceChildren(Object.assign(document.createElement('div'), { className: 'cmd cmd-none', textContent: `No command matches /${q}. Type /help for the list.` }));
    el.palette.hidden = false;
    return;
  }
  paletteIndex = Math.min(paletteIndex, paletteItems.length - 1);
  el.palette.replaceChildren(...paletteItems.map((c, i) => paletteRow(c, i)));
  el.palette.hidden = false;
}

// While a command with arguments is typed, the status line shows its usage and what it does, in place of the usual hint.
function commandHint() {
  const m = el.input.value.match(/^\/([\w-]+)\s/);
  const word = m?.[1].toLowerCase();
  const c = word && COMMANDS.find(x => x.name === word || x.aliases?.includes(word));
  if (c?.args) {
    el.hint.textContent = `/${c.name} ${c.args} · ${c.desc}`;
    el.hint.classList.add('hint-args');
    return;
  }
  el.hint.classList.remove('hint-args');
  el.hint.textContent = busyNow() ? BUSY_HINT : idleHint();
}

function movePalette(delta) {
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  [...el.palette.children].forEach((row, i) => row.classList.toggle('sel', i === paletteIndex));
  el.palette.children[paletteIndex]?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

// ---------- streaming ----------

function readSSE(res, onEvent) {
  return (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data) onEvent(JSON.parse(data));
      }
    }
  })();
}

// One streamed run at a time per project. The chat, a council, a build and a relay all share it.
// Resolves to false when the request never got going (so the caller can keep what the user typed).
async function runStream(url, body, onEvent, { tick } = {}) {
  // The run belongs to the project on screen when it starts. Its controller and its box are keyed by that project (B-8, B-9).
  const project = S.activeProject;
  const ctl = new AbortController();
  runs.set(project, ctl);
  const box = runBox(project);
  setBusy(true);
  const began = Date.now();
  const clock = setInterval(() => {
    const time = clockText(Math.floor((Date.now() - began) / 1000));
    tick?.(Math.floor((Date.now() - began) / 1000), time);
    const state = el.statusbar.querySelector('.run-state');
    if (state) state.lastChild.textContent = `Working… ${time}`;
  }, 1000);
  let ok = true;
  // The server ends a run with a done event, or reports a failed run with an error event. A stream that ends with neither was cut
  // short, so it is reported below. Without that the message would vanish with no error, since the page redraws from the server.
  let reported = false;
  // Set when the run failed (a refused send, a dropped stream or an error event), so its text stays in lastSent for Retry (B-5).
  let failed = false;
  liveRunId = '';
  // Every event of the stream carries the run's id. The first one tells which run is ours, so the events channel (which carries
  // every run) does not draw it a second time. Each event is also announced to the page's panels as 'muse:stream'.
  const watch = ev => {
    if (ev.runId && !liveRunId) liveRunId = ev.runId;
    if (ev.type === 'done' || ev.type === 'error') reported = true;
    if (ev.type === 'error') failed = true;
    window.dispatchEvent(new CustomEvent('muse:stream', { detail: ev }));
    onEvent(ev);
  };
  try {
    const res = await request(url, { method: 'POST', body, signal: ctl.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (tokenRefused(res)) showTokenCard();
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    await readSSE(res, watch);
    if (!reported) throw new Error('The run ended before it finished. Try again.');
  } catch (err) {
    ok = false;
    if (err.name !== 'AbortError') {
      failed = true;
      notes.push(`Error: ${err.message}`);
      box.append(errorEl(err.message));
    }
  } finally {
    clearInterval(clock);
    if (runs.get(project) === ctl) runs.delete(project);
    // B-5: a run that finished without failing lets its send's text go, so Retry never offers an old message. A failed one keeps it.
    if (!failed && lastSent?.project === project) lastSent = null;
    dropRunBox(project);
    routeRun = null;
    renderRouteBar();
    // Only this project's run has ended. Another project's Stop stays as it is (B-8).
    setBusy(Boolean(activeRun()));
    await refresh();
    setBusy(busyNow());
    await loadUpdates();
    // The run is over, however it ended (Stop included): the next queued message, if there is one, starts now.
    scheduleDrain();
  }
  return ok;
}

// A chat turn, a relay send or a relay route. Each seat has a lane of its own, so the parallel
// replies of a broadcast stay apart; a chain's hops arrive one after another in the same way.
function streamTurn(url, body) {
  const renderer = turnRenderer();
  return runStream(url, body, renderer.onEvent, { tick: renderer.tick });
}

// Draws the events of a chat turn, a review or a relay into the transcript: the turns, the tool lines and the approval cards.
// It serves a run of this window (streamTurn) and a run started in another window (foreignFeed). Returns { onEvent, tick }.
function turnRenderer(project = S.activeProject) {
  // The box of this run's project, so its events never paint into another project's transcript (B-9).
  const box = runBox(project);
  const tools = new Map();
  const lanes = new Map();
  // The model's note between computer actions (the current line), and the card that offers to type a step for the person.
  let thought = null;
  const typeIt = typeItTracker(box);
  let hopFrom = '';
  let stepNote = null;
  const lane = seat => {
    const key = seat ?? '';
    if (!lanes.has(key)) lanes.set(key, { kind: 'chat', model: null, label: '', current: null });
    return lanes.get(key);
  };
  const openTurn = (ln, html) => {
    const advisor = ln.kind === 'advisor';
    const t = makeTurn(advisor ? 'advisor' : 'assistant', {
      label: advisor ? `Advisor · ${modelName(ln.model)}` : ln.label,
      provider: advisor ? 'advisor' : providerOf(ln.model),
      when: Date.now(),
    });
    if (ln.kind === 'relay' && hopFrom) t.article.insertBefore(relayLine(hopFrom), t.body);
    t.body.innerHTML = html;
    t.article.classList.add('fresh');
    box.append(t.article);
    return { article: t.article, body: t.body, text: '', queued: false };
  };
  // Text arrives in many small pieces; the reply is redrawn at most once per frame.
  const paint = turn => {
    if (turn.queued) return;
    turn.queued = true;
    requestAnimationFrame(() => {
      turn.queued = false;
      turn.body.innerHTML = md(turn.text);
      stickBottom();
    });
  };
  // One line for the hop in progress; it is kept as a record once the hop is done.
  const step = text => {
    if (!stepNote || !stepNote.isConnected) {
      stepNote = document.createElement('div');
      stepNote.className = 'relay-step';
      box.append(stepNote);
    }
    stepNote.textContent = text;
    stickBottom();
  };
  const onEvent = ev => {
    const ln = lane(ev.seat);
    switch (ev.type) {
      case 'start':
        ln.kind = ev.kind ?? 'chat';
        ln.model = ev.model;
        ln.label = ev.label || modelName(ev.model);
        ln.current = openTurn(ln, THINKING);
        break;
      case 'delta':
        // Text that follows tool steps gets a turn of its own, under those steps.
        ln.current ??= openTurn(ln, '');
        ln.current.text += ev.text;
        paint(ln.current);
        break;
      case 'thought': {
        // A computer run narrates each action. A note that is fresh, or comes after a step, starts a new line.
        if (ev.fresh === true || !thought || !thought.isConnected) {
          thought = thoughtLine();
          box.append(thought);
        }
        thought.textContent += String(ev.text ?? '');
        stickBottom();
        break;
      }
      case 'approval-closed': {
        // A run that was stopped closes its waiting cards; the server says which, and the card goes.
        const card = [...box.querySelectorAll('.approval[data-approval-id]')].find(c => c.dataset.approvalId === ev.approvalId);
        card?.remove();
        break;
      }
      case 'drive':
        typeIt.sync(ev.drive);
        break;
      case 'tool': {
        thought = null;
        if (ln.current && !ln.current.text) ln.current.article.remove();
        ln.current = null;
        const d = toolEl(ev.name, ev.summary, 'running');
        d.classList.add('fresh');
        tools.set(ev.id, d);
        box.append(d);
        stickBottom();
        break;
      }
      case 'tool_result': {
        const d = tools.get(ev.id);
        if (d) setToolState(d, ev.ok ? 'done' : 'failed', ev.summary);
        break;
      }
      case 'approval':
        if (ln.current && !ln.current.text) ln.current.article.remove();
        ln.current = null;
        box.append(approvalEl(ev));
        cue('approval');
        stickBottom();
        break;
      case 'error':
        if (ln.current && !ln.current.text) ln.current.article.remove();
        ln.current = null;
        // Kept in the notes so the end-of-turn refresh does not wipe it.
        notes.push(`Error: ${ev.message}`);
        box.append(errorEl(ev.message));
        cue('error');
        stickBottom();
        break;
      case 'notice':
        // A short note from the server, such as a session that had to start again with the transcript.
        box.append(systemTurn(ev.text));
        // The server sends the Approve all notice once per thread per launch, and the end-of-run refresh would drop it, so it is kept
        // in the notes (drawn after the transcript, and cleared when the next message is sent).
        if (ev.kind === 'approve-all') notes.push(ev.text);
        // amend-22: a Codex or Gemini coder that cannot ask shows the cli-no-ask strip above the composer (the notices module draws it).
        if (ev.kind === 'cli-no-ask') window.MuseUI?.notice?.('cli-no-ask', { before: el.form });
        stickBottom();
        break;
      case 'hop-skipped':
        step(`Hop ${ev.hop} skipped: the same reply was already sent (${ev.reason}).`);
        break;
      case 'relay-start':
        if (ev.kind === 'route') {
          routeRun = { limit: ev.hops ?? null, hop: 0, paused: false };
          renderRouteBar();
        }
        break;
      case 'hop-countdown':
        if (routeRun) routeRun.hop = ev.hop;
        renderRouteBar();
        step(`Hop ${ev.hop}: ${ev.from.label} → ${ev.to.label} in ${ev.seconds}…`);
        break;
      case 'hop-start':
        hopFrom = ev.from.label;
        if (routeRun) routeRun.hop = ev.hop;
        renderRouteBar();
        step(`Hop ${ev.hop}: ${ev.from.label} → ${ev.to.label}`);
        break;
      case 'hop-done':
        step(`Hop ${ev.hop} ${ev.ok ? 'done' : 'failed'}: ${ev.from.label} → ${ev.to.label}`);
        stepNote = null;
        if (!ev.ok) {
          notes.push(`Error: ${ev.error || 'A hop failed.'}`);
          box.append(errorEl(ev.error || 'A hop failed.'));
        }
        break;
      case 'relay-paused':
        if (routeRun) routeRun.paused = true;
        renderRouteBar();
        break;
      case 'relay-resumed':
        if (routeRun) routeRun.paused = false;
        renderRouteBar();
        break;
      case 'relay-done':
        step(`Relay finished: ${ev.hops} ${ev.hops === 1 ? 'hop' : 'hops'}, ${STOP_TEXT[ev.stopped] ?? ev.stopped}.`);
        stepNote = null;
        routeRun = null;
        renderRouteBar();
        break;
      default:
        break;
    }
  };
  // Muse Code and Codex only print their answer at the end, so a long run says so.
  const tick = (secs, time) => {
    if (secs < 10) return;
    for (const ln of lanes.values()) {
      const label = ln.current?.body.querySelector('.thinking-text');
      if (!label) continue;
      const cli = ['muse', 'codex'].includes(providerOf(ln.model)) && secs >= 30;
      label.textContent = cli ? `Working · ${time} · the answer appears when ${modelName(ln.model)} finishes` : `Thinking · ${time}`;
    }
  };
  return { onEvent, tick };
}

// Images picked in the composer (public/ext-images.js) go with the next chat message to a model that takes them. A queued
// message brings the images it was queued with. Without that script there are none.
const pickedImages = () => window.MuseImages?.list() ?? [];
// The reason a model cannot take the images in list, in the server's words, or '' when it can (or when there are none). The list
// is the composer's files, or the files a queued message was queued with (B-94). public/ext-images.js takes(model, files) checks it.
const imageRefusal = (list, model) => (list.length && window.MuseImages && !window.MuseImages.takes(model, list) ? window.MuseImages.REFUSAL : '');

// computer (optional) is the settings of a computer run that this message starts (see sendComputer); appNames are its apps, for the chip.
async function sendMessage(text, model, images, computer, appNames) {
  if (text.length > 14_000_000) return toast('That message is too long to send (over 14 million characters). Split it up or attach the file with @path.', 'bad');
  if (!S.activeProject) {
    openAddForm();
    return toast('Add a project folder first.', 'bad');
  }
  if (S.running && !activeRun()) return toast('This project is already running. Use /cancel first.', 'bad');
  const sent = images ?? pickedImages();
  const refusal = imageRefusal(sent, model);
  if (refusal) return toast(refusal, 'bad');
  if (!images) window.MuseImages?.clear();
  notes = [];
  S.messages.push({ role: 'user', kind: 'chat', content: text, ts: Date.now(), ...(sent.length ? { images: sent.map(({ name, size }) => ({ name, size })) } : {}), ...(computer ? { computer: { task: true, apps: appNames ?? [] } } : {}) });
  renderChat();
  stream().lastElementChild?.classList.add('fresh');
  // B-5: the text is kept until the run is known to have gone through, so Retry can put back what the server refused.
  lastSent = { text, images: sent, project: S.activeProject };
  await streamTurn('/api/chat', { project: S.activeProject, message: text, model, ...(sent.length ? { images: sent.map(({ name, mime, data }) => ({ name, mime, data })) } : {}), ...(computer ? { computer } : {}) });
}

// ---------- queued follow-ups ----------

// Enter while a run is going keeps the text here, in the page: up to MAX_QUEUED messages, oldest first. The queue is in memory
// only. It is not sent to the server and not saved, so a reload of the page loses it. When the run ends, the oldest message
// goes out as a normal chat message (sendMessage), so it has its own stream, its own approval cards and every rule a typed
// message has. Stop ends the run and leaves the queue as it is, and the next message then starts.
function queueFollowUp() {
  const text = el.input.value.trim();
  if (!text || !S.activeProject) return;
  if (text.startsWith('/')) return toast('Commands run when nothing else is running. Press Esc to stop the run first.', 'bad');
  if (mode === 'council') return toast('A council question cannot be queued. Wait for this run to end, or press Esc to stop it.', 'bad');
  if (text.length > 14_000_000) return toast('That message is too long to send (over 14 million characters). Split it up or attach the file with @path.', 'bad');
  // The text stays in the box when the queue is full.
  if (followUps.length >= MAX_QUEUED) {
    return toast(`${MAX_QUEUED} messages are already waiting in this project. Wait for one to start, or clear the queue.`, 'bad');
  }
  // Images in the composer wait with the message, so they go out with it and not with a later one.
  const images = pickedImages();
  const refusal = imageRefusal(images);
  if (refusal) return toast(refusal, 'bad');
  followUps.push({ project: S.activeProject, text, images });
  window.MuseImages?.clear();
  el.input.value = '';
  autosize();
  hidePalette();
  commandHint();
  syncQueue();
}

function clearQueue() {
  const cleared = followUps.length;
  followUps = [];
  syncQueue();
  toast(cleared ? `Dropped ${cleared} queued ${cleared === 1 ? 'message' : 'messages'}` : 'The queue was already empty');
}

// A queued message belongs to the project it was typed in. If another project is on screen when the queue is looked at (the
// person switched, or forgot the project), those messages are dropped, so none of them lands in the wrong chat.
function dropOtherProjects() {
  const kept = followUps.filter(f => f.project === S.activeProject);
  const dropped = followUps.length - kept.length;
  if (!dropped) return;
  followUps = kept;
  toast(`Dropped ${dropped} queued ${dropped === 1 ? 'message' : 'messages'} because the project changed`, 'bad');
}

// Sends the oldest queued message in the ordinary way. It waits while a run is going (a stopped run can still be winding down
// on the server, and watchRun then calls this again).
async function drainQueue() {
  dropOtherProjects();
  if (!followUps.length || busyNow()) return;
  const next = followUps[0];
  // The queued files are checked before the message leaves the queue. When the model cannot take them, the message stays at the
  // head with the reason, and Edit or Remove deal with it (B-94).
  const refusal = imageRefusal(next.images ?? [], undefined);
  if (refusal) return toast(refusal, 'bad');
  followUps.shift();
  syncQueue();
  await sendMessage(next.text, undefined, next.images);
}

// Called when a run has ended and the state has been read again, however the run ended (finished, failed or stopped). It waits
// one turn of the event loop, so the code that started the run finishes its own steps first.
function scheduleDrain() {
  setTimeout(() => drainQueue().catch(err => toast(err.message, 'bad')), 0);
}

function buildQueueLine() {
  const line = document.createElement('div');
  line.className = 'queue-line';
  line.setAttribute('role', 'status');
  line.hidden = true;
  const list = document.createElement('ul');
  list.className = 'queue-list';
  const clear = button('ghost small', 'Clear queue');
  clear.title = 'Drop the waiting messages. The run in progress is not stopped';
  clear.addEventListener('click', clearQueue);
  line.append(span('ql-text', ''), list, clear);
  el.form.before(line);
  return line;
}

// Removes one waiting message. The rest keep their order and still send after the run.
function removeQueued(item) {
  const i = followUps.indexOf(item);
  if (i < 0) return;
  followUps.splice(i, 1);
  syncQueue();
  toast('Removed 1 queued message');
}

// Moves one waiting message back into the composer, so it can be fixed and sent again. It refuses while the composer has text,
// so nothing typed is overwritten.
function editQueued(item) {
  const i = followUps.indexOf(item);
  if (i < 0) return;
  // Files already in the composer are refused too, so the restored files never mix with the ones in the composer (B-94).
  if (el.input.value.trim() || pickedImages().length) return toast('The composer already has text or files. Send or clear it first.', 'bad');
  followUps.splice(i, 1);
  el.input.value = item.text;
  if (item.images?.length) {
    if (window.MuseImages?.restore) window.MuseImages.restore(item.images);
    else toast("The message's images were dropped; attach them again.");
  }
  autosize();
  hidePalette();
  syncQueue();
  el.input.focus();
}

// One row per waiting message: its first words (the full text in the title), then Edit and Remove.
function queueRow(item, i) {
  const row = document.createElement('li');
  row.className = 'queue-item';
  const flat = item.text.replace(/\s+/g, ' ');
  const label = span('q-text', flat.length > 80 ? `${flat.slice(0, 80)}…` : flat);
  label.title = item.text;
  const edit = button('ghost small', 'Edit');
  edit.setAttribute('aria-label', `Edit queued message ${i + 1}`);
  edit.addEventListener('click', () => editQueued(item));
  const remove = button('ghost small', 'Remove');
  remove.setAttribute('aria-label', `Remove queued message ${i + 1}`);
  remove.addEventListener('click', () => removeQueued(item));
  row.append(label, edit, remove);
  return row;
}

// Rebuilds the rows only when the queue itself has changed, so a redraw during a run does not take focus off a button.
function paintQueueRows(list) {
  const same = followUps.length === queueDrawn.length && followUps.every((item, i) => item === queueDrawn[i]);
  if (same) return;
  queueDrawn = [...followUps];
  list.replaceChildren(...followUps.map(queueRow));
}

// Keeps the queued line, the Send/Stop look of the button and the state timer in step with S. renderStatus calls it on every
// redraw. A run this page holds no stream for has no abort handle here, so the button stops it through the server.
function syncQueue() {
  dropOtherProjects();
  const queued = followUps.length;
  if (queued > 0 || queueLine) {
    queueLine ??= buildQueueLine();
    queueLine.hidden = queued === 0;
    if (queued > 0) {
      queueLine.firstElementChild.textContent = queued === 1
        ? '1 message queued. It starts when the current run ends.'
        : `${queued} messages queued. They start one at a time, in order.`;
    }
    paintQueueRows(queueLine.querySelector('.queue-list'));
  }
  const stop = busyNow();
  el.send.classList.toggle('stop', stop);
  el.send.title = stop ? 'Stop' : 'Send';
  el.send.setAttribute('aria-label', el.send.title);
}

// The fallback for the events channel. While the channel is down (and only then, every 5 seconds) the state is read and the
// page is redrawn when the run, the project or the chat has changed, and the next queued message starts once the project is idle.
// While the channel is up, the server sends every change and this does nothing.
async function watchRun() {
  if (runs.size || events.connected) return;
  try {
    const next = await api('/api/state');
    if (runs.size || events.connected) return;
    const changed = next.running !== S.running || next.activeProject !== S.activeProject || next.messages.length !== S.messages.length;
    if (changed) {
      S = next;
      renderAll();
    }
    if (!S.running) scheduleDrain();
  } catch {
    // The next tick tries again.
  }
}
setInterval(watchRun, 5000);

// /compact: the main model writes a summary, which then replaces the chat.
async function compact() {
  if (!S.activeProject) return toast('Add a project folder first.', 'bad');
  if (S.running || activeRun()) return toast('This project is already running. Use /cancel first.', 'bad');
  if (S.messages.filter(m => m.kind === 'chat').length < 2) return toast('There is not enough conversation to compact yet.');
  const project = S.activeProject;
  const ctl = new AbortController();
  runs.set(project, ctl);
  setBusy(true);
  const t = makeTurn('assistant', { label: modelName(S.model), provider: providerOf(S.model) });
  t.article.classList.add('fresh');
  t.body.innerHTML = THINKING.replace('Thinking', 'Summarising the conversation');
  runBox(project).append(t.article);
  el.chat.scrollTop = el.chat.scrollHeight;
  try {
    const res = await request('/api/compact', { method: 'POST', body: { project }, signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (tokenRefused(res)) showTokenCard();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    S = data;
    notes = [];
    toast(`Compacted ${data.compacted} messages into a summary`);
  } catch (err) {
    toast(err.name === 'AbortError' ? 'Compacting was cancelled. The chat is unchanged.' : err.message, 'bad');
  } finally {
    if (runs.get(project) === ctl) runs.delete(project);
    dropRunBox(project);
    setBusy(Boolean(activeRun()));
    await refresh();
    setBusy(busyNow());
    scheduleDrain();
  }
}

async function review() {
  if (!S.activeProject) return toast('Add a project folder first.', 'bad');
  if (!S.advisor) return toast('The advisor is off. Try /advisor sonnet.', 'bad');
  // A review is a new run, so a message from an earlier failed send is no longer what Retry should offer (B-5).
  lastSent = null;
  await streamTurn('/api/review', { project: S.activeProject });
}

// ---------- council: one renderer for the saved transcript and the live card ----------

// The text a seat wrote after its ANSWER: line, or the whole reply while the answer has not started.
function seatAnswer(text = '') {
  const at = text.search(/^ANSWER:/m);
  if (at !== -1) return text.slice(text.indexOf(':', at) + 1).trim();
  return text.replace(/^(POSITION|CONFIDENCE|CHANGED|AGREE|DISAGREE):.*$/gim, '').trim();
}

// The header lines of a seat's reply: its position, its confidence and whether round 2 changed it.
function seatMeta(text = '') {
  const position = text.match(/^POSITION:\s*(.+)$/im)?.[1].trim() ?? '';
  const conf = text.match(/^CONFIDENCE:\s*(\d{1,3})/im);
  const changed = text.match(/^CHANGED:\s*(yes|no)/im)?.[1].toLowerCase() ?? null;
  return { position, confidence: conf ? Math.min(100, Number(conf[1])) : null, changed };
}

function seatList() {
  const cfg = S.council ?? DEFAULT_COUNCIL;
  return cfg.seats.map((s, i) => ({ ...s, id: SEAT_IDS[i], label: seatLabel(s) }));
}

function seatLabel(s) {
  return `${modelName(s.ref)} · ${ROLE_LABELS[s.role] ?? s.role}`;
}

function seatLabelById(id) {
  return seatList().find(s => s.id === id)?.label ?? id ?? '';
}

// The council seat that wrote a chat reply: the seat it was relayed to, or the seat with its model.
function seatOfReply(m) {
  const seats = seatList();
  return seats.find(s => s.id === m.relay?.to) ?? seats.find(s => s.ref === m.model) ?? null;
}

function liveCouncil(question, config) {
  return {
    question,
    rounds: config.rounds ?? 2,
    mod: config.moderator ? { label: modelName(config.moderator.ref), ref: config.moderator.ref } : null,
    seats: config.seats.map((s, i) => ({ id: SEAT_IDS[i], label: seatLabel(s), ref: s.ref, role: s.role, effort: s.effort, rounds: {} })),
    modText: '',
    modState: 'waiting',
    result: null,
    stopped: false,
    done: false,
    error: '',
    clock: '',
    open: {},
  };
}

// A saved council message, in the same shape the live card builds up.
function councilFromSaved(m) {
  const c = m.council ?? {};
  const seats = (c.seats ?? []).map(s => {
    const rounds = {};
    // The server saves one roundN key for each round a seat ran (server.mjs, seat-done). Every one is read, not only rounds 1 and 2 (B-31).
    const ran = Object.keys(s).map(k => /^round(\d+)$/.exec(k)).filter(Boolean).map(x => Number(x[1])).sort((a, b) => a - b);
    for (const r of ran) {
      const text = s[`round${r}`];
      // An empty text is a round that gave no answer (it failed, see below), so it is not shown as done (B-15).
      if (typeof text === 'string' && text) rounds[r] = { text, state: 'done', ...seatMeta(text) };
    }
    if (s.error) {
      // A failed seat never runs a later round, so the error belongs to the last round it saved (B-15).
      const r = ran.length ? ran[ran.length - 1] : 1;
      rounds[r] = { ...(rounds[r] ?? {}), text: rounds[r]?.text ?? '', state: 'failed', error: s.error };
    }
    return { id: s.id, label: s.label, ref: s.ref ?? '', role: s.role, effort: s.effort, rounds };
  });
  return {
    question: c.question ?? '',
    // The count comes from what was saved: a council stopped after round 2 of 3 shows 2, a full three-round run shows 3 (B-31).
    rounds: Math.max(1, ...seats.flatMap(s => Object.keys(s.rounds).map(Number))),
    seats,
    mod: null,
    modText: '',
    modState: c.result ? 'done' : 'waiting',
    result: c.result ?? null,
    stopped: !c.result,
    done: true,
    error: '',
    clock: '',
    open: {},
  };
}

// Turns the council's events into the card's data; each change asks for a redraw.
function councilHandler(cd, paint) {
  const seat = id => cd.seats.find(s => s.id === id);
  return ev => {
    switch (ev.type) {
      case 'council-start':
        cd.seats = ev.seats.map(s => ({ id: s.id, label: s.label, ref: s.ref, role: s.role, effort: s.effort, rounds: {} }));
        cd.rounds = ev.rounds ?? cd.rounds;
        cd.mod = ev.moderator ? { label: ev.moderator.label, ref: ev.moderator.ref } : cd.mod;
        cue('start');
        break;
      case 'seat-start': {
        const s = seat(ev.seat);
        if (!s) break;
        s.rounds[ev.round] = { text: '', state: 'running' };
        // Round 2 opens as it starts; round 1 folds away so the answers stay in view.
        if (ev.round === 2) cd.open[`${s.id}1`] = false;
        break;
      }
      case 'seat-delta': {
        const r = seat(ev.seat)?.rounds[ev.round];
        if (r) r.text += ev.text ?? '';
        break;
      }
      case 'seat-done': {
        const s = seat(ev.seat);
        if (!s) break;
        const text = ev.text ?? s.rounds[ev.round]?.text ?? '';
        s.rounds[ev.round] = { ...seatMeta(text), ...(ev.parsed ?? {}), text, state: ev.ok ? 'done' : 'failed', error: ev.error };
        break;
      }
      case 'consensus-start':
        cd.mod = ev.moderator ? { label: ev.moderator.label, ref: ev.moderator.ref } : cd.mod;
        cd.modState = 'running';
        break;
      case 'consensus-delta':
        cd.modText += ev.text ?? '';
        break;
      case 'consensus':
        cd.result = ev.result;
        cd.modState = 'done';
        break;
      case 'council-done':
        cd.done = true;
        cd.stopped = Boolean(ev.aborted) && !cd.result;
        cue('done');
        break;
      case 'error':
        cd.error = ev.message;
        notes.push(`Error: ${ev.message}`);
        cue('error');
        break;
      case 'done':
        if (ev.timedOut) notes.push('The council ran out of time and was stopped.');
        break;
      default:
        break;
    }
    paint();
  };
}

// The whole council card: the seat columns, the consensus, and a slot where a plan and a build go.
function councilEl(cd, fresh = false) {
  const article = document.createElement('article');
  article.className = fresh ? 'turn council fresh' : 'turn council';
  const head = document.createElement('div');
  head.className = 'council-head';
  head.append(icon('layers'), span('council-title', 'Council'), span('council-meta', `${cd.rounds} ${cd.rounds === 1 ? 'round' : 'rounds'}`));
  if (!cd.done) head.append(span('council-timer', cd.clock ? `Working · ${cd.clock}` : 'Working'));
  const q = document.createElement('p');
  q.className = 'council-q';
  q.textContent = cd.question;
  const cols = document.createElement('div');
  cols.className = 'council-cols';
  cols.style.setProperty('--seat-count', String(Math.max(1, cd.seats.length)));
  for (const s of cd.seats) cols.append(seatColEl(cd, s));
  const slot = document.createElement('div');
  slot.className = 'council-slot';
  article.append(head, q, cols);
  if (cd.error) article.append(quietNote(cd.error, 'council-err'));
  const cons = consensusEl(cd, slot);
  if (cons) article.append(cons);
  article.append(slot);
  return article;
}

function seatColEl(cd, s) {
  const col = document.createElement('section');
  col.className = 'seat-col';
  col.dataset.p = providerOf(s.ref);
  const head = document.createElement('header');
  head.className = 'seat-col-head';
  head.append(span('sc-name', s.label));
  const latest = [3, 2, 1].map(r => s.rounds[r]).find(r => r && r.confidence != null);
  if (latest) {
    const conf = span('sc-conf', `Confidence ${latest.confidence}`);
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = latest.confidence;
    bar.setAttribute('aria-label', `Confidence ${latest.confidence} of 100`);
    conf.append(bar);
    head.append(conf);
  }
  col.append(head);
  for (let r = 1; r <= cd.rounds; r++) col.append(roundEl(cd, s, r));
  return col;
}

function roundEl(cd, s, r) {
  const data = s.rounds[r] ?? { state: 'waiting', text: '' };
  const d = document.createElement('details');
  d.className = `round ${data.state}`;
  // Round 1 opens until round 2 starts; round 2 opens as it starts. A choice made by hand is kept.
  trackOpen(cd.open, `${s.id}${r}`, d, r === 1 ? !s.rounds[2] : true);
  const sum = document.createElement('summary');
  const words = { waiting: 'Waiting', running: 'Working', done: 'Done', failed: 'Failed' };
  let label = words[data.state] ?? '';
  if (data.state === 'done' && r > 1 && data.changed) label = data.changed === 'yes' ? 'Changed its view' : 'Kept its view';
  sum.append(span('round-name', `Round ${r}`), span('round-state', label));
  d.append(sum);
  const body = document.createElement('div');
  body.className = 'turn-body round-body';
  if (data.state === 'failed') {
    body.append(span('seat-err', data.error || 'This seat failed.'));
  } else if (data.state === 'waiting') {
    body.append(span('round-wait', r === 1 ? 'Waiting to start' : 'Waiting for round 1 to finish'));
  } else if (!data.text) {
    body.innerHTML = THINKING;
  } else {
    body.innerHTML = md(seatAnswer(data.text));
    if (data.position) {
      const pos = document.createElement('p');
      pos.className = 'seat-pos';
      pos.textContent = data.position;
      body.prepend(pos);
    }
  }
  d.append(body);
  return d;
}

// The consensus card. It stays hidden until the moderator has started, and shows the raw text if the layout did not parse.
function consensusEl(cd, slot) {
  if (!cd.result && cd.modState === 'waiting' && !cd.stopped) return null;
  const box = document.createElement('section');
  box.className = 'consensus';
  const top = document.createElement('div');
  top.className = 'consensus-top';
  top.append(span('kicker', 'Consensus'));
  if (cd.mod) top.append(span('consensus-by', `Moderator · ${cd.mod.label}`));
  box.append(top);
  if (!cd.result) {
    if (cd.modText) box.append(preEl('raw-stream', cd.modText));
    else if (!cd.stopped) {
      const wait = document.createElement('div');
      wait.innerHTML = THINKING;
      box.append(wait);
    }
    if (cd.stopped) box.append(quietNote('Stopped before the consensus.'));
    return box;
  }
  const r = cd.result;
  if (!r.complete) {
    box.append(quietNote('The moderator did not use the usual layout. This is its full reply.'), preEl('raw-full', r.verdict ?? ''));
    return box;
  }
  const verdict = document.createElement('div');
  verdict.className = 'verdict';
  verdict.innerHTML = md(r.verdict ?? '');
  box.append(verdict);
  if (r.consensus?.length) box.append(consensusList(r.consensus));
  if (r.disagreements?.length) box.append(disagreementList(cd, r.disagreements));
  if (r.recommendation?.length) box.append(recommendationBlock(cd, r.recommendation, slot));
  if (r.confidence) box.append(confidenceRow(r.confidence));
  if (r.dissent?.length) box.append(dissentBlock(r.dissent));
  return box;
}

function consensusList(items) {
  const wrap = document.createElement('div');
  wrap.append(capEl('Consensus'));
  const ul = document.createElement('ul');
  ul.className = 'checks';
  for (const t of items) ul.append(Object.assign(document.createElement('li'), { textContent: t }));
  wrap.append(ul);
  return wrap;
}

function disagreementList(cd, items) {
  const wrap = document.createElement('div');
  wrap.append(capEl('Disagreements'));
  const list = document.createElement('div');
  list.className = 'dis-list';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'dis';
    d.append(span('dis-topic', it.topic ?? ''));
    for (const v of it.views ?? []) {
      const s = cd.seats.find(x => x.id === v.seat);
      const line = document.createElement('div');
      line.className = 'dis-view';
      line.dataset.p = providerOf(s?.ref);
      line.append(span('dis-dot', ''), Object.assign(document.createElement('b'), { textContent: v.label || s?.label || v.seat }), span('', v.view ?? ''));
      d.append(line);
    }
    if (it.settle) d.append(quietNote(`How to settle it: ${it.settle}`, 'dis-settle'));
    list.append(d);
  }
  wrap.append(list);
  return wrap;
}

function recommendationBlock(cd, steps, slot) {
  const row = document.createElement('div');
  row.className = 'rec-row';
  const main = document.createElement('div');
  main.className = 'rec-main';
  main.append(capEl('Recommendation'));
  const ol = document.createElement('ol');
  ol.className = 'steps';
  for (const s of steps) ol.append(Object.assign(document.createElement('li'), { textContent: s }));
  main.append(ol);
  const btn = button('primary small build-this', 'Build this');
  btn.title = 'Turn these steps into tasks you can edit, then run them';
  btn.addEventListener('click', () => openPlan(cd, slot, btn));
  row.append(main, btn);
  return row;
}

function confidenceRow({ value, why }) {
  const row = document.createElement('div');
  row.className = 'conf';
  const shown = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Math.round(Number(value)))) : null;
  row.append(span('conf-value', shown == null ? 'Confidence not given' : `Confidence ${shown} / 100`));
  if (shown != null) {
    const meter = document.createElement('div');
    meter.className = 'meter';
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = shown;
    bar.setAttribute('aria-label', `Confidence ${shown} of 100`);
    meter.append(bar);
    row.append(meter);
  }
  if (why) row.append(span('conf-why', why));
  return row;
}

function dissentBlock(items) {
  const box = document.createElement('div');
  box.className = 'dissent';
  box.append(capEl('Dissent'));
  for (const it of items) {
    const p = document.createElement('p');
    p.append(Object.assign(document.createElement('b'), { textContent: `${it.label ?? it.seat}: ` }), it.view ?? '');
    box.append(p);
  }
  return box;
}

// The plan panel: the recommendation as tasks, editable, before anything runs.
async function openPlan(cd, slot, btn) {
  if (busyNow()) return toast('This project is already running. Use /cancel first.', 'bad');
  const recommendation = (cd.result?.recommendation ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  const wait = document.createElement('p');
  wait.className = 'plan-wait';
  wait.append(span('spinner'), 'Turning the recommendation into tasks…');
  slot.append(wait);
  btn.disabled = true;
  try {
    const data = await api('/api/plan', { project: S.activeProject, goal: cd.question, recommendation });
    if (data.error) throw new Error(data.error);
    const tasks = (data.tasks ?? []).map(normalizeTask);
    if (!tasks.length) throw new Error('The planner returned no tasks. Try again, or ask the council a narrower question.');
    slot.append(planPanel(cd, slot, tasks));
    slot.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    wait.remove();
    btn.disabled = false;
  }
}

function normalizeTask(t) {
  return {
    id: String(t.id ?? ''),
    title: String(t.title ?? ''),
    instructions: String(t.instructions ?? ''),
    scope: Array.isArray(t.scope) ? t.scope.map(String) : [],
    depends: Array.isArray(t.depends) ? t.depends.map(String) : [],
    coder: t.coder || DEFAULT_CODER,
    effort: t.effort || 'high',
  };
}

function normScope(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// Two scopes overlap when one equals the other or lies inside it; the empty scope is the whole project.
function scopesOverlap(a = [], b = []) {
  return a.some(x => b.some(y => {
    const p = normScope(x);
    const q = normScope(y);
    if (!p || !q || p === '.' || q === '.') return true;
    return p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
  }));
}

function coderOptions(select, ref) {
  const list = CODERS.some(c => c.ref === ref) ? CODERS : [...CODERS, { ref, label: ref }];
  select.replaceChildren(...list.map(c => new Option(c.note ? `${c.label} (${c.note})` : c.label, c.ref)));
  select.value = ref;
}

function planPanel(cd, slot, tasks) {
  const panel = document.createElement('section');
  panel.className = 'plan fresh';
  const head = document.createElement('div');
  head.className = 'plan-head';
  head.append(span('kicker', 'Build plan'), span('plan-note', 'Change titles, coders, scope or instructions. Nothing runs until you press Run.'));
  const list = document.createElement('div');
  list.className = 'plan-list';
  for (const t of tasks) list.append(taskEditor(t));
  const foot = document.createElement('div');
  foot.className = 'plan-foot';
  const run = button('primary small', `Run ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`);
  run.addEventListener('click', () => {
    const bad = tasks.find(t => !t.title.trim() || !t.scope.length);
    if (bad) return toast(`Task ${bad.id} needs a title and at least one scope path.`, 'bad');
    panel.remove();
    runBuild(cd, slot, tasks);
  });
  const cancel = button('ghost small', 'Cancel');
  cancel.addEventListener('click', () => panel.remove());
  foot.append(run, cancel);
  panel.append(head, list, foot);
  // The delegation strip sits above Run: pressing Run lets coders change files in the scopes shown (delegation).
  window.MuseUI?.notice?.('delegation', { before: foot });
  return panel;
}

function taskEditor(t) {
  const row = document.createElement('div');
  row.className = 'plan-task';
  const top = document.createElement('div');
  top.className = 'pt-top';
  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'pt-title';
  title.value = t.title;
  title.placeholder = 'Task title';
  title.setAttribute('aria-label', `Title of ${t.id}`);
  title.addEventListener('input', () => { t.title = title.value; });
  const coder = document.createElement('select');
  coder.className = 'plain-select pt-coder';
  coder.setAttribute('aria-label', `Coder for ${t.id}`);
  coderOptions(coder, t.coder);
  const gem = quietNote(GEMINI_EDIT, 'pt-note');
  const markGemini = () => {
    const isGemini = t.coder.startsWith('gemini:');
    gem.hidden = !isGemini;
    coder.title = isGemini ? GEMINI_EDIT : '';
  };
  coder.addEventListener('change', () => { t.coder = coder.value; markGemini(); });
  markGemini();
  top.append(span('pt-id', t.id), title, coder);
  const line = document.createElement('div');
  line.className = 'pt-line';
  const dep = document.createElement('input');
  dep.type = 'text';
  dep.className = 'pt-dep';
  dep.value = t.depends.join(', ');
  dep.placeholder = 'none';
  dep.setAttribute('aria-label', `Depends on, for ${t.id}`);
  dep.addEventListener('change', () => { t.depends = dep.value.split(/[\s,]+/).filter(Boolean); });
  line.append(span('', 'Depends on'), dep);
  const instr = document.createElement('details');
  instr.className = 'pt-instr';
  const sum = document.createElement('summary');
  sum.textContent = 'Instructions';
  const area = document.createElement('textarea');
  area.value = t.instructions;
  area.setAttribute('aria-label', `Instructions for ${t.id}`);
  area.addEventListener('input', () => { t.instructions = area.value; });
  instr.append(sum, area);
  row.append(top, scopeChips(t), line, gem, instr);
  return row;
}

// The scope as chips: each path can be removed, and a new one is added with Enter.
function scopeChips(t) {
  const box = document.createElement('div');
  box.className = 'chips';
  const paint = focusAdd => {
    const chips = t.scope.map((p, k) => {
      const c = span('chip', p);
      const x = button('chip-x', '');
      x.append(icon('x'));
      x.title = `Remove ${p}`;
      x.setAttribute('aria-label', `Remove ${p} from ${t.id}`);
      x.addEventListener('click', () => { t.scope.splice(k, 1); paint(false); });
      c.append(x);
      return c;
    });
    const add = document.createElement('input');
    add.type = 'text';
    add.className = 'chip-add';
    add.placeholder = t.scope.length ? 'Add a path, then Enter' : 'Add a folder or file, then Enter';
    add.setAttribute('aria-label', `Add a scope path for ${t.id}`);
    add.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const p = normScope(add.value);
      if (p && !t.scope.includes(p)) {
        t.scope.push(p);
        paint(true);
      }
    });
    box.replaceChildren(...chips, add);
    if (focusAdd) add.focus();
  };
  paint(false);
  return box;
}

// Runs a plan: the build streams into the card, and the review follows it.
async function runBuild(cd, slot, tasks) {
  if (busyNow()) return toast('This project is already running. Use /cancel first.', 'bad');
  const payload = tasks.map(t => ({ id: t.id, title: t.title.trim(), instructions: t.instructions, scope: t.scope, depends: t.depends, coder: t.coder, effort: t.effort }));
  const run = {
    goal: cd.question,
    tasks: payload.map(t => ({ ...t, state: 'waiting', started: false, summary: '', changed: [], outOfScope: [], steps: [] })),
    steps: [],
    approvals: [],
    review: null,
    reviewing: null,
    reviewText: '',
    done: false,
    aborted: false,
    error: '',
    clock: '',
    open: {},
  };
  let live = buildEl(run, true);
  slot.append(live);
  live.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  let queued = false;
  const paint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!live.isConnected) return;
      const next = buildEl(run);
      replaceKeepingFocus(live, next);
      live = next;
      stickBottom();
    });
  };
  notes = [];
  cue('start');
  await runStream('/api/build', { project: S.activeProject, goal: cd.question, tasks: payload }, buildHandler(run, paint), {
    tick: (secs, time) => {
      run.clock = time;
      const t = el.chat.querySelector('.build-timer');
      if (t) t.textContent = `Working · ${time}`;
    },
  });
}

function buildHandler(run, paint) {
  const byId = id => run.tasks.find(t => t.id === id);
  const findStep = id => [...run.tasks.flatMap(t => t.steps), ...run.steps].find(s => s.id === id);
  return ev => {
    switch (ev.type) {
      case 'build-start':
        run.tasks = ev.tasks.map(t => ({ state: 'waiting', started: false, summary: '', changed: [], outOfScope: [], steps: [], ...t }));
        break;
      case 'task-start': {
        const t = byId(ev.id);
        if (t) {
          t.state = 'running';
          t.started = true;
        }
        break;
      }
      case 'tool': {
        const step = { id: ev.id, name: ev.name, summary: ev.summary, state: 'running', result: '' };
        const host = byId(ev.parent);
        (host ? host.steps : run.steps).push(step);
        break;
      }
      case 'tool_result': {
        const s = findStep(ev.id);
        if (s) {
          s.state = ev.ok ? 'done' : 'failed';
          s.result = ev.summary ?? '';
        }
        break;
      }
      case 'task-done': {
        const t = byId(ev.id);
        if (t) {
          t.state = ev.ok ? 'done' : (t.started ? 'failed' : 'skipped');
          t.summary = ev.ok ? (ev.summary ?? '') : (ev.error || ev.summary || '');
          t.changed = ev.changed ?? [];
          t.outOfScope = ev.outOfScope ?? [];
        }
        break;
      }
      case 'approval': {
        const a = { ...ev };
        a.onDone = () => {
          run.approvals = run.approvals.filter(x => x !== a);
          paint();
        };
        // Show all asks for the card to be built again, so its text reaches the card that is on the page (see approvalEl).
        a.onChange = paint;
        run.approvals.push(a);
        cue('approval');
        break;
      }
      case 'review-start':
        run.reviewing = ev.reviewer?.label ?? 'the reviewer';
        run.reviewText = '';
        break;
      case 'review-delta':
        run.reviewText += ev.text ?? '';
        break;
      case 'review':
        run.review = ev.result;
        run.reviewing = null;
        break;
      case 'build-done':
        run.done = true;
        run.aborted = Boolean(ev.aborted);
        if (run.aborted) {
          for (const t of run.tasks) if (t.state === 'running' || t.state === 'waiting') t.state = 'stopped';
        }
        cue('done');
        break;
      case 'error':
        run.error = ev.message;
        notes.push(`Error: ${ev.message}`);
        cue('error');
        break;
      case 'done':
        if (ev.timedOut) notes.push('The build ran out of time and was stopped.');
        break;
      default:
        break;
    }
    paint();
  };
}

// A build run: the task rows, their steps, approvals and the review. Used live and from the saved transcript.
function buildEl(run, fresh = false) {
  const box = document.createElement('section');
  box.className = fresh ? 'build-run fresh' : 'build-run';
  const head = document.createElement('div');
  head.className = 'build-head';
  head.append(icon('terminal'), span('kicker', 'Build'), span('build-goal', run.goal || 'the agreed plan'));
  if (!run.done) head.append(span('build-timer', run.clock ? `Working · ${run.clock}` : 'Working'));
  box.append(head);
  const list = document.createElement('ol');
  list.className = 'build-tasks';
  for (const t of run.tasks) list.append(taskRowEl(run, t));
  box.append(list);
  if (run.steps.length) {
    const loose = document.createElement('div');
    loose.className = 'bt-steps';
    for (const s of run.steps) loose.append(stepEl(run, s));
    box.append(loose);
  }
  for (const a of run.approvals) {
    const card = approvalEl(a, { reason: false });
    card.classList.remove('fresh');
    box.append(card);
  }
  if (run.reviewing) {
    const wait = document.createElement('section');
    wait.className = 'build-review review-wait';
    const h = document.createElement('div');
    h.className = 'review-head';
    h.append(span('kicker', `Review · ${run.reviewing}`), span('spinner'));
    wait.append(h);
    if (run.reviewText) wait.append(preEl('raw-stream', run.reviewText));
    box.append(wait);
  }
  if (run.review) box.append(reviewEl(run.review));
  if (run.error) box.append(quietNote(run.error, 'council-err'));
  if (run.aborted) box.append(quietNote('Stopped before the build finished.'));
  return box;
}

function taskRowEl(run, t) {
  const li = document.createElement('li');
  li.className = `btask ${t.state}`;
  const top = document.createElement('div');
  top.className = 'bt-top';
  const st = span('bt-state');
  const nodes = stateNodes(t.state);
  st.append(...(nodes.length ? nodes : [STATE_WORDS[t.state] ?? '']));
  top.append(st, span('bt-title', `${t.id} · ${t.title}`), span('bt-coder', coderLabel(t.coder)));
  li.append(top);
  if (t.scope?.length) li.append(span('bt-scope', t.scope.join(', ')));
  const wait = waitNote(run, t);
  if (wait) li.append(span('bt-note', wait));
  if (t.summary) li.append(Object.assign(document.createElement('p'), { className: 'bt-summary', textContent: t.summary }));
  if (t.outOfScope?.length) li.append(span('bt-warn', `Changed outside its scope: ${t.outOfScope.join(', ')}`));
  if (t.steps?.length) {
    const steps = document.createElement('div');
    steps.className = 'bt-steps';
    for (const s of t.steps) steps.append(stepEl(run, s));
    li.append(steps);
  }
  return li;
}

function stepEl(run, s) {
  const d = toolEl(s.name, s.summary, s.state, s.result);
  return trackOpen(run.open, `s:${s.id}`, d, false);
}

function coderLabel(ref) {
  return CODERS.find(c => c.ref === ref)?.label ?? ref ?? '';
}

// Why a task has not started: a dependency that is not finished, or a running task whose scope overlaps.
function waitNote(run, t) {
  if (t.state !== 'waiting') return '';
  const dep = (t.depends ?? []).map(id => run.tasks.find(x => x.id === id)).find(d => d && d.state !== 'done');
  if (dep) return `waiting for ${dep.title || dep.id}`;
  const blocker = run.tasks.find(x => x !== t && x.state === 'running' && scopesOverlap(x.scope, t.scope));
  return blocker ? `waiting for ${blocker.title || blocker.id} (scope overlap)` : '';
}

function reviewEl(review) {
  const box = document.createElement('section');
  box.className = 'build-review';
  const ok = review.verdict === 'approve';
  const head = document.createElement('div');
  head.className = 'review-head';
  head.append(span('kicker', 'Review'), span(`pill ${ok ? 'ok' : 'warn'}`, ok ? 'Approve' : 'Changes'));
  box.append(head);
  if (review.summary) box.append(Object.assign(document.createElement('p'), { className: 'bt-summary', textContent: review.summary }));
  if (review.items?.length) {
    const ul = document.createElement('ul');
    ul.className = 'review-items';
    for (const it of review.items) {
      const sev = String(it.severity ?? 'note').toLowerCase();
      const li = document.createElement('li');
      li.append(span(`sev sev-${sev}`, sev), span('ri-file', it.file ?? ''), span('ri-issue', it.issue ?? ''));
      ul.append(li);
    }
    box.append(ul);
  }
  return box;
}

// A saved build message, in the same shape the live run builds up.
function buildFromSaved(m) {
  const b = m.build ?? {};
  const results = b.results ?? {};
  const listed = b.tasks ?? Object.keys(results).map(id => ({ id, title: id, scope: [], depends: [], coder: '' }));
  return {
    goal: b.goal ?? '',
    tasks: listed.map(t => {
      const r = results[t.id];
      return {
        ...t,
        state: r ? (r.ok ? 'done' : 'failed') : 'skipped',
        started: Boolean(r),
        summary: r ? (r.ok ? (r.summary ?? '') : (r.error || r.summary || '')) : '',
        changed: r?.changed ?? [],
        outOfScope: r?.outOfScope ?? [],
        steps: [],
      };
    }),
    steps: [],
    approvals: [],
    review: b.review ?? null,
    reviewing: null,
    reviewText: '',
    done: true,
    aborted: false,
    error: '',
    clock: '',
    open: {},
  };
}

// /build: plans the last council recommendation that is on screen.
function buildLast() {
  const plan = [...el.chat.querySelectorAll('.build-this')].at(-1);
  if (!plan) return toast('Run /council first. Its recommendation is what /build plans.', 'bad');
  plan.scrollIntoView({ block: 'center' });
  plan.click();
}

async function askCouncil(question) {
  const text = question.trim();
  if (!S.activeProject) {
    openAddForm();
    return toast('Add a project folder first.', 'bad');
  }
  if (busyNow()) return toast('This project is already running. Use /cancel first.', 'bad');
  if (!text) return toast('Type a question for the council. Example: /council Should we cache the price feed?', 'bad');
  const config = S.council ?? DEFAULT_COUNCIL;
  notes = [];
  S.messages.push({ role: 'user', kind: 'council', content: text, ts: Date.now() });
  renderChat();
  const cd = liveCouncil(text, config);
  let live = councilEl(cd, true);
  runBox().append(live);
  live.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  let queued = false;
  const paint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!live.isConnected) return;
      const next = councilEl(cd);
      replaceKeepingFocus(live, next);
      live = next;
      stickBottom();
    });
  };
  await runStream('/api/council', { project: S.activeProject, question: text, config }, councilHandler(cd, paint), {
    tick: (secs, time) => {
      cd.clock = time;
      const t = el.chat.querySelector('.council-timer');
      if (t) t.textContent = `Working · ${time}`;
    },
  });
}

// ---------- council board, above the composer ----------

function setMode(next) {
  mode = next;
  // The board takes room from the transcript: a transcript that was at its end stays at its end.
  const atEnd = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 80;
  renderBoard();
  if (atEnd) el.chat.scrollTop = el.chat.scrollHeight;
  // Council takes its first strip above the board in a launch (multi-provider): every seat is asked, so the spend and the providers say so.
  if (next === 'council') window.MuseUI?.notice?.('multi-provider', { before: el.board });
}

function renderBoard() {
  const council = mode === 'council';
  el.board.hidden = !council;
  el.boardSummary.hidden = !council;
  for (const b of el.modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  el.hint.textContent = busyNow() ? BUSY_HINT : idleHint();
  const cfg = S.council ?? DEFAULT_COUNCIL;
  el.roundsSel.value = String(cfg.rounds);
  if (!council) return;
  if (boardPills.length !== cfg.seats.length + 1) {
    boardPills = [...cfg.seats.map((_, i) => seatPill(i)), moderatorPill()];
    el.boardSeats.replaceChildren(...boardPills.map(p => p.root));
  }
  for (const p of boardPills) p.sync(cfg);
  el.boardSummary.replaceChildren(icon('layers'), span('', summaryText(cfg)), icon('chevron'));
}

function summaryText(cfg) {
  const seats = cfg.seats.map((s, i) => `${SEAT_IDS[i].toUpperCase()} ${modelName(s.ref)} · ${ROLE_LABELS[s.role] ?? s.role}`).join('  ·  ');
  return `Council: ${seats} · Moderator ${modelName(cfg.moderator?.ref)} · ${cfg.rounds} ${cfg.rounds === 1 ? 'round' : 'rounds'}`;
}

// A menu chip with a select inside it, styled like the composer's menus.
function pickSelect(cls, title, aria) {
  const pickEl = document.createElement('label');
  pickEl.className = `pick ${cls}`;
  pickEl.title = title;
  const select = document.createElement('select');
  select.setAttribute('aria-label', aria);
  pickEl.append(select);
  pickable(pickEl);
  return { pickEl, select };
}

function seatPill(index) {
  const L = SEAT_IDS[index].toUpperCase();
  const root = document.createElement('div');
  root.className = 'seat';
  const role = document.createElement('select');
  role.className = 'plain-select';
  role.setAttribute('aria-label', `Role of seat ${L}`);
  for (const [key, name] of Object.entries(ROLE_LABELS)) role.append(new Option(name, key));
  role.addEventListener('change', () => editSeat(index, 'role', role.value));
  const model = pickSelect('seat-model', 'The model for this seat', `Model of seat ${L}`);
  fillModels(model.select, false);
  model.select.addEventListener('change', () => editSeat(index, 'ref', model.select.value));
  const effort = pickSelect('seat-effort', 'How hard this seat thinks', `Effort of seat ${L}`);
  effort.select.replaceChildren(...menuHead(), ...effortOptions());
  effort.select.addEventListener('change', () => editSeat(index, 'effort', effort.select.value));
  const sess = span('seat-sess', '');
  const head = document.createElement('div');
  head.className = 'seat-head';
  head.append(span('seat-letter', L), role);
  const foot = document.createElement('div');
  foot.className = 'seat-foot';
  foot.append(effort.pickEl, sess);
  root.append(head, model.pickEl, foot);
  return {
    root,
    sync(cfg) {
      const s = cfg.seats[index] ?? {};
      const gemini = providerOf(s.ref) === 'gemini';
      root.dataset.p = providerOf(s.ref);
      role.value = s.role;
      ensureOption(model.select, s.ref);
      model.select.value = s.ref;
      model.pickEl.title = gemini ? GEMINI_EDIT : 'The model for this seat';
      effort.select.value = s.effort ?? 'high';
      effort.select.disabled = gemini;
      effort.select.title = gemini ? GEMINI_EFFORT : '';
      effort.pickEl.title = gemini ? GEMINI_EFFORT : 'How hard this seat thinks';
      sess.textContent = `Sessions: ${(s.sessions ?? S.sessions) === 'native' ? 'Native' : 'Transcript'}`;
      sess.title = 'How this seat keeps the chat: Native uses the provider\'s own session; Transcript sends the chat again each time';
    },
  };
}

function moderatorPill() {
  const root = document.createElement('div');
  root.className = 'seat mod';
  const model = pickSelect('seat-model', 'The model that reads every seat and writes the verdict', 'Moderator model');
  fillModels(model.select, false);
  model.select.addEventListener('change', () => editMod('ref', model.select.value));
  const effort = pickSelect('seat-effort', 'How hard the moderator thinks', 'Moderator effort');
  effort.select.replaceChildren(...menuHead(), ...effortOptions());
  effort.select.addEventListener('change', () => editMod('effort', effort.select.value));
  const head = document.createElement('div');
  head.className = 'seat-head';
  head.append(span('seat-letter', 'M'), span('seat-role-static', 'Moderator'));
  const foot = document.createElement('div');
  foot.className = 'seat-foot';
  foot.append(effort.pickEl);
  root.append(head, model.pickEl, foot);
  return {
    root,
    sync(cfg) {
      const m = cfg.moderator ?? {};
      root.dataset.p = providerOf(m.ref);
      ensureOption(model.select, m.ref);
      model.select.value = m.ref ?? '';
      effort.select.value = m.effort ?? 'high';
      const gemini = providerOf(m.ref) === 'gemini';
      effort.select.disabled = gemini;
      effort.select.title = gemini ? GEMINI_EFFORT : '';
    },
  };
}

async function editSeat(index, field, value) {
  const cfg = JSON.parse(JSON.stringify(S.council ?? DEFAULT_COUNCIL));
  cfg.seats[index][field] = value;
  await saveCouncil(cfg);
}

async function editMod(field, value) {
  const cfg = JSON.parse(JSON.stringify(S.council ?? DEFAULT_COUNCIL));
  cfg.moderator = { ...(cfg.moderator ?? {}), [field]: value };
  await saveCouncil(cfg);
}

async function editRounds(value) {
  const cfg = JSON.parse(JSON.stringify(S.council ?? DEFAULT_COUNCIL));
  cfg.rounds = Number(value);
  await saveCouncil(cfg);
}

// Saves the council, then shows the saved config. The server checks it and says why when it is wrong.
async function saveCouncil(cfg) {
  try {
    S = await api('/api/settings', { council: cfg });
  } catch (err) {
    toast(err.message, 'bad');
  }
  renderBoard();
  if (drawerRender === renderCouncilDrawer) refreshDrawer();
}

function openCouncilDrawer() {
  openDrawer('Council', renderCouncilDrawer);
}

// The council controls in a panel, for narrow windows where the board is a single line.
function renderCouncilDrawer(body) {
  const cfg = S.council ?? DEFAULT_COUNCIL;
  body.append(para('Each seat is one model with a role. The moderator reads every seat and writes the verdict.'));
  const seats = document.createElement('div');
  seats.className = 'board-seats drawer-seats';
  const pills = [...cfg.seats.map((_, i) => seatPill(i)), moderatorPill()];
  for (const p of pills) p.sync(cfg);
  seats.replaceChildren(...pills.map(p => p.root));
  body.append(seats);
  const rounds = document.createElement('select');
  rounds.setAttribute('aria-label', 'Rounds');
  for (const n of [1, 2, 3]) rounds.append(new Option(`${n} ${n === 1 ? 'round' : 'rounds'}`, String(n)));
  rounds.value = String(cfg.rounds);
  rounds.addEventListener('change', () => editRounds(rounds.value));
  body.append(fieldRow('Rounds', rounds, 'One round means no critique. Two or three let the seats answer each other.'));
  const relayBtn = button('ghost small', 'Relay route…');
  relayBtn.addEventListener('click', () => openDrawer('Relay route', renderRelayPanel));
  const logBtn = button('ghost small', 'Relay log');
  logBtn.addEventListener('click', () => openDrawer('Relay log', renderRelayLog));
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(relayBtn, logBtn);
  body.append(actions);
}

// ---------- relay: the route panel, the route bar and the log ----------

function relaySettings() {
  return { ...RELAY_DEFAULTS, ...(S.relay ?? {}) };
}

function latestSeatId(seats) {
  for (let i = S.messages.length - 1; i >= 0; i--) {
    const m = S.messages[i];
    if (m.role === 'assistant' && (!m.kind || m.kind === 'chat')) {
      const seat = seatOfReply(m);
      if (seat && seats.some(s => s.id === seat.id)) return seat.id;
    }
  }
  return null;
}

function relayDraftFor(seats) {
  routeDraft ??= { from: latestSeatId(seats) ?? seats[0]?.id ?? 'a', kind: 'chain', targets: [] };
  if (!seats.some(s => s.id === routeDraft.from)) routeDraft.from = seats[0]?.id ?? 'a';
  routeDraft.targets = routeDraft.targets.filter((id, i, all) => id !== routeDraft.from && seats.some(s => s.id === id) && all.indexOf(id) === i);
  return routeDraft;
}

function fieldRow(label, control, note = '') {
  const row = document.createElement('div');
  row.className = 'field';
  row.append(span('field-label', label), control);
  if (note) row.append(span('field-note', note));
  return row;
}

function switchRow(label, desc, checked, onChange) {
  const row = document.createElement('label');
  row.className = 'switch-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  const track = span('switch-track');
  track.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.append(label);
  if (desc) text.append(Object.assign(document.createElement('small'), { textContent: desc }));
  row.append(input, track, text);
  return row;
}

async function saveRelay(patch) {
  try {
    S = await api('/api/settings', { relay: { ...relaySettings(), ...patch } });
  } catch (err) {
    toast(err.message, 'bad');
  }
  if (drawerRender === renderRelayPanel) refreshDrawer();
}

// The chain editor: each step is a seat, in order, and no seat appears twice.
function chainEditor(d, seats) {
  const box = document.createElement('div');
  box.className = 'chain';
  const others = seats.filter(s => s.id !== d.from);
  d.targets.forEach((id, i) => {
    const row = document.createElement('div');
    row.className = 'chain-step';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Step ${i + 1}`);
    for (const s of others) if (s.id === id || !d.targets.includes(s.id)) sel.append(new Option(s.label, s.id));
    sel.value = id;
    sel.addEventListener('change', () => { d.targets[i] = sel.value; refreshDrawer(); });
    const up = button('ghost small', '↑');
    up.disabled = i === 0;
    up.setAttribute('aria-label', `Move step ${i + 1} up`);
    up.addEventListener('click', () => { [d.targets[i - 1], d.targets[i]] = [d.targets[i], d.targets[i - 1]]; refreshDrawer(); });
    const down = button('ghost small', '↓');
    down.disabled = i === d.targets.length - 1;
    down.setAttribute('aria-label', `Move step ${i + 1} down`);
    down.addEventListener('click', () => { [d.targets[i + 1], d.targets[i]] = [d.targets[i], d.targets[i + 1]]; refreshDrawer(); });
    const rm = button('icon-btn', '');
    rm.append(icon('x'));
    rm.setAttribute('aria-label', `Remove step ${i + 1}`);
    rm.addEventListener('click', () => { d.targets.splice(i, 1); refreshDrawer(); });
    row.append(span('chain-n', String(i + 1)), sel, up, down, rm);
    box.append(row);
  });
  const free = others.filter(s => !d.targets.includes(s.id));
  const add = button('ghost small chain-add', 'Add a step');
  add.disabled = !free.length;
  add.addEventListener('click', () => { d.targets.push(free[0].id); refreshDrawer(); });
  box.append(add);
  return box;
}

function renderRelayPanel(body) {
  const seats = seatList();
  const rs = relaySettings();
  const d = relayDraftFor(seats);
  const form = document.createElement('div');
  form.className = 'relay-form';
  form.append(para('Pass a finished reply from one seat to another. The receiving seat gets it as quoted text, never as instructions.'));

  const from = document.createElement('select');
  from.setAttribute('aria-label', 'The reply to pass on');
  for (const s of seats) from.append(new Option(s.label, s.id));
  from.value = d.from;
  from.addEventListener('change', () => { d.from = from.value; refreshDrawer(); });
  form.append(fieldRow('Reply from', from, 'The seat whose latest reply in this chat is passed on.'));

  const kind = document.createElement('div');
  kind.className = 'seg';
  kind.setAttribute('role', 'group');
  kind.setAttribute('aria-label', 'Chain or broadcast');
  for (const [value, label] of [['chain', 'Chain'], ['broadcast', 'Broadcast']]) {
    const b = button('seg-btn', label);
    b.setAttribute('aria-pressed', String(d.kind === value));
    b.addEventListener('click', () => { d.kind = value; refreshDrawer(); });
    kind.append(b);
  }
  form.append(fieldRow('Send to', kind, d.kind === 'chain' ? 'Each seat gets the reply from the seat before it, in order.' : 'Every other seat gets the reply at once.'));
  if (d.kind === 'chain') form.append(chainEditor(d, seats));

  const hopSel = document.createElement('select');
  hopSel.setAttribute('aria-label', 'Hop limit');
  for (const [value, label] of HOP_CHOICES) hopSel.append(new Option(label, value));
  const current = rs.hops == null ? 'none' : [2, 4, 8].includes(rs.hops) ? String(rs.hops) : 'custom';
  hopSel.value = current;
  const custom = document.createElement('input');
  custom.type = 'number';
  custom.min = '1';
  custom.max = '50';
  custom.step = '1';
  custom.value = String(rs.hops ?? 3);
  custom.hidden = current !== 'custom';
  custom.setAttribute('aria-label', 'Custom hop limit');
  hopSel.addEventListener('change', () => {
    if (hopSel.value === 'custom') {
      custom.hidden = false;
      custom.focus();
      return;
    }
    saveRelay({ hops: hopSel.value === 'none' ? null : Number(hopSel.value) });
  });
  custom.addEventListener('change', () => {
    const n = Math.floor(Number(custom.value));
    if (!(n >= 1 && n <= 50)) return toast('A hop limit is a whole number from 1 to 50.', 'bad');
    saveRelay({ hops: n });
  });
  const hopRow = document.createElement('div');
  hopRow.className = 'hop-row';
  hopRow.append(hopSel, custom);
  form.append(fieldRow('Hop limit', hopRow, 'How many hops the route takes before it stops.'));

  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '10';
  range.step = '1';
  range.value = String(rs.countdownSec);
  range.setAttribute('aria-label', 'Countdown before each hop, in seconds');
  const out = document.createElement('output');
  out.textContent = `${rs.countdownSec} s`;
  range.addEventListener('input', () => { out.textContent = `${range.value} s`; });
  range.addEventListener('change', () => saveRelay({ countdownSec: Number(range.value) }));
  const rangeRow = document.createElement('div');
  rangeRow.className = 'range-row';
  rangeRow.append(range, out);
  form.append(fieldRow('Countdown before each hop', rangeRow, '0 passes the reply on at once.'));

  form.append(switchRow('Stop when a hop fails', 'On: the route stops at the first error. Off: it goes on with the last good reply.', rs.stopOnError, v => saveRelay({ stopOnError: v })));
  form.append(switchRow('Skip repeats', 'Do not send a reply that was already sent in this route. Off by default, since a repeated answer is sometimes the right one.', rs.dedupe, v => saveRelay({ dedupe: v })));
  form.append(switchRow(`Auto relay is ${rs.autoRoute ? 'on' : 'off'}`, rs.autoRoute ? 'Routes run on their own until a limit, a stop or an error.' : 'Off by default. While it is off, nothing is passed on without you.', rs.autoRoute, v => saveRelay({ autoRoute: v })));

  const start = button('primary small', 'Start route');
  const reason = !rs.autoRoute
    ? 'Turn on auto relay to start a route.'
    : busyNow()
      ? 'Something is already running in this project.'
      : d.kind === 'chain' && !d.targets.length
        ? 'Add at least one seat to the chain.'
        : 'The route runs in this chat. Its hop counter and Pause and Stop appear above the composer.';
  start.disabled = !rs.autoRoute || busyNow() || (d.kind === 'chain' && !d.targets.length);
  start.addEventListener('click', () => startRoute(d));
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(start);
  form.append(actions, Object.assign(document.createElement('p'), { className: `route-state${rs.autoRoute ? ' on' : ''}`, textContent: reason }));
  body.append(form);
}

async function startRoute(d) {
  if (busyNow()) return toast('This project is already running. Use /cancel first.', 'bad');
  const rs = relaySettings();
  const route = {
    kind: d.kind,
    from: d.from,
    targets: d.kind === 'chain' ? d.targets.slice() : [],
    hops: rs.hops ?? null,
    countdownSec: rs.countdownSec,
    stopOnError: rs.stopOnError !== false,
  };
  closeDrawer();
  notes = [];
  routeRun = { limit: rs.hops ?? null, hop: 0, paused: false };
  renderRouteBar();
  await streamTurn('/api/relay/route', { project: S.activeProject, sourceId: d.from, route });
}

// One reply, sent on to one seat or to all the others.
async function relayReply(sourceId, targets) {
  if (!S.activeProject) return toast('Add a project folder first.', 'bad');
  if (busyNow()) return toast('This project is already running. Use /cancel first.', 'bad');
  const draft = el.input.value;
  const note = draft.trim().startsWith('/') ? '' : draft.trim();
  if (note) {
    el.input.value = '';
    autosize();
  }
  notes = [];
  const ok = await streamTurn('/api/relay/send', { project: S.activeProject, sourceId, targets, note });
  if (!ok && note && !el.input.value) {
    el.input.value = draft;
    autosize();
  }
}

function renderRouteBar() {
  el.relayBar.hidden = !routeRun;
  if (!routeRun) return;
  const hop = routeRun.hop ? `Hop ${routeRun.hop}${routeRun.limit ? ` of ${routeRun.limit}` : ''}` : 'Starting';
  el.rbText.textContent = `Relay · ${hop}${routeRun.paused ? ' · paused' : ''}`;
  el.rbToggle.textContent = routeRun.paused ? 'Resume' : 'Pause';
}

async function toggleRelayPause() {
  if (!routeRun || !S.activeProject) return;
  const resume = routeRun.paused;
  try {
    const data = await api(resume ? '/api/relay/resume' : '/api/relay/pause', { project: S.activeProject });
    if (routeRun) routeRun.paused = Boolean(data.paused);
  } catch (err) {
    toast(err.message, 'bad');
  }
  renderRouteBar();
}

async function renderRelayLog(body) {
  const gen = drawerGen;
  body.append(para('The last hops in this project: when, which seats, how many characters, and a short fingerprint of the text. The text itself is never kept.'));
  let records = [];
  try {
    records = (await api(`/api/relay/log?project=${encodeURIComponent(S.activeProject ?? '')}`)).records ?? [];
  } catch (err) {
    if (gen === drawerGen) body.append(para(err.message));
    return;
  }
  if (gen !== drawerGen) return;
  const list = document.createElement('div');
  list.className = 'log-list';
  if (!records.length) list.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No relays yet. Use Send to on a reply, or start a route.' }));
  for (const r of records.slice().reverse()) list.append(logRow(r));
  body.append(list);
  const refreshBtn = button('ghost small', 'Refresh');
  refreshBtn.addEventListener('click', () => refreshDrawer());
  const foot = document.createElement('div');
  foot.className = 'actions';
  foot.append(refreshBtn);
  body.append(foot);
}

function logRow(r) {
  const who = x => x?.label || x?.seat || '?';
  const row = document.createElement('div');
  row.className = 'log-row';
  row.append(
    span('log-time', fmtTime(r.at)),
    span('log-hop', `Hop ${r.hop ?? 1}`),
    span('log-path', `${who(r.from)} → ${who(r.to)}`),
    span('log-chars', `${r.chars ?? 0} chars`),
    span('log-hash', String(r.sha256 ?? '').slice(0, 8)),
    span(`pill ${r.ok ? 'ok' : ''}`, r.ok ? 'Sent' : (r.error || 'Failed')),
  );
  return row;
}

// ---------- state ----------

async function refresh() {
  try {
    S = await api('/api/state');
  } catch (err) {
    notes.push(`Cannot reach the Plenum server (${err.message}).`);
  }
  renderAll();
}

// Takes the state the events channel sends (everything but the transcript, plus messageCount and lastMessageTs) and redraws the
// parts around the chat. The transcript is read again, as a whole, only when it has changed and no stream is being drawn here
// (a live stream is never wiped, which is the trap B-10 describes). { chat: false } leaves the transcript alone.
function applyState(next, { chat } = {}) {
  if (!next || typeof next !== 'object') return;
  const switched = next.activeProject !== undefined && next.activeProject !== S.activeProject;
  S = { ...S, ...next, messages: S.messages };
  if (switched) notes = [];
  renderShell();
  const changed = typeof next.messageCount === 'number' && (next.messageCount !== S.messages.length || (next.lastMessageTs ?? 0) !== (S.messages.at(-1)?.ts ?? 0));
  if (chat !== false && !activeRun() && !foreign && (switched || changed)) refresh();
  if (!S.running && !activeRun()) scheduleDrain();
}

// ---------- the events channel ----------

// GET /api/events keeps one stream open per window (lib/events.mjs). The server sends every change on it, so nothing here polls
// while it is up. A lost stream is reopened after 1, 2, 4, 8, then every 10 seconds, and watchRun covers the gap.
const eventHandlers = new Map();
let startedAt = 0;
let reconnecting = false;

function fanOut(ev) {
  for (const fn of eventHandlers.get(ev.type) ?? []) {
    try {
      fn(ev);
    } catch (err) {
      console.error(err);
    }
  }
  // Panels listen to every event as 'plenum:event'.
  window.dispatchEvent(new CustomEvent('plenum:event', { detail: ev }));
}

function setConnected(connected) {
  if (events.connected === connected) return;
  events.connected = connected;
  window.dispatchEvent(new CustomEvent('plenum:connection', { detail: { connected } }));
}

const events = {
  connected: false,
  on(type, fn) {
    if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
    eventHandlers.get(type).add(fn);
  },
  off(type, fn) {
    eventHandlers.get(type)?.delete(fn);
  },
  // Opens the stream and keeps it open, for the life of the page. Calling it again while it runs does nothing.
  async connect() {
    if (reconnecting) return;
    reconnecting = true;
    for (let fails = 0; ; ) {
      try {
        const res = await request('/api/events');
        if (tokenRefused(res)) showTokenCard();
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        await readSSE(res, ev => {
          fails = 0;
          fanOut(ev);
        });
      } catch {
        // The stream ended or could not open; it is opened again below.
      }
      setConnected(false);
      await new Promise(resolve => setTimeout(resolve, [1000, 2000, 4000, 8000, 10000][Math.min(fails, 4)]));
      fails += 1;
    }
  },
};

events.on('hello', ev => {
  // A different startedAt than before means the server restarted (an applied update), so this window loads the new page once.
  if (startedAt && ev.startedAt !== startedAt) {
    location.reload();
    return;
  }
  startedAt = ev.startedAt;
  setConnected(true);
  applyState(ev.state);
});

events.on('state', ev => applyState(ev.state));

// An approval card answered in another window is replaced by one quiet line. A card this window answered itself is left alone.
events.on('approval', ev => {
  const card = document.querySelector(`[data-approval-id="${CSS.escape(String(ev.approvalId))}"]`);
  if (!card || card.dataset.answeredHere) return;
  const text = ev.action === 'expired' ? 'Timed out' : ev.action === 'stopped' ? 'Stopped' : ev.allow ? 'Approved in another window' : 'Denied in another window';
  card.replaceWith(systemTurn(text));
});

// What a run started in another window looks like here. A chat turn, a review or a relay is drawn like a run of this window
// (the same turns, tool lines and approval cards), after the transcript has been read once so the message that started it is
// on the page. Any other kind gets one line.
const DRAWN_KINDS = ['chat', 'review', 'relay'];
const KIND_WORDS = { council: 'A council', build: 'A build', compare: 'A comparison', pipeline: 'A pipeline', compact: 'A compact', restore: 'A restore' };

function foreignFeed(ev) {
  if (!foreign || foreign.runId !== ev.runId) {
    if (foreignDone.has(ev.runId)) return;
    const run = { runId: ev.runId, kind: ev.kind, project: ev.project, ready: false, queue: [], ...turnRenderer(ev.project) };
    foreign = run;
    refresh().then(() => {
      if (foreign !== run) return;
      run.ready = true;
      for (const queued of run.queue.splice(0)) foreignFeed({ runId: run.runId, event: queued });
    });
  }
  if (!foreign.ready) {
    foreign.queue.push(ev.event);
    return;
  }
  foreign.onEvent(ev.event);
  // A run ends with done. A chat turn or a review that fails ends with its error as well, so it never stays drawn if the done
  // is lost (the server sends one after it). A relay carries on after an error in one hop, so only its done ends it.
  if (ev.event.type === 'done' || (ev.event.type === 'error' && foreign.kind !== 'relay')) {
    foreignDone.add(foreign.runId);
    dropRunBox(foreign.project);
    foreign = null;
    refresh();
  }
}

function noteOtherRun(ev) {
  if (noted.has(ev.runId) || ev.event?.type === 'done') return;
  noted.add(ev.runId);
  // A panel of this window that started the run claims it from its first event; that arrives a moment after this one.
  setTimeout(() => {
    if (claimed.has(ev.runId) || ev.project !== S.activeProject || activeRun()) return;
    runBox().append(systemTurn(`${KIND_WORDS[ev.kind] ?? 'A run'} is running in another window.`));
    stickBottom();
  }, 400);
}

events.on('run', ev => {
  if (ev.project !== S.activeProject || ev.runId === liveRunId || claimed.has(ev.runId)) return;
  if (activeRun()) return;
  if (DRAWN_KINDS.includes(ev.kind)) foreignFeed(ev);
  else noteOtherRun(ev);
});

async function loadProviders() {
  const data = await api('/api/status');
  providers = data.providers;
  catalog = data.catalog;
  aliases = data.aliases;
  renderStatus();
  renderTop();
}

// ---------- theme ----------

// The server writes a saved choice into the page as data-theme, so it is in place before any script runs.
// The choice is kept with the other settings, not in the browser's local storage: the first read of
// local storage held up startup by several seconds in the desktop app.
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || t === 'light' ? t : 'system';
}

// Keeps the Theme button and the published window colour in step with the theme in use.
function syncTheme() {
  const theme = currentTheme();
  const shown = theme === 'system' ? (systemIsLight.matches ? 'light' : 'dark') : theme;
  el.themeValue.textContent = THEMES[theme];
  document.querySelector('meta[name="theme-color"]').content = THEME_COLORS[shown];
}

// Switches at once, then saves the choice with the other settings.
async function setTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  syncTheme();
  S.theme = (await api('/api/settings', { theme })).theme;
}

async function loadUpdates() {
  try {
    const data = await api('/api/updates');
    updates = data.updates;
    takeOverlay(data.overlay);
  } catch {
    updates = [];
  }
  renderBadge();
}

// Keeps the overlay part of GET /api/updates. An automatic rollback (the bootstrap went back to an earlier generation because the
// last one did not start) gets one toast, and the server is told it has been seen. The panel keeps showing it, from here, until its OK.
function takeOverlay(info) {
  overlayInfo = info && typeof info === 'object' ? info : null;
  const rb = overlayInfo?.rollback;
  if (!rb) return;
  const key = `${rb.at}|${rb.from}|${rb.to}`;
  if (key === rollbackSeen) return;
  rollbackSeen = key;
  rollbackNotice = rb;
  const why = rb.reason || 'Plenum did not start with it';
  toast(`The last update was rolled back: ${why}.${rb.from !== null ? ' Its files are kept under overlay in the state folder.' : ''}`, 'bad', 8000);
  api('/api/updates/ack-rollback', {}).catch(() => {});
}

// A settings change keeps the transcript. Only a switch to another project redraws it, so a reply, approval card or plan that is
// still arriving stays on the page (B-10). Everything else is drawn from the new state without touching the chat.
async function update(body) {
  const before = S.activeProject;
  S = await api('/api/settings', body);
  if (S.activeProject !== before) renderAll();
  else renderShell();
}

async function addFolder(path) {
  S = await api('/api/projects', { path: path.replace(/^["']+|["']+$/g, '') });
  notes = [];
  el.addForm.hidden = true;
  el.addPath.value = '';
  renderAll();
  toast(`Added ${S.projects.find(p => p.id === S.activeProject)?.name ?? 'project'}`);
}

async function switchProject(p) {
  if (p.id === S.activeProject) return;
  notes = [];
  await update({ activeProject: p.id });
  await loadUpdates();
}

async function removeProject(p) {
  S = await api('/api/projects/remove', { project: p.id });
  renderAll();
  toast(`Forgot ${p.name}. Its files were not touched.`);
}

function findProject(arg) {
  const q = arg.toLowerCase();
  return S.projects.find(p => p.name.toLowerCase() === q || p.path.toLowerCase() === q || p.id === q);
}

function openAddForm() {
  el.addForm.hidden = false;
  window.MuseUI?.notice?.('untrusted-commands', { into: el.addForm });
  el.addPath.focus();
}

// ---------- music (window.MuseMusic from public/music.js; playback starts only on a click) ----------

function mm() {
  return window.MuseMusic ?? null;
}

function musicState() {
  return { on: false, style: 'synth', volume: 60, effects: true, ...(S.music ?? {}) };
}

function styleName(key) {
  return mm()?.styles.find(s => s.key === key)?.name ?? key;
}

// Applies the saved music choices to the engine. It never starts playback: browsers need a click.
function applyMusic(mu) {
  const m = mm();
  if (!m) return;
  try {
    m.setVolume(mu.volume / 100);
    m.setStyle(mu.style);
    m.setEffects(mu.effects !== false);
  } catch {
    // no audio in this window
  }
}

function initMusic() {
  const m = mm();
  if (!m) return;
  el.music.hidden = false;
  el.musicStyle.replaceChildren(...m.styles.map(s => new Option(s.name, s.key)));
  const ok = m.supported !== false;
  for (const c of [el.musicOn, el.musicStyle, el.musicVol]) c.disabled = !ok;
  if (!ok) el.music.title = 'This window has no sound output, so music cannot play.';
  applyMusic(musicState());
  renderMusic();
}

function renderMusic() {
  const m = mm();
  if (!m) return;
  const mu = musicState();
  const playing = Boolean(m.isOn?.());
  el.musicOn.checked = playing;
  el.musicStyle.value = mu.style;
  el.musicVol.value = String(mu.volume);
  el.musicVolOut.textContent = String(mu.volume);
  el.musicHint.hidden = !(mu.on && !playing);
}

async function saveMusic(patch) {
  try {
    S = await api('/api/settings', { music: patch });
  } catch (err) {
    toast(err.message, 'bad');
  }
  renderMusic();
}

function musicCommand(arg) {
  const m = mm();
  if (!m) return toast('Music is not available in this window.', 'bad');
  const word = arg.trim().toLowerCase();
  const mu = musicState();
  if (!word) {
    const state = m.isOn?.() ? 'playing' : mu.on ? 'on, but waiting for a click' : 'off';
    return toast(`Music is ${state}. Style: ${styleName(mu.style)}. Try /music on, /music off or /music ${m.styles[0].key}.`);
  }
  if (word === 'on' || word === 'off') {
    el.musicOn.checked = word === 'on';
    el.musicOn.dispatchEvent(new Event('change'));
    return;
  }
  const style = m.styles.find(s => s.key === word || s.name.toLowerCase() === word);
  if (!style) return toast(`No music style "${arg.trim()}". Styles: ${m.styles.map(s => s.name).join(', ')}.`, 'bad');
  m.setStyle(style.key);
  return saveMusic({ style: style.key }).then(() => toast(`Music style: ${style.name}`));
}

// ---------- drawers ----------

function openDrawer(title, render) {
  drawerGen++;
  el.drawerTitle.textContent = title;
  el.drawerBody.replaceChildren();
  el.drawer.hidden = false;
  el.scrim.hidden = false;
  drawerRender = render;
  render(el.drawerBody);
}

function closeDrawer() {
  drawerGen++;
  el.drawer.hidden = true;
  el.scrim.hidden = true;
  drawerRender = null;
}

function refreshDrawer() {
  if (drawerRender && !el.drawer.hidden) {
    drawerGen++;
    el.drawerBody.replaceChildren();
    drawerRender(el.drawerBody);
  } else if (settingsShown) {
    settingsRedraw();
  }
}

function cardShell(mark, key, title, sub, pillText, ok) {
  const c = document.createElement('section');
  c.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(span(`logo-sm p-${key}`, mark));
  const names = document.createElement('div');
  names.append(span('ct', title), document.createElement('br'), span('cs', sub));
  const pill = span(`pill ${ok ? 'ok' : ''}`, pillText);
  head.append(names, pill);
  c.append(head);
  return c;
}

// Claude through the Claude CLI: sign in with the Claude account, no key involved.
function claudeCliCard(c) {
  const card = cardShell('C', 'claude', 'Claude', c.plan ? `Claude account · ${c.plan} plan` : 'Claude account', c.connected ? 'Signed in' : 'Not signed in', c.connected);
  card.append(para(c.connected
    ? `Claude runs through the Claude CLI on this computer${c.email ? `, signed in as ${c.email}` : ''}. It uses your Claude plan, not an API key.`
    : 'Sign in with your Claude account. A sign-in window opens; finish in your browser, then press Refresh here.'));
  const actions = document.createElement('div');
  actions.className = 'actions';
  // The button names the product, not the provider's own sign-in button (LEGAL provider_risks, Trademarks).
  const signIn = button('primary small', c.connected ? 'Sign in again' : 'Sign in to Claude Code');
  signIn.addEventListener('click', async () => {
    try {
      await api('/api/accounts/claude/login', {});
      toast('Sign-in window opened. Finish in your browser, then press Refresh.');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  const refreshBtn = button('ghost small', 'Refresh');
  refreshBtn.addEventListener('click', async () => {
    await loadProviders().catch(() => {});
    refreshDrawer();
  });
  actions.append(signIn, refreshBtn);
  card.append(actions);
  // The strip sits above the Sign in row (provider-terms). It informs, and the sign-in still runs when the button is pressed.
  window.MuseUI?.notice?.('provider-terms', { before: actions });
  return card;
}

function claudeCard(c) {
  if (c.route === 'cli') return claudeCliCard(c);
  const card = cardShell('C', 'claude', 'Claude', 'Anthropic API key', c.connected ? 'Connected' : 'Not connected', c.connected);
  card.append(para(c.connected
    ? `A key is saved${c.source ? ` (${c.source})` : ''}. Paste a new key below to replace it.`
    : 'Paste your Anthropic API key. It is checked with one small request, then saved to your Windows account so it survives restarts.'));
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = 'sk-ant-…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const result = document.createElement('div');
  result.className = 'result';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = button('primary small', 'Save key');
  const test = button('ghost small', c.connected ? 'Test saved key' : 'Test key');
  const show = (msg, ok) => {
    result.textContent = msg;
    result.className = `result ${ok ? 'ok' : 'bad'}`;
  };
  save.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) return show('Paste a key first.', false);
    save.disabled = true;
    show('Checking the key…', true);
    try {
      const r = await api('/api/accounts/claude/key', { key });
      input.value = '';
      show(r.message, r.saved);
      if (r.saved) {
        await loadProviders();
        toast('Claude key saved');
        refreshDrawer();
      }
    } catch (err) {
      show(err.message, false);
    } finally {
      save.disabled = false;
    }
  });
  test.addEventListener('click', async () => {
    show('Checking…', true);
    try {
      const r = await api('/api/accounts/claude/test', {});
      show(r.message, r.ok);
    } catch (err) {
      show(err.message, false);
    }
  });
  actions.append(save, test);
  card.append(input, actions, result);
  return card;
}

function museCard(m) {
  const pill = !m.installed ? 'Not installed' : m.signedIn ? 'Signed in' : 'Not signed in';
  const card = cardShell('M', 'muse', 'Muse Code', 'Meta account', pill, m.installed && m.signedIn);
  card.append(para(!m.installed
    ? 'Install Muse Code first (see the README), then come back here.'
    : m.signedIn
      ? 'Muse Code has a saved sign-in on this computer.'
      : 'Sign in with your Meta account. A sign-in window opens; approve the code in your browser, then press Refresh here.'));
  if (m.metaApiKey) card.append(para('META_API_KEY is set on this computer. It overrides the Meta account sign-in and decides which account is billed.'));
  const actions = document.createElement('div');
  actions.className = 'actions';
  const signIn = button('primary small', m.signedIn ? 'Sign in again' : 'Sign in to Muse Code');
  signIn.disabled = !m.installed;
  signIn.addEventListener('click', async () => {
    try {
      await api('/api/accounts/muse/login', {});
      toast('Sign-in window opened. Approve the code in your browser, then press Refresh.');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  const refreshBtn = button('ghost small', 'Refresh');
  refreshBtn.addEventListener('click', () => refreshDrawer());
  actions.append(signIn, refreshBtn);
  card.append(actions);
  // The strip sits above the Sign in row (provider-terms). It informs, and the sign-in still runs when the button is pressed.
  window.MuseUI?.notice?.('provider-terms', { before: actions });
  return card;
}

function codexCard(c) {
  const pill = !c.installed ? 'Not installed' : c.loggedIn ? 'Signed in' : 'Not signed in';
  const card = cardShell('X', 'codex', 'Codex', 'ChatGPT account', pill, c.installed && c.loggedIn);
  card.append(para(!c.installed
    ? 'Install the Codex CLI with npm install -g @openai/codex, then come back here.'
    : c.status || 'Sign in with your ChatGPT account. A sign-in window opens in your browser.'));
  const actions = document.createElement('div');
  actions.className = 'actions';
  const signIn = button('primary small', c.loggedIn ? 'Sign in again' : 'Sign in to Codex');
  signIn.disabled = !c.installed;
  signIn.addEventListener('click', async () => {
    try {
      await api('/api/accounts/codex/login', {});
      toast('Sign-in window opened. Finish in your browser, then press Refresh.');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  const refreshBtn = button('ghost small', 'Refresh');
  refreshBtn.addEventListener('click', () => refreshDrawer());
  actions.append(signIn, refreshBtn);
  card.append(actions);
  // The strip sits above the Sign in row (provider-terms). It informs, and the sign-in still runs when the button is pressed.
  window.MuseUI?.notice?.('provider-terms', { before: actions });
  return card;
}

// Gemini runs headless, so it can only edit files in Auto-approve mode. The card says so.
function geminiCard(g) {
  const ok = Boolean(g?.installed && g?.signedIn);
  const pill = !g ? 'Unknown' : !g.installed ? 'Not installed' : g.signedIn ? 'Signed in' : 'Not signed in';
  const card = cardShell('G', 'gemini', 'Gemini', 'Google account', pill, ok);
  card.dataset.card = 'gemini';
  card.append(para(!g
    ? 'Gemini status is not available yet. Press Refresh.'
    : !g.installed
      ? GEMINI_INSTALL
      : g.signedIn
        ? `Gemini has a saved sign-in${g.email ? ` for ${g.email}` : ''}.`
        : 'Sign in with your Google account. A sign-in window opens; choose Sign in with Google there, then press Refresh here.'));
  card.append(para('Gemini runs headless, so it edits files only when Auto-approve or Approve all is on.'));
  const actions = document.createElement('div');
  actions.className = 'actions';
  const signIn = button('primary small', g?.signedIn ? 'Sign in again' : 'Sign in to Gemini CLI');
  signIn.disabled = !g?.installed;
  signIn.addEventListener('click', async () => {
    try {
      await api('/api/accounts/gemini/login', {});
      toast('Sign-in window opened. Choose Sign in with Google there, then press Refresh.');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  const refreshBtn = button('ghost small', 'Refresh');
  refreshBtn.addEventListener('click', async () => {
    await loadProviders().catch(() => {});
    refreshDrawer();
  });
  actions.append(signIn, refreshBtn);
  card.append(actions);
  // The strip sits above the Sign in row (provider-terms). It informs, and the sign-in still runs when the button is pressed.
  window.MuseUI?.notice?.('provider-terms', { before: actions });
  return card;
}

async function renderAccounts(body) {
  const gen = drawerGen;
  body.append(para('Checking your accounts…'));
  let a;
  try {
    a = await api('/api/accounts');
  } catch (err) {
    if (gen === drawerGen) body.replaceChildren(para(err.message));
    return;
  }
  // The drawer was closed or refreshed while the answer was on its way, so it is not painted here (B-62).
  if (gen !== drawerGen) return;
  body.replaceChildren(claudeCard(a.claude), museCard(a.muse), codexCard(a.codex), geminiCard(a.gemini));
  body.append(Object.assign(document.createElement('p'), { textContent: 'Keys and sign-ins stay on this computer. Plenum sends them only to the provider they belong to.' }));
  if (accountsFocus) {
    body.querySelector(`[data-card="${accountsFocus}"]`)?.scrollIntoView({ block: 'start' });
    accountsFocus = '';
  }
}

function openAccounts() {
  openSettingsPage('accounts');
}

async function renderUpdates(body) {
  const gen = drawerGen;
  try {
    const data = await api('/api/updates');
    updates = data.updates;
    takeOverlay(data.overlay);
  } catch (err) {
    if (gen === drawerGen) body.append(para(err.message));
    return;
  }
  // The badge is kept up to date whatever drawer is open. The drawer itself is painted only if it is still the one that asked (B-62).
  renderBadge();
  if (gen !== drawerGen) return;
  if (!updates.length) {
    body.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing to review. When Claude proposes a change to Plenum, it appears here.' }));
  }
  for (const u of updates) body.append(updateCard(u));
  body.append(overlayCard());
}

// "14 Oct 2026"
function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`;
}

// The "Applied updates" section: which generation of the overlay is in use, and the two ways back (roll back one step, or remove
// them all). An automatic rollback shows as a strip at the top until its OK.
function overlayCard() {
  const card = document.createElement('section');
  card.className = 'update applied-updates';
  card.append(span('ut', 'Applied updates'));
  if (rollbackNotice) card.append(rollbackStrip(rollbackNotice));
  const gens = overlayInfo?.generations ?? [];
  const active = overlayInfo?.active ?? null;
  const gen = active === null ? null : gens.find(g => g.n === active);
  if (!gen) {
    card.append(span('um', 'Plenum is running its shipped files.'));
    return card;
  }
  card.append(span('um', `Generation ${gen.n}, applied ${shortDate(gen.appliedAt)}: ${gen.summary}`));
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `Files (${gen.files.length})`;
  const list = document.createElement('div');
  list.className = 'gen-files';
  for (const p of gen.files) list.append(span('uf', p));
  details.append(summary, list);
  const row = document.createElement('div');
  row.className = 'actions';
  const back = button('ghost small', 'Roll back');
  back.title = gen.previous ? `Go back to generation ${gen.previous}` : 'Go back to the shipped files';
  back.addEventListener('click', () => restartWith('/api/updates/rollback'));
  const reset = button('ghost small', 'Remove all applied updates');
  reset.title = 'Delete every applied update and restart with the shipped files';
  reset.addEventListener('click', () => {
    confirmBox({ title: 'Remove every applied update?', body: 'Plenum deletes every applied update and restarts with the files it shipped with.', action: 'Remove and restart', tone: 'danger' })
      .then(yes => { if (yes) restartWith('/api/updates/reset'); });
  });
  row.append(back, reset);
  card.append(details, row);
  return card;
}

// The warning strip for an automatic rollback: what happened, which generations were involved, and OK.
function rollbackStrip(rb) {
  const strip = document.createElement('div');
  strip.className = 'rollback-strip';
  strip.setAttribute('role', 'status');
  const reason = rb.reason || 'Plenum did not start with it';
  const text = rb.from === null
    ? `The last update was rolled back: ${reason}.`
    : `The last update was rolled back: ${reason}. Generation ${rb.from} was replaced by ${rb.to === null ? 'the shipped files' : `generation ${rb.to}`}.`;
  const ok = button('ghost small', 'OK');
  ok.addEventListener('click', () => {
    rollbackNotice = null;
    api('/api/updates/ack-rollback', {}).catch(() => {});
    strip.remove();
  });
  strip.append(span('rs-text', text), ok);
  return strip;
}

function updateCard(u) {
  const card = document.createElement('section');
  card.className = 'update';
  card.append(span('ut', u.summary), span('um', `${new Date(u.createdAt).toLocaleString()} · ${u.files.length} file(s)`));
  for (const f of u.files) card.append(span('uf', `${f.path}  (${f.status}, ${f.lines} lines)`));
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Show the new contents';
  const pre = document.createElement('pre');
  pre.textContent = u.files.map(f => `=== ${f.path}\n${f.preview}`).join('\n\n');
  details.append(summary, pre);
  const row = document.createElement('div');
  row.className = 'actions';
  const apply = button('primary small', 'Apply and restart');
  apply.addEventListener('click', () => applyUpdate(u));
  const discard = button('ghost small', 'Discard');
  discard.addEventListener('click', () => discardUpdate(u));
  row.append(apply, discard);
  card.append(details, row);
  return card;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      await api('/api/status');
      return true;
    } catch {
      // still restarting
    }
  }
  return false;
}

async function applyUpdate(u) {
  const names = u.files.map(f => f.path).join(', ');
  // Apply update is one of the two notices that ask in a dialog (UI-ARCH 7); Cancel is focused. The notice's registry id is
  // 'self-update' (apply-update is only its alias on the server), so the page asks by the id: the registry text and "Don't show again" apply.
  const ok = await window.MuseUI.risk('self-update', {
    title: `Apply "${u.summary}"?`,
    body: `Files: ${names}. The update is kept beside Plenum's data, and the files Plenum was installed with are not touched. Plenum restarts. If it cannot start with the update, it goes back to the version before.`,
    action: 'Apply and restart',
    focusCancel: true,
  });
  if (!ok) return;
  await restartWith('/api/updates/apply', { id: u.id });
}

// Calls an endpoint that ends in a restart of the server (apply, roll back, remove all), waits for Plenum to answer again, then reloads.
// One at a time: while a call is in flight a second one is not sent, and the buttons on the update cards are off until the page reloads
// or the call fails.
let restarting = false;
const setUpdateButtons = off => document.querySelectorAll('.update button').forEach(b => { b.disabled = off; });
async function restartWith(path, body = {}) {
  if (restarting) return;
  restarting = true;
  setUpdateButtons(true);
  try {
    await api(path, body);
    toast('Applied. Restarting Plenum…');
    const back = await waitForServer();
    if (back) {
      location.reload();
      return;
    }
    toast('The server did not come back within a minute. Restart it from the Start menu.', 'bad');
  } catch (err) {
    toast(err.message, 'bad');
  }
  restarting = false;
  setUpdateButtons(false);
}

async function discardUpdate(u) {
  try {
    await api('/api/updates/discard', { id: u.id });
    toast('Update discarded');
    refreshDrawer();
    await loadUpdates();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// "in 3 h 12 min (Tue 4:05 PM)" for a reset time.
function untilText(ts) {
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
  const span = mins < 1 ? 'in under a minute' : mins < 60 ? `in ${mins} min` : mins < 1440 ? `in ${Math.floor(mins / 60)} h ${mins % 60} min` : `in ${Math.floor(mins / 1440)} d ${Math.floor((mins % 1440) / 60)} h`;
  if (mins < 60) return span;
  return `${span} (${new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })})`;
}

function usageCard(mark, key, title, u) {
  const card = cardShell(mark, key, title, u.plan ? `Plan: ${u.plan}` : u.unavailable ? 'Not available' : 'Plan limits', u.unavailable ? 'No data' : 'Current', !u.unavailable);
  if (u.unavailable) {
    card.append(para(u.unavailable));
    return card;
  }
  for (const w of u.windows) {
    const row = document.createElement('div');
    row.className = 'meter';
    const used = Math.max(0, w.usedPercent);
    const head = span('meter-head');
    head.append(span('meter-name', w.name), span('meter-value', `${used}% used`));
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = Math.min(100, used);
    bar.className = used >= 90 ? 'high' : used >= 70 ? 'mid' : '';
    bar.setAttribute('aria-label', `${w.name}: ${used}% used`);
    const notes = [w.detail, w.resetsAt > Date.now() ? `Resets ${untilText(w.resetsAt)}` : ''].filter(Boolean).join(' · ');
    row.append(head, bar, span('meter-note', notes));
    card.append(row);
  }
  for (const [name, value] of u.facts ?? []) {
    const row = span('fact');
    row.append(span('meter-name', name), span('meter-value', value));
    card.append(row);
  }
  if (u.note) card.append(para(u.note));
  return card;
}

async function renderUsage(body) {
  const gen = drawerGen;
  const wait = document.createElement('div');
  wait.className = 'empty';
  wait.innerHTML = THINKING.replace('Thinking', 'Asking each provider');
  body.append(wait);
  let u;
  try {
    u = await api('/api/usage');
  } catch (err) {
    if (gen === drawerGen) body.replaceChildren(para(err.message));
    return;
  }
  if (gen !== drawerGen) return;
  body.replaceChildren(
    usageCard('M', 'muse', 'Muse Code', u.muse),
    usageCard('X', 'codex', 'Codex', u.codex),
    usageCard('C', 'claude', 'Claude', u.claude),
    usageCard('G', 'gemini', 'Gemini', u.gemini ?? { unavailable: 'Gemini does not report its limits from the command line.' }),
  );
  const refreshBtn = button('ghost small', 'Refresh');
  refreshBtn.addEventListener('click', () => refreshDrawer());
  const foot = document.createElement('div');
  foot.className = 'actions';
  foot.append(refreshBtn);
  body.append(foot, para('Muse Code and Claude report their numbers with a reply. Reading Muse Code can send one very small request.'));
}

function openUpdates() {
  openSettingsPage('updates');
}

function renderCommands(body) {
  // The filter box hides every card whose name, other words or description do not contain what is typed.
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'cmd-filter';
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  filter.placeholder = 'Filter commands';
  filter.setAttribute('aria-label', 'Filter commands');
  const field = document.createElement('div');
  field.className = 'field';
  field.append(filter);
  const cards = COMMANDS.map(c => {
    // Each card is a button, so Tab reaches it and Enter opens it.
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmd cmd-card';
    row.append(commandHead(c), span('cd', c.desc));
    row.addEventListener('click', () => {
      closeDrawer();
      el.input.value = `/${c.name}${c.args ? ' ' : ''}`;
      autosize();
      el.input.focus();
      commandHint();
    });
    return { row, words: [c.name, ...(c.aliases ?? []), c.desc] };
  });
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const { row, words } of cards) row.hidden = Boolean(q) && !words.some(w => w.toLowerCase().includes(q));
  });
  body.append(field, ...cards.map(card => card.row));
  body.append(Object.assign(document.createElement('p'), { textContent: 'Enter sends. Shift+Enter adds a line. Esc stops a run. @path/to/file attaches a file.' }));
}

// ---------- computer use: the Computer panel, /computer, the cards of a run and the list of past runs ----------

// Start in the panel is the consent (UI-ARCH 10.5): the person's settings go with the next chat message, and the server checks them
// before anything is stored or shown (POST /api/chat, `computer`; lib/computer/policy.mjs normalizeRunSettings). Nothing in this
// block reaches the screen: the run, its cards and its limits are the server's. The panel remembers its choices per project
// (POST /api/computer/prefs), so the usual run is: type the task, pick a window, Start.

// Looks that style.css does not carry are set through the style object, which the page's policy allows (a style attribute it does not).
const looks = (node, props) => {
  Object.assign(node.style, props);
  return node;
};

// A screenshot of a run is a PNG the server keeps. Its route wants the Plenum token, which an <img> cannot send, so the page reads it
// with the token and shows it as a data: image (img-src 'self' data:). A few are kept, so a card that is built again does not read it twice.
const frameCache = new Map();
async function frameDataUrl(runId, n) {
  const key = `${runId}/${n}`;
  if (frameCache.has(key)) return frameCache.get(key);
  const res = await request(`/api/computer/frame?run=${encodeURIComponent(runId)}&n=${encodeURIComponent(n)}`);
  if (!res.ok) throw new Error('The screenshot is not available.');
  const blob = await res.blob();
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The screenshot could not be read.'));
    reader.readAsDataURL(blob);
  });
  frameCache.set(key, url);
  if (frameCache.size > 8) frameCache.delete(frameCache.keys().next().value);
  return url;
}

// The picture on a computer-use card: the screenshot the model is acting on, with a ring at the point it is about to act on. The ring is
// placed by percentage, so it stays on its point at any card width. A click on the picture makes it as wide as the card.
function frameShot(frame) {
  const shot = span('approval-shot', '');
  looks(shot, { position: 'relative', display: 'inline-block', maxWidth: '100%' });
  const img = document.createElement('img');
  img.className = 'approval-frame';
  img.alt = 'Screenshot the model is acting on';
  looks(img, { display: 'block', maxWidth: '100%', maxHeight: '320px', width: 'auto', height: 'auto', borderRadius: '8px', border: '1px solid var(--line-2)', cursor: 'zoom-in' });
  frameDataUrl(frame.run, frame.n).then(url => { img.src = url; }, () => { img.replaceWith(quietNote('The screenshot is not available.')); });
  shot.append(img);
  if (frame.marker && frame.w > 0 && frame.h > 0) {
    const ring = span('approval-marker', '');
    ring.setAttribute('aria-hidden', 'true');
    looks(ring, {
      position: 'absolute', width: '22px', height: '22px', marginLeft: '-11px', marginTop: '-11px', borderRadius: '50%', pointerEvents: 'none',
      border: '2px solid var(--accent)', boxShadow: '0 0 0 2px var(--bg)',
      left: `${Math.min(100, Math.max(0, (frame.marker.x / frame.w) * 100))}%`, top: `${Math.min(100, Math.max(0, (frame.marker.y / frame.h) * 100))}%`,
    });
    shot.append(ring);
  }
  img.addEventListener('click', () => {
    const big = img.dataset.big !== '1';
    img.dataset.big = big ? '1' : '0';
    looks(img, big ? { maxHeight: 'none', width: '100%', cursor: 'zoom-out' } : { maxHeight: '320px', width: 'auto', cursor: 'zoom-in' });
  });
  return shot;
}

// The model's notes between actions, as short grey lines. A run narrates each step; a note is two lines tall until it is clicked.
function thoughtLine() {
  const line = document.createElement('div');
  line.className = 'thought note-quiet';
  line.tabIndex = 0;
  line.title = 'Click to show all of it';
  const clamp = on => looks(line, on
    ? { display: '-webkit-box', webkitLineClamp: '2', webkitBoxOrient: 'vertical', overflow: 'hidden', cursor: 'pointer' }
    : { display: 'block', webkitLineClamp: 'unset', overflow: 'visible', cursor: 'pointer' });
  clamp(true);
  let closed = true;
  const flip = () => { closed = !closed; clamp(closed); };
  line.addEventListener('click', flip);
  line.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    flip();
  });
  return line;
}

// "Your turn": the model asked the person to do a step (hand_over), so the run waits for Resume. A password or a code can be typed here
// instead of in the app: Plenum brings the program the run was using to the front and types it there (POST /api/computer/type). The
// text is held in this function for the length of the request, cleared from the box at once, and kept nowhere: the model does not see
// it, and neither the transcript, the run log nor any provider request carries it. drive is the drive summary of the waiting run.
function typeItCard(drive) {
  const card = document.createElement('div');
  card.className = 'approval fresh typeit';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Your turn');
  const head = span('approval-head', 'Your turn');
  head.prepend(icon('user'));
  const asks = drive.note ? `The model asks: "${drive.note}"` : 'The model asks you to do a step.';
  const note = span('approval-note', 'Do it yourself in the app, then press Resume on the bar. For a password or a code you can type it here instead. Plenum types it into the window the model was using. The model never sees it, and Plenum does not keep it.');
  const box = document.createElement('input');
  box.type = 'password';
  box.className = 'approval-reason';
  box.autocomplete = 'off';
  box.spellcheck = false;
  box.maxLength = 512;
  box.placeholder = 'Text to type for you';
  box.setAttribute('aria-label', 'Text for Plenum to type into the window');
  const typeBtn = button('primary small', 'Type it for me');
  typeBtn.disabled = true;
  const status = span('hint', '');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  actions.append(typeBtn, status);
  box.addEventListener('input', () => { typeBtn.disabled = box.value === ''; });
  const send = async () => {
    if (box.value === '' || typeBtn.disabled) return;
    let secret = box.value;
    box.value = '';
    typeBtn.disabled = true;
    box.disabled = true;
    status.textContent = 'Typing…';
    try {
      const done = await api('/api/computer/type', { id: drive.id, text: secret });
      status.textContent = `Typed into ${done.app}. Press Resume on the bar when you are done.`;
    } catch (err) {
      status.textContent = err.message;
    } finally {
      secret = '';
      box.disabled = false;
      box.focus({ preventScroll: true });
    }
  };
  typeBtn.addEventListener('click', send);
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    send();
  });
  card.append(head, span('approval-summary', asks), note, box, actions);
  return card;
}

// Keeps one "Your turn" card in step with the run's drive events (the stream of a computer run carries them). The card appears when the
// model hands a step over and goes when the run resumes or stops.
function typeItTracker(box) {
  let card = null;
  let waitingId = null;
  const drop = () => {
    card?.remove();
    card = null;
    waitingId = null;
  };
  return {
    sync(drive) {
      if (!drive || drive.kind !== 'computer') return;
      const waiting = drive.state === 'paused' && drive.pausedBy === 'model';
      if (!waiting) {
        if (waitingId === drive.id) drop();
        return;
      }
      if (waitingId === drive.id && card?.isConnected) return;
      drop();
      waitingId = drive.id;
      card = typeItCard(drive);
      box.append(card);
      stickBottom();
    },
  };
}

// ---------- the Computer panel ----------

const COMPUTER_MAX_APPS = 32;
const COMPUTER_UNKNOWN = [['ask', 'Ask each time'], ['refuse', 'Refuse'], ['allow', 'Any app, no asking']];
const COMPUTER_EDGES = [[1280, '1280 px (default)'], [1600, '1600 px'], [2000, '2000 px'], [2576, '2576 px']];
const COMPUTER_CONFIRMS = [
  ['send', 'Sending messages or email'], ['buy', 'Buying or paying'], ['delete', 'Deleting or discarding'],
  ['submit', 'Submitting forms'], ['terms', 'Agreeing to terms'], ['signin', 'Signing in'],
];
const clipText = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

// Opens the panel (the + menu, /computer and MuseUI.openComputer). task fills the first box.
function openComputer(task = '') {
  if (!S.activeProject) {
    openAddForm();
    return toast('Add a project folder first.', 'bad');
  }
  const first = typeof task === 'string' ? task : '';
  return openDrawer('Computer use', body => renderComputer(body, first));
}

async function renderComputer(body, firstTask) {
  const gen = drawerGen;
  body.append(para('Checking this computer…'));
  let probe;
  let wins;
  let prefs;
  try {
    [probe, wins, prefs] = await Promise.all([
      api('/api/computer/probe'),
      api('/api/computer/windows').catch(() => ({ windows: [] })),
      api(`/api/computer/prefs?project=${encodeURIComponent(S.activeProject)}`).then(r => r.prefs).catch(() => null),
    ]);
  } catch (err) {
    if (gen !== drawerGen) return;
    const again = button('ghost small', 'Try again');
    again.addEventListener('click', () => refreshDrawer());
    body.replaceChildren(para(err.message), again);
    return;
  }
  if (gen !== drawerGen) return;
  body.replaceChildren();
  const project = S.projects.find(p => p.id === S.activeProject);
  const hotkey = probe.hotkey?.label ?? 'Ctrl+Alt+Esc';
  const stopped = line => {
    body.append(para(line));
    const past = button('ghost small', 'Past runs');
    past.addEventListener('click', () => openComputerRuns());
    body.append(past);
  };
  if (!probe.available) return stopped('Computer use needs the desktop app.');
  if (project?.chatMode === 'plan') return stopped(`Plan mode is on for ${project.name}, so Plenum will not control the computer here. Turn Plan off first.`);
  if (!probe.supported) {
    body.append(para([probe.reason, probe.help].filter(Boolean).join(' ') || 'Computer use is not available on this computer.'));
    if (probe.platform === 'darwin') {
      const ask = button('primary small', 'Request permissions');
      ask.addEventListener('click', async () => {
        ask.disabled = true;
        try {
          await api('/api/computer/request-permissions', {});
          toast('Asked. Grant them in System Settings, then restart Plenum.');
        } catch (err) {
          toast(err.message, 'bad');
        }
        ask.disabled = false;
      });
      body.append(ask, quietNote('Restart Plenum after granting them.'));
    }
    return undefined;
  }
  const ready = (probe.models ?? []).filter(m => m.ready);
  if (!ready.length) {
    return stopped('No model here can use the computer. Add an Anthropic API key in Accounts for Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 or Opus 5, or an OpenAI or Google AI key.');
  }

  // ---- what the person chose ----
  const usable = (wins.windows ?? []).filter(w => !w.denied);
  const barred = (wins.windows ?? []).filter(w => w.denied);
  const displays = probe.displays ?? [];
  const exeOf = w => String(w.exe ?? '').toLowerCase();
  const d = {
    task: firstTask || '',
    choice: '',
    apps: new Set(),
    model: '',
    steps: prefs && 'steps' in prefs ? prefs.steps : 200,
    minutes: prefs?.minutes ?? 30,
    confirmEvery: prefs?.confirmEvery === true,
    unknownApps: prefs?.unknownApps ?? 'ask',
    maxEdge: prefs?.maxEdge ?? 1280,
    numberGuard: prefs?.numberGuard !== false,
    confirm: Object.fromEntries(COMPUTER_CONFIRMS.map(([id]) => [id, prefs?.confirm?.[id] !== false])),
  };
  const remembered = new Set((prefs?.allowExes ?? []).map(e => String(e).toLowerCase()));
  if (prefs?.scope === 'display' && displays.length) {
    d.choice = `d:${displays[0].id}`;
    for (const w of usable) if (remembered.has(exeOf(w))) d.apps.add(exeOf(w));
  } else if (prefs?.targetExe) {
    const hit = usable.find(w => exeOf(w) === String(prefs.targetExe).toLowerCase());
    if (hit) d.choice = `w:${hit.id}`;
  }
  const current = project?.model ?? S.model;
  d.model = ready.find(m => m.ref === current)?.ref ?? ready.find(m => m.ref === prefs?.model)?.ref ?? ready.find(m => m.ref === 'anthropic:claude-opus-5-5')?.ref ?? ready[0].ref;

  const form = document.createElement('div');
  form.className = 'relay-form';
  form.append(para('Let a model see your screen and use the mouse and keyboard for one task.'));

  // 1. The task.
  const taskBox = document.createElement('textarea');
  taskBox.className = 'cu-task';
  taskBox.rows = 4;
  taskBox.maxLength = 2000;
  taskBox.value = d.task;
  taskBox.placeholder = 'What should the model do?';
  taskBox.setAttribute('aria-label', 'The task');
  looks(taskBox, { width: '100%', minHeight: '84px', padding: '8px 10px', resize: 'vertical', borderRadius: '9px', border: '1px solid var(--line-2)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: '13px' });
  taskBox.addEventListener('input', () => { d.task = taskBox.value; paint(); });
  form.append(fieldRow('Task', taskBox, 'Say it as you would to a person. The model asks before it sends, buys, deletes or signs in.'));

  // 2. What the model sees.
  const pick = document.createElement('select');
  pick.setAttribute('aria-label', 'What the model sees');
  const placeholder = new Option('Choose a window or a display', '', true, true);
  placeholder.disabled = true;
  pick.append(placeholder);
  if (usable.length) {
    const group = document.createElement('optgroup');
    group.label = 'Windows';
    for (const w of usable) {
      const option = new Option(`${w.app} — ${clipText(w.title || '(no title)', 70)}`, `w:${w.id}`);
      option.title = w.title;
      group.append(option);
    }
    pick.append(group);
  }
  if (displays.length) {
    const group = document.createElement('optgroup');
    group.label = 'Whole display';
    displays.forEach((disp, i) => group.append(new Option(`${disp.label || `Display ${i + 1}`} (every window on it)`, `d:${disp.id}`)));
    pick.append(group);
  }
  pick.value = d.choice;
  pick.addEventListener('change', () => { d.choice = pick.value; paintApps(); paint(); });
  const refreshWins = button('ghost small', 'Refresh');
  refreshWins.addEventListener('click', () => refreshDrawer());
  const pickRow = document.createElement('div');
  pickRow.className = 'hop-row';
  pickRow.append(pick, refreshWins);
  const seeNote = span('field-note', '');
  const seeWarn = span('field-note', '');
  looks(seeWarn, { color: 'var(--warn)' });
  const field = fieldRow('What the model sees', pickRow);
  field.append(seeNote, seeWarn);
  if (barred.length) field.append(span('field-note', 'Password managers and other credential programs are never offered.'));
  form.append(field);

  // 3. For a display: the apps the model may use.
  const appsBox = document.createElement('div');
  appsBox.className = 'field';
  form.append(appsBox);
  function paintApps() {
    appsBox.replaceChildren();
    const display = d.choice.startsWith('d:');
    appsBox.hidden = !display;
    if (!display) return;
    appsBox.append(span('field-label', 'Apps the model may use'));
    const byExe = new Map();
    for (const w of usable) {
      const key = exeOf(w);
      if (!byExe.has(key)) byExe.set(key, { first: w, count: 0 });
      byExe.get(key).count += 1;
    }
    const rows = [...byExe.entries()].sort((a, b) => Number(d.apps.has(b[0])) - Number(d.apps.has(a[0])) || Number(remembered.has(b[0])) - Number(remembered.has(a[0])));
    for (const [key, { first, count }] of rows) {
      const row = switchRow(first.app, `${clipText(first.title || '(no title)', 60)}${count > 1 ? ` · ${count} windows` : ''}`, d.apps.has(key), on => {
        if (on && d.apps.size >= COMPUTER_MAX_APPS) {
          toast(`Pick at most ${COMPUTER_MAX_APPS} apps.`, 'bad');
          return paintApps();
        }
        if (on) d.apps.add(key); else d.apps.delete(key);
        paint();
      });
      if (first.flag) row.lastElementChild.append(' ', span('pill warn', first.flag === 'browser' ? 'browser' : 'runs commands'));
      appsBox.append(row);
    }
    for (const w of barred) {
      const row = document.createElement('div');
      row.className = 'note-quiet';
      row.append(`${w.app} `, span('pill', 'never allowed'));
      appsBox.append(row);
    }
    if (!rows.length) appsBox.append(span('field-note', 'No windows are open. Open the apps the task needs, then press Refresh.'));
  }

  // 4. The model.
  const modelSel = document.createElement('select');
  modelSel.setAttribute('aria-label', 'Model');
  for (const m of probe.models ?? []) {
    const option = new Option(`${m.name}${m.note ? ` (${m.note})` : ''}`, m.ref);
    option.disabled = !m.ready;
    modelSel.append(option);
  }
  modelSel.value = d.model;
  modelSel.addEventListener('change', () => { d.model = modelSel.value; paint(); });
  form.append(fieldRow('Model', modelSel, 'Only models that can use the computer are offered. Their requests go to the model\'s provider with a screenshot each.'));

  // 5. Limits and checks.
  const more = document.createElement('details');
  more.className = 'cu-more';
  const moreSum = document.createElement('summary');
  more.append(moreSum);
  const moreBody = document.createElement('div');
  moreBody.className = 'relay-form';
  looks(moreBody, { marginTop: '12px' });
  more.append(moreBody);
  const steps = document.createElement('input');
  steps.type = 'number';
  steps.min = '10';
  steps.max = '2000';
  steps.step = '1';
  steps.value = String(d.steps ?? 200);
  steps.disabled = d.steps === null;
  steps.setAttribute('aria-label', 'Up to this many actions');
  const noLimit = switchRow('No limit on actions', '', d.steps === null, on => {
    d.steps = on ? null : Math.min(2000, Math.max(10, Math.floor(Number(steps.value)) || 200));
    steps.disabled = on;
    paint();
  });
  steps.addEventListener('change', () => { d.steps = Math.min(2000, Math.max(10, Math.floor(Number(steps.value)) || 200)); steps.value = String(d.steps); paint(); });
  moreBody.append(fieldRow('Up to this many actions', steps, '10 to 2000. A click, a key press, a typing step and a scroll are one action each.'), noLimit);
  const minutes = document.createElement('input');
  minutes.type = 'number';
  minutes.min = '1';
  minutes.max = '480';
  minutes.step = '1';
  minutes.value = String(d.minutes);
  minutes.setAttribute('aria-label', 'Minutes of activity');
  minutes.addEventListener('change', () => { d.minutes = Math.min(480, Math.max(1, Math.floor(Number(minutes.value)) || 30)); minutes.value = String(d.minutes); paint(); });
  moreBody.append(fieldRow('Up to this many minutes of activity', minutes, 'Paused time does not count.'));
  moreBody.append(switchRow('Ask before every action', 'A card before each click, key and typing step. Slow; useful for a first try.', d.confirmEvery, on => { d.confirmEvery = on; paint(); }));
  const unknown = document.createElement('div');
  unknown.className = 'seg';
  unknown.setAttribute('role', 'group');
  unknown.setAttribute('aria-label', 'Other apps');
  const unknownField = fieldRow('Other apps', unknown, 'What happens when an action lands in an app that is not in the list.');
  moreBody.append(unknownField);
  const paintUnknown = () => {
    unknown.replaceChildren(...COMPUTER_UNKNOWN.map(([value, label]) => {
      const b = button('seg-btn', label);
      b.setAttribute('aria-pressed', String(d.unknownApps === value));
      b.addEventListener('click', () => { d.unknownApps = value; paintUnknown(); paint(); });
      return b;
    }));
  };
  const edge = document.createElement('select');
  edge.setAttribute('aria-label', 'Screenshot size');
  edge.append(...COMPUTER_EDGES.map(([value, label]) => new Option(label, String(value))));
  edge.value = String(d.maxEdge);
  edge.addEventListener('change', () => { d.maxEdge = Number(edge.value); });
  moreBody.append(fieldRow('Screenshot size', edge, 'The long edge of each screenshot. Larger is sharper and costs more.'));
  moreBody.append(span('field-label', 'Ask first before the model'));
  for (const [id, label] of COMPUTER_CONFIRMS) {
    moreBody.append(switchRow(label, '', d.confirm[id], on => { d.confirm[id] = on; paint(); }));
  }
  moreBody.append(switchRow('Block card, bank and id numbers', 'Off: the model may type numbers it reads in your chat or on the screen. Use that for test cards in your own app, not real ones.', d.numberGuard, on => { d.numberGuard = on; paint(); }));
  form.append(more);

  // 6. The note.
  const rules = document.createElement('p');
  rules.className = 'field-note';
  looks(rules, { border: '1px solid var(--line-2)', borderRadius: '9px', padding: '9px 11px' });
  form.append(rules);

  // 7. The actions.
  const start = button('primary', 'Start');
  const cancel = button('ghost', 'Cancel');
  const past = button('ghost small', 'Past runs');
  const missing = span('field-note', '');
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(start, cancel, past);
  form.append(actions, missing, span('field-note', 'The model starts only after you press Start. Nothing it does changes what Plenum refuses: password managers, Plenum itself and system prompts stay off limits.'));
  cancel.addEventListener('click', closeDrawer);
  past.addEventListener('click', () => openComputerRuns());
  body.append(form);
  // The danger strip sits above Start. It informs; pressing Start is the consent.
  window.MuseUI?.notice?.('computer-use', { before: actions });

  // ---- keeping the page in step with the choices ----
  const stepsText = () => (d.steps === null ? 'no action limit' : `${d.steps} actions`);
  const asked = () => COMPUTER_CONFIRMS.filter(([id]) => d.confirm[id]).map(([, label]) => label.toLowerCase());
  function targetWindow() {
    return d.choice.startsWith('w:') ? usable.find(w => `w:${w.id}` === d.choice) ?? null : null;
  }
  function paint() {
    const win = targetWindow();
    const display = d.choice.startsWith('d:');
    unknownField.hidden = !display;
    seeNote.textContent = win
      ? `The model sees this window with the menus and dialogs it opens, and can act only in ${win.app}.`
      : display ? 'The model sees every window on this display. Pick the apps it may use below.' : 'Pick the one window the model works in, or a whole display.';
    seeWarn.textContent = win?.flag === 'browser' || (display && [...d.apps].some(e => usable.find(w => exeOf(w) === e)?.flag === 'browser'))
      ? 'A browser gives the model every site you are signed in to. The in-app browser is safer for web tasks.'
      : win?.flag === 'terminal' ? `In ${win.app} the model can run commands, and Plenum's command rules do not apply there.` : '';
    moreSum.textContent = `Limits and checks: ${stepsText()} · ${d.minutes} minutes${display ? ` · other apps: ${d.unknownApps === 'allow' ? 'any' : d.unknownApps === 'refuse' ? 'refused' : 'ask'}` : ''}${d.confirmEvery ? ' · ask before every action' : ''}`;
    const asks = asked();
    rules.textContent = `Never: typing passwords, codes${d.numberGuard ? ', card or bank details' : ''} (the model asks you to do those steps). ${asks.length ? `Asks first: ${asks.join(', ')}${display && d.unknownApps === 'ask' ? ', and any app not in the list' : ''}. ` : ''}Approve all answers these cards only where Settings allow it. Moving the mouse pauses the run; press Resume to go on. Stop any time with Stop on the bar, or ${hotkey}.`;
    const reason = !d.task.trim() ? 'Type what the model should do.'
      : !d.choice ? 'Choose a window or a display.'
        : display && !d.apps.size && d.unknownApps !== 'allow' ? 'Tick at least one app, or let the model use any app.'
          : busyNow() ? 'A reply is running in this project. Wait for it to end, or press Esc to stop it.' : '';
    start.disabled = reason !== '';
    missing.textContent = reason;
  }
  paintUnknown();
  paintApps();
  paint();

  start.addEventListener('click', async () => {
    const win = targetWindow();
    const display = d.choice.startsWith('d:');
    const ids = [];
    if (display) {
      for (const exe of d.apps) {
        const w = usable.find(x => exeOf(x) === exe);
        if (w) ids.push(w.id);
      }
    }
    const settings = {
      scope: display ? 'display' : 'window',
      target: d.choice.slice(2),
      ...(display ? { allow: ids } : {}),
      steps: d.steps,
      minutes: d.minutes,
      confirmEvery: d.confirmEvery,
      ...(display ? { unknownApps: d.unknownApps } : {}),
      maxEdge: d.maxEdge,
      confirm: { ...d.confirm },
      numberGuard: d.numberGuard,
      appNames: display ? [...d.apps].map(e => usable.find(x => exeOf(x) === e)?.app).filter(Boolean) : [win?.app].filter(Boolean),
    };
    const remember = {
      scope: settings.scope,
      ...(win ? { targetExe: win.exe } : {}),
      allowExes: display ? [...d.apps] : prefs?.allowExes ?? [],
      steps: d.steps,
      minutes: d.minutes,
      confirmEvery: d.confirmEvery,
      unknownApps: d.unknownApps,
      maxEdge: d.maxEdge,
      confirm: { ...d.confirm },
      numberGuard: d.numberGuard,
      model: d.model,
    };
    start.disabled = true;
    // The remembered choices are a convenience; a project that cannot keep them still runs.
    await api('/api/computer/prefs', { project: S.activeProject, prefs: remember }).catch(() => {});
    closeDrawer();
    await sendComputer(d.task.trim(), d.model, settings);
  });
}

// Sends one computer run as a chat turn: the task is the message and the settings go with it. It never goes through the composer, whose
// submit would stop a running reply or send the text to the council, and it takes no pictures.
// settings is what the panel built: { scope, target, allow?, steps, minutes, confirmEvery, unknownApps?, maxEdge, confirm, numberGuard, appNames }.
async function sendComputer(task, model, settings = {}) {
  if (!S.activeProject) {
    openAddForm();
    return toast('Add a project folder first.', 'bad');
  }
  if (busyNow()) return toast('A reply is running in this project. Wait for it to end, or press Esc to stop it.', 'bad');
  const text = String(task ?? '').trim();
  if (!text) return toast('Say what the model should do.', 'bad');
  const { appNames, ...computer } = settings;
  return sendMessage(text, model, [], computer, Array.isArray(appNames) ? appNames : []);
}

// ---------- past runs ----------

const STOP_WORDS_PAGE = {
  done: 'finished', user: 'stopped by you', hotkey: 'stopped with the stop key', idle: 'left paused', limit: 'limit reached',
  budget: 'spend cap reached', cancelled: 'stopped', error: 'failed', declined: 'not started', interrupted: 'interrupted',
};
const stopWordOf = reason => STOP_WORDS_PAGE[String(reason ?? '').split(':')[0].trim()] ?? 'stopped';

// The kept runs: when, which model, which apps, how many actions, how it ended, and how much room the screenshots take. A run can be
// deleted here; the server keeps runs for a time and a size (Settings) and a live run cannot be deleted.
function openComputerRuns() {
  return openDrawer('Computer runs', renderComputerRuns);
}

async function renderComputerRuns(body) {
  const gen = drawerGen;
  body.append(para('Loading…'));
  let runs;
  try {
    runs = (await api('/api/computer/runs')).runs ?? [];
  } catch (err) {
    if (gen !== drawerGen) return;
    body.replaceChildren(para(err.message));
    return;
  }
  if (gen !== drawerGen) return;
  body.replaceChildren(para('Screenshots, actions and card answers from computer runs, kept on this computer for a few days or until they pass a size limit. Nothing here is sent anywhere.'));
  if (!runs.length) {
    body.append(quietNote('No computer runs yet. Start one with /computer.'));
    return;
  }
  const list = document.createElement('div');
  list.className = 'log-list';
  for (const r of runs) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const when = r.startedAt ? new Date(r.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    row.append(span('log-time', when), span('log-hop', modelName(r.model) || r.model || ''), span('log-chars', `${(r.apps ?? []).join(', ') || 'no app'} · ${r.actions} actions · ${r.frames} screenshots · ${sizeText(r.bytes ?? 0)}`));
    row.append(span('pill', r.live ? 'running' : stopWordOf(r.stopReason)));
    const del = button('ghost small', 'Delete');
    del.disabled = r.live === true;
    del.title = r.live ? 'This run is still going. Stop it first.' : 'Delete this run\'s screenshots and action list';
    del.addEventListener('click', async () => {
      const ok = await confirmBox({ title: 'Delete this run?', body: 'Its screenshots and action list are deleted from this computer. This cannot be undone.', action: 'Delete', tone: 'danger', focusCancel: true });
      if (!ok) return;
      try {
        await api('/api/computer/runs/delete', { id: r.id });
        refreshDrawer();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    row.append(del);
    list.append(row);
  }
  body.append(list);
  const all = button('ghost small', 'Delete all runs');
  all.addEventListener('click', async () => {
    const ok = await confirmBox({ title: 'Delete every computer run?', body: 'Every run\'s screenshots and action list are deleted from this computer, except a run that is still going. This cannot be undone.', action: 'Delete all', tone: 'danger', focusCancel: true });
    if (!ok) return;
    try {
      await api('/api/computer/runs/delete-all', {});
      refreshDrawer();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  body.append(all);
}

// ---------- the side pane (MuseUI.pane) ----------

// Panels register a tab in the side pane (artifacts, the browser, review, agents) and open it. This code draws only the tab strip,
// the grip and the Back and Close buttons. Each panel draws into its own view. The view stays in the page while its tab is open,
// so switching tabs never draws a view again. Nothing about the pane is kept between page loads, except what the panels keep.
const PANE_ID = /^[a-z0-9-]{1,32}$/;
const PANE_ICON = /^[a-z0-9-]{1,40}$/;
const PANE_MIN_W = 380;   // UI-ARCH: the pane is never narrower than 380 px
const PANE_STEP = 24;     // one arrow key on the grip moves the edge this far
// UI-ARCH section 8: 480 px from 1440 px wide, 440 px before that.
const paneDefaultWidth = () => (window.innerWidth >= 1440 ? 480 : 440);
const paneDefs = new Map();       // id -> the registered definition
const paneInstances = new Map();  // id -> an open tab: { id, label, icon, count, tab, view, badgeEl, api, closed }
const paneTitleBtns = new Map();  // id -> the pane's button in the title bar (a pane registered with titleButton: true)
const paneCounts = new Map();     // id -> { n, tone }: the count the title bar button shows, kept even while the pane is closed
let paneActive = null;    // the selected tab's id, or null when no tab is open
let paneShown = false;    // whether the column is visible. Back and the last tab closing hide it; the tabs stay
let paneExpanded = false; // Expand: the pane takes over the chat column. Kept only while the column shows
let paneW = null;         // the width in px, kept for this page's life only; null until the grip or MuseUI.pane.width sets it
let paneDrag = null;      // { pointer, x, w } while the grip is dragged

function paneEvent(action, id) {
  window.dispatchEvent(new CustomEvent('plenum:pane', { detail: { action, id: id ?? null } }));
}

// A hook a panel gave in its definition. An error in it is logged and does not stop the pane.
function paneHook(id, name, api) {
  const fn = paneDefs.get(id)?.[name];
  if (typeof fn !== 'function') return;
  try {
    fn(api);
  } catch (err) {
    console.error(err);
  }
}

// 380 px at least, 60% of the window at most, and never so wide that less than 480 px of the window is left for the chat.
function paneWidthLimits() {
  const vw = window.innerWidth;
  return { min: PANE_MIN_W, max: Math.max(PANE_MIN_W, Math.min(Math.floor(vw * 0.6), vw - 480)) };
}

function paneCurrentWidth() {
  return Math.min(paneW ?? paneDefaultWidth(), paneWidthLimits().max);
}

// Sets the width (a number of pixels, clamped) through the --pane-w property the stylesheet reads. A value that is not a number keeps
// the width as it is.
function paneSetWidth(px) {
  const { min, max } = paneWidthLimits();
  const n = Number(px);
  paneW = Math.round(Math.min(max, Math.max(min, Number.isFinite(n) ? n : paneCurrentWidth())));
  el.pane.style.setProperty('--pane-w', `${paneW}px`);
  el.paneGrip.setAttribute('aria-valuenow', String(paneW));
  el.paneGrip.setAttribute('aria-valuemax', String(max));
  paneEvent('resize', paneActive);
  return paneW;
}

// The tab strip keeps the order the panels asked for. Equal orders keep the order they were opened in.
const paneTabOrder = id => paneDefs.get(id)?.order ?? 50;

// A count on a tab. null (or anything that is not a count) hides the badge.
function paneSetBadge(inst, n) {
  inst.count = n;
  const shown = typeof n === 'number' && Number.isFinite(n) && n >= 0;
  inst.badgeEl.hidden = !shown;
  inst.badgeEl.textContent = shown ? (n > 99 ? '99+' : String(Math.floor(n))) : '';
}

// Draws what the tab shows: the icon, the title and the badge.
function paneFillTab(inst) {
  const parts = [];
  if (PANE_ICON.test(inst.icon ?? '')) parts.push(icon(inst.icon));
  parts.push(span('pane-tab-title', inst.label));
  inst.badgeEl = span('badge', '');
  parts.push(inst.badgeEl);
  inst.tab.replaceChildren(...parts);
  inst.view.setAttribute('aria-label', inst.label);
  paneSetBadge(inst, inst.count ?? null);
}

function paneSortTab(inst) {
  const order = paneTabOrder(inst.id);
  const later = [...el.paneTabs.children].find(tab => tab !== inst.tab && paneTabOrder(tab.dataset.pane) > order);
  if (later) el.paneTabs.insertBefore(inst.tab, later);
  else el.paneTabs.append(inst.tab);
}

// Makes the tab and its view, and gives the api the panel receives. The view is not drawn yet (paneRenderView does that).
function paneCreate(def, params) {
  const { id } = def;
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'pane-tab';
  tab.id = `pane-tab-${id}`;
  tab.dataset.pane = id;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.setAttribute('aria-controls', `pane-view-${id}`);
  tab.tabIndex = -1;
  const view = document.createElement('section');
  view.className = 'pane-view';
  view.id = `pane-view-${id}`;
  view.dataset.pane = id;
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', tab.id);
  view.hidden = true;
  const inst = { id, label: def.title, icon: def.icon, count: null, tab, view, badgeEl: null, closed: false, api: null };
  inst.api = {
    id,
    params: params ?? {},
    el: view,
    close: () => {
      if (!inst.closed) paneCloseTab(id);
    },
    setTitle: text => {
      if (inst.closed) return;
      inst.label = String(text ?? '');
      paneFillTab(inst);
    },
    badge: n => {
      if (!inst.closed) paneSetBadge(inst, n);
    },
    isActive: () => !inst.closed && paneActive === id,
  };
  tab.addEventListener('click', () => paneSelect(id));
  paneFillTab(inst);
  el.paneBody.append(view);
  return inst;
}

// render(body, api) runs once, on the first open. A render that throws (or rejects) says so in its own view.
function paneRenderView(inst, def) {
  const fail = err => inst.view.replaceChildren(para(`This pane could not load: ${err?.message ?? err}`));
  try {
    const out = def.render(inst.view, inst.api);
    if (out && typeof out.then === 'function') out.catch(fail);
  } catch (err) {
    fail(err);
  }
}

function paneSelectTab(id) {
  for (const inst of paneInstances.values()) {
    const on = inst.id === id;
    inst.view.hidden = !on;
    inst.tab.setAttribute('aria-selected', String(on));
    inst.tab.tabIndex = on ? 0 : -1;
  }
  paneActive = paneInstances.has(id) ? id : null;
  paneSyncChrome();
}

// The column shows only while there is a tab to show.
function paneShowColumn(on) {
  paneShown = Boolean(on) && paneInstances.size > 0;
  el.pane.hidden = !paneShown;
  if (!paneShown) paneExpanded = false;
  paneSyncChrome();
}

// Keeps the title bar's pane buttons, the Expand button and the icon strip in step with what the column shows.
function paneSyncChrome() {
  for (const [id, btn] of paneTitleBtns) btn.setAttribute('aria-pressed', String(paneShown && paneActive === id));
  el.paneExpand.setAttribute('aria-pressed', String(paneExpanded));
  el.paneExpand.title = paneExpanded ? 'Restore the pane beside the chat' : 'Expand the pane over the chat';
  el.paneExpand.setAttribute('aria-label', paneExpanded ? 'Restore the pane beside the chat' : 'Expand the pane over the chat');
  // Until the grip or MuseUI.pane.width sets a width, the pane takes the default for this window (480 px from 1440 px).
  if (paneShown && paneW === null) el.pane.style.setProperty('--pane-w', `${paneDefaultWidth()}px`);
  const app = $('app');
  if (paneExpanded) app.dataset.paneExpanded = '';
  else delete app.dataset.paneExpanded;
  // With the column open the chat is narrower, so the title bar drops its secondary labels to keep one line (see style.css).
  if (paneShown) app.dataset.paneOpen = '';
  else delete app.dataset.paneOpen;
  // UI-ARCH section 8: from 1100 to 1439 px, with the pane open (not while expanded) or the Settings page open, the sidebar becomes a
  // 56 px icon strip.
  const w = window.innerWidth;
  if ((paneShown && !paneExpanded || app.hasAttribute('data-settings-open')) && w >= 1100 && w <= 1439) app.dataset.strip = '';
  else delete app.dataset.strip;
}

// Expand the pane over the chat column, or give the chat its column back. Only meaningful while the column shows.
function paneSetExpanded(on) {
  paneExpanded = Boolean(on) && paneShown;
  paneSyncChrome();
  paneEvent(paneExpanded ? 'expand' : 'restore', paneActive);
}

// The button for a pane that asks for one in the title bar (titleButton: true). Its count is the one set with MuseUI.pane.count.
function paneDrawTitleBtn(id) {
  const btn = paneTitleBtns.get(id);
  const def = paneDefs.get(id);
  if (!btn || !def) return;
  const parts = [];
  if (PANE_ICON.test(def.icon ?? '')) parts.push(icon(def.icon));
  parts.push(span('pane-btn-label', def.title));
  const count = paneCounts.get(id);
  if (count) parts.push(span('badge', count.n > 99 ? '99+' : String(Math.floor(count.n))));
  btn.replaceChildren(...parts);
  if (count) btn.lastElementChild.dataset.tone = count.tone ?? '';
  btn.title = def.title;
  btn.setAttribute('aria-label', count ? `${def.title}, ${count.n}` : def.title);
  btn.setAttribute('aria-pressed', String(paneShown && paneActive === id));
}

// Adds, orders or removes the pane's title bar button, after the pane's own definition is set.
function paneSyncTitleBtn(def) {
  if (!def.titleButton) {
    paneTitleBtns.get(def.id)?.remove();
    paneTitleBtns.delete(def.id);
    return;
  }
  let btn = paneTitleBtns.get(def.id);
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-btn';
    btn.dataset.pane = def.id;
    btn.addEventListener('click', () => paneToggle(def.id));
    paneTitleBtns.set(def.id, btn);
  }
  const later = [...el.paneButtons.children].find(b => b !== btn && paneTabOrder(b.dataset.pane) > def.order);
  if (later) el.paneButtons.insertBefore(btn, later);
  else el.paneButtons.append(btn);
  paneDrawTitleBtn(def.id);
}

// The tab after the given one, else the one before it, or null when it is the only tab.
function paneNeighbour(tab) {
  const tabs = [...el.paneTabs.children];
  const at = tabs.indexOf(tab);
  const other = tabs[at + 1] ?? tabs[at - 1];
  return other ? other.dataset.pane : null;
}

function paneRegister(def) {
  const d = def && typeof def === 'object' ? def : {};
  const { id, title, icon: iconName = '', order = 50, render, onShow, onHide, onClose } = d;
  if (typeof id !== 'string' || !PANE_ID.test(id)) throw new Error('A pane id is 1 to 32 lower-case letters, digits or hyphens.');
  if (typeof title !== 'string' || !title.trim()) throw new Error(`Pane ${id} needs a title.`);
  if (typeof render !== 'function') throw new Error(`Pane ${id} needs a render(body, api) function.`);
  if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error(`Pane ${id}: order must be a number.`);
  // titleButton: true puts a button for the pane in the title bar; MuseUI.pane.count(id, n) puts a count on it.
  const titleButton = d.titleButton === true;
  const next = { id, title: title.trim(), icon: typeof iconName === 'string' ? iconName : '', order, render, onShow, onHide, onClose, titleButton };
  // Registering again replaces the definition. A tab that is open keeps its view and takes the new title and icon.
  paneDefs.set(id, next);
  const inst = paneInstances.get(id);
  if (inst) {
    inst.label = next.title;
    inst.icon = next.icon;
    paneFillTab(inst);
    paneSortTab(inst);
  }
  paneSyncTitleBtn(next);
  return next;
}

// Opens the tab for id (drawing it on the first open) and shows the column. Every open sets the params the panel is given.
function paneOpenTab(id, params) {
  const def = paneDefs.get(id);
  if (!def) throw new Error(`No side pane called "${id}". Register it with MuseUI.pane.register first.`);
  let inst = paneInstances.get(id);
  if (!inst) {
    inst = paneCreate(def, params);
    paneInstances.set(id, inst);
    paneSortTab(inst);
    paneRenderView(inst, def);
  }
  inst.api.params = params ?? {};
  const prev = paneActive;
  const wasShown = paneShown;
  paneSelectTab(id);
  if (wasShown && prev && prev !== id) paneHook(prev, 'onHide', paneInstances.get(prev).api);
  paneShowColumn(true);
  paneHook(id, 'onShow', inst.api);
  paneEvent('open', id);
  return inst.api;
}

// Selects a tab that is open. Nothing is drawn again: the views are kept and only their hidden flags change.
function paneSelect(id) {
  if (!paneInstances.has(id)) return false;
  if (paneActive === id && paneShown) return true;
  const prev = paneActive;
  const wasShown = paneShown;
  paneSelectTab(id);
  if (wasShown && prev && prev !== id) paneHook(prev, 'onHide', paneInstances.get(prev).api);
  paneShowColumn(true);
  paneHook(id, 'onShow', paneInstances.get(id).api);
  paneEvent('select', id);
  return true;
}

// Removes the tab and its view and calls onClose. The neighbour of an active tab is selected; the column hides when no tab is left.
function paneCloseTab(id = paneActive) {
  const inst = id ? paneInstances.get(id) : undefined;
  if (!inst) return false;
  const wasActive = paneActive === id;
  const hadFocus = el.pane.contains(document.activeElement);
  const next = wasActive ? paneNeighbour(inst.tab) : null;
  paneInstances.delete(id);
  inst.closed = true;
  inst.tab.remove();
  inst.view.remove();
  paneHook(id, 'onClose', inst.api);
  if (wasActive) {
    paneActive = null;
    if (next) {
      paneSelectTab(next);
      // onShow means the tab is on screen, so a neighbour of a tab closed while the column is hidden waits for show().
      if (paneShown) paneHook(next, 'onShow', paneInstances.get(next).api);
    }
  }
  if (paneInstances.size === 0) paneShowColumn(false);
  // The focused control has gone with its view, so focus goes to the tab that is now selected, or to the composer.
  if (hadFocus) {
    const target = paneActive && paneShown ? paneInstances.get(paneActive).tab : null;
    (target ?? el.input).focus();
  }
  paneEvent('close', id);
  return true;
}

// Hides the column and keeps every tab. The composer takes the focus if the pane had it.
function paneHide() {
  if (!paneShown) return false;
  const id = paneActive;
  const hadFocus = el.pane.contains(document.activeElement);
  paneShowColumn(false);
  if (hadFocus) el.input.focus();
  if (id) paneHook(id, 'onHide', paneInstances.get(id).api);
  paneEvent('hide', id);
  return true;
}

function paneShow() {
  if (paneShown || paneInstances.size === 0) return false;
  paneShowColumn(true);
  paneHook(paneActive, 'onShow', paneInstances.get(paneActive).api);
  paneEvent('show', paneActive);
  return true;
}

// Shows the tab when it is not the one on screen, and hides the pane when it is.
function paneToggle(id) {
  if (paneShown && paneActive === id) {
    paneHide();
    return false;
  }
  paneOpenTab(id);
  return true;
}

const paneList = () => [...paneDefs.values()].sort((a, b) => a.order - b.order).map(d => d.id);

const PANE = {
  register: paneRegister,
  open: paneOpenTab,
  close: id => paneCloseTab(id),
  toggle: paneToggle,
  select: paneSelect,
  show: paneShow,
  hide: paneHide,
  active: () => paneActive,
  isOpen: id => paneInstances.has(id),
  list: paneList,
  width: px => (px === undefined ? paneCurrentWidth() : paneSetWidth(px)),
  // The count on a pane's title bar button: a number, or null to clear it. tone is 'amber' (waiting on you), 'red' or 'accent'.
  count: (id, n, tone) => {
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) paneCounts.set(id, { n: Math.floor(n), tone: tone ?? '' });
    else paneCounts.delete(id);
    paneDrawTitleBtn(id);
  },
  expanded: () => paneExpanded,
  expand: on => paneSetExpanded(on),
};

// The grip on the left edge: a drag, a double-click to reset, and the arrow keys when it has the focus.
el.paneGrip.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  paneDrag = { pointer: e.pointerId, x: e.clientX, w: paneCurrentWidth() };
  try {
    el.paneGrip.setPointerCapture(e.pointerId);
  } catch {
    // Without capture the drag still follows the pointer while it stays over the grip.
  }
});
el.paneGrip.addEventListener('pointermove', e => {
  if (!paneDrag || e.pointerId !== paneDrag.pointer) return;
  // The pane sits on the right, so moving the edge left makes it wider.
  paneSetWidth(paneDrag.w + (paneDrag.x - e.clientX));
});
const paneDragEnd = e => {
  if (!paneDrag || e.pointerId !== paneDrag.pointer) return;
  paneDrag = null;
  try {
    el.paneGrip.releasePointerCapture(e.pointerId);
  } catch {
    // The capture ended with the pointer.
  }
};
el.paneGrip.addEventListener('pointerup', paneDragEnd);
el.paneGrip.addEventListener('pointercancel', paneDragEnd);
el.paneGrip.addEventListener('dblclick', () => paneSetWidth(paneDefaultWidth()));
el.paneGrip.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  paneSetWidth(paneCurrentWidth() + (e.key === 'ArrowLeft' ? PANE_STEP : -PANE_STEP));
});
el.paneGrip.setAttribute('aria-valuemax', String(paneWidthLimits().max));
window.addEventListener('resize', () => el.paneGrip.setAttribute('aria-valuemax', String(paneWidthLimits().max)));

el.paneBack.addEventListener('click', () => paneHide());
el.paneClose.addEventListener('click', () => paneCloseTab());
el.paneExpand.addEventListener('click', () => paneSetExpanded(!paneExpanded));
// The icon strip and the Expand state follow the window width (1100 to 1439 px) as well as the column.
window.addEventListener('resize', () => paneSyncChrome());
paneSyncChrome();

// The arrow keys, Home and End move between the tabs and select the tab they reach.
el.paneTabs.addEventListener('keydown', e => {
  const tabs = [...el.paneTabs.children];
  const at = tabs.indexOf(e.target);
  if (at < 0) return;
  let to = null;
  if (e.key === 'ArrowRight') to = (at + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') to = (at - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = tabs.length - 1;
  if (to === null) return;
  e.preventDefault();
  paneSelect(tabs[to].dataset.pane);
  tabs[to].focus();
});

// Escape with the focus inside the pane closes its active tab. It stops here, so the composer's Escape (which stops a run) never sees
// it. Three cases leave it alone: a panel that handled Escape itself (it calls preventDefault), an open drawer (it sits above the
// pane, so Escape closes the drawer first), and no open tab. The drawer's own Escape handler on the document then runs.
el.pane.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented || !paneActive || !el.drawer.hidden) return;
  e.stopPropagation();
  paneCloseTab(paneActive);
});

// ---------- settings (MuseUI.settings) ----------

// Sections for the Settings drawer (scope 'app') and for the project settings drawer (scope 'project'). Each section's render draws
// into its card. A change inside a section saves at once and says so on its row.
const settingsDefs = new Map();

function settingsRegister(def) {
  const d = def && typeof def === 'object' ? def : {};
  const { id, scope, title, order = 50, render } = d;
  if (typeof id !== 'string' || !PANE_ID.test(id)) throw new Error('A settings id is 1 to 32 lower-case letters, digits or hyphens.');
  if (scope !== 'app' && scope !== 'project') throw new Error(`Settings ${id}: scope must be 'app' or 'project'.`);
  if (typeof title !== 'string' || !title.trim()) throw new Error(`Settings ${id} needs a title.`);
  if (typeof render !== 'function') throw new Error(`Settings ${id} needs a render(body, ctx) function.`);
  if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error(`Settings ${id}: order must be a number.`);
  const next = { id, scope, title: title.trim(), order, render, group: typeof d.group === 'string' ? d.group : null };
  settingsDefs.set(id, next);
  return next;
}

// Copies of the sections for one scope, in order. Equal orders keep the order they were registered in.
const settingsSections = scope => [...settingsDefs.values()]
  .filter(d => d.scope === scope)
  .sort((a, b) => a.order - b.order)
  .map(d => ({ ...d }));

// The line under a setting. It says "Saved" once the server has stored the change, or the server's refusal in red.
function settingStatus() {
  const note = document.createElement('span');
  note.className = 'setting-status';
  note.setAttribute('role', 'status');
  const show = (text, bad) => {
    note.textContent = text;
    note.classList.toggle('bad', Boolean(bad));
  };
  return { note, saved: () => show('Saved'), failed: message => show(message, true) };
}

// ---------- the Settings page (MuseUI.settings, UI-ARCH section 5) ----------
// One page over the chat column and the side pane, under the title bar. A list of groups sits on the left with a search box, and every
// group's sections stack on the right in the order UI-ARCH section 5 gives. A section comes from MuseUI.settings.register. It goes into
// the group its id names (SECTION_GROUP) or the group its registration names (group), and otherwise into More at the end. Scope
// 'project' sections belong to the project settings drawer and are not listed here (settings.open('project') opens that drawer).
const SETTINGS_GROUPS = [
  { key: 'project', label: 'This project' },
  { key: 'rules', label: 'Rules' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'api', label: 'API finder' },
  { key: 'roles', label: 'Roles' },
  { key: 'agents', label: 'Agents' },
  { key: 'safety', label: 'Safety' },
  { key: 'general', label: 'General' },
  { key: 'updates', label: 'Updates' },
  { key: 'legal', label: 'Legal' },
  { key: 'more', label: 'More' },
];
const SECTION_GROUP = {
  rules: 'rules', accounts: 'accounts', 'api-finder': 'api', roles: 'roles', sessions: 'roles', agents: 'agents', approvals: 'safety',
  appearance: 'general', music: 'general', desktop: 'general', legal: 'legal', updates: 'updates', 'plenum-changes': 'updates',
};
const groupOfSection = def => SECTION_GROUP[def.id] ?? (SETTINGS_GROUPS.some(g => g.key === def.group) ? def.group : 'more');

// The page's own parts. The roles controls and the music block were in the title bar and the sidebar; they wait in the page's stash.
const settingsRolesEl = document.getElementById('rolesControls');
let settingsShown = false;      // the page is open
let settingsGroupEls = [];      // the groups as the last draw made them: { key, label, group, nav, cards, match }
let settingsPicked = null;      // the group a narrow window shows, or the group a wide window was last sent to
let settingsActive = null;      // the group the list marks as current
let settingsEmpty = null;       // the line that says nothing matches the search
let settingsFocusBack = null;   // what had focus before the page opened; closing the page returns focus there
let settingsItem = null;        // the row a caller asked the page to open at (openSettings(section, id)); a section reads it as ctx.item while it draws
const settingsNarrow = window.matchMedia('(max-width: 480px)');
const settingsMedium = window.matchMedia('(max-width: 860px)');

// One section's card. Its render draws into the body. ctx.refresh draws the card again, in place, and the page is left as it is.
function settingsCard(def, showTitle) {
  const card = document.createElement('section');
  card.className = 'card settings-card';
  card.dataset.section = def.id;
  const body = document.createElement('div');
  body.className = 'card-body';
  if (showTitle) {
    const title = document.createElement('h4');
    title.className = 'card-title';
    title.textContent = def.title;
    card.append(title);
  }
  card.append(body);
  const fail = err => body.replaceChildren(para(`This section could not load: ${err?.message ?? err}`));
  const ctx = {
    get state() { return S; },
    // The row this open of the page was asked for, such as a notice's id, or null. A section that has rows reads it while it draws.
    get item() { return settingsItem; },
    update: patch => update(patch),
    refresh: () => draw(),
    toast: (message, kind) => toast(message, kind),
  };
  const draw = () => {
    body.replaceChildren();
    try {
      const out = def.render(body, ctx);
      if (out && typeof out.then === 'function') out.catch(fail);
    } catch (err) {
      fail(err);
    }
  };
  draw();
  return card;
}

// The project's own settings are in the project drawer, which this card opens (UI-ARCH section 5, This project).
function projectCard() {
  const card = document.createElement('section');
  card.className = 'card settings-card';
  card.dataset.section = 'project';
  const body = document.createElement('div');
  body.className = 'card-body';
  const project = S.projects.find(p => p.id === S.activeProject);
  if (!project) {
    body.append(para('Add a project folder first. Each project keeps its own settings.'));
  } else {
    body.append(para(`Settings for ${project.name}: model, effort, approvals, plan and build focus, checks after each turn, blocked commands, tools, isolated copies, the spend limit and the agent settings. Each one follows the app default until you change it.`));
    const open = button('ghost small', 'Open project settings');
    open.addEventListener('click', () => settingsOpen('project'));
    body.append(open);
  }
  card.append(body);
  return card;
}

// Draws every group and its sections. It runs each time the page opens, as the drawer did, so each section starts from the current
// settings. The roles controls and the music block go back to the stash first, so they are not lost with the cards.
function settingsDraw() {
  drawerGen++;
  el.settingsStash.append(settingsRolesEl, el.music);
  el.settingsNav.replaceChildren();
  el.settingsContent.replaceChildren();
  el.settingsPick.replaceChildren();
  const defsByGroup = new Map(SETTINGS_GROUPS.map(g => [g.key, []]));
  for (const def of settingsSections('app')) defsByGroup.get(groupOfSection(def)).push(def);
  settingsGroupEls = [];
  for (const g of SETTINGS_GROUPS) {
    const defs = defsByGroup.get(g.key);
    if (g.key !== 'project' && defs.length === 0) continue;
    const group = document.createElement('section');
    group.className = 'settings-group';
    group.dataset.group = g.key;
    const heading = document.createElement('h2');
    heading.className = 'settings-group-title';
    heading.id = `settings-group-${g.key}`;
    heading.textContent = g.label;
    group.setAttribute('aria-labelledby', heading.id);
    const holder = document.createElement('div');
    holder.className = 'settings-group-body';
    // A group with one section that has the group's own name does not repeat the name on the card.
    const cards = g.key === 'project' ? [projectCard()] : defs.map(def => settingsCard(def, !(defs.length === 1 && def.title === g.label)));
    holder.append(...cards);
    group.append(heading, holder);
    const nav = document.createElement('button');
    nav.type = 'button';
    nav.className = 'settings-nav-item';
    nav.textContent = g.label;
    nav.addEventListener('click', () => settingsPickGroup(g.key));
    el.settingsNav.append(nav);
    el.settingsPick.append(new Option(g.label, g.key));
    el.settingsContent.append(group);
    settingsGroupEls.push({ key: g.key, label: g.label, group, nav, cards, match: true });
  }
  settingsEmpty = document.createElement('div');
  settingsEmpty.className = 'settings-empty';
  settingsEmpty.hidden = true;
  const line = document.createElement('p');
  const clear = button('ghost small', 'Clear search');
  clear.addEventListener('click', () => {
    el.settingsSearch.value = '';
    settingsApplySearch();
    el.settingsSearch.focus({ preventScroll: true });
  });
  settingsEmpty.append(line, clear);
  el.settingsContent.append(settingsEmpty);
}

// Filters the page. A section stays when its words contain the search, and a group stays when its name does.
function settingsApplySearch() {
  const raw = el.settingsSearch.value.trim();
  const q = raw.toLowerCase();
  let shown = 0;
  for (const g of settingsGroupEls) {
    const named = Boolean(q) && g.label.toLowerCase().includes(q);
    let any = false;
    for (const card of g.cards) {
      const hit = !q || named || card.textContent.toLowerCase().includes(q);
      card.hidden = !hit;
      if (hit) any = true;
    }
    g.match = !q || named || any;
    g.nav.hidden = !g.match;
    if (g.match) shown += 1;
  }
  if (settingsEmpty) {
    settingsEmpty.hidden = !(q && shown === 0);
    settingsEmpty.firstElementChild.textContent = `No settings match "${raw}".`;
  }
  settingsSyncView();
}

// What a narrow window shows. Below 480 px the list comes first and one section follows its pick; a search shows every match.
// Wide and medium windows show every group.
function settingsSyncView() {
  const q = el.settingsSearch.value.trim();
  const narrow = settingsNarrow.matches;
  const browsing = narrow && !q;
  el.settingsPage.dataset.view = narrow ? (browsing && !settingsPicked ? 'list' : 'group') : '';
  el.settingsBack.hidden = !(narrow && (q || settingsPicked));
  for (const g of settingsGroupEls) g.group.hidden = !g.match || (browsing && g.key !== settingsPicked);
}

// Marks the group in the list as current, and in the menu of a medium window.
function settingsMark(key) {
  settingsActive = key;
  for (const g of settingsGroupEls) {
    if (g.key === key) g.nav.setAttribute('aria-current', 'true');
    else g.nav.removeAttribute('aria-current');
  }
  el.settingsPick.value = key ?? '';
}

// Sends the page to a group: a scroll on wide windows, and the group alone on a narrow one.
function settingsPickGroup(key) {
  const g = settingsGroupEls.find(x => x.key === key);
  if (!g) return;
  settingsPicked = key;
  settingsMark(key);
  settingsSyncView();
  el.settingsContent.scrollTop = settingsNarrow.matches ? 0 : Math.max(0, g.group.offsetTop - 12);
}

// On wide windows the list marks the group the reader has reached.
function settingsSpy() {
  if (!settingsShown || settingsMedium.matches) return;
  const line = el.settingsContent.scrollTop + 40;
  let current = null;
  for (const g of settingsGroupEls) if (!g.group.hidden && g.group.offsetTop <= line) current = g.key;
  if (current === null) current = settingsGroupEls.find(g => !g.group.hidden)?.key ?? null;
  if (current !== null && current !== settingsActive) settingsMark(current);
}

// A name for where the page opens: a group ("rules", "accounts", "roles"...) or a section id (see settingsDefs). Anything else opens
// the top of the page.
function settingsTarget(where) {
  const name = typeof where === 'string' ? where.trim() : '';
  if (!name) return null;
  if (SETTINGS_GROUPS.some(g => g.key === name)) return name;
  if (SECTION_GROUP[name]) return SECTION_GROUP[name];
  const def = settingsDefs.get(name);
  return def ? groupOfSection(def) : null;
}

// The chat and the composer cannot be reached while the page is open. The banner slot is left live: the drive bar is in it, paints over
// the page (ext-drive.css, z-index 35) and its Pause and Stop have to keep working there. style.css keeps the slot's other banners, and
// anything added to the composer while the page is open, out of reach.
function settingsInert(on) {
  el.chat.inert = on;
  for (const part of el.composerWrap.children) part.inert = on && part !== el.bannerSlot;
}

// Opens the Settings page, at the group or section named by where. A page that is open is drawn again at the new place. item names a
// row inside that section (a notice's id for Safety); the section gets it as ctx.item while it draws, and nothing else reads it.
function openSettingsPage(where, item) {
  const target = settingsTarget(where);
  closeDrawer();
  if (!settingsShown) {
    settingsFocusBack = document.activeElement;
    settingsShown = true;
    $('app').dataset.settingsOpen = '';
    el.settingsPage.hidden = false;
    settingsInert(true);
    el.settingsBtn.setAttribute('aria-pressed', 'true');
  }
  el.settingsSearch.value = '';
  settingsPicked = null;
  settingsItem = typeof item === 'string' && item ? item : null;
  try {
    settingsDraw();
  } finally {
    settingsItem = null;
  }
  settingsApplySearch();
  if (target) settingsPickGroup(target);
  else settingsSpy();
  paneSyncChrome();
  el.settingsSearch.focus({ preventScroll: true });
}

// Closes the page and gives focus back to what had it.
function closeSettingsPage() {
  if (!settingsShown) return;
  settingsShown = false;
  drawerGen++;
  el.settingsPage.hidden = true;
  delete $('app').dataset.settingsOpen;
  settingsInert(false);
  el.settingsBtn.setAttribute('aria-pressed', 'false');
  el.settingsStash.append(settingsRolesEl, el.music);
  el.settingsNav.replaceChildren();
  el.settingsContent.replaceChildren();
  el.settingsPick.replaceChildren();
  settingsGroupEls = [];
  settingsEmpty = null;
  settingsPicked = null;
  settingsActive = null;
  el.settingsSearch.value = '';
  paneSyncChrome();
  const back = settingsFocusBack;
  settingsFocusBack = null;
  // Focus goes back only to something on screen; a control that was hidden meanwhile would lose it.
  const shown = back && back.isConnected && back !== document.body && !back.closest('.settings-page') && back.getClientRects().length > 0;
  if (shown && typeof back.focus === 'function') back.focus({ preventScroll: true });
  else el.input.focus({ preventScroll: true });
}

// Draws the page again in place: a section's refresh, or a change made in one of them, keeps the search, the pick and the scroll.
function settingsRedraw() {
  const top = el.settingsContent.scrollTop;
  settingsDraw();
  settingsApplySearch();
  el.settingsContent.scrollTop = top;
  settingsSpy();
}

// scope 'app' opens the Settings page at where (a group or section, see settingsTarget). scope 'project' opens the project settings
// drawer, which a panel defines.
function settingsOpen(scope = 'app', where = '', item) {
  if (scope === 'project') {
    if (typeof window.MuseUI?.openProjectSettings === 'function') return window.MuseUI.openProjectSettings();
    return toast('Project settings are not available.', 'bad');
  }
  if (scope !== 'app') throw new Error(`Settings scope must be 'app' or 'project', not "${scope}".`);
  return openSettingsPage(where, item);
}

// Ctrl+Comma and the sidebar link open the page at its top. The argument is ignored unless it names a group or section.
function openSettings(where) {
  return openSettingsPage(typeof where === 'string' ? where : '');
}

// MuseUI.openSettings(section, id): the page at a group or section and, with an id, at a row in it. The notices' More link uses it to
// open Settings > Safety at that notice (UI-ARCH 7). A section that is not named opens the top of the page, as openSettings does.
function openSettingsAt(section, id) {
  return openSettingsPage(typeof section === 'string' ? section : '', id);
}

const SETTINGS = { register: settingsRegister, sections: settingsSections, open: settingsOpen };

// Sections this file owns. Accounts and Updates were drawers; they are sections of the page now (UI-ARCH section 5). The roles controls
// (the advisor and the review switch) and the music block are moved in from the title bar and the sidebar.
settingsRegister({
  id: 'roles',
  scope: 'app',
  title: 'Roles',
  order: 10,
  render(body) {
    body.append(settingsRolesEl);
  },
});
settingsRegister({
  id: 'music',
  scope: 'app',
  title: 'Music',
  order: 15,
  render(body) {
    body.append(el.music);
  },
});
settingsRegister({
  id: 'accounts',
  scope: 'app',
  title: 'Accounts',
  order: 10,
  render: body => renderAccounts(body),
});
// The review of the changes Claude proposes to Plenum (the Updates drawer's content). The app's own version and update status is
// the Updates section of wave 9, which sorts first.
settingsRegister({
  id: 'plenum-changes',
  scope: 'app',
  title: 'Changes to Plenum',
  order: 70,
  render: body => renderUpdates(body),
});

// The page's controls: the search, the menu of a medium window, the back button of a narrow one, the scroll that marks the group,
// and the close button. The updates count shows on Settings, since the Updates link left the sidebar.
el.settingsPage.tabIndex = -1;
el.settingsSearch.addEventListener('input', () => settingsApplySearch());
el.settingsPick.addEventListener('change', () => settingsPickGroup(el.settingsPick.value));
el.settingsClose.addEventListener('click', () => closeSettingsPage());
el.settingsBack.addEventListener('click', () => {
  if (el.settingsSearch.value) {
    el.settingsSearch.value = '';
    settingsApplySearch();
  } else {
    settingsPicked = null;
    settingsSyncView();
    el.settingsNav.querySelector('button')?.focus({ preventScroll: true });
  }
});
el.settingsContent.addEventListener('scroll', () => settingsSpy(), { passive: true });
// A window that changes width changes the view. The resize event covers a size change that the breakpoint's change event misses.
settingsNarrow.addEventListener('change', () => settingsSyncView());
window.addEventListener('resize', () => { if (settingsShown) settingsSyncView(); });
el.settingsBtn.append(el.updatesBadge);


// Appearance: the same choice as the Theme button in the sidebar. The select follows the button when the theme changes elsewhere.
settingsRegister({
  id: 'appearance',
  scope: 'app',
  title: 'Appearance',
  order: 10,
  render(body) {
    const select = document.createElement('select');
    for (const [key, label] of Object.entries(THEMES)) select.append(new Option(label, key));
    select.value = currentTheme();
    const row = document.createElement('label');
    row.className = 'setting';
    const status = settingStatus();
    row.append(span('field-label', 'Theme'), select);
    select.addEventListener('change', () => {
      const theme = select.value;
      setTheme(theme)
        .then(() => {
          status.saved();
          toast(`Theme: ${THEMES[theme]}`);
        })
        .catch(err => {
          status.failed(err.message);
          toast(err.message, 'bad');
        });
    });
    const watch = new MutationObserver(() => {
      if (!select.isConnected) {
        watch.disconnect();
        return;
      }
      select.value = currentTheme();
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    body.append(row, status.note);
  },
});

// Desktop: four switches the desktop app reads from the saved state file. Under plain node they are shown but disabled.
const DESKTOP_SWITCHES = [
  { key: 'finishedAlerts', label: 'Finished alerts', desc: 'Show a notification when a run ends while the window is not focused' },
  { key: 'approvalAlerts', label: 'Approval alerts', desc: 'Show a notification when a card waits while the window is not focused' },
  { key: 'keepAwake', label: 'Keep awake', desc: 'Keep the computer from sleeping while a run is in progress' },
  { key: 'trayOnClose', label: 'Keep in tray on close', desc: 'Closing the window hides Plenum to the tray and keeps the server running' },
];

settingsRegister({
  id: 'desktop',
  scope: 'app',
  title: 'Desktop',
  order: 20,
  render(body) {
    body.append(para('Reading these settings…'));
    return api('/api/desktop-settings').then(data => {
      body.replaceChildren();
      if (!data.desktop) body.append(para('These apply in the Plenum desktop app.'));
      for (const sw of DESKTOP_SWITCHES) body.append(desktopSwitch(sw, data));
    });
  },
});

function desktopSwitch(sw, data) {
  const wrap = document.createElement('div');
  wrap.className = 'setting';
  const status = settingStatus();
  // Only the answer to the latest change is shown, so two quick changes cannot leave the switch on the earlier value.
  let latest = 0;
  const row = switchRow(sw.label, sw.desc, data[sw.key], value => {
    const mine = ++latest;
    api('/api/desktop-settings', { [sw.key]: value })
      .then(saved => {
        if (mine !== latest) return;
        input.checked = saved[sw.key] === true;
        status.saved();
        toast(`${sw.label} ${input.checked ? 'on' : 'off'}.`);
      })
      .catch(err => {
        if (mine !== latest) return;
        input.checked = !value;
        status.failed(err.message);
        toast(err.message, 'bad');
      });
  });
  const input = row.querySelector('input');
  input.disabled = !data.desktop;
  wrap.append(row, status.note);
  return wrap;
}

// Sessions: how a chat turn reaches the model. The same choice the server keeps as sessionMode.
const SESSION_LABELS = { transcript: 'Transcript', native: 'Native' };
settingsRegister({
  id: 'sessions',
  scope: 'app',
  title: 'Sessions',
  order: 30,
  render(body) {
    const select = document.createElement('select');
    for (const [key, label] of Object.entries(SESSION_LABELS)) select.append(new Option(label, key));
    let saved = S.sessionMode === 'native' ? 'native' : 'transcript';
    select.value = saved;
    const status = settingStatus();
    const row = document.createElement('label');
    row.className = 'setting';
    row.append(
      span('field-label', 'Session mode'),
      select,
      span('field-note', 'Transcript resends the chat to each model. Native lets each CLI keep its own session where it can.'),
    );
    select.addEventListener('change', () => {
      const mode = select.value;
      update({ sessionMode: mode })
        .then(() => {
          saved = mode;
          status.saved();
          toast(`Session mode: ${SESSION_LABELS[mode]}`);
        })
        .catch(err => {
          select.value = saved;
          status.failed(err.message);
          toast(err.message, 'bad');
        });
    });
    body.append(row, status.note);
  },
});

// ---------- the confirm dialog (MuseUI.confirm) ----------
// MuseUI.confirm({ title, body, action, cancel, tone, check, focusCancel }) replaces window.confirm and window.prompt. It resolves
// true only when the action button is pressed; Cancel, Escape and closing the dialog resolve false. tone 'danger' (or 'bad') makes
// the action red and puts focus on Cancel, as does focusCancel: true, so Enter never does the risky thing by accident. check is
// { label, checked }: it adds a checkbox, and the caller reads check.checked after the answer. Every piece of text is set with
// textContent. The dialog is shown over a scrim, not as a native modal: a modal makes the whole page inert, which would also stop
// the drive bar and the drive pill (Stop) from being pressed while a question waits. Tab stays inside it and Escape closes it.
let dialogSeq = 0;
// Either the app's confirm dialog or the notices' risk dialog (ext-notices.js) counts: Esc belongs to the dialog while one is open.
const dialogOpen = () => Boolean(document.querySelector('dialog.confirm-dialog[open], dialog.risk-dialog[open]'));

function confirmBox({ title = '', body = '', action = 'OK', cancel = 'Cancel', tone = '', check = null, focusCancel = false } = {}) {
  return new Promise(resolve => {
    const id = ++dialogSeq;
    const danger = tone === 'danger' || tone === 'bad';
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm-dialog';
    const head = document.createElement('h2');
    head.className = 'confirm-title';
    head.id = `confirm-title-${id}`;
    head.textContent = String(title);
    const text = document.createElement('p');
    text.className = 'confirm-body';
    text.id = `confirm-body-${id}`;
    text.textContent = String(body);
    dlg.setAttribute('aria-labelledby', head.id);
    dlg.setAttribute('aria-describedby', text.id);
    dlg.setAttribute('aria-modal', 'true');
    const parts = [head, text];
    if (check && typeof check === 'object') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = check.checked === true;
      box.addEventListener('change', () => { check.checked = box.checked; });
      const row = document.createElement('label');
      row.className = 'confirm-check';
      row.append(box, document.createTextNode(` ${check.label ?? ''}`));
      parts.push(row);
    }
    const cancelBtn = button('ghost', cancel);
    const actionBtn = button(danger ? 'primary danger' : 'primary', action);
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    actions.append(cancelBtn, actionBtn);
    dlg.append(...parts, actions);
    // The answer is settled here, from the buttons and from Escape, and not from the close event: a browser may not dispatch that
    // event for a dialog it closes, and the question would then never resolve and leave the page's controls disabled.
    // Focus stays in the dialog: Tab wraps inside it, and a focus move outside it is brought back to the safe button.
    const scrim = document.createElement('div');
    scrim.className = 'confirm-scrim';
    const keepFocus = e => {
      if (!dlg.contains(e.target)) (danger || focusCancel ? cancelBtn : actionBtn).focus();
    };
    let settled = false;
    const finish = answer => {
      if (settled) return;
      settled = true;
      document.removeEventListener('focusin', keepFocus);
      scrim.remove();
      dlg.remove();
      resolve(answer);
    };
    cancelBtn.addEventListener('click', () => finish(false));
    actionBtn.addEventListener('click', () => finish(true));
    // Escape: the answer is False and the dialog is removed at once. The browser's own close request gets the same answer.
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...dlg.querySelectorAll('button, input, select, textarea, a[href]')].filter(el => !el.disabled);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !dlg.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !dlg.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('focusin', keepFocus);
    document.body.append(scrim, dlg);
    dlg.show();
    (danger || focusCancel ? cancelBtn : actionBtn).focus();
  });
}

// ---------- the notices surface and the Approve all question ----------
// MuseUI.notice(id, { before, after }) draws a notice strip before or after an element, and MuseUI.risk(id, { action, title, body,
// tone, check }) asks before a risky switch and resolves to true when it may go on. public/ext-notices.js replaces both: the strip
// or dialog, the notice text and Don't show again live there. Until it loads, a notice draws nothing, and a risk asks with the text
// the caller gave, every time. A risky switch is therefore never turned on without a question.
// Approve all is asked the same way from every control that can turn it on (the Mode menu, Settings, Project settings, /approvals).
function askApproveAll() {
  return window.MuseUI.risk('approve-all', { title: APPROVE_ALL_TITLE, body: APPROVE_ALL_CONFIRM, action: APPROVE_ALL_ACTION, tone: 'danger' });
}

// Changes the approval settings of one project (POST /api/project-approvals). The patch holds only the fields to change: approvals
// ('ask', 'auto', 'all' or null for the app default), approveAllBlocked, approveAllCovers or codersCannotAsk. The reply is the
// project's approval summary, which replaces the page's copy of it, and plenum:approvals tells the panels that paint it.
async function setProjectApprovals(patch, projectId = S.activeProject) {
  const r = await api('/api/project-approvals', { project: projectId, ...patch });
  const p = S.projects.find(x => x.id === r.project);
  if (p) {
    p.approvals = r.approvals;
    p.ownApprovals = r.ownApprovals;
    p.approveAllBlocked = r.approveAllBlocked;
    p.approveAllCovers = r.approveAllCovers;
    p.codersCannotAsk = r.codersCannotAsk;
  }
  window.dispatchEvent(new CustomEvent('plenum:approvals', { detail: r }));
  renderTop();
  return r;
}

// ---------- commands ----------

function advisorLine() {
  return `Advisor: ${S.advisor ? modelName(S.advisor) : 'off'}. Review every reply: ${S.advisorAuto ? 'on' : 'off'}.`;
}

async function runCommand(line) {
  const match = line.match(/^\/(\S*)\s*([\s\S]*)$/);
  const rawName = match?.[1] ?? '';
  const arg = (match?.[2] ?? '').trim();
  try {
    switch (rawName.toLowerCase()) {
      case 'help':
      case 'commands':
        return openDrawer('Commands', renderCommands);
      case 'models': {
        const lines = catalog.map(c => `${modelName(`${c.provider}:${c.id}`).padEnd(16)} ${c.provider}:${c.id}`);
        const names = Object.entries(aliases).map(([a, ref]) => `${a} → ${modelName(ref)}`);
        notes.push(`Models\n${lines.join('\n')}\n\nShort names: ${names.join(' · ')}`);
        return renderChat();
      }
      case 'model':
        if (!arg) return toast(`Model: ${modelName(S.model)}. Switch with /model <name>.`);
        await update({ model: arg });
        return toast(`Model set to ${modelName(S.model)}`);
      case 'advisor': {
        const tokens = arg.split(/\s+/).filter(Boolean);
        if (!tokens.length) return toast(advisorLine());
        const body = {};
        for (const t of tokens) {
          if (t === 'off') {
            body.advisor = 'off';
            body.advisorAuto = false;
          } else if (t === 'auto') {
            body.advisorAuto = !S.advisorAuto;
          } else {
            body.advisor = t;
          }
        }
        await update(body);
        return toast(advisorLine());
      }
      case 'effort': {
        const level = arg.toLowerCase();
        // A fresh state has no effort of its own, so the app uses high: the default the Effort selector shows and the server falls back to.
        const choices = Object.keys(EFFORT_LABELS).join('|');
        if (!level) return toast(EFFORT_LABELS[S.effort] ? `Effort: ${S.effort}. Set it with /effort ${choices}.` : `Effort: high (default). Set it with /effort ${choices}.`);
        if (!EFFORT_LABELS[level]) return toast('Effort must be low, medium, high, xhigh or max.', 'bad');
        await update({ effort: level });
        return toast(`Effort set to ${EFFORT_LABELS[level]}`);
      }
      case 'approvals': {
        // The mode of the active project, the same setting the Mode menu changes (see setProjectApprovals).
        const choice = arg.toLowerCase();
        const project = S.projects.find(p => p.id === S.activeProject);
        if (!project) return toast('Add a project folder first.', 'bad');
        if (!choice) return toast(`Approvals: ${APPROVAL_WORDS[project.approvals] ?? 'ask first'}. Set with /approvals ask|auto|all.`);
        if (!APPROVAL_MODES.includes(choice)) return toast('Approvals must be ask, auto or all.', 'bad');
        if (choice === 'all' && project.approvals !== 'all' && !(await askApproveAll())) return;
        await setProjectApprovals({ approvals: choice }, project.id);
        if (choice === 'all') return toast(`Approve all is on for ${project.name}. Edits and commands run without asking; credential and system folders stay blocked.`);
        if (choice === 'auto') {
          // The danger strip where the risk starts (UI-ARCH 7); the notices module draws it, and nothing if it is not loaded.
          window.MuseUI?.notice?.('auto-approve', { before: el.form });
          return toast('Edits and commands run without asking.');
        }
        return toast('Edits and commands wait for your approval.');
      }
      case 'theme': {
        const theme = arg.toLowerCase();
        if (!theme) return toast(`Theme: ${THEMES[currentTheme()]}. Set with /theme system|dark|light.`);
        if (!THEMES[theme]) return toast('Theme must be system, dark or light.', 'bad');
        await setTheme(theme);
        return toast(`Theme: ${THEMES[theme]}`);
      }
      case 'settings':
        return openSettings();
      // The Computer panel (UI-ARCH 10.5): /computer opens it with the task typed after it, and /computer runs lists the kept runs.
      // It is not in COMMANDS yet: the palette list must match BUILT_IN_COMMANDS in lib/prompts.mjs (a saved prompt may not take a built-in
      // name), and that file is edited with it. Until then /computer runs but the palette does not offer it.
      case 'computer':
        if (arg.toLowerCase() === 'runs') return openComputerRuns();
        return openComputer(arg);
      // ext-legal.js defines MuseUI.openLegal; the optional call keeps /legal quiet when that panel has not loaded.
      case 'legal':
        return window.MuseUI.openLegal?.();
      case 'usage':
      case 'limits':
        return openDrawer('Usage and limits', renderUsage);
      // B-58: every promise is awaited inside the try, so a rejection reaches the catch below and shows as a toast.
      case 'compact':
        return await compact();
      case 'updates':
        return openUpdates();
      case 'accounts':
      case 'login':
      case 'keys':
        return openAccounts();
      case 'gemini':
        accountsFocus = 'gemini';
        return openAccounts();
      case 'music':
        return musicCommand(arg);
      case 'council': {
        const word = arg.toLowerCase();
        if (word === 'off') {
          setMode('chat');
          return toast('Chat mode. Send asks the main model.');
        }
        if (!arg) {
          setMode('council');
          return toast('Council mode. Type a question and press Enter. /council off returns to Chat.');
        }
        return await askCouncil(arg);
      }
      case 'build':
        return buildLast();
      case 'relay':
        return openDrawer('Relay route', renderRelayPanel);
      case 'review':
        return await review();
      case 'ask': {
        const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
        if (!m) return toast('Usage: /ask <model> <message>, for example /ask claude hello', 'bad');
        return await sendMessage(m[2], m[1]);
      }
      case 'plan':
        if (!arg) return toast('Usage: /plan <task>', 'bad');
        return await sendMessage(`Make a step-by-step plan for the task below. Do not modify any files yet. List the files you would touch and the main risks.\n\nTask: ${arg}`);
      case 'add':
        if (!arg) return toast('Usage: /add <folder path>', 'bad');
        return await addFolder(arg);
      case 'project':
      case 'switch': {
        if (!arg) return toast(S.projects.map(p => p.name).join(', ') || 'No projects yet.');
        const p = findProject(arg);
        if (!p) return toast(`No project "${arg}".`, 'bad');
        return await switchProject(p);
      }
      case 'remove':
      case 'forget': {
        const p = findProject(arg);
        if (!p) return toast(`No project "${arg}".`, 'bad');
        return await removeProject(p);
      }
      case 'clear':
      case 'reset':
        if (!S.activeProject) return toast('No project selected.', 'bad');
        // A short chat is cleared at once. A longer one is asked about first, so a mistyped /clear costs nothing.
        if (S.messages.filter(m => m.kind === 'chat').length >= 4 && !(await confirmBox({ title: 'Clear this chat?', body: 'Undo stays available above the composer until you send the next message.', action: 'Clear chat', tone: 'danger' }))) return;
        S = await api('/api/clear', { project: S.activeProject });
        notes = [];
        renderAll();
        return toast('Chat cleared. Undo is above the composer.');
      case 'cancel':
      case 'stop':
        return await cancelRun();
      case 'status':
        await loadProviders();
        return openAccounts();
      default:
        return toast(`Unknown command /${rawName}. Type /help.`, 'bad');
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function cancelRun() {
  const run = activeRun();
  if (run) {
    run.abort();
    return toast('Stopping…');
  }
  if (!S.activeProject) return toast('Nothing is running.');
  const { cancelled } = await api('/api/cancel', { project: S.activeProject });
  toast(cancelled ? 'Cancel sent.' : 'Nothing is running in this project.');
}

// ---------- wiring ----------

el.form.addEventListener('submit', e => {
  e.preventDefault();
  const run = activeRun();
  if (run) {
    run.abort();
    return;
  }
  // A run this page holds no stream for (one started in another window, say) is stopped here the same way. Stop leaves the
  // queue as it is.
  if (S.running) {
    cancelRun();
    return;
  }
  const text = el.input.value.trim();
  if (!text) {
    if (pickedImages().length) toast('Type a message to send with the image.', 'bad');
    return;
  }
  // The text and the images stay in the composer when they cannot be sent as they are.
  const images = pickedImages();
  const held = text.startsWith('/') ? '' : mode === 'council' && images.length ? 'A council question cannot take images. Switch to Chat to send them.' : imageRefusal(images);
  if (held) return toast(held, 'bad');
  el.input.value = '';
  autosize();
  hidePalette();
  commandHint();
  if (text.startsWith('/')) runCommand(text);
  else if (mode === 'council') askCouncil(text);
  else sendMessage(text);
});

// The names of the active project's saved prompts (ext-prompts.js keeps them), so Enter can send a typed /name that is one of
// them even when a command starts with the same letters (B-98). Read again at most every 3 seconds, and only while a / is typed.
const savedNames = { project: '', names: new Set(), at: 0, busy: false };
function refreshSavedNames() {
  const project = S.activeProject;
  if (!project || savedNames.busy) return;
  if (savedNames.project === project && Date.now() - savedNames.at < 3000) return;
  savedNames.busy = true;
  api(`/api/prompts?project=${encodeURIComponent(project)}`)
    .then(data => {
      savedNames.project = project;
      savedNames.names = new Set((Array.isArray(data?.prompts) ? data.prompts : []).map(p => String(p.name)));
      savedNames.at = Date.now();
    })
    .catch(() => {
      // Without the list, Enter keeps its usual meaning.
    })
    .finally(() => {
      savedNames.busy = false;
    });
}

el.input.addEventListener('input', () => {
  autosize();
  paletteIndex = 0;
  updatePalette();
  commandHint();
  if (el.input.value.startsWith('/')) refreshSavedNames();
});

el.input.addEventListener('keydown', e => {
  // While an input method is composing text, its keys belong to the IME: Enter confirms a conversion and Escape cancels it (B-59).
  if (e.isComposing || e.keyCode === 229) return;
  const paletteOpen = !el.palette.hidden && paletteItems.length;
  // Enter picks the highlighted command, unless the composer already holds exactly that command or the alias typed (/stop),
  // or exactly the name of a saved prompt, which Enter sends as that prompt (B-98).
  const picked = paletteItems[paletteIndex];
  const typedExact = Boolean(picked) && (el.input.value === `/${picked.name}` || (Boolean(picked.alias) && el.input.value === `/${picked.alias}`));
  const typedSaved = /^\/[a-z0-9-]{1,32}$/i.test(el.input.value) && savedNames.project === S.activeProject && savedNames.names.has(el.input.value.slice(1).toLowerCase());
  if (paletteOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    movePalette(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (paletteOpen && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !typedExact && !typedSaved))) {
    e.preventDefault();
    pickCommand(paletteIndex);
    return;
  }
  // Escape closes the list first. An open drawer takes the next Escape (the page-wide handler closes it) and the run goes on (B-60).
  // Only when neither is open does it stop a run, so the Escape after that is the one that stops it.
  if (e.key === 'Escape') {
    if (!el.palette.hidden) {
      hidePalette();
      // The list took this Escape, so an open drawer stays open.
      if (!el.drawer.hidden) e.stopPropagation();
      return;
    }
    if (!el.drawer.hidden) return;
    const run = activeRun();
    if (run) run.abort();
    else if (S.running) cancelRun();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // While a run is going, Enter queues what is typed behind it (the Send button stays Stop).
    if (busyNow()) queueFollowUp();
    else el.form.requestSubmit();
  }
});

// Puts text on the clipboard. When the clipboard API is missing or refuses (the window lost focus, or no permission), a hidden
// text box holds the text and the page's copy command takes it. Resolves false only when both fail. Panels use it as MuseUI.copyText.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The copy command below is the fallback.
  }
  const was = document.activeElement;
  const box = document.createElement('textarea');
  box.className = 'copy-buffer';
  box.readOnly = true;
  box.value = text;
  document.body.append(box);
  let ok = false;
  try {
    box.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    box.remove();
    was?.focus?.({ preventScroll: true });
  }
  return ok;
}

el.chat.addEventListener('click', async e => {
  const copy = e.target.closest('.copy');
  if (!copy) return;
  const code = copy.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
  if (!(await copyText(code))) return toast('The code could not be copied.', 'bad');
  copy.textContent = 'Copied';
  setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
});

el.addProjectBtn.addEventListener('click', () => (el.addForm.hidden ? openAddForm() : (el.addForm.hidden = true)));
el.addCancel.addEventListener('click', () => { el.addForm.hidden = true; });
el.addForm.addEventListener('submit', async e => {
  e.preventDefault();
  const v = el.addPath.value.trim();
  if (!v) return;
  try {
    await addFolder(v);
  } catch (err) {
    toast(err.message, 'bad');
  }
});

const onSettingError = err => toast(err.message, 'bad');
el.model.addEventListener('change', () => update({ model: el.model.value }).then(() => toast(`Model set to ${modelName(S.model)}`)).catch(onSettingError));
el.advisor.addEventListener('change', () => update({ advisor: el.advisor.value }).then(() => toast(advisorLine())).catch(onSettingError));
el.auto.addEventListener('change', () => update({ advisorAuto: el.auto.checked }).catch(onSettingError));
el.effort.addEventListener('change', () => update({ effort: el.effort.value }).then(() => toast(`Effort set to ${EFFORT_LABELS[S.effort]}`)).catch(onSettingError));
for (const b of el.modeBtns) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}

el.roundsSel.addEventListener('change', () => editRounds(el.roundsSel.value));
el.relayOpenBtn.addEventListener('click', () => openDrawer('Relay route', renderRelayPanel));
el.relayLogBtn.addEventListener('click', () => openDrawer('Relay log', renderRelayLog));
el.boardSummary.addEventListener('click', openCouncilDrawer);
el.rbToggle.addEventListener('click', toggleRelayPause);
el.rbStop.addEventListener('click', cancelRun);

el.musicOn.addEventListener('change', async () => {
  const m = mm();
  if (!m) return;
  const on = el.musicOn.checked;
  let playing = false;
  try {
    if (on) playing = await m.setOn(true);
    else await m.setOn(false);
  } catch {
    playing = false;
  }
  if (on && !playing) toast('Music could not start here. Click the switch again.', 'bad');
  await saveMusic({ on });
});
el.musicStyle.addEventListener('change', () => {
  mm()?.setStyle(el.musicStyle.value);
  saveMusic({ style: el.musicStyle.value });
});
el.musicVol.addEventListener('input', () => {
  mm()?.setVolume(Number(el.musicVol.value) / 100);
  el.musicVolOut.textContent = el.musicVol.value;
});
el.musicVol.addEventListener('change', () => saveMusic({ volume: Number(el.musicVol.value) }));
// The engine announces every real change; the switch follows it, whoever made the change.
window.addEventListener('musicchange', e => {
  el.musicOn.checked = Boolean(e.detail?.on);
  el.musicHint.hidden = true;
});

// Keeps one menu open at a time and closes them on an outside click or Escape.
document.addEventListener('click', e => {
  if (!e.target.closest('.reply-actions')) closeRelayMenus();
});

for (const pick of document.querySelectorAll('.pick')) pickable(pick);

el.accountsBtn.addEventListener('click', openAccounts);
el.updatesBtn.addEventListener('click', openUpdates);
el.helpBtn.addEventListener('click', () => openDrawer('Commands', renderCommands));
el.settingsBtn.addEventListener('click', () => openSettings());
el.themeBtn.addEventListener('click', () => {
  const order = Object.keys(THEMES);
  setTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]).catch(onSettingError);
});
systemIsLight.addEventListener('change', syncTheme);
el.drawerClose.addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);

// F6 moves through the regions of the window: the sidebar, the chat, the composer and the side pane (UI-ARCH section 9).
function shellRegions() {
  const side = document.querySelector('.proj-item.active, .proj-item, #addProjectBtn');
  if (settingsShown) return [side, el.settingsPage].filter(node => node && node.getClientRects().length > 0);
  const tab = paneShown && paneActive ? paneInstances.get(paneActive)?.tab : null;
  el.chat.tabIndex = -1;
  return [side, el.chat, el.input, tab].filter(node => node && node.getClientRects().length > 0);
}

function cycleRegion(step) {
  const regions = shellRegions();
  if (!regions.length) return;
  const at = regions.findIndex(region => region.contains(document.activeElement));
  const next = at < 0 ? (step > 0 ? 0 : regions.length - 1) : (at + step + regions.length) % regions.length;
  regions[next].focus({ preventScroll: true });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeRelayMenus();
  // The Settings page is the layer under a drawer and a dialog. Escape clears its search first, then closes the page.
  if (e.key === 'Escape' && settingsShown && el.drawer.hidden && !dialogOpen()) {
    if (el.settingsSearch.value) {
      el.settingsSearch.value = '';
      settingsApplySearch();
    } else {
      closeSettingsPage();
    }
  }
  // A dialog that is open takes Escape for itself, so the drawer under it stays as it is.
  if (e.key === 'Escape' && !el.drawer.hidden && !dialogOpen()) closeDrawer();
  // Ctrl+Comma opens Settings from anywhere in the window.
  if (e.key === ',' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    openSettings();
  }
  // A slash typed into a field (the composer, the approval reason, the add-project path) is text, so the shortcut leaves it alone.
  const at = document.activeElement;
  const typing = Boolean(at?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(at?.tagName ?? '');
  // The shell keys (UI-ARCH section 9). Ctrl+\ shows or hides the pane. Ctrl+Shift+B and Ctrl+Shift+D open the Agents and Review
  // panes when a panel has registered them. Those two work from the composer but not from other text fields, as Ctrl+Shift+P does.
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  const otherField = typing && at !== el.input;
  if (mod && !e.shiftKey && e.key === '\\') {
    e.preventDefault();
    if (paneShown) paneHide();
    else paneShow();
  } else if (mod && e.shiftKey && !otherField && !e.repeat && /^[bd]$/i.test(e.key)) {
    const id = e.key.toLowerCase() === 'b' ? 'agents' : 'review';
    if (paneDefs.has(id)) {
      e.preventDefault();
      paneToggle(id);
    }
  } else if (e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    cycleRegion(e.shiftKey ? -1 : 1);
  }
  if (e.key === '/' && !typing && el.drawer.hidden && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    el.input.focus();
    if (!el.input.value) el.input.value = '/';
    autosize();
    updatePalette();
  }
});

// Reads everything the page shows and opens the events channel.
async function loadAll() {
  try {
    await loadProviders();
  } catch (err) {
    notes.push(`Cannot load status (${err.message}).`);
  }
  await refresh();
  await loadUpdates();
  initMusic();
  renderAll();
  events.connect();
}

async function boot() {
  syncTheme();
  await loadToken();
  readyDone();
  // A tab started with plain Node and opened without the link has no token. The card asks for it; nothing else can work.
  if (!TOKEN && !window.plenumShell) {
    showTokenCard();
    return;
  }
  await loadAll();
}

// The surface the extra panels (public/ext-*.js) build on. It exposes what they need and changes nothing itself.
// ---------- named slots (MuseUI.slots) and the shared parts (MuseUI.ui) ----------

// A panel puts its piece into a named slot instead of finding a control on the page and placing itself beside it (UI-ARCH section 1),
// so two panels cannot collide on order. Three slots have a place on the page and take elements, kept in the order given: titlebar
// (the chips beside the project name), paneTabs (beside the side pane's tabs) and bannerSlot (above the message box). The others hold
// the definitions their consumers read: plusMenu, turnExtras, shortcutRows and threadDialogExtras. The Settings sections are MuseUI.settings.
const SLOT_HOSTS = { titlebar: () => el.titlebarSlot, paneTabs: () => el.paneSlot, bannerSlot: () => el.bannerSlot };
const SLOT_NAMES = ['titlebar', 'paneTabs', 'plusMenu', 'bannerSlot', 'settingsSections', 'turnExtras', 'shortcutRows', 'threadDialogExtras'];
const SLOT_ID = /^[a-z0-9-]{1,40}$/;
const slotItems = new Map(SLOT_NAMES.map(name => [name, new Map()])); // name -> Map(id -> { value, order })

function slotRemove(name, id) {
  const items = slotItems.get(name);
  const item = items?.get(id);
  if (!item) return false;
  if (item.value instanceof Element) item.value.remove();
  items.delete(id);
  return true;
}

// Adds an item to a slot. An item with the same id replaces the one there. Returns { remove() }.
function slotAdd(name, id, value, order = 50) {
  if (!slotItems.has(name)) throw new Error(`No slot called "${name}". The slots are ${SLOT_NAMES.join(', ')}.`);
  if (typeof id !== 'string' || !SLOT_ID.test(id)) throw new Error('A slot item id is 1 to 40 lower-case letters, digits or hyphens.');
  if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error('A slot order is a number.');
  const host = SLOT_HOSTS[name]?.() ?? null;
  if (host && !(value instanceof Element)) throw new Error(`The ${name} slot takes an element.`);
  slotRemove(name, id);
  if (host) {
    value.dataset.slotItem = id;
    value.dataset.order = String(order);
    const later = [...host.children].find(child => Number(child.dataset.order) > order);
    host.insertBefore(value, later ?? null);
  }
  slotItems.get(name).set(id, { value, order });
  return { remove: () => slotRemove(name, id) };
}

const SLOTS = {
  add: slotAdd,
  remove: slotRemove,
  names: () => [...SLOT_NAMES],
  list: name => {
    const items = slotItems.get(name);
    return items ? [...items].map(([id, item]) => ({ id, order: item.order, value: item.value })) : [];
  },
};

// The shared parts (UI-ARCH section 7): a status chip (a button in the title bar), a pill (a label) and a badge (a count). Tones:
// accent for the plan, the selection and what waits on you; amber for attention and auto-approve; red for failure, Approve all and
// destructive actions; green for passed. A tone is a data attribute, so no colour is written into the page.
const TONES = ['accent', 'amber', 'red', 'green'];
const toneOf = tone => (TONES.includes(tone) ? tone : '');

const UI = {
  chip({ label = '', title = '', tone = '', onClick } = {}) {
    const b = button('chip', String(label));
    if (toneOf(tone)) b.dataset.tone = toneOf(tone);
    b.title = title || String(label);
    b.setAttribute('aria-label', title || String(label));
    if (typeof onClick === 'function') b.addEventListener('click', onClick);
    return b;
  },
  pill(text = '', tone = '') {
    const p = span('pill', String(text));
    if (toneOf(tone)) p.dataset.tone = toneOf(tone);
    return p;
  },
  badge(n, tone = '') {
    const shown = typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const b = span('badge', shown ? (n > 99 ? '99+' : String(Math.floor(n))) : '');
    if (toneOf(tone)) b.dataset.tone = toneOf(tone);
    b.hidden = !shown;
    return b;
  },
};

window.MuseUI = {
  api, request, headers, ready, events, applyState, toast, openDrawer, closeDrawer, refreshDrawer, refresh, renderAll, renderTop, update, copyText,
  // Named slots (see above) and the shared parts.
  slots: SLOTS,
  ui: UI,
  // A panel that starts a run with its own request (a compare, a pipeline, a restore) calls this with the runId of its first
  // event, so the events channel does not draw that run as one started in another window.
  claimRun: id => { if (typeof id === 'string' && id) claimed.add(id); },
  // The side pane: panels register a tab (pane.register) and open it (pane.open). See the side pane section above.
  pane: PANE,
  // Settings sections: scope 'app' for the Settings drawer, 'project' for the project settings drawer (settings.open).
  settings: SETTINGS,
  // Opens the Settings page at a group or section and, with an id, at a row in it (a section reads the id as ctx.item).
  openSettings: openSettingsAt,
  // Computer use: the panel (also /computer and the + menu), one computer run sent as a chat turn, and the list of past runs.
  openComputer,
  sendComputer,
  openComputerRuns,
  // Overwritable. public/ext-notices.js assigns the real notice strip and risk here. A notice is information, so the stub draws
  // nothing; a risk is a question, so the stub asks with the caller's own text (confirmBox) rather than allowing the switch.
  notice: (id, { before, after } = {}) => null,
  risk: (id, opts = {}) => confirmBox({ title: opts.title ?? 'Continue?', body: opts.body ?? '', action: opts.action ?? 'Continue', tone: opts.tone ?? '', focusCancel: opts.focusCancel === true }),
  // MuseUI.confirm replaces window.confirm and window.prompt everywhere (see confirmBox).
  confirm: opts => confirmBox(opts ?? {}),
  // The last chat send, kept until its run goes through (B-5). ext-connection.js reads it for Retry.
  get lastSent() { return lastSent; },
  // Approval settings: setProjectApprovals(patch) changes the active project's, askApproveAll() is the Approve all question.
  setProjectApprovals,
  askApproveAll,
  approvalNames: APPROVAL_NAMES,
  approvalModes: APPROVAL_MODES,
  dialogOpen,
  el, span, button, para, icon, cardShell, modelName, stream: () => streamEl ?? el.chat,
  get state() { return S; },
  get catalog() { return catalog; },
  get aliases() { return aliases; },
  get providers() { return providers; },
};

// The + menu item that opens the Computer panel (UI-ARCH 2: "Use the computer…"). The menu itself reads the plusMenu slot.
window.MuseUI.slots.add('plusMenu', 'computer', { label: 'Use the computer…', icon: 'shield', run: () => openComputer() }, 30);

boot();
