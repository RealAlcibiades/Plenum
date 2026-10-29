// The phone routes (MOBILE.json desktop.new_files, devices). Settings > Phones reads and changes everything through these; a paired phone
// calls a few of them itself (its own notification switches and push subscription, removing itself). The Bridge that serves phones is
// lib/remote/ and is loaded by dynamic import inside the handlers, so this module loads on a build that has no phone packages yet:
// until @noble and ws are installed every route that needs the Bridge answers 503 "Phones need a newer Plenum build." and
// GET /api/phones answers what it can ({ available: false }).
//
//   GET  /api/phones                 -> { available, enabled, running, port, storage, plainNode, carriers: { lan, tailscale, relay },
//                                         devices: [{ id, name, platform, app, tier, created, lastSeen, lastCarrier, connected, push,
//                                         expiresAfterDays, approveFromNotifications }], offer: { active, state, expiresInS, second,
//                                         tried, left, code?, device? }, push: { approvals, finished, limits, onlyWhenAway, firstLine }, autoExpireDays,
//                                         indicator: { connected: [names] } }
//   POST /api/phones/settings        { enabled?, port?, rerollPort?, autoExpireDays? }  Let phones connect, the port, auto-expire
//   POST /api/phones/lan             { enabled?, anyAddress? }       Allow phones on this network, Any address
//   POST /api/phones/tailscale       { enabled? }                    Tailscale (the switch is the consent)
//   POST /api/phones/relay           { enabled?, url? }              your relay (https only)
//   POST /api/phones/relay/new-room  {}                              a new room id and host secret for your relay (phones paired through the old room pair again)
//   POST /api/phones/pair/start      {}                              a new code. Under the desktop app the code appears only in the capture-protected
//                                                                    window; under plain node the answer carries the link
//   POST /api/phones/pair/cancel     {}
//   POST /api/phones/pair/confirm    { allow }                       the Allow or Deny when there is no window (plain node only; 404 under the desktop app)
//   POST /api/phones/remove          { id }                          a phone, any phone for the computer or a Full phone; the phone itself for any tier
//   POST /api/phones/remove-all      {}                              every phone, a new key for this computer and a new relay room
//   POST /api/phones/tier            { id, tier }                    full | approve | read
//   POST /api/phones/push            { approvals?, finished?, limits?, onlyWhenAway?, firstLine?, approveFromNotifications?, id?, subscription? }
//   POST /api/phones/test-push       { id? }
//   GET  /api/phones/activity        -> { activity: [{ at, device, text }] }
//   POST /api/artifacts/picture      { id }                          a PNG of an artifact, drawn by the desktop app (503 under plain node)
//
// Pairing is human-only (the floor), and so is every change to how phones reach this computer: pair/start, pair/cancel, pair/confirm,
// tier, settings, lan, tailscale, relay, relay/new-room and remove-all answer 403 "Add or change phones at the computer." when the request
// carries x-plenum-device, which only the Bridge sets, and only for a phone. A phone may still remove itself, or another phone when it has
// Full control (remove), and change its own notification switches (push): a phone that could switch phones off, or point them somewhere
// else, would end Stop for every other phone. The pair/confirm route is decided when it is
// asked: under the desktop app it is a 404, because the Allow is a button in the pairing window.
//
// Every handler checks the Plenum token itself (requireToken) as well as the server. The terms gate refuses every POST until the License
// Agreement is accepted; the GETs reach no provider and are not gated.
//
// The Bridge starts when state.phones.enabled is on: server.mjs starts it once the server listens (startPhones), and a request here
// starts it when it is not running yet. A request that is refused changes nothing and starts nothing: the store is put back, and the
// phones are only read (openPhones) until the request has passed its checks. The server's port is read from the socket of the request, never assumed.
import { requireToken } from '../auth.mjs';
import { shellAvailable, shellRequest } from '../shell.mjs';
import { REFUSAL_TEXT, phonesShape } from '../remote/tiers.mjs';

const NEEDS_BUILD = 'Phones need a newer Plenum build.';
const COMPUTER_ONLY = 'Add or change phones at the computer.';
const NO_ROUTE = 'No such route.';
// The Bridge never writes to the console itself; this is the one writer it is given, for a few fixed sentences (no keys, names or addresses).
const BRIDGE_OPTIONS = Object.freeze({ log: line => console.error(String(line).slice(0, 200)) });
const SELF_REMOVE_DELAY_MS = 150;
// The five notification switches are desktop-wide, so only a Full phone may change them (lib/remote/tiers.mjs, SELF_POSTS).
const PUSH_KEYS = ['approvals', 'finished', 'limits', 'onlyWhenAway', 'firstLine'];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ----- the Bridge, loaded when it is needed -----

