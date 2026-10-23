// Muse Console desktop shell. Runs the local server as an Electron utility process and shows it in a window.
// The API keys live here, encrypted by the operating system (keyvault.cjs). The server is started with no key in its environment
// and gets the saved keys over its message channel; when the page saves a key, the server asks this process to store it.
// This file keeps the core: the single instance, the window, the server process, the tray and quit. What the server asks of the
// desktop (keys, the folder dialog, the alerts, and later the browser and the computer) is answered by the handler modules in
// desktop/handlers/, which desktop/handler-loader.cjs loads and routes (see that file for the shape). The over-the-air updater
// (desktop/handlers/app-update.cjs) adds a tray item and may take over the error box of a failed first start after an update.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, powerSaveBlocker, safeStorage, shell: electronShell, utilityProcess } = require('electron');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createKeyVault, stripKeys } = require('./keyvault.cjs');
const { tooltipFor } = require('./alerts.cjs');
const { createSseParser } = require('./sse.cjs');
const { loadHandlers, handleMessage, runHooks } = require('./handler-loader.cjs');

// This launch's token. Every request to the server's /api/ must carry it (lib/auth.mjs). It is made once per launch of the app, so
// a server restart after an applied update keeps it and an open window keeps working. It goes to the server over the keys channel,
// to the app page through the preload bridge (preload.cjs) and to this process's own requests as a header. It is never on a
// command line, in an environment, in a URL or in the log.
const TOKEN = randomBytes(32).toString('hex');
const apiHeaders = () => ({ 'x-plenum-token': TOKEN });

const PORT = 4317;
const APP_URL = `http://127.0.0.1:${PORT}/`;
// The server exits with this code when it wants a restart (after an applied update).
const RESTART_EXIT_CODE = 75;
// Set once the server has been started again because it ended while an applied update was still unproven (see the exit handler in
// startServer). It is cleared when a start gets as far as answering, so one bad update costs one restart, not a loop.
let restartTried = false;
// The server is asked for its state this often while the events channel is down (while it is up, the server sends the state
// whenever it changes). A request that takes longer than the timeout is skipped.
const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 1_000;
// How long to wait before the events channel is opened again, by the number of failed tries in a row.
const EVENTS_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
// How long the port check waits for an answer before it counts the port as in use.
const PORT_PROBE_MS = 1_500;
const root = path.resolve(__dirname, '..');
// The page draws the title bar itself; Windows only overlays the minimise, maximise and close
// buttons. The height matches --bar-h and the colours match --bg in public/style.css.
const BAR_HEIGHT = 52;
const CHROME = {
  dark: { background: '#0a0a11', symbols: '#c9cce0' },
  light: { background: '#f6f6fb', symbols: '#2a2b3c' },
};
const windowButtons = look => ({ color: '#00000000', symbolColor: look.symbols, height: BAR_HEIGHT });
// A "#rrggbb" colour counts as dark when its perceived brightness is under half.
function isDark(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.5;
}

let win = null;
let tray = null;
let server = null;
let vault = null;
let quitting = false;
let logStream = null;
let logFile = '';
// The poll timer, and whether a poll is running now. The poll is the fallback while the events channel is down.
let pollTimer = null;
let polling = false;
// The number of approval cards the tray shows. The alerts handler sets it through shell.tray.count.
let trayCount = 0;
// The notice shown the first time the window is hidden to a Linux tray that may not be there (B-112). Kept, as the alerts are.
let trayNote = null;
let trayNoticeShown = false;
// The events channel (GET /api/events): the open request, whether it has delivered its first event, the failed tries in a row,
// and the timer for the next try.
let eventsReq = null;
let eventsUp = false;
let eventsFails = 0;
let eventsTimer = null;
// The desktop handlers (desktop/handlers/): their messages and hooks. Loaded once, in main(), before the window is made.
let handlers = { messages: new Map(), hooks: [], reported: new Set() };
// The handler modules that loaded, in file order ({ file, mod }). The startFailed hook is run from here, because it answers with a
// value and the loader's runHooks (desktop/handler-loader.cjs) ignores what a hook returns.
let handlerModules = [];
// The item a handler adds to the tray menu ({ label, click }), or null. The updater sets it while an update is ready to install.
let updateItem = null;
// Set once a handler has taken over the error box for a failed start, so the 30-second wait and the server's exit cannot each show
// another box for the same failure.
let startFailureHandled = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (for example from the shortcut) shows the window, even when it is hidden in the tray.
  app.on('second-instance', () => showWindow());
  // macOS: a click on the Dock icon re-activates the app. The window may be hidden to the tray, so bring it back.
  // Windows and Linux never send this, so it changes nothing there.
  app.on('activate', () => showWindow());
  app.whenReady().then(main);
}

