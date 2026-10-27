// Driver that runs the relay under miniflare (workerd on this machine): the
// real Worker, the real Durable Object class (through the test entry), the
// public/ folder as the static assets, all bound to 127.0.0.1 on a random port.
// Nothing reaches Cloudflare. Driver interface, shared with fake-driver.mjs:
//   caps, start(), stop(), connect(room, headers), handshakeStatus(room, headers),
//   hook(room, path), httpGet(path, opts), restart(room), settle()
import { fileURLToPath } from 'node:url';
import { Miniflare, NoOpLog } from 'miniflare';
import { Inbox } from './inbox.mjs';
import { sleep } from './frames.mjs';

const ENTRY = fileURLToPath(new URL('./entry.mjs', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../public', import.meta.url));

class MiniClient {
  constructor(ws, inbox) {
    this.ws = ws;
    this.inbox = inbox;
  }

  send(data) {
    this.ws.send(data);
  }

  close() {
    this.ws.close();
  }

  next(ms) {
    return this.inbox.next(ms);
  }

  quiet(ms) {
    return this.inbox.quiet(ms);
  }

  closed(ms) {
    return this.inbox.closed(ms);
  }

  get isOpen() {
    return this.inbox.isOpen;
  }

  get closeInfo() {
    return this.inbox.closeInfo;
  }
}

export function createMiniflareDriver() {
  let mf;
  let origin;

  return {
    caps: { autoResponse: true },

    async start() {
      mf = new Miniflare({
        modules: true,
        scriptPath: ENTRY,
        // The pinned workerd (1.20260730) may not know a date later than its
        // own build; every API the relay uses predates this date.
        compatibilityDate: '2026-07-30',
        durableObjects: { ROOM: { className: 'Room', useSQLite: true } },
        assets: {
          directory: PUBLIC,
          binding: 'ASSETS',
          routerConfig: { invoke_user_worker_ahead_of_assets: true },
        },
        host: '127.0.0.1',
        port: 0,
        inspectorHost: '127.0.0.1',
        inspectorPort: 0,
        log: new NoOpLog(),
      });
      const url = await mf.ready;
      origin = `http://127.0.0.1:${url.port}`;
    },

    async stop() {
      await mf?.dispose();
    },

    async connect(room, headers = {}) {
      const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/room/${room}`, { headers });
      ws.binaryType = 'arraybuffer';
      const inbox = new Inbox();
      ws.addEventListener('message', (event) => inbox.push(event.data));
      ws.addEventListener('close', (event) => inbox.closeWith({ code: event.code, reason: event.reason }));
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error(`handshake failed for room ${room}`)), { once: true });
      });
      return new MiniClient(ws, inbox);
    },

    async handshakeStatus(room, headers = {}) {
      const response = await fetch(`${origin}/room/${room}`, {
        headers: { Upgrade: 'websocket', ...headers },
        redirect: 'manual',
      });
      await response.body?.cancel();
      return response.status;
    },

    async httpGet(path, { method = 'GET', upgrade = false, headers = {} } = {}) {
      return fetch(`${origin}${path}`, {
        method,
        headers: upgrade ? { Upgrade: 'websocket', ...headers } : headers,
        redirect: 'manual',
      });
    },

    async hook(room, path) {
      const ns = await mf.getDurableObjectNamespace('ROOM');
      const stub = ns.get(ns.idFromName(room));
      return stub.fetch(`http://room.test${path}`);
    },

    // Simulates an eviction: the object is reset and its sockets must survive.
    async restart(room) {
      try {
        await this.hook(room, '/__test/abort');
      } catch {
        // The abort ends the request that asked for it.
      }
      await sleep(200);
    },

    async settle() {
      await sleep(250);
    },
  };
}
