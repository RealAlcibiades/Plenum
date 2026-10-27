// The Electron main process of the mob-18 phone-size harness. Only phone-window.mjs starts it (through the project's own
// node_modules/electron/dist/electron.exe, with a throwaway --harness-user-data folder under scratch-run-mob). It never shows a dialog:
// the one BrowserWindow is opacity 0, focusable false, skipTaskbar and shown with showInactive().
//
// Commands come in over a named pipe (--harness-pipe=<name>), one JSON object per line: { id, op, ...args }. Each reply is one line
// that starts with 'HARNESS ' on the same pipe. stdout carries only the ready line. (process.stdin is not used: in the Electron main
// process it ends at once.) The ops are listed at the bottom of this file. An uncaught error or an unhandled rejection exits at once,
// so a broken harness never leaves a window or a dialog behind.
process.on('uncaughtException', e => { console.error(e); require('electron').app.exit(1); });
process.on('unhandledRejection', e => { console.error(e); require('electron').app.exit(1); });

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const PRELOAD = path.join(__dirname, 'preload.cjs');
const STUB_SOURCE = fs.readFileSync(path.join(__dirname, 'capacitor-stub.js'), 'utf8');
const MAX_LOG = 200;
// MOB18_TRACE=1 appends step names to C:/t/mob/mob18-trace.log (the orchestrator's trace file), for finding a hang.
const trace = m => { if (process.env.MOB18_TRACE === '1') { try { fs.appendFileSync('C:/t/mob/mob18-trace.log', `${new Date().toISOString()} main ${m}
`); } catch { /* never fails a run */ } } };

const userDataArg = process.argv.find(a => a.startsWith('--harness-user-data='));
if (userDataArg) app.setPath('userData', userDataArg.slice('--harness-user-data='.length));

// What the page may read. The token goes only to the frame at the server origin named by the last 'open' (tokenOrigin).
const state = {
  win: null,
  surface: 'phone',
  token: '',
  tokenOrigin: '',
  stubId: null,
  logs: { errors: [], warnings: [], pageErrors: [] },
};

const note = (list, item) => { if (list.length < MAX_LOG) list.push(item); };
const ownWindow = event => state.win !== null && event.sender === state.win.webContents;

// Sync read in the preload: the surface marker. The desktop surface gets no marker (the real app sets none).
ipcMain.on('harness:config', event => {
  event.returnValue = { surface: ownWindow(event) && state.surface === 'phone' ? 'phone' : '' };
});

// Async read in the preload: the token, to the server origin only (never to the Bridge's page or any other origin).
ipcMain.handle('harness:token', event => {
  const url = String(event.senderFrame?.url ?? '');
  const origin = state.tokenOrigin;
  if (!ownWindow(event) || !origin) return '';
  return url === origin || url.startsWith(`${origin}/`) ? state.token : '';
});