let remoteModule = null;
async function loadRemote() {
  if (remoteModule) return remoteModule;
  try {
    remoteModule = await import('../remote/index.mjs');
    return remoteModule;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return null;
    throw err;
  }
}

async function remoteOf({ req, running, publicState, httpError }) {
  const mod = await loadRemote();
  if (!mod) throw httpError(503, NEEDS_BUILD);
  return mod.getRemote({ port: req.socket?.localPort, running, publicState, options: BRIDGE_OPTIONS });
}

function phonesOf(st) {
  if (!isObject(st.phones)) st.phones = {};
  return phonesShape(st.phones);
}

const phoneId = req => {
  const v = req.headers['x-plenum-device'];
  return typeof v === 'string' ? v : '';
};

function computerOnly(req, httpError) {
  if (phoneId(req)) throw httpError(403, COMPUTER_ONLY);
}

async function bodyOf({ req, readBody, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send a JSON object.');
  return body;
}

// A save that failed puts the old record back, so the screen and the file agree.
async function saveOrRestore(store, st, previous) {
  try {
    await store.saveOrFail();
  } catch (err) {
    st.phones = previous;
    throw err;
  }
}

const copyPhones = p => JSON.parse(JSON.stringify(p));

// A request that is refused changes nothing (B-25): the change is made to the store's record, and that record is put back when any step
// throws (a bad value, a failed check, or the Bridge answering 503). Nothing is saved for it either, so no stray switch waits for a later save.
async function refusing(st, previous, change) {
  try {
    return await change();
  } catch (err) {
    st.phones = previous;
    throw err;
  }
}

// The paired phones are loaded for a request. The Bridge starts only when phones are on, so a request that is refused, or that only lists or
// removes phones, does not turn a listener on (B-25). With phones off the paired phones are still read, so a person can see and remove them.
async function openPhones(store, remote) {
  if (phonesOf(store.get()).enabled) await remote.start().catch(() => {});
  else await remote.registry.ready().catch(() => {});
}

// ----- GET /api/phones -----

function unavailableView(p, message) {
  return {
    available: false,
    message,
    enabled: p.enabled,
    running: false,
    port: p.port ?? 0,
    storage: '',
    storageNote: '',
    plainNode: !shellAvailable(),
    carriers: {
      lan: { on: p.lan.enabled, anyAddress: p.lan.anyAddress, addresses: [], available: false },
      tailscale: { on: p.tailscale.enabled, name: p.tailscale.name, available: false },
      relay: { on: p.relay.enabled, url: p.relay.url, connected: false, available: false },
    },
    devices: [],
    offer: { active: false, state: 'idle', expiresInS: 0, second: false, tried: false, left: false },
    push: { ...p.push },
    autoExpireDays: p.autoExpireDays,
    indicator: { connected: [] },
  };
}

async function listRoute(ctx) {
  const { req, res, json, store } = ctx;
  requireToken(req, ctx.httpError);
  const p = phonesOf(store.get());
  const mod = await loadRemote();
  if (!mod) return json(res, 200, unavailableView(p, NEEDS_BUILD));
  const remote = mod.getRemote({ port: req.socket?.localPort, running: ctx.running, publicState: ctx.publicState, options: BRIDGE_OPTIONS });
  let problem = '';
  if (p.enabled && !remote.isRunning()) {
    try {
      await remote.start();
    } catch (err) {
      problem = String(err?.message ?? 'Phones could not start.');
    }
  }
  const view = await remote.state();
  // The six-digit check code and the name of the phone being paired are for the person at the computer. A phone's own request (it carries
  // x-plenum-device, which only the Bridge sets) is not shown them, so a Read-only phone cannot read another phone's code (B-27).
  if (phoneId(req) && view.offer) {
    delete view.offer.code;
    delete view.offer.device;
  }
  return json(res, 200, problem ? { ...view, error: problem } : view);
}

// ----- settings -----

async function settingsRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  computerOnly(req, httpError);
  const body = await bodyOf(ctx);
  const st = store.get();
  const previous = copyPhones(phonesOf(st));
  const p = phonesOf(st);
  let portChanged = false;
  // The checks and the changes come together: a refused value leaves every setting as it was, and no listener starts (refusing).
  const remote = await refusing(st, previous, async () => {
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false.');
      p.enabled = body.enabled;
    }
    if (body.port !== undefined) {
      if (!Number.isInteger(body.port) || body.port < 1024 || body.port > 65535) throw httpError(400, 'The port must be a whole number from 1024 to 65535.');
      if (body.port === req.socket?.localPort) throw httpError(400, 'That port is the one Plenum itself uses.');
      portChanged = body.port !== p.port;
      p.port = body.port;
    }
    if (body.rerollPort === true) {
      p.port = null;
      portChanged = true;
    }
    if (body.autoExpireDays !== undefined) {
      if (!Number.isInteger(body.autoExpireDays) || body.autoExpireDays < 0 || body.autoExpireDays > 3650) throw httpError(400, 'Days must be a whole number from 0 (never) to 3650.');
      p.autoExpireDays = body.autoExpireDays;
    }
    return remoteOf(ctx);
  });
  await saveOrRestore(store, st, previous);
  try {
    const running = remote.isRunning();
    if (p.enabled && !running) await remote.start();
    else if (!p.enabled && running) await remote.stop();
    else if (p.enabled && running && portChanged) {
      await remote.stop();
      await remote.start();
    }
    if (body.autoExpireDays !== undefined && remote.isRunning()) await remote.setAutoExpire(p.autoExpireDays);
  } catch (err) {
    p.enabled = false;
    await store.saveOrFail().catch(() => {});
    throw httpError(err?.status ?? 500, String(err?.message ?? 'Phones could not start.'));
  }
  return json(res, 200, await remote.state());
}