function writeLog(line) {
  logStream?.write(`${line}\n`);
}

// Calls the handlers' hooks with this name. The shell is the first argument of every hook.
function callHooks(name, ...args) {
  runHooks(handlers, name, [desktopShell, ...args], { log: writeLog });
}

// The loader's `load`: it requires the module as the loader would, and remembers the ones that loaded (for runStartFailed below).
function loadHandlerModule(file) {
  const mod = require(file);
  if (mod && typeof mod === 'object') handlerModules.push({ file: path.basename(file), mod });
  return mod;
}

// Asks the handlers whether one of them deals with a failed start (the server exited with an error, or never answered). Every
// handler's startFailed hook runs, in file order, with { code, message }; a hook that throws is logged and skipped. The result is
// true when a hook returned true: that handler has shown its own box and quits the app itself, so the caller shows no box and does
// not quit. Once a start failure has been taken over, later calls answer true without asking again.
function runStartFailed(info) {
  if (startFailureHandled) return true;
  let taken = false;
  for (const { file, mod } of handlerModules) {
    const fn = mod.hooks?.startFailed;
    if (typeof fn !== 'function') continue;
    try {
      if (fn(desktopShell, info) === true) taken = true;
    } catch (err) {
      writeLog(`hook startFailed in ${file} failed: ${String(err?.message ?? err).replace(/[\r\n\t]+/g, ' ').slice(0, 300)}`);
    }
  }
  if (taken) startFailureHandled = true;
  return taken;
}

// What a handler module is given as its shell (desktop/handler-loader.cjs). It is this process's view for the handlers' own jobs:
// the key vault and the token are read through it, and windows, notifications and replies to the server go out through it.
// shell.log writes to the app's log; the handlers here never pass a key or the token to it.
const desktopShell = {
  app,
  dialog,
  shell: electronShell,
  Notification,
  nativeImage,
  powerSaveBlocker,
  ipcMain,
  win: () => win,
  showWindow: () => showWindow(),
  tell: message => tell(server, message),
  get vault() {
    return vault;
  },
  token: TOKEN,
  port: PORT,
  get userData() {
    return app.getPath('userData');
  },
  get logFile() {
    return logFile;
  },
  log: writeLog,
  settings: () => alertSettings(),
  stateFile: () => stateFile(),
  tray: {
    count: n => {
      trayCount = n;
      if (tray) {
        tray.setToolTip(tooltipFor(n));
        tray.setContextMenu(buildTrayMenu(n));
      }
    },
    // The updater's item: { label, click } while an update is downloaded, null otherwise. The menu is rebuilt when it changes.
    setUpdateItem: item => {
      const next = item && typeof item === 'object' && typeof item.label === 'string' && typeof item.click === 'function' ? { label: item.label, click: item.click } : null;
      if (next?.label === updateItem?.label && next?.click === updateItem?.click) return;
      updateItem = next;
      if (tray) tray.setContextMenu(buildTrayMenu(trayCount));
    },
  },
  serverPid: () => server?.pid ?? null,
};

