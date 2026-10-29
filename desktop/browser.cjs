'use strict';
// The in-app web browser (brw-02): one WebContentsView per tab, in its own persistent cookie store (partition persist:plenum-browser),
// drawn by Electron over the app window where the Browser pane's placeholder is. desktop/handlers/browser.cjs routes the server's
// browser-* messages here; lib/browser-bridge.mjs is the server's end. This file imports Electron only inside createBrowser (and a test
// passes its own `electron`), so it loads without the app.
//
// What a page can and cannot do:
//  - The view has contextIsolation, sandbox and webSecurity on, no Node and no preload, and devTools off. DevTools never open.
//  - Only http and https addresses load: the server checks each address and this file checks it again; a page's own navigation, a
//    redirect to anything else and a window.open of anything else are stopped.
//  - Pop-ups open as tabs (the page that asked is not given the new window). At most 16 tabs. While the model drives, a pop-up opens
//    in the background so the tab it is working in does not change.
//  - Downloads are not written until a person says so. A download starts into a private temp folder and is paused; a question goes to
//    the pane ("Save <name> (<size>) to Downloads?"), or to the chat while the model drives. Save moves the finished file into the
//    chosen folder (the system Downloads folder, or a folder chosen in the pane that the server has checked); Cancel deletes it.
//    "Block all downloads" (state file, browser.blockDownloads) cancels every download at once. The file is never opened or run.
//  - Permissions (camera, microphone, location, notifications, clipboard) ask the pane while a person drives, with Allow or Deny kept
//    per site for the session. While the model drives, every one is denied. Anything else (MIDI, USB, screen capture, ...) is denied.
//
// Messages (the server's, each answered with an object that the handler posts as `${type}-result` with the same id):
//   browser-open { url, wait? }  browser-navigate { tab?, url, wait? }  browser-back | browser-forward | browser-reload { tab?, wait? }
//   browser-tabs { action: 'new' | 'close' | 'select', tab?, url?, select? }  browser-bounds { x, y, width, height, visible, snapshot?, keep? }
//   browser-hide {}  browser-state {}  browser-screenshot { tab?, maxEdge? } -> { png, width, height }  browser-driving { agentDriving }
//   browser-download-answer { download, allow, dir? }  browser-permission-answer { permission, allow }  browser-permission-reset {}  browser-clear {}
//   browser-snapshot { tab?, maxElements?, maxChars? } -> { url, title, text, elements, password, captcha, ... }   (brw-03)
//   browser-act { tab?, action, ref?, expect?, text?, value?, key?, direction?, amount?, submit? } -> { ok, url?, title?, ... }   (brw-03)
//   browser-frame { tab?, maxEdge? } -> { ok, image (a JPEG data URL), width, height, shown, cached? }   (mob-20: a phone looks at the pane)
//   browser-input { tab?, kind: 'tap' | 'scroll' | 'type' | 'key', x?, y?, width?, height?, dx?, dy?, text?, key?, count?, paused? }   (mob-20)
// (`download` and `permission` name the question being answered; a message's own `id` is the server's request id and is never reused.)
// `wait: true` makes open, navigate, back and reload answer when the page has loaded (or after 15 seconds), with its address and title.
// Events it sends on its own (through `tell`, as { type: 'browser-event', kind, ... }): tabs, popup-blocked, download-blocked,
// download-request, download-gone, download-saved, download-failed, permission-request, permission-gone, key.
// browser-bounds with keep: true is a phone's call (the Bridge adds it): it takes the picture and leaves the page view where the desktop put it,
// because the desktop's own pane puts its view back on every 2 seconds and would blink. The views of a desktop call are unchanged.
// Nothing here logs a page's address, title or content. Cookies and page content never leave this process: only addresses, titles,
// file names, sizes and, on request, a picture of the page.
//
// The model's tools (brw-03): browser-snapshot and browser-act run the fixed scripts in desktop/browser-snapshot.js, read once when this
// file loads, in an isolated world of the page (the page's own scripts cannot change them). What reaches a script is data only: limits
// as numbers, a ref that matches /^e\d{1,4}$/, and strings that are read as data. A click, a key and the text typed go in through
// Electron's input (sendInputEvent, insertText), so the page sees real events. Input reaches a page only while its view is on the
// window, so a view that is not shown is put on the window's right edge with one pixel inside it for the moment of the action.
// A page's answer is cut and checked here (cleanSnapshot) before it leaves. A password, one-time code or card field is never typed
// into by 'type'; only 'type-secret', which the person starts from the pane, types into one, and it reads nothing back.
//
// A phone (mob-20): browser-frame is a JPEG of the page made only when a phone asks for one, at most five a second (a frame asked for sooner
// is the last one, with cached: true). browser-input is the person's own hand: the tap, the scroll, the typing and the key arrive from the
// phone as the person would make them, through the same real input as the model's click (withLive, deliver, sendClick), but they do not
// go through browser-act, so none of the model's refusals apply to them and the model's tools are not involved. What a person types
// into a password or code field from their phone is theirs: it goes to the page and is read back by nobody, kept nowhere, and left out of
// every reply, log line and event. While the model drives, the server says by paused: true that the person has paused it; without that
// the input is refused here too. Input needs the Plenum window to be showing (it is never shown for it).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PARTITION = 'persist:plenum-browser';
const MAX_TABS = 16;
const MAX_URL = 2048;
const MAX_TITLE = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REF_RE = /^e\d{1,4}$/;
const DOWNLOAD_ASK_MS = 5 * 60 * 1000;
const PERMISSION_ASK_MS = 2 * 60 * 1000;
const CAPTURE_MS = 4000;
// The longest edge of the picture kept while something covers the page.
const COVER_PICTURE_EDGE = 1280;
// The model's tools: the world the scripts run in (999 is Electron's own), how long one may take, and how long a page gets to settle.
const SCRIPT_WORLD = 1337;
const SCRIPT_MS = 10_000;
const SETTLE_QUICK_MS = 350;
const SETTLE_MAX_MS = 12_000;
const LOAD_WAIT_MS = 15_000;
const MAX_TYPED = 5000;
// A phone's frames: at most five a second, a picture of at most FRAME_EDGE on its longest side unless the phone asks for another size.
const FRAME_MIN_MS = 200;
const FRAME_EDGE = { min: 200, max: 1600, default: 960 };
const FRAME_QUALITY = 60;
// A phone's typing, scrolling and keys.
const MAX_PERSON_TEXT = 1000;
const MAX_SCROLL = 4000;
const PERSON_KINDS = new Set(['tap', 'scroll', 'type', 'key']);
const SCREENSHOT_EDGE = { min: 200, max: 4000 };
// Two animation frames, run in the isolated world: when they have passed, the page has been laid out at the size its view has now and
// has drawn what the last action changed (a scroll), so a click lands where the page really is. A page that is not drawing gives up
// after FRAMES_MS.
const FRAMES_CODE = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';
const FRAMES_MS = 700;
// The keys the model may press, as Electron names them.
const KEYS = Object.freeze({
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp',
  PageDown: 'PageDown', Home: 'Home', End: 'End',
});
// The keys a person may press from the phone, as Electron names them: the model's keys, and the two that erase.
const PERSON_KEYS = Object.freeze({ ...KEYS, Backspace: 'Backspace', Delete: 'Delete' });
const ACT_ACTIONS = new Set(['click', 'type', 'type-secret', 'select', 'press', 'scroll', 'focus-info']);
const NEEDS_REF = new Set(['click', 'type', 'select']);
const SECRET_REFUSAL = 'This looks like a password, code or payment field. Plenum never types those.';
const HIDDEN_WINDOW = 'The Plenum window is hidden, so taps cannot be sent. Show the window on the computer.';
const MODEL_USING = 'The model is using this browser. Pause it first.';

const NOT_HTTP = 'Only http and https addresses can be opened.';
const NO_TAB = 'There is no such tab.';
const TAB_LIMIT = `At most ${MAX_TABS} tabs can be open. Close one first.`;
const FAILED = 'The browser could not do that.';

// The fixed scripts, read once. If the file is missing the two messages answer with a sentence and everything else works.
let SNAPSHOT_SRC = null;
try {
  SNAPSHOT_SRC = fs.readFileSync(path.join(__dirname, 'browser-snapshot.js'), 'utf8');
} catch {
  SNAPSHOT_SRC = null;
}

// The message types desktop/handlers/browser.cjs registers. createBrowser().types is the same list; the tests compare them.
const MESSAGE_TYPES = Object.freeze([
  'browser-open', 'browser-navigate', 'browser-back', 'browser-forward', 'browser-reload', 'browser-tabs', 'browser-bounds', 'browser-hide',
  'browser-state', 'browser-screenshot', 'browser-driving', 'browser-download-answer', 'browser-permission-answer', 'browser-permission-reset',
  'browser-clear', 'browser-snapshot', 'browser-act', 'browser-frame', 'browser-input',
]);