// ----- the carriers' switches -----

function relayUrlOf(value, httpError) {
  if (typeof value !== 'string') throw httpError(400, 'The relay address must be text.');
  const text = value.trim();
  if (text === '') return '';
  if (text.length > 300) throw httpError(400, 'That relay address is too long.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw httpError(400, 'That relay address is not a web address.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hash) {
    throw httpError(400, 'The relay address must start with https:// and name your Cloudflare Worker.');
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
}

function carrierRoute(kind, apply) {
  return async function route(ctx) {
    const { req, res, json, httpError, store } = ctx;
    requireToken(req, httpError);
    computerOnly(req, httpError);
    const body = await bodyOf(ctx);
    const st = store.get();
    const previous = copyPhones(phonesOf(st));
    const p = phonesOf(st);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false.');
    // A refused change (a bad address, a switch with no address to use) leaves the carrier as it was (refusing, B-25).
    const remote = await refusing(st, previous, async () => {
      apply(p, body, httpError);
      return remoteOf(ctx);
    });
    await saveOrRestore(store, st, previous);
    try {
      if (remote.isRunning()) await remote.applyCarriers();
    } catch (err) {
      throw httpError(err?.status ?? 500, String(err?.message ?? `The ${kind} way could not be changed.`));
    }
    return json(res, 200, await remote.state());
  };
}

const lanRoute = carrierRoute('same-network', (p, body, httpError) => {
  if (body.anyAddress !== undefined && typeof body.anyAddress !== 'boolean') throw httpError(400, 'anyAddress must be true or false.');
  if (body.enabled !== undefined) p.lan.enabled = body.enabled;
  if (body.anyAddress !== undefined) p.lan.anyAddress = body.anyAddress;
});
const tailscaleRoute = carrierRoute('Tailscale', (p, body) => {
  if (body.enabled !== undefined) p.tailscale.enabled = body.enabled;
});
const relayRoute = carrierRoute('relay', (p, body, httpError) => {
  if (body.url !== undefined) p.relay.url = relayUrlOf(body.url, httpError);
  if (body.enabled !== undefined) p.relay.enabled = body.enabled;
  if (p.relay.enabled && !p.relay.url) throw httpError(400, 'Paste the address of your relay first.');
});

// A new room id and host secret (D9): the old room keeps no host, and a phone paired through it pairs again. Same answer as the relay route.
async function relayNewRoomRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  computerOnly(req, httpError);
  await bodyOf(ctx);
  if (!phonesOf(store.get()).relay.url) throw httpError(409, 'Save a relay address first.');
  const remote = await remoteOf(ctx);
  try {
    await remote.newRelayRoom();
  } catch (err) {
    throw httpError(err?.status ?? 500, String(err?.message ?? 'The relay room could not be changed.'));
  }
  return json(res, 200, await remote.state());
}

// ----- pairing: human-only -----

async function pairStartRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  computerOnly(req, httpError);
  await bodyOf(ctx);
  const p = phonesOf(store.get());
  if (!p.enabled) throw httpError(409, 'Turn on "Let phones connect" first.');
  const remote = await remoteOf(ctx);
  let made;
  try {
    made = await remote.pairStart();
  } catch (err) {
    throw httpError(err?.status ?? 500, String(err?.message ?? 'A new code could not be made.'));
  }
  if (!made.ok) {
    return json(res, 409, { ok: false, state: made.state, error: 'Turn on at least one way for a phone to reach this computer first: Same network, Tailscale or a relay.' });
  }
  return json(res, 200, { ok: true, state: made.state, expiresInS: made.expiresInS, ...(made.link ? { link: made.link, hints: made.hints } : {}) });
}

