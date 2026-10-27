// Driver that runs the same Worker and Room class in-process, with a small
// stand-in for the Cloudflare runtime: WebSocketPair, the hibernatable socket
// API (accept with tags, attachments, auto-response), durable storage with an
// alarm, and static assets read from public/. It runs everywhere, with no
// workerd. It is the check that runs on machines where workerd cannot start;
// the miniflare suite is the check that exercises the real runtime.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { Inbox } from './inbox.mjs';
import { sleep } from './frames.mjs';

const NativeResponse = globalThis.Response;
const ORIGIN = 'https://relay.test';
const PUBLIC = fileURLToPath(new URL('../../public', import.meta.url));

// A Response that can carry status 101 with a webSocket, as a Worker returns it.
class FakeResponse extends NativeResponse {
  constructor(body = null, init = {}) {
    const { webSocket, status = 200, ...rest } = init;
    super(body, { ...rest, status: status === 101 ? 200 : status });
    if (status === 101) Object.defineProperty(this, 'status', { value: 101 });
    this.webSocket = webSocket;
  }
}

function toMessage(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  throw new TypeError('unsupported message type');
}

// The server side of an accepted socket.
class FakeServer {
  constructor(handle) {
    this.handle = handle;
    this.state = 'open';
    this.tags = [];
    this.attachment = undefined;
  }

  accept() {}

  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment() {
    return this.attachment === undefined ? undefined : structuredClone(this.attachment);
  }

  send(data) {
    if (this.state !== 'open') throw new Error('send on a closed socket');
    this.handle.inbox.push(toMessage(data));
  }

  close(code = 1000, reason = '') {
    if (this.state !== 'open') throw new Error('close on a closed socket');
    this.state = 'closed';
    this.handle.inbox.closeWith({ code, reason });
  }
}

class FakeStorage {
  constructor() {
    this.data = new Map();
    this.alarmTime = null;
  }

  async get(key) {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
  }

  async put(key, value) {
    this.data.set(key, structuredClone(value));
  }

  async list() {
    return [...this.data.entries()].map(([key, value]) => [key, structuredClone(value)]);
  }

  async deleteAll() {
    this.data.clear();
    this.alarmTime = null;
  }

  async setAlarm(time) {
    this.alarmTime = time;
  }

  async getAlarm() {
    return this.alarmTime;
  }

  async deleteAlarm() {
    this.alarmTime = null;
  }
}

// What survives an eviction: storage and the accepted sockets.
class RoomState {
  constructor() {
    this.storage = new FakeStorage();
    this.sockets = [];
    this.autoResponse = null;
    this.instance = null;
  }
}

class FakeCtx {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }

  acceptWebSocket(ws, tags = []) {
    ws.tags = tags;
    this.state.sockets.push(ws);
  }

  getWebSockets(tag) {
    return this.state.sockets.filter((ws) => ws.state === 'open' && (tag === undefined || ws.tags.includes(tag)));
  }

  setWebSocketAutoResponse(pair) {
    this.state.autoResponse = pair;
  }

  async blockConcurrencyWhile(callback) {
    return callback();
  }

  abort(reason) {
    throw new Error(`aborted: ${reason}`);
  }
}

