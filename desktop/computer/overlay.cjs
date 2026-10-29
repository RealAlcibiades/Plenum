'use strict';
// The control overlay: what shows on the person's screen while a model has the mouse and the keyboard. Five frameless, always-on-top
// ('screen-saver' level), skip-taskbar, non-focusable windows:
//  - four 4 px strips that draw an amber frame around exactly what the model sees: just outside the target window's rectangle in
//    window scope, along the edges of the display in display scope. They ignore the mouse. The frame shows only while the state is
//    'running'; while the drive is paused the strips hide and the bar stays, so an amber frame always means the model has the mouse
//    and the keyboard at that moment.
//  - one 560x44 bar that loads the server's /overlay.html (the drive's text and its Pause and Stop buttons) with contextIsolation and
//    sandbox on and NO preload and no Node. It sits just above the window when there is room, else just below, else at the top centre
//    of the display (geometry.barPlacement); display scope always uses the top centre. The bar never carries Approve or Deny.
// All five call setContentProtection(true), so the operating system keeps them out of screenshots. The first capture of a run checks
// that: the page draws a 6x6 magenta square (#ff00ff) at the bar's top-left, capture.cjs looks for it, and when it is there (a
// window that content protection does not hide, as on Linux) the status becomes 'hidden-during-capture' and every later capture
// hides the five windows for the moment it takes. An input aimed at a point inside the bar hides the bar and makes it click-through
// for that action, so a click meant for what the model sees under the bar never lands on the bar.
//
// The overlay page is served by the app's own server (public/overlay.html with overlay.css and overlay.js beside it) and polls
// GET /api/drive, which needs the per-launch token. The page has no preload and never sees the token: these windows use their own
// in-memory session, and that session adds the token header to requests for the server's /api/ paths only
// (webRequest.onBeforeSendHeaders). The same session refuses every other request and every permission, and the windows refuse to
// navigate or to open new windows.
//
// A bar must never show an error page in place of the indicator. When the server answers the page with an error status (a missing
// file is a 404) or the page does not load at all, the bar loads a built-in page of this module instead (barFallbackHtml): the
// marker, a line that says a model is using the computer, and the stop key. It has no script and no buttons, so Stop is then the
// stop key and the Stop in the app. The next change of the run's state tries the server's page again.
const geometry = require('./geometry.cjs');

const FRAME_DIP = 4;
const FRAME_COLOR = '#f5a524';
const MARKER_DIP = 6;
const PARTITION = 'plenum-overlay';
const SETTLE_MS = 45;
const READY_MS = 200;
const BAR_HIDE_MS = 30;
const BAR_RESTORE_MS = 60;
const STRIPS = ['top', 'bottom', 'left', 'right'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Text that is safe in a query string value: printable, one line, clipped.
function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, max);
}

