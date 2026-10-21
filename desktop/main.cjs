// Muse Console desktop shell. Runs the local server as an Electron utility process and shows it in a window.
// The API keys live here, encrypted by the operating system (keyvault.cjs). The server is started with no key in its environment
// and gets the saved keys over its message channel; when the page saves a key, the server asks this process to store it.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, nativeTheme, powerSaveBlocker, safeStorage, shell, utilityProcess } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createKeyVault, stripKeys } = require('./keyvault.cjs');
const { shouldAnnounce, tooltipFor } = require('./alerts.cjs');

const PORT = 4317;
const APP_URL = `http://127.0.0.1:${PORT}/`;
// The server exits with this code when it wants a restart (after an applied update).
const RESTART_EXIT_CODE = 75;
// The server is asked for its state this often while the app is open. A request that takes longer than the timeout is skipped.
const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 1_000;
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
// Background checks: the poll timer, whether a poll is running now, the keep-awake blocker id,
// and the run being watched ({ projectId, name }) while the server reports it in progress.
let pollTimer = null;
let polling = false;
let keepAwakeId = null;
let watchedRun = null;
let finishedNote = null;
// The number of approval cards the last poll counted, and the notification for one that just arrived (kept, as finishedNote is).
let lastWaiting = 0;
let approvalNote = null;
// True while the folder dialog for the server's "Browse…" is open. Only one is opened at a time.
let folderPickOpen = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (for example from the shortcut) shows the window, even when it is hidden in the tray.
  app.on('second-instance', () => showWindow());
  app.whenReady().then(main);
}

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
  child.on('message', message => onServerMessage(child, message));
  child.on('exit', code => {
    if (child !== server) return;
    server = null;
    if (quitting) return;
    if (code === RESTART_EXIT_CODE) {
      setTimeout(restartAndReload, 300);
      return;
    }
    dialog.showErrorBox('Plenum stopped', `The local server exited with code ${code}.\n\nLog: ${logFile}`);
    app.quit();
  });
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

// Answers the server's two key requests. keys-hello is sent once at its start and gets the saved keys; save-key stores one key.
// Nothing here is logged, and the keys appear only in the replies.
async function onServerMessage(child, message) {
  if (child !== server || !vault || !message || typeof message !== 'object') return;
  if (message.type === 'keys-hello') {
    let loaded;
    try {
      loaded = await vault.load();
    } catch {
      loaded = { storage: 'unavailable', note: 'The saved keys could not be read.', keys: {} };
    }
    tell(child, { type: 'keys', ...loaded });
  } else if (message.type === 'save-key') {
    tell(child, { type: 'save-key-result', id: message.id, ...(await vault.save(message.name, message.key)) });
  } else if (message.type === 'pick-folder' && typeof message.id === 'string') {
    await answerFolderPick(child, message.id);
  }
}