function openLog() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'server.log');
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write(`\n--- started ${new Date().toISOString()} ---\n`);
}

// Reads environment variables straight from the registry. An app started from the Start menu can
// miss PATH or API key changes made after Explorer started (for example by the Muse Code installer
// or setx), so the server gets the current values.
function registryEnv() {
  const sources = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
  const vars = {};
  for (const key of sources) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
    } catch {
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
      if (!m) continue;
      const value = m[2].replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
      if (m[1].toLowerCase() === 'path') vars.Path = [vars.Path, value].filter(Boolean).join(';');
      else vars[m[1]] = value;
    }
  }
  return vars;
}

// On Windows the server gets the registry values and this process's own, merged.
function windowsEnv() {
  const env = registryEnv();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') continue;
    env[key] = value;
  }
  env.Path = [env.Path, process.env.Path ?? process.env.PATH].filter(Boolean).join(';');
  // npm's global folder holds the Codex CLI shim; it is not always on the registry PATH.
  const npmBin = path.join(process.env.APPDATA || '', 'npm');
  if (process.env.APPDATA && fs.existsSync(npmBin) && !env.Path.toLowerCase().includes(npmBin.toLowerCase())) {
    env.Path = `${env.Path};${npmBin}`;
  }
  return env;
}

// The environment the server starts with. It is built here and carries no API key: the saved keys reach the server over its
// channel instead. A key that is still in the environment (for example one an older version saved to the Windows user
// environment) is left out, and the Accounts panel offers to import it.
function serverEnv() {
  const env = stripKeys(process.platform === 'win32' ? windowsEnv() : { ...process.env });
  // A utility process is started by Electron itself and must not be told to run as plain Node.
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[name];
  }
  return env;
}

function startServer() {
  // server-entry.cjs loads server.mjs, which is an ES module.
  const child = utilityProcess.fork(path.join(__dirname, 'server-entry.cjs'), [], {
    cwd: root,
    env: serverEnv(),
    serviceName: 'Plenum server',
    // Its output goes to the log. A utility process has no stdin; it ends with the app.
    stdio: 'pipe',
  });
  server = child;
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.on('message', message => {
    if (message?.type === 'shutdown-done') {
      shutdownDone?.();
      return;
    }
    onServerMessage(child, message).catch(() => writeLog('a message from the server could not be handled'));
  });
  child.on('exit', code => {
    if (child !== server) return;
    server = null;
    callHooks('serverExited', code);
    if (quitting) return;
    if (code === RESTART_EXIT_CODE) {
      setTimeout(restartAndReload, 300);
      return;
    }
    // B-3: an applied update that has not started cleanly yet leaves overlay/pending.json in the state folder (lib/updates.mjs). If
    // the server ends while it is there, start it once more: the bootstrap (lib/overlay/register.cjs) then goes back to the
    // generation before. A second failure in a row shows the box below as it always did.
    if (!restartTried && fs.existsSync(path.join(stateDir(), 'overlay', 'pending.json'))) {
      restartTried = true;
      setTimeout(restartAndReload, 300);
      return;
    }
    // A handler may deal with the failure itself (the updater does when this was the first start after an update); then there is
    // no box here and no quit.
    if (runStartFailed({ code, message: `The local server exited with code ${code}.` })) return;
    dialog.showErrorBox('Plenum stopped', `The local server exited with code ${code}.\n\nLog: ${logFile}`);
    app.quit();
  });
  callHooks('serverStarted', child);
}

// Sends the server a message, if it is still the server this reply was for.
function tell(child, message) {
  if (child !== server) return;
  try {
    child.postMessage(message);
  } catch {
    // The server went away while the reply was being made.
  }
}

// The server's messages go to the handler modules (desktop/handlers/). A message from a server that is no longer the current one
// is ignored, and a message with no string type is not a request.
async function onServerMessage(child, message) {
  if (child !== server || !message || typeof message !== 'object' || typeof message.type !== 'string') return;
  await handleMessage(handlers, message, desktopShell, { post: reply => tell(child, reply), log: writeLog });
}