export async function createFakeDriver() {
  register(new URL('./cf-loader.mjs', import.meta.url));
  globalThis.Response = FakeResponse;
  globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
    constructor(request, response) {
      this.request = request;
      this.response = response;
    }
  };
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      const handle = { inbox: new Inbox(), server: null };
      const server = new FakeServer(handle);
      handle.server = server;
      this[0] = handle;
      this[1] = server;
    }
  };

  const { default: worker, Room } = await import('./entry.mjs');
  const rooms = new Map();
  const pending = new Set();
  const failures = [];

  function stateOf(room) {
    if (!rooms.has(room)) rooms.set(room, new RoomState());
    return rooms.get(room);
  }

  function instanceOf(room) {
    const state = stateOf(room);
    if (!state.instance) state.instance = new Room(new FakeCtx(state), env);
    return state.instance;
  }

  function track(promise) {
    pending.add(promise);
    promise.catch((error) => failures.push(error)).finally(() => pending.delete(promise));
  }

  function serveAsset(request) {
    const path = new URL(request.url).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    const full = normalize(join(PUBLIC, file));
    if (!full.startsWith(PUBLIC) || !existsSync(full) || !statSync(full).isFile()) {
      return new FakeResponse('Not found', { status: 404 });
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
    return new FakeResponse(readFileSync(full), {
      status: 200,
      headers: { 'Content-Type': types[extname(full)] ?? 'application/octet-stream' },
    });
  }

  const env = {
    ROOM: {
      idFromName: (name) => name,
      get: (name) => ({ fetch: (request) => instanceOf(name).fetch(request) }),
    },
    ASSETS: { fetch: async (request) => serveAsset(request) },
  };

  class FakeClient {
    constructor(handle, room) {
      this.handle = handle;
      this.room = room;
    }

    send(data) {
      const auto = stateOf(this.room).autoResponse;
      if (typeof data === 'string' && auto && data === auto.request) {
        this.handle.inbox.push(auto.response);
        return;
      }
      track(instanceOf(this.room).webSocketMessage(this.handle.server, toMessage(data)));
    }

    close() {
      const server = this.handle.server;
      if (server.state !== 'open') return;
      server.state = 'closed';
      this.handle.inbox.closeWith({ code: 1000, reason: '' });
      track(instanceOf(this.room).webSocketClose(server, 1000, '', true));
    }

    next(ms) {
      return this.handle.inbox.next(ms);
    }

    quiet(ms) {
      return this.handle.inbox.quiet(ms);
    }

    closed(ms) {
      return this.handle.inbox.closed(ms);
    }

    get isOpen() {
      return this.handle.inbox.isOpen;
    }

    get closeInfo() {
      return this.handle.inbox.closeInfo;
    }
  }

  return {
    caps: { autoResponse: true },

    async start() {},

    async stop() {},

    async connect(room, headers = {}) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/room/${room}`, { headers: { Upgrade: 'websocket', ...headers } }),
        env,
      );
      if (response.status !== 101) throw new Error(`handshake failed with ${response.status} for room ${room}`);
      return new FakeClient(response.webSocket, room);
    },

    // Connects to the Room object itself with exactly these headers, as the Worker's stub.fetch would deliver them (x-relay-role, x-relay-host-hash
    // and whatever else the Worker forwards, such as cf-connecting-ip). For tests of what the Room does with a header; the Worker is bypassed.
    async connectRoom(room, headers = {}) {
      const response = await instanceOf(room).fetch(new Request(`${ORIGIN}/room/${room}`, { headers: { Upgrade: 'websocket', ...headers } }));
      if (response.status !== 101) throw new Error(`room handshake failed with ${response.status} for room ${room}`);
      return new FakeClient(response.webSocket, room);
    },

    async handshakeStatus(room, headers = {}) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/room/${room}`, { headers: { Upgrade: 'websocket', ...headers } }),
        env,
      );
      return response.status;
    },

    async httpGet(path, { method = 'GET', upgrade = false, headers = {} } = {}) {
      return worker.fetch(
        new Request(`${ORIGIN}${path}`, { method, headers: upgrade ? { Upgrade: 'websocket', ...headers } : headers }),
        env,
      );
    },

    async hook(room, path) {
      return instanceOf(room).fetch(new Request(`http://room.test${path}`));
    },

    // Simulates an eviction: the next request builds a new object over the
    // same storage and sockets, with its in-memory state reset.
    async restart(room) {
      stateOf(room).instance = null;
      await this.settle();
    },

    async settle() {
      for (let i = 0; i < 3; i += 1) {
        await Promise.allSettled([...pending]);
        await sleep(0);
      }
      if (failures.length > 0) throw failures.shift();
    },
  };
}
