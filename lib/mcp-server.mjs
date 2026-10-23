// Plenum's MCP bridge for CLI agents (plenum-mcp, amendment 10). Claude Code, Codex, Gemini CLI, Cursor and Grok Build keep
// their own tools, but they have no browser pane, no computer run and no Plenum agents. This file gives them those three roles through
// a small local MCP server: the CLI starts `node lib/mcp-server.mjs <handoff file>` as an ordinary stdio MCP server, and every tool call
// it receives is sent back to the running Plenum over loopback, to lib/routes/mcp.mjs, which runs it through the same code a model with
// API tools goes through: lib/browser-tools.mjs (the browser_* tools, their site and impact cards), lib/computer/run.mjs (the run the
// person started, with its allow list, limits, takeover, log and Stop) and the agent runner (the delegate tool). So the cards, the allow
// lists, the limits and the floor are the same ones, and Stop on the bar, the overlay and the pane ends all of it.
//
// The file has two halves that share nothing but this header.
//
// 1. The stdio server (runs in the CLI's child process, imports only Node's own modules, so it starts fast and cannot reach the app):
//      serve({ input, output, call, version })   JSON-RPC 2.0 over newline-delimited JSON (the MCP stdio transport): initialize, ping,
//                                                tools/list, tools/call, notifications/cancelled. Answers tool failures as results with
//                                                isError, never as protocol errors, so a model reads them as a tool's own refusal.
//      loopbackClient({ url, secret, bridge })   the HTTP client: POST http://127.0.0.1:<port>/api/mcp/tools and /call, with the bridge's own
//                                                secret in the x-plenum-bridge header and the bridge id in the body. A url that is not loopback is
//                                                refused, so the secret can never be sent to another host.
//      readHandoff(file)                         reads { v, url, secret, bridge } and deletes the file at once (see "No credential moves").
//      main()                                    what `node lib/mcp-server.mjs <handoff file>` runs.
//
// 2. The app side (runs in the Plenum server):
//      openBridge(ctx, { cli, readOnly })        for one chat turn: registers the turn's tool context under a new random bridge id and a new random
//                                                bridge secret, writes the handoff file and the per-CLI config files into a private temp folder, and returns
//                                                { id, cli, descriptor, env, acpServers, close() }. It returns null (nothing is attached) for a
//                                                read-only seat, a delegated agent or coder, a seat that may only start agents, a tool test, a ctx
//                                                the server did not mark ctx.mcpBridge, an unknown CLI, or a path the CLI's command line cannot carry.
//      lookupBridge(id)                          the registered entry for a bridge id, or null (lib/routes/mcp.mjs).
//      acpServerFor(descriptor)                  the entry for ACP's session/new `mcpServers` (Cursor and Grok Build).
//    The call sites pass descriptor on to the argument builders in lib/cli-options/ (--mcp-config for Claude Code, -c mcp_servers.* for Codex,
//    a system settings file and the allowed server names for Gemini CLI), env to the child, acpServers to session/new, and call close() when
//    the turn ends. close() deletes the folder and makes the id useless, so a CLI that outlives its turn can call nothing.
//
// No credential moves. The server process is handed two things and nothing else: the loopback URL and a secret made for this bridge alone
// (32 random bytes), in a file of its own (mode 0600 in a fresh 0700 folder) whose path is the only argument. Plenum's per-launch token
// (lib/auth.mjs) is never written there or into anything a CLI can read. The bridge's two routes (lib/routes/mcp.mjs) accept the bridge
// secret and not the launch token, and the secret opens nothing else: it cannot read state, answer a card or reach a key. A model that
// reads the start file therefore gets only the tools it is already offered this turn. The server reads the file when it starts and
// deletes it at once, so the secret is never on a command line, in an environment, in a CLI's config file or in a place a model's file
// tools could read after the first moment, and close() makes the secret useless with the turn. No API key, no sign-in and no CLI
// credential is ever involved: each CLI keeps its own sign-in inside its own binary. A second start of the same server finds the file
// gone and says so (every call then answers that the bridge is closed); that is deliberate, and a new chat turn makes a new bridge.
//
// What the bridge offers (lib/routes/mcp.mjs decides, per call): browser_* while the model may use the Browser pane this turn, the
// computer_* actions with confirm_with_user and hand_over while a computer run the person started is live, and delegate while the project's
// agent settings let this chat start an agent. File and command tools are never offered: the CLIs have their own, behind their own gates.
import { randomBytes } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'plenum';
export const SERVER_TITLE = 'Plenum';
export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const HANDOFF_VERSION = 2;
// The header that carries the bridge's own secret (openBridge makes one per turn). The launch token is not accepted on the bridge routes.
export const SECRET_HEADER = 'x-plenum-bridge';
export const TOOLS_ROUTE = '/api/mcp/tools';
export const CALL_ROUTE = '/api/mcp/call';
export const BRIDGE_ID = /^[a-f0-9]{32}$/;
// The CLIs a bridge can be opened for. 'grok' (Grok Build) takes the same ACP entry as Cursor (lib/grok.mjs).
export const CLIS = Object.freeze(['claude', 'codex', 'gemini', 'cursor', 'grok']);

