// The page shim (mob-09, wave 105): mobile/shell/boot.js over a fake page and a fake channel, and the real channel.js over a fake Worker.
// Covers request('/api/state') parity, a getReader stream from POST /api/compare in order, GET /api/events with hello and drive events,
// AbortController -> CANCEL, the not-connected and refused shapes, the plenumShell object, the shell DOM (no inline style, text only),
// and the artifact iframe's page side. The live Electron checks (the artifact iframe under its real CSP, one reload on a generation
// bump in the Electron window) belong to the mob-18 harness; see the report for what this suite does not reach.
// Run through the sealed runner, never from the project folder:
//   node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id mob-09-shims-ui-manifest-and-loader shim.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import {
  ARTIFACT_VIEW, base64Of, bodyBytes, capsFor, debugHooksOn, installShim, isLanPage, LOCK_STOP_ARMED_NOTE, LOCK_STOP_READY_LABEL, LOCK_STOP_UNLOCK_LABEL,
  LOCK_TRY_AGAIN, LOCK_UNKNOWN_NOTE, mapChannelError, pickRequestHeaders, pickResponseHeaders, readCapped, sseParser,
} from '../shell/boot.js';
import { bytesToB64u, openChannel } from '../shell/channel.js';
import { deviceFor } from '../shell/app.js';
import { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { startSealedServer } from './helpers/sealed-server.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SURFACE = `http://127.0.0.1:7300/p/${'a'.repeat(32)}/?debug=1`;

// ----- fakes -----

// A fake page document: createElement, append, getElementById, attributes and text only.
function fakeDocument() {
  const byId = new Map();
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.listeners = new Map();
      this.textContent = '';
      this.hidden = false;
      this.id = '';
      this.className = '';
      this.parent = null;
    }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    append(...nodes) {
      for (const n of nodes) {
        n.parent = this;
        this.children.push(n);
        if (n.id) byId.set(n.id, n);
        for (const c of n.children ?? []) if (c.id) byId.set(c.id, c);
      }
    }
    remove() {}
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() { for (const fn of this.listeners.get('click') ?? []) fn({ type: 'click' }); }
    all() { return [this, ...this.children.flatMap(c => c.all())]; }
  }
  const doc = {
    readyState: 'complete',
    documentElement: new El('html'),
    head: new El('head'),
    body: new El('body'),
    createElement: tag => new El(tag),
    getElementById: id => byId.get(id) ?? null,
    visibilityState: 'visible',
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(fn);
    },
    fire(type) { for (const fn of doc.listeners.get(type) ?? []) fn({ type }); },
    El,
  };
  doc.documentElement.setAttribute('lang', 'en');
  return doc;
}

function fakeWindow(url = SURFACE) {
  const win = {
    location: new URL(url),
    Response,
    ReadableStream,
    fetch: async () => { throw new Error('the original fetch was used'); },
    setTimeout,
    clearTimeout,
    opened: [],
    open(...args) { win.opened.push(args); return null; },
    navigator: {},
  };
  return win;
}

// A fake shell core with the facade's members (plan C6b): the snapshot the shell publishes, with state, subscribe, request, stop, lock, unlock and log.
function fakeCore(channel) {
  const subs = new Set();
  const core = {
    channel,
    stops: [],
    unlocks: [],
    unlockArgs: [],   // the second argument of each unlock (a PIN's digits); only the PIN tests read it
    locks: 0,
    snapshot: {
      connection: { status: 'connected', carrier: 'lan', desktopName: 'Home PC', lastSeen: null },
      locked: false,
      lock: { mode: 'biometric' },
      computers: [{ id: 'a', name: 'Home PC' }],
      activeId: 'a',
      stop: { state: 'idle', text: '', seq: 0 },
      notice: null,
      prefs: { theme: 'follow' },
      hello: null,
    },
    shellOpens: [],
    logs: [],
    state: () => core.snapshot,
    request(spec, body = null, opts = {}) {
      if (!core.channel) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      return core.channel.request(spec, body, opts);
    },
    log(line) { core.logs.push(line); },
    async openShell(hash = '') { core.shellOpens.push(hash); return true; },
    subscribe(fn) {
      subs.add(fn);
      fn(core.snapshot);
      return () => subs.delete(fn);
    },
    push(patch) {
      Object.assign(core.snapshot, patch);
      for (const fn of [...subs]) fn(core.snapshot);
    },
    async stop(project = null) {
      core.stops.push(project);
      return { state: 'done', text: 'Stopped' };
    },
    async lock() {
      core.locks += 1;
      if (core.snapshot.lock?.mode === 'off') return { ok: false, reason: 'no-lock' };
      core.push({ locked: true });
      return { ok: true, reason: null };
    },
    unlockResult: { ok: true },
    async unlock(method, arg = null) {
      core.unlocks.push(method);
      core.unlockArgs.push(arg);
      return core.unlockResult;
    },
  };
  return core;
}

function streamOf(chunks) {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
      c.close();
    },
  });
}

// A fake channel: request(req, body, opts) is answered by handler, and every call is recorded.
function fakeChannel(handler) {
  const channel = {
    calls: [],
    cancels: [],
    request(req, body = null, opts = {}) {
      channel.calls.push({ req, body: body ? dec.decode(body) : null, signal: opts.signal ?? null });
      return handler(req, body, opts);
    },
    cancel(id) {
      channel.cancels.push(id);
      return true;
    },
    onState() { return () => {}; },
    onHello() { return () => {}; },
  };
  return channel;
}

function answerJson(value, status = 200) {
  return Promise.resolve({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-plenum-auth': 'token', 'x-secret': 'drop me' },
    body: streamOf([JSON.stringify(value)]),
    id: 7,
    cancel() {},
  });
}

function install(extra = {}) {
  const win = extra.win ?? fakeWindow();
  const doc = extra.doc ?? fakeDocument();
  const channel = extra.channel ?? fakeChannel(() => answerJson({ ok: true }));
  const core = extra.core === undefined ? fakeCore(channel) : extra.core;
  const originalCalls = [];
  const origFetch = extra.origFetch ?? (async (input) => { originalCalls.push(String(input)); return new Response('original'); });
  const shim = installShim({ win, doc, origFetch, core, plugins: extra.plugins, app: { version: '1.0.0', build: '7' }, ...extra.opts });
  return { win, doc, channel, core, shim, originalCalls };
}

// ----- tests -----

