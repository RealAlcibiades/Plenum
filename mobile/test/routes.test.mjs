// Suite for the phone routes and POST /api/stop-all (mob-05), against sealed servers (node server.mjs on a random port, the real route
// modules, a real token, no real model). Run it through the sealed runner: node build/mobile/run.mjs --id mob-03 routes.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {
  canInstallTestRoutes, freePort, makeBareApp, removeBareApp, sleep, startMockModel, startSealedServer, until,
} from './helpers/sealed-server.mjs';
import { createPhone, decodeLink } from './helpers/phone-sim.mjs';

const { allRoutes, findExtRoute } = await import('../../lib/routes/index.mjs');
const { TERMS, termsGate, TERMS_REQUIRED } = await import('../../lib/legal.mjs');

const COMPUTER_ONLY = 'Add or change phones at the computer.';
const PHONE_ROUTES = [
  ['GET', '/api/phones'], ['POST', '/api/phones/settings'], ['POST', '/api/phones/lan'], ['POST', '/api/phones/tailscale'], ['POST', '/api/phones/relay'], ['POST', '/api/phones/relay/new-room'],
  ['POST', '/api/phones/pair/start'], ['POST', '/api/phones/pair/cancel'], ['POST', '/api/phones/pair/confirm'], ['POST', '/api/phones/remove'],
  ['POST', '/api/phones/remove-all'], ['POST', '/api/phones/tier'], ['POST', '/api/phones/push'], ['POST', '/api/phones/test-push'],
  ['GET', '/api/phones/activity'], ['POST', '/api/artifacts/picture'], ['POST', '/api/stop-all'],
];

const canConnect = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

// A pairing driven through the routes: start, phone, confirm. Returns { phone, session, link, hello }.
async function pairThroughRoutes(server, name = "Will's iPhone", opts = {}) {
  const started = await server.post('/api/phones/pair/start');
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const link = decodeLink(started.body.link);
  const phone = createPhone({ name, platform: 'ios' });
  const paired = await phone.pair(link, opts);
  await until(async () => (await server.get('/api/phones')).body.offer.state === 'confirm', 'the confirm state');
  const confirm = await server.post('/api/phones/pair/confirm', { allow: true });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  const hello = await paired.hello;
  return { phone, session: paired.session, link, hello, paired };
}

describe('the routes are in the table and behind the terms gate', () => {
  test('allRoutes() lists every phone route and Stop all, and each has a handler', () => {
    const table = allRoutes();
    for (const [method, p] of PHONE_ROUTES) {
      assert.ok(table.some(r => r.method === method && r.path === p), `${method} ${p} is registered`);
      assert.equal(typeof findExtRoute(method, p)?.handler, 'function', `${method} ${p} has a handler`);
    }
    for (const r of table.filter(x => x.path.startsWith('/api/phones') && x.method === 'GET')) assert.equal(r.gated, false, `${r.path} reaches no provider, so it is not gated`);
  });

  test('before the License Agreement is accepted every phone POST and Stop all answer 403 with terms: true, and the GETs go through', () => {
    for (const [method, p] of PHONE_ROUTES) {
      const gate = termsGate({ method, pathname: p, route: findExtRoute(method, p), st: {} });
      if (method === 'POST') {
        assert.equal(gate?.status, 403, `${method} ${p}`);
        assert.equal(gate.terms, true);
        assert.equal(gate.message, TERMS_REQUIRED);
      } else {
        assert.equal(gate, null, `${method} ${p} is open`);
      }
    }
    // Acceptance is for the exact texts (27 Oct): the record carries the terms version and the sha256 of both documents.
    const accepted = { legal: { accepted: { version: TERMS.version, eula: TERMS.sha256['EULA.md'], privacy: TERMS.sha256['PRIVACY.md'] } } };
    for (const [method, p] of PHONE_ROUTES) assert.equal(termsGate({ method, pathname: p, route: findExtRoute(method, p), st: accepted }), null, `${method} ${p} after acceptance`);
  });
});

describe('a server that has not accepted the License Agreement', () => {
  let server;
  before(async () => {
    server = await startSealedServer({ name: 'terms', accepted: false });
  });
  after(async () => {
    await server?.stop();
  });

  test('the POSTs are refused with 403 terms: true and the GETs answer', async () => {
    const body = {};
    for (const p of ['/api/phones/settings', '/api/phones/pair/start', '/api/phones/remove', '/api/phones/tier', '/api/stop-all', '/api/artifacts/picture']) {
      const r = await server.post(p, body);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.terms, true, p);
    }
    const list = await server.get('/api/phones');
    assert.equal(list.status, 200);
    assert.equal(list.body.enabled, false);
    assert.equal((await server.get('/api/phones/activity')).status, 200);
    assert.equal((await server.get('/api/state')).body.legal.required, true);
  });
});

