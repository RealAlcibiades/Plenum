// Suite for a phone acting as the person (mob-20, wave 120; MOBILE.json powers.browser_and_computer, MOBILE-UI 8.10 and 8.11): the live picture
// of the Browser pane, the person's tap, swipe, typing and key, and "Take over from phone" for a computer run. Seven layers:
//   (1) the tier rule and the carrier rule (lib/remote/tiers.mjs);
//   (2) the Bridge on a fake upstream: Full only, the headers the server gets, the activity lines, a phone's forged headers dropped;
//   (3) the iOS store build off the LAN carrier, on the proxy with a fake connection (the only way to give a connection another carrier);
//   (4) the browser routes with a fake browser bridge;
//   (5) the computer routes with a fake computer driver and the real drive registry;
//   (6) the whole chain against a sealed `node server.mjs` with a fake desktop shell (sealed runner only);
//   (7) the desktop handler that makes the JPEG of a run (desktop/handlers/computer.cjs) and the places a model's tool must never reach.
// No network beyond loopback, no real model, no real desktop. Run it through the sealed runner:
//   node build/mobile/run.mjs --id mob20rc remote-control.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { TEST_TOKEN, makeBridge, startFakeUpstream, startSealedServer, sleep, until } from './helpers/sealed-server.mjs';
import { createPhone } from './helpers/phone-sim.mjs';
import { setToken } from '../../lib/auth.mjs';
import { startDrive } from '../../lib/drive.mjs';

const require = createRequire(import.meta.url);
const tiers = await import('../../lib/remote/tiers.mjs');
const { createProxy } = await import('../../lib/remote/proxy.mjs');
const { createRoutes } = await import('../../lib/routes/browser.mjs');
const { createControlRoutes } = await import('../../lib/routes/computer.mjs');
const { NOTICES } = await import('../../lib/notices.mjs');
const computerHandler = require('../../desktop/handlers/computer.cjs');
const SEALED = process.env.MOBILE_SEALED === '1';
const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const { CONTROL_POSTS, LAN_ONLY_TEXT, REFUSAL_TEXT, capsForTier, classify, classifyDetailed, controlRefusal, isControlPath, lanOnlyClient } = tiers;
const PHONE_ONLY = 'This is for a paired phone.';
const jsonBody = value => Buffer.from(JSON.stringify(value));

const TAP = { kind: 'tap', x: 10, y: 20, width: 400, height: 300 };
const BODIES = {
  '/api/browser/frame': {},
  '/api/browser/input': TAP,
  '/api/computer/takeover': { id: 'no-such-run' },
  '/api/computer/live': { id: 'no-such-run' },
  '/api/computer/input': { id: 'no-such-run', ...TAP },
};

// ---------------------------------------------------------------------------------------------------------------------------------
// (1) The tier rule and the carrier rule