describe('boot.js: header and body helpers', () => {
  test('requests keep only the allowlisted headers: the placeholder token is dropped', () => {
    const got = pickRequestHeaders({ 'x-plenum-token': '0'.repeat(64), 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-plenum-client-id': 'c1', cookie: 'no' });
    assert.deepEqual(got, { 'content-type': 'application/json', accept: 'text/event-stream', 'x-plenum-client-id': 'c1' });
    const fromHeaders = new Headers({ 'content-type': 'text/plain', 'x-plenum-token': 'x' });
    assert.deepEqual(pickRequestHeaders(fromHeaders), { 'content-type': 'text/plain' });
    assert.deepEqual(pickRequestHeaders([['Accept', 'x']]), { accept: 'x' });
  });

  test('responses keep the allowlisted headers, including the CSP, and drop the rest', () => {
    const got = pickResponseHeaders({ 'content-security-policy': "default-src 'none'", 'x-secret': 'no', 'content-length': '5' });
    assert.deepEqual(got, { 'content-security-policy': "default-src 'none'", 'content-length': '5' });
  });

  test('bodies become bytes; an unsupported body is refused rather than sent wrong', async () => {
    assert.deepEqual([...await bodyBytes('hi')], [104, 105]);
    assert.equal(await bodyBytes(null), null);
    assert.deepEqual([...await bodyBytes(new Uint8Array([1, 2]))], [1, 2]);
    assert.deepEqual([...await bodyBytes(new URLSearchParams('a=1'))], [97, 61, 49]);
    await assert.rejects(bodyBytes(new FormData()), TypeError);
  });

  test('the SSE parser yields each data payload once, across chunk boundaries', () => {
    const seen = [];
    const p = sseParser(d => seen.push(d));
    p.push('data: {"a"');
    p.push(':1}\n\ndata: 2\n');
    p.push('\n');
    assert.deepEqual(seen, ['{"a":1}', '2']);
  });

  test('channel errors become the two fetch shapes: an abort is AbortError, anything else is a network failure', () => {
    assert.equal(mapChannelError({ code: 'cancelled' }).name, 'AbortError');
    const net = mapChannelError({ code: 'offline' });
    assert.ok(net instanceof TypeError);
    assert.equal(net.message, 'Failed to fetch', 'the message the UI reads as "Cannot reach the Plenum server"');
  });

  test('readCapped stops past its cap', async () => {
    assert.deepEqual([...await readCapped(streamOf(['ab']), 5)], [97, 98]);
    await assert.rejects(readCapped(streamOf(['abcdef']), 3));
  });

  test('the phone caps follow the platform: web on a LAN page, web app, and native', () => {
    assert.ok(capsFor(fakeWindow(SURFACE)).includes('ui-from-desktop'));
    assert.ok(capsFor(fakeWindow('https://relay.example/')).includes('artifacts-iframe'));
    const native = { location: new URL('https://localhost/'), Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } };
    assert.ok(capsFor(native).includes('ui-bundled'));
  });

  test('the LAN page is found by its origin (plain http, not a secure context), not by a path: picture artifact, no Web Push', () => {
    const lan = capsFor(fakeWindow('http://192.168.1.5:40123/'));
    assert.ok(lan.includes('artifacts-picture'));
    assert.ok(lan.includes('push-none'));
    assert.ok(!lan.includes('artifacts-iframe'));
    assert.ok(!lan.includes('push-webpush'));
    assert.ok(capsFor(fakeWindow(`http://192.168.1.5:40123/p/${'b'.repeat(32)}/`)).includes('artifacts-picture'), 'the path does not matter');
    assert.ok(capsFor(fakeWindow('https://phone.tailnet.example/')).includes('push-webpush'), 'an https page keeps Web Push');
    assert.equal(isLanPage(fakeWindow('http://localhost:7300/')), false, 'localhost is a development page, not a LAN');
    const insecureFlag = { ...fakeWindow('https://phone.example/'), isSecureContext: false };
    assert.equal(isLanPage(insecureFlag), true, 'a page the browser does not treat as a secure context is a LAN page');
  });

  test('base64Of matches Buffer across the 32 KiB chunk boundary', () => {
    const bytes = new Uint8Array(70001).map((_, i) => (i * 37) & 0xff);
    assert.equal(base64Of(bytes), Buffer.from(bytes).toString('base64'));
    assert.equal(base64Of(new Uint8Array(0)), '');
  });
});

describe('boot.js: a shell core that appears after the shim, and save on native', () => {
  test('the facade handed to the one-shot slot is bound, and /api/state then goes through it; window.plenumShellCore and window.plenumNative are never read', async () => {
    const channel = fakeChannel(() => answerJson({ projects: ['a'], activeProject: 'a' }));
    const win = fakeWindow();
    const doc = fakeDocument();
    const shim = installShim({ win, doc, origFetch: async () => new Response('original') });
    await assert.rejects(shim.shimFetch('/api/state'), err => err instanceof TypeError && err.message === 'Failed to fetch', 'no core yet: not connected');
    // The old ways in are not read: a page object on window is not the shell.
    win.plenumShellCore = fakeCore(channel);
    win.plenumNative = { Haptics: { impact: () => Promise.resolve() } };
    shim.syncFromCore();
    await assert.rejects(shim.shimFetch('/api/state'), TypeError, 'window.plenumShellCore is ignored');
    assert.equal(win.plenumShell.haptic(), false, 'window.plenumNative is ignored');
    const descriptor = Object.getOwnPropertyDescriptor(win, '__plenumAttachShell');
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.configurable, true);
    assert.equal(win.__plenumAttachShell(null), false, 'nothing is not a core');
    const core = fakeCore(channel);
    assert.equal(win.__plenumAttachShell(core), true);
    assert.equal(win.__plenumAttachShell(fakeCore(channel)), false, 'one core, once');
    const res = await shim.shimFetch('/api/state', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { projects: ['a'], activeProject: 'a' });
    assert.equal(channel.calls.at(-1).req.path, '/api/state');
    assert.equal(win.plenumShell.connection().state, 'connected', 'the shell state comes from the bound core');
  });

  test('a shim given its core by the suite takes no slot', () => {
    const { win } = install();
    assert.equal('__plenumAttachShell' in win, false);
  });

  test('plugin(name) of the facade serves the native plugins; options.plugins comes first; the plain Capacitor.Plugins only for the eight names', () => {
    const win = fakeWindow('https://localhost/');
    const seen = [];
    win.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Haptics: { impact: o => { seen.push(['cap', o.style]); return Promise.resolve(); } }, SecureStorage: { id: 'no' } } };
    const channel = fakeChannel(() => answerJson({}));
    const core = fakeCore(channel);
    core.plugin = name => (name === 'Haptics' ? { impact: o => { seen.push(['facade', o.style]); return Promise.resolve(); } } : null);
    const { win: w } = install({ win, core });
    assert.equal(w.plenumShell.haptic('warn'), true);
    assert.deepEqual(seen, [['facade', 'HEAVY']], 'the facade answered');
    const second = fakeWindow('https://localhost/');
    second.Capacitor = win.Capacitor;
    install({ win: second, plugins: { Haptics: { impact: o => { seen.push(['option', o.style]); return Promise.resolve(); } } }, core: fakeCore(channel) });
    assert.equal(second.plenumShell.haptic(), true);
    assert.deepEqual(seen.at(-1), ['option', 'LIGHT'], 'options.plugins first');
    const third = fakeWindow('https://localhost/');
    third.Capacitor = win.Capacitor;
    install({ win: third, core: fakeCore(channel) });
    assert.equal(third.plenumShell.haptic(), true);
    assert.deepEqual(seen.at(-1), ['cap', 'LIGHT'], 'a bridge that only has Capacitor.Plugins');
    // SecureStorage is not one of the eight names: the shim never asks for it, and nothing in the facade list gives it out.
    assert.equal(second.plenumShell.preview.available(), false);
  });

  test('save on native writes the bytes to the cache folder and shares that file; it says false when a plugin is missing', async () => {
    const calls = [];
    const win = fakeWindow('https://localhost/');
    win.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        Filesystem: { writeFile: async opts => { calls.push(['write', opts]); return { uri: 'file:///cache/notes_1.txt' }; } },
        Share: { share: async opts => { calls.push(['share', opts]); return {}; } },
      },
    };
    const { win: w } = install({ win });
    const blob = new Blob(['hi there']);
    assert.equal(await w.plenumShell.save({ name: 'notes:1.txt', blob }), true);
    assert.deepEqual(calls[0], ['write', { path: 'notes_1.txt', data: Buffer.from('hi there').toString('base64'), directory: 'CACHE' }]);
    assert.deepEqual(calls[1], ['share', { title: 'notes_1.txt', files: ['file:///cache/notes_1.txt'] }]);

    const bare = fakeWindow('https://localhost/');
    bare.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { Filesystem: { writeFile: async () => ({ uri: 'x' }) } } };
    const { win: w2 } = install({ win: bare });
    assert.equal(await w2.plenumShell.save({ name: 'a.txt', blob }), false, 'no Share plugin: the UI is told');
    assert.equal(await w2.plenumShell.save({ name: 'a.txt' }), false, 'no blob: nothing is written');
  });
});

