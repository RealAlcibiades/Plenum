// The carriers of the Bridge (MOBILE.json features mob-04): same network (LAN), Tailscale serve and the relay client. Owned by mob-04.
//
// Run through the sealed runner: node build/mobile/run.mjs --id mob-04-carriers carriers.test.mjs
// Everything stays on this computer. The LAN suites bind loopback only: makeBridge keeps lanHosts at 127.0.0.1, and a sealed run refuses
// any other bind (lib/remote/listener.mjs); the one real wildcard bind runs only in CI with PLENUM_TEST_REAL_LAN=1. The Tailscale suites
// put helpers/fake-tailscale first on a scratch PATH, so the real tailscale is never run and every call is recorded. The relay suites run
// the real relay Worker and Room (relay/src) in the in-process runtime of relay/test/support/fake-driver.mjs, served on a loopback socket
// by startRoomAdapter below: miniflare cannot start on the Windows build machine (workerd exits with STATUS_DLL_NOT_FOUND, 0xC0000135),
// so relay/test runs the miniflare suite in CI (RELAY_REQUIRE_MINIFLARE=1 on Ubuntu) and this suite covers the same Worker code here.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocketClient, { WebSocketServer } from 'ws';
import { createMemoryStorage, freePort, makeBridge, sleep, until } from './helpers/sealed-server.mjs';
import { b64uDecode, createPhone, decodeLink, openChannel } from './helpers/phone-sim.mjs';
import * as noise from '../../lib/remote/noise.mjs';
import { createRegistry } from '../../lib/remote/registry.mjs';
import { TYPE as FRAME_TYPE, encodeFrame } from '../../lib/remote/frames.mjs';
import { decodeStopAck, encodeStopOnly } from '../../lib/remote/stop-only.mjs';
import { candidatesOf, createLanCarrier, FIREWALL_TEXT, hostOf } from '../../lib/remote/carriers/lan.mjs';
import { createTailscaleCarrier, INSTALL_TEXT, locateTailscale } from '../../lib/remote/carriers/tailscale.mjs';
import { backoffFor, createRelayCarrier, FIRST_RETRY_MS, MAX_RETRY_MS, parseRelayUrl, probeUpgrade, sha256Hex } from '../../lib/remote/carriers/relay.mjs';

const FAKE_DIR = fileURLToPath(new URL('./helpers/fake-tailscale/', import.meta.url));
const SHIM = process.platform === 'win32' ? 'tailscale.cmd' : 'tailscale';
const sealed = process.env.MOBILE_SEALED === '1';
const realLan = process.env.PLENUM_TEST_REAL_LAN === '1';

