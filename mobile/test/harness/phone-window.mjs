// The mob-18 phone-size harness, Node side. It runs only inside a sealed copy (build/mobile/src-<id>, started by build/mobile/run.mjs):
//
//   const h = await startPhoneHarness({ name: 'my-suite' });   // a sealed server + one hidden Electron window
//   await h.openApp({ view: PHONE_VIEW, theme: 'light' });     // the desktop UI at 390 x 844, DPR 3, touch, data-surface="phone"
//   await h.shot('my-shot');                                   // C:/t/mob/my-shot.png, read it back with the Read tool
//   await h.theme('dark');                                     // prefers-color-scheme; then shot again
//   const b = await h.enableBridge();                          // Bridge in loopback LAN mode; b.link is the pairing link
//   await h.openFixture(b.link, { theme: 'light' });           // the fixture page at /p/<pathKey>/ with the code in the fragment
//   const p = await h.phonePair({ name: "Will's iPhone" });   // IKpsk2 from a phone in Node (phone-sim); p.code is the check code
//   await h.confirmPairing();                                 // POST /api/phones/pair/confirm { allow: true }, the computer's Allow
//   const left = await h.close();                             // { leftover: [] } when no process of the run is still alive
//
// Options of startPhoneHarness: { name, appRoot, mock, projects }. projects: the project ids the server starts with (default one, p1). appRoot is a private app folder from makeAppCopy() (sealed-server.mjs): the server runs
// from it and the fixture or the built shell is served from its mobile/www, so no other suite can replace the page. mock: true starts the Anthropic
// mock (startMockModel) and runs the server's model against it; h.raiseApproval() then makes a model turn that asks to write a file, which raises an
// approval card in Ask first mode. h.restartServer() stops the server process and starts it again on the same port, token and state folder.
//
// See harness/README.md for every call. Nothing here binds an address but 127.0.0.1, shows a dialog or touches the real state.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { b64uDecode, createPhone, decodeLink, sleep, until } from '../helpers/phone-sim.mjs';
import { freePort, startMockModel, startSealedServer } from '../helpers/sealed-server.mjs';

const HERE = import.meta.dirname;
// <copy>/mobile/test/harness -> <copy>
export const APP_ROOT = path.resolve(HERE, '..', '..', '..');
const SEALED_COPY = /\/build\/mobile\/src-[^/]+$/;
export const SCREEN_DIR = 'C:/t/mob';
export const SCRATCH = 'C:/Users/willi/AppData/Local/Temp/claude/mcshots/scratch-run-mob';
export const ELECTRON = process.env.MOB18_ELECTRON || 'C:/Users/willi/OneDrive/Desktop/Muse Console/node_modules/electron/dist/electron.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';