describe('boot.js: the request shim', () => {
  test('request("/api/state") answers the same JSON a direct fetch gives, with the response headers that matter', async () => {
    const { shim, channel } = install({ channel: fakeChannel(() => answerJson({ projects: ['a'], activeProject: 'a' })) });
    const res = await shim.shimFetch('/api/state', { headers: { 'x-plenum-token': '0'.repeat(64), accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { projects: ['a'], activeProject: 'a' });
    assert.equal(res.headers.get('x-plenum-auth'), 'token');
    assert.equal(res.headers.get('x-secret'), null);
    assert.equal(channel.calls[0].req.method, 'GET');
    assert.equal(channel.calls[0].req.path, '/api/state');
    assert.deepEqual(channel.calls[0].req.headers, { accept: 'application/json' }, 'the token never reaches the channel');
  });

  test('POST /api/compare sends its body and reads the answer as a stream, chunks in order', async () => {
    const chunks = ['one\n', 'two\n', 'three\n'];
    const channel = fakeChannel((req) => Promise.resolve({ status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: streamOf(chunks), id: 3, cancel() {} }));
    const { shim } = install({ channel });
    const res = await shim.shimFetch('/api/compare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
    assert.equal(channel.calls[0].req.method, 'POST');
    assert.equal(channel.calls[0].body, '{"prompt":"hi"}');
    const reader = res.body.getReader();
    const got = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push(dec.decode(value));
    }
    assert.deepEqual(got, chunks);
  });

  test('GET /api/events: hello arrives within 200 ms, and a drive event moves the Stop ring on and off', async () => {
    const hello = { type: 'hello', at: 1, state: { pending: { driving: null } } };
    const running = { type: 'drive', drive: { id: 'd1', kind: 'computer', label: 'Notepad', state: 'running', steps: 12, limits: { steps: 80 } } };
    const stopped = { type: 'drive', drive: { id: 'd1', kind: 'computer', label: 'Notepad', state: 'stopped', steps: 12, limits: { steps: 80 } } };
    const payload = [`data: ${JSON.stringify(hello)}\n\n`, `data: ${JSON.stringify(running)}\n\n`, `data: ${JSON.stringify(stopped)}\n\n`];
    const channel = fakeChannel(() => Promise.resolve({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: streamOf([payload[0]]), id: 9, cancel() {} }));
    const { shim, doc } = install({ channel });
    const t0 = Date.now();
    const res = await shim.shimFetch('/api/events');
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.ok(Date.now() - t0 < 200, 'hello within 200 ms');
    assert.match(dec.decode(first.value), /"type":"hello"/);
    // The rest of the stream: push the drive events through a second answer.
    channel.request = () => Promise.resolve({ status: 200, headers: {}, body: streamOf(payload.slice(1)), id: 10, cancel() {} });
    const ev = await shim.shimFetch('/api/events');
    const r2 = ev.body.getReader();
    for (let i = 0; i < 4; i += 1) {
      const { done } = await r2.read();
      if (done) break;
    }
    const stop = doc.getElementById('plenum-stop');
    assert.ok(stop, 'the Stop control is in the page');
    assert.equal(stop.attrs.has('data-driving'), false, 'the ring is off after the drive stopped');
    shim.noteDriveEvent(running);
    assert.equal(stop.attrs.has('data-driving'), true, 'the ring is on while a drive runs');
    assert.match(stop.attrs.get('aria-description'), /Notepad, step 12 of 80/);
    shim.noteDriveEvent(stopped);
    assert.equal(stop.attrs.has('data-driving'), false);
  });

  test('HELLO.pending.driving draws the ring before any drive event arrives', () => {
    const { shim, doc } = install();
    shim.setHelloDriving({ kind: 'computer', app: 'Paint', step: 3, of: 10 });
    const stop = doc.getElementById('plenum-stop');
    assert.equal(stop.attrs.has('data-driving'), true);
    assert.match(stop.attrs.get('aria-description'), /Paint, step 3 of 10/);
    shim.setHelloDriving(null);
    assert.equal(stop.attrs.has('data-driving'), false);
  });

  test('a call with no channel (not connected) fails with TypeError: the UI draws its connection line', async () => {
    const { shim } = install({ core: null });
    await assert.rejects(shim.shimFetch('/api/state'), err => err instanceof TypeError && err.message === 'Failed to fetch');
  });

  test('cross-origin fetches are refused; a /_bridge/ path answers 404 and is never sent', async () => {
    const { shim, channel } = install();
    await assert.rejects(shim.shimFetch('https://evil.example/api/state'), TypeError);
    const res = await shim.shimFetch('/_bridge/log', { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(channel.calls.length, 0);
  });

  test('static UI paths go through the channel; other same-origin paths keep the original fetch', async () => {
    const { shim, channel, originalCalls } = install({ channel: fakeChannel(() => Promise.resolve({ status: 200, headers: {}, body: streamOf(['/*js*/']), id: 1, cancel() {} })) });
    const js = await shim.shimFetch('/app.js');
    assert.equal(await js.text(), '/*js*/');
    assert.equal(channel.calls[0].req.path, '/app.js');
    await shim.shimFetch('/shell/styles.css');
    assert.deepEqual(originalCalls, ['/shell/styles.css']);
  });

  test('an abort before the answer rejects with AbortError and sends CANCEL through the channel signal', async () => {
    let seenSignal = null;
    const channel = fakeChannel((req, body, opts) => {
      seenSignal = opts.signal;
      return new Promise((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        if (opts.signal.aborted) fail();
        else opts.signal.addEventListener('abort', fail, { once: true });
      });
    });
    const { shim } = install({ channel });
    const ac = new AbortController();
    const pending = shim.shimFetch('/api/events', { signal: ac.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(seenSignal, ac.signal, 'the channel got the signal');
    ac.abort();
    await assert.rejects(pending, err => err.name === 'AbortError');
    // An abort that came before the call is refused at once, and the channel is never asked.
    const late = new AbortController();
    late.abort();
    await assert.rejects(shim.shimFetch('/api/state', { signal: late.signal }), err => err.name === 'AbortError');
  });
});

describe('boot.js and channel.js over a fake Worker: CANCEL, and parity through the real channel', () => {
  // A fake Worker: records what the page posts, and lets the test play the worker's answers.
  class FakeWorker {
    constructor() { this.sent = []; this.onmessage = null; this.onerror = null; }
    postMessage(msg) { this.sent.push(msg); }
    terminate() {}
    emit(data) { this.onmessage?.({ data }); }
  }
  const b64 = n => bytesToB64u(new Uint8Array(32).fill(n));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  test('AbortController.abort() on a shimmed fetch posts CANCEL to the worker and rejects the fetch', async () => {
    const worker = new FakeWorker();
    const channel = openChannel({
      computer: { id: 'c1', name: 'Home PC', desktopPub: b64(1), myPriv: b64(2), carriers: [], counter: 0 },
      createWorker: () => worker,
      device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '0', uiHash: '' },
      caps: ['ui-from-desktop'],
    });
    const { shim } = install({ channel });
    const ac = new AbortController();
    // Captured at once, so a rejection before the assertions below is not an unhandled one.
    const pending = shim.shimFetch('/api/compare', { method: 'POST', body: '{"x":1}', signal: ac.signal }).then(() => null, err => err);
    await tick();
    const req = worker.sent.find(m => m.op === 'request');
    assert.ok(req, 'the request reached the worker');
    assert.equal(req.path, '/api/compare');
    assert.equal(req.method, 'POST');
    ac.abort();
    await tick();
    const cancel = worker.sent.find(m => m.op === 'cancel');
    assert.ok(cancel, 'CANCEL was posted');
    assert.equal(cancel.sid, req.sid);
    const err = await pending;
    assert.equal(err?.name, 'AbortError');
    channel.close();
  });

  test('a /api/state answer from the worker reaches the page as the same JSON', async () => {
    const worker = new FakeWorker();
    const channel = openChannel({
      computer: { id: 'c1', name: 'Home PC', desktopPub: b64(1), myPriv: b64(2), carriers: [], counter: 0 },
      createWorker: () => worker,
      device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '0', uiHash: '' },
      caps: ['ui-from-desktop'],
    });
    const { shim } = install({ channel });
    const pending = shim.shimFetch('/api/state');
    await tick();
    const req = worker.sent.find(m => m.op === 'request');
    worker.emit({ op: 'res', sid: req.sid, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    worker.emit({ op: 'data', sid: req.sid, bytes: enc.encode('{"ok":true,"n":2}').buffer });
    worker.emit({ op: 'end', sid: req.sid });
    const res = await pending;
    assert.deepEqual(await res.json(), { ok: true, n: 2 });
    channel.close();
  });
});

describe('boot.js: plenumShell, the debug hooks and the shell DOM', () => {
  test('window.plenumShell has the shape the UI checks: not desktop, surface phone, a placeholder token and the caps', () => {
    const { win } = install();
    const s = win.plenumShell;
    assert.equal(s.desktop, false);
    assert.equal(s.surface, 'phone');
    assert.equal(s.token(), '0'.repeat(64));
    assert.ok(Array.isArray(s.caps) && s.caps.includes('ui-from-desktop'));
    assert.equal(s.app.version, '1.0.0');
  });

  test('stop() goes to the shell core, lock() locks it, and openExternal refuses anything but https', async () => {
    const { win, core } = install();
    const s = win.plenumShell;
    const out = await s.stop('proj');
    assert.equal(out.state, 'done');
    assert.deepEqual(core.stops, ['proj']);
    assert.equal(await s.lock(), true);
    assert.equal(core.locks, 1);
    assert.equal(await s.openExternal('http://insecure.example/'), false);
    assert.equal(await s.openExternal('https://ok.example/'), true);
    assert.equal(win.opened[0][0], 'https://ok.example/');
  });

  test('connection() maps the shell state to the four states of MOBILE-UI 9', () => {
    const { win, core } = install();
    assert.equal(win.plenumShell.connection().state, 'connected');
    core.push({ connection: { status: 'reconnecting', desktopName: 'Home PC' } });
    assert.equal(win.plenumShell.connection().state, 'reconnecting');
    core.push({ connection: { status: 'asleep', desktopName: 'Home PC', lastSeen: '14:02' } });
    assert.equal(win.plenumShell.connection().state, 'asleep');
    core.push({ connection: { status: 'offline', desktopName: 'Home PC' } });
    assert.equal(win.plenumShell.connection().state, 'offline');
  });

  test('plenumPhoneDebug exists only with ?debug=1, demo or selftest', () => {
    const on = install({ win: fakeWindow(SURFACE) });
    assert.equal(typeof on.win.plenumPhoneDebug.connection, 'function');
    const off = install({ win: fakeWindow(`http://127.0.0.1:7300/p/${'b'.repeat(32)}/`) });
    assert.equal(off.win.plenumPhoneDebug, undefined);
  });

  test('no plenumPhoneDebug when DEV_BUILD is false, whatever the address says', () => {
    for (const search of ['?debug=1', '?demo=1', '?selftest', '?a=1&debug=1&b=2', '?debug']) {
      assert.equal(debugHooksOn(search, true), true, `dev: ${search}`);
      assert.equal(debugHooksOn(search, false), false, `release: ${search}`);
    }
    for (const search of ['', '?debugger=1', '?x=demo', undefined]) assert.equal(debugHooksOn(search, true), false, String(search));
    assert.equal(debugHooksOn('?debug=1'), true, 'the Node suites run the source, which is a dev build');
  });

  test('the shell DOM is built with text only, and the strip and lock follow the shell state', () => {
    const { doc, core } = install();
    const stop = doc.getElementById('plenum-stop');
    const strip = doc.getElementById('plenum-conn-strip');
    const lock = doc.getElementById('plenum-lock');
    assert.ok(stop && strip && lock);
    assert.equal(stop.getAttribute('aria-label'), 'Stop');
    assert.equal(strip.hidden, true, 'the strip is hidden while connected');
    core.push({ connection: { status: 'offline', desktopName: 'Home PC', lastSeen: '14:02' } });
    assert.equal(strip.hidden, false);
    assert.equal(strip.getAttribute('data-state'), 'offline');
    assert.match(doc.getElementById('plenum-conn-strip').children[0].textContent, /Can't reach Home PC\./);
    core.push({ locked: true });
    assert.equal(lock.hidden, false);
    for (const el of doc.documentElement.all().concat(doc.body.all(), doc.head.all())) {
      assert.equal(el.attrs.has('style'), false, `no style attribute on ${el.tagName}`);
    }
  });

  test('the Stop control shows its state and sends a stop when pressed', async () => {
    const { doc, core } = install();
    const stop = doc.getElementById('plenum-stop');
    core.push({ stop: { state: 'sending', text: '' } });
    assert.equal(stop.attrs.get('data-state'), 'sending');
    const label = stop.children[1];
    assert.equal(label.textContent, 'Stopping…');
    stop.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.stops, [null]);
  });

  test('the lock screen offers Unlock by the method the lock uses: a biometric here, a passkey here, and a PIN on the pad of this overlay (F3)', async () => {
    const { doc, core } = install();
    core.push({ locked: true });
    const lock = doc.getElementById('plenum-lock');
    const unlock = lock.children.find(c => c.className === 'plenum-lock-unlock');
    unlock.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.unlocks, ['biometric']);
    core.push({ lock: { mode: 'passkey' } });
    assert.equal(unlock.textContent, 'Unlock with a passkey');
    unlock.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.unlocks, ['biometric', 'passkey']);
    // A PIN is typed on the pad of this overlay: the Unlock button is gone (the pad is the unlock), and nothing sends the person to the shell page.
    core.push({ lock: { mode: 'pin' } });
    assert.equal(unlock.hidden, true, 'the Unlock button is hidden in PIN mode');
    const pad = lock.children.find(c => c.className === 'sh-pad plenum-lock-pad');
    assert.equal(pad.hidden, false);
    assert.equal(pad.children.length, 12, 'twelve cells: 1 to 9, a gap, 0, Delete');
    unlock.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.unlocks, ['biometric', 'passkey'], 'no unlock method is called by the hidden button');
    assert.deepEqual(core.shellOpens, [], 'PIN mode no longer opens the shell page');
  });

  test('Unlock and stop everything is offered once a computer is paired (a lock closes the channel, so it never waits for a connection), and stops only after the unlock worked', async () => {
    const { doc, core } = install();
    const lock = doc.getElementById('plenum-lock');
    const both = lock.children.find(c => c.className === 'plenum-lock-unlock-stop');
    // The channel is gone while locked: the connection is not 'connected', and the button is still there.
    core.push({ locked: true, connection: { status: 'closed', desktopName: 'Home PC' } });
    assert.equal(both.hidden, false);
    core.unlockResult = { ok: false, reason: 'wrong' };
    both.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.stops, [], 'a failed unlock sends no Stop');
    const note = lock.children.find(c => c.className === 'plenum-lock-note');
    assert.equal(note.textContent, 'That did not unlock Plenum. Try again.');
    core.unlockResult = { ok: true };
    both.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.unlocks, ['biometric', 'biometric']);
    assert.deepEqual(core.stops, [null], 'Stop goes out after the unlock, by the same method');
    assert.equal(note.textContent, '');
  });

  test('with no computer paired the lock screen offers Unlock only', () => {
    const channel = fakeChannel(() => answerJson({}));
    const core = fakeCore(channel);
    core.snapshot.computers = [];
    core.snapshot.activeId = null;
    const { doc } = install({ core, channel });
    core.push({ locked: true });
    const both = doc.getElementById('plenum-lock').children.find(c => c.className === 'plenum-lock-unlock-stop');
    assert.equal(both.hidden, true);
  });
});

describe('boot.js: the lock screen\'s Stop without unlocking, the unknown lock, and the refused request (phone security round)', () => {
  test('with the computer\'s Stop key on this phone the button reads Stop everything and stops at once, without any unlock; without it, it is Unlock and stop everything', async () => {
    const { doc, core } = install();
    const lock = doc.getElementById('plenum-lock');
    const both = lock.children.find(c => c.className === 'plenum-lock-unlock-stop');
    core.push({ locked: true, connection: { status: 'closed', desktopName: 'Home PC' }, lockStop: { ready: false, computerName: 'Home PC' } });
    assert.equal(both.textContent, 'Unlock and stop everything');
    assert.equal(both.textContent, LOCK_STOP_UNLOCK_LABEL);
    core.push({ lockStop: { ready: true, computerName: 'Home PC' } });
    assert.equal(both.textContent, 'Stop everything');
    assert.equal(both.textContent, LOCK_STOP_READY_LABEL);
    assert.equal(both.hidden, false);
    both.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.stops, [null], 'one Stop');
    assert.deepEqual(core.unlocks, [], 'and no unlock was asked for');
    // In PIN mode too: it does not arm, it stops.
    core.push({ lock: { mode: 'pin' } });
    both.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.stops, [null, null]);
    assert.equal(both.attrs.has('aria-pressed'), false, 'a Stop that is sent is not an armed one');
    // The key goes away (the phone was removed there): the old behaviour is back.
    core.push({ lock: { mode: 'biometric' }, lockStop: { ready: false, computerName: 'Home PC' } });
    assert.equal(both.textContent, 'Unlock and stop everything');
  });

  test('the Stop result shows in the lock note while sending, queued, done or failed, and the PIN note is back after', () => {
    const { doc, core } = install();
    const lock = doc.getElementById('plenum-lock');
    const note = lock.children.find(c => c.className === 'plenum-lock-note');
    core.push({ locked: true, lockStop: { ready: true, computerName: 'Home PC' } });
    assert.equal(note.textContent, '');
    for (const state of ['sending', 'queued', 'done', 'failed']) {
      core.push({ stop: { state, text: `result ${state}`, seq: 1 } });
      assert.equal(note.textContent, `result ${state}`, state);
    }
    core.push({ stop: { state: 'idle', text: '', seq: 1 } });
    assert.equal(note.textContent, '');
    core.push({ stop: { state: 'done', text: '', seq: 2 } });
    assert.equal(note.textContent, '', 'a result with no words shows nothing');
  });

  test('when the lock settings could not be read, Unlock and the PIN pad are hidden, the note says why and Stop stays', async () => {
    const { doc, core } = install();
    const lock = doc.getElementById('plenum-lock');
    const unlock = lock.children.find(c => c.className === 'plenum-lock-unlock');
    const pad = lock.children.find(c => c.className === 'sh-pad plenum-lock-pad');
    const note = lock.children.find(c => c.className === 'plenum-lock-note');
    const both = lock.children.find(c => c.className === 'plenum-lock-unlock-stop');
    core.push({ locked: true, lock: { mode: 'unknown', locked: true }, lockStop: { ready: true, computerName: 'Home PC' } });
    assert.equal(lock.hidden, false);
    assert.equal(unlock.hidden, true);
    assert.equal(pad.hidden, true);
    assert.equal(note.textContent, 'Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.');
    assert.equal(note.textContent, LOCK_UNKNOWN_NOTE);
    assert.equal(both.hidden, false);
    assert.equal(both.textContent, 'Stop everything');
    both.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.stops, [null]);
    core.push({ stop: { state: 'done', text: 'Stopped everything on Home PC: 1 reply.', seq: 1 } });
    assert.equal(note.textContent, 'Stopped everything on Home PC: 1 reply.', 'the result wins over the lock line while it shows');
  });

  test('the worker\'s refusal reads as the same 404 a /_bridge/ path gets; offline stays a network failure', async () => {
    const refusing = fakeChannel(() => Promise.reject(Object.assign(new Error('refused'), { code: 'refused' })));
    const { shim } = install({ channel: refusing });
    const res = await shim.shimFetch('/api/state');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found.' });
    const offline = fakeChannel(() => Promise.reject(Object.assign(new Error('offline'), { code: 'offline' })));
    const second = install({ channel: offline });
    await assert.rejects(second.shim.shimFetch('/api/state'), err => err instanceof TypeError && err.message === 'Failed to fetch');
  });

  test('the shim\'s own check still refuses /_bridge/ before the worker is asked, and passes the page only the three headers', async () => {
    const { shim, channel } = install();
    assert.equal((await shim.shimFetch('/_bridge/log', { method: 'POST' })).status, 404);
    assert.equal(channel.calls.length, 0);
    await shim.shimFetch('/api/state', { headers: { 'x-plenum-notify-line': 'Run: x', accept: 'a', 'x-evil': '1' } });
    assert.deepEqual(channel.calls[0].req.headers, { accept: 'a' });
  });

  test('debug(line) goes to the shell\'s log (it redacts and posts); with no shell it does nothing', () => {
    const { win, core } = install();
    win.plenumShell.debug('phone: hello');
    win.plenumShell.debug(undefined);
    assert.deepEqual(core.logs, ['phone: hello', '']);
    const bare = install({ core: null });
    assert.doesNotThrow(() => bare.win.plenumShell.debug('nobody is listening'));
  });

  test('a worker request for the artifact view while the phone is offline is answered 503, and a failure that is not offline 502', async () => {
    const answers = [];
    for (const code of ['offline', 'lost']) {
      const channel = fakeChannel(() => Promise.reject(Object.assign(new Error(code), { code })));
      const listeners = [];
      const win = fakeWindow();
      win.navigator = { serviceWorker: { addEventListener: (type, fn) => listeners.push(fn) } };
      install({ win, channel });
      const port = new MessageChannel();
      const reply = new Promise(resolve => { port.port1.onmessage = e => resolve(e.data); });
      listeners[0]({ data: { op: 'plenum-fetch', path: `${ARTIFACT_VIEW}?id=abc` }, ports: [port.port2] });
      answers.push((await reply).status);
      port.port1.close();
    }
    assert.deepEqual(answers, [503, 502]);
  });
});

