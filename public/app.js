const H = { 'content-type': 'application/json', 'x-muse-console': '1' };
const $ = id => document.getElementById(id);

// The desktop app draws its own title bar, so the stylesheet keeps the window buttons clear.
if (/\bElectron\//.test(navigator.userAgent)) document.documentElement.dataset.shell = 'desktop';

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
  approvalBtns: [...document.querySelectorAll('.seg-btn[data-approvals]')],
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
  themeBtn: $('themeBtn'),
  themeValue: $('themeValue'),
  drawer: $('drawer'),
  drawerTitle: $('drawerTitle'),
  drawerBody: $('drawerBody'),
  drawerClose: $('drawerClose'),
  scrim: $('scrim'),
  toasts: $('toasts'),
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
const GEMINI_EDIT = 'Gemini edits files only when Auto-approve is on. Headless Gemini cannot ask first.';
const GEMINI_EFFORT = 'The Gemini CLI sets its own thinking depth';
const GEMINI_INSTALL = 'Install the Gemini CLI with npm install --prefix "%USERPROFILE%\\.muse-console\\tools" @google/gemini-cli on Windows, or npm install --prefix "$HOME/.muse-console/tools" @google/gemini-cli on macOS and Linux, then come back here.';

// aliases are other words that run the same command (/stop runs /cancel). They are found by the palette and the drawer too.
const COMMANDS = [
  { name: 'help', aliases: ['commands'], args: '', desc: 'Show all commands' },
  { name: 'model', args: '[name]', desc: 'Switch the model that answers' },
  { name: 'models', args: '', desc: 'List models and short names' },
  { name: 'advisor', args: '[sonnet|opus|fable|off|auto]', desc: 'Pick the reviewer model. Try /advisor sonnet' },
  { name: 'review', args: '', desc: 'Review the last answer against the working changes' },
  { name: 'approvals', args: '[ask|auto]', desc: 'Ask before edits and commands, or auto-approve' },
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
};
const TOOL_ICONS = {
  list_dir: 'folder', read_file: 'file', search_text: 'search', write_file: 'file-plus',
  edit_file: 'pencil', run_command: 'terminal', propose_update: 'update',
  Read: 'file', Glob: 'folder', Grep: 'search', Write: 'file-plus', Edit: 'pencil', NotebookEdit: 'pencil',
  Bash: 'terminal', PowerShell: 'terminal', WebFetch: 'layers', WebSearch: 'search',
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
let abortCtl = null;
let updates = [];
let streamEl = null;
let paletteItems = [];
let paletteIndex = 0;
let drawerRender = null;
let mode = 'chat';        // what Send does: 'chat' asks the main model, 'council' asks every seat
let routeRun = null;      // the auto relay that is running: { limit, hop, paused }
let routeDraft = null;    // the route panel's choices, kept while it is open
let accountsFocus = '';   // a card the Accounts drawer scrolls to when it opens
let boardPills = [];      // the seat pills on the board, updated in place
let followUps = [];       // messages typed during a run, oldest first: [{ project, text }], at most MAX_QUEUED (see queueFollowUp)
let queueLine = null;     // the line above the composer that counts queued follow-ups; built when first needed
let queueWatch = null;    // the timer that reads the state while a run has no stream of ours to show it
let queueDrawn = [];      // the follow-ups the rows in the queue line show, so a redraw that changes nothing keeps focus on a button

// ---------- helpers ----------

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: H, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

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
  return Boolean(abortCtl) || S.running;
}

// A details element whose open state survives redraws: the choice is kept in `store` under `key`.
function trackOpen(store, key, d, fallback) {
  d.open = store[key] ?? fallback;
  d.addEventListener('toggle', () => { store[key] = d.open; });
  return d;
}

function toast(message, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  el.toasts.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 5200 : 3200);
}

function stickBottom() {
  const c = el.chat;
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 180) c.scrollTop = c.scrollHeight;
}