// A bar position kept inside the display (DIP): the person's drag, or one the model's pointer made, can never leave the bar where Pause and
// Stop cannot be reached.
function clampBar(at, area, size) {
  const x = Math.min(Math.max(at.x, area.x), Math.max(area.x, area.x + area.width - size.width));
  const y = Math.min(Math.max(at.y, area.y), Math.max(area.y, area.y + area.height - size.height));
  return { x: Math.round(x), y: Math.round(y) };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// The stop key's usual name on a system (the person can change it in Settings; the server's page names the key in force).
const defaultStopKey = platform => (platform === 'darwin' ? 'Control+Option+Esc' : 'Ctrl+Alt+Esc');

// The bar's page when the server's cannot be used: no script, inline style only (the page's own policy allows nothing else), the 6x6
// magenta marker at the top-left, and one line. info = { state, model, label, theme, platform }; the text is escaped here.
function barFallbackHtml({ state = 'running', model = '', label = '', theme = 'dark', platform = process.platform } = {}) {
  const dark = theme !== 'light';
  const who = cleanText(model, 60) || 'The model';
  const where = cleanText(label, 80) || 'this computer';
  const how = `To stop it, press the stop key (${defaultStopKey(platform)} unless you changed it in Settings) or use Stop in Plenum.`;
  const line = state === 'paused' ? `Paused · ${where}. ${how}` : `${who} is using ${where}. ${how}`;
  const css = 'html,body{margin:0;height:100%;overflow:hidden;background:transparent;cursor:default;-webkit-user-select:none}'
    + '.m{position:fixed;left:0;top:0;width:6px;height:6px;background:#ff00ff;z-index:2}'
    + `.b{box-sizing:border-box;position:fixed;inset:0;display:flex;align-items:center;padding:0 14px 0 16px;-webkit-app-region:drag;`
    + `border:2px solid ${state === 'paused' ? (dark ? '#4a4c63' : '#b9bbd0') : FRAME_COLOR};border-radius:0 12px 12px 12px;`
    + `background:${dark ? '#1a1a27' : '#f2f2f9'};color:${dark ? '#edeef6' : '#15151f'};font:600 12px/15px "Segoe UI",system-ui,sans-serif}`
    + '.t{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">"
    + `<title>Plenum computer use</title><style>${css}</style></head><body><div class="m"></div><div class="b"><span class="t">${escapeHtml(line)}</span></div></body></html>`;
}

// The decimal id of a native window handle Buffer (an HWND on Windows, an X11 window id on Linux).
function handleId(buffer) {
  try {
    if (Buffer.isBuffer(buffer) && buffer.length >= 8) return String(buffer.readBigUInt64LE(0));
    if (Buffer.isBuffer(buffer) && buffer.length >= 4) return String(buffer.readUInt32LE(0));
  } catch {
    // No id; the bounds comparison below still finds the window.
  }
  return '';
}

// Whether the URL is the app's own server on this computer (http, loopback).
function isLoopbackHttp(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

function createOverlay({ electron, space, overlayUrl = () => null, getToken = () => '', theme = () => 'dark', platform = process.platform, ownPid = process.pid, wait = sleep, now = Date.now } = {}) {
  const { BrowserWindow } = electron;
  // Content protection is a no-op on Linux, so the windows are always hidden for a capture there and nothing needs sampling.
  let status = platform === 'linux' ? 'hidden-during-capture' : 'unknown';
  let wins = null;
  let barReadyAt = 0;
  let barKey = '';
  let installedOrigin = '';
  const shown = { top: false, bottom: false, left: false, right: false, bar: false };
  const shaped = { top: false, bottom: false, left: false, right: false };
  const state = { show: false, state: 'running', rect: null, displayId: null, model: '', label: '', barPhysical: null, framePhysical: null, where: 'top' };
  let barDip = null;
  // The bar's bounds as the system reported them right after this module placed it. A later reading that differs is the person's drag.
  let barActual = null;
  // Where the person dragged the bar to, in DIP. Once they have, the bar stays there for the rest of the run.
  let userPlaced = null;
  let ids = new Set();

  const all = () => (wins ? [...STRIPS.map(k => wins[k]), wins.bar] : []);
  const canOpacity = typeof BrowserWindow?.prototype?.setOpacity === 'function' && platform !== 'linux';

  // macOS: stay in view over full-screen apps too. skipTransformProcessType keeps the Dock icon as it is. UNVERIFIED on a Mac.
  function floatOver(win) {
    if (platform !== 'darwin') return;
    try {
      win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    } catch {
      // The window still shows over ordinary windows.
    }
  }

  function protect(win) {
    try {
      win.setContentProtection(true);
    } catch {
      // The windows are hidden for captures when protection is not there; the first capture finds that out.
    }
  }

  // The windows never navigate, open another window or attach a webview.
  function lockDown(win) {
    const wc = win.webContents;
    try {
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', event => event.preventDefault());
      wc.on('will-attach-webview', event => event.preventDefault());
    } catch {
      // A window without these hooks cannot navigate anyway.
    }
  }

  function installSession(origin) {
    if (!electron.session || installedOrigin === origin) return;
    installedOrigin = origin;
    try {
      const ses = electron.session.fromPartition(PARTITION);
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      if (typeof ses.setPermissionCheckHandler === 'function') ses.setPermissionCheckHandler(() => false);
      // Only the app's own server, plus the blank page the strips load.
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        const url = String(details.url ?? '');
        callback({ cancel: !(url === 'about:blank' || url.startsWith(`${origin}/`) || url.startsWith('data:')) });
      });
      // The token goes onto the server's API requests here and nowhere else; the page never holds it.
      ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/api/*`] }, (details, callback) => {
        const headers = { ...details.requestHeaders };
        const token = getToken();
        if (token) headers['x-plenum-token'] = token;
        callback({ requestHeaders: headers });
      });
    } catch {
      // Without the session rules the bar cannot reach the API; it still shows its first text.
    }
  }

  // A window type that lets a window be as thin as the frame: on Windows an ordinary frameless window is never narrower than about 50
  // pixels, and a tool window ('toolbar') is made at exactly the size asked for. On macOS a panel does not take focus.
  const windowType = platform === 'darwin' ? 'panel' : 'toolbar';

  function baseOptions() {
    return {
      type: windowType,
      width: FRAME_DIP,
      height: FRAME_DIP,
      x: -32000,
      y: -32000,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      autoHideMenuBar: true,
      title: 'Plenum computer use',
    };
  }

  function createWindows() {
    if (wins) return wins;
    const strip = () => {
      const win = new BrowserWindow({
        ...baseOptions(),
        transparent: false,
        backgroundColor: FRAME_COLOR,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false, devTools: false, spellcheck: false, partition: PARTITION },
      });
      lockDown(win);
      win.setAlwaysOnTop(true, 'screen-saver');
      floatOver(win);
      win.setIgnoreMouseEvents(true);
      protect(win);
      win.setBackgroundColor?.(FRAME_COLOR);
      loadIn(win, 'about:blank');
      return win;
    };
    const bar = new BrowserWindow({
      ...baseOptions(),
      width: geometry.BAR_SIZE.width,
      height: geometry.BAR_SIZE.height,
      movable: true,
      transparent: true,
      backgroundColor: '#00000000',
      // No preload, no Node, a sandboxed page: it is the server's page and nothing more.
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false, spellcheck: false, partition: PARTITION, backgroundThrottling: false },
    });
    lockDown(bar);
    bar.setAlwaysOnTop(true, 'screen-saver');
    floatOver(bar);
    protect(bar);
    bar.webContents.on('did-finish-load', () => {
      barReadyAt = now();
    });
    // A page that did not load (the server is not there), or that the server answered with an error (a missing file is a 404), is
    // replaced by the built-in bar. Code -3 is a load that a newer load cut short; the built-in page is never judged itself.
    bar.webContents.on('did-fail-load', (_event, code, _text, url, isMainFrame) => {
      barReadyAt = 0;
      if (isMainFrame !== false && code !== -3 && !String(url ?? '').startsWith('data:')) showFallback();
    });
    bar.webContents.on('did-navigate', (_event, url, status) => {
      if (typeof status === 'number' && status >= 400 && !String(url ?? '').startsWith('data:')) showFallback();
    });
    wins = { top: strip(), bottom: strip(), left: strip(), right: strip(), bar };
    ids = new Set();
    for (const win of all()) {
      const id = handleId(win.getNativeWindowHandle?.());
      if (id) ids.add(id);
    }
    return wins;
  }

  function setBounds(win, rect) {
    const target = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    win.setBounds(target);
    // A window moved to a display with another scale factor may take the first call's size from the old display.
    const got = win.getBounds?.();
    if (got && (got.width !== target.width || got.height !== target.height || got.x !== target.x || got.y !== target.y)) win.setBounds(target);
  }

  // Puts a strip where the frame needs it. Windows will not make a window thinner than the system's smallest (about 30 pixels high for
  // a tool window), so a strip that came out larger than asked is moved so that the edge it belongs on is right and everything else
  // of it is cut away with setShape (outside the shape nothing is drawn and no mouse event arrives). A strip that is the size
  // asked for has no shape.
  function placeStrip(key, rect) {
    const win = wins[key];
    setBounds(win, rect);
    const want = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    const got = win.getBounds?.();
    const enlarged = got && (got.width > want.width || got.height > want.height);
    if (!enlarged) {
      if (shaped[key]) {
        win.setShape?.([]);
        shaped[key] = false;
      }
      return;
    }
    const dw = got.width - want.width;
    const dh = got.height - want.height;
    const at = { x: key === 'right' ? want.x - dw : want.x, y: key === 'bottom' ? want.y - dh : want.y, width: got.width, height: got.height };
    win.setBounds(at);
    if (typeof win.setShape === 'function') {
      win.setShape([{ x: key === 'right' ? dw : 0, y: key === 'bottom' ? dh : 0, width: want.width, height: want.height }]);
      shaped[key] = true;
    }
  }

  function showWin(key) {
    const win = wins[key];
    if (!shown[key]) win.showInactive();
    shown[key] = true;
    win.setAlwaysOnTop(true, 'screen-saver');
  }

  function hideWin(key) {
    if (wins && shown[key]) wins[key].hide();
    shown[key] = false;
  }

  function hideAll() {
    if (!wins) return;
    for (const key of [...STRIPS, 'bar']) hideWin(key);
    state.show = false;
    state.barPhysical = null;
    state.framePhysical = null;
    barDip = null;
    barActual = null;
    userPlaced = null;
  }

  // loadURL answers with a promise that rejects when the page does not load; the bar's load handlers deal with that, so the
  // rejection itself is let go (an unhandled one would be reported by the main process).
  function loadIn(win, href) {
    try {
      Promise.resolve(win.loadURL(href)).catch(() => {});
    } catch {
      // The window is gone.
    }
  }

  const loadInBar = href => loadIn(wins.bar, href);

  function showFallback() {
    if (!wins || !state.show) return;
    barReadyAt = 0;
    const page = barFallbackHtml({ state: state.state, model: state.model, label: state.label, theme: theme() === 'light' ? 'light' : 'dark', platform });
    loadInBar(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  }

  function loadBar() {
    const base = overlayUrl();
    if (!base || !isLoopbackHttp(base)) return;
    const url = new URL(base);
    url.search = new URLSearchParams({
      state: state.state,
      label: cleanText(state.label, 80),
      model: cleanText(state.model, 60),
      theme: theme() === 'light' ? 'light' : 'dark',
    }).toString();
    installSession(url.origin);
    if (url.href === barKey) return;
    barKey = url.href;
    barReadyAt = 0;
    loadInBar(url.href);
  }

  // update({ show, displayId, rect, state: 'running'|'paused', model, label }): rect is the target window in physical pixels, or
  // null for display scope. -> { ok, bar } where bar is the bar's physical rectangle (null when hidden).
  async function update(opts = {}) {
    if (!opts.show) {
      hideAll();
      return { ok: true, bar: null };
    }
    createWindows();
    const displays = space.displays();
    const display = displays.find(d => d.id === String(opts.displayId)) ?? displays.find(d => d.primary) ?? displays[0];
    if (!display) {
      hideAll();
      return { ok: false, bar: null };
    }
    state.show = true;
    state.state = opts.state === 'paused' ? 'paused' : 'running';
    state.rect = opts.rect && geometry.rectOk(opts.rect) ? { ...opts.rect } : null;
    state.displayId = display.id;
    state.model = opts.model ?? '';
    state.label = opts.label ?? '';
    const target = state.rect ? space.toDipRect(state.rect) : null;
    // A bar that is not where this module last put it has been dragged by the person, and stays where they left it.
    if (barActual && !userPlaced) {
      const at = wins.bar.getBounds?.();
      if (at && (Math.abs(at.x - barActual.x) > 2 || Math.abs(at.y - barActual.y) > 2)) userPlaced = clampBar({ x: at.x, y: at.y }, display.dipBounds, geometry.BAR_SIZE);
    }
    const placed = geometry.barPlacement({ target, display: display.dipBounds, size: geometry.BAR_SIZE, gap: 8, clearance: FRAME_DIP });
    if (userPlaced) userPlaced = clampBar(userPlaced, display.dipBounds, geometry.BAR_SIZE);
    barDip = userPlaced ? { x: userPlaced.x, y: userPlaced.y, width: placed.width, height: placed.height } : { x: placed.x, y: placed.y, width: placed.width, height: placed.height };
    state.where = userPlaced ? 'moved' : placed.where;
    setBounds(wins.bar, barDip);
    barActual = wins.bar.getBounds?.() ?? { ...barDip };
    loadBar();
    showWin('bar');
    state.barPhysical = space.toPhysicalRect(barDip);
    // The frame: around the window in window scope, along the display's edges in display scope.
    const frameDip = target ?? display.dipBounds;
    state.framePhysical = target ? state.rect : display.bounds;
    if (state.state === 'running') {
      const strips = geometry.frameStrips(frameDip, FRAME_DIP, display.dipBounds);
      for (const key of STRIPS) {
        placeStrip(key, strips[key]);
        showWin(key);
      }
    } else {
      for (const key of STRIPS) hideWin(key);
    }
    return { ok: true, bar: { ...state.barPhysical } };
  }

  const visibleKeys = () => [...STRIPS, 'bar'].filter(key => shown[key]);

  function fade(keys, on) {
    for (const key of keys) {
      const win = wins[key];
      try {
        if (canOpacity) win.setOpacity(on ? 1 : 0);
        else if (on) win.showInactive();
        else win.hide();
      } catch {
        // A window that is already gone changes nothing.
      }
    }
  }

  // Puts a window that was faded out back at full opacity without showing it. A Stop that lands while the bar or the frame is out of sight
  // hides them for good (hideAll), and a window left at opacity 0 would come back invisible with the next run.
  function restoreLook(key) {
    try {
      if (canOpacity) wins[key].setOpacity(1);
    } catch {
      // A window that is already gone changes nothing.
    }
  }

  function barReady() {
    return shown.bar && barReadyAt > 0 && now() - barReadyAt >= READY_MS;
  }

  return {
    update,

    // 'unknown' until the marker has been looked for, then 'protected' or 'hidden-during-capture'.
    status: () => status,

    visible: () => state.show && visibleKeys().length > 0,
    barPhysicalRect: () => (state.show && shown.bar && state.barPhysical ? { ...state.barPhysical } : null),
    framePhysicalRect: () => (state.show && state.state === 'running' && state.framePhysical ? { ...state.framePhysical } : null),
    snapshot: () => ({ ...state, shown: { ...shown }, status }),

    // True while a magenta check is due: the bar is showing, its page has loaded, and the status is not known yet.
    needsMarkerCheck: () => status === 'unknown' && state.show && barReady(),

    // The physical point at the middle of the bar's marker square, or null when the bar is not showing a loaded page.
    markerPoint() {
      if (!state.show || !state.barPhysical || !barReady()) return null;
      const scale = state.barPhysical.width / geometry.BAR_SIZE.width;
      const half = Math.round((MARKER_DIP * scale) / 2);
      return { x: state.barPhysical.x + half, y: state.barPhysical.y + half };
    },

    recordMarker(present) {
      status = present ? 'hidden-during-capture' : 'protected';
    },

    // Before a capture: hides the five windows unless the system is known to keep them out of the picture (status 'protected'); an
    // unknown status counts as not protected. The marker check (capture.cjs sampleMarker) grabs the screen on its own, before this,
    // with the windows showing. -> an async function that brings them back.
    async prepareCapture() {
      if (!wins || !state.show) return async () => {};
      if (status === 'protected') return async () => {};
      const keys = visibleKeys();
      if (keys.length === 0) return async () => {};
      fade(keys, false);
      await wait(SETTLE_MS);
      return async () => {
        if (!wins) return;
        for (const key of keys) {
          if (shown[key]) fade([key], true);
          else restoreLook(key);
        }
      };
    },

    // Runs fn with the bar hidden and click-through (an action aimed at a point under the bar), then brings the bar back.
    async hideBarDuring(fn) {
      if (!wins || !state.show || !shown.bar) return fn();
      const bar = wins.bar;
      bar.setIgnoreMouseEvents(true);
      fade(['bar'], false);
      try {
        await wait(BAR_HIDE_MS);
        return await fn();
      } finally {
        await wait(BAR_RESTORE_MS);
        // Stop can land while the bar is out of sight: hideAll() then clears shown.bar and the window stays hidden, but it must not stay
        // at opacity 0 and click-through for the run after.
        if (wins) {
          if (shown.bar) fade(['bar'], true);
          else restoreLook('bar');
          try {
            bar.setIgnoreMouseEvents(false);
          } catch {
            // The window is gone.
          }
        }
      }
    },

    // Whether a window from a window list ({ id, pid, bounds }) is one of these five.
    isOverlayWindow(w) {
      if (!wins || !w) return false;
      if (ids.has(String(w.id))) return true;
      if (w.pid !== ownPid || !w.bounds) return false;
      return all().some(win => {
        try {
          const b = space.toPhysicalRect(win.getBounds());
          return Math.abs(b.x - w.bounds.x) <= 2 && Math.abs(b.y - w.bounds.y) <= 2 && Math.abs(b.width - w.bounds.width) <= 2 && Math.abs(b.height - w.bounds.height) <= 2;
        } catch {
          return false;
        }
      });
    },

    hide: () => hideAll(),

    close() {
      for (const win of all()) {
        try {
          win.destroy();
        } catch {
          // Already gone.
        }
      }
      wins = null;
      ids = new Set();
      for (const key of Object.keys(shown)) shown[key] = false;
      state.show = false;
      barKey = '';
      barReadyAt = 0;
    },

    // The native window handles of the five windows, for tests and for the window lists.
    windowIds: () => [...ids],
  };
}

module.exports = { createOverlay, isLoopbackHttp, cleanText, handleId, barFallbackHtml, FRAME_DIP, FRAME_COLOR, PARTITION };