// ----- the PIN pad on the lock overlay (F3, MOBILE-UI 6.13 and C22) -----

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The overlay's parts by their class, as the design note orders them.
function lockParts(doc) {
  const lock = doc.getElementById('plenum-lock');
  const byClass = name => lock.children.find(c => c.className === name);
  const pad = byClass('sh-pad plenum-lock-pad');
  return {
    lock,
    dots: byClass('sh-dots plenum-lock-dots'),
    count: byClass('sh-sr'),
    note: byClass('plenum-lock-note'),
    pad,
    unlock: byClass('plenum-lock-unlock'),
    stop: byClass('plenum-lock-unlock-stop'),
    keys: pad.children.filter(c => c.tagName === 'BUTTON'),
    key: label => pad.children.find(c => c.tagName === 'BUTTON' && c.textContent === label),
  };
}

// A core that publishes the unlock before it answers, as app.js does (the lock goes away inside unlock(), then the promise resolves).
function publishingCore(core) {
  core.unlock = async (method, arg = null) => {
    core.unlocks.push(method);
    core.unlockArgs.push(arg);
    const out = core.unlockResult;
    if (out.ok) core.push({ locked: false });
    return out;
  };
  return core;
}

async function typePin(parts, digits) {
  for (const digit of digits) parts.key(digit).click();
  await tick();
}