function stream() {
  return streamEl;
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
  const head = span('approval-head', 'Approval needed');
  head.prepend(icon('shield'));
  card.append(head, span('approval-summary', ev.summary));
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
    if (!typing && (first || idle)) {
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
  for (const tool of m.tools ?? []) {
    nodes.push(toolEl(tool.name, tool.summary, tool.ok ? 'done' : 'failed', tool.result));
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
  for (const b of el.approvalBtns) b.setAttribute('aria-pressed', String(b.dataset.approvals === (S.approvals ?? 'ask')));
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
  if (S.running || abortCtl) {
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
  abortCtl = new AbortController();
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
  const watch = ev => {
    if (ev.type === 'done' || ev.type === 'error') reported = true;
    onEvent(ev);
  };
  try {
    const res = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body), signal: abortCtl.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    await readSSE(res, watch);
    if (!reported) throw new Error('The run ended before it finished. Try again.');
  } catch (err) {
    ok = false;
    if (err.name !== 'AbortError') {
      notes.push(`Error: ${err.message}`);
      stream().append(errorEl(err.message));
    }
  } finally {
    clearInterval(clock);
    abortCtl = null;
    routeRun = null;
    renderRouteBar();
    setBusy(false);
    await refresh();
    await loadUpdates();
    // The run is over, however it ended (Stop included): the next queued message, if there is one, starts now.
    scheduleDrain();
  }
  return ok;
}

// A chat turn, a relay send or a relay route. Each seat has a lane of its own, so the parallel
// replies of a broadcast stay apart; a chain's hops arrive one after another in the same way.
function streamTurn(url, body) {
  const tools = new Map();
  const lanes = new Map();
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
    stream().append(t.article);
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
      stream().append(stepNote);
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
      case 'tool': {
        if (ln.current && !ln.current.text) ln.current.article.remove();
        ln.current = null;
        const d = toolEl(ev.name, ev.summary, 'running');
        d.classList.add('fresh');
        tools.set(ev.id, d);
        stream().append(d);
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
        stream().append(approvalEl(ev));
        cue('approval');
        stickBottom();
        break;
      case 'error':
        if (ln.current && !ln.current.text) ln.current.article.remove();
        ln.current = null;
        // Kept in the notes so the end-of-turn refresh does not wipe it.
        notes.push(`Error: ${ev.message}`);
        stream().append(errorEl(ev.message));
        cue('error');
        stickBottom();
        break;
      case 'notice':
        // A short note from the server, such as a session that had to start again with the transcript.
        stream().append(systemTurn(ev.text));
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
          stream().append(errorEl(ev.error || 'A hop failed.'));
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
  return runStream(url, body, onEvent, { tick });
}

// Images picked in the composer (public/ext-images.js) go with the next chat message to a model that takes them. A queued
// message brings the images it was queued with. Without that script there are none.
const pickedImages = () => window.MuseImages?.list() ?? [];
// The reason a model cannot take the images, in the server's words, or '' when it can (or when there are none).
const imageRefusal = (list, model) => (list.length && window.MuseImages && !window.MuseImages.takes(model) ? window.MuseImages.REFUSAL : '');

async function sendMessage(text, model, images) {
  if (text.length > 14_000_000) return toast('That message is too long to send (over 14 million characters). Split it up or attach the file with @path.', 'bad');
  if (!S.activeProject) {
    openAddForm();
    return toast('Add a project folder first.', 'bad');
  }
  if (S.running && !abortCtl) return toast('This project is already running. Use /cancel first.', 'bad');
  const sent = images ?? pickedImages();
  const refusal = imageRefusal(sent, model);
  if (refusal) return toast(refusal, 'bad');
  if (!images) window.MuseImages?.clear();
  notes = [];
  S.messages.push({ role: 'user', kind: 'chat', content: text, ts: Date.now(), ...(sent.length ? { images: sent.map(({ name, size }) => ({ name, size })) } : {}) });
  renderChat();
  stream().lastElementChild?.classList.add('fresh');
  await streamTurn('/api/chat', { project: S.activeProject, message: text, model, ...(sent.length ? { images: sent.map(({ name, mime, data }) => ({ name, mime, data })) } : {}) });
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
  const next = followUps.shift();
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
  if (el.input.value.trim()) return toast('The composer already has text. Send or clear it first.', 'bad');
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
  if (!queueWatch && !abortCtl && S.running) queueWatch = setInterval(watchRun, 2000);
}

// While a run goes on that no stream of ours carries (one started in another window, one still going after a reload, or a
// stopped one still winding down on the server), the state is read every two seconds and the page is redrawn only when the
// run or the chat has changed. The timer stops once the project is idle, and the next queued message then starts.
async function watchRun() {
  if (abortCtl) return;
  try {
    const next = await api('/api/state');
    if (abortCtl) return;
    const changed = next.running !== S.running || next.activeProject !== S.activeProject || next.messages.length !== S.messages.length;
    if (changed) {
      S = next;
      renderAll();
    }
    if (!S.running) {
      clearInterval(queueWatch);
      queueWatch = null;
      scheduleDrain();
    }
  } catch {
    // The next tick tries again.
  }
}

// /compact: the main model writes a summary, which then replaces the chat.
async function compact() {
  if (!S.activeProject) return toast('Add a project folder first.', 'bad');
  if (S.running || abortCtl) return toast('This project is already running. Use /cancel first.', 'bad');
  if (S.messages.filter(m => m.kind === 'chat').length < 2) return toast('There is not enough conversation to compact yet.');
  abortCtl = new AbortController();
  setBusy(true);
  const t = makeTurn('assistant', { label: modelName(S.model), provider: providerOf(S.model) });
  t.article.classList.add('fresh');
  t.body.innerHTML = THINKING.replace('Thinking', 'Summarising the conversation');
  stream().append(t.article);
  el.chat.scrollTop = el.chat.scrollHeight;
  try {
    const res = await fetch('/api/compact', { method: 'POST', headers: H, body: JSON.stringify({ project: S.activeProject }), signal: abortCtl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    S = data;
    notes = [];
    toast(`Compacted ${data.compacted} messages into a summary`);
  } catch (err) {
    toast(err.name === 'AbortError' ? 'Compacting was cancelled. The chat is unchanged.' : err.message, 'bad');
  } finally {
    abortCtl = null;
    setBusy(false);
    await refresh();
    scheduleDrain();
  }
}

async function review() {
  if (!S.activeProject) return toast('Add a project folder first.', 'bad');
  if (!S.advisor) return toast('The advisor is off. Try /advisor sonnet.', 'bad');
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
    for (const r of [1, 2]) {
      const text = s[`round${r}`];
      if (typeof text === 'string') rounds[r] = { text, state: 'done', ...seatMeta(text) };
    }
    if (s.error) {
      const r = rounds[1] ? 2 : 1;
      rounds[r] = { ...(rounds[r] ?? {}), text: rounds[r]?.text ?? '', state: 'failed', error: s.error };
    }
    return { id: s.id, label: s.label, ref: s.ref ?? '', role: s.role, effort: s.effort, rounds };
  });
  return {
    question: c.question ?? '',
    rounds: seats.some(s => s.rounds[2]) ? 2 : 1,
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
  const latest = [2, 1].map(r => s.rounds[r]).find(r => r && r.confidence != null);
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
  if (data.state === 'done' && r === 2 && data.changed) label = data.changed === 'yes' ? 'Changed its view' : 'Kept its view';
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
      live.replaceWith(next);
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
  stream().append(live);
  live.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  let queued = false;
  const paint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!live.isConnected) return;
      const next = councilEl(cd);
      live.replaceWith(next);
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
  body.append(para('The last hops in this project: when, which seats, how many characters, and a short fingerprint of the text. The text itself is never kept.'));
  let records = [];
  try {
    records = (await api(`/api/relay/log?project=${encodeURIComponent(S.activeProject ?? '')}`)).records ?? [];
  } catch (err) {
    body.append(para(err.message));
    return;
  }
  if (drawerRender !== renderRelayLog) return;
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
    updates = (await api('/api/updates')).updates;
  } catch {
    updates = [];
  }
  renderBadge();
}

async function update(body) {
  S = await api('/api/settings', body);
  renderAll();
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
  el.drawerTitle.textContent = title;
  el.drawerBody.replaceChildren();
  el.drawer.hidden = false;
  el.scrim.hidden = false;
  drawerRender = render;
  render(el.drawerBody);
}

function closeDrawer() {
  el.drawer.hidden = true;
  el.scrim.hidden = true;
  drawerRender = null;
}

function refreshDrawer() {
  if (drawerRender && !el.drawer.hidden) {
    el.drawerBody.replaceChildren();
    drawerRender(el.drawerBody);
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
  const signIn = button('primary small', c.connected ? 'Sign in again' : 'Sign in with Claude');
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
  const signIn = button('primary small', m.signedIn ? 'Sign in again' : 'Sign in with Meta account');
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
  const signIn = button('primary small', c.loggedIn ? 'Sign in again' : 'Sign in with ChatGPT');
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
  card.append(para('Gemini runs headless, so it edits files only in Auto-approve mode.'));
  const actions = document.createElement('div');
  actions.className = 'actions';
  const signIn = button('primary small', g?.signedIn ? 'Sign in again' : 'Sign in with Gemini');
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
  return card;
}

async function renderAccounts(body) {
  body.append(para('Checking your accounts…'));
  let a;
  try {
    a = await api('/api/accounts');
  } catch (err) {
    body.replaceChildren(para(err.message));
    return;
  }
  body.replaceChildren(claudeCard(a.claude), museCard(a.muse), codexCard(a.codex), geminiCard(a.gemini));
  body.append(Object.assign(document.createElement('p'), { textContent: 'Keys and sign-ins stay on this computer. Plenum sends them only to the provider they belong to.' }));
  if (accountsFocus) {
    body.querySelector(`[data-card="${accountsFocus}"]`)?.scrollIntoView({ block: 'start' });
    accountsFocus = '';
  }
}

function openAccounts() {
  openDrawer('Accounts', renderAccounts);
}

async function renderUpdates(body) {
  try {
    updates = (await api('/api/updates')).updates;
  } catch (err) {
    body.append(para(err.message));
    return;
  }
  renderBadge();
  if (!updates.length) {
    body.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing to review. When Claude proposes a change to Plenum, it appears here.' }));
    return;
  }
  for (const u of updates) body.append(updateCard(u));
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
  if (!confirm(`Apply "${u.summary}"?\n\nFiles: ${names}\n\nThe current versions are backed up first, then Plenum restarts.`)) return;
  try {
    await api('/api/updates/apply', { id: u.id });
    toast('Applied. Restarting Plenum…');
    const back = await waitForServer();
    if (back) location.reload();
    else toast('The server did not come back within a minute. Restart it from the Start menu.', 'bad');
  } catch (err) {
    toast(err.message, 'bad');
  }
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
  const wait = document.createElement('div');
  wait.className = 'empty';
  wait.innerHTML = THINKING.replace('Thinking', 'Asking each provider');
  body.append(wait);
  let u;
  try {
    u = await api('/api/usage');
  } catch (err) {
    body.replaceChildren(para(err.message));
    return;
  }
  if (drawerRender !== renderUsage) return;
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
  openDrawer('Updates to Plenum', renderUpdates);
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
        const choice = arg.toLowerCase();
        if (!choice) return toast(`Approvals: ${S.approvals === 'auto' ? 'auto-approve' : 'ask first'}. Set with /approvals ask|auto.`);
        if (choice !== 'ask' && choice !== 'auto') return toast('Approvals must be ask or auto.', 'bad');
        await update({ approvals: choice });
        return toast(S.approvals === 'auto' ? 'Edits and commands run without asking.' : 'Edits and commands wait for your approval.');
      }
      case 'theme': {
        const theme = arg.toLowerCase();
        if (!theme) return toast(`Theme: ${THEMES[currentTheme()]}. Set with /theme system|dark|light.`);
        if (!THEMES[theme]) return toast('Theme must be system, dark or light.', 'bad');
        await setTheme(theme);
        return toast(`Theme: ${THEMES[theme]}`);
      }
      case 'usage':
      case 'limits':
        return openDrawer('Usage and limits', renderUsage);
      case 'compact':
        return compact();
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
        return askCouncil(arg);
      }
      case 'build':
        return buildLast();
      case 'relay':
        return openDrawer('Relay route', renderRelayPanel);
      case 'review':
        return review();
      case 'ask': {
        const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
        if (!m) return toast('Usage: /ask <model> <message>, for example /ask claude hello', 'bad');
        return sendMessage(m[2], m[1]);
      }
      case 'plan':
        if (!arg) return toast('Usage: /plan <task>', 'bad');
        return sendMessage(`Make a step-by-step plan for the task below. Do not modify any files yet. List the files you would touch and the main risks.\n\nTask: ${arg}`);
      case 'add':
        if (!arg) return toast('Usage: /add <folder path>', 'bad');
        return addFolder(arg);
      case 'project':
      case 'switch': {
        if (!arg) return toast(S.projects.map(p => p.name).join(', ') || 'No projects yet.');
        const p = findProject(arg);
        if (!p) return toast(`No project "${arg}".`, 'bad');
        return switchProject(p);
      }
      case 'remove':
      case 'forget': {
        const p = findProject(arg);
        if (!p) return toast(`No project "${arg}".`, 'bad');
        return removeProject(p);
      }
      case 'clear':
      case 'reset':
        if (!S.activeProject) return toast('No project selected.', 'bad');
        // A short chat is cleared at once. A longer one is asked about first, so a mistyped /clear costs nothing.
        if (S.messages.filter(m => m.kind === 'chat').length >= 4 && !confirm('Clear this chat? Undo stays available above the composer until you send the next message.')) return;
        S = await api('/api/clear', { project: S.activeProject });
        notes = [];
        renderAll();
        return toast('Chat cleared. Undo is above the composer.');
      case 'cancel':
      case 'stop':
        return cancelRun();
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
  if (abortCtl) {
    abortCtl.abort();
    return toast('Stopping…');
  }
  if (!S.activeProject) return toast('Nothing is running.');
  const { cancelled } = await api('/api/cancel', { project: S.activeProject });
  toast(cancelled ? 'Cancel sent.' : 'Nothing is running in this project.');
}

// ---------- wiring ----------

el.form.addEventListener('submit', e => {
  e.preventDefault();
  if (abortCtl) {
    abortCtl.abort();
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

el.input.addEventListener('input', () => {
  autosize();
  paletteIndex = 0;
  updatePalette();
  commandHint();
});

el.input.addEventListener('keydown', e => {
  const paletteOpen = !el.palette.hidden && paletteItems.length;
  // Enter picks the highlighted command, unless the composer already holds exactly that command or the alias typed (/stop).
  const picked = paletteItems[paletteIndex];
  const typedExact = Boolean(picked) && (el.input.value === `/${picked.name}` || (Boolean(picked.alias) && el.input.value === `/${picked.alias}`));
  if (paletteOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    movePalette(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (paletteOpen && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !typedExact))) {
    e.preventDefault();
    pickCommand(paletteIndex);
    return;
  }
  // Escape closes the list first. Only when no list is open does it stop a run, so a second Escape is the one that stops it.
  if (e.key === 'Escape') {
    if (!el.palette.hidden) {
      hidePalette();
      return;
    }
    if (abortCtl) abortCtl.abort();
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
for (const b of el.approvalBtns) {
  b.addEventListener('click', () => update({ approvals: b.dataset.approvals }).catch(onSettingError));
}
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
el.themeBtn.addEventListener('click', () => {
  const order = Object.keys(THEMES);
  setTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]).catch(onSettingError);
});
systemIsLight.addEventListener('change', syncTheme);
el.drawerClose.addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeRelayMenus();
  if (e.key === 'Escape' && !el.drawer.hidden) closeDrawer();
  // A slash typed into a field (the composer, the approval reason, the add-project path) is text, so the shortcut leaves it alone.
  const at = document.activeElement;
  const typing = Boolean(at?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(at?.tagName ?? '');
  if (e.key === '/' && !typing && el.drawer.hidden && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    el.input.focus();
    if (!el.input.value) el.input.value = '/';
    autosize();
    updatePalette();
  }
});

async function boot() {
  syncTheme();
  try {
    await loadProviders();
  } catch (err) {
    notes.push(`Cannot load status (${err.message}).`);
  }
  await refresh();
  await loadUpdates();
  initMusic();
  renderAll();
}

// The surface the extra panels (public/ext-*.js) build on. It exposes what they need and changes nothing itself.
window.MuseUI = {
  api, toast, openDrawer, closeDrawer, refreshDrawer, refresh, renderAll, renderTop, update, copyText,
  el, span, button, para, icon, cardShell, modelName, stream: () => streamEl ?? el.chat,
  get state() { return S; },
  get catalog() { return catalog; },
  get aliases() { return aliases; },
  get providers() { return providers; },
};

boot();
