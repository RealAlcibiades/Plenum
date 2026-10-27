// A sealed Plenum server for the Bridge suites (mob-03). Starts `node server.mjs` from the app folder the suite runs in (the sealed
// runner's copy), on a random loopback port, with its own state folder, a fresh token and no real model: the offline echo model by
// default, or a mock of the Anthropic messages API on 127.0.0.1 that the test controls (startMockModel) when a run has to be held open.
// Nothing here reaches the network, a real provider or a real state folder.
//
//   const server = await startSealedServer({ name: 'a', mock, phones: { enabled: true, port } });
//   await server.post('/api/phones/settings', { enabled: true });  // { status, body, headers }
//   server.stop();
//
// server.restart() stops the process and starts it again on the same port, token and state folder (a phone's reconnect can be tested on it).
// Options: accepted (default true: the License Agreement is accepted by the harness preload; false starts without it), projects (ids),
// phones (seeds state.phones), ipc (true: the server is started with a message channel and a fake desktop shell answers it, see
// `server.shell`), testRoutes (true: adds the test-only routes in installTestRoutes to the COPY the suite runs in), appRoot (another app
// folder), seed(home) (called before start), env.
//
// Also here: installX25519Counter (counts the Diffie-Hellman operations of this process, to show a bad mac1 costs none),
// makeBareApp (a copy of the app with no phone packages in reach, for the "Phones need a newer Plenum build." answer; its node_modules
// is a folder of per-entry junctions that leaves out ws, qrcode-generator and the @noble packages), freePort,
// until and sleep.
import { spawn } from 'node:child_process';
import fs, { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

export const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(fn, label = 'a condition', ms = 10_000, step = 15) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(step);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Counting Diffie-Hellman operations

// Must run before lib/remote/noise.mjs is first imported in this process (import the library with `await import()` afterwards).
// Replaces the module '@noble/curves/ed25519.js' for noise.mjs with a wrapper whose x25519.getSharedSecret counts into
// globalThis.__x25519Dh. Returns { count() }.
export async function installX25519Counter() {
  const real = import.meta.resolve('@noble/curves/ed25519.js');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'x25519-'));
  const stub = path.join(dir, 'stub.mjs');
  await fsp.writeFile(stub, [
    `import { x25519 as base } from ${JSON.stringify(real)};`,
    `export * from ${JSON.stringify(real)};`,
    'export const x25519 = Object.freeze({ ...base, getSharedSecret(...args) { globalThis.__x25519Dh = (globalThis.__x25519Dh || 0) + 1; return base.getSharedSecret(...args); } });',
    '',
  ].join('\n'));
  const hook = `
let stubUrl;
export function initialize(data) { stubUrl = data.stub; }
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@noble/curves/ed25519.js' && context.parentURL !== stubUrl) return { url: stubUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`, { parentURL: import.meta.url, data: { stub: pathToFileURL(stub).href } });
  globalThis.__x25519Dh = 0;
  return { count: () => globalThis.__x25519Dh };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A mock of the Anthropic messages API, on loopback, that a test can hold open