// File types that can start a program when opened. The pane adds a line for them; the download is not refused.
const RISKY = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg', 'dll', 'cpl', 'msc', 'pif', 'apk', 'dmg', 'pkg', 'app', 'sh', 'command', 'appimage', 'deb', 'rpm', 'msix', 'appx', 'docm', 'xlsm', 'pptm']);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// The address when it is an http or https address of at most 2048 characters with no user name or password; otherwise null. The same
// rule as lib/browser-urls.mjs, without guessing a scheme: the server has already done that.
function httpUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href.length <= MAX_URL ? url.href : null;
}

// Any http or https address (a page's own navigation may carry credentials; those are the page's business).
const isHttp = raw => {
  try {
    const p = new URL(raw).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};

const originOf = raw => {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
};

const hostOf = raw => {
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
};

// A file name that is safe to create in a folder: no folders, no characters Windows refuses, no reserved device names, no stream
// suffix, no leading or trailing dots or spaces, at most 150 characters with the extension kept. Never empty.
function safeFileName(name) {
  let base = String(name ?? '');
  base = base.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\.+/, '_').replace(/[. ]+$/, '');
  if (!base) base = 'download';
  if (RESERVED.test(base)) base = `_${base}`;
  if (base.length > 150) {
    const ext = path.extname(base);
    base = ext && ext.length <= 20 ? base.slice(0, 150 - ext.length) + ext : base.slice(0, 150);
  }
  return base;
}

const isRisky = name => RISKY.has(path.extname(name).slice(1).toLowerCase());

// The kinds of permission a request names, or null for one that is always denied. Sorted, so a pair has one key.
function permissionKinds(permission, details, forCheck) {
  switch (permission) {
    case 'media': {
      const types = forCheck ? [details?.mediaType] : details?.mediaTypes;
      const list = Array.isArray(types) ? types : [];
      const kinds = [];
      if (list.includes('video')) kinds.push('camera');
      if (list.includes('audio')) kinds.push('microphone');
      return kinds.length ? kinds : ['camera', 'microphone'];
    }
    case 'geolocation':
      return ['location'];
    case 'notifications':
      return ['notifications'];
    case 'clipboard-read':
      return ['clipboard-read'];
    case 'clipboard-sanitized-write':
      return ['clipboard-write'];
    default:
      return null;
  }
}

const KIND_WORDS = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  location: 'see your location',
  notifications: 'show notifications',
  'clipboard-read': 'read what you have copied',
  'clipboard-write': 'copy text to your clipboard',
};

function permissionLabel(kinds) {
  if (kinds.includes('camera') && kinds.includes('microphone')) return 'use your camera and microphone';
  return kinds.map(k => KIND_WORDS[k] ?? k).join(' and ');
}

const sleepUnref = (ms, fn) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
};

// ---------- what a page tells the model's tools ----------

// A page's text is data from a stranger: every string is cut and stripped of control characters, every number is made finite, and
// nothing that is not in the shape below comes through. `line` keeps one line; `block` keeps line breaks and tabs.
const line = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const block = (v, n) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, n) : '');
const whole = v => (Number.isFinite(v) ? Math.max(-1_000_000, Math.min(1_000_000, Math.round(v))) : 0);
const clampInt = (v, min, max, fallback) => (Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback);

// The answer of the snapshot script, checked: at most limits.maxElements controls with a valid ref, at most limits.maxChars of text,
// and no value for a password or other secret field, whatever the page said. Returns null when it is not an object.
function cleanSnapshot(raw, limits) {
  if (!isObject(raw)) return null;
  const elements = [];
  for (const e of Array.isArray(raw.elements) ? raw.elements.slice(0, limits.maxElements) : []) {
    if (!isObject(e) || typeof e.ref !== 'string' || !REF_RE.test(e.ref)) continue;
    const item = {
      ref: e.ref, role: line(e.role, 24) || 'clickable', name: line(e.name, 80), x: whole(e.x), y: whole(e.y), w: whole(e.w), h: whole(e.h),
      inForm: e.inForm === true, submit: e.submit === true,
    };
    const type = line(e.type, 20);
    if (type) item.type = type;
    const secret = e.secret === true || type === 'password';
    if (secret) item.secret = true;
    if (!secret && typeof e.value === 'string' && e.value) item.value = line(e.value, 60);
    if (typeof e.checked === 'boolean') item.checked = e.checked;
    if (e.disabled === true) item.disabled = true;
    const href = line(e.href, 80);
    if (href) item.href = href;
    if (e.post === true) item.post = true;
    if (e.sensitive === true) item.sensitive = true;
    const near = line(e.near, 160);
    if (near) item.near = near;
    elements.push(item);
  }
  const scroll = isObject(raw.scroll) ? raw.scroll : {};
  return {
    url: line(raw.url, MAX_URL),
    title: line(raw.title, MAX_TITLE),
    text: block(raw.text, limits.maxChars),
    textCut: raw.textCut === true,
    elements,
    password: raw.password === true,
    captcha: raw.captcha === true,
    truncated: raw.truncated === true,
    scroll: { y: whole(scroll.y), height: whole(scroll.height), view: whole(scroll.view) },
  };
}

// The expectation a click or a type carries from the snapshot: the control's kind and name, so a page that moved the ref to another
// control since is noticed. Only these two strings pass.
function cleanExpect(raw) {
  if (!isObject(raw)) return undefined;
  const out = {};
  if (typeof raw.role === 'string') out.role = line(raw.role, 24);
  if (typeof raw.name === 'string') out.name = line(raw.name, 80);
  return out;
}

// The code that runs one script function with its argument as data: the argument is JSON inside a JSON string, read by JSON.parse in the
// page, so no text in it is ever code. `method` is one of the two names the file defines.
function scriptCall(source, method, args) {
  if (method !== 'snapshot' && method !== 'act') throw new Error('Unknown script.');
  return `(${source}).${method}(JSON.parse(${JSON.stringify(JSON.stringify(args))}))`;
}