describe('the phone routes on plain node', () => {
  let server;
  before(async () => {
    server = await startSealedServer({ name: 'plain', projects: ['p1'] });
  });
  after(async () => {
    await server?.stop();
  });

  const settings = body => server.post('/api/phones/settings', body);

  test('the token is required on every route, GET or POST', async () => {
    for (const [method, p] of PHONE_ROUTES) {
      const res = await fetch(server.url + p, { method, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, `${method} ${p} without a token`);
    }
  });

  test('GET /api/phones starts from the defaults', async () => {
    const r = await server.get('/api/phones');
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.running, false);
    assert.equal(r.body.plainNode, true);
    assert.deepEqual(r.body.devices, []);
    assert.equal(r.body.offer.state, 'idle');
    assert.equal(r.body.offer.active, false);
    assert.equal(r.body.offer.tried, false, 'GET /api/phones tells the window whether a device tried the code');
    assert.equal(r.body.offer.left, false, 'and whether the phone that was waiting left');
    assert.deepEqual(r.body.push, { approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false });
    assert.equal(r.body.autoExpireDays, 0);
    assert.deepEqual(r.body.indicator, { connected: [] });
    assert.equal(typeof r.body.carriers.lan.on, 'boolean');
    assert.equal(r.body.carriers.lan.anyAddress, false);
    assert.equal(typeof r.body.carriers.tailscale.on, 'boolean');
    assert.equal(typeof r.body.carriers.relay.url, 'string');
    assert.equal(await canConnect(Number(r.body.port) || 1), false, 'nothing listens while phones are off');
  });

  test('settings are validated and nothing changes when one is refused', async () => {
    const before = (await server.get('/api/phones')).body;
    for (const bad of [{ enabled: 'yes' }, { enabled: 1 }, { port: 80 }, { port: 70000 }, { port: 'x' }, { port: 12.5 }, { port: server.port }, { autoExpireDays: -1 }, { autoExpireDays: 4000 }, { autoExpireDays: 'x' }, []]) {
      const r = await settings(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
    }
    assert.deepEqual((await server.get('/api/phones')).body.port, before.port);
    assert.equal((await server.get('/api/phones')).body.enabled, false);
  });

  test('turning phones on binds a random high port on loopback, remembers it, and turning them off lets it go', async () => {
    const on = await settings({ enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.running, true);
    const port = on.body.port;
    assert.ok(port >= 49152 && port <= 65535 && port !== server.port, `port ${port}`);
    assert.equal(await canConnect(port), true);
    const saved = JSON.parse(readFileSync(path.join(server.home, 'state.json'), 'utf8')).phones;
    assert.equal(saved.enabled, true);
    assert.equal(saved.port, port);
    assert.ok(existsSync(path.join(server.home, 'phones.json')), 'the keys are in phones.json, not in state.json');
    const stateText = readFileSync(path.join(server.home, 'state.json'), 'utf8');
    const keys = JSON.parse(readFileSync(path.join(server.home, 'phones.json'), 'utf8'));
    assert.match(keys.identity.privateKey, /^[0-9a-f]{64}$/);
    for (const secret of [keys.identity.privateKey, keys.pathKey, server.token]) assert.equal(stateText.includes(secret), false, 'no key, path key or token in state.json');
    // A new port on request, or a chosen one.
    const rerolled = await settings({ rerollPort: true });
    assert.equal(rerolled.status, 200);
    assert.equal(rerolled.body.running, true);
    assert.notEqual(rerolled.body.port, port);
    assert.equal(await canConnect(rerolled.body.port), true);
    await until(async () => !(await canConnect(port)), 'the old port to be free');
    const chosen = await freePort();
    const set = await settings({ port: chosen });
    assert.equal(set.body.port, chosen);
    assert.equal(await canConnect(chosen), true);
    const off = await settings({ enabled: false });
    assert.equal(off.body.running, false);
    assert.equal(await canConnect(chosen), false);
    const again = await settings({ enabled: true });
    assert.equal(again.body.port, chosen, 'the same port comes back');
    assert.equal(again.body.running, true);
    await settings({ enabled: false });
  });

  test('the carrier switches are saved and validated; the relay address must be https and clean', async () => {
    await settings({ enabled: true });
    const lan = await server.post('/api/phones/lan', { enabled: true, anyAddress: true });
    assert.equal(lan.status, 200, JSON.stringify(lan.body));
    assert.equal(lan.body.carriers.lan.on, true);
    assert.equal(lan.body.carriers.lan.anyAddress, true);
    assert.equal((await server.post('/api/phones/lan', { enabled: 'x' })).status, 400);
    assert.equal((await server.post('/api/phones/lan', { anyAddress: 3 })).status, 400);
    assert.equal((await server.post('/api/phones/lan', { enabled: false, anyAddress: false })).body.carriers.lan.on, false);
    assert.equal((await server.post('/api/phones/tailscale', { enabled: true })).body.carriers.tailscale.on, true);
    assert.equal((await server.post('/api/phones/tailscale', { enabled: false })).body.carriers.tailscale.on, false);
    for (const url of ['http://w.a.workers.dev', 'https://user:pw@w.a.workers.dev', 'https://w.a.workers.dev/#x', 'https://localhost', 'ftp://x.y', 'not a url', 5, `https://${'a'.repeat(300)}.example.com`]) {
      assert.equal((await server.post('/api/phones/relay', { url })).status, 400, String(url).slice(0, 40));
    }
    assert.equal((await server.post('/api/phones/relay', { enabled: true })).status, 400, 'a relay with no address cannot be turned on');
    const good = await server.post('/api/phones/relay', { url: ' https://plenum-relay.me.workers.dev/ ', enabled: true });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.carriers.relay.url, 'https://plenum-relay.me.workers.dev');
    assert.equal(good.body.carriers.relay.on, true);
    const cleared = await server.post('/api/phones/relay', { enabled: false, url: '' });
    assert.equal(cleared.body.carriers.relay.url, '');
    await server.post('/api/phones/lan', { enabled: false });
    await settings({ enabled: false });
  });

  test('a new code needs phones to be on, and the confirm route exists under plain node', async () => {
    await settings({ enabled: false });
    const off = await server.post('/api/phones/pair/start');
    assert.equal(off.status, 409);
    assert.match(off.body.error, /Let phones connect/);
    await settings({ enabled: true });
    const nothing = await server.post('/api/phones/pair/confirm', { allow: true });
    assert.equal(nothing.status, 409, 'the route exists; there is just nobody to allow');
    assert.notEqual(nothing.status, 404);
    assert.equal((await server.post('/api/phones/pair/confirm', {})).status, 400);
    assert.equal((await server.post('/api/phones/pair/confirm', { allow: 'yes' })).status, 400);
    const started = await server.post('/api/phones/pair/start');
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.state, 'offer');
    assert.equal(started.body.expiresInS, 120);
    assert.match(started.body.link, /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/#pair=/, 'without a window the link comes back to the token holder');
    assert.ok(Array.isArray(started.body.hints));
    const view = (await server.get('/api/phones')).body;
    assert.equal(view.offer.active, true);
    assert.equal(view.offer.state, 'offer');
    assert.equal('code' in view.offer, false);
    assert.equal(JSON.stringify(view).includes(started.body.link.split('#pair=')[1]), false, 'the page state never holds the link');
    const cancelled = await server.post('/api/phones/pair/cancel');
    assert.deepEqual(cancelled.body, { ok: true });
    assert.equal((await server.get('/api/phones')).body.offer.state, 'idle');
  });

  test('pair/start, pair/cancel, pair/confirm and tier refuse a request that carries x-plenum-device, with the fixed sentence', async () => {
    const asPhone = { 'x-plenum-device': 'ab'.repeat(32) };
    for (const [p, body] of [['/api/phones/pair/start', {}], ['/api/phones/pair/cancel', {}], ['/api/phones/pair/confirm', { allow: true }], ['/api/phones/tier', { id: 'x', tier: 'read' }]]) {
      const r = await server.post(p, body, asPhone);
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.body, { error: COMPUTER_ONLY }, p);
    }
    assert.equal((await server.get('/api/phones')).body.offer.state, 'idle', 'no offer was made');
  });

  test('a phone is paired through the routes: nothing is saved before Allow, the tier can be changed, and removing it closes its channel', async () => {
    const { phone, session, hello } = await pairThroughRoutes(server);
    assert.equal(hello.tier, 'full');
    const list = (await server.get('/api/phones')).body;
    assert.equal(list.devices.length, 1);
    const [device] = list.devices;
    assert.equal(device.id, phone.id);
    assert.equal(device.name, "Will's iPhone");
    assert.equal(device.app, 'pwa', 'each device carries its app, so the window can label a plain-http web page');
    assert.equal(device.connected, true);
    assert.equal(device.tier, 'full');
    assert.deepEqual(list.indicator.connected, ["Will's iPhone"]);
    assert.equal('publicKey' in device, false, 'a device row carries no key material');
    assert.equal(JSON.parse(readFileSync(path.join(server.home, 'phones.json'), 'utf8')).devices.length, 1);
    // Tier changes: validated, then live.
    assert.equal((await server.post('/api/phones/tier', { id: phone.id, tier: 'root' })).status, 400);
    assert.equal((await server.post('/api/phones/tier', { id: 'nobody', tier: 'read' })).status, 404);
    assert.equal((await server.post('/api/phones/tier', { tier: 'read' })).status, 400);
    assert.equal((await server.post('/api/phones/tier', { id: phone.id, tier: 'approve' })).status, 200);
    await until(() => session.events.some(e => e.kind === 'tier' && e.tier === 'approve'), 'the tier event');
    assert.equal((await server.get('/api/phones')).body.devices[0].tier, 'approve');
    // Removal.
    assert.equal((await server.post('/api/phones/remove', { id: 'nobody' })).status, 404);
    assert.equal((await server.post('/api/phones/remove', {})).status, 400);
    const removed = await server.post('/api/phones/remove', { id: phone.id });
    assert.deepEqual(removed.body, { ok: true });
    const closed = await Promise.race([session.closed, sleep(3000).then(() => null)]);
    assert.ok(closed, 'the live channel closed');
    assert.equal((await server.get('/api/phones')).body.devices.length, 0);
    assert.deepEqual((await server.get('/api/phones')).body.indicator.connected, []);
  });

  test('a phone can remove itself at any tier, other phones only with Full control, and the answer is delivered first', async () => {
    const a = await pairThroughRoutes(server, 'Phone A');
    const b = await pairThroughRoutes(server, 'Phone B');
    await server.post('/api/phones/tier', { id: a.phone.id, tier: 'approve' });
    await until(() => a.session.events.some(e => e.kind === 'tier'), 'tier event');
    const other = await a.session.request('POST', '/api/phones/remove', { body: { id: b.phone.id } });
    assert.equal(other.status, 403, 'an approve-tier phone may remove only itself');
    assert.equal((await server.get('/api/phones')).body.devices.length, 2);
    const self = await a.session.request('POST', '/api/phones/remove', { body: { id: a.phone.id } });
    assert.equal(self.status, 200, 'the answer arrives before the channel closes');
    assert.deepEqual(self.json(), { ok: true });
    await until(async () => (await server.get('/api/phones')).body.devices.length === 1, 'the phone to be gone');
    const gone = await server.post('/api/phones/remove', { id: b.phone.id }, { 'x-plenum-device': b.phone.id });
    assert.equal(gone.status, 200);
    await until(async () => (await server.get('/api/phones')).body.devices.length === 0, 'the last phone to be gone');
    const c = await pairThroughRoutes(server, 'Phone C');
    const d = await pairThroughRoutes(server, 'Phone D');
    const full = await c.session.request('POST', '/api/phones/remove', { body: { id: d.phone.id } });
    assert.equal(full.status, 200, 'a Full phone may remove another');
    await until(async () => (await server.get('/api/phones')).body.devices.length === 1, 'D to be gone');
    await server.post('/api/phones/remove-all', {});
  });

  test('Remove all removes every phone and changes the key and the address', async () => {
    const a = await pairThroughRoutes(server, 'One');
    const b = await pairThroughRoutes(server, 'Two');
    const before = JSON.parse(readFileSync(path.join(server.home, 'phones.json'), 'utf8'));
    const done = await server.post('/api/phones/remove-all', {});
    assert.equal(done.status, 200);
    assert.equal(done.body.removed, 2);
    await Promise.all([a.session.closed, b.session.closed]);
    const after = JSON.parse(readFileSync(path.join(server.home, 'phones.json'), 'utf8'));
    assert.notEqual(after.identity.publicKey, before.identity.publicKey);
    assert.notEqual(after.pathKey, before.pathKey);
    assert.deepEqual(after.devices, []);
    assert.equal((await server.get('/api/phones')).body.devices.length, 0);
  });

  // D7 (F4): only the computer changes how phones reach it. A Full phone that could switch phones off, change the carriers or remove every
  // phone would end Stop for all the others. A single phone can still be removed by a Full phone (see the test above).
  test('a phone gets 403 on settings, lan, tailscale, relay, relay/new-room and remove-all; the computer still can', async () => {
    const a = await pairThroughRoutes(server, 'Caller');
    const b = await pairThroughRoutes(server, 'Bystander');
    assert.equal(a.hello.tier, 'full', 'the caller has Full control, which used to be enough');
    const phoneFile = () => JSON.parse(readFileSync(path.join(server.home, 'phones.json'), 'utf8'));
    const before = phoneFile();
    const viewBefore = (await server.get('/api/phones')).body;
    for (const p of ['/api/phones/settings', '/api/phones/lan', '/api/phones/tailscale', '/api/phones/relay', '/api/phones/relay/new-room', '/api/phones/remove-all']) {
      const asPhone = await a.session.request('POST', p, { body: p === '/api/phones/settings' ? { enabled: false } : {} });
      assert.equal(asPhone.status, 403, `${p} from a phone`);
      assert.deepEqual(asPhone.json(), { error: COMPUTER_ONLY }, p);
      // The header the Bridge sets for a phone is what the route reads, so the same refusal comes from a direct request that carries it.
      const direct = await server.post(p, p === '/api/phones/settings' ? { enabled: false } : {}, { 'x-plenum-device': a.phone.id });
      assert.equal(direct.status, 403, `${p} with x-plenum-device`);
      assert.deepEqual(direct.body, { error: COMPUTER_ONLY }, p);
    }
    const viewAfter = (await server.get('/api/phones')).body;
    assert.equal(viewAfter.enabled, true, 'a phone could not switch phones off');
    assert.equal(viewAfter.devices.length, 2, 'a phone could not remove every phone');
    assert.deepEqual(viewAfter.carriers, viewBefore.carriers);
    const after = phoneFile();
    assert.equal(after.identity.publicKey, before.identity.publicKey, 'the computer key was not rotated');
    assert.equal(after.pathKey, before.pathKey);
    assert.deepEqual(after.relay ?? null, before.relay ?? null, 'the relay room was not touched');
    assert.equal(a.session.channel.isClosed, false, 'the caller is still connected');
    // The computer can: the same routes, with the token and no device header.
    assert.equal((await server.post('/api/phones/settings', {})).status, 200);
    assert.equal((await server.post('/api/phones/lan', {})).status, 200);
    assert.equal((await server.post('/api/phones/tailscale', {})).status, 200);
    assert.equal((await server.post('/api/phones/relay', {})).status, 200);
    const done = await server.post('/api/phones/remove-all', {});
    assert.equal(done.status, 200);
    assert.equal(done.body.removed, 2);
    await Promise.all([a.session.closed, b.session.closed]);
    const rotated = await until(() => {
      const saved = phoneFile();
      return saved.identity.publicKey !== before.identity.publicKey ? saved : null;
    }, 'the new key to be saved');
    assert.deepEqual(rotated.devices, []);
    assert.notEqual(rotated.pathKey, before.pathKey);
  });

  test('relay/new-room: 409 with no relay address; from the computer a new room id and host secret, the same body as the relay route', async () => {
    await settings({ enabled: true });
    const none = await server.post('/api/phones/relay/new-room', {});
    assert.equal(none.status, 409, JSON.stringify(none.body));
    assert.deepEqual(none.body, { error: 'Save a relay address first.' });
    assert.equal((await server.post('/api/phones/relay/new-room', 5)).status, 400, 'the body must be a JSON object');
    // An address is saved but the relay stays off: nothing connects anywhere.
    const saved = await server.post('/api/phones/relay', { url: 'https://plenum-relay.me.workers.dev', enabled: false });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const roomOf = () => JSON.parse(readFileSync(path.join(server.home, 'phones.json'), 'utf8')).relay;
    const first = await server.post('/api/phones/relay/new-room', {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.carriers.relay.url, 'https://plenum-relay.me.workers.dev', 'the answer is the relay route\'s: the whole phones view');
    assert.equal(first.body.carriers.relay.on, false);
    assert.equal(Array.isArray(first.body.devices), true);
    const one = roomOf();
    assert.match(one.roomId, /^[0-9a-f]{32}$/);
    assert.match(one.hostSecret, /^[0-9a-f]{64}$/);
    const second = await server.post('/api/phones/relay/new-room', {});
    assert.equal(second.status, 200);
    const two = roomOf();
    assert.notEqual(two.roomId, one.roomId, 'a new room id');
    assert.notEqual(two.hostSecret, one.hostSecret, 'a new host secret');
    assert.equal(JSON.stringify(first.body).includes(one.hostSecret), false, 'the host secret is in no answer');
    assert.equal(JSON.stringify(second.body).includes(two.hostSecret), false);
    await server.post('/api/phones/relay', { enabled: false, url: '' });
  });

  test('notification switches are checked; Approve from a notification needs the first line; a subscription comes only from the phone', async () => {
    const a = await pairThroughRoutes(server, 'Notified');
    for (const bad of [{ approvals: 'yes' }, { firstLine: 1 }, { approveFromNotifications: 'x' }]) {
      assert.equal((await server.post('/api/phones/push', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await server.post('/api/phones/push', { approveFromNotifications: true, id: a.phone.id })).status, 409, 'the first line must be on first');
    const switches = await server.post('/api/phones/push', { firstLine: true, finished: false });
    assert.equal(switches.status, 200);
    assert.deepEqual(switches.body.push, { approvals: true, finished: false, limits: true, onlyWhenAway: true, firstLine: true });
    assert.equal((await server.post('/api/phones/push', { approveFromNotifications: true })).status, 400, 'say which phone');
    assert.equal((await server.post('/api/phones/push', { approveFromNotifications: true, id: a.phone.id })).status, 200);
    assert.equal((await server.get('/api/phones')).body.devices[0].approveFromNotifications, true);
    // The phone itself, through the Bridge, at its own tier.
    const own = await a.session.request('POST', '/api/phones/push', { body: { approveFromNotifications: false } });
    assert.equal(own.status, 200);
    assert.equal((await server.get('/api/phones')).body.devices[0].approveFromNotifications, false);
    const other = await a.session.request('POST', '/api/phones/push', { body: { approveFromNotifications: true, id: 'someone-else' } });
    assert.equal(other.status, 403);
    // A subscription: the desktop cannot make one for a phone; a bad one is refused; a good one is kept and can be dropped.
    const subscription = { endpoint: 'https://push.example.net/send/abc', keys: { p256dh: Buffer.from((() => { const e = createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey(); })()).toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    assert.equal((await server.post('/api/phones/push', { subscription })).status, 400);
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { subscription: { endpoint: 'http://push.example.net/x', keys: {} } } })).status, 400);
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { subscription: 'x' } })).status, 400);
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { subscription } })).status, 200);
    assert.equal((await server.get('/api/phones')).body.devices[0].push, 'webpush');
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { subscription: null } })).status, 200);
    assert.equal((await server.get('/api/phones')).body.devices[0].push, null);
    // The test notification skips a phone with no subscription, and says so.
    const test = await server.post('/api/phones/test-push', {});
    assert.equal(test.status, 200);
    assert.deepEqual(test.body.results.map(r => [r.outcome, r.reason]), [['skipped', 'no-subscription']]);
    // The five switches are desktop-wide: a phone below Full control is refused and nothing changes. A read-only phone may not turn on
    // Approve from a notification either.
    await server.post('/api/phones/tier', { id: a.phone.id, tier: 'read' });
    await until(() => a.session.events.some(e => e.kind === 'tier' && e.tier === 'read'), 'read tier event');
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { finished: true } })).status, 403);
    assert.equal((await server.get('/api/phones')).body.push.finished, false, 'the desktop-wide switch did not change');
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { approveFromNotifications: true } })).status, 403);
    // An Approve-and-watch phone is refused the desktop-wide switches, but may set its own Approve from a notification.
    await server.post('/api/phones/tier', { id: a.phone.id, tier: 'approve' });
    await until(() => a.session.events.some(e => e.kind === 'tier' && e.tier === 'approve'), 'approve tier event');
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { limits: false } })).status, 403);
    assert.equal((await server.get('/api/phones')).body.push.limits, true, 'the desktop-wide switch did not change');
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { approveFromNotifications: true } })).status, 200);
    // A Full phone may change the desktop-wide switches.
    await server.post('/api/phones/tier', { id: a.phone.id, tier: 'full' });
    await until(() => a.session.events.some(e => e.kind === 'tier' && e.tier === 'full'), 'full tier event');
    assert.equal((await a.session.request('POST', '/api/phones/push', { body: { finished: true } })).status, 200);
    assert.equal((await server.get('/api/phones')).body.push.finished, true);
    await server.post('/api/phones/remove-all', {});
  });

  test('the activity list says what a phone did, newest first', async () => {
    const a = await pairThroughRoutes(server, 'Activist');
    await a.session.request('POST', '/api/cancel', { body: { project: 'p1' } });
    await a.session.request('POST', '/api/stop-all', { body: {} });
    await until(async () => (await server.get('/api/phones/activity')).body.activity.length >= 2, 'two activity lines');
    const { activity } = (await server.get('/api/phones/activity')).body;
    assert.equal(activity[0].device, 'Activist');
    assert.ok(activity.some(x => x.text === 'cancelled a run'));
    assert.ok(activity.some(x => x.text === 'stopped everything'));
    for (const entry of activity) assert.deepEqual(Object.keys(entry).sort(), ['at', 'device', 'text']);
    const saved = JSON.parse(readFileSync(path.join(server.home, 'state.json'), 'utf8')).phones.activity;
    assert.ok(saved.length >= 2, 'kept in state.json');
    await server.post('/api/phones/remove-all', {});
  });

  test('a picture of an artifact needs the desktop app', async () => {
    const bad = await server.post('/api/artifacts/picture', { id: 'x' });
    assert.equal(bad.status, 400);
    assert.equal((await server.post('/api/artifacts/picture', {})).status, 400);
    const none = await server.post('/api/artifacts/picture', { id: 'abcdef12-3456' });
    assert.equal(none.status, 503);
    assert.equal(none.body.error, 'This needs the desktop app.');
  });
});