// The latest user message may carry a marker: HOLD:<name> keeps the response open until gate('<name>').release() or the connection
// closes; WRITE asks the server to write a file (which raises an approval card in Ask first mode); AGENT:<name> asks it to delegate a task
// to a researcher agent whose own request carries the marker HOLD:<name>. A gate is used once (see below). Anything else is answered with a short text.
export async function startMockModel() {
  const log = [];
  const gates = new Map();
  let n = 0;
  const gate = name => {
    if (!gates.has(name)) {
      let release;
      const promise = new Promise(r => { release = r; });
      let reached;
      const reachedPromise = new Promise(r => { reached = r; });
      gates.set(name, { name, promise, release, reachedPromise, reached, held: 0, done: false });
    }
    const g = gates.get(name);
    return { release: () => g.release(), reached: g.reachedPromise, get held() { return g.held; } };
  };
  const textOf = content => (typeof content === 'string' ? content : (content ?? []).map(b => (b.type === 'text' ? b.text : '')).join('\n'));
  const userText = messages => textOf([...messages].reverse().find(m => m.role === 'user')?.content);
  const events = blocks => {
    const reason = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const list = [['message_start', { message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }]];
    blocks.forEach((b, i) => {
      if (b.type === 'text') {
        list.push(['content_block_start', { index: i, content_block: { type: 'text', text: '' } }]);
        list.push(['content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } }]);
      } else {
        list.push(['content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
        list.push(['content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }]);
      }
      list.push(['content_block_stop', { index: i }]);
    });
    list.push(['message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } }]);
    list.push(['message_stop', {}]);
    return list;
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    const messages = body.messages ?? [];
    const latest = userText(messages).split('\n').filter(Boolean).at(-1) ?? '';
    const blocks = messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));
    const results = blocks.filter(b => b.type === 'tool_result');
    const entry = { seq: log.length + 1, user: userText(messages), tools: (body.tools ?? []).map(t => t.name), aborted: false };
    log.push(entry);
    // The newest marker wins: messages stopped before an answer stay in the history and reach the model joined to the next one.
    const hold = [...userText(messages).matchAll(/HOLD:(\w+)/g)].at(-1)?.[1];
    // A held gate is used once: after its request was released or abandoned, later requests that still carry the marker (a stopped message
    // stays in the history and is sent again with the next one) are answered at once.
    if (hold && !(gates.get(hold)?.done)) {
      gate(hold);
      const state = gates.get(hold);
      state.held += 1;
      state.reached();
      const closed = new Promise(r => res.on('close', r));
      await Promise.race([state.promise, closed]);
      state.held -= 1;
      state.done = true;
      if (res.destroyed || res.closed) {
        entry.aborted = true;
        return;
      }
    }
    let out;
    if (/WRITE/.test(latest) && !results.length) {
      out = [{ type: 'tool_use', id: `toolu_${++n}`, name: 'write_file', input: { path: 'mob-card.txt', content: 'hello\n' } }];
    } else if (/AGENT/.test(latest) && !results.length && entry.tools.includes('delegate')) {
      const gateName = /AGENT:(\w+)/.exec(latest)?.[1] ?? 'agent';
      out = [{ type: 'tool_use', id: `toolu_${++n}`, name: 'delegate', input: { title: 'Look around', agent: 'researcher', instructions: `HOLD:${gateName} look at the project and report.` } }];
    } else if (results.length) {
      out = [{ type: 'text', text: 'Done after the tool result.' }];
    } else {
      out = [{ type: 'text', text: `OK ${latest.slice(0, 40)}` }];
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [type, data] of events(out)) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    gate,
    close: () => { server.closeAllConnections?.(); return new Promise(r => server.close(r)); },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Test-only routes, added to the sealed runner's COPY of the app (never to the project)

const TEST_ROUTES = `// Test-only routes for the mob-03 suites. Written into the sealed runner's copy of the app by mobile/test/helpers/sealed-server.mjs.
import { startDrive } from '../drive.mjs';
import * as events from '../events.mjs';
import { checkRequest } from '../auth.mjs';
export const routes = [
  { method: 'POST', path: '/api/_mobtest/drive', handler: async ({ req, res, json, readBody }) => {
    const body = await readBody(req);
    const drive = startDrive({ kind: body.kind === 'browser' ? 'browser' : 'computer', projectId: String(body.project), label: 'mob test run' });
    return json(res, 200, { drive: drive.summary() });
  } },
  { method: 'POST', path: '/api/_mobtest/publish', handler: async ({ req, res, json, readBody }) => {
    const body = await readBody(req);
    events.publish({ type: 'notice', text: String(body.text ?? 'test'), mark: body.mark ?? null });
    return json(res, 200, { ok: true, at: Date.now() });
  } },
  { method: 'GET', path: '/api/_mobtest/headers', handler: ({ req, res, json }) => json(res, 200, {
    host: req.headers.host ?? null,
    device: req.headers['x-plenum-device'] ?? null,
    clientId: req.headers['x-plenum-client-id'] ?? null,
    contentType: req.headers['content-type'] ?? null,
    hasOrigin: 'origin' in req.headers,
    hasCookie: 'cookie' in req.headers,
    tokenOk: checkRequest(req) === null,
    names: Object.keys(req.headers).sort(),
  }) },
  { method: 'POST', path: '/api/_mobtest/sink', handler: async ({ req, res, json }) => {
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    return json(res, 200, { bytes });
  } },
];
`;

// Adds lib/routes/zz-mob-test.mjs to a sealed runner copy. Refuses anywhere else (the project itself must never get it).
export async function installTestRoutes(appRoot = APP_ROOT) {
  const norm = appRoot.split(path.sep).join('/');
  if (process.env.MOBILE_SEALED !== '1' || !/\/build\/mobile\/src-[^/]+\/?$/.test(norm)) {
    throw new Error('test routes are only written into a sealed runner copy');
  }
  const file = path.join(appRoot, 'lib', 'routes', 'zz-mob-test.mjs');
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, TEST_ROUTES);
  await fsp.rename(temp, file);
  return file;
}

export const canInstallTestRoutes = (appRoot = APP_ROOT) => process.env.MOBILE_SEALED === '1' && /\/build\/mobile\/src-[^/]+\/?$/.test(appRoot.split(path.sep).join('/'));

// ---------------------------------------------------------------------------------------------------------------------------------
// An app folder with no phone packages in reach

// The packages the phone layer needs. A bare app must not find them: not in its own node_modules (CI installs them into the root one, so
// the root folder cannot simply be linked in whole) and not above it (the temp folder has nothing above it).
const PHONE_PACKAGES = new Set(['ws', 'qrcode-generator']);
const PHONE_SCOPES = new Map([['@noble', new Set(['curves', 'ciphers', 'hashes'])]]);

function linkDir(target, at) {
  fs.symlinkSync(target, at, 'junction');
}

// Removes one junction (or symlink) without following it, and anything else with the plain recursive remove.
function dropEntry(at) {
  let st;
  try {
    st = fs.lstatSync(at);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      fs.rmdirSync(at);
    } catch {
      fs.unlinkSync(at);
    }
  } else if (st.isDirectory()) {
    for (const name of fs.readdirSync(at)) dropEntry(path.join(at, name));
    fs.rmdirSync(at);
  } else {
    fs.unlinkSync(at);
  }
}

// A copy of lib/, public/, legal/, desktop/, server.mjs and package.json in the temp folder. Its node_modules is a real folder of one
// junction per entry of the copy's own node_modules (the project's packages), leaving out ws, qrcode-generator and the @noble packages
// the phone layer imports, so the "Phones need a newer Plenum build." answer holds on CI too, where those are installed at the root.
export async function makeBareApp(base) {
  const root = path.join(base, 'bare-app');
  await fsp.mkdir(root, { recursive: true });
  for (const name of ['lib', 'public', 'legal', 'desktop']) {
    if (fs.existsSync(path.join(APP_ROOT, name))) await fsp.cp(path.join(APP_ROOT, name), path.join(root, name), { recursive: true });
  }
  for (const name of ['server.mjs', 'package.json']) await fsp.copyFile(path.join(APP_ROOT, name), path.join(root, name));
  await fsp.rm(path.join(root, 'lib', 'routes', 'zz-mob-test.mjs'), { force: true });
  const source = path.join(APP_ROOT, 'node_modules');
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const name = entry.name;
    if (name === '.bin' || name.startsWith('.') || PHONE_PACKAGES.has(name)) continue;
    const from = path.join(source, name);
    if (name.startsWith('@')) {
      const left = PHONE_SCOPES.get(name) ?? new Set();
      const inner = fs.readdirSync(from).filter(n => !left.has(n));
      if (inner.length === 0) continue;
      const scopeDir = path.join(modules, name);
      fs.mkdirSync(scopeDir, { recursive: true });
      for (const n of inner) linkDir(path.join(from, n), path.join(scopeDir, n));
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      linkDir(from, path.join(modules, name));
    }
  }
  return root;
}

// Takes the junctions out one by one (a recursive remove must never follow one into the copy's real node_modules), then the folder.
export function removeBareApp(root) {
  try {
    dropEntry(path.join(root, 'node_modules'));
  } catch {
    // Already gone, or a junction that would not go: the recursive remove below leaves the real folders alone.
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A private app folder for one suite

// The suites that build the phone shell (shell-core, shell-screens, shell.e2e, regression, ui-phone) used to write the same copy's mobile/www,
// and the build removes the folder first, so one suite's build could pull the page from under another's. Each now takes its own app folder:
// lib, public, legal, desktop, scripts, server.mjs, package.json, mobile/shell, mobile/plugins and mobile/package.json copied from the copy the
// suite runs in, and an empty relay/public for the build to write. It lives in APP_ROOT/.apps (inside the sealed runner's copy, which the runner
// clears at the start of every run). No junction and no copy of node_modules: Node resolves packages upward from there, through the copy's own
// node_modules to the shared install above it, and esbuild finds mobile/package.json and the shared packages the same way.
//   const app = await makeAppCopy('shell-core');          // an absolute path
//   spawnSync(node, [build-mobile.mjs, '--root', app]);     // writes <app>/mobile/www and <app>/relay/public
//   await startSealedServer({ appRoot: app });              // serves the copy's lib and public, and its mobile/www as the LAN shell
//   removeAppCopy(app);
export const APP_COPY_BASE = path.join(APP_ROOT, '.apps');
const APP_COPY_DIRS = ['lib', 'public', 'legal', 'desktop', 'scripts'];

export async function makeAppCopy(name = 'app', base = APP_COPY_BASE) {
  const norm = path.resolve(base).split(path.sep).join('/');
  if (process.env.MOBILE_SEALED !== '1' || !norm.startsWith(`${path.resolve(APP_ROOT).split(path.sep).join('/')}/`)) {
    throw new Error('an app copy is made only inside the sealed runner copy, never in the project');
  }
  await fsp.mkdir(base, { recursive: true });
  const root = await fsp.mkdtemp(path.join(base, `${String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'app'}-`));
  for (const dir of APP_COPY_DIRS) {
    if (fs.existsSync(path.join(APP_ROOT, dir))) await fsp.cp(path.join(APP_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  await fsp.rm(path.join(root, 'lib', 'routes', 'zz-mob-test.mjs'), { force: true });
  for (const file of ['server.mjs', 'package.json']) await fsp.copyFile(path.join(APP_ROOT, file), path.join(root, file));
  await fsp.mkdir(path.join(root, 'mobile'), { recursive: true });
  for (const dir of ['shell', 'plugins']) {
    if (fs.existsSync(path.join(APP_ROOT, 'mobile', dir))) await fsp.cp(path.join(APP_ROOT, 'mobile', dir), path.join(root, 'mobile', dir), { recursive: true });
  }
  await fsp.copyFile(path.join(APP_ROOT, 'mobile', 'package.json'), path.join(root, 'mobile', 'package.json'));
  await fsp.mkdir(path.join(root, 'relay', 'public'), { recursive: true });
  return root;
}

export function removeAppCopy(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The server

// A desktop shell that answers over the IPC channel. The registry store is kept in memory; the pairing window is recorded, not drawn.
function fakeShell(token) {
  let proc = null;
  const shell = {
    messages: [],
    store: '',
    handlers: {},
    pairShows: [],
    send(type, extra = {}) { proc.send({ type, ...extra }); },
    last(type) { return [...shell.messages].reverse().find(m => m.type === type) ?? null; },
    // Wires the shell to a (new) server process. A restarted server finds the same registry store and the same recorded messages.
    attach(next) { proc = next; wire(next); },
  };
  shell.handlers = {
    'phones-store-load': () => ({ ok: true, storage: 'keychain', text: shell.store, damaged: false }),
    'phones-store-save': msg => { shell.store = msg.text; return { ok: true, storage: 'keychain' }; },
    'phones-pair-show': msg => { shell.pairShows.push(msg); return { ok: true }; },
    'phones-presence': () => ({ ok: true, focused: false, idleS: 999 }),
    'phones-clipboard': () => ({ ok: true }),
    'phones-artifact-picture': () => ({ ok: false, message: 'Pictures of artifacts are not in this build yet.' }),
  };
  function wire(target) {
    target.on('message', async msg => {
      if (!msg || typeof msg !== 'object') return;
      shell.messages.push(msg);
      if (msg.type === 'keys-hello') {
        try {
          target.send({ type: 'keys', storage: 'session', keys: {}, note: '', token });
        } catch {
          // The server went away.
        }
        return;
      }
      const handler = shell.handlers[msg.type];
      if (msg.id !== undefined && handler) {
        const reply = await handler(msg);
        try {
          target.send({ ...reply, type: `${msg.type}-result`, id: msg.id });
        } catch {
          // The server went away.
        }
      }
    });
  }
  return shell;
}

export async function startSealedServer(options = {}) {
  const {
    name = 'srv', accepted = true, mock = null, projects = ['p1'], phones = null, ipc = false, testRoutes = false,
    appRoot = APP_ROOT, env = {}, seed = null, state: extraState = {}, loopbackHint = true,
  } = options;
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `m3-${name}-`)));
  const home = path.join(base, 'home');
  await fsp.mkdir(home, { recursive: true });
  if (testRoutes) await installTestRoutes(appRoot);
  const folders = {};
  for (const id of projects) {
    folders[id] = path.join(base, 'projects', id);
    await fsp.mkdir(folders[id], { recursive: true });
  }
  await fsp.writeFile(path.join(home, 'state.json'), JSON.stringify({
    projects: projects.map(id => ({ id, name: id, path: folders[id] })),
    activeProject: projects[0] ?? null,
    model: mock ? 'anthropic:claude-haiku-5-5' : 'echo:offline',
    advisor: null,
    advisorAuto: false,
    approvals: 'ask',
    effort: 'low',
    chats: {},
    ...(phones ? { phones } : {}),
    ...extraState,
  }, null, 2));
  if (seed) await seed(home, base);
  const port = await freePort();
  if (port === 4317) throw new Error('never the live port');
  const token = randomBytes(32).toString('hex');
  const childEnv = {
    ...process.env,
    PORT: String(port),
    PLENUM_TOKEN: token,
    MUSE_CONSOLE_HOME: home,
    MUSE_CONSOLE_CLAUDE: 'api',
    MUSE_CONSOLE_NO_FALLBACK: '1',
    MUSE_CONSOLE_APP_ROOT: appRoot,
    MOBILE_SEALED: '1',
    ANTHROPIC_BASE_URL: mock ? mock.url : 'http://127.0.0.1:9',
    ...(mock ? { ANTHROPIC_API_KEY: 'sk-test-mock-not-real' } : {}),
    ...(loopbackHint ? { PLENUM_REMOTE_LOOPBACK_HINT: '1' } : {}),
    ...(ipc ? { MUSE_CONSOLE_KEY_CHANNEL: 'ipc' } : {}),
    ...env,
  };
  delete childEnv.PLENUM_TEST_REAL_LAN;
  if (!accepted) delete childEnv.NODE_OPTIONS;
  let output = '';
  let proc = null;
  let gone = false;
  let exited = null;
  const shell = ipc ? fakeShell(token) : null;
  // Starts node server.mjs on the same port, state folder and token. restart() uses it again after the first process was stopped.
  const launch = () => {
    gone = false;
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: appRoot,
      env: childEnv,
      stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    const ended = new Promise(resolve => child.once('exit', () => { if (proc === child) gone = true; resolve(); }));
    proc = child;
    exited = ended;
    shell?.attach(child);
  };
  launch();
  const url = `http://127.0.0.1:${port}`;
  const headers = { 'x-plenum-token': token };

  const request = async (method, route, body, extra = {}) => {
    const init = { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, signal: AbortSignal.timeout(60_000) };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(url + route, init);
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: the text is the body.
    }
    return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers) };
  };

  const ready = async (ms = 30_000) => until(async () => {
    if (gone) throw new Error(`the server exited early: ${output.slice(0, 600)}`);
    try {
      return (await fetch(`${url}/api/state`, { headers })).ok;
    } catch {
      return false;
    }
  }, 'the server to answer', ms, 100);

  const server = {
    url, port, token, home, base, appRoot, headers, shell, mock,
    get proc() { return proc; },
    projectIds: projects,
    projectPath: id => folders[id],
    get: (route, extra) => request('GET', route, undefined, extra),
    post: (route, body = {}, extra) => request('POST', route, body, extra),
    output: () => output,
    exited: () => gone,
    async state() { return (await request('GET', '/api/state')).body; },
    // Stops the server process and starts it again on the same port, token and state folder (state.json, phones.json and the projects stay),
    // as a person quitting and reopening Plenum would. Resolves once the new process answers. With { down: ms } the new process starts
    // after that long, so a test can watch a phone notice the loss first.
    async restart({ down = 0 } = {}) {
      if (!gone) proc.kill();
      await exited;
      if (down > 0) await sleep(down);
      launch();
      await ready();
      return server;
    },
    async stop() {
      if (!gone) proc.kill();
      await exited;
      await sleep(50);
      await fsp.rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
  };

  try {
    await ready();
  } catch (err) {
    await server.stop();
    throw err;
  }
  return server;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// An in-process Bridge (lib/remote/index.mjs createRemote) with everything replaceable and nothing real: memory storage for the
// registry, a fake desktop shell (plain node unless `shell` says otherwise), a fake "lan" carrier, a recording events channel, an
// injectable clock and source address. Import the library with `await import()` AFTER installX25519Counter() when counting DH.

export function createMemoryStorage() {
  const storage = {
    kind: 'memory',
    text: '',
    saves: 0,
    failNext: false,
    async load() { return { ok: true, storage: 'file', text: storage.text, damaged: false }; },
    async save(text) {
      if (storage.failNext) { storage.failNext = false; return { ok: false, message: 'The phone data could not be saved.' }; }
      storage.text = text;
      storage.saves += 1;
      return { ok: true, storage: 'file' };
    },
  };
  return storage;
}

// The carrier contract of lib/remote/index.mjs, answered for the loopback listener. Records its start and stop.
export function fakeLanCarrier() {
  const carrier = {
    started: 0,
    stopped: 0,
    ctx: null,
    async start(ctx) { carrier.started += 1; carrier.ctx = ctx; if (ctx.settings().enabled) await ctx.listener.setLan({ enabled: true, anyAddress: ctx.settings().anyAddress }); },
    async stop() { carrier.stopped += 1; },
    async status() { return { on: carrier.started > carrier.stopped, addresses: ['127.0.0.1'], origins: [] }; },
    async hints() {
      if (!carrier.ctx) return [];
      const port = carrier.ctx.listener.port();
      const key = carrier.ctx.registry.pathKey();
      return [{ kind: 'lan', on: true, label: 'Same network (test)', urls: [`ws://127.0.0.1:${port}/b/${key}`], web: `http://127.0.0.1:${port}/p/${key}/` }];
    },
  };
  return carrier;
}

// A tiny HTTP server standing in for Plenum: records every request (headers included) and answers by path.
export async function startFakeUpstream(handlers = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    const entry = { method: req.method, url: req.url, headers: { ...req.headers }, bytes: 0, aborted: false, chunks: 0 };
    requests.push(entry);
    res.on('close', () => { if (!res.writableFinished) entry.aborted = true; });
    req.on('data', c => { entry.bytes += c.length; entry.chunks += 1; if (entry.bytes < 100_000) chunks.push(c); });
    await new Promise(resolve => req.on('end', resolve));
    entry.body = Buffer.concat(chunks).toString('utf8');
    const path0 = new URL(req.url, 'http://x').pathname;
    const handler = handlers[`${req.method} ${path0}`] ?? handlers[path0] ?? handlers['*'];
    if (handler) return handler(req, res, entry);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, path: path0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    server,
    close: () => { server.closeAllConnections?.(); return new Promise(r => server.close(r)); },
  };
}

export const TEST_TOKEN = 'ab'.repeat(32);

/**
 * @param {object} [o]
 * @param {object} [o.clock]            default: the real monotonic clock
 * @param {object} [o.upstream]         { port } of a fake upstream (startFakeUpstream)
 * @param {(req) => string} [o.remoteAddress]
 * @param {object} [o.limits]           handshaker limit overrides
 * @param {boolean} [o.carrier]         load the fake lan carrier (default true)
 * @param {object} [o.phones]           state.phones seed
 * @param {boolean} [o.followEvents]    default false
 * @param {object} [o.shell]            a fake shell (available() true makes it a desktop session)
 */
export async function makeBridge(o = {}) {
  const { createRemote, monotonicClock } = await import('../../../lib/remote/index.mjs');
  const storage = o.storage ?? createMemoryStorage();
  const published = [];
  const shellPosts = [];
  const shellRequests = [];
  const shell = o.shell ?? {
    available: () => false,
    request: async (type, payload) => { shellRequests.push({ type, payload }); return { ok: true }; },
    post: msg => { shellPosts.push(msg); return true; },
    on: () => () => {},
  };
  const lan = o.carrier === false ? null : fakeLanCarrier();
  const phones = { enabled: true, port: await freePort(), lan: { enabled: lan !== null, anyAddress: false }, ...(o.phones ?? {}) };
  const settingsState = { phones };
  const remote = createRemote({
    shell,
    events: { publish: ev => published.push(ev) },
    clock: o.clock ?? monotonicClock(),
    getToken: () => o.token ?? TEST_TOKEN,
    port: o.upstream?.port ?? 1,
    settings: { get: () => settingsState.phones, save: async () => {} },
    storage,
    followEvents: o.followEvents === true,
    loadCarrier: async kind => {
      if (kind === 'lan' && lan) return lan;
      throw Object.assign(new Error('no such carrier'), { code: 'ERR_MODULE_NOT_FOUND' });
    },
    hostname: 'Test PC',
    host: '127.0.0.1',
    lanHosts: ['127.0.0.1'],
    remoteAddress: o.remoteAddress,
    shellRoot: o.shellRoot ?? null,
    handshaker: o.limits ? { limits: o.limits } : undefined,
    proxy: o.proxy,
    loadUiManifest: o.loadUiManifest,
    running: o.running,
    publicState: o.publicState,
    stopDeps: o.stopDeps,
    allowLocalPushEndpoints: true,
    createPusher: o.createPusher,
    ...(o.remoteOptions ?? {}),
  });
  await remote.start();
  const port = remote.listener.port();
  const pathKey = remote.registry.pathKey();
  const bridge = {
    remote, storage, published, shellPosts, shellRequests, phones, lan, port,
    get pathKey() { return remote.registry.pathKey(); },
    get url() { return `ws://127.0.0.1:${port}/b/${remote.registry.pathKey()}`; },
    get desktopPublic() { return remote.registry.identity().publicKey; },
    httpUrl: p => `http://127.0.0.1:${port}${p}`,
    async close() { await remote.stop(); },
    // Starts an offer, runs the phone through IKpsk2 and presses Allow. Resolves { paired, hello, session }.
    async pairPhone(phone, opts = {}) {
      const started = await remote.pairStart();
      if (!started.ok) throw new Error(`no offer: ${started.state}`);
      const { decodeLink } = await import('./phone-sim.mjs');
      const paired = await phone.pair(decodeLink(started.link), opts);
      await until(() => remote.pairing.view().state === 'confirm', 'the confirm state');
      const answer = await remote.pairConfirm(true);
      if (!answer.ok) throw new Error(`allow failed: ${answer.error}`);
      const hello = await paired.hello;
      return { paired, hello, session: paired.session, answer };
    },
  };
  void pathKey;
  return bridge;
}