// A clean stop first (B-29): the server stops its runs, stores their replies and saves the state, then answers shutdown-done (server.mjs).
// Resolves when it answered, or after SHUTDOWN_WAIT_MS when it did not; stopServer below then ends the process either way.
const SHUTDOWN_WAIT_MS = 4000;
let shutdownDone = null;
function askServerToStop() {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, SHUTDOWN_WAIT_MS);
    function finish() {
      clearTimeout(timer);
      shutdownDone = null;
      resolve();
    }
    shutdownDone = finish;
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      finish();
    }
  });
}

function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  try {
    // taskkill /t also ends anything the server started (for example a run_command process).
    execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    child.kill();
  }
}

// Whether something already answers on the app's port before this app starts its server. Only a refused connection means the
// port is free: any answer, or silence for PORT_PROBE_MS, counts as in use. The request carries no token, so a foreign listener
// is never given this launch's token.
function portInUse() {
  return new Promise(resolve => {
    let settled = false;
    const done = inUse => {
      if (settled) return;
      settled = true;
      resolve(inUse);
    };
    const req = http.get(`${APP_URL}api/status`, res => {
      res.resume();
      done(true);
      req.destroy();
    });
    req.on('error', err => done(err?.code !== 'ECONNREFUSED'));
    req.setTimeout(PORT_PROBE_MS, () => {
      req.destroy();
      done(true);
    });
  });
}

// Polls the server until it answers. Gives up after 30 seconds.
function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('The local server did not start in time.'));
      else setTimeout(tryOnce, 300);
    };
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: apiHeaders() }, res => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    tryOnce();
  });
}

async function restartAndReload() {
  startServer();
  try {
    await waitForServer();
    restartTried = false;
    subscribeEvents();
    if (win) win.loadURL(APP_URL);
  } catch (err) {
    if (runStartFailed({ code: null, message: err.message })) return;
    dialog.showErrorBox('Plenum', `${err.message}\n\nLog: ${logFile}`);
    app.quit();
  }
}

function createWindow() {
  // Until the page loads, follow Windows.
  const startLook = nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light;
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    // Narrow enough to snap beside another window; below 860 px the sidebar folds into a menu (public/ext-sidebar.js).
    minWidth: 480,
    minHeight: 480,
    title: 'Plenum',
    // Window and taskbar icon (the installed .exe gets its icon from build/icon.ico at packaging time).
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: startLook.background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: windowButtons(startLook),
    show: false,
    // preload.cjs gives the page its token (window.plenumShell.token). spellcheck is off because on Linux Electron downloads
    // Hunspell dictionaries from a Google-hosted server when it is on, and the Privacy Notice says Plenum makes no such request.
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs'), spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  // The page publishes its background as its theme colour. The window buttons follow it, so they
  // stay readable when Windows changes theme or the Theme button overrides it.
  win.webContents.on('did-change-theme-color', (_event, color) => {
    if (!win || !/^#[0-9a-f]{6}$/i.test(color ?? '')) return;
    win.setTitleBarOverlay(windowButtons(isDark(color) ? CHROME.dark : CHROME.light));
    win.setBackgroundColor(color);
  });
  // Links that open a new window go to the browser; the app itself stays in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) electronShell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) event.preventDefault();
  });
  // With "trayOnClose" on, closing the window hides it to the tray and the server keeps running.
  // A quit (the tray's Quit, or app.quit from anywhere) is never blocked.
  win.on('close', event => {
    if (quitting || !trayOnClose()) return;
    if (!ensureTray()) return;
    event.preventDefault();
    win.hide();
    // B-112: a Linux desktop with no tray host draws no tray icon and reports no error, so the window would stay hidden with no
    // way back on screen. Say where it went, once per launch. The notice is kept in a variable, so a click still reaches it.
    if (process.platform === 'linux' && !trayNoticeShown && Notification.isSupported()) {
      trayNoticeShown = true;
      trayNote = new Notification({ title: 'Plenum is still running', body: 'Open Plenum again, or use its tray icon, to show the window.' });
      trayNote.on('click', () => showWindow());
      trayNote.show();
    }
  });
  // Windows is ending the session, which cannot be stopped, so the window must not hide to the tray now.
  win.on('session-end', () => {
    quitting = true;
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  callHooks('windowCreated', win);
}

// The state folder the server uses (lib/store.mjs HOME): the app state file, and the overlay of applied updates.
function stateDir() {
  return process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
}

// The app state file. lib/store.mjs writes it in the same folder, so the shell and the server share the settings.
function stateFile() {
  return path.join(stateDir(), 'state.json');
}

// Reads "trayOnClose" from the app state file. It is read at close time, so a change applies without restarting.
// Missing or unreadable means off.
function trayOnClose() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).trayOnClose === true;
  } catch {
    return false;
  }
}