async function pairCancelRoute(ctx) {
  const { req, res, json, httpError } = ctx;
  requireToken(req, httpError);
  computerOnly(req, httpError);
  await bodyOf(ctx);
  const remote = await remoteOf(ctx);
  remote.pairCancel();
  return json(res, 200, { ok: true });
}

// The Allow when there is no pairing window. Decided on each request: under the desktop app this route does not exist.
async function pairConfirmRoute(ctx) {
  const { req, res, json, httpError } = ctx;
  if (shellAvailable()) throw httpError(404, NO_ROUTE);
  requireToken(req, httpError);
  computerOnly(req, httpError);
  const body = await bodyOf(ctx);
  if (typeof body.allow !== 'boolean') throw httpError(400, 'Say allow: true or allow: false.');
  const remote = await remoteOf(ctx);
  const answer = await remote.pairConfirm(body.allow);
  if (!answer?.ok) throw httpError(answer?.status ?? 409, String(answer?.error ?? 'There is no phone waiting.'));
  return json(res, 200, { ok: true, ...(body.allow && answer.device ? { device: answer.device } : {}) });
}

// ----- the phones themselves -----

async function removeRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  const body = await bodyOf(ctx);
  if (typeof body.id !== 'string' || !body.id) throw httpError(400, 'Say which phone to remove.');
  const remote = await remoteOf(ctx);
  await openPhones(store, remote);
  const caller = phoneId(req);
  if (caller && body.id !== caller) {
    // A phone may remove another one only when it has Full control (the tier rule lets Approve-and-watch phones reach this route for themselves).
    if (remote.registry.tierOf(caller) !== 'full') throw httpError(403, REFUSAL_TEXT);
  }
  if (!remote.registry.get(body.id)) throw httpError(404, 'That phone is not paired.');
  if (caller && body.id === caller) {
    // The phone's own channel closes with the removal, so the answer is sent first.
    const timer = setTimeout(() => {
      remote.removeDevice(body.id).catch(() => {});
    }, SELF_REMOVE_DELAY_MS);
    timer.unref?.();
    return json(res, 200, { ok: true });
  }
  await remote.removeDevice(body.id);
  return json(res, 200, { ok: true });
}

// Computer-only: a phone that could remove every phone would end Stop for all of them (D7).
async function removeAllRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  computerOnly(req, httpError);
  await bodyOf(ctx);
  const remote = await remoteOf(ctx);
  await openPhones(store, remote);
  const done = await remote.removeAll();
  return json(res, 200, { ok: true, removed: done.removed });
}

async function tierRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  computerOnly(req, httpError);
  const body = await bodyOf(ctx);
  if (typeof body.id !== 'string' || !body.id) throw httpError(400, 'Say which phone.');
  const remote = await remoteOf(ctx);
  await openPhones(store, remote);
  const device = await remote.setTier(body.id, body.tier);
  return json(res, 200, { ok: true, device });
}

async function pushRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  const body = await bodyOf(ctx);
  const caller = phoneId(req);
  const target = caller || (typeof body.id === 'string' ? body.id : '');
  const remote = await remoteOf(ctx);
  // The paired phones are loaded before the record is copied, so a start of the Bridge (on a phone's own request) is not undone by a refusal.
  if (body.approveFromNotifications !== undefined || body.subscription !== undefined) await openPhones(store, remote);
  const st = store.get();
  const previous = copyPhones(phonesOf(st));
  const p = phonesOf(st);
  // Every check runs before anything is saved (refusing, B-25): a refused request changes no switch, no approval and no subscription.
  await refusing(st, previous, async () => {
    // A phone below Full control may not change the desktop-wide switches (firstLine puts file names and commands on every lock screen).
    // It still sets its own Approve-from-notification and subscription, below.
    if (caller && PUSH_KEYS.some(key => body[key] !== undefined) && remote.registry.tierOf(caller) !== 'full') throw httpError(403, REFUSAL_TEXT);
    for (const key of PUSH_KEYS) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') throw httpError(400, `${key} must be true or false.`);
      p.push[key] = body[key];
    }
    if (body.approveFromNotifications !== undefined) {
      if (typeof body.approveFromNotifications !== 'boolean') throw httpError(400, 'approveFromNotifications must be true or false.');
      if (!target) throw httpError(400, 'Say which phone.');
      if (body.approveFromNotifications === true && p.push.firstLine !== true) throw httpError(409, 'Turn on "Include the first line" first. Approving from a notification needs it.');
      if (caller && body.id !== undefined && body.id !== caller) throw httpError(403, REFUSAL_TEXT);
      if (caller && body.approveFromNotifications === true && remote.registry.tierOf(caller) === 'read') throw httpError(403, REFUSAL_TEXT);
      if (!remote.registry.get(target)) throw httpError(404, 'That phone is not paired.');
    }
    if (body.subscription !== undefined) {
      if (!caller) throw httpError(400, 'A push subscription comes from the phone itself.');
      if (body.subscription !== null && !isObject(body.subscription)) throw httpError(400, 'That push subscription is not valid.');
      try {
        // The subscription is checked (and stored) before the switches are saved: a subscription that is refused leaves them as they were.
        await remote.setSubscription(caller, body.subscription);
      } catch (err) {
        throw httpError(err?.status ?? 400, String(err?.message ?? 'That push subscription is not valid.'));
      }
    }
  });
  await saveOrRestore(store, st, previous);
  if (body.approveFromNotifications !== undefined) await remote.setApproveFromNotifications(target, body.approveFromNotifications);
  return json(res, 200, { ok: true, push: { ...p.push } });
}