const TOKEN_RE = /^[a-f0-9]{64}$/;
const SECRET_RE = /^[a-f0-9]{64}$/;
const MAX_LINE = 16 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_HANDOFF_BYTES = 4096;
const PROGRESS_MS = 10_000;
const INSTRUCTIONS_MS = 2500;
const VERSION = '1';

export const MESSAGES = Object.freeze({
  noHandoff: 'The Plenum bridge was not given its start file, or another start already used it. Send your message again in Plenum to get a new bridge.',
  gone: 'This Plenum chat turn has ended, so its tools are gone. Ask the user to send a new message.',
  refused: 'Plenum refused the bridge (it may have restarted). Ask the user to send a new message.',
  unreachable: 'Plenum could not be reached on this computer. Ask the user to check that Plenum is still open.',
  unknownTool: 'That Plenum tool is not available in this chat.',
});

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}\n…[cut at ${n} characters]` : text);

// ---------- 1. the stdio server ----------

// True for http://127.0.0.1:<port> or http://localhost:<port>: no user name, no path, no query. The token is sent only there.
export function isLoopbackUrl(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return false;
  }
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && /^\d{1,5}$/.test(u.port)
    && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
}

// Reads the handoff file and, unless keep is true, deletes it straight away (the secret is then only in this process). Throws an Error
// with a plain message for a file that is missing, too big, not JSON, not the expected shape or pointing anywhere but loopback.
export async function readHandoff(file, { keep = false } = {}) {
  if (typeof file !== 'string' || !file) throw new Error(MESSAGES.noHandoff);
  let text;
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_HANDOFF_BYTES) throw new Error('not a start file');
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(MESSAGES.noHandoff);
  } finally {
    if (!keep) await fs.rm(file, { force: true }).catch(() => {});
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The start file is not valid.');
  }
  if (!isObject(data) || data.v !== HANDOFF_VERSION || !SECRET_RE.test(String(data.secret ?? '')) || !BRIDGE_ID.test(String(data.bridge ?? ''))) {
    throw new Error('The start file is not valid.');
  }
  if (!isLoopbackUrl(data.url)) throw new Error('The start file names an address that is not on this computer, so the bridge did not start.');
  return { url: data.url, secret: data.secret, bridge: data.bridge };
}

// The request function the client uses: a POST over node:http with no keep-alive (one request, one connection), shaped like the part of
// fetch the client reads ({ status, json() }). It is not fetch on purpose: fetch's connection pool keeps sockets and async handles that
// are still open when the CLI closes the pipe, and ending the process then trips a libuv assertion on Windows that leaves it hanging. A
// redirect is never followed (it is just a non-200 answer), and an answer over 64 MB is refused.
const MAX_ANSWER = 64 * 1024 * 1024;
function httpPost(target, { headers = {}, body = '', signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(String(target));
    const data = Buffer.from(String(body), 'utf8');
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'content-length': data.length, connection: 'close' },
      agent: false,
      signal,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ANSWER) {
          res.destroy(new Error('too big'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// The HTTP side. Returns call(route, payload, { signal }) -> { status, json } (json is null for an answer that was not JSON). A network
// failure rejects with an Error whose message is plain and never holds the token; a call that the signal aborted rejects with cancelled: true.
// fetchImpl replaces httpPost in the tests.
export function loopbackClient({ url, secret, bridge, fetchImpl = httpPost }) {
  if (!isLoopbackUrl(url)) throw new Error('The bridge only talks to this computer.');
  const base = new URL(url);
  return async (route, payload = {}, { signal } = {}) => {
    let res;
    try {
      res = await fetchImpl(new URL(route, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({ ...payload, bridge }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw Object.assign(new Error('cancelled'), { cancelled: true });
      throw new Error(MESSAGES.unreachable);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}

// What a tools/call result looks like on the wire, from the route's answer { ok, text, images }.
function toResult(status, json) {
  if (status === 401 || status === 403) return { content: [{ type: 'text', text: MESSAGES.refused }], isError: true };
  if (status === 404) return { content: [{ type: 'text', text: typeof json?.error === 'string' && json.error ? json.error : MESSAGES.gone }], isError: true };
  if (status !== 200 || !isObject(json)) {
    const why = typeof json?.error === 'string' && json.error ? json.error : `Plenum answered ${status}.`;
    return { content: [{ type: 'text', text: clip(why, 2000) }], isError: true };
  }
  const ok = json.ok === true;
  const text = typeof json.text === 'string' && json.text ? clip(json.text, MAX_TEXT) : (ok ? 'Done.' : 'That did not work.');
  const content = [{ type: 'text', text }];
  for (const image of Array.isArray(json.images) ? json.images : []) {
    if (isObject(image) && typeof image.data === 'string' && image.data) content.push({ type: 'image', data: image.data, mimeType: typeof image.mimeType === 'string' && image.mimeType ? image.mimeType : 'image/png' });
  }
  return { content, isError: !ok };
}

// The tools of a tools/list answer in the MCP shape.
function toTools(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!isObject(t) || typeof t.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) continue;
    out.push({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: isObject(t.input_schema) ? t.input_schema : { type: 'object', properties: {} },
    });
  }
  return out;
}

// Runs the server on a pair of streams until `input` ends. call is the loopbackClient function (or a fake). Resolves when the input has
// ended and every call in flight has finished. A request id is any JSON-RPC id; a message without one is a notification and gets no answer.
export function serve({ input, output, call, version = VERSION, log = () => {}, progressMs = PROGRESS_MS }) {
  const inflight = new Map(); // JSON-RPC id (as text) -> AbortController of a tools/call
  const running = new Set();
  let lastEtag = null;
  let ended = false;

  const write = msg => {
    if (ended && !running.size) return;
    try {
      output.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // The reader has gone; the end of the input follows.
    }
  };
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function tools() {
    try {
      const { status, json } = await call(TOOLS_ROUTE, {});
      if (status !== 200 || !isObject(json)) return { tools: [], instructions: '', etag: null };
      return { tools: toTools(json.tools), instructions: typeof json.instructions === 'string' ? json.instructions : '', etag: typeof json.etag === 'string' ? json.etag : null };
    } catch (err) {
      log(`tools/list failed: ${err.message}`);
      return { tools: [], instructions: '', etag: null };
    }
  }

  async function initialize(id, params) {
    const asked = isObject(params) ? params.protocolVersion : undefined;
    const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    // The instructions say what the tools are for. They are asked for with a short wait, so a slow Plenum never delays the start.
    let instructions = '';
    let timer;
    const first = await Promise.race([tools(), new Promise(resolve => { timer = setTimeout(resolve, INSTRUCTIONS_MS, null); })]);
    clearTimeout(timer);
    if (first) {
      instructions = first.instructions;
      lastEtag = first.etag;
    }
    const result = {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version },
    };
    if (instructions) result.instructions = instructions;
    reply(id, result);
  }

  async function listTools(id) {
    const got = await tools();
    lastEtag = got.etag;
    reply(id, { tools: got.tools });
  }

  async function callTool(id, params, meta) {
    if (!isObject(params) || typeof params.name !== 'string' || !params.name) return fail(id, -32602, 'tools/call needs a tool name.');
    const input = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(input)) return fail(id, -32602, 'The arguments of a tool call must be an object.');
    const key = String(id);
    const controller = new AbortController();
    inflight.set(key, controller);
    // Some clients restart a tool's timeout whenever progress arrives, so a long step (an agent, a card nobody has answered yet) keeps
    // the call alive: one progress notification every ten seconds, only when the client sent a progress token.
    const token = isObject(params._meta) ? params._meta.progressToken : undefined;
    let ticks = 0;
    const ticker = token === undefined ? null : setInterval(() => {
      ticks += 1;
      write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ticks, message: 'Plenum is still working on this step.' } });
    }, progressMs);
    ticker?.unref?.();
    // Claude Code names its own call here, which lets Plenum nest an agent's steps under the right row.
    const callId = typeof meta === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(meta) ? meta : `mcp-${key.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40)}`;
    try {
      const { status, json } = await call(CALL_ROUTE, { name: params.name, input, id: callId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      reply(id, toResult(status, json));
      const etag = status === 200 && isObject(json) && typeof json.etag === 'string' ? json.etag : null;
      if (etag && lastEtag !== null && etag !== lastEtag) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      if (etag) lastEtag = etag;
    } catch (err) {
      if (err?.cancelled || controller.signal.aborted) return;
      reply(id, { content: [{ type: 'text', text: err?.message || MESSAGES.unreachable }], isError: true });
    } finally {
      clearInterval(ticker);
      inflight.delete(key);
    }
  }

  async function handle(msg) {
    if (!isObject(msg)) return fail(null, -32600, 'Invalid request.');
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== 'string') return; // an answer to a request of ours (there are none), or noise
    if (!hasId) {
      if (msg.method === 'notifications/cancelled') {
        const ctl = inflight.get(String(msg.params?.requestId));
        ctl?.abort();
      }
      return;
    }
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        return initialize(id, params);
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return listTools(id);
      case 'tools/call':
        return callTool(id, params, isObject(params?._meta) ? params._meta['claudecode/toolUseId'] : undefined);
      default:
        return fail(id, -32601, `Method not found: ${String(method).slice(0, 60)}`);
    }
  }

  let buffer = '';
  let dropping = false;
  const onLine = line => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return fail(null, -32700, 'Parse error.');
    }
    const items = Array.isArray(msg) ? msg : [msg];
    for (const item of items) {
      const p = handle(item).catch(err => {
        log(`handler failed: ${err?.message}`);
        if (isObject(item) && item.id !== undefined && item.id !== null) fail(item.id, -32603, 'Internal error.');
      });
      running.add(p);
      p.finally(() => running.delete(p));
    }
  };
  input.setEncoding?.('utf8');
  const done = new Promise(resolve => {
    input.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (dropping) dropping = false;
        else onLine(line);
      }
      if (buffer.length > MAX_LINE) {
        buffer = '';
        dropping = true;
      }
    });
    const finish = async () => {
      ended = true;
      if (buffer.trim() && !dropping) onLine(buffer);
      buffer = '';
      for (const ctl of inflight.values()) ctl.abort();
      await Promise.allSettled([...running]);
      resolve();
    };
    input.on('end', finish);
    input.on('close', finish);
    input.on('error', finish);
  });
  return { done };
}

// What `node lib/mcp-server.mjs <handoff file>` runs. Never throws: a bridge that cannot start still answers the CLI's handshake, with no
// tools, and every call says why, so the CLI does not report a broken server on top of a working chat.
export async function main({ argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, exit = code => process.exit(code), fetchImpl, keep = false } = {}) {
  const note = text => {
    try {
      stderr.write(`plenum-mcp: ${text}\n`);
    } catch {
      // No stderr to write to.
    }
  };
  let call;
  try {
    const hand = await readHandoff(argv[0], { keep });
    call = loopbackClient({ ...hand, fetchImpl });
  } catch (err) {
    note(err.message);
    call = async () => ({ status: 503, json: { error: err.message } });
  }
  const { done } = serve({ input: stdin, output: stdout, call, log: note });
  await done;
  // Everything written is out before the process ends (a pipe on Windows takes writes asynchronously); a stream that is gone does not hold it.
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 500);
    try {
      stdout.write('', () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  exit(0);
}

// ---------- 2. the app side: the registry and openBridge ----------

const SELF = fileURLToPath(import.meta.url);
const bridges = new Map(); // bridge id -> entry
const EXPIRES_MS = 6 * 60 * 60 * 1000;

// The registered entry for a bridge id, or null. entry: { id, secret, cli, ctx, emitSteps, openedAt, calls, dir, close() }.
export function lookupBridge(id) {
  return typeof id === 'string' && BRIDGE_ID.test(id) ? (bridges.get(id) ?? null) : null;
}

export const bridgeCount = () => bridges.size;

// Closes every open bridge (the tests; and a server that is going down).
export async function closeAllBridges() {
  await Promise.all([...bridges.values()].map(entry => entry.close()));
}

// Characters a bridge path may not hold: the ones cmd.exe rewrites in a .cmd shim's command line (lib/proc.mjs), a single quote (it
// would end a TOML literal string, which is how Codex gets its servers), control characters and a comma (some CLIs split lists on it).
const UNSAFE_PATH = /["%!^&|<>'\x00-\x1f\x7f,]/;
const plainPath = p => typeof p === 'string' && path.isAbsolute(p) && !UNSAFE_PATH.test(p) && !p.endsWith('\\');

// The entry for ACP's session/new `mcpServers` list: { name, command, args, env: [{ name, value }] }.
export function acpServerFor(descriptor) {
  if (!isObject(descriptor)) return null;
  return {
    name: descriptor.name,
    command: descriptor.command,
    args: [...descriptor.args],
    env: Object.entries(descriptor.env ?? {}).map(([name, value]) => ({ name, value })),
  };
}

// A folder a crashed Plenum left behind (a bridge folder is removed by close(), and by the expiry above after six hours). Once per process, the
// first time a bridge is opened in a temp folder, folders of this kind that are more than twelve hours old are removed; only a folder that
// has the exact name mkdtemp makes and holds nothing but the files a bridge writes is touched.
const STALE_MS = 12 * 60 * 60 * 1000;
const BRIDGE_FILES = new Set(['bridge.json', 'claude.mcp.json', 'gemini.settings.json']);
const swept = new Set();
export async function sweepStale(tmp, now = Date.now()) {
  let names;
  try {
    names = await fs.readdir(tmp);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^plenum-mcp-[A-Za-z0-9]{6}$/.test(name)) continue;
    const dir = path.join(tmp, name);
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory() || now - st.mtimeMs < STALE_MS) continue;
      const inside = await fs.readdir(dir);
      if (!inside.every(f => BRIDGE_FILES.has(f))) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Not ours to judge, or already gone.
    }
  }
  return removed;
}

// Opens a bridge for one chat turn and returns its handle, or null when nothing is to be attached (see the header). ctx is the turn's tool
// context (server.mjs runTurn); the server marks the turns that may have a bridge with ctx.mcpBridge === true, the way it marks
// ctx.browser. cli is one of CLIS; readOnly is true for a read-only seat. Options only for the tests: port, tmp, node, script, token.
//   descriptor  { name, cli, command, args, env, startupSec, toolSec, claudeConfig?, geminiSettings? }: what lib/cli-options/<cli>.mjs
//               turns into flags. command is the program that runs the server (this process's own Node, or Electron as Node).
//   env         variables the CLI's child process needs ({ GEMINI_CLI_SYSTEM_SETTINGS_PATH } for Gemini CLI), else {}.
//   acpServers  [entry] for ACP's session/new (Cursor, Grok Build), else [].
//   close()     removes the folder and unregisters the id. Safe to call twice.
export async function openBridge(ctx, { cli, readOnly = false, port, tmp = os.tmpdir(), node = process.execPath, script = SELF, token: given, emitSteps } = {}) {
  if (!isObject(ctx) || ctx.mcpBridge !== true || readOnly === true) return null;
  if (ctx.agent || ctx.scope || ctx.seatOnly) return null;
  if (!CLIS.includes(cli)) return null;
  // Plenum must be running with a launch token; the bridge never carries that token (see "No credential moves").
  const launch = given ?? (await import('./auth.mjs')).token();
  if (!TOKEN_RE.test(String(launch ?? ''))) return null;
  const portNumber = Number(port ?? process.env.PORT) || 4317;
  const id = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const handoffUrl = `http://127.0.0.1:${portNumber}`;

  if (!swept.has(tmp)) {
    swept.add(tmp);
    sweepStale(tmp).catch(() => {});
  }
  let dir = null;
  try {
    dir = await fs.mkdtemp(path.join(tmp, 'plenum-mcp-'));
    const parts = [node, script, dir];
    if (!parts.every(plainPath)) {
      const bad = [node, script, dir].find(p => !plainPath(p));
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      dir = null;
      try {
        ctx.emit?.({ type: 'notice', text: `The Plenum bridge was not attached to ${cli}: a path it needs (${path.basename(String(bad))}) has a character a command line cannot carry safely.` });
      } catch {
        // The stream is gone.
      }
      return null;
    }
    const handoff = path.join(dir, 'bridge.json');
    await fs.writeFile(handoff, JSON.stringify({ v: HANDOFF_VERSION, url: handoffUrl, secret, bridge: id }), { mode: 0o600 });
    const env = process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    const descriptor = { name: SERVER_NAME, cli, command: node, args: [script, handoff], env, startupSec: 30, toolSec: 3600 };
    const childEnv = {};
    if (cli === 'claude') {
      descriptor.claudeConfig = path.join(dir, 'claude.mcp.json');
      await fs.writeFile(descriptor.claudeConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', command: node, args: descriptor.args, env } } }));
    } else if (cli === 'gemini') {
      descriptor.geminiSettings = path.join(dir, 'gemini.settings.json');
      // trust: the server's calls are checked by Plenum, so the CLI's own confirmation (which a headless run cannot answer) is skipped.
      await fs.writeFile(descriptor.geminiSettings, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: node, args: descriptor.args, env, trust: true, timeout: descriptor.toolSec * 1000 } } }));
      childEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = descriptor.geminiSettings;
    }
    const acpServers = cli === 'cursor' || cli === 'grok' ? [acpServerFor(descriptor)] : [];
    let closed = false;
    let expiry = null;
    const entry = {
      id,
      // The bridge's own secret: lib/routes/mcp.mjs checks the x-plenum-bridge header against it. Kept in memory only.
      secret,
      cli,
      ctx,
      // Codex's adapter shows no steps of its own, so the bridge draws a row for each call; the others draw theirs from the CLI's own events.
      emitSteps: typeof emitSteps === 'boolean' ? emitSteps : cli === 'codex',
      openedAt: Date.now(),
      calls: 0,
      dir,
      async close() {
        if (closed) return;
        closed = true;
        clearTimeout(expiry);
        bridges.delete(id);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
    expiry = setTimeout(() => entry.close(), EXPIRES_MS);
    expiry.unref?.();
    bridges.set(id, entry);
    return { id, cli, descriptor, env: childEnv, acpServers, close: () => entry.close() };
  } catch {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

// Run as a program (`node lib/mcp-server.mjs <handoff file>`), this file is the stdio server. It sits last so that everything above is
// defined before the server starts; imported by the app, it does nothing.
const isMain = () => {
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const run = realpathSync(process.argv[1] ?? '');
    return process.platform === 'win32' ? here.toLowerCase() === run.toLowerCase() : here === run;
  } catch {
    return false;
  }
};
if (isMain()) await main();