describe('a server that starts the Bridge from its saved settings', () => {
  test('phones that were on are on again 2 seconds after the server starts, on the saved port', async () => {
    const port = await freePort();
    const server = await startSealedServer({ name: 'lazy', phones: { enabled: true, port } });
    try {
      await until(() => canConnect(port), 'the Bridge to listen', 8000, 100);
      const view = (await server.get('/api/phones')).body;
      assert.equal(view.running, true);
      assert.equal(view.port, port);
    } finally {
      await server.stop();
    }
  });
});

describe('under the desktop app (a fake shell on the message channel)', () => {
  let server;
  before(async () => {
    server = await startSealedServer({ name: 'desktop', ipc: true, phones: { enabled: true } });
    await until(async () => (await server.get('/api/phones')).body.running, 'the Bridge to run');
  });
  after(async () => {
    await server?.stop();
  });

  test('the confirm route does not exist; the keys go through the shell and are never written as a file', async () => {
    const r = await server.post('/api/phones/pair/confirm', { allow: true });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'No such route.');
    assert.equal((await server.get('/api/phones')).body.plainNode, false);
    assert.ok(server.shell.store.length > 0, 'the registry text went to phones-store-save');
    assert.equal(existsSync(path.join(server.home, 'phones.json')), false, 'no phones.json under the desktop app');
    assert.equal(JSON.parse(server.shell.store).v, 1);
  });

  test('pair/start answers without the link; the window gets it; Allow is the window\'s answer', async () => {
    const started = await server.post('/api/phones/pair/start');
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal('link' in started.body, false);
    assert.equal(JSON.stringify(started.body).includes('#pair='), false);
    await until(() => server.shell.pairShows.length >= 1, 'phones-pair-show');
    const show = server.shell.pairShows.at(-1);
    assert.equal(show.state, 'offer');
    const link = decodeLink(show.link);
    const phone = createPhone({ name: 'Desktop-paired' });
    const paired = await phone.pair(link);
    await until(() => server.shell.pairShows.some(s => s.state === 'confirm'), 'the confirm state');
    const view = (await server.get('/api/phones')).body;
    assert.equal('code' in view.offer, false, 'the page does not get the code');
    assert.equal(server.shell.pairShows.find(s => s.state === 'confirm').code, paired.code, 'the window does');
    assert.equal((await server.get('/api/phones')).body.devices.length, 0);
    server.shell.send('phones-pair-answer', { offer: show.offer, action: 'allow' });
    await paired.hello;
    assert.equal((await server.get('/api/phones')).body.devices[0].name, 'Desktop-paired');
    assert.equal(JSON.parse(server.shell.store).devices.length, 1, 'saved through the shell');
    assert.ok(server.shell.messages.some(m => m.type === 'phones-indicator' && m.connected.includes('Desktop-paired')));
    paired.session.close();
  });

  test('a picture of an artifact comes from the shell, or its sentence', async () => {
    server.shell.handlers['phones-artifact-picture'] = () => ({ ok: true, png: 'data:image/png;base64,iVBORw0KGgo=' });
    const ok = await server.post('/api/artifacts/picture', { id: 'abcdef12-3456-7890' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { png: 'data:image/png;base64,iVBORw0KGgo=' });
    // The desktop handler (desktop/handlers/phones.cjs artifactPicture) reads message.artifact: shellRequest overwrites message.id with its
    // own correlation id, so the artifact id must travel under another name.
    const asked = server.shell.last('phones-artifact-picture');
    assert.equal(asked.artifact, 'abcdef12-3456-7890', 'the artifact id reaches the shell as message.artifact');
    assert.notEqual(asked.id, 'abcdef12-3456-7890', 'message.id is the correlation id, not the artifact');
    server.shell.handlers['phones-artifact-picture'] = () => ({ ok: false, message: 'Pictures of artifacts are not in this build yet.' });
    const no = await server.post('/api/artifacts/picture', { id: 'abcdef12-3456-7890' });
    assert.equal(no.status, 503);
    assert.equal(no.body.error, 'Pictures of artifacts are not in this build yet.');
    server.shell.handlers['phones-artifact-picture'] = () => ({ ok: true, png: 'javascript:alert(1)' });
    assert.equal((await server.post('/api/artifacts/picture', { id: 'abcdef12-3456-7890' })).status, 503, 'only a PNG data URL is passed on');
  });
});