// "finishedAlerts", "keepAwake" and "approvalAlerts" come from the same file. All default to on, so only an explicit false turns one off.
function alertSettings() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return { finishedAlerts: st.finishedAlerts !== false, keepAwake: st.keepAwake !== false, approvalAlerts: st.approvalAlerts !== false };
  } catch {
    return { finishedAlerts: true, keepAwake: true, approvalAlerts: true };
  }
}

// Asks the server for its state. Resolves null when it does not answer in time, so a slow server changes nothing.
function fetchState() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: apiHeaders() }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(POLL_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

// Takes the server's state (from an event, or from the poll below) and hands it to the state hooks (the alerts, in desktop/handlers/).
function onState(st) {
  callHooks('state', st);
}

// The fallback: runs every POLL_MS, and does nothing while the events channel is up. A poll that gets no answer changes nothing.
async function pollServer() {
  if (polling || eventsUp) return;
  polling = true;
  try {
    const st = await fetchState();
    if (st) onState(st);
  } finally {
    polling = false;
  }
}

// Opens the events channel (GET /api/events). Its hello and state events carry the state without messages, which is all
// onState reads. When the channel ends or fails it is opened again after 1, 2, 4, 8 and then 10 seconds, and the poll above
// covers the gap. Calling this while a channel is open or a retry is waiting starts over with a fresh one.
function subscribeEvents() {
  if (quitting) return;
  clearTimeout(eventsTimer);
  eventsTimer = null;
  if (eventsReq) {
    const old = eventsReq;
    eventsReq = null;
    old.destroy();
  }
  eventsUp = false;
  const parser = createSseParser(ev => {
    if (!ev || typeof ev !== 'object' || (ev.type !== 'hello' && ev.type !== 'state') || !ev.state) return;
    eventsUp = true;
    eventsFails = 0;
    onState(ev.state);
  });
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { ...apiHeaders(), accept: 'text/event-stream' } }, res => {
    if (res.statusCode !== 200) {
      res.resume();
      return eventsLost(req);
    }
    res.setEncoding('utf8');
    res.on('data', chunk => parser.feed(chunk));
    res.on('end', () => eventsLost(req));
    res.on('error', () => eventsLost(req));
    return undefined;
  });
  req.on('error', () => eventsLost(req));
  eventsReq = req;
}

// The channel ended or never opened: the poll takes over and a new try is scheduled. A request that has been replaced is ignored.
function eventsLost(req) {
  if (req !== eventsReq) return;
  eventsReq = null;
  eventsUp = false;
  if (quitting) return;
  const wait = EVENTS_BACKOFF_MS[Math.min(eventsFails, EVENTS_BACKOFF_MS.length - 1)];
  eventsFails += 1;
  eventsTimer = setTimeout(subscribeEvents, wait);
}