// Everything an overlay element says: tag, class, every attribute and its own text. Used to prove the digits are not in there.
function overlayFacts(doc) {
  return doc.getElementById('plenum-lock').all().map(el => ({
    tag: el.tagName,
    cls: el.className,
    attrs: [...el.attrs.entries()].sort(),
    text: el.textContent,
  }));
}

describe('boot.js: the PIN pad on the lock overlay (F3)', () => {
  test('in PIN mode the overlay is the title, the drive line, six dots, the count, the note, a 12-cell pad and Unlock and stop everything, in that order', () => {
    const { doc, core } = install();
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    assert.deepEqual(p.lock.children.map(c => c.className), [
      'plenum-lock-title', 'plenum-lock-line', 'sh-dots plenum-lock-dots', 'sh-sr', 'plenum-lock-note', 'sh-pad plenum-lock-pad', 'plenum-lock-unlock', 'plenum-lock-unlock-stop',
    ]);
    assert.equal(p.lock.children[0].tagName, 'H2');
    assert.equal(p.lock.children[0].textContent, 'Plenum is locked');
    assert.equal(p.dots.getAttribute('aria-hidden'), 'true');
    assert.equal(p.dots.children.length, 6);
    assert.ok(p.dots.children.every(d => d.tagName === 'SPAN' && d.className === 'sh-dot' && !d.attrs.has('data-on')));
    assert.equal(p.count.tagName, 'SPAN');
    assert.equal(p.count.getAttribute('aria-live'), 'polite');
    assert.equal(p.count.textContent, '0 of 6 digits entered');
    assert.equal(p.note.getAttribute('role'), 'alert');
    assert.equal(p.pad.tagName, 'DIV');
    assert.equal(p.pad.getAttribute('role'), 'group');
    assert.equal(p.pad.getAttribute('aria-label'), 'PIN');
    assert.equal(p.pad.children.length, 12);
    assert.deepEqual(p.pad.children.map(c => (c.tagName === 'SPAN' ? '' : c.textContent)), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'Delete']);
    const gap = p.pad.children[9];
    assert.equal(gap.className, 'sh-key-gap');
    assert.equal(gap.getAttribute('aria-hidden'), 'true');
    assert.equal(p.keys.length, 11);
    for (const key of p.keys) {
      assert.equal(key.getAttribute('type'), 'button');
      assert.equal(key.getAttribute('aria-label'), key.textContent);
      assert.equal(key.className, key.textContent === 'Delete' ? 'sh-key sh-key-del' : 'sh-key');
      assert.equal(key.hidden, false);
      assert.equal(key.disabled, false);
    }
    assert.equal(p.unlock.hidden, true, 'the pad is the unlock');
    assert.equal(p.stop.textContent, 'Unlock and stop everything');
    assert.equal(p.stop.hidden, false);
    assert.equal(p.stop.getAttribute('aria-pressed'), null);
    assert.equal(p.note.textContent, '');
    assert.deepEqual(core.shellOpens, [], 'PIN mode does not open the shell page');
  });

  test('the pad, the dots and the count show only while the lock is a PIN; a biometric and a passkey keep the one Unlock button', () => {
    const { doc, core } = install();
    core.push({ locked: true });
    const p = lockParts(doc);
    for (const mode of ['biometric', 'passkey', 'off']) {
      core.push({ lock: { mode } });
      assert.equal(p.pad.hidden, true, `no pad for ${mode}`);
      assert.equal(p.dots.hidden, true);
      assert.equal(p.count.hidden, true);
      assert.equal(p.unlock.hidden, false);
    }
    core.push({ lock: { mode: 'pin' } });
    assert.equal(p.pad.hidden, false);
    assert.equal(p.dots.hidden, false);
    assert.equal(p.count.hidden, false);
    assert.equal(p.unlock.hidden, true);
  });

  test('a digit fills a dot (six at most) and Delete takes the last one back', async () => {
    const { doc, core } = install();
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    const on = () => p.dots.children.filter(d => d.attrs.has('data-on')).length;
    p.key('1').click();
    p.key('2').click();
    p.key('3').click();
    assert.equal(on(), 3);
    assert.deepEqual(p.dots.children.map(d => d.attrs.has('data-on')), [true, true, true, false, false, false], 'the first n dots are on');
    assert.equal(p.count.textContent, '3 of 6 digits entered');
    p.key('Delete').click();
    assert.equal(on(), 2);
    assert.equal(p.count.textContent, '2 of 6 digits entered');
    p.key('Delete').click();
    p.key('Delete').click();
    p.key('Delete').click();
    assert.equal(on(), 0, 'Delete on an empty entry does nothing');
    assert.equal(p.count.textContent, '0 of 6 digits entered');
    await tick();
    assert.deepEqual(core.unlocks, [], 'fewer than six digits never unlock anything');
  });

  test('the sixth digit clears the digits and dots at once, marks the pad busy with every key disabled, calls unlock("pin", digits) once, then re-enables', async () => {
    const { doc, core } = install();
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    let release;
    core.unlock = (method, arg) => {
      core.unlocks.push(method);
      core.unlockArgs.push(arg);
      return new Promise(resolve => { release = resolve; });
    };
    for (const d of '12345') p.key(d).click();
    p.key('6').click();
    assert.deepEqual(core.unlocks, ['pin']);
    assert.deepEqual(core.unlockArgs, ['123456']);
    assert.equal(p.dots.children.filter(d => d.attrs.has('data-on')).length, 0, 'the dots are cleared at once');
    assert.equal(p.count.textContent, '0 of 6 digits entered');
    assert.equal(p.pad.getAttribute('aria-busy'), 'true');
    assert.ok(p.keys.every(k => k.disabled === true), 'every key is disabled while the PIN is checked');
    // A key pressed meanwhile is ignored (a disabled button gets no click in a page; the shim also refuses one that arrives).
    p.key('7').click();
    p.key('Delete').click();
    assert.equal(p.count.textContent, '0 of 6 digits entered');
    assert.deepEqual(core.unlocks, ['pin']);
    release({ ok: false, reason: 'wrong', waitSec: 0 });
    await tick();
    assert.equal(p.pad.getAttribute('aria-busy'), null);
    assert.ok(p.keys.every(k => k.disabled === false), 'the keys are back');
    assert.equal(p.note.textContent, 'Wrong PIN.');
    // The next PIN starts from nothing: the old digits are gone.
    core.unlock = async (method, arg) => {
      core.unlocks.push(method);
      core.unlockArgs.push(arg);
      return { ok: false, reason: 'wrong', waitSec: 0 };
    };
    await typePin(p, '654321');
    assert.deepEqual(core.unlockArgs, ['123456', '654321']);
  });

  test('every answer has its own words, and a PIN that did not unlock never unlocks and sends no Stop', async () => {
    const cases = [
      [{ ok: false, reason: 'wrong', waitSec: 30 }, 'Wrong PIN. Try again in 30 seconds.'],
      [{ ok: false, reason: 'wrong', waitSec: 0 }, 'Wrong PIN.'],
      [{ ok: false, reason: 'wrong' }, 'Wrong PIN.'],
      [{ ok: false, reason: 'wait', waitSec: 12 }, 'Try again in 12 seconds.'],
      [{ ok: false, reason: 'format' }, LOCK_TRY_AGAIN],
      [{ ok: false, reason: 'mode' }, LOCK_TRY_AGAIN],
      [{ ok: false, reason: 'unavailable' }, LOCK_TRY_AGAIN],
    ];
    for (const [result, words] of cases) {
      const { doc, core } = install();
      core.push({ locked: true, lock: { mode: 'pin' } });
      const p = lockParts(doc);
      p.stop.click();
      core.unlockResult = result;
      await typePin(p, '246810');
      assert.equal(p.note.textContent, words, `${result.reason} ${result.waitSec ?? ''}`);
      assert.equal(p.lock.hidden, false, 'a wrong PIN leaves the lock on');
      assert.deepEqual(core.stops, [], 'a PIN that did not unlock sends no Stop');
      assert.equal(p.count.textContent, '0 of 6 digits entered');
    }
    // A core that throws is the same as one that could not unlock, and the error text (which might carry anything) is not shown.
    const { doc, core } = install();
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    core.unlock = async () => { throw new Error('pin 135790 exploded'); };
    await typePin(p, '135790');
    assert.equal(p.note.textContent, LOCK_TRY_AGAIN);
    assert.ok(p.keys.every(k => k.disabled === false));
    assert.deepEqual(core.stops, []);
  });

  test('a PIN that works clears the note; without the armed Stop nothing is stopped', async () => {
    const { doc, core } = install();
    publishingCore(core);
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    core.unlockResult = { ok: false, reason: 'wrong', waitSec: 0 };
    await typePin(p, '111111');
    assert.equal(p.note.textContent, 'Wrong PIN.');
    core.unlockResult = { ok: true, reason: null, waitSec: 0, failures: 0 };
    await typePin(p, '222222');
    assert.deepEqual(core.unlockArgs, ['111111', '222222']);
    assert.equal(p.lock.hidden, true);
    assert.equal(p.note.textContent, '');
    assert.deepEqual(core.stops, []);
  });

  test('Unlock and stop everything in PIN mode does not unlock: it arms the Stop, says so, and shows as pressed', async () => {
    const { doc, core } = install();
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    p.stop.click();
    await tick();
    assert.deepEqual(core.unlocks, [], 'arming is not an unlock');
    assert.deepEqual(core.stops, []);
    assert.equal(p.note.textContent, 'Enter your PIN. Plenum stops everything once it unlocks.');
    assert.equal(p.note.textContent, LOCK_STOP_ARMED_NOTE);
    assert.equal(p.stop.getAttribute('aria-pressed'), 'true');
    assert.equal(p.lock.hidden, false);
    p.stop.click();
    assert.equal(p.stop.getAttribute('aria-pressed'), 'true', 'pressing it again keeps it armed');
    assert.deepEqual(core.shellOpens, []);
  });

  test('armed and the PIN works: exactly one Stop goes out after the unlock, with the overlay already gone so the Stop result is not under it', async () => {
    const { doc, core } = install();
    publishingCore(core);
    core.stop = async (project = null) => {
      core.stops.push(project);
      core.push({ stop: { state: 'done', text: 'Stopped', seq: 1 }, notice: { seq: 1, text: 'Stopped everything.', tone: 'ok' } });
      return { state: 'done', text: 'Stopped' };
    };
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    p.stop.click();
    core.unlockResult = { ok: true, reason: null, waitSec: 0, failures: 0 };
    await typePin(p, '482915');
    assert.deepEqual(core.unlocks, ['pin']);
    assert.deepEqual(core.unlockArgs, ['482915']);
    assert.deepEqual(core.stops, [null], 'one Stop, after the unlock');
    assert.equal(p.lock.hidden, true, 'the lock overlay is gone');
    const toast = doc.getElementById('plenum-toast');
    assert.equal(toast.hidden, false, 'the Stop result shows');
    assert.equal(toast.children[0].textContent, 'Stopped everything.');
    assert.equal(p.stop.getAttribute('aria-pressed'), null, 'disarmed');
    assert.equal(p.note.textContent, '');
    // The Stop belongs to that one unlock: the next lock starts disarmed, and a PIN that works then stops nothing.
    core.push({ stop: { state: 'idle', text: '', seq: 1 } }); // the shell resets a finished Stop after 1.6 s
    core.push({ locked: true });
    assert.equal(p.stop.getAttribute('aria-pressed'), null);
    assert.equal(p.note.textContent, '');
    await typePin(p, '482915');
    assert.deepEqual(core.stops, [null], 'still the one Stop');
  });

  test('armed, a wrong PIN stays armed and stops nothing; the PIN that works then sends exactly one Stop', async () => {
    const { doc, core } = install();
    publishingCore(core);
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    p.stop.click();
    core.unlockResult = { ok: false, reason: 'wrong', waitSec: 5 };
    await typePin(p, '000000');
    assert.equal(p.note.textContent, 'Wrong PIN. Try again in 5 seconds.');
    assert.equal(p.stop.getAttribute('aria-pressed'), 'true', 'still armed');
    assert.deepEqual(core.stops, []);
    core.unlockResult = { ok: false, reason: 'wait', waitSec: 3 };
    await typePin(p, '000000');
    assert.deepEqual(core.stops, []);
    core.unlockResult = { ok: true };
    await typePin(p, '123123');
    assert.deepEqual(core.stops, [null]);
  });

  test('a Stop armed while the PIN is being checked still goes out once, when that PIN unlocks', async () => {
    const { doc, core } = install();
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    let release;
    core.unlock = (method, arg) => {
      core.unlocks.push(method);
      core.unlockArgs.push(arg);
      return new Promise(resolve => {
        release = () => {
          core.push({ locked: false });
          resolve({ ok: true });
        };
      });
    };
    for (const d of '908172') p.key(d).click();
    p.stop.click();
    release();
    await tick();
    assert.deepEqual(core.stops, [null]);
  });

  test('the Stop is disarmed, and the digits and note cleared, when the overlay hides or the lock leaves PIN mode', async () => {
    const { doc, core } = install();
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    p.key('1').click();
    p.key('2').click();
    p.stop.click();
    assert.equal(p.count.textContent, '2 of 6 digits entered');
    // The overlay hides (for any reason other than this pad's own PIN) and comes back.
    core.push({ locked: false });
    core.push({ locked: true });
    assert.equal(p.stop.getAttribute('aria-pressed'), null);
    assert.equal(p.note.textContent, '');
    assert.equal(p.count.textContent, '0 of 6 digits entered');
    // The lock changes to a biometric: the pad goes, and what it held with it.
    p.key('3').click();
    p.stop.click();
    core.push({ lock: { mode: 'biometric' } });
    assert.equal(p.pad.hidden, true);
    assert.equal(p.unlock.hidden, false);
    assert.equal(p.stop.getAttribute('aria-pressed'), null);
    assert.equal(p.note.textContent, '');
    core.push({ lock: { mode: 'pin' } });
    assert.equal(p.count.textContent, '0 of 6 digits entered');
    assert.deepEqual(core.stops, []);
    await typePin(p, '777777');
    assert.deepEqual(core.stops, [], 'nothing armed any more');
  });

  test('a biometric still unlocks and stops the way it did, and its note survives a repaint', async () => {
    const { doc, core } = install();
    core.push({ locked: true });
    const p = lockParts(doc);
    core.unlockResult = { ok: false, reason: 'wrong' };
    p.stop.click();
    await tick();
    assert.equal(p.note.textContent, LOCK_TRY_AGAIN);
    core.push({ connection: { status: 'closed', desktopName: 'Home PC' } });
    assert.equal(p.note.textContent, LOCK_TRY_AGAIN, 'a repaint does not wipe the note while the overlay is up');
    assert.deepEqual(core.stops, []);
    assert.equal(p.stop.getAttribute('aria-pressed'), null, 'not a toggle outside PIN mode');
  });

  test('no digit is kept in the overlay: not in text, not in an attribute, not in a log or a request; only the dots and the count move', async () => {
    const logs = [];
    const { doc, core, channel } = install({ opts: { log: line => logs.push(line) } });
    core.push({ locked: true, lock: { mode: 'pin' } });
    const p = lockParts(doc);
    const before = overlayFacts(doc);
    for (const d of '97531') p.key(d).click();
    const during = overlayFacts(doc);
    assert.equal(before.length, during.length);
    const changed = [];
    before.forEach((fact, i) => {
      if (JSON.stringify(fact) !== JSON.stringify(during[i])) changed.push(fact.cls);
    });
    assert.deepEqual([...new Set(changed)].sort(), ['sh-dot', 'sh-sr'], 'only the dots (data-on) and the count change while typing');
    const PIN = '975310';
    core.unlockResult = { ok: false, reason: 'wrong', waitSec: 0 };
    p.key('0').click();
    await tick();
    const every = [];
    for (const el of [doc.documentElement, doc.head, doc.body].flatMap(e => e.all())) {
      every.push(el.textContent, ...[...el.attrs.values()]);
    }
    for (const text of every) {
      assert.ok(!text.includes(PIN) && !/\d{6}/.test(text), `no PIN digits in "${text}"`);
    }
    for (const fact of overlayFacts(doc)) {
      if (fact.cls.startsWith('sh-key')) continue;   // a key is named for its own digit, and for nothing typed
      assert.ok(!/\d{2,}/.test(fact.text), 'no run of digits in the text');
      for (const [, value] of fact.attrs) assert.ok(!/\d{2,}/.test(value), 'no run of digits in an attribute');
    }
    assert.deepEqual(logs, []);
    assert.ok(!JSON.stringify(channel.calls).includes(PIN));
    assert.deepEqual(core.unlockArgs, [PIN], 'the digits went to the shell core and nowhere else');
  });

  test('the overlay is styled by the stylesheet alone: the pad rules, a scrolling overlay, and tokens only', () => {
    const css = readFileSync(new URL('../shell/styles.css', import.meta.url), 'utf8');
    const rule = selector => {
      const at = css.indexOf(`${selector} {`);
      assert.ok(at >= 0, `rule for ${selector}`);
      return css.slice(at, css.indexOf('}', at));
    };
    const overlay = rule('#plenum-lock');
    assert.match(overlay, /overflow-y:\s*auto/);
    assert.match(overlay, /justify-content:\s*safe center/);
    const key = rule('#plenum-lock .plenum-lock-pad button');
    for (const decl of ['min-width: 0', 'min-height: 0', 'width: 72px', 'height: 56px', 'padding: 0', 'border-radius: 12px', 'border: 1px solid var(--line-2)', 'background: var(--surface-2)', 'color: var(--text)', 'font: 600 24px/1 var(--display)']) {
      assert.ok(key.includes(decl), decl);
    }
    assert.ok(rule('#plenum-lock .plenum-lock-pad .sh-key-del').includes('font: 600 15px/1 var(--ui)'));
    assert.ok(rule('#plenum-lock .plenum-lock-pad[aria-busy="true"]').includes('opacity: 0.6'));
    assert.match(css, /@media \(max-width: 359px\) \{\s*#plenum-lock \.plenum-lock-pad button \{\s*width: 64px;/);
    assert.match(css, /#plenum-lock \[hidden\]/, 'a hidden dot row or pad is not shown by their own display rules');
    for (const name of ['.sh-dots', '.sh-dot', '.sh-pad', '.sh-key-gap', '.sh-sr']) assert.ok(css.includes(`${name} {`), `${name} is styled in this file`);
    assert.ok(css.includes('.sh-key,'), '.sh-key is styled in this file');
    for (const piece of [overlay, key]) assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|light-dark\(/.test(piece), 'tokens only');
  });
});

describe('boot.js: the phone layer\'s contract with the shell (M9, F4, L15, M6, H7, F2)', () => {
  test('M9: the phone\'s own id and tier come from HELLO, and stay while the computer is away; a tier event moves the tier', async () => {
    const { win, core } = install();
    assert.equal(win.plenumShell.device.id, '');
    assert.equal(win.plenumShell.connection().tier, null, 'nothing is known before the first HELLO');
    core.push({ hello: { deviceId: 'dev-1234', tier: 'read', desktopName: 'Home PC', pending: {} } });
    assert.equal(win.plenumShell.device.id, 'dev-1234', 'ext-remote can tell which row is this phone');
    assert.equal(win.plenumShell.connection().tier, 'read');
    core.push({ hello: null, connection: { status: 'reconnecting', desktopName: 'Home PC' } });
    assert.equal(win.plenumShell.device.id, 'dev-1234');
    assert.equal(win.plenumShell.connection().tier, 'read', 'the same phone while the computer is away');
    // A tier change the computer publishes arrives on the events stream the page reads.
    core.push({ hello: { deviceId: 'dev-1234', tier: 'read', desktopName: 'Home PC', pending: {} }, connection: { status: 'connected', desktopName: 'Home PC' } });
    const events = fakeChannel(() => Promise.resolve({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: streamOf([`data: ${JSON.stringify({ type: 'phone', kind: 'tier', id: 'other', tier: 'full' })}\n\n`, `data: ${JSON.stringify({ type: 'phone', kind: 'tier', id: 'dev-1234', tier: 'approve' })}\n\n`]),
      id: 1,
      cancel() {},
    }));
    const inst = install({ channel: events });
    inst.core.push({ hello: { deviceId: 'dev-1234', tier: 'read', desktopName: 'Home PC', pending: {} } });
    const res = await inst.shim.shimFetch('/api/events');
    await res.text();
    assert.equal(inst.win.plenumShell.connection().tier, 'approve', 'a tier event for this phone is followed; one for another phone is not');
  });

  test('M9: app.js and boot.js report the same capabilities for the same page, on a LAN page and on an https page', () => {
    const pages = [
      { location: new URL('http://192.168.1.5:40123/'), isSecureContext: false },
      { location: new URL(`http://192.168.1.5:40123/p/${'c'.repeat(32)}/`), isSecureContext: false },
      { location: new URL('https://relay.example/'), isSecureContext: true },
      { location: new URL('http://127.0.0.1:7300/'), isSecureContext: true },
    ];
    for (const env of pages) {
      assert.deepEqual(deviceFor(env).caps, capsFor(env), env.location.href);
    }
    const lan = deviceFor(pages[0]);
    assert.equal(lan.device.app, 'lan-web');
    assert.ok(lan.caps.includes('artifacts-picture') && lan.caps.includes('push-none'));
    assert.equal(deviceFor(pages[2]).device.app, 'pwa');
    assert.ok(deviceFor(pages[2]).caps.includes('push-webpush'));
  });

  test('F4: lock() resolves false when no lock is set, and connection() tells the phone layer the lock mode', async () => {
    const { win, core } = install();
    assert.equal(win.plenumShell.connection().lockMode, 'biometric');
    core.push({ lock: { mode: 'off' } });
    assert.equal(win.plenumShell.connection().lockMode, 'off', 'the "Lock now" row is hidden then');
    assert.equal(await win.plenumShell.lock(), false);
    assert.equal(core.snapshot.locked, false, 'nothing locked');
    core.push({ lock: { mode: 'pin' } });
    assert.equal(await win.plenumShell.lock(), true);
    assert.equal(core.snapshot.locked, true);
  });

  test('F4/H3: openSettings() with no section, switchComputer() and retry() go to the shell page or the shell core; a section name is the desktop UI\'s settings', async () => {
    const { win, core } = install();
    const asked = [];
    win.MuseUI = { openSettings: section => asked.push(section) };
    assert.equal(await win.plenumShell.openSettings(), true);
    assert.equal(await win.plenumShell.openSettings('phones'), true);
    assert.equal(await win.plenumShell.switchComputer(), true);
    assert.deepEqual(core.shellOpens, ['#settings', '#computers']);
    assert.deepEqual(asked, ['phones']);
    const connects = [];
    core.connect = async id => { connects.push(id); return { ok: true }; };
    core.state = () => core.snapshot;
    assert.equal(await win.plenumShell.retry(), true);
    assert.deepEqual(connects, ['a']);
  });

  test('L16: computers() lists the paired computers with the one in use marked, connectComputer() connects a paired one only, and contactEmail is a string', async () => {
    const { win, core } = install();
    core.state = () => ({ ...core.snapshot, activeId: 'b', computers: [{ id: 'a', name: 'Desk', key: 'secret' }, { id: 'b', name: 'Laptop' }, { nope: true }] });
    assert.deepEqual(win.plenumShell.computers(), [{ id: 'a', name: 'Desk', active: false }, { id: 'b', name: 'Laptop', active: true }], 'a copy of id, name and active only: no key');
    const connects = [];
    core.connect = async id => { connects.push(id); return { ok: true }; };
    assert.equal(await win.plenumShell.connectComputer('a'), true);
    assert.equal(await win.plenumShell.connectComputer('zzz'), false, 'an id that is not paired is refused and not sent');
    assert.equal(await win.plenumShell.connectComputer({ id: 'a' }), false);
    assert.deepEqual(connects, ['a']);
    core.connect = async () => ({ ok: false, status: 'revoked' });
    assert.equal(await win.plenumShell.connectComputer('b'), false);
    assert.equal(typeof win.plenumShell.contactEmail, 'string');
  });

  test('L15: the theme listeners hear the system changing between light and dark, and the phone\'s own Theme setting', () => {
    const changes = [];
    let dark = false;
    const queries = [];
    const win = fakeWindow();
    win.matchMedia = query => {
      const mq = { query, get matches() { return dark; }, addEventListener: (type, fn) => queries.push(fn) };
      return mq;
    };
    const { core } = install({ win });
    const off = win.plenumShell.onTheme(t => changes.push(t));
    assert.equal(win.plenumShell.theme(), 'light');
    dark = true;
    for (const fn of queries) fn({ matches: true });
    assert.deepEqual(changes, ['dark']);
    assert.equal(win.plenumShell.theme(), 'dark');
    core.push({ prefs: { theme: 'light' } });
    assert.deepEqual(changes, ['dark', 'light'], 'a chosen theme wins over the system');
    core.push({ prefs: { theme: 'follow' } });
    assert.deepEqual(changes, ['dark', 'light', 'dark']);
    off();
    for (const fn of queries) fn({ matches: false });
    assert.equal(changes.length, 3, 'a removed listener hears nothing');
  });

  test('L15: on a native app the platform text size is read at the start and again when the app returns, and the listeners hear a change', async () => {
    let preferred = 1.3;
    const resumes = [];
    const win = fakeWindow('https://localhost/');
    win.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} };
    const plugins = {
      TextZoom: { getPreferred: async () => ({ value: preferred }) },
      App: { addListener: (event, fn) => { resumes.push([event, fn]); return Promise.resolve({ remove() {} }); } },
    };
    const doc = fakeDocument();
    const { shim } = install({ win, doc, plugins });
    void shim;
    const heard = [];
    win.plenumShell.onTextZoom(f => heard.push(f));
    for (let i = 0; i < 20 && win.plenumShell.textZoom() === 1; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(win.plenumShell.textZoom(), 1.3);
    assert.deepEqual(heard, [1.3]);
    preferred = 2;
    resumes.find(r => r[0] === 'resume')[1]();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(win.plenumShell.textZoom(), 2, 'the app came back to the front');
    preferred = 1.5;
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(win.plenumShell.textZoom(), 1.5);
    assert.deepEqual(heard, [1.3, 2, 1.5]);
  });

  test('M6: hardware Back goes to the listeners first (one that returns true took it), then back in the page\'s history, and from the first screen the app is minimised', async () => {
    const handlers = [];
    const history = [];
    const win = fakeWindow('https://localhost/');
    win.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
    win.history = { back: () => history.push('back') };
    const plugins = { App: { addListener: (event, fn) => { handlers.push([event, fn]); return Promise.resolve({ remove() {} }); }, minimizeApp: () => history.push('minimize'), exitApp: () => history.push('exit') } };
    install({ win, plugins });
    const seen = [];
    let take = true;
    const off = win.plenumShell.onBack(() => { seen.push('listener'); return take; });
    for (let i = 0; i < 20 && !handlers.some(h => h[0] === 'backButton'); i++) await new Promise(r => setTimeout(r, 5));
    const back = handlers.find(h => h[0] === 'backButton')[1];
    back({ canGoBack: true });
    assert.deepEqual(seen, ['listener']);
    assert.deepEqual(history, [], 'the listener took it: neither history nor exit');
    take = false;
    back({ canGoBack: true });
    assert.deepEqual(history, ['back'], 'not taken, and the page can go back: the page goes back (its popstate is the phone layer\'s)');
    back({ canGoBack: false });
    assert.deepEqual(history, ['back', 'minimize'], 'at the first screen the app is minimised');
    off();
    back({ canGoBack: false });
    assert.deepEqual(seen.length, 3, 'a removed listener is not called');
    assert.equal(handlers.filter(h => h[0] === 'backButton').length, 1, 'one native listener, however many onBack calls');
  });

  test('H7: a route a notification named reaches onRoute and the plenum:route event once, and takeRoute() hands the one nobody heard', () => {
    const win = fakeWindow();
    const dispatched = [];
    win.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    win.dispatchEvent = event => { dispatched.push(event); return true; };
    const taken = [];
    const { core } = install({ win });
    core.takeRoute = () => { taken.push(true); return null; };
    // Nobody listens yet: the route waits for takeRoute().
    core.push({ intent: { kind: 'waiting', id: 'ap1', seq: 1, taken: false } });
    assert.equal(dispatched.length, 1, 'the DOM event goes out');
    assert.deepEqual(dispatched[0].detail, { kind: 'waiting', id: 'ap1', seq: 1 });
    assert.deepEqual(taken, [], 'no listener heard it, so it stays for takeRoute()');
    const heard = [];
    win.plenumShell.onRoute(link => heard.push(link));
    core.push({ intent: { kind: 'settings', section: 'limit', seq: 2, taken: false } });
    assert.deepEqual(heard, [{ kind: 'settings', section: 'limit', seq: 2 }]);
    assert.deepEqual(taken, [true], 'a listener heard it: it is not offered again');
    core.push({ intent: { kind: 'settings', section: 'limit', seq: 2, taken: true } });
    assert.equal(heard.length, 1, 'the same route is not announced twice');
  });

  test('F2: the Stop result is on screen where the person looks: a toast for done and queued, a sheet with Try again for a failure', async () => {
    const { doc, core } = install();
    const toast = doc.getElementById('plenum-toast');
    const sheet = doc.getElementById('plenum-stop-sheet');
    assert.equal(toast.hidden, true);
    assert.equal(sheet.hidden, true);
    assert.equal(toast.getAttribute('role'), 'status');
    assert.equal(sheet.getAttribute('role'), 'alertdialog');
    // Done: the toast shows the words of the result, not only the clipped note inside the button.
    core.push({ stop: { state: 'done', text: 'Stopped everything on Home PC: 2 replies.', seq: 1 }, notice: { seq: 1, text: 'Stopped everything on Home PC: 2 replies.', tone: 'ok' } });
    assert.equal(toast.hidden, false);
    assert.equal(toast.children[0].textContent, 'Stopped everything on Home PC: 2 replies.');
    assert.equal(toast.getAttribute('data-tone'), 'ok');
    const stop = doc.getElementById('plenum-stop');
    assert.equal(stop.children.find(c => c.className === 'plenum-stop-note').getAttribute('aria-hidden'), 'true', 'the live text is not in the button any more');
    // Close hides it.
    toast.children[1].click();
    assert.equal(toast.hidden, true);
    // Queued keeps its toast while the Stop waits for the computer.
    core.push({ stop: { state: 'queued', text: 'Stop will be sent when the computer is reachable. Trying for 60 seconds.', seq: 2 }, notice: { seq: 2, text: 'Stop will be sent when the computer is reachable. Trying for 60 seconds.', tone: 'warn' } });
    assert.equal(toast.hidden, false);
    assert.equal(toast.getAttribute('data-tone'), 'warn');
    // Failed: the sheet, with the words that name the way out, Try again and Close.
    core.push({ stop: { state: 'failed', text: '', seq: 3 } });
    assert.equal(sheet.hidden, false);
    const body = sheet.children.find(c => c.className === 'plenum-stop-sheet-body');
    assert.match(body.textContent, /press Stop on the bar or Ctrl\+Alt\+Esc/);
    const actions = sheet.children.find(c => c.className === 'plenum-stop-sheet-actions');
    actions.children[0].click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.stops, [null], 'Try again sends the Stop again');
    actions.children[1].click();
    assert.equal(sheet.hidden, true, 'Close dismisses it');
    core.push({ stop: { state: 'failed', text: '', seq: 4 } });
    assert.equal(sheet.hidden, false, 'the next failure shows it again');
  });

  test('F2: the Stop button describes what is running by its description, not by clipped text', () => {
    const { doc, core } = install();
    const stop = doc.getElementById('plenum-stop');
    core.state = () => ({ hello: { pending: { runs: 2 } } });
    core.push({ hello: { pending: { runs: 2, driving: null }, deviceId: 'd', tier: 'full' } });
    assert.equal(stop.getAttribute('aria-description'), '2 runs are going');
    core.push({ hello: { pending: { runs: 2, driving: { app: 'Notepad', step: 4, of: 80 } }, deviceId: 'd', tier: 'full' } });
    assert.match(stop.getAttribute('aria-description'), /A model is driving: Notepad, step 4 of 80/);
  });
});