// Opens the folder dialog for the server's "Browse…" and answers with the folder path, or null when it is cancelled or cannot open.
// The window is shown first, in case it is in the tray. A request that arrives while a dialog is open is answered with null and
// busy: true, so the server refuses it instead of reading it as a cancelled dialog. The path is not logged.
async function answerFolderPick(child, id) {
  if (folderPickOpen) {
    tell(child, { type: 'pick-folder-result', id, path: null, busy: true });
    return;
  }
  folderPickOpen = true;
  let folder = null;
  try {
    showWindow();
    const options = { properties: ['openDirectory'], title: 'Choose a project folder' };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    folder = r.canceled || !r.filePaths?.length ? null : r.filePaths[0];
  } catch {
    folder = null;
  } finally {
    folderPickOpen = false;
  }
  tell(child, { type: 'pick-folder-result', id, path: folder });
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

// Polls the server until it answers. Gives up after 30 seconds.
function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('The local server did not start in time.'));
      else setTimeout(tryOnce, 300);
    };
    const tryOnce = () => {
      const req = http.get(`${APP_URL}api/status`, res => {
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
    if (win) win.loadURL(APP_URL);
  } catch (err) {
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
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
    if (/^https:\/\//.test(url)) shell.openExternal(url);
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
  });
  // Windows is ending the session, which cannot be stopped, so the window must not hide to the tray now.
  win.on('session-end', () => {
    quitting = true;
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
}

// The app state file. lib/store.mjs writes it in the same folder, so the shell and the server share the settings.
function stateFile() {
  return path.join(process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console'), 'state.json');
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
    const req = http.get(`${APP_URL}api/state`, res => {
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

// Holds the PC awake while a run is in progress. Only one blocker is held at a time.
function setKeepAwake(on) {
  if (on && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

// The finished alert: the project name and a short status only. It never carries a prompt or a reply.
function notifyFinished(name) {
  if (!Notification.isSupported()) return;
  // Kept in a variable so the notification is not collected before a click on it can be handled.
  finishedNote = new Notification({ title: 'Plenum finished', body: `${name || 'Project'}: run finished.` });
  finishedNote.on('click', () => showWindow());
  finishedNote.show();
}

// Runs every POLL_MS while the app is open. It keeps the blocker in step with the run and announces a run that has
// ended, and a card that is waiting for an approval. The server reports a run only for the active project, so a run is
// followed only while that project stays active. A poll that gets no answer changes nothing.
async function pollServer() {
  if (polling) return;
  polling = true;
  try {
    const st = await fetchState();
    if (!st) return;
    const { finishedAlerts, keepAwake, approvalAlerts } = alertSettings();
    const active = (st.projects ?? []).find(p => p.id === st.activeProject);
    if (st.running && active) {
      watchedRun = { projectId: active.id, name: active.name };
    } else if (watchedRun && st.activeProject === watchedRun.projectId) {
      const ended = watchedRun;
      watchedRun = null;
      if (finishedAlerts && (!win || !win.isFocused())) notifyFinished(ended.name);
    } else {
      // The user moved to another project, so the run in progress can no longer be followed.
      watchedRun = null;
    }
    // The approval alert is for a card that has just arrived while the window is not focused. The tray text follows the
    // count whether or not the alert shows, so it is right when the window comes back. The notification names the project only.
    const waiting = Number(st.approvalsWaiting) || 0;
    if (shouldAnnounce(lastWaiting, waiting, Boolean(win && win.isFocused()), approvalAlerts)) {
      if (Notification.isSupported()) {
        approvalNote = new Notification({ title: 'Plenum needs your approval', body: `${active?.name ?? 'Project'}: an action is waiting for Approve or Deny.` });
        approvalNote.on('click', () => showWindow());
        approvalNote.show();
      }
    }
    if (waiting !== lastWaiting && tray) {
      tray.setToolTip(tooltipFor(waiting));
      tray.setContextMenu(buildTrayMenu(waiting));
    }
    lastWaiting = waiting;
    setKeepAwake(keepAwake && st.running === true);
  } catch {
    // Polling must never throw into the timer. A failed check changes nothing.
  } finally {
    polling = false;
  }
}

// Brings the window back from the tray, or from behind other windows.
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The tray menu. "Show waiting approval" is enabled only while an approval card waits, and then it says how many.
function buildTrayMenu(waiting) {
  return Menu.buildFromTemplate([
    { label: 'Show Plenum', click: () => showWindow() },
    { label: waiting ? `Show waiting approval (${waiting})` : 'Show waiting approval', enabled: waiting > 0, click: () => showWindow() },
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
  // The tray starts with the count the last poll saw, so a tray made while an approval waits says so at once.
  tray.setToolTip(tooltipFor(lastWaiting));
  tray.setContextMenu(buildTrayMenu(lastWaiting));
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
  createWindow();
  startServer();
  pollTimer = setInterval(pollServer, POLL_MS);
  try {
    await waitForServer();
    if (win) win.loadURL(APP_URL);
  } catch (err) {
    dialog.showErrorBox('Plenum could not start', `${err.message}\n\nLog: ${logFile}`);
    app.quit();
  }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  stopServer();
  clearInterval(pollTimer);
  pollTimer = null;
  setKeepAwake(false);
});