async function testPushRoute(ctx) {
  const { req, res, json, httpError, store } = ctx;
  requireToken(req, httpError);
  const body = await bodyOf(ctx);
  const remote = await remoteOf(ctx);
  // The test needs the pusher, which only a started Bridge has. With phones off the Bridge runs for the test alone and is stopped
  // again, so no listener stays bound behind the switch (B-25).
  const onlyForTest = !phonesOf(store.get()).enabled && !remote.isRunning();
  await remote.start().catch(() => {});
  try {
    const results = await remote.testPush(typeof body.id === 'string' && body.id ? body.id : null);
    return json(res, 200, { ok: true, results });
  } finally {
    // A switch turned on while the test ran keeps the Bridge running.
    if (onlyForTest && !phonesOf(store.get()).enabled) await remote.stop().catch(() => {});
  }
}

async function activityRoute({ req, res, json, httpError, store }) {
  requireToken(req, httpError);
  return json(res, 200, { activity: phonesOf(store.get()).activity.slice() });
}

// ----- a picture of an artifact, for a phone that cannot show the page -----

async function pictureRoute(ctx) {
  const { req, res, json, httpError } = ctx;
  requireToken(req, httpError);
  const body = await bodyOf(ctx);
  if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.id)) throw httpError(400, 'Say which artifact.');
  if (!shellAvailable()) throw httpError(503, 'This needs the desktop app.');
  let reply;
  try {
    reply = await shellRequest('phones-artifact-picture', { artifact: body.id }, { timeoutMs: 15_000 });
  } catch (err) {
    throw httpError(err?.status ?? 503, String(err?.message ?? 'The picture could not be made.'));
  }
  const png = reply?.png ?? reply?.dataUrl;
  if (reply?.ok !== true || typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) {
    throw httpError(503, typeof reply?.message === 'string' && reply.message ? reply.message.slice(0, 300) : 'The picture could not be made.');
  }
  return json(res, 200, { png });
}

export const routes = [
  { method: 'GET', path: '/api/phones', handler: listRoute },
  { method: 'POST', path: '/api/phones/settings', handler: settingsRoute },
  { method: 'POST', path: '/api/phones/lan', handler: lanRoute },
  { method: 'POST', path: '/api/phones/tailscale', handler: tailscaleRoute },
  { method: 'POST', path: '/api/phones/relay', handler: relayRoute },
  { method: 'POST', path: '/api/phones/relay/new-room', handler: relayNewRoomRoute },
  { method: 'POST', path: '/api/phones/pair/start', handler: pairStartRoute },
  { method: 'POST', path: '/api/phones/pair/cancel', handler: pairCancelRoute },
  { method: 'POST', path: '/api/phones/pair/confirm', handler: pairConfirmRoute },
  { method: 'POST', path: '/api/phones/remove', handler: removeRoute },
  { method: 'POST', path: '/api/phones/remove-all', handler: removeAllRoute },
  { method: 'POST', path: '/api/phones/tier', handler: tierRoute },
  { method: 'POST', path: '/api/phones/push', handler: pushRoute },
  { method: 'POST', path: '/api/phones/test-push', handler: testPushRoute },
  { method: 'GET', path: '/api/phones/activity', handler: activityRoute },
  { method: 'POST', path: '/api/artifacts/picture', handler: pictureRoute },
];