describe('the tier rule and the carrier rule', () => {
  test('the five control routes need Full, by their own rule', () => {
    assert.deepEqual([...CONTROL_POSTS].sort(), Object.keys(BODIES).sort());
    for (const p of CONTROL_POSTS) {
      assert.equal(classify('POST', p), 'full', p);
      assert.deepEqual(classifyDetailed('POST', p), { tier: 'full', rule: 'control' }, p);
      assert.equal(classify('POST', `${p}?x=1`), 'full', 'a query changes nothing');
      assert.equal(isControlPath(p), true);
      assert.equal(classify('POST', `/api/x/../${p.slice(5)}`), 'full', 'a dot segment that lands on it is that route');
    }
    assert.equal(isControlPath('/api/browser/navigate'), false, 'the address bar is not person input');
    assert.equal(isControlPath('/api/browser/bounds'), false, 'the picture the phone already had is not either');
    assert.equal(isControlPath('/api/drive/pause'), false);
  });

  test('Full phones are told the desktop can be steered; the lower tiers are not', () => {
    for (const cap of ['browser-control', 'computer-control']) {
      assert.ok(capsForTier('full').includes(cap), cap);
      assert.equal(capsForTier('approve').includes(cap), false, cap);
      assert.equal(capsForTier('read').includes(cap), false, cap);
    }
    assert.ok(capsForTier('read').includes('browser-picture'), 'the still picture stays in every tier');
  });

  test('the iOS store build is the one held to the LAN carrier, judged by the connection and not by what the phone says', () => {
    const ios = { device: { app: 'ios', platform: 'ios' }, caps: ['ui-bundled', 'artifacts-picture', 'lan-control'] };
    const iosNoCap = { device: { app: 'ios', platform: 'ios' }, caps: ['ui-bundled'] };
    const iosPwa = { device: { app: 'pwa', platform: 'ios' }, caps: ['ui-from-desktop', 'artifacts-iframe', 'push-webpush'] };
    const androidApp = { device: { app: 'android', platform: 'android' }, caps: ['ui-bundled', 'lan-control'] };
    const androidPwa = { device: { app: 'pwa', platform: 'android' }, caps: [] };
    const lanWeb = { device: { app: 'lan-web', platform: 'web' }, caps: ['ui-from-desktop'] };
    const capOnly = { device: { app: 'pwa', platform: 'web' }, caps: ['lan-control'] };
    for (const [name, rec, held] of [['ios', ios, true], ['ios without the cap', iosNoCap, true], ['an iPhone web app', iosPwa, false], ['an Android app', androidApp, false],
      ['an Android web app', androidPwa, false], ['the LAN page', lanWeb, false], ['the cap alone on a web client', capOnly, true]]) {
      assert.equal(lanOnlyClient(rec), held, name);
      for (const carrier of ['tailscale', 'relay', '', undefined]) {
        assert.equal(controlRefusal({ ...rec, carrier }), held ? LAN_ONLY_TEXT : null, `${name} on ${carrier}`);
      }
      assert.equal(controlRefusal({ ...rec, carrier: 'lan' }), null, `${name} on the LAN`);
    }
    assert.equal(lanOnlyClient({}), false);
    assert.equal(lanOnlyClient(null), false);
    assert.doesNotMatch(LAN_ONLY_TEXT, /!/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (2) The Bridge on a fake upstream

describe('the Bridge: Full only, the headers the server gets, the activity lines', () => {
  let up;
  let bridge;
  let full;
  let fullSession;
  let ios;
  let iosSession;
  let low;
  let lowSession;
  const last = () => up.requests.at(-1);
  const post = (session, path, body = BODIES[path], headers = {}) => session.request('POST', path, { body, headers });

  before(async () => {
    up = await startFakeUpstream({});
    bridge = await makeBridge({ upstream: up, loadUiManifest: async () => { throw new Error('no ui-manifest.mjs'); } });
    full = createPhone({ name: 'Android phone', platform: 'android', app: 'pwa', caps: ['ui-from-desktop', 'artifacts-iframe', 'push-webpush'] });
    ios = createPhone({ name: "Will's iPhone", platform: 'ios', app: 'ios', caps: ['ui-bundled', 'artifacts-picture', 'lan-control'] });
    low = createPhone({ name: 'Spare phone', platform: 'android', app: 'pwa' });
    ({ session: fullSession } = await bridge.pairPhone(full));
    ({ session: iosSession } = await bridge.pairPhone(ios));
    ({ session: lowSession } = await bridge.pairPhone(low));
  });
  after(async () => {
    for (const s of [fullSession, iosSession, lowSession]) s?.close();
    await bridge?.close();
    await up?.close();
  });

  test('a Full phone reaches all five routes with the real token and its own id, and the body arrives as sent', async () => {
    for (const [path, body] of Object.entries(BODIES)) {
      const before = up.requests.length;
      const res = await post(fullSession, path, body);
      assert.equal(res.status, 200, path);
      assert.equal(up.requests.length, before + 1, path);
      assert.equal(last().url, path);
      assert.equal(last().headers['x-plenum-token'], TEST_TOKEN);
      assert.equal(last().headers['x-plenum-device'], full.id);
      assert.deepEqual(JSON.parse(last().body), body, 'the same body');
    }
  });

  test('a phone cannot set the device or the token the server sees', async () => {
    await post(fullSession, '/api/browser/input', TAP, { 'x-plenum-device': 'someone-else', 'x-plenum-token': 'f'.repeat(64), 'x-plenum-bridge': 'secret' });
    assert.equal(last().headers['x-plenum-device'], full.id);
    assert.equal(last().headers['x-plenum-token'], TEST_TOKEN);
    assert.equal(last().headers['x-plenum-bridge'], undefined);
  });

  test('an Approve-and-watch phone and a Read-only phone are refused every one of them, and the server hears nothing', async () => {
    for (const tier of ['approve', 'read']) {
      await bridge.remote.setTier(low.id, tier);
      for (const [path, body] of Object.entries(BODIES)) {
        const before = up.requests.length;
        const res = await post(lowSession, path, body);
        assert.equal(res.status, 403, `${tier} ${path}`);
        assert.equal(res.json().error, REFUSAL_TEXT);
        assert.equal(up.requests.length, before, 'refused at the Bridge');
      }
    }
    // The stops and the still picture of those tiers are untouched.
    const stop = await lowSession.request('POST', '/api/stop-all', { body: {} });
    assert.equal(stop.status, 200);
    await bridge.remote.setTier(low.id, 'full');
    assert.equal((await post(lowSession, '/api/browser/input')).status, 200, 'raising the tier lets the next request through');
  });

  test('the iOS app on the LAN carrier may steer; the same routes of every other kind of request are untouched', async () => {
    for (const [path, body] of Object.entries(BODIES)) assert.equal((await post(iosSession, path, body)).status, 200, path);
    assert.equal((await iosSession.request('POST', '/api/browser/navigate', { body: { url: 'https://example.com/' } })).status, 200);
  });

  test('a body over 16 KB is refused by the guard and the server is not asked', async () => {
    const before = up.requests.length;
    const res = await post(fullSession, '/api/browser/input', { kind: 'type', text: 'x'.repeat(20_000) });
    assert.equal(res.status, 413);
    assert.equal(up.requests.length, before);
  });

  test('a burst of taps is one line in the activity list, a different kind of input is another, and no line holds what was typed', async () => {
    // A phone of its own: the lines are held back for half a minute for each connection, and the tests above have written some already.
    const watcher = createPhone({ name: 'Watcher', platform: 'android', app: 'pwa' });
    const { session } = await bridge.pairPhone(watcher);
    try {
      const lines = () => bridge.remote.activity().filter(a => a.device === 'Watcher').map(a => a.text);
      for (let i = 0; i < 4; i += 1) await post(session, '/api/browser/input', { ...TAP, x: i });
      assert.deepEqual(lines(), ['tapped in the browser'], 'four taps, one line');
      await post(session, '/api/browser/input', { kind: 'type', text: 'hunter2-the-password' });
      await post(session, '/api/browser/input', { kind: 'key', key: 'Backspace' });
      await post(session, '/api/browser/input', { kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dy: 5 });
      await post(session, '/api/browser/frame', {});
      await post(session, '/api/browser/frame', {});
      assert.deepEqual(lines(), ['watched the browser live', 'scrolled in the browser', 'pressed a key in the browser', 'typed in the browser', 'tapped in the browser']);
      await post(session, '/api/computer/takeover', { id: 'x' });
      await post(session, '/api/computer/takeover', { id: 'x' });
      assert.deepEqual(lines().slice(0, 2), ['took over a computer run', 'took over a computer run'], 'a takeover is written every time');
      await post(session, '/api/computer/input', { id: 'x', kind: 'type', text: 'another-secret' });
      await post(session, '/api/computer/input', { id: 'x', kind: 'drag' });
      await post(session, '/api/computer/live', { id: 'x' });
      assert.deepEqual(lines().slice(0, 3), ['watched the computer run live', 'used the computer', 'typed on the computer'], 'a kind it does not know is called by its route');
      const all = JSON.stringify(bridge.remote.activity());
      assert.ok(!all.includes('hunter2') && !all.includes('another-secret'), 'nothing typed is in the list');
      assert.ok(bridge.published.filter(e => e.type === 'phone' && e.kind === 'activity').every(e => !/hunter2|another-secret/.test(JSON.stringify(e))), 'nor on the events channel');
    } finally {
      session.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (3) The iOS store build off the LAN carrier

// A connection record and a frame session that only record the answer, so a connection can have any carrier.
function fakeFrames() {
  const streams = new Map();
  const get = id => {
    if (!streams.has(id)) {
      const entry = { status: 0, headers: null, chunks: [], done: false, wake: null };
      entry.finished = new Promise(resolve => { entry.wake = resolve; });
      streams.set(id, entry);
    }
    return streams.get(id);
  };
  const finish = entry => { entry.done = true; entry.wake(); };
  return {
    isClosed: false,
    transport: { bufferedAmount: 0 },
    respond(id, head, opts = {}) { const e = get(id); e.status = head.status; e.headers = head.headers; if (opts.fin) finish(e); return true; },
    data(id, bytes, opts = {}) { const e = get(id); if (bytes?.length) e.chunks.push(Buffer.from(bytes)); if (opts.fin) finish(e); return true; },
    cancel() {},
    stopAck() {},
    async result(id) { const e = get(id); await e.finished; const text = Buffer.concat(e.chunks).toString('utf8'); return { status: e.status, text, json: () => JSON.parse(text) }; },
  };
}

describe('the iOS store build off the LAN carrier', () => {
  let up;
  let proxy;
  const activity = [];
  let nextStream = 1;

  before(async () => {
    up = await startFakeUpstream({});
    proxy = createProxy({
      upstreamPort: () => up.port,
      getToken: () => TEST_TOKEN,
      registry: { tierOf: () => 'full', get: () => ({}) },
      clock: { now: () => Date.now(), setTimeout, clearTimeout },
      routeGated: async () => false,
      onActivity: a => activity.push(a.text),
    });
  });
  after(async () => { await up?.close(); });

  const connection = (device, caps, carrier) => ({ deviceId: 'dev-1', device, caps, carrier, frames: fakeFrames(), lastReq: 0 });

  async function send(rec, method, path, body) {
    const handlers = proxy.attach(rec);
    const stream = nextStream++;
    const bytes = body === undefined ? null : jsonBody(body);
    handlers.req(stream, { method, path, headers: bytes ? { 'content-type': 'application/json' } : {}, ...(bytes ? { bodyLength: bytes.length } : {}) }, bytes === null);
    if (bytes) handlers.body(stream, new Uint8Array(bytes), true);
    return rec.frames.result(stream);
  }

  const IOS = { app: 'ios', platform: 'ios', name: "Will's iPhone" };
  const IOS_CAPS = ['ui-bundled', 'artifacts-picture', 'lan-control'];

  test('the iOS app is refused all five routes on Tailscale and on the relay, with the sentence, and the server hears nothing', async () => {
    for (const carrier of ['tailscale', 'relay']) {
      const rec = connection(IOS, IOS_CAPS, carrier);
      for (const [path, body] of Object.entries(BODIES)) {
        const before = up.requests.length;
        const res = await send(rec, 'POST', path, body);
        assert.equal(res.status, 403, `${carrier} ${path}`);
        assert.deepEqual(res.json(), { error: LAN_ONLY_TEXT });
        assert.equal(up.requests.length, before);
      }
    }
  });

  test('the iOS app on the LAN carrier is let through, and so is the same app that left out its lan-control cap only if it is on the LAN', async () => {
    const lan = connection(IOS, IOS_CAPS, 'lan');
    assert.equal((await send(lan, 'POST', '/api/browser/input', TAP)).status, 200);
    const noCap = connection(IOS, ['ui-bundled'], 'relay');
    assert.equal((await send(noCap, 'POST', '/api/browser/input', TAP)).status, 403, 'dropping the cap does not get an iOS app past the rule');
    assert.equal((await send(connection(IOS, ['ui-bundled'], 'lan'), 'POST', '/api/browser/input', TAP)).status, 200);
  });

  test('the Android app, the web apps and the LAN page are not held to it on any carrier', async () => {
    const others = [
      [{ app: 'android', platform: 'android', name: 'Pixel' }, ['ui-bundled', 'lan-control']],
      [{ app: 'pwa', platform: 'android', name: 'Pixel web' }, ['ui-from-desktop']],
      [{ app: 'pwa', platform: 'ios', name: 'iPhone web app' }, ['ui-from-desktop', 'artifacts-iframe']],
      [{ app: 'lan-web', platform: 'web', name: 'A browser' }, ['ui-from-desktop']],
    ];
    for (const [device, caps] of others) {
      for (const carrier of ['lan', 'tailscale', 'relay']) {
        const res = await send(connection(device, caps, carrier), 'POST', '/api/browser/input', TAP);
        assert.equal(res.status, 200, `${device.name} on ${carrier}`);
      }
    }
  });

  test('what the iOS app already had off the LAN stays: the address bar, the still picture, Pause, Resume and Stop, and the reads', async () => {
    const rec = connection(IOS, IOS_CAPS, 'relay');
    for (const [method, path, body] of [['POST', '/api/browser/navigate', { url: 'https://example.com/' }], ['POST', '/api/browser/bounds', { x: 0, y: 0, width: 4, height: 3, visible: true }],
      ['POST', '/api/drive/pause', { id: 'x' }], ['POST', '/api/drive/resume', { id: 'x' }], ['POST', '/api/drive/stop', { id: 'x' }], ['POST', '/api/stop-all', {}], ['GET', '/api/computer/frame?run=r&n=1'],
      ['GET', '/api/browser/state'], ['POST', '/api/computer/type', { id: 'x', text: 'code' }]]) {
      const res = await send(rec, method, path, body);
      assert.equal(res.status, 200, `${method} ${path}`);
    }
    const bounds = up.requests.filter(r => r.url === '/api/browser/bounds').at(-1);
    assert.deepEqual(JSON.parse(bounds.body), { visible: false, snapshot: true, keep: true }, 'the picture call still reaches the server as a keep call');
  });

  test('an Approve-and-watch tier is refused first, with its own sentence', async () => {
    const low = createProxy({
      upstreamPort: () => up.port, getToken: () => TEST_TOKEN, registry: { tierOf: () => 'approve', get: () => ({}) },
      clock: { now: () => Date.now(), setTimeout, clearTimeout }, routeGated: async () => false,
    });
    const rec = connection(IOS, IOS_CAPS, 'relay');
    const handlers = low.attach(rec);
    handlers.req(900, { method: 'POST', path: '/api/browser/input', headers: {}, bodyLength: 2 }, false);
    handlers.body(900, new Uint8Array(Buffer.from('{}')), true);
    const res = await rec.frames.result(900);
    assert.equal(res.status, 403);
    assert.equal(res.json().error, REFUSAL_TEXT);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (4) The browser routes with a fake browser bridge

const GOOD_TOKEN = 'cd'.repeat(32);
setToken(GOOD_TOKEN, 'environment');
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Calls one route handler the way the server does, with a fake request. Resolves { status, body } or { status, error }.
async function callRoute(routes, method, path, { body, device, headers = {} } = {}) {
  const route = routes.find(r => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} is a route`);
  let out = null;
  const ctx = {
    req: { headers: { 'x-plenum-token': GOOD_TOKEN, ...(device ? { 'x-plenum-device': device } : {}), ...headers } },
    res: {},
    url: new URL(`http://127.0.0.1${path}`),
    json: (_res, status, payload) => { out = { status, body: payload }; return out; },
    readBody: async () => body,
    httpError,
    store: { get: () => ({}) },
  };
  try {
    await route.handler(ctx);
  } catch (err) {
    return { status: err.status ?? 500, error: err.message };
  }
  return out;
}

function fakeBrowserBridge({ available = true } = {}) {
  const calls = [];
  const bridge = {
    calls,
    answers: {},
    delay: 0,
    available: () => available,
    snapshot: () => ({ known: true, tabs: [], activeTab: null, events: [], downloads: [], permissions: [], remembered: 0, takeover: false, agentDriving: false, secret: null, askAnyway: false }),
    async ask(type, payload) {
      calls.push({ type, payload });
      if (bridge.delay) await sleep(bridge.delay);
      const answer = bridge.answers[type];
      return answer ? answer(payload) : { type: `${type}-result`, id: 'x', ok: true };
    },
  };
  return bridge;
}

const fakeDrives = list => ({ listDrives: () => list });
const drive = (state, pausedBy = null, kind = 'browser') => ({ id: `d-${state}`, kind, state, pausedBy });

describe('the browser routes (fake browser bridge)', () => {
  const PHONE = 'a1b2c3d4e5f60718';

  test('bounds passes keep on from a phone, and only as true or false inside the covered call', async () => {
    const bridge = fakeBrowserBridge();
    const routes = createRoutes(bridge, { events: false, drives: fakeDrives([]) });
    await callRoute(routes, 'POST', '/api/browser/bounds', { body: { visible: false, snapshot: true, keep: true } });
    await callRoute(routes, 'POST', '/api/browser/bounds', { body: { visible: false, snapshot: true } });
    await callRoute(routes, 'POST', '/api/browser/bounds', { body: { visible: false, snapshot: true, keep: 'yes' } });
    await callRoute(routes, 'POST', '/api/browser/bounds', { body: { x: 1, y: 2, width: 3, height: 4, visible: true, keep: true } });
    assert.deepEqual(bridge.calls.map(c => c.payload), [
      { visible: false, snapshot: true, keep: true },
      { visible: false, snapshot: true, keep: false },
      { visible: false, snapshot: true, keep: false },
      { visible: true, x: 1, y: 2, width: 3, height: 4 },
    ]);
  });

  test('every person-input route answers 403 to a request that did not come through the Bridge, and asks the desktop nothing', async () => {
    const bridge = fakeBrowserBridge();
    const routes = createRoutes(bridge, { events: false, drives: fakeDrives([]) });
    for (const path of ['/api/browser/frame', '/api/browser/input']) {
      for (const device of [undefined, '', 'has spaces', 'x'.repeat(200), '../etc']) {
        const res = await callRoute(routes, 'POST', path, { body: path.endsWith('input') ? TAP : {}, device });
        assert.equal(res.status, 403, `${path} ${JSON.stringify(device)}`);
        assert.equal(res.error, PHONE_ONLY);
      }
      const noToken = await callRoute(routes, 'POST', path, { body: TAP, device: PHONE, headers: { 'x-plenum-token': 'f'.repeat(64) } });
      assert.equal(noToken.status, 401, 'and the Plenum token is checked as for every route');
    }
    assert.deepEqual(bridge.calls, []);
  });

  test('a frame asks the desktop once for asks that overlap or come within 200 ms, and again after that', async () => {
    const bridge = fakeBrowserBridge();
    bridge.delay = 30;
    bridge.answers['browser-frame'] = () => ({ type: 'browser-frame-result', id: 'x', ok: true, image: 'data:image/jpeg;base64,/9j/', width: 960, height: 540, shown: true });
    const routes = createRoutes(bridge, { events: false, drives: fakeDrives([]) });
    const asks = await Promise.all([1, 2, 3].map(() => callRoute(routes, 'POST', '/api/browser/frame', { body: {}, device: PHONE })));
    assert.ok(asks.every(a => a.status === 200 && a.body.image.startsWith('data:image/jpeg')));
    assert.equal(bridge.calls.length, 1, 'three asks at once, one picture');
    assert.deepEqual(Object.keys(asks[0].body).sort(), ['available', 'height', 'image', 'nextMs', 'ok', 'shown', 'viewers', 'width']);
    assert.equal(asks[0].body.nextMs, 250, 'a phone is told to ask four times a second');
    const early = await callRoute(routes, 'POST', '/api/browser/frame', { body: {}, device: PHONE });
    assert.equal(early.body.cached, true);
    assert.equal(bridge.calls.length, 1, 'inside 200 ms the last picture is the answer');
    await sleep(230);
    const later = await callRoute(routes, 'POST', '/api/browser/frame', { body: {}, device: PHONE });
    assert.equal(later.body.cached, undefined);
    assert.equal(bridge.calls.length, 2);
    const other = await callRoute(routes, 'POST', '/api/browser/frame', { body: { tab: 't2', maxEdge: 400 }, device: PHONE });
    assert.equal(other.status, 200);
    assert.deepEqual(bridge.calls.at(-1).payload, { tab: 't2', maxEdge: 400 });
    assert.equal(bridge.calls.length, 3, 'another tab or size is another picture');
    const second = await callRoute(routes, 'POST', '/api/browser/frame', { body: { tab: 't2', maxEdge: 400 }, device: 'other-phone-0001' });
    assert.equal(second.body.viewers, 2, 'two phones are looking');
  });

  test('a frame is checked before the desktop is asked, and a desktop refusal is a 400 with its sentence', async () => {
    const bridge = fakeBrowserBridge();
    bridge.answers['browser-frame'] = () => ({ ok: false, message: 'The page has nothing to show yet.' });
    const routes = createRoutes(bridge, { events: false, drives: fakeDrives([]) });
    for (const bad of [{ maxEdge: 10 }, { maxEdge: 5000 }, { maxEdge: 'big' }, { maxEdge: 960.5 }, { tab: '../x' }, { tab: 7 }]) {
      assert.equal((await callRoute(routes, 'POST', '/api/browser/frame', { body: bad, device: PHONE })).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(bridge.calls, []);
    const refused = await callRoute(routes, 'POST', '/api/browser/frame', { body: {}, device: PHONE });
    assert.equal(refused.status, 400);
    assert.equal(refused.error, 'The page has nothing to show yet.');
    const plain = createRoutes(fakeBrowserBridge({ available: false }), { events: false, drives: fakeDrives([]) });
    assert.deepEqual((await callRoute(plain, 'POST', '/api/browser/frame', { body: {}, device: PHONE })).body, { available: false });
  });

  test('input is checked field by field before the desktop is asked', async () => {
    const bridge = fakeBrowserBridge();
    const routes = createRoutes(bridge, { events: false, drives: fakeDrives([]) });
    const bad = [
      {}, { kind: 'drag' }, { kind: 7 }, { kind: 'tap' }, { ...TAP, x: -1 }, { ...TAP, x: 401 }, { ...TAP, width: 0 }, { ...TAP, y: 'low' }, { ...TAP, height: Infinity }, { ...TAP, tab: 'a b' },
      { kind: 'scroll', x: 1, y: 1, width: 4, height: 3 }, { kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dy: 'far' }, { kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dx: 0, dy: 0 },
      { kind: 'scroll', x: 9, y: 1, width: 4, height: 3, dy: 5 },
      { kind: 'type' }, { kind: 'type', text: '' }, { kind: 'type', text: 5 }, { kind: 'type', text: 'x'.repeat(1001) },
      { kind: 'key' }, { kind: 'key', key: 'F12' }, { kind: 'key', key: 'a' }, { kind: 'key', key: 'Enter', count: 0 }, { kind: 'key', key: 'Enter', count: 21 }, { kind: 'key', key: 'Enter', count: 1.5 },
    ];
    for (const body of bad) assert.equal((await callRoute(routes, 'POST', '/api/browser/input', { body, device: PHONE })).status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(bridge.calls, []);
    assert.equal((await callRoute(routes, 'POST', '/api/browser/input', { body: [1], device: PHONE })).status, 400, 'a body that is not an object');
  });

  test('each good input reaches the desktop as browser-input with only the fields it needs, and the reply holds none of the text', async () => {
    const bridge = fakeBrowserBridge();
    bridge.answers['browser-input'] = () => ({ type: 'browser-input-result', id: 'x', ok: true, tab: 't1', url: 'https://example.com/', title: 'Example' });
    const routes = createRoutes(bridge, { events: false, drives: fakeDrives([]) });
    const good = [
      [TAP, { kind: 'tap', x: 10, y: 20, width: 400, height: 300, paused: false }],
      [{ ...TAP, tab: 't3', extra: 'dropped' }, { kind: 'tap', tab: 't3', x: 10, y: 20, width: 400, height: 300, paused: false }],
      [{ kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dy: -50.5 }, { kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dy: -50.5, paused: false }],
      [{ kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dx: 3, dy: 2 }, { kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dx: 3, dy: 2, paused: false }],
      [{ kind: 'type', text: 'hunter2 and more' }, { kind: 'type', text: 'hunter2 and more', paused: false }],
      [{ kind: 'key', key: 'Backspace', count: 5 }, { kind: 'key', key: 'Backspace', count: 5, paused: false }],
      [{ kind: 'key', key: 'Enter' }, { kind: 'key', key: 'Enter', paused: false }],
    ];
    for (const [body, payload] of good) {
      const res = await callRoute(routes, 'POST', '/api/browser/input', { body, device: PHONE });
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual(bridge.calls.at(-1), { type: 'browser-input', payload });
      assert.equal(res.body.available, true);
      assert.equal(res.body.url, 'https://example.com/');
      assert.ok(!JSON.stringify(res.body).includes('hunter2'));
    }
    const refusal = fakeBrowserBridge();
    refusal.answers['browser-input'] = () => ({ ok: false, message: 'Tap a text field first.' });
    const again = createRoutes(refusal, { events: false, drives: fakeDrives([]) });
    const refused = await callRoute(again, 'POST', '/api/browser/input', { body: { kind: 'type', text: 'abc' }, device: PHONE });
    assert.deepEqual([refused.status, refused.error], [400, 'Tap a text field first.']);
    const plain = createRoutes(fakeBrowserBridge({ available: false }), { events: false, drives: fakeDrives([]) });
    assert.deepEqual((await callRoute(plain, 'POST', '/api/browser/input', { body: TAP, device: PHONE })).body, { available: false });
  });

  test('the person acts only when the model does not: a running drive is refused, a pause lets the person in, and the desktop is told which', async () => {
    const bridge = fakeBrowserBridge();
    const live = [];
    const routes = createRoutes(bridge, { events: false, drives: fakeDrives(live) });
    const tap = () => callRoute(routes, 'POST', '/api/browser/input', { body: TAP, device: PHONE });
    live.push(drive('running'));
    const running = await tap();
    assert.deepEqual([running.status, running.error], [409, 'The model is using the browser. Pause it first.']);
    assert.deepEqual(bridge.calls, [], 'the desktop is not asked');
    live.splice(0, 1, drive('paused', 'card'));
    assert.equal((await tap()).status, 409, 'a card is waiting');
    assert.deepEqual(bridge.calls, []);
    for (const by of ['user', 'model', 'input']) {
      live.splice(0, 1, drive('paused', by));
      assert.equal((await tap()).status, 200, `paused by ${by}`);
      assert.equal(bridge.calls.at(-1).payload.paused, true, 'the desktop is told the model is paused');
    }
    live.splice(0, 1, drive('running', null, 'computer'));
    assert.equal((await tap()).status, 200, 'a computer run does not stop the browser');
    assert.equal(bridge.calls.at(-1).payload.paused, false);
    live.length = 0;
    assert.equal((await tap()).status, 200, 'no drive, no pause needed');
    assert.equal(bridge.calls.at(-1).payload.paused, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (5) The computer routes with a fake computer driver

const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const PLENUM = 'C:\\Users\\will\\AppData\\Local\\Programs\\Plenum\\Plenum.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEEPASS = 'C:\\Program Files\\KeePass\\KeePass.exe';
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function fakeDriver() {
  const d = {
    available: true,
    inputs: [],
    focused: [],
    captures: 0,
    secureAsked: 0,
    front: { id: 'w1', title: 'Untitled', exe: NOTEPAD, own: false, elevated: false },
    // Topmost first, in physical pixels: Notepad covers the display except a Plenum window in the corner and a password manager strip.
    stack: [
      { id: 'w9', exe: PLENUM, bounds: { x: 1900, y: 0, width: 100, height: 100 } },
      { id: 'w8', exe: KEEPASS, bounds: { x: 0, y: 900, width: 2100, height: 100 } },
      { id: 'w7', exe: CHROME, bounds: { x: 1500, y: 0, width: 300, height: 300 } },
      { id: 'w1', exe: NOTEPAD, bounds: { x: 100, y: 50, width: 2000, height: 1000 } },
    ],
    list: [{ id: 'w9', exe: PLENUM, own: true }, { id: 'w1', exe: NOTEPAD }],
    inputDelay: 0,
    inputResult: { ok: true },
    async foreground() { return d.front; },
    async windows(opts) { return opts?.all ? d.stack : d.list; },
    async focus(id) { d.focused.push(id); return { ok: true }; },
    async capture() { d.captures += 1; return { ok: true, png: PNG_B, width: 1000, height: 500, physical: { x: 100, y: 50, width: 2000, height: 1000 }, scale: { x: 2, y: 2 } }; },
    async input(action) {
      if (d.inputDelay) await sleep(d.inputDelay);
      d.inputs.push(action);
      return d.inputResult;
    },
    async isSecureField() { d.secureAsked += 1; throw new Error('a phone\'s typing does not ask whether a field is a password field'); },
  };
  return d;
}

function fakeRun(extra = {}) {
  const settings = {
    scope: 'window', target: 'w1', targetWindow: { id: 'w1', exe: NOTEPAD, title: 'Untitled' }, unknownApps: 'refuse', maxEdge: 1280, allow: [{ id: 'w1', exe: NOTEPAD, title: 'Untitled' }], ...extra,
  };
  // Frozen: nothing a phone does may write to the run (no action is counted, no frame is changed).
  return Object.freeze({ settings: Object.freeze(settings), allow: Object.freeze([...settings.allow]), frame: Object.freeze({ n: 3 }), handoverWindow: null });
}

describe('the computer routes (fake computer driver, real drive registry)', () => {
  const A = 'phone-a-0001';
  const B = 'phone-b-0002';
  let seq = 0;
  let driver;
  let run;
  let live;
  let routes;
  let clock;
  let waits;

  const setup = (runExtra = {}, options = {}) => {
    driver = options.driver ?? fakeDriver();
    run = fakeRun(runExtra);
    clock = 1_000_000;
    waits = 0;
    live = startDrive({ kind: 'computer', projectId: `rc-${++seq}`, label: 'Notepad', limits: { idleMs: 3_600_000 }, hotkey: false });
    routes = createControlRoutes({
      driver, shell: options.shell ?? { available: () => false }, now: () => clock, wait: options.wait ?? (async () => { waits += 1; }),
    });
  };
  const teardown = () => { try { live?.stop('user'); } catch { /* already stopped */ } };
  const call = (path, body, device = A, extra = {}) => callRoute(routes, 'POST', path, {
    body, device, ...extra,
  });
  const withRun = (path, body, device = A) => {
    const route = routes.find(r => r.path === path);
    return (async () => {
      let out = null;
      const ctx = {
        req: { headers: { 'x-plenum-token': GOOD_TOKEN, ...(device ? { 'x-plenum-device': device } : {}) } }, res: {}, json: (_r, status, payload) => { out = { status, body: payload }; return out; },
        readBody: async () => body, httpError, computerRun: id => (id === live.id ? run : null),
      };
      try {
        await route.handler(ctx);
      } catch (err) {
        return { status: err.status ?? 500, error: err.message };
      }
      return out;
    })();
  };
  const takeover = (device = A) => withRun('/api/computer/takeover', { id: live.id }, device);
  const picture = (device = A) => withRun('/api/computer/live', { id: live.id }, device);
  const input = (body, device = A) => withRun('/api/computer/input', { id: live.id, ...body }, device);
  const TAP_MID = { kind: 'tap', x: 250, y: 125, width: 500, height: 250 };

  test('the three routes answer 403 to a request that did not come through the Bridge, before anything else', async () => {
    setup();
    try {
      for (const device of [null, '', 'bad id', 'x'.repeat(200)]) {
        for (const [path, body] of [['/api/computer/takeover', { id: live.id }], ['/api/computer/live', { id: live.id }], ['/api/computer/input', { id: live.id, ...TAP_MID }]]) {
          const res = await withRun(path, body, device);
          assert.equal(res.status, 403, `${path} ${JSON.stringify(device)}`);
          assert.equal(res.error, PHONE_ONLY);
        }
      }
      assert.equal(live.state, 'running', 'the run was not paused by a request that was refused');
      assert.deepEqual([driver.inputs.length, driver.captures, driver.focused.length], [0, 0, 0]);
    } finally { teardown(); }
  });

  test('take over pauses the run as the person\'s pause, puts the run\'s window in front, and answers the run', async () => {
    setup();
    try {
      assert.equal(live.state, 'running');
      const res = await takeover();
      assert.equal(res.status, 200);
      assert.equal(res.body.takeover, true);
      assert.equal(res.body.drive.state, 'paused');
      assert.equal(res.body.drive.pausedBy, 'user');
      assert.equal(live.state, 'paused');
      assert.deepEqual(driver.focused, ['w1']);
      assert.equal(waits, 1, 'a step the model had begun is given a moment to finish');
      const again = await takeover();
      assert.equal(again.status, 200, 'taking over a run that is already paused changes nothing');
      assert.equal(live.pausedBy, 'user');
    } finally { teardown(); }
  });

  test('a run the person already paused, or the model paused for a hand-over, can be taken over; one waiting for a card cannot', async () => {
    setup();
    try {
      live.pause('model', 'Enter the 2FA code');
      assert.equal((await takeover()).status, 200);
      assert.equal(live.pausedBy, 'model', 'the model\'s hand-over is not turned into the person\'s pause');
      live.resume('user');
      live.pause('card');
      const card = await takeover();
      assert.deepEqual([card.status, card.error], [409, 'A card is waiting for your answer. Answer it first, or press Stop.']);
    } finally { teardown(); }
  });

  test('a run that is gone, or whose screen this server cannot reach, is a sentence and pauses nothing', async () => {
    setup();
    try {
      const gone = await withRun('/api/computer/takeover', { id: 'no-such-run' });
      assert.deepEqual([gone.status, gone.error], [404, 'That run is no longer driving anything.']);
      const bad = await withRun('/api/computer/takeover', {});
      assert.equal(bad.status, 400);
      const other = startDrive({ kind: 'browser', projectId: `rc-b-${seq}`, label: 'b', limits: { idleMs: 3_600_000 }, hotkey: false });
      try {
        const browserRun = await withRun('/api/computer/takeover', { id: other.id });
        assert.equal(browserRun.status, 404, 'a browser drive is not a computer run');
        assert.equal(other.state, 'running', 'and it is not paused');
      } finally { other.stop('user'); }
      const unreachable = await call('/api/computer/takeover', { id: live.id });
      assert.deepEqual([unreachable.status, unreachable.error], [409, 'This run cannot be reached from here.']);
      assert.equal(live.state, 'running');
    } finally { teardown(); }
  });

  test('a picture needs the takeover, is a PNG from a driver without a JPEG encoder, and an ask within 200 ms gets the last one', async () => {
    setup();
    try {
      const early = await picture();
      assert.deepEqual([early.status, early.error], [409, 'Take over the run from your phone first.']);
      await takeover();
      const other = await picture(B);
      assert.equal(other.status, 409, 'another phone holds nothing');
      const one = await picture();
      assert.equal(one.status, 200);
      assert.match(one.body.image, /^data:image\/png;base64,/);
      assert.deepEqual([one.body.width, one.body.height, one.body.nextMs], [1000, 500, 250]);
      assert.equal(driver.captures, 1);
      const again = await picture();
      assert.equal(again.body.cached, true);
      assert.equal(driver.captures, 1);
      clock += 250;
      await picture();
      assert.equal(driver.captures, 2);
    } finally { teardown(); }
  });

  test('the desktop\'s JPEG is used when it has one, and its refusal falls back to the PNG', async () => {
    const asked = [];
    const shell = {
      available: () => true,
      request: async (type, payload) => { asked.push({ type, payload }); return { ok: true, jpeg: '/9j/4AAQ', width: 800, height: 400, physical: { x: 0, y: 0, width: 1600, height: 800 }, scale: { x: 2, y: 2 } }; },
    };
    setup({}, { shell });
    try {
      await takeover();
      const one = await picture();
      assert.match(one.body.image, /^data:image\/jpeg;base64,\/9j\/4AAQ$/);
      assert.deepEqual([one.body.width, one.body.height], [800, 400]);
      assert.deepEqual(asked[0].payload, { scope: 'window', target: 'w1', maxEdge: 1280, quality: 60 });
      assert.equal(asked[0].type, 'computer-live-frame');
      assert.equal(driver.captures, 0, 'the driver was not asked');
      shell.request = async () => ({ ok: false, reason: 'unsupported', message: 'This computer cannot make a JPEG.' });
      clock += 300;
      const fallback = await picture();
      assert.match(fallback.body.image, /^data:image\/png/);
      assert.equal(driver.captures, 1);
    } finally { teardown(); }
  });

  test('a tap lands where the picture says: the picture\'s point, the capture\'s scale and the window\'s place on the screen', async () => {
    setup();
    try {
      await takeover();
      const before = await input(TAP_MID);
      assert.deepEqual([before.status, before.error], [409, 'Wait for the picture to load, then try again.']);
      await picture();
      // The phone shows the 1000x500 picture at 500x250. Its middle is (500, 250) in the picture, and the capture is 2 screen pixels to
      // each, starting at (100, 50): 100 + 500 * 2 and 50 + 250 * 2.
      const res = await input(TAP_MID);
      assert.equal(res.status, 200);
      assert.equal(res.body.app, 'Notepad');
      assert.deepEqual(driver.inputs, [{ kind: 'click', button: 'left', count: 1, x: 1100, y: 550 }]);
      await input({ kind: 'tap', x: 0, y: 0, width: 500, height: 250, button: 'right', count: 2 });
      assert.deepEqual(driver.inputs.at(-1), { kind: 'click', button: 'right', count: 2, x: 100, y: 50 });
      assert.equal(JSON.stringify(res).includes('1100'), false, 'the answer says nothing about the screen');
    } finally { teardown(); }
  });

  test('typing and keys go to the program in front as the person\'s own, a password field included, and the answer holds none of the text', async () => {
    setup();
    try {
      await takeover();
      const typed = await input({ kind: 'type', text: 'hunter2-secret' });
      assert.equal(typed.status, 200);
      assert.deepEqual(driver.inputs, [{ kind: 'type', text: 'hunter2-secret' }]);
      assert.ok(!JSON.stringify(typed).includes('hunter2'));
      assert.equal(driver.secureAsked, 0, 'a phone\'s typing never asks whether a field is a password field: it is the person\'s own');
      await input({ kind: 'key', key: 'Enter' });
      await input({ kind: 'key', key: 'Backspace', count: 4 });
      await input({ kind: 'key', key: 'ArrowLeft' });
      assert.deepEqual(driver.inputs.slice(1), [
        { kind: 'key', keys: ['enter'], repeat: 1 }, { kind: 'key', keys: ['backspace'], repeat: 4 }, { kind: 'key', keys: ['left'], repeat: 1 },
      ]);
    } finally { teardown(); }
  });

  test('a swipe is a scroll of the dominant direction, by a share of the picture', async () => {
    setup();
    try {
      await takeover();
      await picture();
      await input({ kind: 'scroll', x: 250, y: 125, width: 500, height: 250, dy: 100 });
      await input({ kind: 'scroll', x: 250, y: 125, width: 500, height: 250, dy: -25 });
      await input({ kind: 'scroll', x: 250, y: 125, width: 500, height: 250, dx: 250, dy: 10 });
      await input({ kind: 'scroll', x: 250, y: 125, width: 500, height: 250, dx: -5 });
      await input({ kind: 'scroll', x: 250, y: 125, width: 500, height: 250, dy: 100000 });
      const scrolls = driver.inputs.map(a => [a.direction, a.amount, a.x, a.y]);
      assert.deepEqual(scrolls, [['down', 8, 1100, 550], ['up', 2, 1100, 550], ['right', 10, 1100, 550], ['left', 1, 1100, 550], ['down', 50, 1100, 550]]);
    } finally { teardown(); }
  });

  test('what a phone may not do: Plenum\'s own window, a password manager, a program the run does not use, an administrator window', async () => {
    setup();
    try {
      await takeover();
      await picture();
      // Screen points inside each stacked window, as picture points: screen = 100 + 2x, 50 + 2y.
      const at = (sx, sy) => ({ kind: 'tap', x: (sx - 100) / 2 / 2, y: (sy - 50) / 2 / 2, width: 500, height: 250 });
      const plenum = await input(at(1950, 50));
      assert.equal(plenum.status, 409);
      assert.match(plenum.error, /Plenum window/);
      const manager = await input(at(500, 950));
      assert.equal(manager.status, 409);
      assert.match(manager.error, /never acts in that program/);
      const chrome = await input(at(1600, 100));
      assert.equal(chrome.status, 409);
      assert.match(chrome.error, /Chrome is not one of the programs this run uses/);
      assert.deepEqual(driver.inputs, [], 'none of the three reached the driver');
      driver.front = { ...driver.front, elevated: true };
      const admin = await input({ kind: 'key', key: 'Enter' });
      assert.equal(admin.status, 409);
      assert.match(admin.error, /administrator/);
      driver.front = { id: 'w9', exe: PLENUM, own: true, title: 'Plenum' };
      const own = await input({ kind: 'key', key: 'Enter' });
      assert.equal(own.status, 409, 'Plenum in front is brought back to the run\'s window once, and refused if it is still there');
      assert.ok(driver.focused.filter(id => id === 'w1').length >= 2);
      driver.front = { id: 'w1', exe: NOTEPAD, own: false };
      assert.equal((await input({ kind: 'key', key: 'Enter' })).status, 200);
    } finally { teardown(); }
  });

  test('a run that allows any app lets the phone act in any program except Plenum\'s own and the never-allowed ones', async () => {
    setup({ unknownApps: 'allow' });
    try {
      await takeover();
      await picture();
      const at = (sx, sy) => ({ kind: 'tap', x: (sx - 100) / 4, y: (sy - 50) / 4, width: 500, height: 250 });
      assert.equal((await input(at(1600, 100))).status, 200, 'Chrome');
      assert.equal((await input(at(1950, 50))).status, 409, 'Plenum');
      assert.equal((await input(at(500, 950))).status, 409, 'KeePass');
    } finally { teardown(); }
  });

  test('the takeover ends with Resume, a card, Stop or another phone, and a new pause is not a new takeover', async () => {
    setup();
    try {
      await takeover();
      await picture();
      assert.equal((await input({ kind: 'key', key: 'Tab' })).status, 200);
      live.resume('user');
      const afterResume = await input({ kind: 'key', key: 'Tab' });
      assert.deepEqual([afterResume.status, afterResume.error], [409, 'Take over the run from your phone first.']);
      live.pause('user');
      assert.equal((await input({ kind: 'key', key: 'Tab' })).status, 409, 'paused again at the desktop: the phone has not taken it over again');
      assert.equal((await takeover(B)).status, 200);
      assert.equal((await input({ kind: 'key', key: 'Tab' }, A)).status, 409, 'phone A lost it to phone B');
      assert.equal((await input({ kind: 'key', key: 'Tab' }, B)).status, 200);
      live.resume('user');
      live.pause('card');
      const card = await input({ kind: 'key', key: 'Tab' }, B);
      assert.equal(card.status, 409);
      live.resume('card');
      live.stop('user');
      const stopped = await input({ kind: 'key', key: 'Tab' }, B);
      assert.equal(stopped.status, 404);
    } finally { teardown(); }
  });

  test('the model\'s record of the run is untouched: the run object is frozen, and nothing a phone does is a step or a screenshot of the run', async () => {
    setup();
    try {
      await takeover();
      await picture();
      await input(TAP_MID);
      await input({ kind: 'type', text: 'abc' });
      assert.equal(live.steps, 0, 'no step was counted');
      assert.deepEqual(run.frame, { n: 3 }, 'the run\'s frame is the one the model took');
    } finally { teardown(); }
  });

  // wave 121 (Fable review): the phone's hold is looked at once more in the tick the input is handed to the driver, and the takeover gives the
  // hold only after the model's last input has landed.
  test('a Resume, a Stop or a card that comes while an input is being checked wins: nothing is sent, and the run is not touched', async () => {
    const bodies = [{ ...TAP_MID }, { kind: 'type', text: 'abc' }, { kind: 'key', key: 'Enter' }];
    for (const body of bodies) {
      for (const meanwhile of ['resume', 'card', 'stop']) {
        setup();
        try {
          await takeover();
          await picture();
          // gate() awaits the program in front and the window list before the input is sent; the person acts on the desktop in that moment.
          const windows = driver.windows;
          driver.windows = async opts => {
            driver.windows = windows;
            if (meanwhile === 'resume') live.resume('user');
            else if (meanwhile === 'card') { live.resume('user'); live.pause('card'); } else live.stop('user');
            return windows(opts);
          };
          const res = await input(body);
          assert.equal(res.status, 409, `${body.kind} after ${meanwhile}: ${JSON.stringify(res)}`);
          assert.equal(res.error, 'Take over the run from your phone first.');
          assert.deepEqual(driver.inputs, [], `${body.kind} after ${meanwhile}: the input was sent to a screen the model may be using`);
          if (meanwhile === 'resume') assert.equal(live.state, 'running');
        } finally { teardown(); }
      }
    }
  });

  test('a type or a key is not accepted while the model\'s last input may still be landing, and the hold comes when it has', async () => {
    let landed;
    const idle = new Promise(resolve => { landed = resolve; });
    setup({}, { wait: () => new Promise(() => {}) });
    run = Object.freeze({ ...run, idle: () => idle });
    try {
      const taking = takeover();
      await sleep(30);
      assert.equal(live.state, 'paused', 'the run is paused at once');
      for (const body of [{ kind: 'type', text: 'abc' }, { kind: 'key', key: 'Enter' }]) {
        const early = await input(body);
        assert.deepEqual([early.status, early.error], [409, 'Take over the run from your phone first.'], body.kind);
      }
      assert.equal((await picture()).status, 409, 'and no picture');
      assert.deepEqual(driver.inputs, [], 'nothing reached the screen before the model\'s input had landed');
      landed();
      const done = await taking;
      assert.equal(done.status, 200);
      assert.equal((await input({ kind: 'type', text: 'abc' })).status, 200);
      assert.deepEqual(driver.inputs, [{ kind: 'type', text: 'abc' }]);
    } finally { landed(); teardown(); }
  });

  test('a takeover that is resumed, or sent to a card, before the model\'s input has landed gives no hold', async () => {
    for (const meanwhile of ['resume', 'card']) {
      let landed;
      const idle = new Promise(resolve => { landed = resolve; });
      setup({}, { wait: () => new Promise(() => {}) });
      run = Object.freeze({ ...run, idle: () => idle });
      try {
        const taking = takeover();
        await sleep(30);
        live.resume('user');
        if (meanwhile === 'card') live.pause('card');
        landed();
        const res = await taking;
        assert.equal(res.status, 409, meanwhile);
        assert.equal(res.error, meanwhile === 'card' ? 'A card is waiting for your answer. Answer it first, or press Stop.' : 'The run was resumed before the takeover finished. Take over again.');
        const after = await input({ kind: 'key', key: 'Enter' });
        assert.equal(after.status, 409, 'and the phone holds nothing');
        assert.deepEqual(driver.inputs, []);
      } finally { landed(); teardown(); }
    }
  });

  test('every input is checked before the driver is asked, and a driver refusal is a sentence', async () => {
    setup();
    try {
      await takeover();
      await picture();
      const bad = [
        {}, { kind: 'drag' }, { kind: 'tap' }, { ...TAP_MID, x: -1 }, { ...TAP_MID, x: 501 }, { ...TAP_MID, width: 0 }, { ...TAP_MID, button: 'middle' }, { ...TAP_MID, count: 3 },
        { kind: 'scroll', x: 1, y: 1, width: 4, height: 3 }, { kind: 'scroll', x: 1, y: 1, width: 4, height: 3, dy: 'far' },
        { kind: 'type' }, { kind: 'type', text: '' }, { kind: 'type', text: 'a\nb' }, { kind: 'type', text: 'a\u0007' }, { kind: 'type', text: 'x'.repeat(1001) },
        { kind: 'key', key: 'F4' }, { kind: 'key', key: 'ctrl+a' }, { kind: 'key', key: 'Enter', count: 21 },
      ];
      for (const body of bad) assert.equal((await input(body)).status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(driver.inputs, []);
      driver.inputResult = { ok: false, message: 'The window in front belongs to a program running as administrator. Plenum cannot control it.' };
      const refused = await input({ kind: 'key', key: 'Enter' });
      assert.deepEqual([refused.status, refused.error], [409, driver.inputResult.message]);
    } finally { teardown(); }
  });

  test('inputs from one takeover are sent one at a time, in the order they arrived', async () => {
    setup();
    try {
      await takeover();
      driver.inputDelay = 25;
      const sent = await Promise.all(['Home', 'End', 'Tab', 'Escape'].map(key => input({ kind: 'key', key })));
      assert.ok(sent.every(r => r.status === 200));
      assert.deepEqual(driver.inputs.map(a => a.keys[0]), ['home', 'end', 'tab', 'escape']);
    } finally { teardown(); }
  });

  test('a picture older than a minute is not a place to tap', async () => {
    setup();
    try {
      await takeover();
      await picture();
      clock += 61_000;
      const stale = await input(TAP_MID);
      assert.deepEqual([stale.status, stale.error], [409, 'Wait for the picture to load, then try again.']);
      await picture();
      assert.equal((await input(TAP_MID)).status, 200);
    } finally { teardown(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (6) The whole chain against a sealed server with a fake desktop shell

describe('the whole chain: phone, Bridge, server, fake desktop', { skip: SEALED ? false : 'only inside the sealed runner (node build/mobile/run.mjs)' }, () => {
  let server;
  let bridge;
  let session;
  let lowSession;
  let low;
  let phoneId;
  const seen = { frame: [], input: [], bounds: [] };
  const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';

  before(async () => {
    server = await startSealedServer({ name: 'rc', ipc: true, projects: ['p1', 'p2'] });
    server.shell.handlers['browser-frame'] = msg => { seen.frame.push(msg); return { ok: true, tab: 't1', image: JPEG, width: 960, height: 540, shown: true }; };
    server.shell.handlers['browser-input'] = msg => { seen.input.push(msg); return { ok: true, tab: 't1', url: 'https://example.com/', title: 'Example' }; };
    server.shell.handlers['browser-bounds'] = msg => { seen.bounds.push(msg); return { ok: true, shown: true, image: JPEG }; };
    bridge = await makeBridge({ upstream: { port: server.port }, token: server.token, loadUiManifest: async () => { throw new Error('no ui-manifest.mjs'); } });
    const phone = createPhone({ name: 'Android phone', platform: 'android', app: 'pwa', caps: ['ui-from-desktop', 'artifacts-iframe', 'push-webpush'] });
    low = createPhone({ name: 'Spare phone', platform: 'android', app: 'pwa' });
    ({ session } = await bridge.pairPhone(phone));
    ({ session: lowSession } = await bridge.pairPhone(low));
    phoneId = phone.id;
  });
  after(async () => {
    session?.close();
    lowSession?.close();
    await bridge?.close();
    await server?.stop();
  });

  test('a phone gets a JPEG frame of the page, at most five a second, and the desktop is asked only for the pictures that are made', async () => {
    const one = await session.request('POST', '/api/browser/frame', { body: {} });
    assert.equal(one.status, 200, one.text());
    const body = one.json();
    assert.equal(body.available, true);
    assert.equal(body.image, JPEG);
    assert.deepEqual([body.width, body.height, body.shown, body.viewers, body.nextMs], [960, 540, true, 1, 250]);
    const [two, three] = await Promise.all([session.request('POST', '/api/browser/frame', { body: {} }), session.request('POST', '/api/browser/frame', { body: {} })]);
    assert.equal(two.json().cached, true);
    assert.equal(three.json().cached, true);
    assert.equal(seen.frame.length, 1, 'three asks inside 200 ms, one picture');
    assert.equal(seen.frame[0].type, 'browser-frame');
    await sleep(230);
    await session.request('POST', '/api/browser/frame', { body: { maxEdge: 640 } });
    assert.equal(seen.frame.length, 2);
    assert.equal(seen.frame[1].maxEdge, 640);
  });

  test('a tap, a swipe, typing and a key reach the desktop as browser-input, and the typed text is in no answer', async () => {
    const tap = await session.request('POST', '/api/browser/input', { body: { kind: 'tap', x: 100, y: 75, width: 400, height: 300 } });
    assert.equal(tap.status, 200, tap.text());
    assert.equal(tap.json().url, 'https://example.com/');
    const typed = await session.request('POST', '/api/browser/input', { body: { kind: 'type', text: 'hunter2-typed' } });
    assert.equal(typed.status, 200);
    assert.ok(!typed.text().includes('hunter2'));
    await session.request('POST', '/api/browser/input', { body: { kind: 'key', key: 'Backspace', count: 3 } });
    await session.request('POST', '/api/browser/input', { body: { kind: 'scroll', x: 5, y: 5, width: 10, height: 10, dy: 4 } });
    assert.deepEqual(seen.input.map(m => [m.type, m.kind]), [['browser-input', 'tap'], ['browser-input', 'type'], ['browser-input', 'key'], ['browser-input', 'scroll']]);
    assert.deepEqual(seen.input[0], { ...seen.input[0], kind: 'tap', x: 100, y: 75, width: 400, height: 300, paused: false });
    assert.equal(seen.input[1].text, 'hunter2-typed', 'it reaches the page, and only there');
    assert.ok(!JSON.stringify(bridge.remote.activity()).includes('hunter2'));
    const lines = bridge.remote.activity().map(a => a.text);
    assert.ok(lines.includes('tapped in the browser') && lines.includes('typed in the browser') && lines.includes('watched the browser live'));
  });

  test('the same routes asked directly with the token, as the desktop page or a model\'s tool would, are refused and the desktop hears nothing', async () => {
    const before = seen.input.length + seen.frame.length;
    for (const [path, body] of Object.entries(BODIES)) {
      const res = await server.post(path, body);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error, PHONE_ONLY);
    }
    const forged = await server.post('/api/browser/input', TAP, { 'x-plenum-device': 'not a device!' });
    assert.equal(forged.status, 403);
    assert.equal(seen.input.length + seen.frame.length, before);
  });

  test('a Read-only phone is refused at the Bridge, and a run that is not there is a 404 for a Full phone', async () => {
    await bridge.remote.setTier(low.id, 'read');
    const before = seen.input.length;
    const refused = await lowSession.request('POST', '/api/browser/input', { body: TAP });
    assert.equal(refused.status, 403);
    assert.equal(refused.json().error, REFUSAL_TEXT);
    assert.equal(seen.input.length, before);
    for (const path of ['/api/computer/takeover', '/api/computer/live', '/api/computer/input']) {
      const res = await session.request('POST', path, { body: { id: 'no-such-run', ...(path.endsWith('input') ? TAP : {}) } });
      assert.equal(res.status, 404, path);
      assert.equal(res.json().error, 'That run is no longer driving anything.');
    }
  });

  // wave 121 (Fable review): public/app.js shows "Switched to <project> from <phone>" on the 'project' event, which nothing published.
  test('a phone that switches the project is published on the events channel with its own id; a desktop switch and a repeat are silent', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { headers: server.headers, signal: ctrl.signal });
    const heard = [];
    const reading = (async () => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let end;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, end).split('\n').find(l => l.startsWith('data:'));
          buf = buf.slice(end + 2);
          if (line) heard.push(JSON.parse(line.slice(5)));
        }
      }
    })().catch(() => {});
    try {
      await until(() => heard.some(e => e.type === 'hello'), 'the events stream to open');
      const switches = () => heard.filter(e => e.type === 'project');
      const active = async () => (await server.state()).activeProject;
      // The desktop's own switch, with the token and no device header, is silent as it always was.
      assert.equal((await server.post('/api/settings', { activeProject: 'p2' })).status, 200);
      assert.equal(await active(), 'p2');
      await sleep(250);
      assert.deepEqual(switches(), [], 'a desktop window\'s switch says nothing');
      // A phone asking for the project that is already active changes nothing, so it says nothing.
      assert.equal((await session.request('POST', '/api/settings', { body: { activeProject: 'p2' } })).status, 200);
      await sleep(250);
      assert.deepEqual(switches(), [], 'a repeat is not a switch');
      // A phone that really switches it is named by its own id (the Bridge sets the header; a phone cannot).
      const out = await session.request('POST', '/api/settings', { body: { activeProject: 'p1' } });
      assert.equal(out.status, 200, out.text());
      assert.equal(await active(), 'p1');
      await until(() => switches().length > 0, 'the switch to be published');
      assert.equal(switches().length, 1);
      const { at, ...event } = switches()[0];
      void at;
      assert.deepEqual(event, { type: 'project', action: 'switched', project: 'p1', via: phoneId });
      // Other settings from a phone do not publish one.
      await session.request('POST', '/api/settings', { body: { effort: 'low' } });
      await sleep(250);
      assert.equal(switches().length, 1);
    } finally {
      ctrl.abort();
      await reading;
    }
  });

  test('the covered picture call carries keep to the desktop, so the desktop\'s own page view stays', async () => {
    const res = await session.request('POST', '/api/browser/bounds', { body: { x: 1, y: 2, width: 300, height: 200, visible: true } });
    assert.equal(res.status, 200);
    assert.equal(res.json().image, JPEG);
    assert.deepEqual([seen.bounds.at(-1).visible, seen.bounds.at(-1).snapshot, seen.bounds.at(-1).keep], [false, true, true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (7) The desktop handler that makes the JPEG, and what no model tool may reach

describe('the desktop handler for a run\'s JPEG (fake backend, fake image encoder)', () => {
  const shell = { token: 'cd'.repeat(32) };
  const backendReply = { png: new Uint8Array([1, 2, 3]), width: 800, height: 400, physical: { x: 5, y: 6, width: 1600, height: 800 }, scale: { x: 2, y: 2 }, type: 'computer-capture-result', id: 'q' };
  const factoryFor = (reply, seen = []) => () => ({ handle: async message => { seen.push(message); return reply; }, release: async () => {}, overlay: async () => {} });
  const images = (seen = []) => ({
    createFromBuffer: bytes => ({ isEmpty: () => bytes.length === 0, toJPEG: quality => { seen.push(quality); return Buffer.from([0xff, 0xd8, quality]); } }),
  });

  test('the backend\'s own capture is asked for, and the JPEG comes back in base64 with the picture\'s size and place', async () => {
    const asked = [];
    const qualities = [];
    const handler = computerHandler.createHandler({ factory: factoryFor(backendReply, asked), nativeImage: images(qualities) });
    const reply = await handler.messages['computer-live-frame']({ type: 'computer-live-frame', id: 'q', scope: 'window', target: 'w1', maxEdge: 1000, quality: 55 }, shell);
    assert.equal(reply.ok, true);
    assert.deepEqual([...Buffer.from(reply.jpeg, 'base64')], [0xff, 0xd8, 55]);
    assert.deepEqual([reply.width, reply.height, reply.physical, reply.scale], [800, 400, backendReply.physical, backendReply.scale]);
    assert.deepEqual(asked, [{ type: 'computer-capture', id: 'q', scope: 'window', target: 'w1', maxEdge: 1000 }]);
    assert.equal('type' in reply, false, 'the loader adds the -result type itself');
    assert.equal('png' in reply, false);
    for (const [asked1, expected] of [[5, 30], [500, 90], [undefined, 60], ['high', 60], [60.5, 60]]) {
      qualities.length = 0;
      await handler.messages['computer-live-frame']({ type: 'computer-live-frame', id: 'q', quality: asked1 }, shell);
      assert.equal(qualities[0], expected, `quality ${asked1}`);
    }
  });

  test('a refusal of the backend is passed on, an empty image and a missing encoder are { ok: false }, and the type is not the backend\'s own', async () => {
    const refused = computerHandler.createHandler({ factory: factoryFor({ ok: false, reason: 'blocked', message: 'The screen is locked.', type: 'x', id: 'q' }), nativeImage: images() });
    assert.deepEqual(await refused.messages['computer-live-frame']({ id: 'q' }, shell), { ok: false, reason: 'blocked', message: 'The screen is locked.' });
    const empty = computerHandler.createHandler({ factory: factoryFor({ ...backendReply, png: new Uint8Array(0) }), nativeImage: images() });
    assert.equal((await empty.messages['computer-live-frame']({ id: 'q' }, shell)).ok, false);
    const none = computerHandler.createHandler({ factory: factoryFor(backendReply), nativeImage: null });
    const noEncoder = await none.messages['computer-live-frame']({ id: 'q' }, shell);
    assert.equal(noEncoder.ok, false, 'plain Node has no encoder; the server then asks for the PNG');
    const broken = computerHandler.createHandler({ factory: factoryFor(backendReply), nativeImage: { createFromBuffer: () => { throw new Error('bad'); } } });
    assert.equal((await broken.messages['computer-live-frame']({ id: 'q' }, shell)).ok, false);
    assert.equal(computerHandler.TYPES.includes('computer-live-frame'), false, 'the backend never sees it');
    assert.equal(computerHandler.LIVE_TYPE, 'computer-live-frame');
  });
});

describe('what a model can reach, and the notice', () => {
  const MODEL_FACING = ['lib/browser-tools.mjs', 'lib/mcp-server.mjs', 'lib/routes/mcp.mjs', 'lib/computer/run.mjs', 'lib/computer/claude.mjs', 'lib/computer/openai.mjs', 'lib/computer/gemini.mjs', 'lib/computer/generic.mjs', 'lib/computer/policy.mjs'];

  test('no model-facing file names a person-input route or message, so no tool call can make one', () => {
    for (const file of MODEL_FACING) {
      const text = read(file);
      for (const word of ['browser-input', 'browser-frame', '/api/browser/input', '/api/browser/frame', '/api/computer/input', '/api/computer/live', '/api/computer/takeover', 'computer-live-frame']) {
        assert.equal(text.includes(word), false, `${file} must not name ${word}`);
      }
    }
  });

  test('the desktop\'s model tool for the browser still refuses a password field, and the phone\'s input does not use its code path', () => {
    const desk = read('desktop/browser.cjs');
    assert.ok(desk.includes("return { ok: false, secret: true, message: SECRET_REFUSAL }"), 'browser-act still refuses');
    const person = desk.slice(desk.indexOf('async function personInput'), desk.indexOf('// ---------- messages ----------'));
    assert.ok(person.length > 500);
    for (const word of ['actOnPage', 'SECRET_REFUSAL', 'browser-act', 'type-secret', 'addLog', 'tell(', 'send(']) assert.equal(person.includes(word), false, `personInput must not use ${word}`);
  });

  test('phone-remote-control is live, and within its limits', () => {
    const notice = NOTICES.find(n => n.id === 'phone-remote-control');
    assert.ok(notice);
    assert.equal(notice.status, 'live');
    assert.equal(notice.kind, 'inline');
    assert.equal(notice.tone, 'danger');
    assert.ok(notice.text.length <= 450 && notice.title.length <= 60, `${notice.text.length} / ${notice.title.length}`);
    assert.doesNotMatch(`${notice.title} ${notice.text}`, /!/);
    assert.match(notice.text, /Stop/);
    assert.deepEqual(NOTICES.filter(n => n.status === 'planned').map(n => n.id), ['phone-push-forwarder'], 'the other planned phone notice stays planned');
  });
});