describe('a build with no phone packages', () => {
  let server;
  let bare;
  let base;
  before(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'm3-bare-'));
    bare = await makeBareApp(base);
    server = await startSealedServer({ name: 'bare', appRoot: bare, phones: { enabled: true }, loopbackHint: false });
  });
  after(async () => {
    await server?.stop();
    if (bare) removeBareApp(bare);
    if (base) await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  test('GET /api/phones answers what it can, the routes that need the Bridge answer 503, and Stop all still works', async () => {
    const view = await server.get('/api/phones');
    assert.equal(view.status, 200);
    assert.equal(view.body.available, false);
    assert.equal(view.body.message, 'Phones need a newer Plenum build.');
    assert.equal(view.body.enabled, true);
    assert.equal(view.body.running, false);
    for (const [p, body] of [['/api/phones/settings', { enabled: true }], ['/api/phones/lan', { enabled: true }], ['/api/phones/pair/start', {}], ['/api/phones/remove', { id: 'x' }], ['/api/phones/tier', { id: 'x', tier: 'read' }], ['/api/phones/push', {}], ['/api/phones/remove-all', {}]]) {
      const r = await server.post(p, body);
      assert.equal(r.status, 503, p);
      assert.equal(r.body.error, 'Phones need a newer Plenum build.', p);
    }
    assert.equal((await server.get('/api/phones/activity')).status, 200);
    const stop = await server.post('/api/stop-all', {});
    assert.equal(stop.status, 200);
    assert.deepEqual(stop.body, { ok: true, cancelled: 0, drivesStopped: 0, agentsStopped: 0, cardsDenied: 0 });
    assert.equal((await server.get('/api/state')).status, 200, 'the server itself is fine');
  });
});