describe('boot.js: the artifact iframe answered for the service worker', () => {
  test('a worker request for the artifact view is answered with the body, the CSP and the status', async () => {
    const seen = [];
    const channel = fakeChannel((req) => {
      seen.push(req.path);
      return Promise.resolve({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'" }, body: streamOf(['<p>art</p>']), id: 4, cancel() {} });
    });
    const listeners = [];
    const win = fakeWindow();
    win.navigator = { serviceWorker: { addEventListener: (type, fn) => listeners.push(fn) } };
    install({ win, channel });
    const port = new MessageChannel();
    const reply = new Promise(resolve => { port.port1.onmessage = e => resolve(e.data); });
    listeners[0]({ data: { op: 'plenum-fetch', path: `${ARTIFACT_VIEW}?id=abc` }, ports: [port.port2] });
    const msg = await reply;
    port.port1.close();
    assert.equal(msg.status, 200);
    assert.equal(msg.headers['content-security-policy'], "default-src 'none'");
    assert.equal(dec.decode(new Uint8Array(msg.body)), '<p>art</p>');
    assert.deepEqual(seen, [`${ARTIFACT_VIEW}?id=abc`]);
  });

  test('a worker request for any other path is refused with 404 and never sent', async () => {
    const channel = fakeChannel(() => { throw new Error('must not be called'); });
    const listeners = [];
    const win = fakeWindow();
    win.navigator = { serviceWorker: { addEventListener: (type, fn) => listeners.push(fn) } };
    install({ win, channel });
    const port = new MessageChannel();
    const reply = new Promise(resolve => { port.port1.onmessage = e => resolve(e.data); });
    listeners[0]({ data: { op: 'plenum-fetch', path: '/api/state' }, ports: [port.port2] });
    const msg = await reply;
    port.port1.close();
    assert.equal(msg.status, 404);
    assert.equal(channel.calls.length, 0);
  });
});

// ----- against the real sealed server, through a loopback bridge -----
// The Bridge's part is played here: each request goes to the sealed server's own loopback port with the real token (the Bridge adds
// it on the phone's path), and the body comes back as a stream. The shim then answers the UI exactly as it would on the phone.
function loopbackBridge(server) {
  return {
    calls: [],
    async request({ method = 'GET', path: p = '/' } = {}, body = null, { signal = null } = {}) {
      this.calls.push(`${method} ${p}`);
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      const ac = new AbortController();
      if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
      const res = await fetch(server.url + p, {
        method,
        headers: { 'x-plenum-token': server.token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ?? undefined,
        signal: ac.signal,
      });
      const headers = {};
      for (const [k, v] of res.headers) headers[k] = v;
      return { status: res.status, headers, body: res.body, id: 1, cancel: () => ac.abort() };
    },
    cancel() {},
  };
}

describe('boot.js against the sealed server (loopback bridge)', () => {
  let server = null;
  before(async () => {
    server = await startSealedServer({ name: 'mob09-shim', projects: ['p1'] });
  });
  after(async () => {
    await server?.stop();
  });

  test("request('/api/state') through the shim answers the same JSON a direct fetch gives", async () => {
    const bridge = loopbackBridge(server);
    const { shim } = install({ win: fakeWindow(`${server.url}/`), channel: bridge });
    const direct = await (await fetch(`${server.url}/api/state`, { headers: { 'x-plenum-token': server.token } })).json();
    const viaShim = await (await shim.shimFetch('/api/state')).json();
    assert.deepEqual(viaShim, direct);
    assert.deepEqual(bridge.calls, ['GET /api/state']);
  });

  test('GET /api/events delivers hello within 200 ms, and an abort ends the stream', async () => {
    const bridge = loopbackBridge(server);
    const { shim } = install({ win: fakeWindow(`${server.url}/`), channel: bridge });
    const ac = new AbortController();
    const t0 = Date.now();
    const res = await shim.shimFetch('/api/events', { signal: ac.signal });
    const reader = res.body.getReader();
    const first = await reader.read();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, `hello within 200 ms (took ${elapsed} ms)`);
    assert.match(dec.decode(first.value), /"type":"hello"/);
    ac.abort();
    await assert.rejects(reader.read());
  });
});