// MOB18_TRACE=1 appends timed progress lines to C:/t/mob/mob18-trace.log, for finding a hang. Nothing is written otherwise.
export function trace(message) {
  if (process.env.MOB18_TRACE !== '1') return;
  try {
    mkdirSync(SCREEN_DIR, { recursive: true });
    appendFileSync(path.join(SCREEN_DIR, 'mob18-trace.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Tracing never fails a run.
  }
}

export const PHONE_VIEW = Object.freeze({ width: 390, height: 844, dpr: 3, mobile: true, touch: true });
export const DESKTOP_VIEW = Object.freeze({ width: 1280, height: 800, dpr: 1, mobile: false, touch: false });
export const FIXTURE_SCREENS = Object.freeze(['pairing', 'code', 'connected', 'offline', 'reconnecting', 'approval', 'stop-pressed']);
const FIXTURE_FILES = ['index.html', 'fixture.css', 'fixture.js'];
const FIXTURE_MARKER = 'mob18-fixture.txt';

// Probe of the page: which ext-*.js resources loaded (status 200), which script elements exist, and whether MuseUI is there.
const PANEL_PROBE = `(() => {
  const re = /^\\/(ext-[a-z0-9-]+)\\.js$/;
  const scripts = performance.getEntriesByType('resource').map(e => {
    const u = new URL(e.name);
    const m = re.exec(u.pathname);
    return m && u.origin === location.origin ? { name: m[1], status: e.responseStatus } : null;
  }).filter(Boolean);
  const inDom = [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).map(src => /^\\/(ext-[a-z0-9-]+)\\.js$/.exec(src)?.[1]).filter(Boolean);
  return { scripts, inDom, museUi: typeof window.MuseUI === 'object' && window.MuseUI !== null, ready: document.readyState };
})()`;

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// The process ids under a root process (the Electron main process and its Chromium children), taken from the process table.
function treePids(root) {
  const script = `$r=${Number(root)};$a=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId;$s=New-Object System.Collections.ArrayList;[void]$s.Add([int]$r);for($i=0;$i -lt $s.Count;$i++){foreach($p in $a){if([int]$p.ParentProcessId -eq [int]$s[$i] -and -not $s.Contains([int]$p.ProcessId)){[void]$s.Add([int]$p.ProcessId)}}};($s -join ',')`;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const ids = String(r.stdout || '').trim().split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? ids : [Number(root)];
}

function killTree(pid) {
  spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
}

// The harness runs only inside a sealed copy, and writes only into that copy or one of its private app folders (APP_ROOT/.apps/<name>).
function assertSealed(appRoot = APP_ROOT) {
  const norm = APP_ROOT.split(path.sep).join('/');
  if (process.env.MOBILE_SEALED !== '1' || !SEALED_COPY.test(norm)) {
    throw new Error('mob-18 harness: run it only from a sealed copy (node build/mobile/run.mjs --id <name> ...), never from the project folder.');
  }
  const target = path.resolve(appRoot).split(path.sep).join('/');
  if (target !== norm && !target.startsWith(`${norm}/.apps/`)) {
    throw new Error('mob-18 harness: the app folder must be the sealed copy itself or one made by makeAppCopy().');
  }
  if (!existsSync(ELECTRON)) throw new Error(`mob-18 harness: Electron is not at ${ELECTRON}`);
}

// Starts electron.exe on electron-main.cjs. Its stdout says it is ready (one HARNESS line); commands and replies then go over a named
// pipe whose random name only this process knows. Nothing secret goes on the command line or into the environment.
function launchElectron(runDir) {
  const userData = path.join(runDir, 'user-data');
  mkdirSync(userData, { recursive: true });
  // A Windows named pipe: \\.\pipe\<name>. The name is random per run.
  const pipe = '\\\\.\\pipe\\mob18-' + randomBytes(12).toString('hex');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(ELECTRON, [path.join(HERE, 'electron-main.cjs'), `--harness-user-data=${userData}`, `--harness-pipe=${pipe}`], {
    cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const tail = [];
  const pending = new Map();
  let seq = 0;
  let exited = false;
  let socket = null;
  let buf = '';
  let resolveReady;
  let rejectReady;
  const readyRaw = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => rejectReady(new Error(`Electron did not start within 30 s: ${tail.slice(-4).join(' | ')}`)), 30000);
  const pushTail = line => {
    tail.push(line.slice(0, 200));
    if (tail.length > 80) tail.splice(0, tail.length - 80);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
      if (!line.startsWith('HARNESS ')) {
        pushTail(line);
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line.slice('HARNESS '.length));
      } catch {
        continue;
      }
      if (msg.ready) {
        clearTimeout(readyTimer);
        resolveReady(msg);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    for (const l of chunk.split('\n')) if (l.trim()) pushTail(l.trim());
  });
  child.once('exit', code => {
    exited = true;
    clearTimeout(readyTimer);
    // An exit before the ready line must fail the start, not leave it waiting forever.
    rejectReady(new Error(`Electron exited (code ${code}) before it was ready: ${tail.slice(-6).join(' | ')}`));
    for (const p of pending.values()) p.reject(new Error(`Electron exited (code ${code})`));
    pending.clear();
  });
  child.once('error', err => rejectReady(new Error(`Electron did not start: ${err.message}`)));

  // Connects to the command pipe once Electron has said it is ready (the pipe is listening before that line is written).
  async function connect() {
    const sock = net.createConnection(pipe);
    sock.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    sock.on('error', () => {});
    let rbuf = '';
    sock.on('data', chunk => {
      rbuf += chunk;
      let i = rbuf.indexOf('\n');
      while (i >= 0) {
        const line = rbuf.slice(0, i).trim();
        rbuf = rbuf.slice(i + 1);
        i = rbuf.indexOf('\n');
        if (!line.startsWith('HARNESS ')) continue;
        let msg;
        try {
          msg = JSON.parse(line.slice('HARNESS '.length));
        } catch {
          continue;
        }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error)));
      }
    });
    socket = sock;
  }
  const ready = readyRaw.then(() => connect());

  const call = (op, msg = {}, ms = 30000) => new Promise((resolve, reject) => {
    trace(`call ${op}`);
    if (exited || !socket) {
      reject(new Error(`Electron is not connected (${op})`));
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} did not answer within ${ms} ms`)); }, ms);
    pending.set(id, {
      resolve: v => { clearTimeout(timer); trace(`done ${op}`); resolve(v); },
      reject: e => { clearTimeout(timer); trace(`fail ${op}: ${e.message}`); reject(e); },
    });
    socket.write(`${JSON.stringify({ id, op, ...msg })}\n`);
  });

  const waitExit = ms => new Promise(resolve => {
    if (exited) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });

  // Asks Electron to leave, then makes sure every process of its tree is gone. Returns the pids still alive (should be none).
  async function stop() {
    if (exited) return { leftover: [] };
    const tree = treePids(child.pid);
    try {
      await call('exit', {}, 4000);
    } catch {
      // The process may already be leaving.
    }
    if (socket) socket.end();
    if (!(await waitExit(4000))) killTree(child.pid);
    for (let i = 0; i < 20 && tree.some(alive); i++) {
      for (const pid of tree.filter(alive)) killTree(pid);
      await sleep(100);
    }
    return { leftover: tree.filter(alive) };
  }

  return { child, ready, call, stop, tail: () => tail.slice(-20), pid: child.pid, isExited: () => exited };
}

class PhoneHarness {
  constructor({ server, electron, runDir, started, appRoot = APP_ROOT, mock = null }) {
    this.server = server;
    this.appRoot = appRoot;
    this.mock = mock;
    this.turns = [];
    this.electron = electron;
    this.runDir = runDir;
    this.started = started;
    this.bridge = null;
    this.confirmed = null;
    this.closed = false;
    this.sessions = [];
  }

  // Keeps a phone session so close() can end it. Returns the session.
  track(session) {
    this.sessions.push(session);
    return session;
  }

  get origin() {
    return this.server.url;
  }

  // The folder the server serves the phone shell (or the fixture) from.
  get www() {
    return path.join(this.appRoot, 'mobile', 'www');
  }

  // Loads a URL in the window with the given emulation. surface 'phone' sets data-surface="phone" and the Capacitor stub (unless capacitor is false).
  async open(url, { surface = 'phone', view = PHONE_VIEW, theme = 'light', capacitor = surface === 'phone', token = null, tokenOrigin = null, resetLogs = true } = {}) {
    return this.electron.call('open', { url, surface, size: view, theme, capacitor, token, tokenOrigin, resetLogs }, 60000);
  }

  // Marks the first-run "Set up Plenum" wizard (public/ext-setup.js) as finished for the server's origin, before the page that would open it
  // loads. A fresh profile otherwise gets the wizard over every screenshot, and plenumPhoneChecks.audit() would measure the wizard. The key is
  // written from a small static file of the same origin, because localStorage is per origin and the page's own scripts read it at load.
  async dismissSetup({ view = PHONE_VIEW, theme = 'light' } = {}) {
    await this.open(`${this.server.url}/mark.svg`, { surface: 'desktop', view, theme, capacitor: false, token: null, tokenOrigin: null, resetLogs: false });
    await this.eval("(() => { try { localStorage.setItem('plenum-setup-dismissed', '1'); return true; } catch { return false; } })()");
  }

  // The desktop UI from the sealed server. The token goes only to this server's origin. The setup wizard is dismissed first (setup: true keeps it).
  async openApp({ view = PHONE_VIEW, theme = 'light', surface = view === PHONE_VIEW ? 'phone' : 'desktop', resetLogs = true, setup = false } = {}) {
    if (!setup) await this.dismissSetup({ view, theme });
    return this.open(`${this.server.url}/`, { surface, view, theme, capacitor: surface === 'phone', token: this.server.token, tokenOrigin: this.server.url, resetLogs });
  }

  // A model turn that raises an approval card: the mock model asks to write a file and the server is in Ask first mode. Needs mock: true.
  // Resolves { runId?, approvals } once the server reports the card waiting.
  async raiseApproval({ project = 'p1', message = 'WRITE a file for me' } = {}) {
    if (!this.mock) throw new Error('raiseApproval needs startPhoneHarness({ mock: true })');
    // The turn's stream stays open until the card is answered, so it is not awaited: it ends (or is aborted) with close().
    const abort = new AbortController();
    const turn = fetch(`${this.server.url}/api/chat`, {
      method: 'POST',
      headers: { ...this.server.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ project, message }),
      signal: abort.signal,
    }).then(async res => ({ status: res.status, text: await res.text() }), () => ({ status: 0, text: '' }));
    this.turns.push({ abort, turn });
    let approvals = 0;
    await until(async () => {
      approvals = Number((await this.server.state())?.approvalsWaiting) || 0;
      return approvals > 0;
    }, 'an approval card to wait', 15000, 50);
    return { approvals, turn };
  }

  // Stops the server process and starts it again on the same port, token and state folder.
  async restartServer(options) {
    await this.server.restart(options);
    return this.server;
  }

  // A page at the Bridge's /p/<pathKey>/ (the fixture until the shell lands). No token goes to it.
  async openFixture(url, { theme = 'light', view = PHONE_VIEW } = {}) {
    return this.open(url, { surface: 'phone', view, theme, capacitor: true, token: null, tokenOrigin: null });
  }

  async eval(code) {
    return this.electron.call('eval', { code }, 30000);
  }

  // Runs a classic script file (for example helpers/phone-checks.js) in the page. The script must not return a value.
  async evalFile(file) {
    const full = path.isAbsolute(file) ? file : path.join(HERE, '..', 'helpers', path.basename(file));
    const code = readFileSync(full, 'utf8');
    return this.eval(`${code}\nvoid 0;`);
  }

  // A PNG under C:/t/mob/<name>.png. Returns { path, bytes, width, height }: width and height are device pixels.
  async shot(name) {
    return this.electron.call('shot', { name, dir: SCREEN_DIR }, 30000);
  }

  async theme(theme) {
    return this.electron.call('theme', { theme }, 10000);
  }

  async tap(x, y) {
    return this.electron.call('tap', { x, y }, 10000);
  }

  // Console errors, console warnings and uncaught page errors since the last open (with resetLogs true).
  async logs() {
    return this.electron.call('logs', {}, 10000);
  }

  // The desktop UI's extension panels: every public/ext-*.js in this copy, which of them loaded (HTTP 200) and whether MuseUI exists.
  async panels({ timeoutMs = 25000 } = {}) {
    const expected = readdirSync(path.join(this.appRoot, 'public')).filter(n => /^ext-[a-z0-9-]+\.js$/.test(n)).map(n => n.slice(0, -3)).sort();
    const t0 = Date.now();
    let probe;
    for (;;) {
      probe = await this.eval(PANEL_PROBE);
      const loaded = new Set(probe.scripts.filter(s => s.status === 200).map(s => s.name));
      if (expected.every(n => loaded.has(n)) || Date.now() - t0 > timeoutMs) break;
      await sleep(250);
    }
    const loaded = [...new Set(probe.scripts.filter(s => s.status === 200).map(s => s.name))].sort();
    const served = await this.server.get('/api/ext-modules');
    const serverList = Array.isArray(served.body?.modules) ? [...served.body.modules].sort() : [];
    return {
      expected,
      registered: expected.filter(n => loaded.includes(n) && probe.inDom.includes(n)),
      missing: expected.filter(n => !loaded.includes(n)),
      extra: loaded.filter(n => !expected.includes(n)),
      serverListMatches: JSON.stringify(serverList) === JSON.stringify(expected),
      museUi: probe.museUi,
      ms: Date.now() - t0,
    };
  }

  // Makes the Bridge's loopback LAN carrier run and returns the pairing link (it carries the page URL with the code in the fragment).
  async enableBridge({ port } = {}) {
    ensureFixture(this.appRoot);
    const p = port ?? await freePort();
    const set = await this.server.post('/api/phones/settings', { enabled: true, port: p });
    if (set.status !== 200) throw new Error(`phones settings: ${set.status}`);
    const lan = await this.server.post('/api/phones/lan', { enabled: true, anyAddress: false });
    if (lan.status !== 200) throw new Error(`phones lan: ${lan.status}`);
    const made = await this.server.post('/api/phones/pair/start', {});
    if (made.status !== 200 || typeof made.body?.link !== 'string') throw new Error(`pair/start: ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
    // The server's links name the Same-network address, which sealed runs do not listen on (the listener is bound to 127.0.0.1).
    // Every carrier's link carries the same fragment, so the loopback page link is rebuilt from the listener's port and path key.
    const served = made.body.link;
    const at = /^https?:\/\/[^/]+:(\d+)\/p\/([0-9a-f]{32})\/#pair=/.exec(served);
    if (!at) throw new Error(`the pairing link has no page address: ${served.slice(0, 40)} hints ${JSON.stringify(made.body.hints ?? null).slice(0, 300)}`);
    const listenerPort = Number(at[1]);
    const pathKey = at[2];
    const fragment = served.slice(served.indexOf('#pair='));
    const payload = decodeLink(served);
    this.bridge = {
      link: `http://127.0.0.1:${listenerPort}/p/${pathKey}/${fragment}`,
      payload,
      port: listenerPort,
      pathKey,
      pageUrl: `http://127.0.0.1:${listenerPort}/p/${pathKey}/`,
      wsUrl: `ws://127.0.0.1:${listenerPort}/b/${pathKey}`,
      desktopPub: b64uDecode(payload.pub),
      servedLink: served,
    };
    return this.bridge;
  }

  // The phone's side of pairing: IKpsk2 against the offer, through the fragment's link. Resolves with the six-digit code the phone shows.
  async phonePair({ name = "Will's iPhone", platform = 'ios' } = {}) {
    if (!this.bridge) throw new Error('call enableBridge() first');
    const phone = createPhone({ name, platform, app: 'pwa' });
    // The phone dials the loopback socket: the payload's own Same-network URL is not listened on in sealed runs.
    const paired = await phone.pair(decodeLink(this.bridge.link), { url: this.bridge.wsUrl });
    this.track(paired.session);
    return { phone, paired, code: paired.code, session: paired.session, hello: paired.hello };
  }

  // Allow on the computer: the confirm route, retried until the phone's first message has been read (409 until then).
  async confirmPairing() {
    let answer = null;
    await until(async () => {
      answer = await this.server.post('/api/phones/pair/confirm', { allow: true });
      if (answer.status === 200) return true;
      if (answer.status !== 409) throw new Error(`pair/confirm: ${answer.status}`);
      return false;
    }, 'the phone to reach the confirm step', 10000, 50);
    this.confirmed = answer.body;
    return answer.body;
  }

  // Shows one of the fixture's screens (fixture.js). data is plain text only.
  async fixture(screen, data = {}) {
    if (!FIXTURE_SCREENS.includes(screen)) throw new Error(`no fixture screen ${screen}`);
    return this.eval(`plenumFixture.show(${JSON.stringify(screen)}, ${JSON.stringify(data)})`);
  }

  // Stops everything the run started. Returns { leftover, ms } with the process ids still alive (none is the goal).
  async close() {
    if (this.closed) return { leftover: [], ms: Date.now() - this.started };
    this.closed = true;
    trace('close');
    for (const session of this.sessions) {
      try {
        session.close();
      } catch {
        // Already closed.
      }
    }
    for (const { abort } of this.turns) abort.abort();
    const report = await this.electron.stop();
    await this.server.stop();
    await this.mock?.close().catch(() => {});
    try {
      rmSync(this.runDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A file still in use is left for the next run's cleanup; no process holds it now.
    }
    return { leftover: report.leftover, ms: Date.now() - this.started, serverExited: this.server.exited() };
  }
}

// Copies the fixture page into the app folder's mobile/www when there is no real shell there yet. A real shell (no marker) is never overwritten.
// Like the harness itself it writes only inside a sealed copy: it checks first, so a call from the project folder fails before it touches anything.
export function ensureFixture(appRoot = APP_ROOT) {
  assertSealed(appRoot);
  const target = path.join(appRoot, 'mobile', 'www');
  const marker = path.join(target, FIXTURE_MARKER);
  if (existsSync(path.join(target, 'index.html')) && !existsSync(marker)) return 'shell';
  mkdirSync(target, { recursive: true });
  for (const file of FIXTURE_FILES) copyFileSync(path.join(HERE, 'fixture', file), path.join(target, file));
  writeFileSync(marker, 'mob-18 fixture page: stands in for the shell until mobile/www has the real shell. Written by phone-window.mjs.\n');
  return 'fixture';
}

// Starts the sealed server (echo model, loopback only, scratch state) and one hidden Electron window. Call close() when done.
export async function startPhoneHarness({ name = 'harness', appRoot = APP_ROOT, mock = false, projects = undefined } = {}) {
  assertSealed(appRoot);
  const started = Date.now();
  mkdirSync(SCRATCH, { recursive: true });
  const runDir = mkdtempSync(path.join(SCRATCH, `mob18-${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}-`));
  let server = null;
  let electron = null;
  let model = null;
  try {
    if (mock) model = await startMockModel();
    server = await startSealedServer({ name: `mob18-${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`, appRoot, mock: model, ...(projects ? { projects } : {}) });
    trace('server up');
    electron = launchElectron(runDir);
    await electron.ready;
    trace('electron ready');
  } catch (err) {
    trace(`start failed: ${err.message}`);
    if (electron) await electron.stop().catch(() => {});
    if (server) await server.stop().catch(() => {});
    if (model) await model.close().catch(() => {});
    rmSync(runDir, { recursive: true, force: true });
    throw err;
  }
  return new PhoneHarness({ server, electron, runDir, started, appRoot, mock: model });
}
