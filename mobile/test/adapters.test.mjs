// Suite for the Bridge's adapters and the artifact picture (mob-19, MOBILE.json powers.adapters, MOBILE-UI 10 and 15.8).
// Four layers: (1) the adapters table in lib/remote/proxy.mjs on a fake upstream (pick-folder answered on the phone, the browser bounds
// rewrite, the artifact view as a picture for a phone whose caps name artifacts-picture and as the page for artifacts-iframe, the approve
// from a notification check, and the headers the server gets); (2) the same routes against a sealed `node server.mjs` with a fake desktop
// shell (sealed runner only); (3) the desktop handler that draws the picture (desktop/handlers/phones.cjs) with a fake Electron API, so
// the window's options, its session rules, the wait, the size limit and the clean-up are checked without starting Electron; the real
// window is checked by the harness in build/mobile/work (hidden, opacity 0). No network beyond loopback and no real provider.
// Run it through the sealed runner: node build/mobile/run.mjs --id mob-19 adapters.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { TEST_TOKEN, makeBridge, startFakeUpstream, startSealedServer } from './helpers/sealed-server.mjs';
import { createPhone } from './helpers/phone-sim.mjs';

const require = createRequire(import.meta.url);
const { createPhones } = require('../../desktop/handlers/phones.cjs');
const proxy = await import('../../lib/remote/proxy.mjs');
const { ADAPTERS, CARD_CHANGED } = proxy;
const SEALED = process.env.MOBILE_SEALED === '1';

const PICTURE_FAILED = 'The picture could not be made.';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = bytes => Buffer.from(bytes).subarray(0, 8).equals(PNG_SIGNATURE);
const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; sandbox allow-scripts";

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// What the fake server answers. Every request it gets is recorded by startFakeUpstream (method, url, headers, body).
const ROUTES = {
  'POST /api/browser/bounds': (req, res) => json(res, 200, { image: 'data:image/jpeg;base64,/9j/4AAQ' }),
  // The phone answers this itself; reaching the server is a failure.
  'POST /api/pick-folder': (req, res) => json(res, 500, { error: 'reached the server' }),
  'GET /api/artifacts/view': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ARTIFACT_CSP, 'cache-control': 'no-store' });
    res.end('<!doctype html><p>artifact</p>');
  },
  'POST /api/artifacts/picture': (req, res, entry) => {
    const { id } = JSON.parse(entry.body || '{}');
    if (id === 'nopicture0000') return json(res, 503, { error: 'This needs the desktop app.' });
    if (id === 'badpicture0000') return json(res, 200, { png: 'data:image/png;base64,AAAA' });
    return json(res, 200, { png: PNG_URL });
  },
  'POST /api/approve': (req, res) => json(res, 200, { ok: true }),
  'GET /api/echo-headers': (req, res) => json(res, 200, req.headers),
};

// ---------------------------------------------------------------------------------------------------------------------------------
// (1) The adapters table on a fake upstream