describe('POST /api/stop-all', { skip: canInstallTestRoutes() ? false : 'the test routes can only be added inside the sealed runner copy' }, () => {
  let server;
  let mock;
  before(async () => {
    mock = await startMockModel();
    server = await startSealedServer({ name: 'stopall', mock, projects: ['p1', 'p2', 'p3', 'p4', 'p5'], testRoutes: true });
  });
  after(async () => {
    await server?.stop();
    await mock?.close();
  });

  const startRun = (project, text) => fetch(`${server.url}/api/chat`, {
    method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify({ project, message: text }),
  }).then(async res => ({ status: res.status, text: await res.text() }), () => ({ status: 0, text: '' }));
  const running = async project => {
    await server.post('/api/settings', { activeProject: project });
    return (await server.state()).running;
  };

  test('with nothing running it answers zeros', async () => {
    const r = await server.post('/api/stop-all', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, cancelled: 0, drivesStopped: 0, agentsStopped: 0, cardsDenied: 0 });
  });

  test('with two running projects, a drive and a waiting card it returns the counts, and the running map is empty at once', async () => {
    const hold = mock.gate('all1');
    const a = startRun('p1', 'HOLD:all1 one');
    const b = startRun('p2', 'WRITE a file please');
    await hold.reached;
    await until(async () => (await server.state()).approvalsWaiting === 1, 'a card to wait');
    assert.equal((await server.post('/api/_mobtest/drive', { project: 'p1', kind: 'computer' })).status, 200);
    assert.equal(await running('p1'), true);
    assert.equal(await running('p2'), true);
    const r = await server.post('/api/stop-all', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, cancelled: 2, drivesStopped: 1, agentsStopped: 0, cardsDenied: 1 });
    assert.equal(await running('p1'), false, 'the server\'s running map has let go of p1');
    assert.equal(await running('p2'), false, 'and of p2');
    const state = await server.state();
    assert.equal(state.drives.length, 0);
    assert.equal(state.approvalsWaiting, 0);
    const runs = await Promise.all([a, b]);
    for (const run of runs) assert.match(run.text, /"aborted":true/);
    // A new message is accepted straight away.
    const next = await server.post('/api/chat', { project: 'p1', message: 'after the stop' });
    assert.equal(next.status, 200);
  });

  test('two running projects, a drive and an agent: the counts add up and the running map is empty', async () => {
    const holdA = mock.gate('comboa');
    const holdB = mock.gate('combob');
    const one = startRun('p4', 'HOLD:comboa one');
    const two = startRun('p5', 'AGENT:combob start a researcher');
    await holdA.reached;
    const reached = await Promise.race([holdB.reached.then(() => true), sleep(15_000).then(() => false)]);
    assert.equal(reached, true, 'the agent\'s model request is being held');
    assert.equal((await server.post('/api/_mobtest/drive', { project: 'p4', kind: 'computer' })).status, 200);
    assert.equal(await running('p4'), true);
    assert.equal(await running('p5'), true);
    await until(async () => (await server.state()).agentsRunning === 1, 'an agent to be listed');
    const r = await server.post('/api/stop-all', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, cancelled: 2, drivesStopped: 1, agentsStopped: 1, cardsDenied: 0 });
    assert.equal(await running('p4'), false);
    assert.equal(await running('p5'), false);
    const state = await server.state();
    assert.equal(state.drives.length, 0);
    assert.equal(state.agentsRunning, 0);
    await Promise.all([one, two]);
  });

  test('an agent that is running is stopped too', async () => {
    const hold = mock.gate('agent1');
    const run = startRun('p3', 'AGENT:agent1 start a researcher');
    const reached = await Promise.race([hold.reached.then(() => true), sleep(15_000).then(() => false)]);
    assert.equal(reached, true, 'the agent\'s model request is being held');
    await server.post('/api/settings', { activeProject: 'p3' });
    await until(async () => (await server.state()).agentsRunning === 1, 'an agent to be listed');
    const r = await server.post('/api/stop-all', { project: 'p3' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.agentsStopped, 1);
    assert.equal(r.body.cancelled, 1);
    await run;
    assert.equal(await running('p3'), false);
  });

  test('a project argument stops only that project, and a project that does not exist is refused', async () => {
    const hold = mock.gate('only');
    const a = startRun('p1', 'HOLD:only mine');
    await hold.reached;
    const other = mock.gate('other');
    const b = startRun('p2', 'HOLD:other theirs');
    await other.reached;
    const r = await server.post('/api/stop-all', { project: 'p1' });
    assert.deepEqual(r.body, { ok: true, cancelled: 1, drivesStopped: 0, agentsStopped: 0, cardsDenied: 0 });
    assert.equal(await running('p1'), false);
    assert.equal(await running('p2'), true, 'p2 keeps going');
    assert.equal((await server.post('/api/stop-all', { project: 'nope' })).status, 400);
    assert.equal((await server.post('/api/stop-all', { project: 7 })).status, 400);
    other.release();
    await Promise.all([a, b]);
  });
});

void [TERMS];