// Every debugger command has a limit: a stalled one is an error, never a hang.
const send = (method, params = {}) => Promise.race([
  state.win.webContents.debugger.sendCommand(method, params),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} did not answer in 8 s`)), 8000)),
]);

function remoteText(arg) {
  if (arg && arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return String(arg?.description ?? arg?.type ?? '');
}

// Console output and page errors come from the debugger, so every Electron version reports them the same way.
function onDebug(method, p) {
  if (method === 'Runtime.consoleAPICalled') {
    const text = (p.args || []).map(remoteText).join(' ').slice(0, 500);
    if (p.type === 'error' || p.type === 'assert') note(state.logs.errors, { source: 'console', text });
    else if (p.type === 'warning') note(state.logs.warnings, { source: 'console', text });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails || {};
    note(state.logs.pageErrors, { text: String(d.exception?.description || d.text || '').split('\n')[0].slice(0, 500), url: d.url || '' });
  } else if (method === 'Log.entryAdded') {
    const e = p.entry || {};
    if (e.level === 'error') note(state.logs.errors, { source: e.source || 'log', text: String(e.text || '').slice(0, 500), url: e.url || '' });
    else if (e.level === 'warning') note(state.logs.warnings, { source: e.source || 'log', text: String(e.text || '').slice(0, 500), url: e.url || '' });
  }
}

async function attach(win) {
  const dbg = win.webContents.debugger;
  trace('attach: attaching');
  dbg.attach('1.3');
  trace('attach: attached');
  dbg.on('message', (_event, method, params) => onDebug(method, params));
  // A debugger command sent before the first navigation can wait for that navigation, so these are not awaited here: open() waits
  // for them after its loadURL, with a limit.
  const enables = ['Page.enable', 'Runtime.enable', 'Log.enable'].map(method => dbg.sendCommand(method).then(() => trace(`attach: ${method} done`), e => trace(`attach: ${method} ${e.message}`)));
  return Promise.all(enables);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 390,
    height: 844,
    useContentSize: true,
    show: false,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    title: 'Plenum harness',
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setOpacity(0);
  win.showInactive();
  win.on('closed', () => { state.win = null; state.stubId = null; });
  return win;
}

async function setTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light';
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  return value;
}

async function setCapacitor(on) {
  if (on && state.stubId === null) {
    state.stubId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SOURCE })).identifier;
  } else if (!on && state.stubId !== null) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: state.stubId });
    state.stubId = null;
  }
}

// open: loads a page with the given emulation. Logs are reset unless resetLogs is false.
async function open(m) {
  trace('open start');
  if (!state.win) {
    state.win = createWindow();
    trace('window made');
    // The debugger is attached once the window has a document: a command sent before the first navigation stalls.
    await state.win.webContents.loadURL('about:blank');
    trace('blank loaded');
    state.enabled = attach(state.win);
    await state.enabled;
    trace('attached');
  }
  state.surface = m.surface === 'desktop' ? 'desktop' : 'phone';
  state.token = typeof m.token === 'string' ? m.token : '';
  state.tokenOrigin = typeof m.tokenOrigin === 'string' ? m.tokenOrigin.replace(/\/$/, '') : '';
  if (m.resetLogs !== false) state.logs = { errors: [], warnings: [], pageErrors: [] };
  const size = m.size ?? { width: 390, height: 844, dpr: 3, mobile: true, touch: true };
  state.win.setContentSize(size.width, size.height);
  await send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: size.mobile === true,
    screenWidth: size.width, screenHeight: size.height,
  });
  trace('metrics set');
  await send('Emulation.setTouchEmulationEnabled', { enabled: size.touch === true, maxTouchPoints: size.touch === true ? 5 : 1 });
  trace('touch set');
  await setTheme(m.theme ?? 'light');
  trace('theme set');
  await setCapacitor(m.capacitor === true);
  trace('capacitor set');
  const contents = state.win.webContents;
  await Promise.race([
    contents.loadURL(String(m.url)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`the page did not load in 20 s: ${m.url}`)), 20000)),
  ]);
  trace('loaded');
  return { url: contents.getURL(), title: contents.getTitle(), surface: state.surface };
}

async function evaluate(m) {
  if (!state.win) throw new Error('no window is open');
  const value = await state.win.webContents.executeJavaScript(String(m.code), true);
  return value === undefined ? null : value;
}

// shot: waits two frames, then captures the page at its device pixel ratio as a PNG under dir (C:/t/mob by default).
async function shot(m) {
  if (!state.win) throw new Error('no window is open');
  const dir = String(m.dir || 'C:/t/mob');
  const name = String(m.name || 'shot').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  await Promise.race([
    state.win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(data, 'base64');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, buf);
  return { path: file, bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// tap: one touch at a CSS-pixel point of the emulated viewport.
async function tap(m) {
  const x = Number(m.x);
  const y = Number(m.y);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, force: 1, radiusX: 1, radiusY: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return { x, y };
}

const OPS = {
  ping: () => ({ pid: process.pid }),
  open,
  eval: evaluate,
  shot,
  theme: async m => ({ theme: await setTheme(m.theme) }),
  tap,
  logs: () => ({ errors: state.logs.errors.slice(), warnings: state.logs.warnings.slice(), pageErrors: state.logs.pageErrors.slice() }),
  exit: () => { setImmediate(() => app.exit(0)); return { bye: true }; },
};

// Replies go to the one client on the named pipe. (process.stdin is not used: in the Electron main process it ends at once.)
let client = null;
const reply = obj => {
  if (client && !client.destroyed) client.write(`HARNESS ${JSON.stringify(obj)}\n`);
};

async function run(line) {
  await app.whenReady();
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return reply({ id: null, ok: false, error: 'the command is not JSON' });
  }
  const fn = Object.prototype.hasOwnProperty.call(OPS, msg.op) ? OPS[msg.op] : null;
  if (!fn) return reply({ id: msg.id ?? null, ok: false, error: `unknown op ${String(msg.op)}` });
  try {
    const result = await fn(msg);
    reply({ id: msg.id ?? null, ok: true, result: result ?? null });
  } catch (err) {
    reply({ id: msg.id ?? null, ok: false, error: String(err?.message ?? err) });
  }
}

app.on('window-all-closed', () => {});

// The command pipe: one client (phone-window.mjs), newline-delimited JSON. The client going away ends the harness.
const PIPE_ARG = process.argv.find(a => a.startsWith('--harness-pipe='));
const PIPE = PIPE_ARG ? PIPE_ARG.slice('--harness-pipe='.length) : '';
const server = net.createServer(socket => {
  if (client) {
    socket.destroy();
    return;
  }
  client = socket;
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) run(line);
      i = buffer.indexOf('\n');
    }
  });
  socket.on('end', () => app.exit(0));
  socket.on('error', () => app.exit(0));
});
server.on('error', e => {
  console.error(e);
  app.exit(1);
});

// The ready line on stdout says the pipe is listening and the app is ready. Its pid is the only thing it tells the orchestrator.
Promise.all([app.whenReady(), new Promise(resolve => server.listen(PIPE, resolve))]).then(() => {
  process.stdout.write(`HARNESS ${JSON.stringify({ ready: true, pid: process.pid })}\n`);
});