describe('the adapters table on a fake upstream', () => {
  let up;
  let bridge;
  let framePhone;
  let picturePhone;
  let frameSession;
  let pictureSession;
  const last = () => up.requests.at(-1);
  const lastBody = () => JSON.parse(last().body);
  const approvesSent = () => up.requests.filter(r => r.url === '/api/approve').length;

  before(async () => {
    up = await startFakeUpstream(ROUTES);
    bridge = await makeBridge({ upstream: up, loadUiManifest: async () => { throw new Error('no ui-manifest.mjs'); } });
    framePhone = createPhone({ name: 'Android phone', platform: 'android', app: 'pwa', caps: ['ui-from-desktop', 'artifacts-iframe', 'push-webpush'] });
    picturePhone = createPhone({ name: "Will's iPhone", platform: 'ios', app: 'ios', caps: ['ui-bundled', 'artifacts-picture', 'lan-control'] });
    ({ session: frameSession } = await bridge.pairPhone(framePhone));
    ({ session: pictureSession } = await bridge.pairPhone(picturePhone));
  });
  after(async () => {
    frameSession?.close();
    pictureSession?.close();
    await bridge?.close();
    await up?.close();
  });

  test('the table holds the three adapters, and a Bridge starts from its own copy of it', () => {
    assert.deepEqual([...ADAPTERS.keys()].sort(), ['GET /api/artifacts/view', 'POST /api/browser/bounds', 'POST /api/pick-folder']);
    assert.equal(bridge.remote.proxy.adapters.size, 3);
    bridge.remote.proxy.adapters.set('GET /api/only-here', { run: ctx => ctx.respond(200, { ok: true }) });
    assert.equal(ADAPTERS.has('GET /api/only-here'), false, 'the module table is not changed by one Bridge');
    bridge.remote.proxy.adapters.delete('GET /api/only-here');
  });

  test('pick-folder is answered on the phone with { available: false } and never reaches the server', async () => {
    const before = up.requests.length;
    const res = await frameSession.request('POST', '/api/pick-folder', { body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { available: false });
    assert.equal(up.requests.length, before, 'answered without touching the server');
  });

  test('a bounds call with visible true reaches the server as visible false, snapshot true and keep true, and the phone gets the picture', async () => {
    const res = await frameSession.request('POST', '/api/browser/bounds', { body: { x: 10, y: 20, width: 300, height: 400, visible: true } });
    assert.equal(res.status, 200);
    assert.equal(last().url, '/api/browser/bounds');
    assert.deepEqual(lastBody(), { visible: false, snapshot: true, keep: true }, 'keep asks the desktop to leave its page view on the window');
    assert.match(res.json().image, /^data:image\/jpeg;base64,/);
  });

  test('the server sees the real token, the device and the client id, and never a notification line the phone sent', async () => {
    await frameSession.request('GET', '/api/echo-headers', { headers: { 'x-plenum-client-id': 'msg-42.a', 'x-plenum-notify-line': 'Run: npm test' } });
    const seen = last().headers;
    assert.equal(seen['x-plenum-token'], TEST_TOKEN);
    assert.equal(seen['x-plenum-client-id'], 'msg-42.a', 'the client id passes through');
    assert.equal(seen['x-plenum-notify-line'], undefined, 'the notification line is checked here and dropped');
  });

  test('an artifact for a phone that shows pictures is a PNG the desktop draws, and the server is asked for it with the token', async () => {
    const id = randomUUID();
    const res = await pictureSession.request('GET', `/api/artifacts/view?id=${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.ok(isPng(res.bytes()), 'the answer is a PNG');
    assert.ok(Buffer.from(res.bytes()).equals(PNG), 'the PNG is the one the desktop sent');
    assert.equal(last().method, 'POST');
    assert.equal(last().url, '/api/artifacts/picture');
    assert.deepEqual(lastBody(), { id });
    assert.equal(last().headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(last().headers['x-plenum-token'], TEST_TOKEN);
  });

  test('a phone that shows the page gets the page with its own Content-Security-Policy, and the request passes through', async () => {
    const id = randomUUID();
    const res = await frameSession.request('GET', `/api/artifacts/view?id=${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-security-policy'], ARTIFACT_CSP);
    assert.match(res.text(), /<p>artifact<\/p>/);
    assert.equal(last().method, 'GET');
    assert.equal(last().url, `/api/artifacts/view?id=${id}`);
  });

  test('a picture the desktop cannot make gives the desktop sentence; a bad id is refused without the server', async () => {
    const before = up.requests.length;
    const none = await pictureSession.request('GET', '/api/artifacts/view?id=nopicture0000');
    assert.equal(none.status, 503);
    assert.equal(none.json().error, 'This needs the desktop app.');
    const bad = await pictureSession.request('GET', '/api/artifacts/view?id=badpicture0000');
    assert.equal(bad.status, 503);
    assert.deepEqual(bad.json(), { error: PICTURE_FAILED }, 'an answer that is not a PNG is never sent to the phone as one');
    const short = await pictureSession.request('GET', '/api/artifacts/view?id=x');
    assert.equal(short.status, 400);
    assert.equal(short.json().error, 'Say which artifact.');
    assert.equal(up.requests.length, before + 2, 'the short id was answered without the server');
  });

  test('an approve from a notification goes through only with the opt-in, a waiting card and the same first line', async () => {
    const card = (approvalId, summary, extra = {}) => bridge.remote.handleEvent({
      type: 'run', runId: 'r-adapt', project: 'p1', kind: 'chat', event: { type: 'approval', approvalId, summary, detail: 'detail', ...extra },
    });
    const approve = (approvalId, { line, allow = true } = {}) => pictureSession.request('POST', '/api/approve', {
      body: { approvalId, allow }, headers: line === undefined ? {} : { 'x-plenum-notify-line': line },
    });
    card('n1', 'Run: npm test');
    card('n2', 'Run: rm -rf build', { defaultDeny: true });

    let before = approvesSent();
    let r = await approve('n1', { line: 'Run: npm test' });
    assert.equal(r.status, 409, 'the opt-in is off by default');
    assert.deepEqual(r.json(), { error: CARD_CHANGED, changed: true });
    assert.equal(approvesSent(), before, 'nothing reached the server');

    await bridge.remote.setApproveFromNotifications(picturePhone.id, true);
    before = approvesSent();
    r = await approve('n1', { line: 'Run: npm test' });
    assert.equal(r.status, 200, 'the opt-in, the waiting card and the same first line');
    assert.equal(approvesSent(), before + 1);
    assert.equal(last().headers['x-plenum-notify-line'], undefined, 'the line is not forwarded');
    assert.equal(lastBody().approvalId, 'n1');

    r = await approve('n1', { line: 'Run: rm -rf /' });
    assert.equal(r.status, 409, 'a different first line');
    r = await approve('n2', { line: 'Run: rm -rf build' });
    assert.equal(r.status, 409, 'a blocked-command card never takes an approve from a notification');
    r = await approve('gone', { line: 'Run: npm test' });
    assert.equal(r.status, 409, 'a card that no longer waits');
    r = await approve('n1', { line: '' });
    assert.equal(r.status, 409, 'an empty line matches nothing');

    await bridge.remote.setApproveFromNotifications(picturePhone.id, false);
    before = approvesSent();
    r = await approve('n1', { line: 'Run: npm test', allow: false });
    assert.equal(r.status, 200, 'a deny from a notification needs no opt-in');
    r = await approve('n1');
    assert.equal(r.status, 200, 'an approve with no notification line is the card itself, as before');
    assert.equal(approvesSent(), before + 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (2) The same routes against a sealed server with a fake desktop shell

describe('against a sealed server with a fake desktop shell', { skip: SEALED ? false : 'only inside the sealed runner (node build/mobile/run.mjs)' }, () => {
  let server;
  let bridge;
  let session;
  const boundsSeen = [];
  const picturesSeen = [];

  before(async () => {
    server = await startSealedServer({ name: 'adapters', ipc: true, projects: ['p1'] });
    server.shell.handlers['browser-bounds'] = msg => {
      boundsSeen.push(msg);
      return { ok: true, image: 'data:image/jpeg;base64,/9j/4AAQ' };
    };
    server.shell.handlers['phones-artifact-picture'] = msg => {
      picturesSeen.push(msg);
      return { ok: true, png: PNG_URL };
    };
    bridge = await makeBridge({ upstream: { port: server.port }, token: server.token, loadUiManifest: async () => { throw new Error('no ui-manifest.mjs'); } });
    const phone = createPhone({ name: "Will's iPhone", platform: 'ios', app: 'ios', caps: ['ui-bundled', 'artifacts-picture'] });
    ({ session } = await bridge.pairPhone(phone));
  });
  after(async () => {
    session?.close();
    await bridge?.close();
    await server?.stop();
  });

  test('a phone bounds call reaches the desktop as visible false and snapshot true, and the phone gets the picture', async () => {
    const res = await session.request('POST', '/api/browser/bounds', { body: { x: 1, y: 2, width: 300, height: 200, visible: true } });
    assert.equal(res.status, 200);
    assert.equal(res.json().available, true);
    assert.match(res.json().image, /^data:image\/jpeg;base64,/);
    const seen = boundsSeen.at(-1);
    assert.equal(seen.visible, false);
    assert.equal(seen.snapshot, true);
  });

  // H5 (wave 103). The Bridge forwards keep: true (proxy.mjs, and the fake-upstream test above holds that). Until lib/routes/browser.mjs
  // passes keep on to the shell and desktop/browser.cjs skips its detach for it, a phone's Browser pane makes the desktop's live page
  // view detach every 2 s. The todo flag keeps the rest of the suite green until then; when the real fix lands the assertion passes and
  // the todo flag comes off (node:test reports a todo that passes as ok, so nothing hides the change).
  test('a phone bounds call reaches the desktop with keep true, so the desktop leaves its live page view on the window', { todo: 'needs lib/routes/browser.mjs and desktop/browser.cjs keep (wave 119)' }, async () => {
    const res = await session.request('POST', '/api/browser/bounds', { body: { x: 1, y: 2, width: 300, height: 200, visible: true } });
    assert.equal(res.status, 200);
    const seen = boundsSeen.at(-1);
    assert.equal(seen.keep, true, 'keep reaches the desktop (lib/routes/browser.mjs must pass it on)');
  });

  test('a staged artifact reaches a picture phone as a PNG the desktop drew', async () => {
    const staged = await server.post('/api/artifacts/stage', { kind: 'html', content: '<p>hello</p>' });
    assert.equal(staged.status, 200);
    const res = await session.request('GET', `/api/artifacts/view?id=${staged.body.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.ok(isPng(res.bytes()));
    assert.equal(picturesSeen.at(-1).artifact, staged.body.id, 'the id travels as artifact (shellRequest uses id for its own correlation id)');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (3) The desktop handler that draws the picture, with a fake Electron API

// The fake keeps every window it makes. behaviour: failLoad (the load fails), neverLoad (the load never ends), emptyFirst (the first
// capture is empty), big (every picture is over 2 MB).
function fakeElectron(behaviour = {}) {
  const made = [];
  const sessions = new Map();
  const bigPng = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(2 * 1024 * 1024)]);
  const imageOf = bytes => ({
    isEmpty: () => bytes.length === 0,
    toPNG: () => bytes,
    getSize: () => ({ width: 900, height: 1200 }),
    resize: () => imageOf(bytes),
  });

  class FakeSession {
    constructor(name) {
      this.name = name;
      this.cleared = 0;
      this.webRequest = {
        onBeforeRequest: (filter, fn) => { this.beforeRequest = { filter, fn }; },
        onBeforeSendHeaders: (filter, fn) => { this.beforeSend = { filter, fn }; },
        onCompleted: (filter, fn) => { this.completed = { filter, fn }; },
      };
    }
    setPermissionRequestHandler(fn) { this.permission = fn; }
    setPermissionCheckHandler(fn) { this.check = fn; }
    async clearStorageData() { this.cleared += 1; }
    async clearCache() {}
  }

  class FakeContents {
    constructor(owner) {
      this.owner = owner;
      this.listeners = new Map();
    }
    on(name, fn) { this.add(name, fn, false); }
    once(name, fn) { this.add(name, fn, true); }
    add(name, fn, once) {
      const list = this.listeners.get(name) ?? [];
      list.push({ fn, once });
      this.listeners.set(name, list);
    }
    emit(name, ...args) {
      const list = this.listeners.get(name) ?? [];
      this.listeners.set(name, list.filter(l => !l.once));
      for (const l of list) l.fn(...args);
    }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    capturePage() {
      const win = this.owner;
      win.captures += 1;
      if (behaviour.emptyFirst && win.captures === 1) return Promise.resolve(imageOf(Buffer.alloc(0)));
      return Promise.resolve(imageOf(behaviour.big ? bigPng : PNG));
    }
  }

  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyedFlag = false;
      this.shown = [];
      this.ignoreMouse = null;
      this.captures = 0;
      this.afterPreviousDestroyed = made.length === 0 ? true : made.at(-1).destroyedFlag;
      this.webContents = new FakeContents(this);
      made.push(this);
    }
    isDestroyed() { return this.destroyedFlag; }
    destroy() { this.destroyedFlag = true; }
    showInactive() { this.shown.push('inactive'); }
    setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
    loadURL(url) {
      this.url = url;
      setImmediate(() => {
        if (this.destroyedFlag) return;
        const session = sessions.get(this.options.webPreferences.partition);
        session?.completed?.fn({ url, statusCode: behaviour.status ?? 200 });
        if (behaviour.failLoad) this.webContents.emit('did-fail-load', {}, -105, 'failed', url, true);
        else if (!behaviour.neverLoad) this.webContents.emit('did-finish-load');
      });
      return Promise.resolve();
    }
  }

  return {
    made,
    sessions,
    session: {
      fromPartition: name => {
        if (!sessions.has(name)) sessions.set(name, new FakeSession(name));
        return sessions.get(name);
      },
    },
    BrowserWindow: FakeWindow,
  };
}

const SHELL = { port: 7235, token: 'cd'.repeat(32), log: () => {} };
const ID = 'artifact-0123456789';
const OTHER_ID = 'artifact-abcdefghij';
const TYPE = 'phones-artifact-picture';
// What the server sends: shellRequest adds its own correlation id as id, and the artifact id travels as artifact.
const message = artifact => ({ type: TYPE, id: 'correlation-0001', artifact });
const handlerWith = electron => createPhones({ electron, pictureWaitMs: 60, pictureTotalMs: 1500 }).messages[TYPE];

describe('the artifact picture window (desktop handler, fake Electron API)', () => {
  test('a picture is a PNG drawn in a hidden window of its own in-memory session, and the window is destroyed afterwards', async () => {
    const api = fakeElectron();
    const reply = await handlerWith(api)(message(ID), SHELL);
    assert.equal(reply.ok, true);
    assert.ok(reply.png.startsWith('data:image/png;base64,'));
    assert.ok(isPng(Buffer.from(reply.png.slice('data:image/png;base64,'.length), 'base64')));
    assert.equal(api.made.length, 1);
    const [win] = api.made;
    assert.equal(win.options.show, false);
    assert.equal(win.options.opacity, 0);
    assert.equal(win.options.focusable, false);
    assert.equal(win.options.skipTaskbar, true);
    assert.equal(win.ignoreMouse, true, 'the window takes no mouse events');
    assert.ok(win.shown.includes('inactive'), 'shown without focus');
    const wp = win.options.webPreferences;
    assert.equal(wp.partition, 'plenum-artifact-picture', 'a partition with no persist: prefix is kept in memory');
    assert.equal(wp.sandbox, true);
    assert.equal(wp.contextIsolation, true);
    assert.equal(wp.nodeIntegration, false);
    assert.equal(wp.devTools, false);
    assert.equal(win.url, `http://127.0.0.1:7235/api/artifacts/view?id=${ID}`);
    assert.equal(win.destroyedFlag, true, 'the window is destroyed afterwards');
    assert.ok(api.sessions.get('plenum-artifact-picture').cleared >= 1, 'what the session kept is cleared');
  });

  test('the token goes only on the one loopback artifact request, and every other request of the page is cancelled', async () => {
    const api = fakeElectron();
    await handlerWith(api)(message(ID), SHELL);
    const session = api.sessions.get('plenum-artifact-picture');
    assert.deepEqual(session.beforeSend.filter.urls, ['http://127.0.0.1:7235/api/artifacts/view*']);
    let sent = null;
    session.beforeSend.fn({ requestHeaders: { accept: '*/*' } }, out => { sent = out.requestHeaders; });
    assert.equal(sent['x-plenum-token'], SHELL.token);
    assert.equal(sent.accept, '*/*');
    const cancelled = url => {
      let cancel = null;
      session.beforeRequest.fn({ url }, out => { cancel = out.cancel; });
      return cancel;
    };
    assert.equal(cancelled(`http://127.0.0.1:7235/api/artifacts/view?id=${ID}`), false, 'the artifact itself loads');
    assert.equal(cancelled('data:image/png;base64,AAAA'), false, 'data addresses the page makes itself load');
    assert.equal(cancelled('http://127.0.0.1:7235/api/state'), true, 'no other route of the server');
    assert.equal(cancelled('http://127.0.0.1:7236/api/artifacts/view?id=x'), true, 'another port');
    assert.equal(cancelled('http://localhost:7235/api/artifacts/view?id=x'), true, 'the name, not the loopback address');
    assert.equal(cancelled('https://example.com/a.png'), true, 'no network from the picture');
    let answered = null;
    session.permission({}, 'notifications', granted => { answered = granted; });
    assert.equal(answered, false, 'no permission is granted');
  });

  test('a page that never ends loading is pictured at the wait limit', async () => {
    const api = fakeElectron({ neverLoad: true });
    const started = Date.now();
    const reply = await handlerWith(api)(message(ID), SHELL);
    assert.equal(reply.ok, true);
    assert.equal(api.made[0].captures, 1, 'taken once, at the limit');
    assert.ok(Date.now() - started < 1500, 'not waited past the limit');
    assert.equal(api.made[0].destroyedFlag, true);
  });

  test('an answer that is an error (an expired id) gets the sentence and is never pictured', async () => {
    const api = fakeElectron({ status: 404 });
    const reply = await handlerWith(api)(message(ID), SHELL);
    assert.deepEqual(reply, { ok: false, message: PICTURE_FAILED });
    assert.equal(api.made[0].captures, 0, 'the error page was not drawn');
    assert.equal(api.made[0].destroyedFlag, true);
  });

  test('a page that fails to load gets the sentence, and its window is still destroyed', async () => {
    const api = fakeElectron({ failLoad: true });
    const reply = await handlerWith(api)(message(ID), SHELL);
    assert.deepEqual(reply, { ok: false, message: PICTURE_FAILED });
    assert.equal(api.made[0].destroyedFlag, true);
  });

  test('an empty first capture is retried once after the window is shown again', async () => {
    const api = fakeElectron({ emptyFirst: true });
    const reply = await handlerWith(api)(message(ID), SHELL);
    assert.equal(reply.ok, true);
    assert.equal(api.made[0].shown.length, 2);
  });

  test('a picture of 2 MB or more is refused with its own sentence, and the window is destroyed', async () => {
    const api = fakeElectron({ big: true });
    const reply = await handlerWith(api)(message(ID), SHELL);
    assert.deepEqual(reply, { ok: false, message: 'That picture is too large to send.' });
    assert.equal(api.made[0].destroyedFlag, true);
  });

  test('a bad id, no desktop token and plain Node are all refused without a window', async () => {
    const api = fakeElectron();
    const picture = handlerWith(api);
    assert.deepEqual(await picture(message('x'), SHELL), { ok: false, message: 'Say which artifact.' });
    assert.deepEqual(await picture({ type: TYPE, id: ID }, SHELL), { ok: false, message: 'Say which artifact.' }, 'the correlation id is never the artifact');
    assert.deepEqual(await picture(message(ID), { port: 7235 }), { ok: false, message: 'Pictures of artifacts need the desktop app.' });
    assert.equal(api.made.length, 0, 'no window was made');
    const plain = await createPhones({ electron: null }).messages[TYPE](message(ID), SHELL);
    assert.equal(plain.ok, false, 'plain Node has no window to draw in');
  });

  test('two pictures are drawn one after the other, each in its own window', async () => {
    const api = fakeElectron();
    const picture = handlerWith(api);
    const [a, b] = await Promise.all([picture(message(ID), SHELL), picture(message(OTHER_ID), SHELL)]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(api.made.length, 2);
    assert.equal(api.made[1].afterPreviousDestroyed, true, 'the second window was made after the first was destroyed');
    assert.equal(api.made[1].url, `http://127.0.0.1:7235/api/artifacts/view?id=${OTHER_ID}`);
  });
});