const fakeInterfaces = () => ({
  Ethernet: [
    { address: '192.168.1.5', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: 'fd12:3456:789a::5', family: 'IPv6', internal: false },
  ],
  'Wi-Fi': [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
  Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  Tailscale: [{ address: '100.100.2.3', family: 'IPv4', internal: false }],
  Public: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
});

const lanModuleOf = carrier => ({ loadCarrier: async kind => (kind === 'lan' ? { default: carrier } : null) });

// Opens a WebSocket and reports how it ended: 'open', 'http <status>' or 'error'. An open socket is closed at once.
function probeSocket(url, headers = {}) {
  return new Promise(resolve => {
    const ws = new WebSocketClient(url, { headers });
    let done = false;
    const finish = state => {
      if (done) return;
      done = true;
      resolve(state);
    };
    ws.on('open', () => {
      finish('open');
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      finish(`http ${res.statusCode}`);
    });
    ws.on('error', () => finish('error'));
    setTimeout(() => finish('timeout'), 5000).unref();
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Same network: addresses and the QR candidates

describe('same network: addresses', () => {
  test('only private IPv4 and unique-local IPv6, best first, without duplicates', () => {
    const list = candidatesOf({
      Ethernet: [
        { address: '192.168.1.5', family: 'IPv4', internal: false },
        { address: '192.168.1.5', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: 'fd12:3456:789a::5', family: 'IPv6', internal: false },
      ],
      'Wi-Fi': [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
      'vEthernet (WSL)': [{ address: '172.20.1.2', family: 'IPv4', internal: false }],
      Tailscale: [{ address: '100.100.2.3', family: 'IPv4', internal: false }],
      Public: [{ address: '8.8.8.8', family: 4, internal: false }],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      Virtual: [{ address: '169.254.9.9', family: 'IPv4', internal: false }],
      Global6: [{ address: '2001:db8::5', family: 'IPv6', internal: false }],
    });
    assert.deepEqual(list.map(c => c.address), ['192.168.1.5', '10.0.0.7', '172.20.1.2', 'fd12:3456:789a::5']);
    assert.equal(hostOf('fd12:3456:789a::5'), '[fd12:3456:789a::5]');
    assert.equal(hostOf('192.168.1.5'), '192.168.1.5');
  });

  test('the carrier reports nothing when LAN mode is off, and the firewall sentence when it is on', async () => {
    const carrier = createLanCarrier({ interfaces: fakeInterfaces });
    const off = carrier.status();
    assert.equal(off.on, false);
    assert.equal(off.firewall, '');
    assert.match(FIREWALL_TEXT, /firewall/);
    assert.deepEqual(await carrier.hints(), [{ kind: 'lan', on: false, label: 'Same network' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Same network through the Bridge

describe('same network through the Bridge', () => {
  const lanCarrier = () => createLanCarrier({ interfaces: fakeInterfaces });

  test('LAN off: the listener is bound to 127.0.0.1 only, and a connect to this computer network address fails', async () => {
    const bridge = await makeBridge({ carrier: false, phones: { lan: { enabled: false, anyAddress: false } }, remoteOptions: lanModuleOf(lanCarrier()) });
    try {
      assert.deepEqual(bridge.remote.listener.status().lan.hosts, ['127.0.0.1']);
      const real = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
      if (!real) return; // this machine has no private address to try; the check needs one
      await assert.rejects(() => new Promise((resolve, reject) => {
        const socket = net.connect({ host: real.address, port: bridge.port });
        socket.setTimeout(3000, () => { socket.destroy(); reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); });
        socket.once('connect', () => { socket.destroy(); resolve('connected'); });
        socket.once('error', reject);
      }));
    } finally {
      await bridge.close();
    }
  });

  test('LAN on: the candidate ws:// URLs and the LAN page are in the pairing QR, and the status lists the addresses', async () => {
    const bridge = await makeBridge({ carrier: false, phones: { lan: { enabled: true, anyAddress: false } }, remoteOptions: lanModuleOf(lanCarrier()) });
    try {
      const started = await bridge.remote.pairStart();
      assert.equal(started.ok, true);
      const payload = decodeLink(started.link);
      const lan = payload.carriers.find(c => c.kind === 'lan');
      assert.deepEqual(lan.urls, [`ws://192.168.1.5:${bridge.port}/b/${bridge.pathKey}`, `ws://10.0.0.7:${bridge.port}/b/${bridge.pathKey}`, `ws://[fd12:3456:789a::5]:${bridge.port}/b/${bridge.pathKey}`]);
      assert.ok(!lan.urls.some(u => u.includes('fe80') || u.includes('100.100')), 'no link-local or VPN candidate');
      const view = (await bridge.remote.state()).carriers.lan;
      assert.equal(view.on, true);
      assert.deepEqual(view.addresses, ['192.168.1.5', '10.0.0.7', 'fd12:3456:789a::5']);
      assert.equal(view.firewall, FIREWALL_TEXT);
      if (sealed) assert.deepEqual(bridge.remote.listener.status().lan.hosts, ['127.0.0.1'], 'a sealed run keeps the listener on loopback');
    } finally {
      await bridge.close();
    }
  });

  test('LAN on: a connection from a public source is refused unless Any address is on', async () => {
    let source = '8.8.8.8';
    const bridge = await makeBridge({ carrier: false, phones: { lan: { enabled: false, anyAddress: false } }, remoteOptions: lanModuleOf(lanCarrier()), remoteAddress: () => source });
    try {
      await bridge.remote.setLan({ enabled: true, anyAddress: false });
      const url = `ws://127.0.0.1:${bridge.port}/b/${bridge.pathKey}`;
      assert.notEqual(await probeSocket(url), 'open', 'a public source is refused');
      source = '192.168.1.5';
      assert.equal(await probeSocket(url), 'open', 'a same-network source is served');
      source = '8.8.8.8';
      await bridge.remote.setLan({ enabled: true, anyAddress: true });
      assert.equal(await probeSocket(url), 'open', 'Any address lets a public source in');
    } finally {
      await bridge.close();
    }
  });

  test('a loopback connection is served with LAN mode off (the Tailscale and local paths)', async () => {
    const bridge = await makeBridge({ carrier: false, phones: { lan: { enabled: false, anyAddress: false } }, remoteOptions: lanModuleOf(lanCarrier()) });
    try {
      assert.equal(await probeSocket(`ws://127.0.0.1:${bridge.port}/b/${bridge.pathKey}`), 'open');
      assert.notEqual(await probeSocket(`ws://127.0.0.1:${bridge.port}/b/${'0'.repeat(32)}`), 'open', 'a wrong path key is not served');
    } finally {
      await bridge.close();
    }
  });

  // The real wildcard bind. CI only: it makes the Windows firewall ask on a developer machine, so a local run never does it.
  test('CI only: with LAN on the listener binds the wildcard addresses and a LAN address connects', { skip: realLan ? false : 'set PLENUM_TEST_REAL_LAN=1 (CI only, the real wildcard bind)' }, async () => {
    const real = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4' && /^(10\.|192\.168\.)/.test(i.address));
    const bridge = await makeBridge({ carrier: false, phones: { lan: { enabled: false, anyAddress: false } }, remoteOptions: { ...lanModuleOf(lanCarrier()), lanHosts: undefined } });
    try {
      await bridge.remote.setLan({ enabled: true, anyAddress: false });
      assert.ok(bridge.remote.listener.status().lan.hosts.includes('0.0.0.0'));
      if (real) assert.equal(await probeSocket(`ws://${real.address}:${bridge.port}/b/${bridge.pathKey}`), 'open');
    } finally {
      await bridge.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Tailscale: the fake CLI on PATH

describe('Tailscale serve, with the fake CLI on PATH', () => {
  let dir;
  let savedEnv;
  let logPath;
  let counter = 0;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ts-fake-'));
    savedEnv = { TS_FAKE_LOG: process.env.TS_FAKE_LOG, TS_FAKE_NODE: process.env.TS_FAKE_NODE, TS_FAKE_STATUS: process.env.TS_FAKE_STATUS, TS_FAKE_FAIL: process.env.TS_FAKE_FAIL };
    if (process.platform !== 'win32') chmodSync(path.join(FAKE_DIR, 'tailscale'), 0o755);
    process.env.TS_FAKE_NODE = process.execPath;
  });
  after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // A fresh record of calls for each test; the fake CLI appends its argv to it.
  const fresh = (status, fail) => {
    counter += 1;
    logPath = path.join(dir, `argv-${counter}.log`);
    process.env.TS_FAKE_LOG = logPath;
    if (status) process.env.TS_FAKE_STATUS = status;
    else delete process.env.TS_FAKE_STATUS;
    if (fail) process.env.TS_FAKE_FAIL = fail;
    else delete process.env.TS_FAKE_FAIL;
  };
  const calls = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).argv) : []);
  const locateFake = () => ({ env: { PATH: FAKE_DIR }, names: [SHIM], fixedPaths: [] });
  const fakeCtx = ({ enabled, port = 4321, name = '' }) => {
    const state = { enabled, port, name };
    return {
      state,
      settings: () => ({ enabled: state.enabled, name: state.name }),
      listener: { port: () => state.port },
      registry: { pathKey: () => 'b'.repeat(32) },
      remember: patch => Object.assign(state, patch),
    };
  };

  test('the fake CLI is found on the scratch PATH and the real one is never looked for', () => {
    assert.equal(locateTailscale({ env: { PATH: FAKE_DIR }, names: [SHIM], fixedPaths: [] }), path.join(FAKE_DIR, SHIM));
    assert.equal(locateTailscale({ env: { PATH: os.tmpdir() }, names: [SHIM], fixedPaths: [] }), null);
  });

  test('turning the switch on runs status, then exactly one serve; a second round changes nothing; the switch off resets once', async () => {
    fresh();
    const ts = createTailscaleCarrier({ locate: locateFake() });
    const bridge = await makeBridge({ carrier: false, phones: { lan: { enabled: false, anyAddress: false }, tailscale: { enabled: false, name: '' } }, remoteOptions: { loadCarrier: async kind => (kind === 'tailscale' ? { default: ts } : null) } });
    try {
      assert.deepEqual(calls(), [], 'nothing runs before the switch is on');
      bridge.phones.tailscale.enabled = true;
      await bridge.remote.applyCarriers();
      const port = bridge.remote.listener.port();
      assert.deepEqual(calls().filter(a => a[0] === 'serve'), [['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]]);
      const view = (await bridge.remote.state()).carriers.tailscale;
      assert.equal(view.on, true);
      assert.equal(view.installed, true);
      assert.equal(view.name, 'will-pc.tail1234.ts.net');
      await bridge.remote.applyCarriers();
      assert.equal(calls().filter(a => a[0] === 'serve').length, 1, 'serve runs once');
      const started = await bridge.remote.pairStart();
      const hint = decodeLink(started.link).carriers.find(c => c.kind === 'tailscale');
      assert.deepEqual(hint, { kind: 'tailscale', url: `wss://will-pc.tail1234.ts.net/b/${bridge.pathKey}` });
      bridge.phones.tailscale.enabled = false;
      await bridge.remote.applyCarriers();
      assert.deepEqual(calls().filter(a => a[0] === 'serve').slice(1), [['serve', 'reset']], 'the switch off runs serve reset once');
      assert.equal(bridge.phones.tailscale.name, '', 'the remembered name is cleared');
      assert.equal((await bridge.remote.state()).carriers.tailscale.on, false);
    } finally {
      await bridge.close();
    }
  });

  test('without the CLI the panel says Install Tailscale and nothing runs, with the switch on or off', async () => {
    fresh();
    const empty = mkdtempSync(path.join(dir, 'empty-'));
    const ts = createTailscaleCarrier({ locate: { env: { PATH: empty }, names: [SHIM], fixedPaths: [] } });
    const bridge = await makeBridge({ carrier: false, phones: { lan: { enabled: false, anyAddress: false }, tailscale: { enabled: true, name: '' } }, remoteOptions: { loadCarrier: async kind => (kind === 'tailscale' ? { default: ts } : null) } });
    try {
      const view = (await bridge.remote.state()).carriers.tailscale;
      assert.equal(view.installed, false);
      assert.equal(view.message, INSTALL_TEXT);
      assert.equal(INSTALL_TEXT, 'Install Tailscale');
      bridge.phones.tailscale.enabled = false;
      await bridge.remote.applyCarriers();
      assert.deepEqual(calls(), [], 'no command ran');
    } finally {
      await bridge.close();
    }
  });

  test('a computer that is not signed in is not served; a serve that fails leaves no name and no hint', async () => {
    fresh('needslogin');
    const ts = createTailscaleCarrier({ locate: locateFake() });
    const ctx = fakeCtx({ enabled: true, port: 4321 });
    const view = await ts.start(ctx);
    assert.equal(view.ready, false);
    assert.match(view.message, /Sign in/);
    assert.deepEqual(calls().filter(a => a[0] === 'serve'), [], 'nothing is served while signed out');
    assert.deepEqual(await ts.hints(), [{ kind: 'tailscale', on: false, label: 'Tailscale' }]);

    fresh(undefined, 'serve');
    const failing = createTailscaleCarrier({ locate: locateFake() });
    const failed = await failing.start(fakeCtx({ enabled: true, port: 4321 }));
    assert.equal(failed.error, 'serve');
    assert.equal(failed.ready, false);
    assert.equal(calls().filter(a => a[0] === 'serve').length, 1, 'the serve was attempted once');
    assert.doesNotMatch(JSON.stringify(failed), /tail1234/, 'no name is reported when the serve failed');
  });

  test('a stop without a context resets nothing; a stop with a remembered name resets once; a stop with no marker resets nothing', async () => {
    fresh();
    const ts = createTailscaleCarrier({ locate: locateFake() });
    const ctx = fakeCtx({ enabled: true, port: 4321 });
    await ts.start(ctx);
    assert.equal(ctx.state.name, 'will-pc.tail1234.ts.net', 'the name is remembered for a later launch');
    await ts.stop();
    assert.deepEqual(calls().filter(a => a[0] === 'serve').map(a => a[1]), ['--bg'], 'one serve and no reset from the Bridge closing');

    const later = fakeCtx({ enabled: false, port: 4321, name: 'will-pc.tail1234.ts.net' });
    await ts.stop(later);
    assert.deepEqual(calls().slice(-1), [['serve', 'reset']], 'the remembered serve is reset in a later launch');
    assert.equal(later.state.name, '');

    fresh();
    const other = createTailscaleCarrier({ locate: locateFake() });
    await other.stop(fakeCtx({ enabled: false, port: 4321, name: '' }));
    assert.deepEqual(calls(), [], 'a computer whose serve Plenum never set is left alone');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The relay: a small adapter that serves the real Worker and Room on a loopback socket

// Serves the relay Worker and Room (relay/src, through relay/test/support/fake-driver.mjs) on 127.0.0.1: each WebSocket upgrade becomes
// the connection the Worker's Room accepts, and frames pass both ways. Host sockets are recorded so a test can drop one as a network would.
async function startRoomAdapter(driver) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70_000, perMessageDeflate: false });
  const hosts = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-length': '0' });
    res.end();
  });
  const refuse = (socket, line) => {
    try {
      socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } finally {
      socket.destroy();
    }
  };
  function wire(ws, client, role) {
    const inbox = client.handle.inbox;
    const early = inbox.closeInfo;
    inbox.push = data => {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
    };
    inbox.closeWith = info => {
      try {
        ws.close(info.code, info.reason);
      } catch {
        ws.terminate();
      }
    };
    if (early) ws.close(early.code, early.reason);
    if (role === 'host') hosts.add(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) client.send(data);
    });
    ws.on('close', () => {
      hosts.delete(ws);
      client.close();
    });
    ws.on('error', () => {});
  }
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const match = /^\/room\/([0-9a-f]{32})$/.exec(req.url ?? '');
    if (!match) return refuse(socket, '404 Not Found');
    const role = req.headers['x-plenum-role'];
    const headers = role === undefined ? {} : { 'x-plenum-role': String(role), 'x-plenum-host-secret': String(req.headers['x-plenum-host-secret'] ?? '') };
    driver.connect(match[1], headers).then(client => {
      wss.handleUpgrade(req, socket, head, ws => wire(ws, client, role === 'host' ? 'host' : 'phone'));
    }, () => refuse(socket, '403 Forbidden'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    dropHosts() {
      for (const ws of [...hosts]) ws.terminate();
    },
    async close() {
      for (const ws of [...hosts]) ws.terminate();
      await new Promise(resolve => {
        wss.close(() => resolve());
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

// The part of the Bridge context the relay carrier reads, with a room and a secret the test chooses.
function fakeRelayCtx({ origin, roomId, hostSecret, enabled = true, handshaker = { accept: () => null }, pathKey = 'a'.repeat(32) }) {
  const handlers = new Map();
  return {
    settings: () => ({ enabled, url: origin }),
    registry: {
      ensureRelay: async () => ({ roomId, hostSecret }),
      relay: () => ({ roomId, hostSecret }),
      pathKey: () => pathKey,
      on: (name, fn) => {
        handlers.set(name, fn);
        return () => handlers.delete(name);
      },
    },
    handshaker,
    listener: { port: () => 0, setLan: async () => ({}) },
    publish() {},
  };
}

// IKpsk2 over the relay as phone-sim does it, with the finished handshake kept: the Stop key is stopKey(h). The first transport message (a
// PING) proves the phone holds the pairing secret.
async function pairKeepingRelay(phone, link) {
  const desktopPublic = b64uDecode(link.pub);
  const channel = await openChannel(link.carriers.find(c => c.kind === 'relay').url);
  phone.counter += 1;
  const payload = { v: '1.0', kind: 'pair', counter: phone.counter, offer: link.offer, device: phone.device, caps: [] };
  const hs = noise.handshakeInitiator({
    staticPrivate: phone.keys.privateKey, remoteStaticPublic: desktopPublic, prologue: noise.prologue('relay', link.offer), psk: b64uDecode(link.psk),
  });
  channel.send(noise.sealMessage1(desktopPublic, hs.writeMessage1(new TextEncoder().encode(JSON.stringify(payload)))));
  hs.readMessage2(await channel.next());
  const cs = hs.finish();
  channel.send(cs.send.encrypt(encodeFrame(FRAME_TYPE.PING, 0, 0, new Uint8Array(8))));
  return { cs, channel, h: new Uint8Array(cs.handshakeHash) };
}

// The host socket a carrier opens to the room, in memory: the test is the room. deliver() hands the host a phone's frame, with the
// 4-byte connection id in front, the way relay/src/room.mjs does; sent holds what the host wrote.
class FakeHostSocket {
  static all = [];
  constructor(url, init = {}) {
    this.url = url;
    this.headers = init.headers ?? {};
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeHostSocket.all.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit('open', {});
    });
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  send(data) {
    this.sent.push(new Uint8Array(data));
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', { code, reason }));
  }
  get bufferedAmount() {
    return 0;
  }
  deliver(conn, bytes) {
    const framed = new Uint8Array(4 + bytes.length);
    new DataView(framed.buffer).setUint32(0, conn, false);
    framed.set(bytes, 4);
    this.emit('message', { data: framed.buffer });
  }
  // The frames the host wrote for one connection id (0 is control, JSON).
  framesFor(conn) {
    return this.sent.filter(b => new DataView(b.buffer, b.byteOffset).getUint32(0, false) === conn).map(b => b.slice(4));
  }
  controls() {
    return this.framesFor(0).map(b => JSON.parse(new TextDecoder().decode(b)));
  }
}

describe('relay client: one source for every phone, and a new room', () => {
  test('relay handshakes share one source: past 30 a minute across connection ids the next is refused 4429', async () => {
    FakeHostSocket.all.length = 0;
    const bridge = await makeBridge({ carrier: false });
    const carrier = createRelayCarrier({ WebSocket: FakeHostSocket, allowLoopbackHttp: true });
    try {
      const opened = []; // one entry per phone connection the carrier handed to the handshaker, in order
      const handshaker = {
        accept: ({ carrier: kind, source, transport }) => {
          const entry = { kind, source, closed: null };
          opened.push(entry);
          return bridge.remote.handshaker.accept({
            carrier: kind,
            source,
            transport: {
              send: bytes => transport.send(bytes),
              close: (code, reason) => {
                entry.closed = { code, reason };
                transport.close(code, reason);
              },
              get bufferedAmount() { return transport.bufferedAmount; },
            },
          });
        },
      };
      await carrier.start(fakeRelayCtx({ origin: 'http://127.0.0.1:9', roomId: 'c'.repeat(32), hostSecret: 'd'.repeat(40), handshaker }));
      const host = FakeHostSocket.all.at(-1);
      await until(() => carrier.status().connected, 'the host to open its socket');
      const desktopPublic = bridge.desktopPublic;
      const stranger = createPhone({ name: 'Stranger' }); // not held by this computer: each handshake is spent and then refused
      const make = () => {
        const initiator = noise.handshakeInitiator({ staticPrivate: stranger.keys.privateKey, remoteStaticPublic: desktopPublic, prologue: noise.prologue('relay') });
        const body = initiator.writeMessage1(new TextEncoder().encode(JSON.stringify({ v: '1.0', kind: 'session', counter: 1, device: stranger.device, caps: [] })));
        return cookie => noise.sealMessage1(desktopPublic, body, cookie);
      };
      let refusedAt = 0;
      let cookies = 0;
      for (let id = 1; id <= 45 && refusedAt === 0; id++) {
        const wire = make();
        host.deliver(id, wire());
        await until(() => host.framesFor(id).length > 0 || opened[id - 1]?.closed, 'an answer to connection ' + id);
        const reply = host.framesFor(id)[0];
        const cookie = reply ? noise.parseCookieReply(reply) : null;
        if (cookie) {
          cookies += 1;
          host.deliver(id, wire(cookie));
        }
        await until(() => opened[id - 1]?.closed, 'connection ' + id + ' to end');
        if (opened[id - 1].closed.code === 4429) refusedAt = id;
      }
      assert.ok(opened.every(o => o.kind === 'relay' && o.source === 'relay'), 'every phone of the room has the one source');
      assert.equal(refusedAt, 31, 'ten handshakes pass freely, twenty more with a cookie, and the 31st in the minute is refused');
      assert.deepEqual(opened[30].closed, { code: 4429, reason: 'rate' });
      assert.equal(opened.slice(0, 30).every(o => o.closed.code === 4401), true, 'the others were spent and refused as a stranger');
      assert.equal(cookies, 21, 'from the 11th connection on, a cookie is asked for');
    } finally {
      await carrier.stop();
      await bridge.close();
    }
  });

  // Fable's re-check: every relay phone shared the source 'relay', so anyone holding an old pairing link could spend the 30 handshakes a
  // minute of all relay phones. The room now says each joining phone's address ({ op: 'open', conn, ip }, relay/src/room.mjs) and the
  // source of that connection is relay:<ip>.
  test('phones with different addresses have separate handshake windows: one address spending its 30 a minute does not touch another phone; no address, or one that is not an address, falls back to the shared source', async () => {
    FakeHostSocket.all.length = 0;
    const bridge = await makeBridge({ carrier: false });
    const carrier = createRelayCarrier({ WebSocket: FakeHostSocket, allowLoopbackHttp: true });
    try {
      const opened = [];
      const handshaker = {
        accept: ({ carrier: kind, source, transport }) => {
          const entry = { kind, source, closed: null };
          opened.push(entry);
          return bridge.remote.handshaker.accept({
            carrier: kind,
            source,
            transport: {
              send: bytes => transport.send(bytes),
              close: (code, reason) => {
                entry.closed = { code, reason };
                transport.close(code, reason);
              },
              get bufferedAmount() { return transport.bufferedAmount; },
            },
          });
        },
      };
      await carrier.start(fakeRelayCtx({ origin: 'http://127.0.0.1:9', roomId: 'c'.repeat(32), hostSecret: 'd'.repeat(40), handshaker }));
      const host = FakeHostSocket.all.at(-1);
      await until(() => carrier.status().connected, 'the host to open its socket');
      const desktopPublic = bridge.desktopPublic;
      const stranger = createPhone({ name: 'Stranger' });
      const make = () => {
        const initiator = noise.handshakeInitiator({ staticPrivate: stranger.keys.privateKey, remoteStaticPublic: desktopPublic, prologue: noise.prologue('relay') });
        const body = initiator.writeMessage1(new TextEncoder().encode(JSON.stringify({ v: '1.0', kind: 'session', counter: 1, device: stranger.device, caps: [] })));
        return cookie => noise.sealMessage1(desktopPublic, body, cookie);
      };
      const say = (conn, ip) => host.deliver(0, new TextEncoder().encode(JSON.stringify({ op: 'open', conn, ip })));
      // One phone connection: the room's 'open' (when there is an address), message 1, and the cookie round when the computer asks for one.
      // Resolves { source, closed, cookie }: how the computer ended it and whether it asked for a cookie.
      const connect = async (conn, ip) => {
        if (ip !== undefined) say(conn, ip);
        const index = opened.length;
        const wire = make();
        host.deliver(conn, wire());
        await until(() => host.framesFor(conn).length > 0 || opened[index]?.closed, 'an answer to connection ' + conn);
        const reply = host.framesFor(conn)[0];
        const cookie = reply ? noise.parseCookieReply(reply) : null;
        if (cookie) host.deliver(conn, wire(cookie));
        await until(() => opened[index]?.closed, 'connection ' + conn + ' to end');
        return { source: opened[index].source, closed: opened[index].closed, cookie: Boolean(cookie) };
      };
      // The holder of an old pairing link spends the allowance of its own address.
      let refusedAt = 0;
      for (let conn = 1; conn <= 40 && refusedAt === 0; conn++) {
        const out = await connect(conn, '203.0.113.7');
        assert.equal(out.source, 'relay:203.0.113.7', 'connection ' + conn + ' has the address of its phone as its source');
        if (out.closed.code === 4429) refusedAt = conn;
      }
      assert.equal(refusedAt, 31, 'the 31st handshake in a minute from that address is refused');
      // Another phone, another address: its own window, so no cookie is asked for and it is not rate-limited (a stranger is refused 4401).
      const other = await connect(101, '198.51.100.9');
      assert.equal(other.source, 'relay:198.51.100.9');
      assert.equal(other.cookie, false, 'the other address is not under load');
      assert.deepEqual(other.closed, { code: 4401, reason: 'unknown' }, 'it is answered as itself, not cut at 4429');
      // The first address stays refused, and the second is not shared with it.
      assert.equal((await connect(102, '203.0.113.7')).closed.code, 4429);
      // An upper-case address is the same source as its lower-case form (IPv6).
      assert.equal((await connect(103, '2001:DB8::1')).source, 'relay:2001:db8::1');
      // No 'open' (an older room, or no address seen), a bad address, or one for a connection that is already open: the shared source.
      assert.equal((await connect(201)).source, 'relay', 'no address');
      assert.equal((await connect(202, 'not an address; drop table')).source, 'relay', 'a text that is not an address');
      assert.equal((await connect(203, '1.2.3.4'.repeat(20))).source, 'relay', 'a text that is too long');
      assert.equal((await connect(204, 7)).source, 'relay', 'not a string');
      // The address is for one connection only: a later connection with the same id and no new 'open' does not reuse it.
      assert.equal((await connect(103)).source, 'relay', 'taken once, at the first frame');
    } finally {
      await carrier.stop();
      await bridge.close();
    }
  });

  test('after newRelayRoom the carrier connects to the new room URL, with the new host secret and no rotate to the old room; Remove all does the same', async () => {
    FakeHostSocket.all.length = 0;
    const registry = createRegistry({ storage: createMemoryStorage() });
    await registry.ready();
    await registry.ensureIdentity();
    const first = await registry.ensureRelay();
    const carrier = createRelayCarrier({ WebSocket: FakeHostSocket, allowLoopbackHttp: true });
    const ctx = {
      settings: () => ({ enabled: true, url: 'http://127.0.0.1:9' }),
      registry: { ensureRelay: () => registry.ensureRelay(), relay: () => registry.relay(), pathKey: () => registry.pathKey(), on: (name, fn) => registry.on(name, fn) },
      handshaker: { accept: () => null },
      listener: { port: () => 0, setLan: async () => ({}) },
      publish() {},
    };
    try {
      await carrier.start(ctx);
      const one = FakeHostSocket.all.at(-1);
      assert.equal(one.url, 'ws://127.0.0.1:9/room/' + first.roomId);
      assert.equal(one.headers['x-plenum-host-secret'], first.hostSecret);
      await until(() => carrier.status().connected, 'the host to claim the first room');
      const made = await registry.newRelayRoom();
      const two = FakeHostSocket.all.at(-1);
      assert.notEqual(two, one, 'a new socket');
      assert.notEqual(made.roomId, first.roomId);
      assert.equal(two.url, 'ws://127.0.0.1:9/room/' + made.roomId, 'the new room\'s URL');
      assert.equal(two.headers['x-plenum-host-secret'], registry.relay().hostSecret, 'with the new host secret');
      assert.notEqual(two.headers['x-plenum-host-secret'], first.hostSecret);
      assert.equal(one.readyState, 3, 'the host socket to the old room is closed');
      assert.deepEqual(one.controls().filter(op => op.op === 'rotate'), [], 'no rotate was sent to the old room');
      assert.deepEqual(one.sent, [], 'nothing at all was sent to the old room');
      await until(() => carrier.status().connected, 'the host to claim the new room');
      assert.equal(carrier.status().reason, '');
      assert.equal((await carrier.hints())[0].url, 'ws://127.0.0.1:9/room/' + made.roomId);
      assert.equal(JSON.stringify(carrier.status()).includes(registry.relay().hostSecret), false, 'the secret is not in the status');
      // Remove all (a reset) changes the room id too.
      const beforeAll = registry.relay();
      await registry.removeAll({ rotate: true });
      const three = FakeHostSocket.all.at(-1);
      assert.notEqual(registry.relay().roomId, beforeAll.roomId);
      assert.equal(three.url, 'ws://127.0.0.1:9/room/' + registry.relay().roomId);
      assert.equal(three.headers['x-plenum-host-secret'], registry.relay().hostSecret);
      assert.equal(two.readyState, 3);
      assert.deepEqual(two.controls().filter(op => op.op === 'rotate'), [], 'no rotate to the room that was left');
      await until(() => carrier.status().connected, 'the host to claim the room after Remove all');
      // A reset that keeps the room and the secret (no new key) moves nothing.
      const count = FakeHostSocket.all.length;
      await registry.removeAll({ rotate: false });
      assert.equal(FakeHostSocket.all.length, count, 'no new socket');
      assert.equal(three.readyState, 1, 'and the open one stays');
    } finally {
      await carrier.stop();
    }
  });

  test('inside the same room a changed host secret is still sent as rotate, and the open socket stays', async () => {
    FakeHostSocket.all.length = 0;
    const handlers = new Map();
    let rec = { roomId: 'e'.repeat(32), hostSecret: 'f'.repeat(40) };
    const carrier = createRelayCarrier({ WebSocket: FakeHostSocket, allowLoopbackHttp: true });
    const ctx = {
      settings: () => ({ enabled: true, url: 'http://127.0.0.1:9' }),
      registry: {
        ensureRelay: async () => rec, relay: () => rec, pathKey: () => 'a'.repeat(32),
        on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
      },
      handshaker: { accept: () => null },
      listener: { port: () => 0, setLan: async () => ({}) },
      publish() {},
    };
    try {
      await carrier.start(ctx);
      const sock = FakeHostSocket.all.at(-1);
      await until(() => carrier.status().connected, 'the host to open');
      assert.deepEqual([...handlers.keys()].sort(), ['relay-room', 'reset'], 'the carrier listens for both');
      const next = 'g'.repeat(40);
      rec = { roomId: rec.roomId, hostSecret: next };
      handlers.get('reset')();
      assert.equal(FakeHostSocket.all.length, 1, 'same room: no new socket');
      assert.deepEqual(sock.controls(), [{ op: 'rotate', secretHash: sha256Hex(next) }]);
      assert.equal(sock.readyState, 1);
    } finally {
      await carrier.stop();
    }
    assert.deepEqual([...handlers.keys()], [], 'stop lets go of both listeners');
  });
});

describe('relay client: the parts that need no Worker', () => {
  test('a relay address must be https (or loopback http in a test), with no credentials, query or hash', () => {
    assert.deepEqual(parseRelayUrl('https://plenum-relay.acct.workers.dev'), { origin: 'https://plenum-relay.acct.workers.dev', wsBase: 'wss://plenum-relay.acct.workers.dev', basePath: '' });
    assert.deepEqual(parseRelayUrl('https://relays.example.com/plenum/'), { origin: 'https://relays.example.com', wsBase: 'wss://relays.example.com', basePath: '/plenum' });
    assert.equal(parseRelayUrl('http://plenum-relay.acct.workers.dev'), null);
    assert.equal(parseRelayUrl('https://user:pass@plenum-relay.acct.workers.dev'), null);
    assert.equal(parseRelayUrl('https://plenum-relay.acct.workers.dev/?x=1'), null);
    assert.equal(parseRelayUrl('not a url'), null);
    assert.equal(parseRelayUrl('http://127.0.0.1:9000'), null, 'loopback http is for tests only');
    assert.deepEqual(parseRelayUrl('http://127.0.0.1:9000', { allowLoopbackHttp: true }), { origin: 'http://127.0.0.1:9000', wsBase: 'ws://127.0.0.1:9000', basePath: '' });
  });

  test('the wait before a retry starts at about half a second and doubles to 30 s, with jitter', () => {
    const low = () => 0;
    const high = () => 0.999999;
    assert.equal(backoffFor(0, low), Math.round(FIRST_RETRY_MS * 0.75));
    assert.ok(backoffFor(0, high) <= Math.round(FIRST_RETRY_MS * 1.25));
    assert.ok(backoffFor(1, high) > backoffFor(0, high));
    assert.ok(backoffFor(40, high) <= Math.round(MAX_RETRY_MS * 1.25), 'never longer than 30 s plus jitter');
  });

  test('the upgrade probe reports a refusal (403) and an accepted upgrade (101) without keeping the socket', async () => {
    const wsServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => wsServer.once('listening', resolve));
    const { port } = wsServer.address();
    try {
      assert.equal(await probeUpgrade(`ws://127.0.0.1:${port}/room/x`), 101);
    } finally {
      await new Promise(resolve => wsServer.close(resolve));
    }
    const refusing = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise(resolve => refusing.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal(await probeUpgrade(`ws://127.0.0.1:${refusing.address().port}/room/x`, { 'x-plenum-role': 'host' }), 403);
    } finally {
      await new Promise(resolve => refusing.close(resolve));
    }
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('relay client against the relay Worker and Room', () => {
  let adapter;
  let bridge;
  let carrier;
  let roomId;
  let roomUrl;
  let paired;
  let driver;

  before(async () => {
    const { createFakeDriver } = await import('../../relay/test/support/fake-driver.mjs');
    driver = await createFakeDriver();
    adapter = await startRoomAdapter(driver);
    carrier = createRelayCarrier({ allowLoopbackHttp: true });
    bridge = await makeBridge({
      carrier: false,
      phones: { lan: { enabled: false, anyAddress: false }, relay: { enabled: true, url: adapter.origin } },
      remoteOptions: { loadCarrier: async kind => (kind === 'relay' ? { default: carrier } : null) },
      // STOP reaches the drives, agents and project list; a test has none of them, so each is a stub (as in bridge.test.mjs).
      stopDeps: { drives: { stopAll: () => 0, stopProject: () => 0 }, agents: { stopAll: () => 0 }, projectIds: () => [] },
    });
    roomId = bridge.remote.registry.relay().roomId;
    roomUrl = `ws://127.0.0.1:${adapter.port}/room/${roomId}`;
    await until(() => carrier.status().connected, 'the host to claim the room', 8000);
  });

  after(async () => {
    await bridge?.close();
    await carrier?.stop();
    await adapter?.close();
  });

  test('the host claims the room, and a phone pairs and exchanges frames through it', async () => {
    const started = await bridge.remote.pairStart();
    assert.equal(started.ok, true);
    const payload = decodeLink(started.link);
    const hint = payload.carriers.find(c => c.kind === 'relay');
    assert.equal(hint.url, roomUrl, 'the pairing names the room, and the host secret is not in it');
    assert.equal(JSON.stringify(payload).includes(bridge.remote.registry.relay().hostSecret), false);
    const phone = createPhone({ name: "Will's iPhone", platform: 'ios' });
    paired = await phone.pair(decodeLink(started.link), { carrier: 'relay' }); // the prologue names the carrier the phone reached the desktop by
    await until(() => bridge.remote.pairing.view().state === 'confirm', 'the confirm state');
    assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
    const hello = await paired.hello;
    assert.equal(hello.tier, 'full');
    assert.equal(hello.desktopName, 'Test PC');
    const ack = await paired.session.stop('0123abcd0123abcd');
    assert.equal(ack.id, '0123abcd0123abcd', 'STOP went up through the relay and STOP_ACK came back');
  });

  test('a phone that hangs up leaves the connected list within a second, and the room hears no kick back', async () => {
    const before = carrier.status().phones;
    const started = await bridge.remote.pairStart();
    assert.equal(started.ok, true);
    const second = createPhone({ name: 'Second phone', platform: 'android' });
    const other = await second.pair(decodeLink(started.link), { carrier: 'relay' });
    await until(() => bridge.remote.pairing.view().state === 'confirm', 'the confirm state');
    assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
    await other.hello;
    await until(() => carrier.status().phones === before + 1, 'the second phone to be counted');
    const connectedNow = () => bridge.published.filter(e => e.type === 'phone' && e.kind === 'presence').at(-1)?.connected ?? [];
    await until(() => connectedNow().some(p => p.name === 'Second phone'), 'the second phone to be shown as connected');
    const closedAt = Date.now();
    other.channel.close(); // the phone's socket goes away; nothing tells the desktop except the room
    await until(() => carrier.status().phones === before, 'the phone to leave the carrier list', 1000);
    await until(() => !connectedNow().some(p => p.name === 'Second phone'), 'the phone to leave the connected list', 1000);
    assert.ok(Date.now() - closedAt < 1000, 'the desktop heard within a second, not at its own liveness check');
    assert.equal(carrier.status().phones, before, 'the first phone is still counted');
  });

  test('a wrong host secret is refused by the room, and a carrier holding it reports refused', async () => {
    const wrongSecret = 'w'.repeat(40);
    assert.equal(await probeUpgrade(roomUrl, { 'x-plenum-role': 'host', 'x-plenum-host-secret': wrongSecret }), 403);
    assert.equal(await probeUpgrade(roomUrl, { 'x-plenum-role': 'host', 'x-plenum-host-secret': 'short' }), 403, 'a malformed secret is refused');
    const intruder = createRelayCarrier({ allowLoopbackHttp: true });
    try {
      await intruder.start(fakeRelayCtx({ origin: adapter.origin, roomId, hostSecret: wrongSecret }));
      await until(() => intruder.status().reason === 'refused', 'the refusal to be reported', 8000);
      assert.equal(intruder.status().connected, false);
      assert.equal(carrier.status().connected, true, 'the real host keeps the room');
      assert.equal(JSON.stringify(intruder.status()).includes(wrongSecret), false, 'the secret is not in the status');
    } finally {
      await intruder.stop();
    }
  });

  test('a STOP_ONLY through the relay carrier reaches onStopOnly and the ACK goes back to that phone', async () => {
    const started = await bridge.remote.pairStart();
    const phone = createPhone({ name: 'Locked relay phone', platform: 'ios' });
    const kept = await pairKeepingRelay(phone, decodeLink(started.link));
    await until(() => bridge.remote.pairing.view().state === 'confirm', 'the confirm state');
    assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
    const key = noise.stopKey(kept.h);
    kept.channel.close();
    await until(() => !bridge.remote.sessions().has(phone.id), 'the pairing session to end');
    const phonesBefore = carrier.status().phones;
    const presenceBefore = bridge.published.filter(e => e.type === 'phone' && e.kind === 'presence').length;
    // A new phone connection of the room whose first and only message is the STOP_ONLY.
    const channel = await openChannel(roomUrl);
    const id = '5a'.repeat(16);
    channel.send(encodeStopOnly({ stopKey: key, deviceId: phone.id, counter: phone.counter + 1, stopId: id }));
    const ack = await channel.next(6000);
    assert.deepEqual(decodeStopAck(key, ack, id), { cancelled: 0, drivesStopped: 0, agentsStopped: 0, cardsDenied: 0 }, 'the signed ACK came back to that phone');
    assert.ok(bridge.remote.activity().some(a => a.text === 'stopped everything' && a.device === 'Locked relay phone'), 'onStopOnly ran the Stop and added the activity line');
    const closed = await Promise.race([channel.closed, sleep(3000).then(() => null)]);
    assert.ok(closed, 'the desktop ended the connection after the ACK (the carrier kicks it)');
    await until(() => carrier.status().phones === phonesBefore, 'the connection to leave the carrier list');
    assert.equal(bridge.published.filter(e => e.type === 'phone' && e.kind === 'presence').length, presenceBefore, 'no presence event');
    // The same message through the relay is a replay.
    const again = await openChannel(roomUrl);
    again.send(encodeStopOnly({ stopKey: key, deviceId: phone.id, counter: phone.counter + 1, stopId: id }));
    const refused = await again.next(4000).then(bytes => bytes, error => error);
    assert.ok(!(refused instanceof Uint8Array), 'no ACK for a replay');
    again.close();
  });

  test('the room drops the host: the phone is closed with host-offline, and the host re-claims within 2 s', async () => {
    const dropped = paired.channel.closed;
    const started = Date.now();
    adapter.dropHosts();
    const info = await dropped;
    assert.equal(info.code, 4001, 'the room closed the phone with host-offline');
    assert.equal(info.reason, 'host-offline');
    await until(() => carrier.status().connected, 'the host to re-claim the room', 2000);
    assert.ok(Date.now() - started < 2000, 'the host re-claimed within 2 s');
  });

  test('Remove all moves the host to a new room: the old room is left with no rotate, the new room is claimed with the new secret, and a phone pairs through it', async () => {
    const old = bridge.remote.registry.relay();
    await bridge.remote.removeAll();
    const fresh = bridge.remote.registry.relay();
    assert.notEqual(fresh.roomId, old.roomId, 'a new room id');
    assert.notEqual(fresh.hostSecret, old.hostSecret, 'and a new host secret');
    const freshUrl = 'ws://127.0.0.1:' + adapter.port + '/room/' + fresh.roomId;
    await until(() => carrier.status().connected && carrier.status().reason === '', 'the host to claim the new room', 6000);
    assert.equal((await carrier.hints())[0].url, freshUrl, 'the pairing names the new room');
    // The new room has a host: a wrong secret is refused (an unclaimed room would take anyone).
    assert.equal(await probeUpgrade(freshUrl, { 'x-plenum-role': 'host', 'x-plenum-host-secret': 'w'.repeat(40) }), 403);
    // The new secret does not open the old room.
    assert.equal(await probeUpgrade(roomUrl, { 'x-plenum-role': 'host', 'x-plenum-host-secret': fresh.hostSecret }), 403, 'the old room does not take this computer\'s new secret');
    assert.equal(JSON.stringify(carrier.status()).includes(fresh.hostSecret), false);
    roomId = fresh.roomId;
    roomUrl = freshUrl;
    // A phone pairs through the new room, and Stop goes up and comes back.
    const started = await bridge.remote.pairStart();
    assert.equal(decodeLink(started.link).carriers.find(c => c.kind === 'relay').url, freshUrl);
    const phone = createPhone({ name: 'After Remove all', platform: 'ios' });
    const through = await phone.pair(decodeLink(started.link), { carrier: 'relay' });
    await until(() => bridge.remote.pairing.view().state === 'confirm', 'the confirm state');
    assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
    await through.hello;
    assert.equal((await through.session.stop('0123abcd0123abce')).id, '0123abcd0123abce');
    through.session.close();
  });

  test('stop leaves the room and nothing reconnects', async () => {
    await carrier.stop();
    await sleep(1200);
    assert.equal(carrier.status().on, false);
    assert.equal(carrier.status().connected, false);
    assert.equal(carrier.status().reason, 'off');
  });
});

void [randomBytes, freePort];