// Brings the window back from the tray, or from behind other windows.
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The tray menu. "Show waiting approval" is enabled only while an approval card waits, and then it says how many. While a handler has
// set an update item (desktop/handlers/app-update.cjs), it sits after the approval item and before the separator.
function buildTrayMenu(waiting) {
  return Menu.buildFromTemplate([
    { label: 'Show Plenum', click: () => showWindow() },
    { label: waiting ? `Show waiting approval (${waiting})` : 'Show waiting approval', enabled: waiting > 0, click: () => showWindow() },
    ...(updateItem ? [{ label: updateItem.label, click: updateItem.click }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

// Creates the tray icon on first use. Returns false when it cannot be made, and then the window
// closes as usual rather than vanishing with no way back.
function ensureTray() {
  if (tray) return true;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
    if (icon.isEmpty()) return false;
    // Windows draws the tray icon at 16 to 32 px, so a 512 px image is scaled down once here.
    tray = new Tray(icon.resize({ width: 32, height: 32 }));
  } catch {
    tray = null;
    return false;
  }
  // The tray starts with the count the alerts last gave it, so a tray made while an approval waits says so at once.
  tray.setToolTip(tooltipFor(trayCount));
  tray.setContextMenu(buildTrayMenu(trayCount));
  // A left click on the icon shows the window; the context menu opens on a right click.
  tray.on('click', () => showWindow());
  return true;
}

async function main() {
  // The same id as build.appId in package.json, which the installer writes into its shortcuts.
  // With matching ids, a pinned taskbar icon and the running window are one icon, not two.
  if (process.platform === 'win32') app.setAppUserModelId('com.museconsole.desktop');
  openLog();
  // The encrypted keys sit beside the log, in the app's user-data folder. The vault is made before the server starts, because
  // the server asks for its keys the moment it is up.
  vault = createKeyVault({ safeStorage, file: path.join(app.getPath('userData'), 'keys.json') });
  // The app page asks for this launch's token through the preload bridge (preload.cjs). Only the app's own window, showing a page
  // from the app's own address, gets it; any other sender gets an empty string. Registered before the window is made.
  ipcMain.handle('plenum:token', event => (win && event.sender === win.webContents && String(event.senderFrame?.url ?? '').startsWith(APP_URL)) ? TOKEN : '');
  // The handler modules are loaded before the window, so their window hook sees the window made here.
  handlerModules = [];
  handlers = loadHandlers({ dir: path.join(__dirname, 'handlers'), log: writeLog, load: loadHandlerModule });
  createWindow();
  // B-111: a program that already listens on the port would answer the status check as if it were this app's server, and the
  // app would load it. So the port is checked first, and a busy one stops the start with a plain message.
  if (await portInUse()) {
    dialog.showErrorBox('Plenum could not start', `Port ${PORT} is already in use by another program or another Plenum. Close it and start Plenum again.\n\nLog: ${logFile}`);
    app.quit();
    return;
  }
  startServer();
  pollTimer = setInterval(pollServer, POLL_MS);
  try {
    await waitForServer();
    restartTried = false;
    subscribeEvents();
    if (win) win.loadURL(APP_URL);
  } catch (err) {
    if (!runStartFailed({ code: null, message: err.message })) {
      dialog.showErrorBox('Plenum could not start', `${err.message}\n\nLog: ${logFile}`);
      app.quit();
    }
  }
  callHooks('ready');
}

app.on('window-all-closed', () => app.quit());
// The first quit waits for the server's clean stop (askServerToStop), then quits again; the second pass ends the process as before.
let stopAsked = false;
app.on('before-quit', event => {
  quitting = true;
  if (server && !stopAsked && typeof event?.preventDefault === 'function') {
    stopAsked = true;
    event.preventDefault();
    askServerToStop().finally(() => app.quit());
    return;
  }
  stopServer();
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(eventsTimer);
  eventsReq?.destroy();
  eventsReq = null;
  callHooks('beforeQuit');
});