function createBrowser(options = {}) {
  const { win, tell, readSettings = () => ({}), log = () => {} } = options;
  const downloadsDirOption = options.downloadsDir ?? (() => path.join(os.homedir(), 'Downloads'));
  const tempDir = options.tempDir ?? (() => os.tmpdir());
  const electron = options.electron ?? require('electron');
  const { WebContentsView } = electron;
  const ses = electron.session.fromPartition(PARTITION);

  // The system Downloads folder, read once at the start (see the session section). It is never asked for again, because the app's own
  // download folder is pointed at a private folder from then on.
  const downloadsDir = () => realDownloads || path.join(os.homedir(), 'Downloads');

  const tabs = new Map(); // id -> { id, view, wc, crashed, error }
  const order = [];
  let active = null;
  let attached = null; // the id of the tab whose view is on the window
  let bounds = null; // the last visible request: { x, y, width, height }
  let wantVisible = false;
  let boundsSeq = 0;
  let agentDriving = false;
  let nextTab = 1;
  let destroyed = false;
  let pushQueued = false;
  let sessionDir = null; // the private folder Chromium writes in-progress downloads into
  let realDownloads = ''; // the system Downloads folder, read before the app's own download folder is pointed at sessionDir
  const remembered = new Map(); // `${origin}|${kind}` -> true | false, for this session
  const askedPermissions = new Map(); // id -> { id, origin, kinds, label, tab, embedded, callbacks, timer, at }
  const askedDownloads = new Map(); // id -> { id, item, dir, tempPath, name, tab, driving, at, timer, state, decision, destDir }

  // ---------- sending ----------

  function send(event) {
    if (destroyed || typeof tell !== 'function') return;
    try {
      tell({ type: 'browser-event', ...event });
    } catch {
      // The server went away; the next state read fills it in.
    }
  }

  function tabInfo(tab) {
    const info = { id: tab.id, url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false };
    try {
      const wc = tab.wc;
      if (!wc.isDestroyed()) {
        info.url = cut(wc.getURL(), MAX_URL) || 'about:blank';
        info.title = cut(wc.getTitle(), MAX_TITLE);
        info.loading = wc.isLoading();
        const history = wc.navigationHistory;
        info.canGoBack = history ? history.canGoBack() : Boolean(wc.canGoBack?.());
        info.canGoForward = history ? history.canGoForward() : Boolean(wc.canGoForward?.());
      }
    } catch {
      // A view that is going away is shown as it was.
    }
    if (tab.crashed) info.crashed = true;
    if (tab.error) info.error = tab.error;
    return info;
  }

  function snapshot() {
    return { tabs: order.map(id => tabInfo(tabs.get(id))), activeTab: active, remembered: remembered.size };
  }

  // One tabs event for any number of changes close together.
  function pushTabs() {
    if (pushQueued || destroyed) return;
    pushQueued = true;
    setImmediate(() => {
      pushQueued = false;
      send({ kind: 'tabs', ...snapshot() });
    });
  }

  // ---------- the view on the window ----------

  const winAlive = () => Boolean(win) && !(typeof win.isDestroyed === 'function' && win.isDestroyed());

  function detach() {
    if (!attached) return;
    const tab = tabs.get(attached);
    attached = null;
    if (!tab || !winAlive()) return;
    try {
      const content = win.contentView;
      if (typeof content.removeChildView === 'function') content.removeChildView(tab.view);
      else tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } catch {
      // The view is already off the window.
    }
  }

  // The page's pixels (CSS) are the window's DIPs times the app page's zoom factor.
  function placed() {
    const zoom = (() => {
      try {
        const z = win.webContents.getZoomFactor();
        return Number.isFinite(z) && z > 0 ? z : 1;
      } catch {
        return 1;
      }
    })();
    let x = Math.round(bounds.x * zoom);
    let y = Math.round(bounds.y * zoom);
    let width = Math.round(bounds.width * zoom);
    let height = Math.round(bounds.height * zoom);
    try {
      const [cw, ch] = win.getContentSize();
      x = Math.min(Math.max(0, x), cw);
      y = Math.min(Math.max(0, y), ch);
      width = Math.max(0, Math.min(width, cw - x));
      height = Math.max(0, Math.min(height, ch - y));
    } catch {
      // Without a size the numbers are used as given.
    }
    return { x, y, width, height };
  }

  function showActive() {
    if (!wantVisible || !bounds || !active || !winAlive()) return;
    const tab = tabs.get(active);
    if (!tab) return;
    if (attached && attached !== active) detach();
    if (!attached) {
      win.contentView.addChildView(tab.view);
      attached = active;
    }
    tab.view.setBounds(placed());
  }

  function hide() {
    boundsSeq += 1;
    wantVisible = false;
    detach();
  }

  // ---------- tabs ----------

  const tabFor = id => {
    const tab = tabs.get(id ?? active);
    return tab && !tab.wc.isDestroyed() ? tab : null;
  };
  const tabByWc = wc => {
    for (const tab of tabs.values()) if (tab.wc === wc) return tab;
    return null;
  };

  function dropAsksOf(tabId, reason) {
    for (const ask of [...askedPermissions.values()]) if (ask.tab === tabId) resolvePermission(ask.id, false, { remember: false });
    for (const entry of [...askedDownloads.values()]) if (entry.tab === tabId) endDownload(entry.id, reason);
  }

  function selectTab(id) {
    if (!tabs.has(id)) return false;
    active = id;
    if (wantVisible) showActive();
    pushTabs();
    return true;
  }

  function openTab(url, { select = true } = {}) {
    if (tabs.size >= MAX_TABS) return { ok: false, message: TAB_LIMIT };
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: PARTITION,
        spellcheck: false,
        devTools: false,
        safeDialogs: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
      },
    });
    try {
      view.setBackgroundColor('#ffffff');
    } catch {
      // A view without a background colour is transparent until the page paints.
    }
    // A view that is not on the window keeps a size, so a page loaded in the background lays out like a normal one.
    try {
      view.setBounds(bounds ? { x: 0, y: 0, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) } : { x: 0, y: 0, width: 1024, height: 768 });
    } catch {
      // The size is set again when the view is shown.
    }
    const id = `t${nextTab++}`;
    const tab = { id, view, wc: view.webContents, crashed: false, error: '' };
    tabs.set(id, tab);
    order.push(id);
    wire(tab);
    if (url) startLoad(tab, url);
    if (select || !active) selectTab(id);
    else pushTabs();
    return { ok: true, tab: id };
  }

  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return { ok: false, message: NO_TAB };
    const at = order.indexOf(id);
    dropAsksOf(id, 'tab-closed');
    if (attached === id) detach();
    tabs.delete(id);
    order.splice(at, 1);
    if (active === id) {
      active = order[at] ?? order[at - 1] ?? null;
      if (active && wantVisible) showActive();
    }
    try {
      if (!tab.wc.isDestroyed()) tab.wc.close({ waitForBeforeUnload: false });
    } catch {
      // The page is already closed.
    }
    pushTabs();
    return { ok: true, tab: active };
  }

  // A key pressed while the page has the focus. The app's own shortcuts that must keep working are handled or passed on (F6 and
  // Ctrl+L go to the app page); the keys that open DevTools or close the app window are swallowed.
  function onInput(tab, event, input) {
    if (input.type !== 'keyDown') return;
    const key = String(input.key ?? '');
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const lower = key.toLowerCase();
    if (key === 'F12' || ((input.control || input.meta) && input.shift && (lower === 'i' || lower === 'j' || lower === 'c'))) {
      event.preventDefault();
      return;
    }
    if (key === 'F6' || (mod && !input.shift && !input.alt && lower === 'l')) {
      event.preventDefault();
      send({ kind: 'key', key, ctrl: Boolean(input.control), shift: Boolean(input.shift), alt: Boolean(input.alt), meta: Boolean(input.meta) });
      return;
    }
    if (mod && !input.shift && !input.alt && lower === 't') {
      event.preventDefault();
      openTab(null, { select: true });
      return;
    }
    if (mod && !input.shift && !input.alt && lower === 'w') {
      event.preventDefault();
      closeTab(tab.id);
      return;
    }
    if (key === 'F5' || (mod && !input.alt && lower === 'r')) {
      event.preventDefault();
      try {
        tab.wc.reload();
      } catch {
        // Nothing to reload.
      }
      return;
    }
    if (input.alt && !mod && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      event.preventDefault();
      goHistory(tab, key === 'ArrowLeft' ? -1 : 1);
    }
  }

  function goHistory(tab, step) {
    const wc = tab.wc;
    const history = wc.navigationHistory;
    if (step < 0) {
      if (history ? history.canGoBack() : wc.canGoBack?.()) (history ? history.goBack() : wc.goBack());
    } else if (history ? history.canGoForward() : wc.canGoForward?.()) {
      (history ? history.goForward() : wc.goForward());
    }
  }

  function wire(tab) {
    const wc = tab.wc;
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const href = typeof url === 'string' && url.length <= MAX_URL && isHttp(url) ? url : null;
      if (href && tabs.size < MAX_TABS) {
        // A pop-up becomes a tab. A person who clicked gets the tab in front; while the model drives it stays behind.
        openTab(href, { select: !agentDriving && disposition !== 'background-tab' });
      } else {
        send({ kind: 'popup-blocked', url: cut(url, 300), reason: href ? 'tab-limit' : 'not-http' });
      }
      return { action: 'deny' };
    });
    // Newer Electron passes the address on the first argument (details.url); older versions pass it second.
    const blockOthers = (details, url) => {
      const target = typeof details?.url === 'string' ? details.url : url;
      if (!isHttp(target)) details.preventDefault();
    };
    wc.on('will-navigate', blockOthers);
    wc.on('will-redirect', blockOthers);
    wc.on('did-start-loading', () => {
      tab.crashed = false;
      pushTabs();
    });
    wc.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      const main = typeof isMainFrame === 'boolean' ? isMainFrame : details?.isMainFrame === true;
      const inPlace = typeof isInPlace === 'boolean' ? isInPlace : details?.isSameDocument === true;
      if (main && !inPlace) {
        tab.error = '';
        // A question the previous page asked is no longer about this page.
        for (const ask of [...askedPermissions.values()]) if (ask.tab === tab.id) resolvePermission(ask.id, false, { remember: false });
      }
    });
    for (const name of ['did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(name, () => pushTabs());
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) tab.error = cut(String(description || 'The page did not load.'), 200);
      pushTabs();
    });
    wc.on('render-process-gone', () => {
      tab.crashed = true;
      pushTabs();
    });
    wc.on('before-input-event', (event, input) => onInput(tab, event, input));
    wc.on('devtools-opened', () => {
      try {
        wc.closeDevTools();
      } catch {
        // devTools is off for this view anyway.
      }
    });
    wc.on('destroyed', () => {
      if (tabs.get(tab.id) === tab) {
        // The page closed itself (window.close) or crashed away: the tab goes.
        closeTab(tab.id);
      }
    });
  }

  // ---------- pictures ----------

  const pause = ms => new Promise(resolve => sleepUnref(ms, resolve));

  // A picture of one page (the page only, in device pixels). Electron can only capture a view that is on the window: one that is not
  // (the pane is closed, or the tab is in the background) is put just outside the window's edge for the moment the picture is taken,
  // where nobody sees it, and taken off again. The first frame of a view that has just been added can be empty, so an empty picture
  // is tried again a few times.
  async function capture(tab) {
    let borrowed = false;
    if (attached !== tab.id && winAlive()) {
      const size = bounds ?? { width: 1024, height: 768 };
      let edge = 2000;
      try {
        edge = win.getContentSize()[0] + 50;
      } catch {
        // The edge guessed above is far enough.
      }
      win.contentView.addChildView(tab.view);
      tab.view.setBounds({ x: edge, y: 0, width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) });
      borrowed = true;
      await pause(80);
    }
    try {
      let lastError = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const image = await Promise.race([
            tab.wc.capturePage(),
            new Promise((_resolve, reject) => sleepUnref(CAPTURE_MS, () => reject(new Error('capture timed out')))),
          ]);
          if (image && !image.isEmpty()) return image;
        } catch (err) {
          // A view that has only just been added answers "display surface not available" until its first frame.
          lastError = err;
        }
        await pause(150 + attempt * 100);
      }
      if (lastError) throw lastError;
      return null;
    } finally {
      if (borrowed && attached !== tab.id && winAlive()) {
        try {
          if (typeof win.contentView.removeChildView === 'function') win.contentView.removeChildView(tab.view);
          else tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        } catch {
          // The view is already off the window.
        }
      }
    }
  }

  // A JPEG data URL of the active page for the pane to show while something covers the view, or null.
  async function coverPicture(tab) {
    try {
      const image = await capture(tab);
      if (!image || image.isEmpty()) return null;
      const size = image.getSize();
      const edge = Math.max(size.width, size.height);
      const small = edge > COVER_PICTURE_EDGE ? image.resize({ width: Math.max(1, Math.round((size.width * COVER_PICTURE_EDGE) / edge)) }) : image;
      return `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`;
    } catch {
      return null;
    }
  }

  // A JPEG of the active page for a phone: { image (a data URL), width, height }, or null when there is nothing to show. A view that is on the
  // window is captured where it is; the rest is borrowed for the moment (see capture).
  async function frameOf(tab, longest, quality) {
    const image = await capture(tab);
    if (!image || image.isEmpty()) return null;
    const size = image.getSize();
    const edge = Math.max(size.width, size.height);
    const small = edge > longest ? image.resize({ width: Math.max(1, Math.round((size.width * longest) / edge)) }) : image;
    const out = small.getSize();
    return { image: `data:image/jpeg;base64,${small.toJPEG(quality).toString('base64')}`, width: out.width, height: out.height };
  }

  // ---------- permissions ----------

  const permissionKey = (origin, kind) => `${origin}|${kind}`;

  function resolvePermission(id, allow, { remember = true } = {}) {
    const ask = askedPermissions.get(id);
    if (!ask) return false;
    askedPermissions.delete(id);
    clearTimeout(ask.timer);
    if (remember) for (const kind of ask.kinds) remembered.set(permissionKey(ask.origin, kind), allow === true);
    for (const cb of ask.callbacks) {
      try {
        cb(allow === true);
      } catch {
        // The page that asked is gone.
      }
    }
    send({ kind: 'permission-gone', id });
    if (remember) pushTabs();
    return true;
  }

  function onPermissionRequest(wc, permission, callback, details) {
    let answered = false;
    const done = allow => {
      if (answered) return;
      answered = true;
      try {
        callback(allow === true);
      } catch {
        // The page that asked is gone.
      }
    };
    const kinds = permissionKinds(permission, details, false);
    const tab = tabByWc(wc);
    if (!kinds || !tab || agentDriving) return done(false);
    const origin = originOf(details?.requestingUrl || wc.getURL());
    if (!origin) return done(false);
    const known = kinds.map(kind => remembered.get(permissionKey(origin, kind)));
    if (known.every(v => v === true)) return done(true);
    if (known.some(v => v === false)) return done(false);
    const key = kinds.slice().sort().join('+');
    for (const ask of askedPermissions.values()) {
      if (ask.origin === origin && ask.key === key) {
        ask.callbacks.push(done);
        return undefined;
      }
    }
    const id = `p${crypto.randomBytes(6).toString('hex')}`;
    const ask = {
      id, origin, key, kinds: kinds.slice().sort(), label: permissionLabel(kinds), tab: tab.id, embedded: details?.isMainFrame === false,
      callbacks: [done], at: Date.now(), timer: null,
    };
    ask.timer = sleepUnref(PERMISSION_ASK_MS, () => resolvePermission(id, false, { remember: false }));
    askedPermissions.set(id, ask);
    send({ kind: 'permission-request', permission: { id, origin, kinds: ask.kinds, label: ask.label, tab: ask.tab, embedded: ask.embedded, at: ask.at } });
    return undefined;
  }

  function onPermissionCheck(_wc, permission, requestingOrigin, details) {
    if (agentDriving) return false;
    const kinds = permissionKinds(permission, details, true);
    const origin = originOf(requestingOrigin) || originOf(details?.requestingUrl);
    if (!kinds || !origin) return false;
    return kinds.every(kind => remembered.get(permissionKey(origin, kind)) === true);
  }

  // ---------- downloads ----------

  // Removes the download's private temp folder. A file that is still being closed cannot be deleted on Windows, so a refusal is tried
  // again a few times; a folder that never goes is left to the system (it holds one unnamed part file).
  // After a download that was cancelled, Chromium can make the folder again (empty) while it closes the download, so the folder is
  // removed once more a little later.
  function removeTemp(entry, attempt = 0) {
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      if (!entry.swept) {
        entry.swept = true;
        sleepUnref(2500, () => {
          try {
            fs.rmSync(entry.dir, { recursive: true, force: true });
          } catch {
            // In use again; the sweep at the next start takes it.
          }
        });
      }
    } catch {
      if (attempt < 8) sleepUnref(300, () => removeTemp(entry, attempt + 1));
    }
  }

  // Folders named plenum-dl-* in the temp folder that are over three days old: left by a run that did not quit cleanly.
  function sweepOldTemp() {
    try {
      const root = tempDir();
      const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(root)) {
        if (!name.startsWith('plenum-dl-')) continue;
        const full = path.join(root, name);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory() && stat.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
        } catch {
          // In use or already gone.
        }
      }
    } catch {
      // The temp folder cannot be read; nothing to sweep.
    }
  }

  // The download is over for the person: no answer is waited for. `reason` is 'expired', 'tab-closed' or 'cancelled'.
  function endDownload(id, reason) {
    const entry = askedDownloads.get(id);
    if (!entry) return;
    askedDownloads.delete(id);
    clearTimeout(entry.timer);
    try {
      if (entry.state === 'progressing') entry.item.cancel();
    } catch {
      // The download has ended already.
    }
    removeTemp(entry);
    send({ kind: 'download-gone', id, reason });
  }

  // A file name in dir that does not exist yet, as "name.ext", "name (1).ext", ...
  function uniqueTarget(dir, name) {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 0; n < 1000; n += 1) {
      const candidate = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return path.join(dir, `${stem} (${crypto.randomBytes(4).toString('hex')})${ext}`);
  }

  // Moves the finished temp file into destDir under a name that is not taken. A hard link fails if the name appeared in the
  // meantime, so nothing is replaced; where links are not possible the file is copied and may not overwrite.
  function moveInto(entry) {
    for (let tries = 0; tries < 5; tries += 1) {
      const target = uniqueTarget(entry.destDir, entry.name);
      try {
        fs.linkSync(entry.tempPath, target);
        return target;
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        try {
          fs.copyFileSync(entry.tempPath, target, fs.constants.COPYFILE_EXCL);
          return target;
        } catch (copyErr) {
          if (copyErr.code === 'EEXIST') continue;
          throw copyErr;
        }
      }
    }
    throw new Error('no free file name');
  }

  function finishDownload(entry) {
    askedDownloads.delete(entry.id);
    clearTimeout(entry.timer);
    if (entry.state !== 'completed') {
      removeTemp(entry);
      send({ kind: 'download-failed', id: entry.id, filename: entry.name, reason: entry.state === 'cancelled' ? 'The download was cancelled.' : 'The download did not finish.' });
      return;
    }
    try {
      const target = moveInto(entry);
      send({ kind: 'download-saved', id: entry.id, filename: path.basename(target), folder: path.basename(entry.destDir) || entry.destDir });
    } catch {
      send({ kind: 'download-failed', id: entry.id, filename: entry.name, reason: 'The file could not be saved to that folder.' });
    } finally {
      removeTemp(entry);
    }
  }

  // What the pane and the server are told about a download that waits.
  function downloadInfo(entry) {
    let size = 0;
    try {
      size = Math.max(0, entry.item.getTotalBytes());
    } catch {
      size = 0;
    }
    return {
      id: entry.id, filename: entry.name, size, host: entry.host, defaultDir: entry.defaultDir, tab: entry.tab, driving: entry.driving,
      risky: isRisky(entry.name), at: entry.at,
    };
  }

  function onWillDownload(event, item, wc) {
    const tab = tabByWc(wc);
    const raw = (() => {
      try {
        return item.getFilename();
      } catch {
        return '';
      }
    })();
    const name = safeFileName(raw);
    const settings = (() => {
      try {
        return isObject(readSettings()) ? readSettings() : {};
      } catch {
        return {};
      }
    })();
    if (!tab || settings.blockDownloads === true) {
      event.preventDefault();
      send({ kind: 'download-blocked', filename: cut(name, 200) });
      return;
    }
    const id = `d${crypto.randomBytes(6).toString('hex')}`;
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(tempDir(), 'plenum-dl-'));
    } catch {
      event.preventDefault();
      send({ kind: 'download-failed', id, filename: cut(name, 200), reason: 'Plenum could not make a temporary folder.' });
      return;
    }
    const tempPath = path.join(dir, 'file.part');
    let defaultDir = '';
    try {
      defaultDir = downloadsDir();
    } catch {
      defaultDir = '';
    }
    const entry = {
      id, item, dir, tempPath, name, tab: tab.id, driving: agentDriving, at: Date.now(), timer: null, state: 'progressing', decision: null, destDir: null,
      host: hostOf(wc.getURL()), defaultDir,
    };
    // The bytes go to the temp file until a person answers; the file the page named is never written by the page.
    item.setSavePath(tempPath);
    item.pause();
    item.on('done', (_e, state) => {
      entry.state = state;
      if (entry.decision === 'save') {
        finishDownload(entry);
      } else if (askedDownloads.has(id)) {
        // A download that ends while the question waits is kept for the answer; a Cancel that arrived first ends it now.
        if (entry.decision === 'cancel') endDownload(id, 'cancelled');
      } else {
        // The download was ended earlier (Cancel, a closed tab, the wait ran out). Its file is closed now, so the folder can go.
        removeTemp(entry);
      }
    });
    entry.timer = sleepUnref(DOWNLOAD_ASK_MS, () => endDownload(id, 'expired'));
    askedDownloads.set(id, entry);
    send({ kind: 'download-request', download: downloadInfo(entry) });
  }

  function answerDownload(message) {
    // The download's id travels as `download`: a message's own `id` is the server's request id (lib/shell.mjs sets it last).
    const entry = askedDownloads.get(message.download);
    if (!entry || entry.decision) return { ok: false, message: 'That download is no longer waiting.' };
    if (message.allow !== true) {
      entry.decision = 'cancel';
      endDownload(entry.id, 'cancelled');
      return { ok: true };
    }
    let destDir;
    if (typeof message.dir === 'string' && message.dir) {
      if (!path.isAbsolute(message.dir)) return { ok: false, message: 'The download folder is not available. Choose another in the Browser pane.' };
      try {
        if (!fs.statSync(message.dir).isDirectory()) throw new Error('not a folder');
      } catch {
        return { ok: false, message: 'The download folder is not available. Choose another in the Browser pane.' };
      }
      destDir = message.dir;
    } else {
      destDir = downloadsDir();
      try {
        fs.mkdirSync(destDir, { recursive: true });
      } catch {
        return { ok: false, message: 'Plenum could not open the Downloads folder.' };
      }
    }
    entry.decision = 'save';
    entry.destDir = destDir;
    clearTimeout(entry.timer);
    if (entry.state !== 'progressing') {
      finishDownload(entry);
    } else {
      try {
        entry.item.resume();
      } catch {
        finishDownload(entry);
      }
    }
    send({ kind: 'download-gone', id: entry.id, reason: 'answered' });
    return { ok: true };
  }

  // ---------- the session ----------

  // Chromium starts writing a download into the session's download folder (a GUID.tmp file) before the page's will-download handler
  // has named a path. That folder is a private one in the system temp folder, so nothing appears in the person's Downloads folder
  // before they say yes. Folders left by an earlier run that did not quit cleanly are swept (only names that start plenum-dl-).
  sweepOldTemp();
  try {
    realDownloads = String(downloadsDirOption() || '');
  } catch {
    realDownloads = '';
  }
  if (!realDownloads) realDownloads = path.join(os.homedir(), 'Downloads');
  try {
    sessionDir = fs.mkdtempSync(path.join(tempDir(), 'plenum-dl-session-'));
    ses.setDownloadPath?.(sessionDir);
    // The intermediate file is made in the app's download folder (not the session's), so that is pointed at the private folder too;
    // nothing else in the app downloads, and the system folder is kept in realDownloads and put back when the browser is destroyed.
    electron.app?.setPath?.('downloads', sessionDir);
  } catch {
    sessionDir = null;
  }
  ses.setPermissionRequestHandler(onPermissionRequest);
  ses.setPermissionCheckHandler(onPermissionCheck);
  ses.on('will-download', onWillDownload);
  // Devices (USB, serial, HID, Bluetooth) and screen capture are never granted; these calls exist only in newer Electron versions.
  try {
    ses.setDevicePermissionHandler?.(() => false);
  } catch {
    // Not available here.
  }
  try {
    ses.setDisplayMediaRequestHandler?.((_request, callback) => {
      try {
        callback({});
      } catch {
        callback();
      }
    });
  } catch {
    // Not available here.
  }
  try {
    ses.setSpellCheckerEnabled?.(false);
  } catch {
    // Not available here.
  }

  // ---------- the model's tools (brw-03) ----------

  const fail = message => ({ ok: false, message });

  // Starts a page load and keeps its promise on the tab, so a message with wait: true can answer when the page has loaded.
  function startLoad(tab, href) {
    tab.pendingLoad = tab.wc.loadURL(href).catch(() => {});
    return tab.pendingLoad;
  }

  // The tab's address and title now, added to a reply when the message asked to wait. A page that failed to load says why.
  function withPage(tab, message, reply) {
    if (message.wait !== true || !tab) return reply;
    let url = '';
    let title = '';
    try {
      url = cut(tab.wc.getURL(), MAX_URL);
      title = cut(tab.wc.getTitle(), MAX_TITLE);
    } catch {
      // The page went away while we waited.
    }
    return { ...reply, url, title, ...(tab.error ? { error: tab.error } : {}) };
  }

  // Waits (with wait: true) for the load that was just started, at most LOAD_WAIT_MS, then a moment for the title.
  async function afterLoad(tab, message, reply) {
    if (message.wait === true && tab) {
      await Promise.race([tab.pendingLoad ?? Promise.resolve(), pause(LOAD_WAIT_MS)]);
      await pause(120);
    }
    return withPage(tab, message, reply);
  }

  // Lets a page that was just acted on begin and finish a navigation: a short moment for it to start, then until loading stops.
  async function settle(tab, { quick = SETTLE_QUICK_MS, max = SETTLE_MAX_MS } = {}) {
    const wc = tab.wc;
    if (quick > 0) await pause(quick);
    if (wc.isDestroyed() || !wc.isLoading()) return;
    await new Promise(resolve => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', finish);
        resolve();
      };
      wc.once('did-stop-loading', finish);
      timer = sleepUnref(max, finish);
    });
  }

  // Page actions run one at a time, so a click and a snapshot never overlap on the same page. A failed one does not stop the next.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  }

  // Runs one of the two fixed scripts in an isolated world of the page. The argument goes in as data (see scriptCall). Rejects when the
  // script file is missing, the page does not answer in time, or the page changed while the script ran.
  function runScript(tab, method, args, { gesture = false } = {}) {
    if (!SNAPSHOT_SRC) return Promise.reject(new Error('The page reader is missing from this build.'));
    const code = scriptCall(SNAPSHOT_SRC, method, args);
    const wc = tab.wc;
    const job = typeof wc.executeJavaScriptInIsolatedWorld === 'function'
      ? wc.executeJavaScriptInIsolatedWorld(SCRIPT_WORLD, [{ code }], gesture)
      : wc.executeJavaScript(code, gesture);
    return Promise.race([job, new Promise((_resolve, reject) => sleepUnref(SCRIPT_MS, () => reject(new Error('The page did not answer in time.'))))]);
  }

  // Real input (a click, a key) reaches a page only while its view is on the window and the window is showing.
  const canSendInput = () => {
    if (!winAlive()) return false;
    try {
      return win.isVisible() !== false && win.isMinimized?.() !== true;
    } catch {
      return false;
    }
  };

  // Runs fn while the tab's view is on the window. A view that is not shown is put on the window's right edge, one pixel of it inside the
  // window and the rest outside, for the moment of the action: the page lays out at its full size, nobody sees it, and input arrives.
  async function withLive(tab, fn) {
    let borrowed = false;
    if (attached !== tab.id && winAlive()) {
      const size = bounds ?? { width: 1024, height: 768 };
      let edge = 1000;
      try {
        edge = win.getContentSize()[0] - 1;
      } catch {
        // The edge guessed above is on the window for a normal width.
      }
      win.contentView.addChildView(tab.view);
      tab.view.setBounds({ x: Math.max(0, edge), y: 0, width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) });
      borrowed = true;
      await pause(70);
    }
    try {
      return await fn();
    } finally {
      if (borrowed && attached !== tab.id && winAlive()) {
        try {
          if (typeof win.contentView.removeChildView === 'function') win.contentView.removeChildView(tab.view);
          else tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        } catch {
          // The view is already off the window.
        }
      }
    }
  }

  // Waits for the page to draw two frames (see FRAMES_CODE). Never rejects.
  function frames(tab) {
    const wc = tab.wc;
    let job;
    try {
      job = typeof wc.executeJavaScriptInIsolatedWorld === 'function' ? wc.executeJavaScriptInIsolatedWorld(SCRIPT_WORLD, [{ code: FRAMES_CODE }], false) : wc.executeJavaScript(FRAMES_CODE, false);
    } catch {
      job = Promise.resolve(false);
    }
    return Promise.race([Promise.resolve(job).catch(() => false), pause(FRAMES_MS)]);
  }

  // One left click at a point of the page, as real mouse input. The view must be live (see withLive).
  async function sendClick(tab, x, y) {
    const wc = tab.wc;
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await pause(30);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await pause(60);
  }

  // Sends real input and checks that the page saw it: a listener is armed first (in the isolated world, where the page cannot see it),
  // then `send` runs, then the listener is asked for up to a moment whether a real event arrived. Input that did not arrive (a covered or
  // busy window can drop it) is sent once more. Returns 'seen', or 'lost' when it never arrived. A page that was replaced meanwhile (a
  // click that followed a link) counts as seen, and so does a page that cannot be asked: sending again would risk doing it twice.
  async function deliver(tab, kind, send) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await runScript(tab, 'act', { action: 'arm-input', kind });
      } catch {
        await send();
        return 'seen';
      }
      await send();
      const end = Date.now() + (attempt === 0 ? 450 : 900);
      for (;;) {
        let reply = null;
        try {
          reply = await runScript(tab, 'act', { action: 'check-input', keep: true });
        } catch {
          return 'seen';
        }
        if (!reply || reply.gone === true || reply.seen === true) return 'seen';
        if (Date.now() > end) break;
        await pause(80);
      }
      try {
        await runScript(tab, 'act', { action: 'check-input' });
      } catch {
        return 'seen';
      }
      await frames(tab);
    }
    return 'lost';
  }

  // One key, as real input, with the view on the window. Returns 'seen' or 'lost' (see deliver).
  async function pressKey(tab, name) {
    const wc = tab.wc;
    const keyCode = KEYS[name];
    let outcome = 'seen';
    await withLive(tab, async () => {
      await frames(tab);
      outcome = await deliver(tab, 'key', async () => {
        wc.sendInputEvent({ type: 'keyDown', keyCode });
        // A line break arrives as a character too, which is what makes a form field submit its form.
        if (name === 'Enter') wc.sendInputEvent({ type: 'char', keyCode });
        wc.sendInputEvent({ type: 'keyUp', keyCode });
        await pause(60);
      });
    });
    return outcome;
  }

  // The tab's address and title, for what an action reply says about where the page is now.
  function where(tab, extra = {}) {
    let url = '';
    let title = '';
    try {
      url = cut(tab.wc.getURL(), MAX_URL);
      title = cut(tab.wc.getTitle(), MAX_TITLE);
    } catch {
      // Gone.
    }
    return { ok: true, tab: tab.id, url, title, ...(tab.error ? { error: tab.error } : {}), ...extra };
  }

  const scriptFail = (reply, fallback) => fail(line(reply && reply.message, 240) || fallback);

  async function snapshotPage(message) {
    if (!SNAPSHOT_SRC) return fail('The page reader is missing from this build.');
    const tab = tabFor(message.tab);
    if (!tab) return fail(NO_TAB);
    if (tab.crashed) return fail('This page stopped working. Reload it to try again.');
    const limits = { maxElements: clampInt(message.maxElements, 1, 2000, 600), maxChars: clampInt(message.maxChars, 1000, 60000, 12000) };
    return serial(async () => {
      try {
        // A page that is still loading is read once it has settled (at most six seconds).
        if (tab.wc.isLoading()) await settle(tab, { quick: 0, max: 6000 });
        const raw = await runScript(tab, 'snapshot', limits);
        const out = cleanSnapshot(raw, limits);
        if (!out) return fail('The page could not be read.');
        return { ok: true, tab: tab.id, ...out };
      } catch {
        return fail('The page changed while it was being read. Try again.');
      }
    });
  }

  async function actOnPage(message) {
    const action = message.action;
    if (!ACT_ACTIONS.has(action)) return fail('The browser does not know that action.');
    if (!SNAPSHOT_SRC) return fail('The page reader is missing from this build.');
    const tab = tabFor(message.tab);
    if (!tab) return fail(NO_TAB);
    if (tab.crashed) return fail('This page stopped working. Reload it to try again.');
    const ref = message.ref;
    if (NEEDS_REF.has(action) && !(typeof ref === 'string' && REF_RE.test(ref))) return fail('That is not a control reference. Use one from the last snapshot (e1, e2, ...).');
    if (action === 'type-secret' && ref !== undefined && !(typeof ref === 'string' && REF_RE.test(ref))) return fail('That is not a control reference.');
    const expect = cleanExpect(message.expect);
    return serial(async () => {
      try {
        switch (action) {
          case 'click': {
            let prep = null;
            let clicked = false;
            if (canSendInput()) {
              // Real input: with the view on the window, the page is given time to lay out at its present size, the control is scrolled to
              // the middle and its centre found, and the click goes there.
              await withLive(tab, async () => {
                await frames(tab);
                prep = await runScript(tab, 'act', { action: 'prepare-click', ref, expect });
                if (!prep || prep.ok !== true || prep.covered === true || !Number.isFinite(prep.x) || !Number.isFinite(prep.y)) return;
                await frames(tab);
                clicked = (await deliver(tab, 'mouse', () => sendClick(tab, Math.round(prep.x), Math.round(prep.y)))) === 'seen';
              });
            } else {
              prep = await runScript(tab, 'act', { action: 'prepare-click', ref, expect });
            }
            if (!prep || prep.ok !== true) return scriptFail(prep, 'That control cannot be clicked.');
            if (clicked) {
              await settle(tab);
              return where(tab, { via: 'mouse' });
            }
            // Another element is drawn over the control's centre, the window is hidden, or the click never reached the page: click the
            // control itself.
            const direct = await runScript(tab, 'act', { action: 'dom-click', ref, expect }, { gesture: true });
            if (!direct || direct.ok !== true) return scriptFail(direct, 'That control cannot be clicked.');
            await settle(tab);
            return where(tab, { via: 'direct', covered: prep.covered === true });
          }
          case 'type':
          case 'type-secret': {
            const secretWanted = action === 'type-secret';
            if (typeof message.text !== 'string') return fail('Send the text to type.');
            const text = message.text.slice(0, MAX_TYPED);
            if (secretWanted && ref === undefined) {
              const focus = await runScript(tab, 'act', { action: 'focus-info' });
              if (!focus || focus.ok !== true || focus.none === true || focus.editable !== true) return fail('Click the field first, then try again.');
            } else {
              const focus = await runScript(tab, 'act', { action: 'focus', ref, expect });
              if (!focus || focus.ok !== true) return scriptFail(focus, 'That control is not a text field.');
              // The model never types into a password, code or card field: this is checked here too, whatever the server said.
              if (focus.secret === true && !secretWanted) return { ok: false, secret: true, message: SECRET_REFUSAL };
            }
            let how = 'keys';
            if (text === '') {
              await runScript(tab, 'act', { action: 'set-value', ref, text: '' });
              how = 'cleared';
            } else {
              await tab.wc.insertText(text);
              if (!secretWanted) {
                const read = await runScript(tab, 'act', { action: 'read-value', ref });
                const norm = v => String(v).replace(/\r\n?/g, '\n');
                if (read && read.ok === true && read.secret !== true && !norm(read.value).includes(norm(text))) {
                  const set = await runScript(tab, 'act', { action: 'set-value', ref, text });
                  if (!set || set.ok !== true) return scriptFail(set, 'The text could not be entered.');
                  how = 'set';
                }
              }
            }
            if (message.submit === true && !secretWanted) {
              if (!canSendInput() || (await pressKey(tab, 'Enter')) === 'lost') await runScript(tab, 'act', { action: 'submit-form' }, { gesture: true });
              await settle(tab);
              return where(tab, { how, submitted: true });
            }
            return where(tab, { how });
          }
          case 'select': {
            if (typeof message.value !== 'string') return fail('Send the option to choose.');
            const chosen = await runScript(tab, 'act', { action: 'select', ref, expect, value: message.value.slice(0, 500) });
            if (!chosen || chosen.ok !== true) return scriptFail(chosen, 'That option could not be chosen.');
            await settle(tab, { quick: 200 });
            return where(tab, { chosen: line(chosen.chosen, 80) });
          }
          case 'press': {
            if (!Object.hasOwn(KEYS, message.key)) return fail('That key is not one the model may press.');
            const info = await runScript(tab, 'act', { action: 'focus-info' });
            if (message.key === 'Enter' && info && info.ok === true && info.secret === true) return { ok: false, secret: true, message: SECRET_REFUSAL };
            const sent = canSendInput() ? await pressKey(tab, message.key) : 'hidden';
            if (sent !== 'seen') {
              if (message.key === 'Enter') await runScript(tab, 'act', { action: 'submit-form' }, { gesture: true });
              else return fail(sent === 'hidden' ? 'The window is hidden, so keys cannot be sent. Show the Plenum window and try again.' : 'The key did not reach the page. Try again.');
            }
            await settle(tab);
            return where(tab);
          }
          case 'scroll': {
            const moved = await runScript(tab, 'act', { action: 'scroll', direction: message.direction === 'up' ? 'up' : 'down', amount: clampInt(message.amount, 1, 10, 3) });
            if (!moved || moved.ok !== true) return scriptFail(moved, 'The page could not be scrolled.');
            return where(tab, { moved: whole(moved.moved), y: whole(moved.y), max: whole(moved.max), atTop: moved.atTop === true, atBottom: moved.atBottom === true });
          }
          case 'focus-info': {
            const info = await runScript(tab, 'act', { action: 'focus-info' });
            if (!info || info.ok !== true) return scriptFail(info, 'The focused control could not be read.');
            return {
              ok: true, tab: tab.id, none: info.none === true, ref: REF_RE.test(String(info.ref)) ? info.ref : '', role: line(info.role, 24), name: line(info.name, 80),
              type: line(info.type, 20), secret: info.secret === true, editable: info.editable === true, inForm: info.inForm === true,
              submit: info.submit === true, post: info.post === true, sensitive: info.sensitive === true, near: line(info.near, 160),
            };
          }
          default:
            return fail('The browser does not know that action.');
        }
      } catch {
        return fail('The page changed or did not answer. Take a new snapshot and try again.');
      }
    });
  }

  // ---------- a phone looks and acts (mob-20) ----------

  // The last picture made for a phone, and the one being made. A phone that asks again within FRAME_MIN_MS gets the last one; one that
  // asks while a picture is being made shares it. Nothing is made unless a phone asks.
  let phoneFrame = null; // { tab, edge, at, reply }
  let phoneJob = null; // { tab, edge, promise }

  function phonePicture(tab, edge, quality) {
    if (phoneFrame && phoneFrame.tab === tab.id && phoneFrame.edge === edge && Date.now() - phoneFrame.at < FRAME_MIN_MS) {
      return Promise.resolve({ ...phoneFrame.reply, cached: true });
    }
    if (phoneJob && phoneJob.tab === tab.id && phoneJob.edge === edge) return phoneJob.promise;
    const job = { tab: tab.id, edge, promise: null };
    job.promise = serial(async () => {
      try {
        const got = await frameOf(tab, edge, quality);
        if (!got) return fail('The page has nothing to show yet.');
        const reply = { ok: true, tab: tab.id, ...got, shown: attached === tab.id };
        phoneFrame = { tab: tab.id, edge, at: Date.now(), reply };
        return reply;
      } catch {
        return fail('The page could not be captured.');
      } finally {
        if (phoneJob === job) phoneJob = null;
      }
    });
    phoneJob = job;
    return job.promise;
  }

  // The size of the tab's view in the page's own pixels, which is what a click is given in.
  function viewSize(tab) {
    try {
      const b = tab.view.getBounds?.();
      if (b && b.width > 0 && b.height > 0) return { width: b.width, height: b.height };
    } catch {
      // The size the pane last asked for is used.
    }
    const size = bounds ?? { width: 1024, height: 768 };
    return { width: Math.max(1, size.width), height: Math.max(1, size.height) };
  }

  // A point of the phone's picture (x, y in a picture of width by height) as a point of the page's view, or null when it is outside.
  function pointIn(message, size) {
    const { x, y, width, height } = message;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return null;
    return { x: Math.min(size.width - 1, Math.round((x / width) * size.width)), y: Math.min(size.height - 1, Math.round((y / height) * size.height)) };
  }

  // One key as the person's real input (no check that the page saw it; the caller decides).
  async function sendKey(tab, name) {
    const keyCode = PERSON_KEYS[name];
    tab.wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (name === 'Enter') tab.wc.sendInputEvent({ type: 'char', keyCode });
    tab.wc.sendInputEvent({ type: 'keyUp', keyCode });
    await pause(40);
  }

  // The person's tap, scroll, typing or key, from a phone. Checked here before anything is queued; sent as real input with the view on the
  // window, one at a time with the model's actions. Answers { ok, tab, url, title } and never a word of what was typed.
  async function personInput(message) {
    if (!PERSON_KINDS.has(message.kind)) return fail('The browser does not know that input.');
    const tab = tabFor(message.tab);
    if (!tab) return fail(NO_TAB);
    if (tab.crashed) return fail('This page stopped working. Reload it to try again.');
    if (agentDriving && message.paused !== true) return fail(MODEL_USING);
    if (message.kind === 'type') {
      if (typeof message.text !== 'string' || message.text === '') return fail('Type something first.');
    } else if (message.kind === 'key') {
      if (!Object.hasOwn(PERSON_KEYS, message.key)) return fail('That key is not one a phone can press.');
    } else if (message.kind === 'scroll') {
      const dx = message.dx ?? 0;
      const dy = message.dy ?? 0;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return fail('Say how far to scroll.');
    }
    if ((message.kind === 'tap' || message.kind === 'scroll') && !pointIn(message, { width: 1, height: 1 })) return fail('That spot is outside the picture.');
    if (!canSendInput()) return fail(HIDDEN_WINDOW);
    return serial(async () => {
      try {
        return await withLive(tab, async () => {
          const wc = tab.wc;
          const size = viewSize(tab);
          switch (message.kind) {
            case 'tap': {
              const at = pointIn(message, size);
              await frames(tab);
              const seen = await deliver(tab, 'mouse', () => sendClick(tab, at.x, at.y));
              if (seen !== 'seen') return fail('The tap did not reach the page. Try again.');
              await settle(tab, { quick: 150, max: 2500 });
              return where(tab);
            }
            case 'scroll': {
              const at = pointIn(message, size);
              const along = (n, of, to) => Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, Math.round(n * (to / of))));
              // dy > 0 moves the page down the way a finger swiping up does; the wheel's own sign is the other way round.
              const deltaX = -along(message.dx ?? 0, message.width, size.width);
              const deltaY = -along(message.dy ?? 0, message.height, size.height);
              wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
              wc.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY, canScroll: true });
              await pause(150);
              return where(tab);
            }
            case 'type': {
              // Control characters are dropped; a line break is the Enter key.
              const lines = message.text.slice(0, MAX_PERSON_TEXT).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '').split('\n');
              if (lines.every(l => l === '')) return fail('Type something first.');
              let focus = null;
              try {
                focus = await runScript(tab, 'act', { action: 'focus-info' });
              } catch {
                focus = null;
              }
              if (focus && focus.ok === true && focus.editable !== true) return fail('Tap a text field first.');
              for (let i = 0; i < lines.length; i += 1) {
                if (lines[i] !== '') await wc.insertText(lines[i]);
                if (i < lines.length - 1) await sendKey(tab, 'Enter');
              }
              return where(tab);
            }
            default: {
              const count = clampInt(message.count, 1, 20, 1);
              if (count === 1) {
                const seen = await deliver(tab, 'key', () => sendKey(tab, message.key));
                if (seen !== 'seen') return fail('The key did not reach the page. Try again.');
              } else {
                for (let i = 0; i < count; i += 1) await sendKey(tab, message.key);
              }
              if (message.key === 'Enter') await settle(tab, { quick: 150, max: 2500 });
              return where(tab);
            }
          }
        });
      } catch {
        return fail('The page changed or did not answer. Try again.');
      }
    });
  }

  // ---------- messages ----------

  const actions = {
    'browser-open': message => {
      const href = httpUrl(message.url);
      if (!href) return fail(NOT_HTTP);
      const current = tabFor(active);
      const blank = current && (current.wc.getURL() === '' || current.wc.getURL() === 'about:blank') && !current.wc.isLoading();
      if (blank) {
        startLoad(current, href);
        selectTab(current.id);
        return afterLoad(current, message, { ok: true, tab: current.id });
      }
      const opened = openTab(href, { select: true });
      return opened.ok ? afterLoad(tabs.get(opened.tab), message, opened) : opened;
    },
    'browser-navigate': message => {
      const href = httpUrl(message.url);
      if (!href) return fail(NOT_HTTP);
      const tab = tabFor(message.tab);
      if (!tab) return fail(NO_TAB);
      tab.error = '';
      startLoad(tab, href);
      return afterLoad(tab, message, { ok: true, tab: tab.id });
    },
    'browser-back': async message => {
      const tab = tabFor(message.tab);
      if (!tab) return fail(NO_TAB);
      goHistory(tab, -1);
      if (message.wait === true) await settle(tab, { max: LOAD_WAIT_MS });
      return withPage(tab, message, { ok: true, tab: tab.id });
    },
    'browser-forward': async message => {
      const tab = tabFor(message.tab);
      if (!tab) return fail(NO_TAB);
      goHistory(tab, 1);
      if (message.wait === true) await settle(tab, { max: LOAD_WAIT_MS });
      return withPage(tab, message, { ok: true, tab: tab.id });
    },
    'browser-reload': async message => {
      const tab = tabFor(message.tab);
      if (!tab) return fail(NO_TAB);
      tab.error = '';
      tab.wc.reload();
      if (message.wait === true) await settle(tab, { max: LOAD_WAIT_MS });
      return withPage(tab, message, { ok: true, tab: tab.id });
    },
    'browser-tabs': message => {
      if (message.action === 'new') {
        let href = null;
        if (message.url !== undefined && message.url !== null && message.url !== '') {
          href = httpUrl(message.url);
          if (!href) return fail(NOT_HTTP);
        }
        const opened = openTab(href, { select: message.select !== false });
        return opened.ok && href ? afterLoad(tabs.get(opened.tab), message, opened) : opened;
      }
      if (typeof message.tab !== 'string' || !ID_RE.test(message.tab)) return fail(NO_TAB);
      if (message.action === 'close') return closeTab(message.tab);
      if (message.action === 'select') return selectTab(message.tab) ? { ok: true, tab: message.tab } : fail(NO_TAB);
      return fail(FAILED);
    },
    'browser-bounds': async message => {
      // A phone's call (keep) takes a picture and leaves the views where the desktop put them; it is not a newer layout, so it does not
      // cancel a desktop call that is still waiting for its own picture.
      const keep = message.keep === true && message.visible !== true;
      const seq = keep ? boundsSeq : (boundsSeq += 1);
      const numbers = ['x', 'y', 'width', 'height'].map(name => message[name]);
      const valid = numbers.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
      if (message.visible === true) {
        if (!valid) return fail('The view needs a position and a size.');
        bounds = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
        wantVisible = bounds.width > 0 && bounds.height > 0;
        if (wantVisible) showActive();
        else detach();
        return { ok: true, shown: attached !== null };
      }
      let image = null;
      // A phone with no page view on the window (the pane is closed on the desktop) still gets a picture of the active tab.
      const shownTab = attached ?? (keep ? active : null);
      if (message.snapshot === true && shownTab) {
        const tab = tabs.get(shownTab);
        // A view that is not on the window is borrowed for the picture, so it waits its turn behind the model's actions.
        if (tab) image = attached === null ? await serial(() => coverPicture(tab)) : await coverPicture(tab);
      }
      if (keep) return image ? { ok: true, shown: attached !== null, image } : { ok: true, shown: attached !== null };
      // A newer bounds message arrived while the picture was taken: it decides.
      if (seq === boundsSeq) {
        wantVisible = false;
        detach();
      }
      return image ? { ok: true, shown: false, image } : { ok: true, shown: false };
    },
    'browser-frame': async message => {
      const tab = tabFor(message.tab);
      if (!tab) return fail(NO_TAB);
      if (tab.crashed) return fail('This page stopped working. Reload it to try again.');
      return phonePicture(tab, clampInt(message.maxEdge, FRAME_EDGE.min, FRAME_EDGE.max, FRAME_EDGE.default), FRAME_QUALITY);
    },
    'browser-input': message => personInput(message),
    'browser-hide': () => {
      hide();
      return { ok: true };
    },
    'browser-state': () => ({
      ok: true,
      ...snapshot(),
      downloads: [...askedDownloads.values()].filter(e => !e.decision).map(downloadInfo),
      permissions: [...askedPermissions.values()].map(a => ({ id: a.id, origin: a.origin, kinds: a.kinds, label: a.label, tab: a.tab, embedded: a.embedded, at: a.at })),
      agentDriving,
    }),
    'browser-screenshot': async message => {
      const tab = tabFor(message.tab);
      if (!tab) return fail(NO_TAB);
      try {
        let image = await serial(() => capture(tab));
        if (!image || image.isEmpty()) return fail('The page has nothing to show yet.');
        // The model's picture is scaled to maxEdge on its longest side (never enlarged), so it is small enough to send.
        if (message.maxEdge !== undefined) {
          const edge = clampInt(message.maxEdge, SCREENSHOT_EDGE.min, SCREENSHOT_EDGE.max, 1280);
          const have = image.getSize();
          const longest = Math.max(have.width, have.height);
          if (longest > edge) image = image.resize({ width: Math.max(1, Math.round((have.width * edge) / longest)) });
        }
        const size = image.getSize();
        return { ok: true, png: image.toPNG().toString('base64'), width: size.width, height: size.height };
      } catch {
        return fail('The page could not be captured.');
      }
    },
    'browser-snapshot': message => snapshotPage(message),
    'browser-act': message => actOnPage(message),
    'browser-driving': message => {
      const next = message.agentDriving === true;
      if (next && !agentDriving) {
        // A model that starts driving never gets a permission, and a question left over from the person's turn is not carried over.
        for (const ask of [...askedPermissions.values()]) resolvePermission(ask.id, false, { remember: false });
      }
      agentDriving = next;
      return { ok: true, agentDriving };
    },
    'browser-download-answer': message => {
      if (typeof message.download !== 'string' || !ID_RE.test(message.download)) return fail('That download is no longer waiting.');
      return answerDownload(message);
    },
    'browser-permission-answer': message => {
      if (typeof message.permission !== 'string' || !ID_RE.test(message.permission)) return fail('That question is no longer waiting.');
      if (agentDriving) return fail('A site never gets a permission while the model drives.');
      return resolvePermission(message.permission, message.allow === true) ? { ok: true } : fail('That question is no longer waiting.');
    },
    'browser-permission-reset': () => {
      remembered.clear();
      pushTabs();
      return { ok: true };
    },
    'browser-clear': async () => {
      try {
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.clearAuthCache?.();
        remembered.clear();
        pushTabs();
        return { ok: true };
      } catch {
        return fail('The browsing data could not be cleared.');
      }
    },
  };

  const types = Object.keys(actions);

  // Answers one message with an object { ok, ... }. Never throws.
  async function handle(message) {
    if (!isObject(message) || typeof message.type !== 'string' || !Object.hasOwn(actions, message.type)) return fail(FAILED);
    if (destroyed || !winAlive()) return fail('The window is not ready.');
    try {
      return await actions[message.type](message);
    } catch (err) {
      log(`browser request ${message.type} failed`);
      return fail(FAILED);
    }
  }

  // Lets go of everything: the questions are answered no, the downloads are cancelled and the views are closed.
  function destroy() {
    if (destroyed) return;
    hide();
    for (const ask of [...askedPermissions.values()]) resolvePermission(ask.id, false, { remember: false });
    for (const entry of [...askedDownloads.values()]) endDownload(entry.id, 'cancelled');
    for (const tab of [...tabs.values()]) {
      try {
        if (!tab.wc.isDestroyed()) tab.wc.close({ waitForBeforeUnload: false });
      } catch {
        // Already closed.
      }
    }
    tabs.clear();
    order.length = 0;
    active = null;
    destroyed = true;
    if (sessionDir) {
      try {
        electron.app?.setPath?.('downloads', realDownloads);
      } catch {
        // The system folder is read again at the next start.
      }
      removeTemp({ dir: sessionDir });
    }
    sessionDir = null;
  }

  return {
    handle,
    hide,
    destroy,
    types,
    // For the tests.
    _state: () => ({ tabs: order.slice(), active, attached, wantVisible, agentDriving, remembered: new Map(remembered), pendingDownloads: [...askedDownloads.values()].filter(e => !e.decision).length, pendingPermissions: askedPermissions.size }),
    _tab: id => tabs.get(id) ?? null,
  };
}

module.exports = { createBrowser, safeFileName, httpUrl, permissionKinds, permissionLabel, cleanSnapshot, scriptCall, PARTITION, MAX_TABS, MESSAGE_TYPES };
