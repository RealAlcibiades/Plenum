// Shell core suites (mob-10, wave 104). Node only: the channel Worker core runs against the fake computer (fixtures/shell-core/fake-desktop.mjs,
// the real Noise responder and frame session in memory), the fake IndexedDB, and a fake clock for reconnect and STOP timing.
// Run through the sealed runner: node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id mob-10-shell-core shell-core.test.mjs
// The Electron bridge mode (pair, REQ, server kill and restart, STOP of a running turn) is in shell-core.harness.test.mjs.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeIndexedDB } from './fixtures/shell-core/fake-idb.mjs';
import { createFakeNet, createFakeDesktop } from './fixtures/shell-core/fake-desktop.mjs';
import { createChannelCore, DELAYS_MS, STOP_WINDOW_MS, STOP_RESEND_MS, RENEW_AFTER_MS, RENEW_DRAIN_MS, NOT_KNOWN_RETRY_MS, openSocket, requestPolicy } from '../shell/channel.worker.js';
import { openChannel, bytesToB64u, b64uToBytes, workerComputer, sendLockedStop } from '../shell/channel.js';
import { carrierUrlOk, hostLabel, usableCarriers } from '../shell/carriers.js';
import { createIdbKv, createSecureKv, createStore, publicComputer, createPlatformStore } from '../shell/store.js';
import { createLock, createPasskeyGate, pinWaitSeconds, isValidPin, wrapKey, unwrapKey, derivePinKey, PIN_ITERATIONS, BACKGROUND_LOCK_MS } from '../shell/lock.js';
import { parsePairingText, pageCandidates, PairingError, describeTried, startPairing, validatePayload } from '../shell/pairing.js';
import { createStopController, stopResultText, STOP_NEEDS_UNLOCK, STOP_NOT_ACCEPTED, STOP_WATCHDOG_MS } from '../shell/stop.js';
import { createDebugLog, redactLine, RING_LINES, LINE_MAX } from '../shell/debug.js';
import { parseNotificationHash, pushAvailable, subscribeWebPush } from '../shell/push.js';
import * as app from '../shell/app.js';
import { CARD_CHANGED, createLinkStore, createShell, deviceFor, hasNativeBridge, linkOfUrl, makeFacade, modeFor, NOTIFICATION_OLD, registerServiceWorker, registrationOf, startShell, wantsNativePlugins, wireAppPlugin } from '../shell/app.js';
import { createUiHost, filesOver, SHELL_LINK_KEY, SHELL_PAGE_KEY, webViewOver } from '../shell/ui-host.js';
import { isRouteLink } from '../shell/push.js';
import { screenFor } from '../shell/screens/route.js';
import { runSelfTest, STEP_NAMES } from '../shell/selftest.js';
import { deviceId, generateKeyPair, sas, pushKey } from '../../lib/remote/noise.mjs';
import { showPush, openFromNotification } from '../shell/sw.js';
import { buildPushText } from '../../lib/remote/push.mjs';
import { createAndroidPush, notificationFor } from '../shell/push.js';
import { parsePushPayload } from '../plugins/unifiedpush/src/core.js';
import * as workerMod from '../shell/channel.worker.js';

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// Lets every queued microtask and immediate run (the fake socket opens and closes on microtasks).
async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

// Moves the fake clock in steps, letting the socket microtasks run between steps (a failed attempt schedules the next one).
async function walk(clock, ms, step = 1000) {
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    await settle();
  }
}

// A fake worker: the page side of a channel core. Messages are copied (as postMessage does) and every message the core posts is kept.
function fakeWorkerFactory({ net, clock, store, observed = [], holdCounters = { on: false, queue: [] }, failCounters = false } = {}) {
  const counters = new Map();
  return () => {
    let core = null;
    const worker = {
      onmessage: null,
      onerror: null,
      terminated: false,
      postMessage(msg) {
        const copy = structuredClone(msg);
        queueMicrotask(() => core.handle(copy));
      },
      terminate() { this.terminated = true; },
    };
    const answer = async msg => {
      if (failCounters) {
        core.handle({ op: 'counterSaved', rid: msg.rid, ok: false });
        return;
      }
      let counter;
      if (store) counter = await store.raiseCounter(msg.id, msg.minimum);
      else {
        counter = Math.max(counters.get(msg.id) ?? 0, msg.minimum - 1) + 1;
        counters.set(msg.id, counter);
      }
      core.handle({ op: 'counterSaved', rid: msg.rid, ok: true, counter });
    };
    core = createChannelCore({
      post: (msg, transfer = []) => {
        observed.push(msg);
        if (msg.op === 'counter') {
          if (holdCounters.on) holdCounters.queue.push(() => answer(msg));
          else queueMicrotask(() => answer(msg));
          return;
        }
        queueMicrotask(() => worker.onmessage?.({ data: structuredClone(msg) }));
        void transfer;
      },
      WebSocketImpl: net.WebSocket,
      clock,
    });
    return worker;
  };
}

function freshComputer(desktop, phone, { counter = 0 } = {}) {
  return {
    id: deviceId(desktop.keys.publicKey),
    name: 'Test PC',
    desktopPub: bytesToB64u(desktop.keys.publicKey),
    myPriv: bytesToB64u(phone.privateKey),
    carriers: [{ kind: 'lan', urls: [desktop.url] }],
    lastCarrier: null,
    counter,
  };
}

// The worker-side record for tests that drive the core directly.
function coreComputer(desktop, phone, extra = {}) {
  return {
    id: deviceId(desktop.keys.publicKey),
    name: 'Test PC',
    desktopPub: desktop.keys.publicKey,
    myPriv: phone.privateKey,
    carriers: [{ kind: 'lan', urls: [desktop.url] }],
    lastCarrier: null,
    counter: 0,
    ...extra,
  };
}

// Builds a core with its messages and a counter store that stays in memory.
function coreRig({ net, clock, computer, holdCounters = false, failCounters = false, stored = 0 }) {
  const messages = [];
  const counters = new Map([[computer.id, stored]]);
  const rig = { messages, counters, held: [], dials: [] };
  const Counting = class extends net.WebSocket {
    constructor(url) {
      super(url);
      rig.dials.push({ at: clock.now(), url });
    }
  };
  rig.core = createChannelCore({
    post: (msg) => {
      messages.push(structuredClone(msg));
      if (msg.op !== 'counter') return;
      const run = () => {
        if (failCounters) rig.core.handle({ op: 'counterSaved', rid: msg.rid, ok: false });
        else {
          const counter = Math.max(counters.get(msg.id) ?? 0, msg.minimum - 1) + 1;
          counters.set(msg.id, counter);
          rig.core.handle({ op: 'counterSaved', rid: msg.rid, ok: true, counter });
        }
      };
      if (holdCounters) rig.held.push(run);
      else queueMicrotask(run);
    },
    WebSocketImpl: Counting,
    clock,
  });
  rig.states = () => messages.filter(m => m.op === 'state').map(m => m.state);
  rig.last = op => messages.filter(m => m.op === op).at(-1);
  rig.init = () => rig.core.handle({ op: 'init', computer: { ...computer, desktopPub: computer.desktopPub, myPriv: computer.myPriv }, device: { name: 'Test phone', platform: 'ios', app: 'pwa', appVersion: '1', uiHash: '' }, caps: ['ui-from-desktop'] });
  return rig;
}

describe('channel core: connect, counter and reconnect', () => {
  it('connects with IK, raises and stores the counter before the handshake, and reports HELLO', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, clock: undefined });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const computer = coreComputer(desktop, phone);
    const rig = coreRig({ net, clock, computer });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    assert.equal(desktop.counters.get(deviceId(phone.publicKey)), 1, 'the desktop accepted counter 1');
    assert.equal(rig.counters.get(computer.id), 1, 'the page stored counter 1 before the handshake');
    const hello = rig.last('hello')?.hello;
    assert.equal(hello?.desktopName, 'Test PC');
    assert.equal(hello?.protocol?.major, 1);
    assert.equal(rig.last('state').state.status, 'connected');
  });

  it('writes no handshake until the counter is stored', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone), holdCounters: true });
    rig.init();
    await settle();
    assert.equal(rig.held.length, 1, 'the counter request is waiting');
    assert.equal(desktop.stats.handshakes, 0, 'no handshake before the store answers');
    rig.held.shift()();
    await settle();
    assert.equal(desktop.stats.handshakes, 1);
    assert.equal(rig.core.phase, 'connected');
  });

  it('never handshakes when the counter cannot be stored', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone), failCounters: true });
    rig.init();
    await settle();
    assert.equal(desktop.stats.handshakes, 0, 'no message 1 was sent');
    assert.notEqual(rig.core.phase, 'connected');
  });

  it('retries after a drop at 1, 2, 4, 8 and then 10 s, and shows offline after three failed rounds', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    const base = clock.now();
    desktop.killAll();
    await settle();
    assert.equal(rig.core.phase, 'reconnecting', 'a drop shows reconnecting at once');
    const dialsBefore = rig.dials.length;
    // Walk time forward second by second and record when each attempt starts.
    const starts = [];
    for (let t = 0; t < 40_000; t += 1000) {
      clock.advance(1000);
      await settle();
      while (starts.length < rig.dials.length - dialsBefore) starts.push(rig.dials[dialsBefore + starts.length].at - base);
    }
    // The first attempt is at 1 s, then after each refused round the gap grows: 1, 2, 4, 8, 10, 10 ...
    assert.deepEqual(starts.slice(0, 6), [1000, 3000, 7000, 15000, 25000, 35000]);
    assert.equal(DELAYS_MS.join(','), '1000,2000,4000,8000');
    assert.equal(rig.core.phase, 'offline', 'three failed rounds: offline');
    assert.equal(desktop.stats.handshakes, 1, 'no handshake reached a computer that was down');
  });

  it('reconnects within 10 s of the computer coming back, with no pairing again', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    desktop.killAll();
    await settle();
    await walk(clock, 20_000);
    assert.equal(rig.core.phase, 'offline');
    desktop.comeBack();
    const back = clock.now();
    for (let i = 0; i < 12 && rig.core.phase !== 'connected'; i++) {
      clock.advance(1000);
      await settle();
    }
    assert.equal(rig.core.phase, 'connected');
    assert.ok(clock.now() - back <= 10_000, `reconnected within 10 s (took ${clock.now() - back} ms)`);
    assert.equal(desktop.registry.size, 0, 'no pairing happened');
    assert.equal(desktop.counters.get(deviceId(phone.publicKey)), 2, 'the counter rose again');
  });

  it('a revoked CLOSE stops every retry', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    desktop.revokeAll('revoked');
    await settle();
    assert.equal(rig.core.phase, 'revoked');
    const dials = rig.dials.length;
    await walk(clock, 120_000);
    assert.equal(rig.dials.length, dials, 'no attempt after revoked');
  });

  it('renews after an hour while an event stream is open: a second handshake, new requests on it, the old stream delivers until the drain ends', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    // The page keeps its event stream open for the life of the page: the renewal must not wait for it to end.
    rig.core.handle({ op: 'request', sid: 5, method: 'GET', path: '/api/events', headers: {}, body: null });
    await settle();
    const oldSession = rig.core.session;
    await walk(clock, RENEW_AFTER_MS);
    await settle();
    assert.equal(desktop.stats.handshakes, 2, 'a second IK handshake at one hour');
    assert.notEqual(rig.core.session, oldSession, 'new requests go to the new session');
    assert.equal(rig.core.phase, 'connected');
    assert.equal(rig.messages.filter(m => m.op === 'hello').length, 2, 'the new HELLO reaches the page');
    const dataOn5 = () => rig.messages.filter(m => m.op === 'data' && m.sid === 5).length;
    const before = dataOn5();
    // The computer's small frames are coalesced on its real timer, so this waits in real time, not on the fake clock.
    desktop.raiseApproval('Write a file');
    await waitFor(() => dataOn5() > before);
    assert.ok(dataOn5() > before, 'the old stream still delivers during the drain');
    rig.core.handle({ op: 'request', sid: 6, method: 'GET', path: '/api/state', headers: {}, body: null });
    await waitFor(() => rig.messages.some(m => m.op === 'res' && m.sid === 6));
    assert.equal(rig.messages.find(m => m.op === 'res' && m.sid === 6)?.status, 200, 'a request after the renewal is answered');
    await walk(clock, RENEW_DRAIN_MS);
    assert.ok(rig.messages.some(m => m.op === 'end' && m.sid === 5 && m.error === 'lost'), 'the old stream ends when the drain is over');
    assert.ok(desktop.stats.closes.includes('renewed'), 'the computer heard the old session close');
    assert.equal(rig.core.phase, 'connected', 'closing the drained session starts no retry');
  });

  it('a phone the computer removed while it was away is not-known after three unknown answers, and tries once a minute', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    const phoneId = deviceId(phone.publicKey);
    desktop.counters.set(phoneId, 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    // The computer removes the phone, and the connection drops while the phone cannot know it.
    desktop.counters.delete(phoneId);
    net.dropAll('removed');
    await walk(clock, 10_000);
    assert.equal(rig.core.phase, 'not-known', 'three unknown answers, at 1, 3 and 7 s');
    assert.equal(rig.core.snapshot().failure, 'unknown');
    assert.equal(NOT_KNOWN_RETRY_MS, 60_000);
    const dials = rig.dials.length;
    await walk(clock, 180_000);
    assert.equal(rig.dials.length - dials, 3, 'one try a minute, not one every few seconds');
    assert.equal(desktop.stats.refused, 6, 'six unknown answers in all, not one per retry');
    assert.equal(rig.core.phase, 'not-known');
    // Not terminal: the phone known again, the next minute's try connects.
    desktop.counters.set(phoneId, 0);
    await walk(clock, 60_000);
    assert.equal(rig.core.phase, 'connected', 'a known phone connects on the next slow try');
  });
});

describe('channel core: requests and STOP', () => {
  it('streams a chat reply through request()', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const observed = [];
    const create = fakeWorkerFactory({ net, clock, observed, store: null });
    const channel = openChannel({ computer: freshComputerRecord(desktop, phone), createWorker: create });
    await waitFor(() => channel.state.status === 'connected');
    const res = await channel.request({ method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' } }, JSON.stringify({ project: 'p1', message: 'hi' }));
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += utf8Decode.decode(value);
    }
    assert.match(text, /Echo \(fake desktop\)/);
    assert.equal(desktop.stats.chats, 1);
    channel.close();
  });

  it('a STOP is answered with a STOP_ACK carrying the same id, and stops a running turn', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const create = fakeWorkerFactory({ net, clock });
    const channel = openChannel({ computer: freshComputerRecord(desktop, phone), createWorker: create });
    await waitFor(() => channel.state.status === 'connected');
    const res = await channel.request({ method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' } }, JSON.stringify({ project: 'p1', message: 'long' }));
    const reader = res.body.getReader();
    await reader.read();
    const ack = await channel.stop('p1');
    assert.equal(desktop.stats.stops, 1);
    assert.equal(ack.cancelled, 1, 'the running turn was cancelled');
    assert.match(ack.id, /^[0-9a-f]{32}$/);
    assert.equal(desktop.stats.stopAcks[0].id, ack.id, 'same id as sent');
    channel.close();
  });

  it('a STOP sent while the phone is offline is queued, then answered after the reconnect', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    desktop.killAll();
    await settle();
    rig.core.handle({ op: 'stop', sid: 7, project: null });
    await settle();
    assert.equal(rig.last('stopState')?.state, 'queued');
    desktop.comeBack();
    for (let i = 0; i < 12 && !rig.last('stopAck'); i++) {
      clock.advance(1000);
      await settle();
    }
    const ack = rig.last('stopAck');
    assert.ok(ack?.ack?.id, 'the STOP was answered after the reconnect');
    assert.equal(ack.sid, 7);
    assert.equal(desktop.stats.stops, 1, 'answered once');
  });

  it('a STOP is sent again with the same id after 8 s without an answer, and gives up at 60 s', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, ignoreStops: true });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    rig.core.handle({ op: 'stop', sid: 9, project: null });
    await settle();
    clock.advance(STOP_RESEND_MS + 10);
    await settle();
    assert.equal(desktop.stats.stopsSeen.length, 2, 'the STOP went out again');
    assert.equal(desktop.stats.stopsSeen[0], desktop.stats.stopsSeen[1], 'same id both times');
    clock.advance(STOP_WINDOW_MS);
    await settle();
    const failed = rig.last('stopAck');
    assert.equal(failed.error, 'unreachable');
    assert.equal(failed.sid, 9);
  });

  it('a forever-offline computer gives an unreachable STOP after 60 s', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    desktop.killAll();
    await settle();
    rig.core.handle({ op: 'stop', sid: 3, project: null });
    for (let i = 0; i < 61; i++) {
      clock.advance(1000);
      await settle();
    }
    assert.equal(rig.last('stopAck').error, 'unreachable');
  });

  it('keeps every key out of what the page is sent', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const computer = coreComputer(desktop, phone);
    const rig = coreRig({ net, clock, computer });
    rig.init();
    await settle();
    rig.core.handle({ op: 'request', sid: 1, method: 'GET', path: '/', headers: {}, body: null });
    rig.core.handle({ op: 'stop', sid: 2, project: null });
    await settle();
    const text = JSON.stringify(rig.messages);
    assert.equal(text.includes(bytesToB64u(phone.privateKey)), false, 'no private key in any message');
    assert.equal(text.includes(Buffer.from(phone.privateKey).toString('hex')), false, 'no private key hex');
  });
});

describe('pairing through the worker', () => {
  const psk = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 255);
  const offerHex = '0f'.repeat(16);

  it('shows the same six digits on both sides, stores the record only after Allow, and then connects', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const link = {
      v: 1,
      name: 'Test PC',
      pub: bytesToB64u(desktop.keys.publicKey),
      psk: bytesToB64u(psk),
      offer: offerHex,
      ttl: 120,
      carriers: [{ kind: 'lan', urls: [desktop.url] }],
      sas: '6',
    };
    desktop.openOffer(psk, offerHex);
    const stored = [];
    const store = { put: async rec => { stored.push(rec); return rec; }, raiseCounter: async (id, min) => min, patchComputer: async () => null };
    const states = [];
    const flow = startPairing({ payload: link, store, createWorker: fakeWorkerFactory({ net, clock, store: null }), onState: s => states.push({ ...s }) });
    for (let i = 0; i < 10 && !states.some(s => s.state === 'confirm'); i++) await settle();
    const phoneCode = states.find(s => s.state === 'confirm')?.code;
    assert.match(phoneCode ?? '', /^[0-9]{6}$/, 'the phone shows six digits');
    const desktopCode = sas(desktop.sessions.values().next().value.cs.handshakeHash);
    assert.equal(phoneCode, desktopCode, 'both screens show the same six digits');
    assert.equal(stored.length, 0, 'nothing stored before Allow');
    assert.equal(desktop.registry.size, 0, 'nothing registered before Allow');
    desktop.allow(offerHex);
    const final = await flow.done;
    assert.equal(final.state, 'allowed');
    assert.equal(stored.length, 1, 'the record was saved once');
    assert.equal(stored[0].id, deviceId(desktop.keys.publicKey));
    assert.ok(stored[0].myPriv && stored[0].desktopPub, 'the record carries the keys for the store only');
    assert.equal(pushKey(new Uint8Array(32)).length, 32);
    // the saved record connects with IK (the same counter rule as any session)
    const shell = openChannel({ computer: { ...stored[0], counter: stored[0].counter ?? 1 }, store, createWorker: fakeWorkerFactory({ net, clock, store: null }) });
    await waitFor(() => shell.state.status === 'connected');
    assert.ok(shell.hello, 'HELLO arrived on the saved record');
    shell.close();
  });

  it('a Deny at the computer stores nothing and reports denied', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const offer = '1a'.repeat(16);
    desktop.openOffer(psk, offer);
    const link = { v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(psk), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' };
    const states = [];
    const worker = fakeWorkerFactory({ net, clock, store: null })();
    const original = worker.postMessage.bind(worker);
    void original;
    const observe = [];
    const pairing = { state: null };
    worker.onmessage = null;
    const create = () => worker;
    const flow = startPairing({ payload: link, store: { put: async () => { throw new Error('must not store'); }, raiseCounter: async (id, m) => m }, createWorker: create, onState: s => states.push(s.state) });
    void observe;
    void pairing;
    await settle();
    await settle();
    desktop.deny(offer);
    await settle();
    await settle();
    const final = await flow.done;
    assert.equal(final.state, 'denied');
    assert.equal(desktop.registry.size, 0);
    assert.ok(states.includes('confirm'));
  });

  it('a link whose psk does not match never reaches the code, and reports the carriers tried', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const offer = '2b'.repeat(16);
    desktop.openOffer(psk, offer);
    const wrong = new Uint8Array(32).fill(9);
    const link = { v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(wrong), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' };
    const worker = fakeWorkerFactory({ net, clock, store: null })();
    const flow = startPairing({ payload: link, store: null, createWorker: () => worker });
    await settle();
    for (let i = 0; i < 20; i++) {
      clock.advance(1000);
      await settle();
    }
    const final = await flow.done;
    assert.equal(final.state, 'failed');
    assert.equal(final.code, null, 'no code was shown');
    assert.equal(final.tried[0]?.carrier, 'lan');
    assert.equal(desktop.registry.size, 0);
  });

  it('pairing expires when the offer times out at 120 s', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const offer = '3c'.repeat(16);
    desktop.openOffer(psk, offer);
    const link = { v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(psk), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' };
    const worker = fakeWorkerFactory({ net, clock, store: null })();
    const flow = startPairing({ payload: link, store: null, createWorker: () => worker });
    await settle();
    for (let i = 0; i < 130; i++) {
      clock.advance(1000);
      await settle();
    }
    assert.equal((await flow.done).state, 'expired');
  });

  it('a mismatch sends CLOSE and reports mismatch', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const offer = '4d'.repeat(16);
    desktop.openOffer(psk, offer);
    const link = { v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(psk), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' };
    const worker = fakeWorkerFactory({ net, clock, store: null })();
    const flow = startPairing({ payload: link, store: null, createWorker: () => worker });
    await settle();
    await settle();
    flow.cancel();
    await settle();
    await settle();
    assert.equal((await flow.done).state, 'mismatch');
    assert.ok(desktop.stats.closes.includes('mismatch'), 'the computer heard CLOSE mismatch');
  });
});

describe('pairing link parsing', () => {
  const payload = { v: 1, name: 'Home PC', pub: bytesToB64u(new Uint8Array(32).fill(1)), psk: bytesToB64u(new Uint8Array(32).fill(2)), offer: '0a'.repeat(16), ttl: 120, carriers: [{ kind: 'lan', urls: ['ws://192.168.1.5:40123/b/' + '0'.repeat(32)] }, { kind: 'relay', url: 'wss://x.workers.dev/room/1' }] };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

  it('accepts the native, the https and the LAN forms', () => {
    assert.equal(parsePairingText(`plenum://pair#${b64(payload)}`).name, 'Home PC');
    assert.equal(parsePairingText(`https://pc.tail.ts.net/#pair=${b64(payload)}`).offer, '0a'.repeat(16));
    assert.equal(parsePairingText(`http://192.168.1.5:40123/p/${'0'.repeat(32)}/#pair=${b64(payload)}`).carriers.length, 2);
  });

  it('refuses a link that is not a Plenum link, and a wrong version', () => {
    assert.throws(() => parsePairingText('https://example.com/#hello'), PairingError);
    assert.throws(() => parsePairingText(`plenum://pair#${b64({ ...payload, v: 2 })}`), /version/);
    assert.throws(() => parsePairingText(`plenum://pair#${b64({ ...payload, psk: 'AAAA' })}`), PairingError);
    assert.throws(() => validatePayload({ ...payload, carriers: [] }), /no-carrier/);
  });

  it('adds the LAN page origin as the first candidate only when the page is the LAN web page', () => {
    const key = '0'.repeat(32);
    assert.deepEqual(pageCandidates(`http://192.168.1.9:40123/p/${key}/#pair=x`, { carriers: [] }), [{ kind: 'lan', url: `ws://192.168.1.9:40123/b/${key}` }]);
    assert.deepEqual(pageCandidates('https://pc.ts.net/', payload), []);
  });

  it('describes each failed carrier with the next step', () => {
    const lines = describeTried([{ carrier: 'lan' }, { carrier: 'relay' }]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /same Wi-Fi/);
  });
});

describe('store', () => {
  it('round-trips computer records through IndexedDB, and the counter only rises', async () => {
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const record = { id: 'a'.repeat(64), name: 'Home PC', desktopPub: 'AAAA', myPriv: 'BBBB', carriers: [{ kind: 'lan', urls: ['ws://x'] }], lastCarrier: 'lan', counter: 0 };
    await store.put(record);
    assert.equal((await store.get(record.id)).name, 'Home PC');
    assert.equal(await store.raiseCounter(record.id, 1), 1);
    assert.equal(await store.raiseCounter(record.id, 1), 2, 'a second raise goes up, never back');
    assert.equal(await store.raiseCounter(record.id, 0), 3, 'a lower minimum still gives a higher value');
    assert.equal(await store.counter(record.id), 3);
    assert.equal((await store.get(record.id)).counter, 3, 'the record mirrors the counter');
  });

  it('keeps keys out of the public view', async () => {
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put({ id: 'c1', name: 'PC', desktopPub: 'PUB', myPriv: 'SECRET', pushKey: 'PUSH', carriers: [] });
    const [pub] = await store.publicList();
    assert.equal(JSON.stringify(pub).includes('SECRET'), false);
    assert.equal(JSON.stringify(pub).includes('PUSH'), false);
    assert.deepEqual(publicComputer({ id: 'x', myPriv: 'k' }).carriers, []);
  });

  it('a failed write leaves the old value and reports the error', async () => {
    const factory = createFakeIndexedDB();
    const store = createStore({ kv: createIdbKv({ indexedDB: factory }) });
    await store.put({ id: 'k1', name: 'before', desktopPub: 'A', myPriv: 'B', carriers: [] });
    factory.failWrites = true;
    await assert.rejects(store.raiseCounter('k1', 5));
    factory.failWrites = false;
    assert.equal((await store.get('k1')).name, 'before');
  });

  it('round-trips through the secure storage plugin shape', async () => {
    const data = new Map();
    const plugin = {
      setItem: async ({ key, value }) => { data.set(key, value); },
      getItem: async ({ key }) => ({ value: data.has(key) ? data.get(key) : null }),
      removeItem: async ({ key }) => { data.delete(key); },
      keys: async () => ({ keys: [...data.keys()] }),
    };
    const store = createPlatformStore({ secureStorage: plugin });
    await store.put({ id: 'n1', name: 'Native PC', desktopPub: 'A', myPriv: 'B', carriers: [] });
    assert.equal((await store.get('n1')).name, 'Native PC');
    assert.ok([...data.keys()].every(k => k.startsWith('plenum.')), 'every key has the prefix');
    assert.equal(createSecureKv({ plugin }).kind, 'native');
  });
});

describe('app lock', () => {
  it('PIN backoff: no wait below five wrong tries, then 30 s doubling to 15 minutes', () => {
    assert.deepEqual([1, 2, 3, 4].map(pinWaitSeconds), [0, 0, 0, 0]);
    assert.deepEqual([5, 6, 7, 8, 9, 10, 11].map(pinWaitSeconds), [30, 60, 120, 240, 480, 900, 900]);
    assert.equal(isValidPin('123456'), true);
    assert.equal(isValidPin('12345'), false);
    assert.equal(isValidPin('12a456'), false);
  });

  it('wraps a key under a PIN with PBKDF2-SHA256 at 600k and AES-GCM, bound to its computer', () => {
    assert.equal(PIN_ITERATIONS, 600000);
    const salt = new Uint8Array(16).fill(5);
    const key = derivePinKey('123456', salt, 2000);
    const priv = new Uint8Array(32).map((_, i) => i + 1);
    const wrap = wrapKey(priv, key, 'computer-a');
    assert.deepEqual(Buffer.from(unwrapKey(wrap, key, 'computer-a')), Buffer.from(priv));
    assert.throws(() => unwrapKey(wrap, derivePinKey('654321', salt, 2000), 'computer-a'));
    assert.throws(() => unwrapKey(wrap, key, 'computer-b'), 'a wrap cannot move to another record');
  });

  it('PIN unlock: a wrong PIN counts up, the wait starts at five, and a restart keeps the count', async () => {
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const priv = new Uint8Array(32).map((_, i) => 200 - i);
    await store.put({ id: 'p1', name: 'PC', desktopPub: bytesToB64u(new Uint8Array(32).fill(3)), myPriv: bytesToB64u(priv), carriers: [] });
    let wall = 1_000_000;
    const lock = createLock({ store, now: () => wall, mono: () => wall, iterations: 2000 });
    { const set = await lock.setPin('123456'); assert.equal(set.ok, true); assert.ok(set.keys instanceof Map); }
    lock.lock();
    for (let i = 1; i <= 4; i++) {
      const r = await lock.unlockPin('000000');
      assert.equal(r.reason, 'wrong');
      assert.equal(r.failures, i);
      assert.equal(r.waitSec, 0);
    }
    const fifth = await lock.unlockPin('000000');
    assert.equal(fifth.waitSec, 30);
    assert.equal((await lock.unlockPin('123456')).reason, 'wait', 'the right PIN waits too');
    wall += 31_000;
    assert.equal((await lock.unlockPin('000000')).waitSec, 60, 'the wait doubles');
    // a fresh lock object reads the same store: the count survives a restart
    const again = createLock({ store, now: () => wall, mono: () => wall, iterations: 2000 });
    assert.equal((await again.status()).failures, 6);
    wall += 61_000;
    const ok = await again.unlockPin('123456');
    assert.equal(ok.ok, true);
    assert.equal(ok.keys.get('p1').length, 32);
    assert.deepEqual(Buffer.from(ok.keys.get('p1')), Buffer.from(priv), 'the key comes back intact');
    assert.equal(typeof (await store.get('p1')).myPriv, 'object', 'at rest the key stays wrapped');
  });

  it('lock on background: five minutes away locks, less does not', async () => {
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    let wall = 0;
    const lock = createLock({ store, now: () => wall, iterations: 2000 });
    await store.meta.put('lock', { mode: 'passkey', failures: 0, lockedUntil: 0 });
    await store.meta.put('passkey', { id: 'AAAA' });
    const gate = { available: async () => true, verify: async () => true, register: async () => 'AAAA' };
    const lock2 = createLock({ store, now: () => wall, iterations: 2000, passkey: gate });
    await lock2.lockOnLaunch();
    assert.equal(lock2.isLocked(), true, 'a lock that is on starts locked');
    assert.equal((await lock2.unlockPasskey()).ok, true);
    lock2.onBackground();
    wall += BACKGROUND_LOCK_MS - 1000;
    assert.equal(await lock2.onForeground(), false, 'four minutes fifty-nine seconds stays open');
    lock2.onBackground();
    wall += BACKGROUND_LOCK_MS;
    assert.equal(await lock2.onForeground(), true);
  });

  it('a passkey gate reports unavailable without WebAuthn, the case of the LAN page', async () => {
    const gate = createPasskeyGate({ credentials: undefined, PublicKeyCredentialCtor: undefined });
    assert.equal(await gate.available(), false);
  });
});

describe('stop copy, debug console, notifications', () => {
  it('Stop result copy counts each kind and pluralises', () => {
    assert.equal(stopResultText({ cancelled: 2, drivesStopped: 1, agentsStopped: 3, cardsDenied: 1 }, 'Home PC'),
      'Stopped everything on Home PC: 2 replies, 1 computer run, 3 agents. 1 card denied.');
    assert.equal(stopResultText({}, 'Home PC'), 'Nothing was running on Home PC.');
    assert.equal(stopResultText({ cancelled: 1, cardsDenied: 2 }, 'PC'), 'Stopped everything on PC: 1 reply. 2 cards denied.');
  });

  it('the Stop controller shows queued, then done, then idle after 1.6 s', async () => {
    const clock = createFakeClock(0);
    const listeners = [];
    const channel = {
      onStopState: fn => { listeners.push(fn); return () => {}; },
      stop: () => {
        listeners.forEach(fn => fn({ sid: 1, state: 'queued' }));
        return Promise.resolve({ id: 'x', cancelled: 1, drivesStopped: 0, agentsStopped: 0, cardsDenied: 0 });
      },
    };
    const ctl = createStopController({ channel, clock, computerName: 'Home PC' });
    const seen = [];
    ctl.subscribe(v => seen.push(v.state));
    const done = await ctl.press();
    assert.equal(done.state, 'done');
    assert.match(done.text, /Stopped everything on Home PC: 1 reply/);
    assert.ok(seen.includes('queued'));
    clock.advance(1600);
    assert.equal(ctl.state, 'idle');
  });

  it('the debug ring holds 500 lines and redacts secrets', () => {
    const log = createDebugLog({ now: () => 5 });
    for (let i = 0; i < RING_LINES + 20; i++) log.log(`line ${i}`);
    assert.equal(log.lines().length, RING_LINES);
    assert.equal(log.lines()[0].text, 'line 20');
    const key = 'A'.repeat(43);
    assert.equal(redactLine(`x-plenum-token: ${'f'.repeat(64)} and ${key}`).includes('ffff'), false);
    assert.equal(redactLine(`psk=${key}`).includes(key), false);
    assert.ok(redactLine('y'.repeat(5000)).length <= LINE_MAX);
    assert.equal(redactLine('a\u0001b'), 'a b');
  });

  it('parses the notification links, with the ids the computer makes (a UUID for a card), and leaves other hashes alone', () => {
    assert.deepEqual(parseNotificationHash('#stop'), { kind: 'stop' });
    assert.deepEqual(parseNotificationHash('#deny=0123456789abcdef'), { kind: 'deny', id: '0123456789abcdef' });
    const uuid = '4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11';
    assert.deepEqual(parseNotificationHash(`#deny=${uuid}`), { kind: 'deny', id: uuid }, 'a hyphenated UUID is an approval id (server.mjs randomUUID)');
    assert.deepEqual(parseNotificationHash(`#approve=${uuid}&line=Run%3A%20npm%20test`), { kind: 'approve', id: uuid, line: 'Run: npm test' });
    assert.deepEqual(parseNotificationHash(`#approve=${uuid}`), { kind: 'approve', id: uuid, line: '' }, 'no line: the page never approves');
    assert.deepEqual(parseNotificationHash('#waiting'), { kind: 'waiting' });
    assert.deepEqual(parseNotificationHash(`#waiting=${uuid}`), { kind: 'waiting', id: uuid });
    assert.deepEqual(parseNotificationHash('#handover=d1'), { kind: 'handover', id: 'd1' });
    assert.deepEqual(parseNotificationHash('#chat'), { kind: 'chat' });
    assert.deepEqual(parseNotificationHash('#chat=p1'), { kind: 'chat', project: 'p1' });
    assert.deepEqual(parseNotificationHash('#settings=limit'), { kind: 'settings', section: 'limit' });
    assert.deepEqual(parseNotificationHash('#home'), { kind: 'home' });
    for (const bad of ['#deny=', '#deny=a b', '#deny=../x', `#deny=${'a'.repeat(81)}`, '#projects', '#settings=other', '#stop=1', '#waiting=a&line=x', '', '#approve']) assert.equal(parseNotificationHash(bad), null, bad);
    assert.equal(isRouteLink(parseNotificationHash('#chat=p1')), true);
    assert.equal(isRouteLink(parseNotificationHash('#stop')), false);
    assert.equal(pushAvailable({}), false, 'no service worker, no push on a plain page');
  });

  it('a deep link of the native app becomes the fragment the shell runs, and anything else is ignored', () => {
    assert.equal(linkOfUrl('plenum://app/#stop'), '#stop');
    assert.equal(linkOfUrl('plenum://app/#approve=ap1&line=npm%20test'), '#approve=ap1&line=npm%20test');
    assert.equal(linkOfUrl('plenum://pair#abc'), 'plenum://pair#abc');
    for (const other of ['https://evil.example/#stop', 'plenum://other/#stop', 'plenum://app/', '', null]) assert.equal(linkOfUrl(other), null, String(other));
  });

  it('subscribes for web push after a grant and posts the subscription to the computer', async () => {
    const posted = [];
    const registration = { pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }) }) } };
    const env = { isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
    const notification = { requestPermission: async () => 'granted' };
    const request = async (req, body) => { posted.push({ req, body }); return { status: 200, body: { cancel: async () => {} } }; };
    const out = await subscribeWebPush({ registration, applicationServerKey: bytesFromText('AQ'), request, deviceId: 'd1', notification, env });
    assert.equal(out.state, 'on');
    assert.equal(posted[0].req.path, '/api/phones/push');
    assert.equal(JSON.parse(posted[0].body).id, 'd1');
  });
});

describe('the shell flow (createShell over the fake computer)', () => {
  it('pairs from a link, connects, runs Stop, locks, and forgets a computer', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const psk = new Uint8Array(32).fill(4);
    const offer = '5e'.repeat(16);
    desktop.openOffer(psk, offer);
    const idb = createFakeIndexedDB();
    const store = createStore({ kv: createIdbKv({ indexedDB: idb }) });
    const lock = createLock({ store, now: () => Date.now(), iterations: 2000 });
    const shell = createShell({
      store,
      lock,
      createWorker: fakeWorkerFactory({ net, clock, store }),
      device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
      caps: ['ui-from-desktop'],
      stopClock: clock,
    });
    await shell.boot();
    assert.equal(shell.state().route, 'welcome');
    const link = `plenum://pair#${Buffer.from(JSON.stringify({ v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(psk), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' })).toString('base64url')}`;
    const pairing = shell.pair(link);
    for (let i = 0; i < 10 && !shell.state().pairing?.code; i++) await settle();
    assert.equal(shell.state().route, 'code', 'the code screen is up');
    assert.match(shell.state().pairing.code, /^[0-9]{6}$/);
    desktop.allow(offer);
    const result = await pairing;
    assert.equal(result.state, 'allowed');
    await waitFor(() => shell.state().connection.status === 'connected' && shell.state().hello);
    assert.equal(shell.state().route, 'connected');
    assert.equal(shell.state().hello.desktopName, 'Test PC');
    const ack = await shell.stop();
    assert.equal(ack.state, 'done');
    assert.match(ack.text, /Nothing was running on Test PC\.|Stopped everything on Test PC/);
    // keys are never in the state
    const flat = JSON.stringify(shell.state());
    assert.equal(flat.includes(bytesToB64u(psk)), false);
    assert.equal(flat.includes('privateKey'), false);
    // No lock is set: locking does nothing, and Stop stays reachable (F4).
    assert.deepEqual(await shell.lockNow(), { ok: false, reason: 'no-lock' });
    assert.equal(shell.state().route, 'connected');
    assert.equal(shell.state().connection.status, 'connected', 'the channel stays open');
    assert.deepEqual(await shell.setPin('123456'), { ok: true, reason: null });
    assert.deepEqual(await shell.lockNow(), { ok: true, reason: null });
    assert.equal(shell.state().route, 'locked');
    assert.notEqual(shell.state().connection.status, 'connected', 'lock closed the channel');
    assert.equal(shell.state().channel ?? null, null);
    await shell.forget(result.computerId);
    assert.equal(shell.state().computers.length, 0);
    assert.notEqual(shell.state().route, 'connected');
  });

  it('demo mode routes to the demo screen without a computer', async () => {
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const shell = createShell({ store, mode: 'demo', createWorker: () => { throw new Error('no worker in demo'); } });
    await shell.boot();
    assert.equal(shell.state().route, 'demo');
    assert.equal(shell.state().computers[0].id, 'demo');
    assert.equal(shell.channel, null);
  });

  it('refuses a broken link with a named reason and keeps the pairing screen state', async () => {
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const shell = createShell({ store, createWorker: () => { throw new Error('no worker needed'); } });
    await shell.boot();
    const out = await shell.pair('https://example.com/#nothing');
    assert.equal(out.state, 'failed');
    assert.equal(out.reason, 'not-plenum');
  });

  it('a Stop from a notification is queued while the computer is away and goes out when it returns, inside the 60 s window', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(freshComputer(desktop, phone, { counter: 0 }));
    const shell = createShell({
      store,
      createWorker: fakeWorkerFactory({ net, clock, store }),
      device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
      caps: ['ui-from-desktop'],
      pageUrl: 'https://phone.example/#stop',
      stopClock: clock,
    });
    desktop.killAll();
    const started = shell.start();
    await settle();
    assert.equal(shell.state().stop.state, 'queued', 'the STOP is queued, not given up');
    for (let t = 0; t < 20_000; t += 1000) {
      clock.advance(1000);
      await settle();
    }
    desktop.comeBack();
    await walk(clock, 20_000);
    await started;
    assert.equal(desktop.stats.stops, 1, 'the STOP reached the computer once');
    assert.ok(shell.state().stop.ack?.id, 'the computer answered the STOP with its ack');
  });

  it('a computer paired while a PIN is set is stored wrapped, connects in this unlocked session, and the PIN still opens its key', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const psk = new Uint8Array(32).fill(6);
    const offer = '6f'.repeat(16);
    desktop.openOffer(psk, offer);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const wall = 1_000_000;
    const lock = createLock({ store, now: () => wall, iterations: 2000 });
    { const set = await lock.setPin('123456'); assert.equal(set.ok, true); assert.ok(set.keys instanceof Map); }
    const shell = createShell({
      store,
      lock,
      createWorker: fakeWorkerFactory({ net, clock, store }),
      device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
      caps: ['ui-from-desktop'],
      stopClock: clock,
    });
    await shell.boot();
    assert.equal(shell.state().route, 'locked', 'a PIN lock starts locked');
    assert.equal((await shell.pair('plenum://pair#x')).reason, 'locked', 'pairing is refused while locked');
    assert.equal((await shell.unlock('pin', '123456')).ok, true);
    const link = `plenum://pair#${Buffer.from(JSON.stringify({ v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(psk), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' })).toString('base64url')}`;
    const pairing = shell.pair(link);
    for (let i = 0; i < 10 && !shell.state().pairing?.code; i++) await settle();
    desktop.allow(offer);
    const result = await pairing;
    assert.equal(result.state, 'allowed');
    const id = deviceId(desktop.keys.publicKey);
    assert.equal(typeof (await store.get(id)).myPriv, 'object', 'the new key rests wrapped under the PIN, never plain');
    await waitFor(() => shell.state().connection.status === 'connected');
    assert.equal(shell.state().route, 'connected', 'it connects in this unlocked session');
    await shell.lockNow();
    const again = createLock({ store, now: () => wall, iterations: 2000 });
    const back = await again.unlockPin('123456');
    assert.equal(back.ok, true);
    assert.equal(back.keys.get(id)?.length, 32, 'the PIN still opens the key of the new computer');
  });
});

// A shell connected to a fake computer. options: { desktop, shell, withLock }. The shell's own clock (stopClock) is separate from the one the
// channel runs on, so a test can move the shell's wall time by minutes without firing a reconnect or a keepalive.
async function connectedShell({ desktop: desktopOptions = {}, shell: shellOptions = {}, withLock = false, connect = true } = {}) {
  const net = createFakeNet();
  const clock = createFakeClock(0);
  const wall = createFakeClock(1_000_000);
  const desktop = createFakeDesktop({ net, ...desktopOptions });
  const phone = generateKeyPair();
  desktop.counters.set(deviceId(phone.publicKey), 0);
  const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
  await store.put(freshComputer(desktop, phone, { counter: 0 }));
  const lock = withLock ? createLock({ store, now: () => wall.now(), iterations: 2000 }) : null;
  const shell = createShell({
    store,
    lock,
    createWorker: fakeWorkerFactory({ net, clock, store }),
    device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
    caps: ['ui-from-desktop'],
    stopClock: wall,
    ...shellOptions,
  });
  await shell.start();
  if (connect) await waitFor(() => shell.state().hello, 8000);
  return { shell, desktop, clock, wall, store, net, phone, id: deviceId(desktop.keys.publicKey), deviceId: deviceId(phone.publicKey) };
}

describe('the service worker is registered for the PWA, and a push subscription does not wait for it forever (F1, M10)', () => {
  const page = (extra = {}) => {
    const calls = [];
    const env = {
      isSecureContext: true,
      location: { href: 'https://relay.example/?shell', hostname: 'relay.example', protocol: 'https:' },
      navigator: { serviceWorker: { register: async (url, options) => { calls.push([url, options]); return { scope: options.scope }; } } },
      ...extra,
    };
    return { env, calls };
  };

  it('registers sw.js at the origin root on an https page, and beside the page when it lives under /p/<key>/', async () => {
    const a = page();
    assert.deepEqual(await registerServiceWorker(a.env), { scope: '/' });
    assert.deepEqual(a.calls, [['https://relay.example/sw.js', { scope: '/' }]]);
    const key = 'd'.repeat(32);
    const b = page({ location: { href: `https://pc.tail.ts.net/p/${key}/`, hostname: 'pc.tail.ts.net', protocol: 'https:' } });
    await registerServiceWorker(b.env);
    assert.deepEqual(b.calls, [[`https://pc.tail.ts.net/p/${key}/sw.js`, { scope: '/' }]], 'the listener sends Service-Worker-Allowed for it');
  });

  it('registers nothing on the plain-http LAN page, outside a secure context, or on a native app; a refusal is swallowed', async () => {
    const lan = page({ isSecureContext: false, location: { href: 'http://192.168.1.5:40123/', hostname: '192.168.1.5', protocol: 'http:' } });
    assert.equal(await registerServiceWorker(lan.env), null);
    const insecure = page({ isSecureContext: false });
    assert.equal(await registerServiceWorker(insecure.env), null);
    const native = page({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } });
    assert.equal(await registerServiceWorker(native.env), null);
    assert.equal(await registerServiceWorker({ isSecureContext: true, location: { href: 'https://x.example/', hostname: 'x.example', protocol: 'https:' }, navigator: {} }), null, 'no service worker API');
    for (const p of [lan, insecure, native]) assert.deepEqual(p.calls, []);
    const refusing = page({ navigator: { serviceWorker: { register: async () => { throw new Error('SecurityError'); } } } });
    assert.equal(await registerServiceWorker(refusing.env), null);
  });

  it('registrationOf takes the registration the page has, else the one that becomes ready in time, else nothing (never ready forever)', async () => {
    const reg = { pushManager: {} };
    assert.equal(await registrationOf({ getRegistration: async () => reg }), reg);
    assert.equal(await registrationOf({ getRegistration: async () => undefined, ready: Promise.resolve(reg) }), reg);
    const started = Date.now();
    assert.equal(await registrationOf({ getRegistration: async () => undefined, ready: new Promise(() => {}) }, { wait: 30 }), null);
    assert.ok(Date.now() - started < 1000, 'gave up');
    assert.equal(await registrationOf(null), null);
  });

  it('turning notifications on subscribes with the computer\'s VAPID key from HELLO and posts { id, subscription } to /api/phones/push', async () => {
    const vapid = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
    const subscribed = [];
    const registration = {
      pushManager: {
        subscribe: async options => { subscribed.push(options); return { toJSON: () => ({ endpoint: 'https://push.example/send/xyz', keys: { p256dh: 'AAAA', auth: 'BBBB' } }) }; },
      },
    };
    const notifications = { permission: 'default', requestPermission: async () => 'granted' };
    const pushEnv = { isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
    const k = await connectedShell({
      desktop: { vapidPublicKey: vapid },
      shell: { notifications, pushEnv, serviceWorker: { getRegistration: async () => registration } },
    });
    assert.equal(k.shell.state().hello.deviceId, k.deviceId, 'the phone\'s own id comes with HELLO');
    const out = await k.shell.enableNotifications();
    assert.deepEqual(out, { ok: true, reason: null });
    assert.equal(subscribed.length, 1);
    assert.deepEqual(Array.from(subscribed[0].applicationServerKey), Array.from(new Uint8Array(65).fill(4)), 'subscribed with the key HELLO carried');
    const sent = k.desktop.stats.pushes.at(-1);
    assert.equal(sent.id, k.deviceId);
    assert.deepEqual(sent.subscription, { endpoint: 'https://push.example/send/xyz', keys: { p256dh: 'AAAA', auth: 'BBBB' } });
  });

  it('without the computer\'s key, with a refused permission, or with no service worker, the answer says why and nothing is posted', async () => {
    const registration = { pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://push.example/x', keys: {} }) }) } };
    const pushEnv = { isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
    const vapid = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
    const none = await connectedShell({ shell: { notifications: { requestPermission: async () => 'granted' }, pushEnv, serviceWorker: { getRegistration: async () => registration } } });
    assert.deepEqual(await none.shell.enableNotifications(), { ok: false, reason: 'unavailable' }, 'an old computer sends no key');
    const denied = await connectedShell({ desktop: { vapidPublicKey: vapid }, shell: { notifications: { requestPermission: async () => 'denied' }, pushEnv, serviceWorker: { getRegistration: async () => registration } } });
    assert.deepEqual(await denied.shell.enableNotifications(), { ok: false, reason: 'denied' });
    assert.equal(denied.desktop.stats.pushes.filter(p => p.subscription).length, 0);
    const bare = await connectedShell({ desktop: { vapidPublicKey: vapid }, shell: { notifications: { requestPermission: async () => 'granted' }, pushEnv, serviceWorker: null } });
    assert.deepEqual(await bare.shell.enableNotifications(), { ok: false, reason: 'unavailable' });
  });
});

describe('the app lock, the lock time and the platform handshake (F4, M14, M8)', () => {
  it('lockNow with no lock does nothing and answers no-lock; with a PIN it locks and drops the channel', async () => {
    const k = await connectedShell({ withLock: true });
    assert.deepEqual(await k.shell.lockNow(), { ok: false, reason: 'no-lock' });
    assert.equal(k.shell.state().locked, false);
    assert.equal(k.shell.state().connection.status, 'connected', 'the channel is still open');
    assert.ok(k.shell.channel, 'and Stop still has its channel');
    assert.equal((await k.shell.setPin('123456')).ok, true);
    assert.deepEqual(await k.shell.lockNow(), { ok: true, reason: null });
    assert.equal(k.shell.state().locked, true);
    assert.equal(k.shell.channel, null);
    // lockNow without any lock object (a bare shell) is the same no-op.
    const bare = await connectedShell({ withLock: false });
    assert.deepEqual(await bare.shell.lockNow(), { ok: false, reason: 'no-lock' });
    assert.equal(bare.shell.state().locked, false);
  });

  it('the lock time is the person\'s: 6 minutes away does not lock at 15 minutes (and pairing is not refused), and locks at the default 5', async () => {
    const k = await connectedShell({ withLock: true });
    assert.equal((await k.shell.setPin('123456')).ok, true);
    await k.shell.setPrefs({ lockAfter: 'm15' });
    await k.shell.visibility(false);
    k.wall.advance(6 * 60 * 1000);
    await k.shell.visibility(true);
    assert.equal(k.shell.state().locked, false, 'six minutes is inside fifteen');
    assert.notEqual((await k.shell.pair('https://example.com/#nothing')).reason, 'locked', 'pairing works');
    await k.shell.setPrefs({ lockAfter: 'm5' });
    await k.shell.visibility(false);
    k.wall.advance(6 * 60 * 1000);
    await k.shell.visibility(true);
    assert.equal(k.shell.state().locked, true, 'six minutes is past five');
    assert.equal((await k.shell.pair('https://example.com/#nothing')).reason, 'locked', 'and pairing is refused until the unlock');
    // A short absence under any setting does not lock.
    assert.equal((await k.shell.unlock('pin', '123456')).ok, true);
    await k.shell.visibility(false);
    k.wall.advance(30 * 1000);
    await k.shell.visibility(true);
    assert.equal(k.shell.state().locked, false);
  });

  it('M8: the handshake says lan-web with a picture for artifacts on a plain-http page, whatever its path, and pwa with Web Push on https', () => {
    const lan = deviceFor({ location: { href: 'http://192.168.1.5:40123/', hostname: '192.168.1.5', protocol: 'http:' }, isSecureContext: false });
    assert.equal(lan.device.app, 'lan-web');
    assert.equal(lan.device.name, 'This browser');
    assert.ok(lan.caps.includes('artifacts-picture') && lan.caps.includes('push-none') && !lan.caps.includes('artifacts-iframe') && !lan.caps.includes('push-webpush'));
    const underPath = deviceFor({ location: { href: `http://192.168.1.5:40123/p/${'a'.repeat(32)}/`, hostname: '192.168.1.5', protocol: 'http:' }, isSecureContext: false });
    assert.deepEqual(underPath, lan, 'the shell page and the UI page of the LAN origin say the same thing');
    const pwa = deviceFor({ location: { href: 'https://relay.example/', hostname: 'relay.example', protocol: 'https:' }, isSecureContext: true });
    assert.equal(pwa.device.app, 'pwa');
    assert.ok(pwa.caps.includes('artifacts-iframe') && pwa.caps.includes('push-webpush'));
    const android = deviceFor({ location: { href: 'https://localhost/', hostname: 'localhost', protocol: 'https:' }, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } });
    assert.equal(android.device.app, 'android');
    assert.equal(android.native, true);
  });

  it('M11: the Android app tells its PlenumPrivacy plugin the switcher preference after launch and at every change; the web page and the iPhone do not', async () => {
    const calls = [];
    const native = { PlenumPrivacy: { setHideInSwitcher: async arg => { calls.push(arg); return arg; } } };
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const android = createShell({ store, device: { name: 'p', platform: 'android', app: 'android', appVersion: '1', uiHash: '' }, native, createWorker: () => { throw new Error('none'); } });
    await android.boot();
    await settle();
    assert.deepEqual(calls, [{ enabled: true }], 'on by default');
    await android.setPrefs({ hideSwitcher: false });
    await settle();
    assert.deepEqual(calls, [{ enabled: true }, { enabled: false }]);
    await android.setPrefs({ theme: 'dark' });
    await android.setPrefs({ hideSwitcher: false });
    await settle();
    assert.equal(calls.length, 2, 'a change to another preference, or the same value, calls nothing');
    await android.setPrefs({ hideSwitcher: true });
    await settle();
    assert.deepEqual(calls.at(-1), { enabled: true });
    const other = [];
    for (const platform of ['ios', 'web']) {
      const shell = createShell({ store: createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) }), device: { name: 'p', platform, app: platform, appVersion: '1', uiHash: '' }, native: { PlenumPrivacy: { setHideInSwitcher: async arg => { other.push(arg); } } }, createWorker: () => { throw new Error('none'); } });
      await shell.boot();
      await shell.setPrefs({ hideSwitcher: false });
    }
    await settle();
    assert.deepEqual(other, [], 'the plugin exists only on Android');
  });

  it('L18: the settings screen can read what dictation can do on this phone', async () => {
    const native = { Dictation: { available: async () => ({ available: true, onDevice: true, permission: 'prompt', platform: 'android' }) } };
    const shell = createShell({ store: createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) }), device: { name: 'p', platform: 'android', app: 'android', appVersion: '1', uiHash: '' }, native, createWorker: () => { throw new Error('none'); } });
    await shell.boot();
    await settle();
    assert.deepEqual(shell.state().dictation, { available: true, onDevice: true, permission: 'prompt' });
    const none = createShell({ store: createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) }), createWorker: () => { throw new Error('none'); } });
    await none.boot();
    assert.equal(none.state().dictation, null, 'the web page has none');
  });

  it('M7: scan() reads the pairing link with the scanner plugin, or says it is unavailable', async () => {
    const scans = [];
    const native = { BarcodeScanner: { scan: async () => { scans.push(1); return { ok: true, text: 'plenum://pair#abc' }; } } };
    const shell = createShell({ store: createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) }), device: { name: 'p', platform: 'ios', app: 'ios', appVersion: '1', uiHash: '' }, native, createWorker: () => { throw new Error('none'); } });
    assert.deepEqual(await shell.scan(), { ok: true, text: 'plenum://pair#abc' });
    assert.equal(scans.length, 1);
    const web = createShell({ store: createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) }), createWorker: () => { throw new Error('none'); } });
    assert.deepEqual(await web.scan(), { ok: false, reason: 'unavailable' });
  });
});

describe('the connection: a cookie reply, a computer that is too new, and one that is too old (M14)', () => {
  it('a computer under load answers message 1 with a cookie reply; the phone sends it again with the cookie and connects', async () => {
    const k = await connectedShell({ desktop: { cookieReply: true } });
    assert.equal(k.shell.state().connection.status, 'connected');
    assert.ok(k.desktop.stats.cookieReplies >= 1, 'the cookie reply was sent');
    assert.equal(k.desktop.stats.handshakes, 1, 'one handshake, after the retry');
  });

  it('protocol major 2 says update-app, major 0 says update-desktop, and neither connects or keeps retrying', async () => {
    const newer = await connectedShell({ desktop: { protocolMajor: 2 }, connect: false });
    await waitFor(() => newer.shell.state().connection.status === 'update-app', 8000);
    assert.equal(newer.shell.state().hello, null);
    assert.equal(screenFor({ ...newer.shell.state() }, {}), 'update-app', 'the shell calls for the update screen');
    const before = newer.desktop.stats.handshakes;
    await walk(newer.clock, 20_000);
    assert.equal(newer.desktop.stats.handshakes, before, 'no retry');
    const older = await connectedShell({ desktop: { protocolMajor: 0 }, connect: false });
    await waitFor(() => older.shell.state().connection.status === 'update-desktop', 8000);
    assert.equal(screenFor(older.shell.state(), {}), 'update-desktop');
  });
});

describe('notification links (H7)', () => {
  it('Approve from a notification sends the card with the first line in x-plenum-notify-line, and says Approved', async () => {
    const k = await connectedShell();
    const out = await k.shell.handleHash('#approve=4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11&line=Run%3A%20npm%20test');
    assert.equal(out.ok, true);
    assert.deepEqual(k.desktop.stats.approvals.at(-1), { approvalId: '4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11', allow: true, line: 'Run: npm test' });
    assert.equal(k.shell.state().notice.text, 'Approved.');
  });

  it('a card that changed (409) says so and opens the card; a link with no first line sends nothing and opens the card', async () => {
    const k = await connectedShell({ desktop: { approveStatus: 409 } });
    const out = await k.shell.handleHash('#approve=ap1&line=Run%3A%20npm%20test');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'changed');
    assert.equal(k.shell.state().notice.text, CARD_CHANGED);
    assert.equal(CARD_CHANGED, 'That card changed. Open it to answer.');
    assert.deepEqual({ kind: k.shell.state().intent.kind, id: k.shell.state().intent.id }, { kind: 'waiting', id: 'ap1' }, 'the Waiting card opens');
    const sent = k.desktop.stats.approvals.length;
    const bare = await k.shell.handleHash('#approve=ap2');
    assert.equal(bare.reason, 'open-card');
    assert.equal(k.desktop.stats.approvals.length, sent, 'without the line it would be taken for an answer from the open card, so nothing is sent');
    assert.equal(k.shell.state().intent.id, 'ap2');
  });

  it('Deny is sent as it is, with no line; Stop goes out; route links become one intent each, taken once', async () => {
    const k = await connectedShell();
    assert.equal((await k.shell.handleHash('#deny=ap9')).ok, true);
    assert.deepEqual(k.desktop.stats.approvals.at(-1), { approvalId: 'ap9', allow: false, line: null });
    assert.equal((await k.shell.handleHash('#waiting=ap9')).kind, 'waiting');
    assert.equal(k.shell.state().intent.seq, 1);
    assert.deepEqual(k.shell.takeRoute()?.kind, 'waiting');
    assert.equal(k.shell.takeRoute(), null, 'taken once');
    await k.shell.handleHash('#settings=limit');
    assert.equal(k.shell.state().intent.section, 'limit');
    await k.shell.handleHash('#handover=d1');
    await k.shell.handleHash('#chat=p1');
    assert.equal(k.shell.state().intent.seq, 4);
    assert.deepEqual(k.shell.takeRoute(), { kind: 'chat', project: 'p1', seq: 4, taken: true });
    assert.equal((await k.shell.handleHash('#nonsense')).reason, 'no link');
    const stopped = await k.shell.handleHash('#stop');
    assert.equal(stopped.state, 'done');
  });

  it('a link that arrives while the app is locked waits for the unlock, then runs', async () => {
    const k = await connectedShell({ withLock: true });
    assert.equal((await k.shell.setPin('123456')).ok, true);
    await k.shell.lockNow();
    const waiting = await k.shell.handleHash('#approve=ap1&line=Run%3A%20x');
    assert.equal(waiting.reason, 'locked');
    assert.equal(k.desktop.stats.approvals.length, 0, 'nothing was sent behind the lock');
    assert.equal((await k.shell.unlock('pin', '123456')).ok, true);
    await waitFor(() => k.desktop.stats.approvals.length === 1, 8000);
    assert.equal(k.desktop.stats.approvals[0].line, 'Run: x');
  });

  it('a route that arrives on the shell page is kept for the UI page (onIntent), and an approve link is never a route', async () => {
    const intents = [];
    const k = await connectedShell({ shell: { onIntent: link => intents.push(link) } });
    await k.shell.handleHash('#waiting=ap1');
    assert.deepEqual(intents, [{ kind: 'waiting', id: 'ap1' }]);
    const asUi = await connectedShell({ shell: { pageKind: 'ui', initialIntent: { kind: 'chat', project: 'p1' }, onIntent: link => intents.push(link) } });
    assert.equal(asUi.shell.state().intent.kind, 'chat', 'the route that came with the page is waiting for the phone layer');
    assert.equal(asUi.shell.takeRoute().project, 'p1');
    await asUi.shell.handleHash('#waiting=ap2');
    assert.equal(intents.length, 1, 'on the UI page the route is shown there, not kept');
  });
});

describe('the desktop UI is handed over to after HELLO (H3)', () => {
  const fakeUiHost = (over = {}) => {
    const calls = [];
    const host = {
      kind: 'web',
      calls,
      show: async args => { calls.push(['show', args.hello?.deviceId ?? null, args.loadedHash]); return over.show ? over.show(args) : { ok: true, status: 'updated', navigated: true }; },
      refresh: async args => { calls.push(['refresh', args.loadedHash]); return over.refresh ? over.refresh(args) : { ok: true, changed: false, reload: false }; },
      loadedHash: async () => over.loaded ?? 'hash-on-page',
      hasCopy: async () => over.hasCopy ?? true,
      useCopy: async () => { calls.push(['useCopy']); return { ok: true, status: 'copy', navigated: true }; },
      openShell: async hash => { calls.push(['openShell', hash ?? '']); return true; },
    };
    return host;
  };

  it('the shell page pulls the UI once the computer says hello and the page leaves for it; the shell state says so for the loading screen', async () => {
    const uiHost = fakeUiHost();
    const k = await connectedShell({ shell: { uiHost } });
    await waitFor(() => k.shell.state().ui.state === 'navigating', 8000);
    assert.deepEqual(uiHost.calls[0], ['show', k.deviceId, null]);
    assert.equal(screenFor(k.shell.state(), {}), 'loading', 'the loading screen, not the stand-in');
    assert.equal(k.shell.state().ui.kind, 'web');
  });

  it('a pull that fails shows ui-failed with the cause and Use the copy; Try again pulls again; Use the copy navigates without asking the computer', async () => {
    let fail = true;
    const uiHost = fakeUiHost({ show: () => (fail ? { ok: false, cause: 'checksum' } : { ok: true, status: 'updated', navigated: true }) });
    const k = await connectedShell({ shell: { uiHost } });
    await waitFor(() => k.shell.state().ui.state === 'failed', 8000);
    assert.equal(k.shell.state().ui.cause, 'checksum');
    assert.equal(k.shell.state().ui.hasCopy, true);
    assert.equal(screenFor(k.shell.state(), {}), 'ui-failed');
    fail = false;
    assert.equal((await k.shell.showUi({ force: true })).ok, true);
    assert.equal(k.shell.state().ui.state, 'navigating');
    assert.equal(uiHost.calls.filter(c => c[0] === 'show').length, 2);
    const failedAgain = await connectedShell({ shell: { uiHost: fakeUiHost({ show: () => ({ ok: false, cause: 'worker' }) }) } });
    await waitFor(() => failedAgain.shell.state().ui.state === 'failed', 8000);
    assert.equal(failedAgain.shell.state().ui.cause, 'worker');
    assert.equal((await failedAgain.shell.useCopy()).ok, true);
    assert.equal(failedAgain.shell.state().ui.state, 'navigating');
  });

  it('/?shell keeps the person on the shell\'s own screens until Open Plenum; a fresh pairing waits for the onboarding to end', async () => {
    const uiHost = fakeUiHost();
    const k = await connectedShell({ shell: { uiHost, stay: true } });
    await settle(100);
    assert.deepEqual(uiHost.calls, [], 'stay: no hand-over');
    assert.equal(screenFor(k.shell.state(), {}), null, 'the connected stand-in');
    assert.equal((await k.shell.showUi({ force: true })).ok, true);
    assert.equal(uiHost.calls[0][0], 'show');
    // Pairing: the onboarding steps (app lock, notifications) are shell screens, so the page stays until the screens release it.
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const psk = new Uint8Array(32).fill(8);
    const offer = '7a'.repeat(16);
    desktop.openOffer(psk, offer);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const host2 = fakeUiHost();
    const shell = createShell({ store, createWorker: fakeWorkerFactory({ net, clock, store }), device: { name: 'p', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' }, caps: ['ui-from-desktop'], stopClock: clock, uiHost: host2 });
    await shell.boot();
    const link = `plenum://pair#${Buffer.from(JSON.stringify({ v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(psk), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' })).toString('base64url')}`;
    const pairing = shell.pair(link);
    for (let i = 0; i < 10 && !shell.state().pairing?.code; i++) await settle();
    desktop.allow(offer);
    assert.equal((await pairing).state, 'allowed');
    await waitFor(() => shell.state().hello, 8000);
    await settle(50);
    assert.deepEqual(host2.calls, [], 'not yet: the person has two onboarding steps to see');
    shell.releaseUi();
    await waitFor(() => host2.calls.some(c => c[0] === 'show'), 8000);
  });

  it('the UI page keeps the channel, asks whether the computer has a newer UI once per HELLO and reloads once when it does; it never navigates away', async () => {
    let reloads = 0;
    const uiHost = fakeUiHost({ refresh: () => ({ ok: true, changed: true, reload: true }) });
    const k = await connectedShell({ shell: { uiHost, pageKind: 'ui', onReload: () => { reloads += 1; } } });
    await waitFor(() => reloads === 1, 8000);
    assert.deepEqual(uiHost.calls[0], ['refresh', 'hash-on-page'], 'the hash the page was served from');
    assert.equal(uiHost.calls.some(c => c[0] === 'show'), false);
    assert.equal(k.shell.state().ui.state, 'idle');
    assert.equal(k.shell.state().page, 'ui');
  });

  it('the UI page sends the person to the shell\'s screens when there is nothing for the UI to show: a revoked phone, no computer, a pairing link', async () => {
    const uiHost = fakeUiHost();
    const revoked = await connectedShell({ shell: { uiHost, pageKind: 'ui' } });
    assert.equal(uiHost.calls.some(c => c[0] === 'openShell'), false, 'a connected UI page stays');
    revoked.desktop.revokeAll();
    await waitFor(() => uiHost.calls.some(c => c[0] === 'openShell'), 8000);
    const gone = fakeUiHost();
    const forgetful = await connectedShell({ shell: { uiHost: gone, pageKind: 'ui' } });
    await forgetful.shell.forget(forgetful.id);
    assert.ok(gone.calls.some(c => c[0] === 'openShell'), 'no computer left');
    const linkHost = fakeUiHost();
    const linked = await connectedShell({ shell: { uiHost: linkHost, pageKind: 'ui' } });
    const out = await linked.shell.handleHash('#pair=eyJ2IjoxfQ');
    assert.equal(out.kind, 'pair');
    assert.deepEqual(linkHost.calls.filter(c => c[0] === 'openShell'), [['openShell', '#pair=eyJ2IjoxfQ']], 'the pairing screens are the shell page\'s');
  });
});

describe('ui-host.js: where the page goes on each platform (H3)', () => {
  const fakeEnv = (extra = {}) => {
    const store = new Map();
    const nav = [];
    const env = {
      location: { href: 'https://relay.example/?shell', pathname: '/', search: '?shell', replace: url => nav.push(['replace', url]), assign: url => nav.push(['assign', url]) },
      sessionStorage: { setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k) },
      caches: {},
      navigator: { serviceWorker: { controller: {}, ready: Promise.resolve({}), addEventListener() {} } },
      setTimeout, clearTimeout,
      fetch: async () => new Response('x'),
      ...extra,
    };
    return { env, nav, store };
  };
  const loaderFactory = (log, answer = { status: 'updated', reload: false }) => options => ({
    check: async args => { log.push(['check', options.platform, args.helloHash, args.loadedHash]); return answer; },
  });

  it('web: the loader checks with the hello hash, the service worker must control the page, and then the page goes to /', async () => {
    const { env, nav, store } = fakeEnv();
    const log = [];
    const host = createUiHost({ env, kind: 'web', channelOf: () => ({ request() {} }), loaderFactory: loaderFactory(log), swWaitMs: 20 });
    const out = await host.show({ hello: { uiManifestHash: 'h1' }, loadedHash: null });
    assert.deepEqual(out, { ok: true, status: 'updated', navigated: true, reload: false });
    assert.deepEqual(log, [['check', 'web', 'h1', null]]);
    assert.deepEqual(nav, [['replace', '/']]);
    assert.equal(store.get('plenum-shell-page'), '/?shell', 'the way back is remembered');
    assert.equal(host.staysOnShell(), true, 'the page was opened with ?shell');
  });

  it('web: no service worker control means the screens cannot be kept, and no navigation; a refused pull names its cause', async () => {
    const lonely = fakeEnv({ navigator: { serviceWorker: { controller: null, ready: new Promise(() => {}), addEventListener() {} } } });
    const host = createUiHost({ env: lonely.env, kind: 'web', channelOf: () => ({ request() {} }), loaderFactory: loaderFactory([]), swWaitMs: 20 });
    assert.deepEqual(await host.show({ hello: {} }), { ok: false, cause: 'worker', code: 'worker' });
    assert.deepEqual(lonely.nav, []);
    const none = fakeEnv({ navigator: {} });
    assert.equal((await createUiHost({ env: none.env, kind: 'web', channelOf: () => ({ request() {} }), loaderFactory: loaderFactory([]), swWaitMs: 20 }).show({ hello: {} })).cause, 'worker');
    const refused = fakeEnv();
    const bad = createUiHost({ env: refused.env, kind: 'web', channelOf: () => ({ request() {} }), loaderFactory: () => ({ check: async () => { throw Object.assign(new Error('x'), { code: 'verify' }); } }), swWaitMs: 20 });
    assert.deepEqual(await bad.show({ hello: {} }), { ok: false, cause: 'checksum', code: 'verify' });
    const away = createUiHost({ env: refused.env, kind: 'web', channelOf: () => null, swWaitMs: 20 });
    assert.equal((await away.show({ hello: {} })).cause, 'stopped');
    assert.deepEqual(refused.nav, []);
  });

  it('LAN page: no loader, no cache; the page remembers where it was and goes to / (the computer serves the UI to a page holding the cookie)', async () => {
    const { env, nav, store } = fakeEnv({ location: { href: `http://192.168.1.5:40123/p/${'e'.repeat(32)}/`, pathname: `/p/${'e'.repeat(32)}/`, search: '', replace: url => nav.push(['replace', url]), assign: url => nav.push(['assign', url]) } });
    const host = createUiHost({ env, kind: 'lan', channelOf: () => null, loaderFactory: () => { throw new Error('no loader on the LAN page'); } });
    assert.equal((await host.show({ hello: {} })).ok, true);
    assert.deepEqual(nav, [['replace', '/']]);
    assert.equal(store.get('plenum-shell-page'), `/p/${'e'.repeat(32)}/?shell`);
    await host.openShell('#settings');
    assert.deepEqual(nav.at(-1), ['assign', `/p/${'e'.repeat(32)}/?shell#settings`], 'the way back to the shell page, with the screen it should open');
  });

  it('iPhone: the base path moves to the bundled ui/ folder under the one the app started with; nothing is pulled', async () => {
    const { env, store } = fakeEnv();
    const calls = [];
    const webView = { getServerBasePath: async () => ({ path: '/private/var/App.app/public' }), setServerBasePath: async arg => { calls.push(arg); } };
    const host = createUiHost({ env, kind: 'ios', native: { WebView: webView }, channelOf: () => null, loaderFactory: () => { throw new Error('iOS pulls nothing'); } });
    assert.deepEqual(await host.show({ hello: {} }), { ok: true, status: 'bundled', navigated: true });
    assert.deepEqual(calls, [{ path: '/private/var/App.app/public/ui' }]);
    assert.equal(store.get('plenum-shell-base'), '/private/var/App.app/public');
    await host.openShell();
    assert.deepEqual(calls.at(-1), { path: '/private/var/App.app/public' }, 'back to the shell\'s own screens');
    assert.equal(await host.hasCopy(), true);
  });

  it('Android: the loader gets the app-data folder and the WebView in their real shapes; persist is noted and the base path is set then persisted in one go', async () => {
    const written = [];
    const filesystem = {
      getUri: async () => ({ uri: 'file:///data/user/0/com.realalcibiades.plenum/files' }),
      writeFile: async arg => { written.push(arg); return {}; },
      readFile: async arg => { const hit = written.find(w => w.path === arg.path); if (!hit) throw new Error('none'); return { data: hit.data }; },
      rmdir: async arg => { written.push({ rmdir: arg.path }); },
      readdir: async () => ({ files: [{ name: 'plenum-ui-old', type: 'directory' }, { name: 'active.json', type: 'file' }] }),
    };
    const sequence = [];
    const webView = {
      setServerBasePath: async arg => { sequence.push(['set', arg.path]); },
      persistServerBasePath: async () => { sequence.push(['persist']); },
      getServerBasePath: async () => ({ path: '/data/user/0/com.realalcibiades.plenum/files/plenum-ui/plenum-ui-x' }),
    };
    const adapter = webViewOver({ webView, filesystem });
    await adapter.persistServerBasePath({ path: 'plenum-ui/plenum-ui-x' });
    assert.deepEqual(sequence, [], 'persist alone calls nothing: the plugin persists the path it serves now');
    await adapter.setServerBasePath({ path: 'plenum-ui/plenum-ui-x' });
    assert.deepEqual(sequence, [['set', '/data/user/0/com.realalcibiades.plenum/files/plenum-ui/plenum-ui-x'], ['persist']]);
    assert.deepEqual(await adapter.getServerBasePath(), { path: 'plenum-ui/plenum-ui-x' }, 'back to the relative name androidStorage compares');
    const files = filesOver(filesystem);
    await files.write('plenum-ui/a/index.html', new Uint8Array([104, 105]));
    assert.equal(written[0].directory, 'DATA');
    assert.deepEqual(Array.from(await files.read('plenum-ui/a/index.html')), [104, 105]);
    assert.equal(await files.read('plenum-ui/a/missing'), null);
    assert.deepEqual(await files.listDirs('plenum-ui'), ['plenum-ui-old']);
    const { env } = fakeEnv();
    const log = [];
    const host = createUiHost({ env, kind: 'android', native: { WebView: webView, Filesystem: filesystem }, channelOf: () => ({ request() {} }), loaderFactory: loaderFactory(log, { status: 'updated', reload: true }) });
    const out = await host.show({ hello: { uiManifestHash: 'h2' } });
    assert.equal(out.ok, true);
    assert.deepEqual(log, [['check', 'android', 'h2', null]]);
    const assetPath = [];
    const shellNative = { WebView: { ...webView, setServerAssetPath: async arg => { assetPath.push(arg); } }, Filesystem: filesystem };
    assert.equal(await createUiHost({ env, kind: 'android', native: shellNative, channelOf: () => null }).openShell(), true);
    assert.deepEqual(assetPath, [{ path: 'public' }], 'back to the bundled screens');
  });

  it('H3 web: the way back is the page the shell\'s screens were on (/p/<key>/ on the Tailscale page) with #settings or #computers; with nothing remembered it is /?shell', async () => {
    const key = 'c'.repeat(32);
    const local = new Map();
    const { env, nav, store } = fakeEnv({
      location: { href: `https://pc.tail1234.ts.net/p/${key}/`, pathname: `/p/${key}/`, search: '', replace: url => nav.push(['replace', url]), assign: url => nav.push(['assign', url]) },
      localStorage: { setItem: (k, v) => local.set(k, v), getItem: k => local.get(k) ?? null },
    });
    const host = createUiHost({ env, kind: 'web', channelOf: () => ({ request() {} }), loaderFactory: loaderFactory([]), swWaitMs: 20 });
    assert.equal((await host.show({ hello: {} })).ok, true);
    assert.deepEqual(nav, [['replace', '/']]);
    assert.equal(store.get(SHELL_PAGE_KEY), `/p/${key}/?shell`, 'the session remembers the page');
    assert.equal(local.get(SHELL_PAGE_KEY), `/p/${key}/?shell`, 'and so does localStorage, which outlives the session');
    await host.openShell('#settings');
    assert.deepEqual(nav.at(-1), ['assign', `/p/${key}/?shell#settings`]);
    await host.openShell('#computers');
    assert.deepEqual(nav.at(-1), ['assign', `/p/${key}/?shell#computers`]);
    await host.openShell();
    assert.deepEqual(nav.at(-1), ['assign', `/p/${key}/?shell`], 'no link, no tail');
    // A link that is not a fragment is not put in the address.
    await host.openShell('plenum://pair#abc');
    assert.deepEqual(nav.at(-1), ['assign', `/p/${key}/?shell`]);
    // Nothing remembered: the root page, which the service worker leaves to the shell's own screens.
    const fresh = fakeEnv();
    const lonely = createUiHost({ env: fresh.env, kind: 'web', channelOf: () => null });
    await lonely.openShell('#settings');
    assert.deepEqual(fresh.nav, [['assign', '/?shell#settings']]);
    const lan = fakeEnv({ location: { href: 'http://192.168.1.5:40123/', pathname: '/', search: '', assign: url => lan.nav.push(['assign', url]) } });
    await createUiHost({ env: lan.env, kind: 'lan', channelOf: () => null }).openShell('#computers');
    assert.deepEqual(lan.nav, [['assign', '/?shell#computers']], 'the LAN page too');
  });

  it('H3 web: a new session (the installed app opened again) still finds the page in localStorage; a remembered value that is not a path of this origin naming the shell page is not used', async () => {
    const key = 'd'.repeat(32);
    const local = new Map([[SHELL_PAGE_KEY, `/p/${key}/?shell`]]);
    const { env, nav } = fakeEnv({ localStorage: { setItem: (k, v) => local.set(k, v), getItem: k => local.get(k) ?? null } });
    await createUiHost({ env, kind: 'web', channelOf: () => null }).openShell('#settings');
    assert.deepEqual(nav, [['assign', `/p/${key}/?shell#settings`]], 'the session was empty, localStorage had it');
    for (const bad of ['//evil.example/?shell', '/\\evil.example/?shell', 'https://evil.example/?shell', '/p/x/', '/p/x/?shellfoo', '/p/x/?shell#frag', 'javascript:alert(1)?shell', 12]) {
      const hostile = fakeEnv({ localStorage: { setItem() {}, getItem: () => bad } });
      hostile.store.set(SHELL_PAGE_KEY, bad);
      await createUiHost({ env: hostile.env, kind: 'web', channelOf: () => null }).openShell();
      assert.deepEqual(hostile.nav, [['assign', '/?shell']], `${String(bad)} is not used`);
    }
    // A browser that refuses storage still gets the way back.
    const denied = () => { throw new Error('denied'); };
    const refusing = fakeEnv({ localStorage: { setItem: denied, getItem: denied }, sessionStorage: { setItem: denied, getItem: denied } });
    const host = createUiHost({ env: refusing.env, kind: 'web', channelOf: () => ({ request() {} }), loaderFactory: loaderFactory([]), swWaitMs: 20 });
    assert.equal((await host.show({ hello: {} })).ok, true, 'remembering is best effort');
    await host.openShell('#settings');
    assert.deepEqual(refusing.nav.at(-1), ['assign', '/?shell#settings']);
  });

  it('one UI per computer: show and refresh pass the computer to the loader\'s check', async () => {
    const seen = [];
    const factory = () => ({ check: async args => { seen.push(args); return { status: 'updated', reload: false }; } });
    const { env } = fakeEnv();
    const host = createUiHost({ env, kind: 'web', channelOf: () => ({}), loaderFactory: factory });
    await host.show({ hello: { uiManifestHash: 'h1' }, computerId: 'c1', loadedHash: null });
    await host.refresh({ hello: { uiManifestHash: 'h1' }, loadedHash: 'x', computerId: 'c2' });
    assert.deepEqual(seen.map(a => a.computerId), ['c1', 'c2']);
    await host.show({ hello: { uiManifestHash: 'h1' }, loadedHash: null });
    assert.equal(seen.at(-1).computerId, null, 'no computer given: null, the loader\'s default');
  });

  it('one UI per computer: uiComputerId() is the active record\'s computer on the web and on Android, null when it is unknown, and any on the LAN page and the iPhone', async () => {
    const cachesOf = record => ({ open: async () => ({ match: async () => (record === undefined ? undefined : new Response(JSON.stringify(record))) }) });
    const web = (record, extra = {}) => createUiHost({ env: fakeEnv({ caches: cachesOf(record), ...extra }).env, kind: 'web', channelOf: () => null });
    assert.equal(await web({ complete: true, hash: 'h', computerId: 'c9' }).uiComputerId(), 'c9');
    assert.equal(await web({ complete: true, hash: 'h' }).uiComputerId(), null, 'a record from before the id was kept');
    assert.equal(await web(undefined).uiComputerId(), null, 'nothing cached yet');
    assert.equal(await web({ computerId: 'c1' }, { caches: { open: async () => { throw new Error('no cache'); } } }).uiComputerId(), null, 'a cache that cannot be read');
    assert.equal(await web({}, { caches: undefined }).uiComputerId(), null, 'a browser with no Cache API');
    const droid = (record, native) => createUiHost({ env: fakeEnv().env, kind: 'android', native, channelOf: () => null });
    const filesystem = record => ({
      readFile: async () => { if (record === undefined) throw new Error('no file'); return { data: Buffer.from(JSON.stringify(record)).toString('base64') }; },
      writeFile: async () => ({}),
    });
    assert.equal(await droid(null, { Filesystem: filesystem({ hash: 'h', computerId: 'c7' }), WebView: {} }).uiComputerId(), 'c7');
    assert.equal(await droid(null, { Filesystem: filesystem({ hash: 'h' }), WebView: {} }).uiComputerId(), null);
    assert.equal(await droid(null, { Filesystem: filesystem(undefined), WebView: {} }).uiComputerId(), null);
    assert.equal(await droid(null, null).uiComputerId(), null, 'no plugins');
    assert.equal(await createUiHost({ env: fakeEnv().env, kind: 'lan', channelOf: () => null }).uiComputerId(), 'any');
    assert.equal(await createUiHost({ env: fakeEnv().env, kind: 'ios', native: { WebView: {} }, channelOf: () => null }).uiComputerId(), 'any');
  });

  it('M6 Android and iPhone: a link for the shell page waits in the linkStore before the page switches, never in sessionStorage, and only a link does; a switch that fails or cannot be made takes it back', async () => {
    const pair = 'plenum://pair#eyJ2IjoxfQ';
    const kept = () => {
      const items = [];
      return { items, async put(text) { items.push(text); }, async take() { return items.pop() ?? null; } };
    };
    // Android: the link is in the linkStore when the WebView is pointed at the shell's assets.
    const droid = fakeEnv();
    const linkStore = kept();
    const seen = [];
    const assetWebView = { setServerAssetPath: async arg => { seen.push([arg.path, [...linkStore.items]]); } };
    const android = createUiHost({ env: droid.env, kind: 'android', native: { WebView: assetWebView }, channelOf: () => null, linkStore });
    assert.equal(await android.openShell(pair), true);
    assert.deepEqual(seen, [['public', [pair]]], 'the whole link, kept before the switch');
    await linkStore.take();
    assert.equal(await android.openShell(), true);
    assert.equal(await android.openShell(''), true);
    assert.deepEqual(linkStore.items, [], 'no link, nothing kept');
    assert.equal(await android.openShell('#settings'), true);
    assert.deepEqual(linkStore.items, ['#settings']);
    assert.equal(droid.store.has(SHELL_LINK_KEY), false, 'nothing is written to sessionStorage');
    assert.equal(droid.nav.length, 0, 'the app has no address to carry it');
    // The switch throws: the link does not stay behind, and the caller still hears the error.
    const broken = fakeEnv();
    const brokenLinks = kept();
    const failing = createUiHost({ env: broken.env, kind: 'android', native: { WebView: { setServerAssetPath: async () => { throw new Error('webview'); } } }, channelOf: () => null, linkStore: brokenLinks });
    await assert.rejects(failing.openShell(pair), /webview/);
    assert.deepEqual(brokenLinks.items, []);
    // No way to switch: nothing is kept either.
    const stuck = fakeEnv();
    const stuckLinks = kept();
    assert.equal(await createUiHost({ env: stuck.env, kind: 'android', native: { WebView: {} }, channelOf: () => null, linkStore: stuckLinks }).openShell(pair), false);
    assert.equal(await createUiHost({ env: stuck.env, kind: 'android', native: null, channelOf: () => null, linkStore: stuckLinks }).openShell(pair), false);
    assert.deepEqual(stuckLinks.items, []);
    // iPhone: the base path the shell started from.
    const phone = fakeEnv();
    phone.store.set('plenum-shell-base', '/private/var/App.app/public');
    const iosLinks = kept();
    const moves = [];
    const iosWebView = { setServerBasePath: async arg => { moves.push([arg.path, [...iosLinks.items]]); } };
    const ios = createUiHost({ env: phone.env, kind: 'ios', native: { WebView: iosWebView }, channelOf: () => null, linkStore: iosLinks });
    assert.equal(await ios.openShell(pair), true);
    assert.deepEqual(moves, [['/private/var/App.app/public', [pair]]]);
    const homeless = fakeEnv();
    const homelessLinks = kept();
    assert.equal(await createUiHost({ env: homeless.env, kind: 'ios', native: { WebView: iosWebView }, channelOf: () => null, linkStore: homelessLinks }).openShell(pair), false, 'no base path remembered');
    assert.deepEqual(homelessLinks.items, []);
    assert.equal(homeless.store.has(SHELL_LINK_KEY), false);
    // The web and LAN pages carry the fragment in the address and keep nothing.
    const web = fakeEnv();
    const webLinks = kept();
    await createUiHost({ env: web.env, kind: 'web', channelOf: () => null, linkStore: webLinks }).openShell('#pair=eyJ2IjoxfQ');
    assert.deepEqual(web.nav, [['assign', '/?shell#pair=eyJ2IjoxfQ']]);
    assert.equal(web.store.has(SHELL_LINK_KEY), false);
    assert.deepEqual(webLinks.items, []);
  });
});

// ----- the phone keeps its keys in the Keychain or Keystore, or nowhere (H6) -----

// A page for startShell: no document (so the shell page), a fake IndexedDB that records that it was opened, and a session.
function pageEnv(extra = {}) {
  const idb = createFakeIndexedDB();
  const session = new Map();
  const nav = [];
  const env = {
    location: { href: 'https://localhost/index.html', pathname: '/index.html', search: '', hash: '', hostname: 'localhost', protocol: 'https:', assign: url => nav.push(['assign', url]), replace: url => nav.push(['replace', url]) },
    isSecureContext: true,
    indexedDB: idb,
    sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) },
    addEventListener() {},
    navigator: {},
    setTimeout,
    clearTimeout,
    ...extra,
  };
  return { env, idb, session, nav };
}

// The shape store.js reads over the plugin: getItem({ key }) -> { value }, setItem({ key, value }), removeItem({ key }), keys() -> { keys }.
function fakeSecureStorage() {
  const items = new Map();
  return {
    items,
    async getItem({ key }) { return { value: items.has(key) ? items.get(key) : null }; },
    async setItem({ key, value }) { items.set(key, value); },
    async removeItem({ key }) { items.delete(key); },
    async keys() { return { keys: [...items.keys()] }; },
  };
}

const NATIVE = { isNativePlatform: () => true, getPlatform: () => 'android' };

describe('the phone keeps its keys in the Keychain or Keystore, or nowhere (H6)', () => {
  it('a phone is a native platform with the native bridge: androidBridge on Android, webkit.messageHandlers.bridge on iPhone; registerPlugin and the platform alone are not', async () => {
    assert.equal(hasNativeBridge({ androidBridge: {} }), true);
    assert.equal(hasNativeBridge({ webkit: { messageHandlers: { bridge: {} } } }), true);
    for (const env of [{}, null, undefined, { webkit: {} }, { webkit: { messageHandlers: {} } }, { androidBridge: null }]) assert.equal(hasNativeBridge(env), false, JSON.stringify(env));
    assert.equal(wantsNativePlugins({}), false, 'the web');
    assert.equal(wantsNativePlugins({ Capacitor: { isNativePlatform: () => false }, androidBridge: {} }), false, 'a page that is not a native platform');
    assert.equal(wantsNativePlugins({ Capacitor: NATIVE }), false, 'the harness stub: a native platform with no bridge keeps Capacitor.Plugins');
    assert.equal(wantsNativePlugins({ Capacitor: { ...NATIVE, registerPlugin() {} } }), false, 'registerPlugin is not the sign of a phone: the bridge script has none');
    assert.equal(wantsNativePlugins({ Capacitor: NATIVE, androidBridge: {} }), true);
    assert.equal(wantsNativePlugins({ Capacitor: { ...NATIVE, getPlatform: () => 'ios' }, webkit: { messageHandlers: { bridge: {} } } }), true);
    // Without a phone nothing is imported and the plugins are null (loadNativePlugins is not exported: the bundle's namespace is importable by any
    // script of the page, and it returns the secure-storage plugin; startShell is the one way in).
    assert.equal('loadNativePlugins' in app, false, 'not on the module namespace');
    for (const extra of [{}, { Capacitor: NATIVE }, { Capacitor: { ...NATIVE, registerPlugin() {} } }]) {
      const { env } = pageEnv(extra);
      await startShell(env, { attach: null });
      assert.equal(env.plenumNative, null, JSON.stringify(Object.keys(extra)));
    }
  });

  it('a phone whose plugins did not load stores nothing: the shell starts locked with its storage unavailable, and IndexedDB is never opened (Android and iPhone, no plugins and a failing load)', async () => {
    const attempts = [
      ['Android, no plugins', { Capacitor: NATIVE, androidBridge: {} }, async () => null],
      ['Android, the load throws', { Capacitor: NATIVE, androidBridge: {} }, async () => { throw new Error('plugin'); }],
      ['iPhone, no plugins', { Capacitor: { ...NATIVE, getPlatform: () => 'ios' }, webkit: { messageHandlers: { bridge: {} } } }, async () => null],
      ['Android, plugins with no secure storage', { Capacitor: NATIVE, androidBridge: {} }, async () => ({ App: null })],
    ];
    for (const [what, extra, loadPlugins] of attempts) {
      const { env, idb } = pageEnv(extra);
      const shell = await startShell(env, { loadPlugins });
      assert.equal(shell.state().storage, 'unavailable', what);
      assert.equal(shell.state().lock.mode, 'unknown', `${what}: the lock settings could not be read`);
      assert.equal(shell.state().locked, true, what);
      assert.equal(shell.state().route, 'locked', what);
      assert.equal(shell.state().pairing, null, what);
      assert.ok(shell.debug.lines().some(l => l.text === 'storage: unavailable' && l.level === 'warn'), `${what}: the console says so once`);
      assert.equal(idb.databases.size, 0, `${what}: IndexedDB was not opened`);
    }
  });

  it('a phone whose plugins loaded keeps everything in the secure storage plugin, and IndexedDB stays unopened', async () => {
    const secureStorage = fakeSecureStorage();
    const { env, idb } = pageEnv({ Capacitor: NATIVE, androidBridge: {} });
    const plugins = { secureStorage, App: null, BiometricAuth: null };
    const shell = await startShell(env, { loadPlugins: async () => plugins });
    assert.equal(env.plenumNative, plugins, 'boot.js reads the plugins from window.plenumNative');
    await shell.setPrefs({ theme: 'dark' });
    assert.ok(secureStorage.items.has('plenum.meta:prefs'), 'the phone\'s settings went to the Keychain or Keystore plugin');
    assert.equal(idb.databases.size, 0);
    const iphone = pageEnv({ Capacitor: { ...NATIVE, getPlatform: () => 'ios' }, webkit: { messageHandlers: { bridge: {} } } });
    const second = fakeSecureStorage();
    const shell2 = await startShell(iphone.env, { loadPlugins: async () => ({ secureStorage: second }) });
    await shell2.setPrefs({ theme: 'light' });
    assert.ok(second.items.has('plenum.meta:prefs'));
    assert.equal(iphone.idb.databases.size, 0);
  });

  it('the harness stub (a native platform with no bridge) keeps Capacitor.Plugins.SecureStorage; the web keeps IndexedDB', async () => {
    const stub = fakeSecureStorage();
    const harness = pageEnv({ Capacitor: { ...NATIVE, Plugins: { SecureStorage: stub } } });
    const shell = await startShell(harness.env);
    assert.equal(harness.env.plenumNative, null, 'native.js is not loaded without the bridge');
    await shell.setPrefs({ theme: 'dark' });
    assert.ok(stub.items.has('plenum.meta:prefs'));
    assert.equal(harness.idb.databases.size, 0);
    const web = pageEnv();
    const webShell = await startShell(web.env);
    await webShell.setPrefs({ theme: 'dark' });
    assert.ok(web.idb.databases.has('plenum-shell'), 'the PWA keeps its store in IndexedDB');
  });
});

// ----- the shell page is asked for its own screens (H3), and links wait behind the lock (M6) -----

describe('the shell page is asked for its own screens (H3)', () => {
  it('#settings and #computers set screenRequest with a seq that rises by one; the UI page ignores them and so do near misses', async () => {
    const k = await connectedShell();
    assert.equal(k.shell.state().screenRequest, null);
    assert.deepEqual(await k.shell.handleHash('#settings'), { ok: true, reason: null, kind: 'screen' });
    assert.deepEqual(k.shell.state().screenRequest, { screen: 'settings', seq: 1 });
    await k.shell.handleHash('#computers');
    assert.deepEqual(k.shell.state().screenRequest, { screen: 'computers', seq: 2 });
    await k.shell.handleHash('#settings');
    assert.deepEqual(k.shell.state().screenRequest, { screen: 'settings', seq: 3 }, 'the same screen again is a new request');
    for (const near of ['#settings=other', '#computer', '#settingsx', 'settings', '#Settings', '#settings ', '#computers=1']) {
      const out = await k.shell.handleHash(near);
      assert.equal(out.reason, 'no link', near);
    }
    assert.deepEqual(k.shell.state().screenRequest, { screen: 'settings', seq: 3 }, 'nothing else moved it');
    assert.equal((await k.shell.handleHash('#settings=limit')).kind, 'settings', 'the notification route is still a route for the UI');
    assert.equal(k.shell.state().intent.section, 'limit');
    const ui = await connectedShell({ shell: { pageKind: 'ui' } });
    assert.equal((await ui.shell.handleHash('#settings')).reason, 'no link');
    assert.equal((await ui.shell.handleHash('#computers')).reason, 'no link');
    assert.equal(ui.shell.state().screenRequest, null, 'the UI page has no such screens');
  });

  it('a request that arrives while the app is locked waits for the unlock and is the first request then', async () => {
    const k = await connectedShell({ withLock: true });
    assert.equal((await k.shell.setPin('123456')).ok, true);
    await k.shell.lockNow();
    assert.deepEqual(await k.shell.handleHash('#settings'), { ok: false, reason: 'locked' });
    assert.equal(k.shell.state().screenRequest, null, 'nothing is asked of the screens behind the lock');
    assert.equal((await k.shell.unlock('pin', '123456')).ok, true);
    assert.deepEqual(k.shell.state().screenRequest, { screen: 'settings', seq: 1 });
  });

  it('the shell page opened with #settings (the way back from the UI page) asks for the settings screen once the shell has started', async () => {
    const k = await connectedShell({ shell: { pageUrl: 'https://phone.example/p/abc/?shell#settings' } });
    assert.deepEqual(k.shell.state().screenRequest, { screen: 'settings', seq: 1 });
  });
});

// A fake computer that is waiting to be paired, and the link that opens its offer.
function pairingRig() {
  const net = createFakeNet();
  const clock = createFakeClock(0);
  const desktop = createFakeDesktop({ net });
  const psk = new Uint8Array(32).fill(9);
  const offer = '9b'.repeat(16);
  desktop.openOffer(psk, offer);
  const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
  const link = `plenum://pair#${Buffer.from(JSON.stringify({ v: 1, name: 'Test PC', pub: bytesToB64u(desktop.keys.publicKey), psk: bytesToB64u(psk), offer, ttl: 120, carriers: [{ kind: 'lan', urls: [desktop.url] }], sas: '6' })).toString('base64url')}`;
  const shell = (extra = {}) => createShell({
    store,
    createWorker: fakeWorkerFactory({ net, clock, store }),
    device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
    caps: ['ui-from-desktop'],
    stopClock: clock,
    ...extra,
  });
  const codeUp = async state => {
    for (let i = 0; i < 40 && !state().pairing?.code; i++) await settle();
    return state().pairing?.code ?? null;
  };
  return { net, clock, desktop, offer, store, link, shell, codeUp };
}

// The App plugin of the native app, as far as the shell uses it.
function fakeAppPlugin({ launch = null, minimize = true } = {}) {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    listeners,
    addListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return { remove() {} };
    },
    emit(event, data) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
    async getLaunchUrl() {
      calls.push('getLaunchUrl');
      return launch ? { url: launch } : undefined;
    },
    ...(minimize ? { minimizeApp() { calls.push('minimizeApp'); } } : {}),
    exitApp() { calls.push('exitApp'); },
  };
}

describe('links that open the native app, and the way to the shell page (M6)', () => {
  const linkShell = () => {
    const handled = [];
    return { handled, handleHash: async link => { handled.push(link); return { ok: true }; } };
  };

  it('a deep link of the app runs through handleHash: #stop as the fragment, a pairing link whole, anything else not at all', async () => {
    const app = fakeAppPlugin();
    const shell = linkShell();
    wireAppPlugin({ appPlugin: app, shell, env: {}, pageKind: 'shell' });
    app.emit('appUrlOpen', { url: 'plenum://app/#stop' });
    app.emit('appUrlOpen', { url: 'plenum://pair#abc' });
    app.emit('appUrlOpen', { url: 'plenum://app/#approve=ap1&line=Run%3A%20x' });
    for (const other of ['https://evil.example/#stop', 'plenum://other/#stop', 'plenum://app/', '', undefined]) app.emit('appUrlOpen', { url: other });
    app.emit('appUrlOpen', undefined);
    assert.deepEqual(shell.handled, ['#stop', 'plenum://pair#abc', '#approve=ap1&line=Run%3A%20x']);
  });

  it('the Back button on the shell page asks the screens first (a cancelable plenum-back) and minimises the app only when nothing took it; the UI page has no Back listener here', async () => {
    const target = new EventTarget();
    const env = { CustomEvent, dispatchEvent: event => target.dispatchEvent(event) };
    const seen = [];
    let take = true;
    target.addEventListener('plenum-back', event => {
      seen.push(event.cancelable);
      if (take) event.preventDefault();
    });
    const app = fakeAppPlugin();
    wireAppPlugin({ appPlugin: app, shell: linkShell(), env, pageKind: 'shell' });
    app.emit('backButton', {});
    assert.deepEqual(seen, [true], 'a cancelable event');
    assert.deepEqual(app.calls, [], 'a screen took it: the app stays');
    take = false;
    app.emit('backButton', {});
    assert.deepEqual(app.calls, ['minimizeApp']);
    const plain = fakeAppPlugin({ minimize: false });
    wireAppPlugin({ appPlugin: plain, shell: linkShell(), env, pageKind: 'shell' });
    plain.emit('backButton', {});
    assert.deepEqual(plain.calls, ['exitApp'], 'an app without minimizeApp exits');
    const bare = fakeAppPlugin();
    wireAppPlugin({ appPlugin: bare, shell: linkShell(), env: {}, pageKind: 'shell' });
    bare.emit('backButton', {});
    assert.deepEqual(bare.calls, ['minimizeApp'], 'no event type to dispatch: the app minimises');
    const ui = fakeAppPlugin();
    wireAppPlugin({ appPlugin: ui, shell: linkShell(), env, pageKind: 'ui' });
    assert.equal(ui.listeners.has('backButton'), false, 'the UI page\'s Back is boot.js');
    assert.equal(ui.listeners.has('appUrlOpen'), true, 'but its links still reach the shell');
  });

  it('the link the app was launched with runs once, after the start, and not twice when the system also delivers it as an open', async () => {
    const app = fakeAppPlugin({ launch: 'plenum://app/#stop' });
    const shell = linkShell();
    const afterStart = wireAppPlugin({ appPlugin: app, shell, env: {}, pageKind: 'shell' });
    assert.deepEqual(shell.handled, [], 'nothing before the shell has started');
    await afterStart();
    await afterStart();
    assert.deepEqual(shell.handled, ['#stop']);
    assert.deepEqual(app.calls, ['getLaunchUrl']);
    const twice = fakeAppPlugin({ launch: 'plenum://pair#abc' });
    const second = linkShell();
    const after = wireAppPlugin({ appPlugin: twice, shell: second, env: {}, pageKind: 'shell' });
    twice.emit('appUrlOpen', { url: 'plenum://pair#abc' });
    await after();
    assert.deepEqual(second.handled, ['plenum://pair#abc'], 'delivered as an open and as the launch link: once');
    // No App plugin, no launch method, a launch call that fails or answers nothing: nothing happens and nothing throws.
    await wireAppPlugin({ appPlugin: null, shell, env: {}, pageKind: 'shell' })();
    await wireAppPlugin({ appPlugin: { addListener() {} }, shell, env: {}, pageKind: 'shell' })();
    await wireAppPlugin({ appPlugin: { addListener() {}, getLaunchUrl: async () => { throw new Error('none'); } }, shell, env: {}, pageKind: 'shell' })();
    await wireAppPlugin({ appPlugin: fakeAppPlugin(), shell, env: {}, pageKind: 'shell' })();
    assert.deepEqual(shell.handled, ['#stop']);
  });

  it('a link from the app waits behind the app lock like any other: an approve is not sent, and a pairing does not start, until the unlock', async () => {
    const k = await connectedShell({ withLock: true });
    assert.equal((await k.shell.setPin('123456')).ok, true);
    await k.shell.lockNow();
    const app = fakeAppPlugin({ launch: 'plenum://app/#approve=ap1&line=Run%3A%20x' });
    const afterStart = wireAppPlugin({ appPlugin: app, shell: k.shell, env: {}, pageKind: 'shell' });
    await afterStart();
    await settle();
    assert.equal(k.desktop.stats.approvals.length, 0, 'nothing was sent behind the lock');
    assert.equal((await k.shell.unlock('pin', '123456')).ok, true);
    await waitFor(() => k.desktop.stats.approvals.length === 1, 8000);
    assert.equal(k.desktop.stats.approvals[0].line, 'Run: x');
    // A pairing link opened while the app is locked.
    const rig = pairingRig();
    const lock = createLock({ store: rig.store, now: () => 1_000_000, iterations: 2000 });
    { const set = await lock.setPin('123456'); assert.equal(set.ok, true); assert.ok(set.keys instanceof Map); }
    const shell = rig.shell({ lock });
    await shell.boot();
    assert.equal(shell.state().route, 'locked');
    const pairApp = fakeAppPlugin();
    wireAppPlugin({ appPlugin: pairApp, shell, env: {}, pageKind: 'shell' });
    pairApp.emit('appUrlOpen', { url: rig.link });
    await settle(60);
    assert.equal(shell.state().pairing, null, 'the pairing has not started');
    assert.equal(shell.state().route, 'locked');
    assert.equal((await shell.unlock('pin', '123456')).ok, true);
    assert.equal(shell.state().pairing?.state, 'review', 'the unlock shows the review, it does not pair');
    assert.equal(rig.desktop.stats.handshakes, 0, 'no socket opened before the person taps Pair');
    const confirming = shell.confirmPair();
    assert.match(await rig.codeUp(shell.state), /^[0-9]{6}$/, 'Pair starts it');
    rig.desktop.allow(rig.offer);
    assert.equal((await confirming).state, 'allowed');
    assert.equal(shell.state().computers.length, 1);
  });

  it('a shell built with the link the UI page left (initialLink) pairs from it at start; the address wins when it has one; behind the lock it waits', async () => {
    const rig = pairingRig();
    const shell = rig.shell({ initialLink: rig.link });
    await shell.start();
    assert.equal(shell.state().pairing?.state, 'review', 'the kept link goes to the review');
    const confirming = shell.confirmPair();
    assert.match(await rig.codeUp(shell.state), /^[0-9]{6}$/);
    rig.desktop.allow(rig.offer);
    await confirming;
    assert.equal(shell.state().computers.length, 1, 'paired from the link once the person tapped Pair');
    // An address with a link of its own is the one that runs.
    const both = await connectedShell({ shell: { pageUrl: 'https://phone.example/p/x/#stop', initialLink: '#settings' } });
    await waitFor(() => both.desktop.stats.stops === 1, 8000);
    assert.equal(both.shell.state().screenRequest, null, 'the address link ran (the Stop), the kept one did not');
    // Behind the lock the kept link waits.
    const locked = pairingRig();
    const lock = createLock({ store: locked.store, now: () => 1_000_000, iterations: 2000 });
    { const set = await lock.setPin('123456'); assert.equal(set.ok, true); assert.ok(set.keys instanceof Map); }
    const lockedShell = locked.shell({ lock, initialLink: locked.link });
    await lockedShell.start();
    assert.equal(lockedShell.state().route, 'locked');
    assert.equal(lockedShell.state().pairing, null, 'no pairing behind the lock');
    await lockedShell.unlock('pin', '123456');
    assert.equal(lockedShell.state().pairing?.state, 'review');
    const lockedConfirm = lockedShell.confirmPair();
    assert.match(await locked.codeUp(lockedShell.state), /^[0-9]{6}$/);
    locked.desktop.allow(locked.offer);
    await lockedConfirm;
    assert.equal(lockedShell.state().computers.length, 1);
  });

  it('an Android UI page that gets a pairing link keeps the whole link in the linkStore, not in sessionStorage, before the WebView switches', async () => {
    const session = new Map();
    const switched = [];
    const env = {
      location: { href: 'https://localhost/ui/index.html', pathname: '/ui/index.html', search: '' },
      sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) },
      setTimeout,
      clearTimeout,
    };
    const kept = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    const linkStore = createLinkStore(kept.meta);
    const webView = { setServerAssetPath: async arg => { switched.push([arg.path, await kept.meta.get('shell-link')]); } };
    const uiHost = createUiHost({ env, kind: 'android', native: { WebView: webView }, channelOf: () => null, linkStore });
    uiHost.uiComputerId = async () => 'any';
    const k = await connectedShell({ shell: { uiHost, pageKind: 'ui' } });
    const link = 'plenum://pair#eyJ2IjoxfQ';
    assert.deepEqual(await k.shell.handleHash(link), { ok: true, reason: null, kind: 'pair' });
    assert.equal(switched.length, 1);
    assert.equal(switched[0][0], 'public');
    assert.equal(switched[0][1]?.text, link, 'the link was in the store when the page switched');
    assert.equal(session.size, 0, 'nothing in sessionStorage');
    assert.equal(await linkStore.take(), link, 'the shell page takes it out once');
    assert.equal(await linkStore.take(), null);
  });

  it('startShell: the shell page of an app takes the link the UI page left out of the linkStore, once, and clears what an older version left in sessionStorage; the UI page leaves it alone', async () => {
    const app = fakeAppPlugin({ launch: 'plenum://app/#computers' });
    const secureStorage = fakeSecureStorage();
    const { env, session } = pageEnv({ Capacitor: NATIVE, androidBridge: {} });
    session.set(SHELL_LINK_KEY, 'plenum://pair#old-version');
    secureStorage.items.set('plenum.meta:shell-link', JSON.stringify({ text: '#settings', at: Date.now() }));
    const shell = await startShell(env, { loadPlugins: async () => ({ secureStorage, App: app }) });
    assert.equal(session.has(SHELL_LINK_KEY), false, 'what an old version left in the session is cleared');
    assert.equal(secureStorage.items.has('plenum.meta:shell-link'), false, 'taken out of the store');
    await waitFor(() => shell.state().screenRequest?.seq === 2, 8000);
    assert.deepEqual(shell.state().screenRequest, { screen: 'computers', seq: 2 }, 'the kept link ran at the start (seq 1), then the launch link once (seq 2)');
    assert.deepEqual(app.calls, ['getLaunchUrl']);
    // A link older than two minutes is not used.
    const stale = pageEnv({ Capacitor: NATIVE, androidBridge: {} });
    const staleStorage = fakeSecureStorage();
    staleStorage.items.set('plenum.meta:shell-link', JSON.stringify({ text: '#settings', at: Date.now() - 121_000 }));
    const staleShell = await startShell(stale.env, { loadPlugins: async () => ({ secureStorage: staleStorage, App: fakeAppPlugin() }) });
    assert.equal(staleShell.state().screenRequest, null, 'an old kept link does not run');
    assert.equal(staleStorage.items.has('plenum.meta:shell-link'), false, 'and does not stay');
    // The UI page does not take it.
    const uiStorage = fakeSecureStorage();
    uiStorage.items.set('plenum.meta:shell-link', JSON.stringify({ text: '#settings', at: Date.now() }));
    const uiPage = pageEnv({
      Capacitor: NATIVE,
      androidBridge: {},
      document: { visibilityState: 'visible', documentElement: { hasAttribute: () => false, getAttribute: name => (name === 'data-surface' ? 'phone' : null) } },
    });
    const uiShell = await startShell(uiPage.env, { loadPlugins: async () => ({ secureStorage: uiStorage, App: fakeAppPlugin() }) });
    assert.equal(uiShell.state().page, 'ui');
    assert.equal(uiStorage.items.has('plenum.meta:shell-link'), true, 'the link is for the shell page');
  });
});

describe('self test over the fake computer', () => {
  it('the approval step ignores an answered event and denies only the new card', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const channel = openChannel({ computer: freshComputerRecord(desktop, phone), createWorker: fakeWorkerFactory({ net, clock }) });
    let ticks = 0;
    const raiser = setInterval(() => {
      if (!desktop.stats.requests.some(r => r.path === '/api/events')) return;
      ticks += 1;
      if (ticks === 1) desktop.raiseApproval('already answered', { action: 'answered' });
      if (ticks === 4) desktop.raiseApproval('Write a file');
    }, 50);
    try {
      const report = await runSelfTest({ channel, project: 'p1', approvalWaitMs: 4000, connectMs: 4000, now: () => Date.now() });
      assert.equal(report.steps.find(x => x.name === 'approval')?.ok, true, JSON.stringify(report.steps));
      assert.deepEqual(desktop.stats.approvals.map(a => [a.approvalId, a.allow]), [['ap2', false]], 'only the new card was answered, and it was denied');
    } finally {
      clearInterval(raiser);
      channel.close();
    }
  });


  it('runs connect, UI pull, echo, a denied approval and STOP, and reports every step', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const channel = openChannel({ computer: freshComputerRecord(desktop, phone), createWorker: fakeWorkerFactory({ net, clock }) });
    // The computer raises a card once the phone opens its events stream.
    const raiser = setInterval(() => { if (desktop.stats.requests.some(r => r.path === '/api/events')) desktop.raiseApproval('Write a file'); }, 50);
    try {
      const report = await runSelfTest({ channel, project: 'p1', approvalWaitMs: 4000, connectMs: 4000, now: () => Date.now() });
      assert.deepEqual(report.steps.map(s => s.name), [...STEP_NAMES]);
      assert.equal(report.steps.every(s => s.ok), true, JSON.stringify(report.steps));
      assert.equal(report.ok, true);
      assert.equal(desktop.stats.approvals.at(-1)?.allow, false, 'the self-test denies a card, it never approves one');
      assert.equal(report.steps.find(x => x.name === 'approval')?.detail, 'denied from the phone');
    } finally {
      clearInterval(raiser);
      channel.close();
    }
  });
});

// ----- phone security round: the facade, Stop without unlocking, the pairing review, the worker's request policy (G2) -----

const FACADE_KEYS = ['connect', 'lock', 'log', 'openShell', 'plugin', 'request', 'state', 'stop', 'subscribe', 'takeRoute', 'unlock'];
const NOT_ON_THE_FACADE = ['lockOff', 'setPin', 'forget', 'pair', 'confirmPair', 'cancelPairing', 'channel', 'debug', 'runSelftest', 'enableLock', 'handleHash', 'store', 'lockNow'];

// A phone record that already holds the computer's Stop key, and the fake computer that knows it.
function recordWithStopKey(desktop, phone, extra = {}) {
  const stop = new Uint8Array(32).map((_, i) => (i * 5 + 11) & 255);
  const myDeviceId = deviceId(phone.publicKey);
  desktop.stopKeys.set(myDeviceId, stop);
  desktop.counters.set(myDeviceId, 0);
  return { ...freshComputer(desktop, phone), stopKey: bytesToB64u(stop), myDeviceId, ...extra };
}

// A shell over a store that holds one computer, started locked with a PIN (or not locked at all). withKey: the record has its Stop key.
async function lockedStopRig({ desktop: desktopOptions = {}, withKey = true, pin = true, shell: shellOptions = {} } = {}) {
  const net = createFakeNet();
  const clock = createFakeClock(0);
  const wall = createFakeClock(1_000_000);
  const desktop = createFakeDesktop({ net, ...desktopOptions });
  const phone = generateKeyPair();
  desktop.counters.set(deviceId(phone.publicKey), 0);
  const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
  await store.put(withKey ? recordWithStopKey(desktop, phone) : freshComputer(desktop, phone));
  const lock = createLock({ store, now: () => wall.now(), iterations: 2000 });
  if (pin) await lock.setPin('123456');
  const shell = createShell({
    store,
    lock,
    createWorker: fakeWorkerFactory({ net, clock, store }),
    device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
    caps: ['ui-from-desktop'],
    stopClock: wall,
    ...shellOptions,
  });
  await shell.boot();
  return { net, clock, wall, desktop, phone, store, lock, shell, id: deviceId(desktop.keys.publicKey), phoneId: deviceId(phone.publicKey) };
}

// A link whose carriers are the given list (the fake computer's real address first by default).
function linkWith(rig, carriers, extra = {}) {
  const payload = { v: 1, name: 'Test PC', pub: bytesToB64u(rig.desktop.keys.publicKey), psk: bytesToB64u(new Uint8Array(32).fill(9)), offer: rig.offer, ttl: 120, carriers, sas: '6', ...extra };
  return `plenum://pair#${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

describe('release builds: no globals, one frame check, a facade of eleven members (S2, DQ2)', () => {
  it('a release start sets no plenumShellCore and no plenumNative; a dev start sets both', async () => {
    const release = pageEnv();
    const shell = await startShell(release.env, { devBuild: false, attach: null });
    assert.ok(shell);
    assert.equal('plenumShellCore' in release.env, false);
    assert.equal('plenumNative' in release.env, false);
    const dev = pageEnv();
    const devShell = await startShell(dev.env, { devBuild: true, attach: null });
    assert.equal(dev.env.plenumShellCore, devShell);
    assert.equal('plenumNative' in dev.env, true);
  });

  // Fable's re-check: any script of the page's origin can `await import('/shell/shell.js')` (the same evaluated namespace) and call
  // startShell(window, { giveCore, attach: null }) for a second full core (pair without review, setPin, forget, lockOff, channel.request with
  // scope 'shell'), or startShell(window, { devBuild: true }) to set window.plenumShellCore and window.plenumNative in a release build.
  // The page global is the one env that counts as the page, and only once per page: this test is that page, played in this process (the
  // marker the first start leaves on globalThis is not configurable, so it is the one page start of the process; the other starts in this
  // file use their own env objects, which are not the page).
  it('the page starts once: a page start ignores a devBuild option in a release build and sets no globals; a second startShell on the page global resolves null, hands out no core and sets no globals, even from another evaluation of the module', async () => {
    const HOOKS = ['plenumShellCore', 'plenumNative'];
    // A release-mode evaluation of the module: DEV_BUILD is read from __PLENUM_DEV_BUILD__ (the build's define) when the module is evaluated.
    // Two evaluations of the same file under different query strings stand for /shell/shell.js and /shell/shell.js?x, which the server answers alike.
    globalThis.__PLENUM_DEV_BUILD__ = false;
    let release;
    let again;
    try {
      release = await import('../shell/app.js?page-start-release');
      again = await import('../shell/app.js?page-start-release-again');
    } finally {
      delete globalThis.__PLENUM_DEV_BUILD__;
    }
    assert.equal(release.DEV_BUILD, false, 'a release-mode module');
    assert.equal(again.DEV_BUILD, false);
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, '__plenumPageStarted'), undefined, 'nothing has started a page yet');
    globalThis.indexedDB = createFakeIndexedDB();
    try {
      // The page's start, with the option a script would pass: devBuild is the constant, not the option.
      let first = 'unset';
      const shell = await release.startShell(globalThis, { devBuild: true, attach: null, giveCore: core => { first = core; } });
      assert.ok(shell, 'the first start on the page runs');
      assert.equal(first, shell, 'and hands its core to the hand-over');
      for (const name of HOOKS) assert.equal(name in globalThis, false, `${name}: a release page start sets no test hook, whatever devBuild says`);
      // A script of the page asks for a second core.
      let second = 'unset';
      let attached = false;
      const out = await release.startShell(globalThis, { attach: () => { attached = true; }, giveCore: core => { second = core; } });
      assert.equal(out, null, 'a second start on the page global resolves null');
      assert.equal(second, null, 'it is handed no core');
      assert.equal(attached, false, 'and no facade');
      assert.equal(await release.startShell(globalThis, { devBuild: true, attach: null }), null, 'with or without the options');
      assert.equal(await release.startShell(), null, 'and the default env is the page global');
      for (const name of HOOKS) assert.equal(name in globalThis, false, `${name}: a refused start sets nothing`);
      // The same file evaluated again (another query string) is refused too: its own flag is clear, the page's marker is not.
      assert.equal(await again.startShell(globalThis, { devBuild: true, attach: null, giveCore: core => { second = core; } }), null);
      assert.equal(second, null);
      for (const name of HOOKS) assert.equal(name in globalThis, false, name);
      // An env that is not the page global is not a page start: the Node suites' option-driven starts are unchanged.
      const other = pageEnv();
      const dev = await release.startShell(other.env, { devBuild: true, attach: null });
      assert.ok(dev);
      assert.equal(other.env.plenumShellCore, dev, 'devBuild: true still works for an env of the suites');
      const rel = pageEnv();
      assert.ok(await release.startShell(rel.env, { devBuild: false, attach: null }));
      assert.equal('plenumShellCore' in rel.env, false);
    } finally {
      delete globalThis.indexedDB;
      for (const name of HOOKS) delete globalThis[name];
    }
  });

  it('the shim gets exactly the facade: frozen, eleven members, no lock-set, forget, pair, channel or debug', async () => {
    const { env } = pageEnv();
    let facade = null;
    let handed = 'unset';
    const shell = await startShell(env, { devBuild: false, attach: f => { facade = f; return true; }, giveCore: core => { handed = core; } });
    assert.ok(facade, 'attach was called once the core existed');
    assert.deepEqual(Object.keys(facade).sort(), FACADE_KEYS);
    assert.equal(Object.isFrozen(facade), true);
    for (const name of NOT_ON_THE_FACADE) assert.equal(name in facade, false, name);
    assert.equal(handed, shell, 'the screens get the full core through the hand-over');
    assert.equal(typeof handed.pair, 'function');
    assert.throws(() => { 'use strict'; facade.pair = () => {}; }, TypeError, 'a script cannot add to it');
    // Only the eight plugin names are answered, openShell takes three hashes, and a request with no channel is offline.
    assert.equal(facade.plugin('SecureStorage'), null);
    assert.equal(facade.plugin('BiometricAuth'), null);
    assert.equal(await facade.openShell('#pair=abc'), false);
    assert.equal(await facade.openShell('#connect=' + 'a'.repeat(64)), false, 'only app.js opens #connect');
    await assert.rejects(facade.request({ method: 'GET', path: '/api/state' }), err => err.code === 'offline');
    const taken = typeof facade.subscribe(() => {});
    assert.equal(taken, 'function', 'subscribe returns the unsubscribe function');
  });

  it('the facade answers plugin(name) for the eight names only, and passes the page scope with every request', async () => {
    const plugins = { App: { id: 'app' }, TextZoom: 1, Haptics: 2, Dictation: 3, IsolatedPreview: 4, Browser: 5, Share: 6, Filesystem: 7, secureStorage: { id: 'secret' }, BiometricAuth: { id: 'bio' } };
    const seen = [];
    const shell = { channel: { request: (spec, body, opts) => { seen.push(opts); return Promise.resolve('answer'); } }, state: () => ({}), subscribe: () => () => {}, stop: () => {}, lockNow: () => {}, unlock: () => {}, connect: () => {}, openShell: h => Promise.resolve(h), takeRoute: () => null, pageLog: () => true };
    const facade = makeFacade(shell, plugins);
    for (const name of ['App', 'TextZoom', 'Haptics', 'Dictation', 'IsolatedPreview', 'Browser', 'Share', 'Filesystem']) assert.ok(facade.plugin(name), name);
    for (const name of ['secureStorage', 'SecureStorage', 'BiometricAuth', 'WebView', 'UnifiedPush', '__proto__', 'constructor']) assert.equal(facade.plugin(name), null, name);
    assert.equal(await facade.request({ method: 'GET', path: '/api/state' }, null, { signal: null, scope: 'shell' }), 'answer');
    assert.equal(seen[0].scope, 'page', 'the page cannot ask for the shell scope');
    assert.equal(await facade.openShell('#settings'), '#settings');
    assert.equal(await facade.openShell('#computers'), '#computers');
    assert.equal(await facade.openShell(''), '');
  });

  it('facade.state() carries only the listed fields: no pairing, no review hosts, no self-test, no key fields', async () => {
    const rig = pairingRig();
    const shell = rig.shell();
    await shell.boot();
    await shell.handleHash(rig.link);
    assert.equal(shell.state().pairing.state, 'review');
    const facade = makeFacade(shell, null);
    const state = facade.state();
    assert.deepEqual(Object.keys(state).sort(), ['activeId', 'computers', 'connection', 'device', 'hello', 'intent', 'lock', 'lockStop', 'locked', 'notice', 'page', 'prefs', 'stop']);
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.lock), true);
    const flat = JSON.stringify(state);
    for (const word of ['pairing', 'review', 'selftest', 'fake-pc.local', 'psk', 'myPriv', 'privateKey', 'stopKey', 'myDeviceId', 'pushKey', 'desktopPub']) assert.equal(flat.includes(word), false, word);
    assert.deepEqual(Object.keys(state.lock).sort(), ['failures', 'locked', 'mode', 'waitSec']);
    assert.deepEqual(Object.keys(state.lockStop).sort(), ['computerName', 'ready']);
    assert.deepEqual(Object.keys(state.stop).sort(), ['ack', 'seq', 'state', 'text']);
    assert.deepEqual(Object.keys(state.device).sort(), ['app', 'appVersion', 'platform', 'protocol']);
    // A subscriber hears the same reduced state.
    let heard = null;
    facade.subscribe(s => { heard = s; })();
    assert.deepEqual(Object.keys(heard).sort(), Object.keys(state).sort());
  });

  it('a framed page, or one a same-origin window opened, starts nothing: startShell returns null and the store is never opened', async () => {
    for (const [what, extra] of [
      ['a frame', { top: {}, self: {} }],
      ['a throw reading top', Object.defineProperty({ self: {} }, 'top', { get() { throw new Error('cross-origin'); }, enumerable: true })],
      ['a same-origin opener', { opener: { location: { origin: 'https://localhost' } } }],
    ]) {
      const { env, idb } = pageEnv();
      Object.defineProperties(env, Object.getOwnPropertyDescriptors(extra));
      env.location.origin = 'https://localhost';
      let handed = 'unset';
      let attached = false;
      const out = await startShell(env, { attach: () => { attached = true; }, giveCore: core => { handed = core; } });
      assert.equal(out, null, what);
      assert.equal(handed, null, `${what}: the hand-over resolves null`);
      assert.equal(attached, false, what);
      assert.equal(idb.databases.size, 0, `${what}: the store was not opened`);
    }
    // A cross-origin opener (reading its location throws) and the page itself as its top are fine.
    const ok = pageEnv({ opener: { get location() { throw new Error('cross-origin'); } } });
    ok.env.self = ok.env; ok.env.top = ok.env;
    assert.ok(await startShell(ok.env, { attach: null }));
  });

  it('modeFor: ?selftest is the self-test only in a dev build; ?demo=1 is the replay in both', () => {
    assert.equal(modeFor('?selftest', false), 'normal');
    assert.equal(modeFor('?selftest', true), 'selftest');
    assert.equal(modeFor('?demo=1', false), 'demo');
    assert.equal(modeFor('?demo=1', true), 'demo');
    assert.equal(modeFor('?selftest&demo=1', false), 'demo');
    assert.equal(modeFor('', false), 'normal');
    assert.equal(modeFor(undefined), 'normal');
  });
});

describe('the worker enforces the request policy (S2, DQ2)', () => {
  async function connectedCore() {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    return { rig, desktop };
  }
  const endOf = (rig, sid) => rig.messages.find(m => m.op === 'end' && m.sid === sid);

  it('a page request keeps accept, content-type and x-plenum-client-id and drops the notify line and anything else', async () => {
    const { rig, desktop } = await connectedCore();
    rig.core.handle({ op: 'request', sid: 1, method: 'GET', path: '/api/state', headers: { Accept: 'application/json', 'X-Plenum-Notify-Line': 'Run: x', 'x-plenum-token': 'abc', cookie: 'a=b', 'Content-Type': 'text/plain', 'x-plenum-client-id': 'c1' }, scope: 'page', body: null });
    rig.core.handle({ op: 'request', sid: 2, method: 'GET', path: '/api/state', headers: { 'x-plenum-notify-line': 'Run: x' }, body: null });
    await settle();
    const seen = desktop.stats.requests.filter(r => r.path === '/api/state');
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].headers, { accept: 'application/json', 'content-type': 'text/plain', 'x-plenum-client-id': 'c1' });
    assert.deepEqual(seen[1].headers, {}, 'a request with no scope is a page request');
  });

  it('a page request never reaches /_bridge/: the plain, the encoded and the dot-segment forms all end refused, and nothing goes to the computer', async () => {
    const { rig, desktop } = await connectedCore();
    const paths = ['/_bridge/log', '/%5Fbridge/log', '/a/../_bridge/log', '/%5fbridge/ui-manifest', '/a/%2e%2e/_bridge/log', '/_bridge/anything', '/_bridge/log?x=1'];
    paths.forEach((path, i) => rig.core.handle({ op: 'request', sid: 10 + i, method: 'POST', path, headers: { 'content-type': 'application/json' }, scope: 'page', body: new Uint8Array([123, 125]) }));
    await settle();
    paths.forEach((path, i) => assert.equal(endOf(rig, 10 + i)?.error, 'refused', path));
    assert.equal(desktop.stats.requests.some(r => r.path.includes('_bridge') || r.path.includes('%5')), false, 'none reached the computer');
  });

  it('a shell request may send the notify line and POST /_bridge/log and /_bridge/ui-manifest, and nothing else under /_bridge/', async () => {
    const { rig, desktop } = await connectedCore();
    rig.core.handle({ op: 'request', sid: 20, method: 'POST', path: '/_bridge/log', headers: { 'content-type': 'application/json', 'x-plenum-notify-line': 'Run: x', cookie: 'no' }, scope: 'shell', body: new TextEncoder().encode('{"line":"hello"}') });
    rig.core.handle({ op: 'request', sid: 21, method: 'GET', path: '/_bridge/ui-manifest', headers: {}, scope: 'shell', body: null });
    rig.core.handle({ op: 'request', sid: 22, method: 'GET', path: '/_bridge/other', headers: {}, scope: 'shell', body: null });
    rig.core.handle({ op: 'request', sid: 23, method: 'GET', path: '/a/../_bridge/log', headers: {}, scope: 'shell', body: null });
    rig.core.handle({ op: 'request', sid: 24, method: 'POST', path: '/api/approve', headers: { 'content-type': 'application/json', 'x-plenum-notify-line': 'Run: x' }, scope: 'shell', body: new TextEncoder().encode('{"approvalId":"a","allow":true}') });
    await settle();
    assert.equal(endOf(rig, 22)?.error, 'refused');
    assert.equal(endOf(rig, 23)?.error, 'refused', 'a dot segment is refused even in the shell scope');
    assert.deepEqual(desktop.stats.logs, ['hello']);
    assert.deepEqual(desktop.stats.requests.find(r => r.path === '/_bridge/log').headers, { 'content-type': 'application/json', 'x-plenum-notify-line': 'Run: x' });
    assert.ok(desktop.stats.requests.some(r => r.path === '/_bridge/ui-manifest'));
    assert.equal(desktop.stats.approvals.at(-1)?.line, 'Run: x');
  });

  it('requestPolicy refuses a path that does not start with /, has a backslash or a dot segment, a protocol-relative path, or does not decode', () => {
    for (const path of ['api/state', '\\api', '/a\\b', '//evil.example/x', '/a/../b', '/a/%2E%2E/b', '/%zz', '/%5C..%5Cx']) assert.equal(requestPolicy({ path }), null, path);
    assert.equal(requestPolicy({ path: '/_Bridge/log', scope: 'page' }), null, 'the check does not depend on case');
    assert.equal(requestPolicy({ path: '/_BRIDGE/LOG', scope: 'shell' }), null, 'and the shell\'s two paths are exact');
    assert.ok(requestPolicy({ path: '/_bridge/log', scope: 'shell' }));
    assert.ok(requestPolicy({ path: '/_bridge/ui-manifest', scope: 'shell' }));
    assert.equal(requestPolicy({ path: '/_bridge/log', scope: 'bogus' }), null, 'an unknown scope is the page scope');
    assert.deepEqual(requestPolicy({ path: '/api/state?x=1&y=2', headers: { Accept: 'a' } }), { path: '/api/state?x=1&y=2', headers: { accept: 'a' } });
    assert.deepEqual(requestPolicy({ path: '/', headers: { 'x-plenum-client-id': 7 } }).headers, { 'x-plenum-client-id': '7' }, 'values are strings');
    assert.ok(requestPolicy({ path: '/a/b..c/d' }), 'two dots inside a name are not a dot segment');
  });

  it('channel.request carries its scope to the worker, page by default', () => {
    const sent = [];
    const worker = { postMessage: msg => sent.push(msg), terminate() {} };
    const channel = openChannel({ computer: freshComputer({ keys: generateKeyPair(), url: 'ws://fake-pc.local/b/k' }, generateKeyPair()), createWorker: () => worker });
    channel.request({ method: 'GET', path: '/a' });
    channel.request({ method: 'GET', path: '/b' }, null, { scope: 'shell' });
    channel.request({ method: 'GET', path: '/c' }, null, { scope: 'bogus' });
    assert.deepEqual(sent.filter(m => m.op === 'request').map(m => m.scope), ['page', 'shell', 'page']);
    assert.equal(sent.find(m => m.op === 'init').hasStopKey, false);
    channel.close();
  });

  it('a socket message over 65599 bytes closes 1009 before it is copied and reaches no handler; the largest allowed one does', async () => {
    const clock = createFakeClock(0);
    let ws = null;
    class Big {
      constructor() {
        ws = this;
        this.listeners = { open: [], message: [], close: [], error: [] };
        this.closedWith = null;
        queueMicrotask(() => this.emit('open', {}));
      }
      addEventListener(type, fn) { this.listeners[type].push(fn); }
      emit(type, event) { for (const fn of this.listeners[type]) fn(event); }
      send() {}
      close(code, reason) { this.closedWith = [code, reason]; }
    }
    const sock = await openSocket(Big, 'ws://fake-pc.local/b/k', { clock });
    let heard = 0;
    sock.onMessage = () => { heard += 1; };
    ws.emit('message', { data: new ArrayBuffer(70_000) });
    assert.deepEqual(ws.closedWith, [1009, 'too-big']);
    assert.equal(heard, 0, 'no handler saw it');
    ws.closedWith = null;
    ws.emit('message', { data: new ArrayBuffer(65535 + 64) });
    assert.equal(heard, 1, 'the largest legal message passes');
    assert.equal(ws.closedWith, null);
  });
});

describe('Stop without unlocking (S4, DQ1 phone half)', () => {
  it('a PIN-locked shell with the computer\'s Stop key sends STOP_ONLY without unlocking: the view is done with the counts and the lock stays on', async () => {
    const k = await lockedStopRig({ desktop: { stopCounts: { drivesStopped: 2, agentsStopped: 3, cardsDenied: 1 } } });
    assert.equal(k.shell.state().route, 'locked');
    assert.deepEqual(k.shell.state().lockStop, { ready: true, computerName: 'Test PC' });
    const out = await k.shell.stop();
    assert.equal(out.state, 'done');
    assert.deepEqual({ ...out.ack, id: undefined }, { id: undefined, cancelled: 0, drivesStopped: 2, agentsStopped: 3, cardsDenied: 1 });
    assert.match(out.text, /^Stopped everything on Test PC: 2 computer runs, 3 agents\. 1 card denied\.$/);
    assert.equal(k.desktop.stats.stopOnly.length, 1);
    assert.equal(k.desktop.stats.stopOnly[0].stopId, out.ack.id, 'the ack answers the press');
    assert.equal(k.desktop.stats.handshakes, 0, 'no Noise session was opened');
    assert.equal(k.desktop.stats.stops, 0, 'and no STOP frame');
    assert.equal(k.shell.state().route, 'locked', 'the lock stayed on');
    assert.equal(k.shell.state().locked, true);
    assert.equal(k.shell.channel, null);
    assert.equal(k.shell.state().stop.state, 'done');
    assert.equal(k.shell.state().notice?.text, out.text, 'the toast says it too');
    // The key never reached the state.
    assert.equal(JSON.stringify(k.shell.state()).includes('stopKey'), false);
  });

  it('a #stop from a notification while locked goes out at once', async () => {
    const k = await lockedStopRig();
    const out = await k.shell.handleHash('#stop');
    assert.equal(out.state, 'done');
    assert.equal(k.desktop.stats.stopOnly.length, 1, 'sent behind the lock, not parked');
    assert.equal(k.shell.state().route, 'locked');
    // The plenum://app/ form from the native app takes the same road.
    const app = fakeAppPlugin();
    wireAppPlugin({ appPlugin: app, shell: k.shell, env: {}, pageKind: 'shell', platform: 'android' });
    app.emit('appUrlOpen', { url: 'plenum://app/#stop' });
    await waitFor(() => k.desktop.stats.stopOnly.length === 2, 4000);
    assert.equal(k.shell.state().route, 'locked');
  });

  it('a locked cold start from a notification (start() with #stop in the address) stops at once and stays locked', async () => {
    const k = await lockedStopRig({ shell: { pageUrl: 'https://phone.example/#stop' } });
    await k.shell.start();
    assert.equal(k.desktop.stats.stopOnly.length, 1);
    assert.equal(k.shell.state().route, 'locked');
    assert.equal(k.shell.state().stop.state, 'done');
  });

  it('lock settings that cannot be read: boot resolves, lock.mode is unknown and locked, and Stop still works', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(recordWithStopKey(desktop, phone));
    const unreadable = { lockOnLaunch: async () => { throw new Error('lock record unreadable'); }, status: async () => { throw new Error('lock record unreadable'); }, lock() {}, protect: async r => r };
    const shell = createShell({ store, lock: unreadable, createWorker: fakeWorkerFactory({ net, clock, store }), stopClock: createFakeClock(5) });
    const snapshot = await shell.boot();
    assert.equal(snapshot.lock.mode, 'unknown');
    assert.equal(snapshot.locked, true);
    assert.equal(snapshot.route, 'locked');
    assert.equal(snapshot.lockStop.ready, true);
    const out = await shell.stop();
    assert.equal(out.state, 'done');
    assert.equal(desktop.stats.stopOnly.length, 1);
    assert.equal(shell.state().lock.mode, 'unknown');
    assert.equal(shell.channel, null, 'nothing was connected');
    assert.equal((await shell.handleHash('#settings')).reason, 'locked');
  });

  it('the computer does not know this phone\'s Stop key: every URL closes 4401 and the press fails with the text that names the way out', async () => {
    const k = await lockedStopRig({ desktop: { refuseStopOnly: true } });
    const out = await k.shell.stop();
    assert.equal(out.state, 'failed');
    assert.equal(out.error, 'unknown');
    assert.equal(out.text, STOP_NOT_ACCEPTED('Test PC'));
    assert.match(out.text, /^Test PC did not accept this Stop\. This phone may have been removed there\. At the computer, press Stop on the bar or Ctrl\+Alt\+Esc\.$/);
    assert.equal(k.shell.state().stop.state, 'failed');
  });

  it('lockStop.ready is false for a record without a Stop key: stop() answers needs-unlock, says so, and keeps #stop for the unlock', async () => {
    const k = await lockedStopRig({ withKey: false });
    assert.deepEqual(k.shell.state().lockStop, { ready: false, computerName: 'Test PC' });
    const out = await k.shell.stop();
    assert.equal(out.state, 'idle');
    assert.equal(out.reason, 'needs-unlock');
    assert.equal(k.shell.state().notice.text, STOP_NEEDS_UNLOCK);
    assert.equal(k.shell.state().notice.text, 'Unlock Plenum to send this Stop. It goes out as soon as Plenum unlocks.');
    assert.equal(k.desktop.stats.stopOnly.length, 0);
    assert.equal(k.desktop.stats.handshakes, 0);
    // The parked Stop runs when the app unlocks (this phone used the computer before, so it is the saved one).
    await k.store.meta.put('active', k.id);
    assert.equal((await k.shell.unlock('pin', '123456')).ok, true);
    await waitFor(() => k.desktop.stats.stops === 1, 8000);
    assert.equal(k.desktop.stats.stopOnly.length, 0, 'it went as an ordinary STOP on the live channel');
  });

  it('the first session of a phone with no Stop key tops it up: wantStopKey, HELLO stopKeyNew, a patch of the record; the lock screen is then ready', async () => {
    const k = await connectedShell({ withLock: true });
    const phoneId = k.deviceId;
    await until(async () => (await k.store.get(k.id)).stopKey, 'the Stop key in the record', 8000);
    const record = await k.store.get(k.id);
    assert.equal(record.stopKey, bytesToB64u(k.desktop.stopKeys.get(phoneId)), 'the phone made the key the computer stored');
    assert.equal(record.myDeviceId, phoneId, 'and keeps its own id there');
    await waitFor(() => k.shell.state().lockStop.ready, 4000);
    assert.equal((await k.shell.setPin('123456')).ok, true);
    await k.shell.lockNow();
    assert.equal(k.shell.state().route, 'locked');
    const out = await k.shell.stop();
    assert.equal(out.state, 'done', 'a record that was topped up stops from the lock screen');
    assert.equal(k.desktop.stats.stopOnly.length, 1);
    assert.equal((await k.store.get(k.id)).stopKey, record.stopKey, 'the lock did not wrap or change it');
  });

  it('a worker with a Stop key does not ask again; one without asks and patches the record', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    const phoneId = deviceId(phone.publicKey);
    desktop.counters.set(phoneId, 0);
    const asking = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    asking.init();
    await settle();
    assert.equal(asking.last('hello').hello.stopKeyNew, true, 'the computer answered wantStopKey');
    const patch = asking.messages.find(m => m.op === 'patch' && m.patch.stopKey);
    assert.deepEqual(patch.patch, { stopKey: bytesToB64u(desktop.stopKeys.get(phoneId)), myDeviceId: phoneId });
    assert.equal(asking.core.phase, 'connected');
    // A later session on the same worker does not ask again (hasStopKey is set once the patch went out).
    desktop.killAll();
    await settle();
    desktop.comeBack();
    await walk(clock, 5000);
    assert.equal(asking.core.phase, 'connected', 'reconnected');
    assert.equal(asking.messages.filter(m => m.op === 'hello').length, 2);
    assert.equal(asking.last('hello').hello.stopKeyNew, undefined, 'the second session did not ask');
    assert.equal(asking.messages.filter(m => m.op === 'patch' && m.patch.stopKey).length, 1, 'one patch in all');
    // A fresh worker whose record already has the key is told so in init, and does not ask at all.
    const second = coreRig({ net, clock, computer: coreComputer(desktop, phone, { counter: asking.counters.get(deviceId(desktop.keys.publicKey)) }), stored: asking.counters.get(deviceId(desktop.keys.publicKey)) });
    second.core.handle({ op: 'init', computer: coreComputer(desktop, phone, { counter: asking.counters.get(deviceId(desktop.keys.publicKey)) }), device: { name: 'Test phone' }, caps: ['ui-from-desktop'], hasStopKey: true });
    await settle();
    assert.equal(second.core.phase, 'connected');
    assert.equal(second.last('hello').hello.stopKeyNew, undefined);
    assert.equal(second.messages.some(m => m.op === 'patch' && m.patch.stopKey), false);
  });

  it('the pairing record holds the Stop key and the phone\'s id equal to the computer\'s, and only carriers that pass the rules', async () => {
    const rig = pairingRig();
    const shell = rig.shell();
    await shell.boot();
    const pairing = shell.pair(linkWith(rig, [{ kind: 'lan', urls: [rig.desktop.url, 'ws://8.8.8.8:4318/b/k'] }, { kind: 'relay', urls: ['ws://relay.example/r/x'] }]));
    assert.match(await rig.codeUp(shell.state), /^[0-9]{6}$/);
    rig.desktop.allow(rig.offer);
    const result = await pairing;
    assert.equal(result.state, 'allowed');
    const record = await rig.store.get(result.computerId);
    const [phoneId] = [...rig.desktop.registry.keys()];
    assert.equal(record.myDeviceId, phoneId, 'the id the computer knows this phone by');
    assert.equal(record.stopKey, bytesToB64u(rig.desktop.stopKeys.get(phoneId)), 'the same key on both sides');
    assert.deepEqual(record.carriers, [{ kind: 'lan', urls: [rig.desktop.url] }], 'the stored list is the sanitised one');
    assert.equal(publicComputer(record).stopReady, true);
    assert.equal('stopKey' in publicComputer(record), false);
    assert.equal('myDeviceId' in publicComputer(record), false);
    assert.equal(JSON.stringify(shell.state()).includes(record.stopKey), false);
  });

  it('worker stopLocked: the first answer ends the press with the ack, no Noise session is opened, and the key is the only thing it needs', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, stopCounts: { agentsStopped: 4 } });
    const phone = generateKeyPair();
    const phoneId = deviceId(phone.publicKey);
    const stop = new Uint8Array(32).fill(7);
    desktop.stopKeys.set(phoneId, stop);
    desktop.counters.set(phoneId, 0);
    const computer = coreComputer(desktop, phone);
    const rig = coreRig({ net, clock, computer });
    rig.core.handle({ op: 'stopLocked', sid: 5, computer: { id: computer.id, deviceId: phoneId, stopKey: stop, carriers: computer.carriers, lastCarrier: null, counter: 0 } });
    await settle();
    assert.equal(rig.messages.find(m => m.op === 'stopState')?.state, 'sending');
    const ack = rig.last('stopAck');
    assert.equal(ack.sid, 5);
    assert.deepEqual({ ...ack.ack, id: undefined }, { id: undefined, cancelled: 0, drivesStopped: 0, agentsStopped: 4, cardsDenied: 0 });
    assert.match(ack.ack.id, /^[0-9a-f]{32}$/);
    assert.equal(desktop.stats.stopOnly[0].stopId, ack.ack.id);
    assert.equal(desktop.stats.handshakes, 0);
    assert.equal(rig.messages.some(m => m.op === 'state' || m.op === 'hello'), false, 'no session, no state');
    assert.equal(rig.messages.some(m => JSON.stringify(m).includes(bytesToB64u(new Uint8Array(32).fill(7)))), false, 'and never posted');
  });

  it('worker stopLocked: a round in which every URL closes 4401 ends unknown; one dead URL among them keeps it trying', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, refuseStopOnly: true });
    const phone = generateKeyPair();
    const phoneId = deviceId(phone.publicKey);
    const stop = new Uint8Array(32).fill(8);
    desktop.counters.set(phoneId, 0);
    const computer = coreComputer(desktop, phone);
    const rig = coreRig({ net, clock, computer });
    rig.core.handle({ op: 'stopLocked', sid: 1, computer: { id: computer.id, deviceId: phoneId, stopKey: stop, carriers: computer.carriers, lastCarrier: null, counter: 0 } });
    await settle();
    assert.equal(rig.last('stopAck')?.error, 'unknown');
    assert.equal(rig.messages.filter(m => m.op === 'stopState' && m.state === 'queued').length, 0);
    // The same with a URL nobody listens on first: that round is not all 4401, so the press goes on.
    const mixed = coreRig({ net, clock, computer });
    const carriers = [{ kind: 'lan', urls: ['ws://nobody.local/b/k', desktop.url] }];
    mixed.core.handle({ op: 'stopLocked', sid: 2, computer: { id: computer.id, deviceId: phoneId, stopKey: new Uint8Array(32).fill(8), carriers, lastCarrier: null, counter: 0 } });
    await settle();
    assert.equal(mixed.last('stopAck'), undefined, 'not unknown: one URL did not answer 4401');
    assert.equal(mixed.messages.filter(m => m.op === 'stopState').at(-1).state, 'queued');
  });

  it('worker stopLocked: no answer gives queued, resends carry a rising counter and the same stopId, and it ends unreachable at 60 s', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, silentStopOnly: true });
    const phone = generateKeyPair();
    const phoneId = deviceId(phone.publicKey);
    desktop.counters.set(phoneId, 0);
    const computer = coreComputer(desktop, phone);
    const rig = coreRig({ net, clock, computer });
    rig.core.handle({ op: 'stopLocked', sid: 3, computer: { id: computer.id, deviceId: phoneId, stopKey: new Uint8Array(32).fill(9), carriers: computer.carriers, lastCarrier: null, counter: 0 } });
    await walk(clock, 8000);
    assert.equal(rig.messages.filter(m => m.op === 'stopState').map(m => m.state)[0], 'sending');
    assert.ok(rig.messages.some(m => m.op === 'stopState' && m.state === 'queued'), 'queued after the first round');
    assert.equal(rig.last('stopAck'), undefined, 'still trying');
    await walk(clock, 40_000);
    assert.equal(rig.last('stopAck'), undefined, 'inside the 60 s window');
    await walk(clock, 14_000);
    const failed = rig.last('stopAck');
    assert.equal(failed.sid, 3);
    assert.equal(failed.error, 'unreachable');
    const seen = desktop.stats.stopOnly;
    assert.ok(seen.length >= 3, `resent (${seen.length})`);
    assert.equal(new Set(seen.map(x => x.stopId)).size, 1, 'the same stopId on every resend');
    seen.slice(1).forEach((x, i) => assert.ok(x.counter > seen[i].counter, 'the counter rises'));
    const after = seen.length;
    await walk(clock, 30_000);
    assert.equal(desktop.stats.stopOnly.length, after, 'nothing is sent after the window');
  });

  it('a record with no valid Stop key rejects no-key and starts no worker', async () => {
    let workers = 0;
    for (const record of [{ id: 'c' }, { id: 'c', stopKey: 'short', myDeviceId: 'a'.repeat(64) }, { id: 'c', stopKey: 'A'.repeat(43), myDeviceId: 'xyz' }, null]) {
      await assert.rejects(sendLockedStop({ record, createWorker: () => { workers += 1; return {}; } }), err => err.code === 'no-key');
    }
    assert.equal(workers, 0);
  });

  it('the stop controller fails with unreachable after 65 s with no answer, and a closed 4401 reads as not accepted', async () => {
    const clock = createFakeClock(0);
    const ctl = createStopController({ channel: { stop: () => new Promise(() => {}) }, clock, computerName: 'Test PC' });
    const seen = [];
    ctl.subscribe(v => seen.push(v.state));
    const pressed = ctl.press();
    clock.advance(STOP_WATCHDOG_MS - 1);
    assert.equal(ctl.state, 'sending');
    clock.advance(1);
    const out = await pressed;
    assert.equal(out.state, 'failed');
    assert.equal(out.error, 'unreachable');
    assert.equal(STOP_WATCHDOG_MS, 65000);
    const refused = createStopController({ channel: { stop: () => Promise.reject(Object.assign(new Error('unknown'), { code: 'unknown' })) }, clock, computerName: 'Home PC' });
    assert.equal((await refused.press()).text, STOP_NOT_ACCEPTED('Home PC'));
  });

  it('a worker error rejects every waiting Stop with unreachable and every open request with lost, then terminates the worker', async () => {
    class FakeWorker {
      constructor() { this.sent = []; this.terminated = false; this.onmessage = null; this.onerror = null; }
      postMessage(msg) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
      emit(data) { this.onmessage?.({ data }); }
    }
    const worker = new FakeWorker();
    const channel = openChannel({ computer: { id: 'c1', name: 'PC', desktopPub: bytesToB64u(new Uint8Array(32).fill(1)), myPriv: bytesToB64u(new Uint8Array(32).fill(2)), carriers: [], counter: 0 }, createWorker: () => worker });
    const stopping = channel.stop().then(() => null, err => err);
    const early = channel.request({ method: 'GET', path: '/api/state' }).then(() => null, err => err);
    const streaming = channel.request({ method: 'GET', path: '/api/events' });
    const sid = worker.sent.filter(m => m.op === 'request').at(-1).sid;
    worker.emit({ op: 'res', sid, status: 200, headers: {} });
    const answered = await streaming;
    const reader = answered.body.getReader();
    const reading = reader.read().then(() => null, err => err);
    worker.onerror({ message: 'boom' });
    assert.equal((await stopping).code, 'unreachable');
    assert.equal((await early).code, 'lost');
    assert.equal((await reading).code, 'lost', 'the open stream errors');
    assert.equal(worker.terminated, true);
  });

  it('a Stop pressed while the phone is away tries to reconnect at once, not at the next retry timer', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    desktop.killAll();
    await settle();
    desktop.comeBack();
    const before = clock.now();
    const dialed = rig.dials.length;
    rig.core.handle({ op: 'stop', sid: 4, project: null });
    await settle();
    assert.equal(clock.now(), before, 'no time passed');
    assert.ok(rig.dials.length > dialed, 'it dialed at once');
    assert.ok(rig.last('stopAck')?.ack?.id, 'and the Stop was answered without waiting for the retry timer');
  });
});

describe('the pairing review (S1, B-H1, B-M2, SL5, B-M1)', () => {
  it('a pairing link from handleHash goes to review with every host and opens no socket until confirmPair', async () => {
    const rig = pairingRig();
    const shell = rig.shell();
    await shell.boot();
    const link = linkWith(rig, [
      { kind: 'lan', urls: [rig.desktop.url, 'ws://192.168.1.20:4318/b/k'] },
      { kind: 'tailscale', urls: ['wss://pc.tail-1234.ts.net/b/k'] },
      { kind: 'relay', urls: ['wss://relay.example/r/room'] },
    ]);
    const out = await shell.handleHash(link);
    assert.deepEqual(out, { ok: true, reason: null, kind: 'review' });
    await settle(30);
    const pairing = shell.state().pairing;
    assert.equal(pairing.state, 'review');
    assert.equal(pairing.code, null);
    assert.deepEqual(pairing.tried, []);
    assert.equal(pairing.reason, null);
    assert.deepEqual(pairing.review, {
      name: 'Test PC',
      hosts: [
        { kind: 'lan', host: 'fake-pc.local' },
        { kind: 'lan', host: '192.168.1.20:4318' },
        { kind: 'tailscale', host: 'pc.tail-1234.ts.net' },
        { kind: 'relay', host: 'relay.example' },
      ],
    });
    assert.equal(rig.desktop.stats.handshakes + rig.desktop.stats.refused, 0, 'no socket reached the computer');
    assert.equal(JSON.stringify(shell.state()).includes(bytesToB64u(new Uint8Array(32).fill(9))), false, 'the pairing secret is not in the state');
    assert.equal(shell.state().route, 'code');
    // Pair starts it.
    const confirming = shell.confirmPair();
    assert.match(await rig.codeUp(shell.state), /^[0-9]{6}$/);
    rig.desktop.allow(rig.offer);
    assert.equal((await confirming).state, 'allowed');
    assert.equal(shell.state().computers.length, 1);
    assert.deepEqual(await shell.confirmPair(), { ok: false, reason: 'none' }, 'the parked link is used once');
  });

  it('Cancel drops the parked link: confirmPair then answers none and nothing pairs', async () => {
    const rig = pairingRig();
    const shell = rig.shell();
    await shell.boot();
    await shell.handleHash(rig.link);
    assert.equal(shell.state().pairing.state, 'review');
    shell.cancelPairing();
    assert.equal(shell.state().pairing, null);
    assert.deepEqual(await shell.confirmPair(), { ok: false, reason: 'none' });
    assert.equal(rig.desktop.stats.handshakes, 0);
    assert.equal(shell.state().computers.length, 0);
  });

  it('scan and paste (pair) still pair at once, and the review is only for a link from outside', async () => {
    const rig = pairingRig();
    const shell = rig.shell();
    await shell.boot();
    const pairing = shell.pair(rig.link);
    assert.match(await rig.codeUp(shell.state), /^[0-9]{6}$/, 'no review on this path');
    assert.equal(shell.state().pairing.state, 'confirm');
    rig.desktop.allow(rig.offer);
    assert.equal((await pairing).state, 'allowed');
  });

  it('review drops a ws:// relay, a public LAN address, a user:password URL and the 5th URL of a kind; a link with nothing left fails with no-carrier', async () => {
    const rig = pairingRig();
    const shell = rig.shell();
    await shell.boot();
    const lan = ['ws://10.0.0.5:4318/b/k', 'ws://8.8.8.8:4318/b/k', 'ws://172.16.0.5:4318/b/k', 'ws://192.168.0.5:4318/b/k', 'ws://169.254.1.5:4318/b/k', 'ws://100.64.0.5:4318/b/k'];
    const out = await shell.handleHash(linkWith(rig, [
      { kind: 'lan', urls: lan },
      { kind: 'relay', urls: ['ws://relay.example/r/x', 'wss://user:pw@relay.example/r/x'] },
      { kind: 'tailscale', urls: ['wss://pc.example.com/b/k'] },
    ]));
    assert.equal(out.kind, 'review');
    // The public address is dropped by the rules, and no kind keeps more than four URLs (the parse cuts the list at four, the rules at four that pass).
    assert.deepEqual(shell.state().pairing.review.hosts, [
      { kind: 'lan', host: '10.0.0.5:4318' },
      { kind: 'lan', host: '172.16.0.5:4318' },
      { kind: 'lan', host: '192.168.0.5:4318' },
    ]);
    shell.cancelPairing();
    const none = await shell.handleHash(linkWith(rig, [{ kind: 'lan', urls: ['ws://8.8.8.8/b/k'] }, { kind: 'relay', urls: ['ws://relay.example/r'] }]));
    assert.equal(none.state, 'failed');
    assert.equal(none.reason, 'no-carrier');
    assert.deepEqual(shell.state().pairing, { state: 'failed', code: null, tried: [], reason: 'no-carrier' });
    // A broken link fails with its own reason, as before.
    const broken = await shell.handleHash('https://example.com/#pair=bm90LWpzb24');
    assert.equal(broken.state, 'failed');
    assert.equal(broken.reason, 'not-plenum');
  });

  it('carrierUrlOk and usableCarriers follow the rules of decision D5', () => {
    const ok = (kind, url) => carrierUrlOk(kind, url);
    for (const url of ['ws://127.0.0.1:1/b', 'ws://localhost:1/b', 'ws://[::1]:1/b']) for (const kind of ['lan', 'tailscale', 'relay']) assert.equal(ok(kind, url), true, `${kind} ${url}`);
    assert.equal(ok('lan', 'ws://10.1.2.3/b'), true);
    assert.equal(ok('lan', 'ws://172.31.255.1/b'), true);
    assert.equal(ok('lan', 'ws://172.32.0.1/b'), false);
    assert.equal(ok('lan', 'ws://100.127.255.1/b'), true);
    assert.equal(ok('lan', 'ws://100.128.0.1/b'), false);
    assert.equal(ok('lan', 'ws://[fd12:3456::1]/b'), true);
    assert.equal(ok('lan', 'ws://[fe80::1]/b'), true);
    assert.equal(ok('lan', 'ws://[2001:db8::1]/b'), false);
    assert.equal(ok('lan', 'ws://my-pc.local/b'), true);
    assert.equal(ok('lan', 'ws://example.com/b'), false);
    assert.equal(ok('lan', 'wss://192.168.1.5/b'), true, 'wss is allowed for a private address');
    assert.equal(ok('tailscale', 'wss://pc.tailnet.ts.net/b'), true);
    assert.equal(ok('tailscale', 'ws://pc.tailnet.ts.net/b'), false);
    assert.equal(ok('tailscale', 'wss://pc.example.com/b'), false);
    assert.equal(ok('relay', 'wss://anything.example/b'), true);
    assert.equal(ok('relay', 'ws://anything.example/b'), false);
    assert.equal(ok('relay', 'https://anything.example/b'), false);
    assert.equal(ok('relay', 'wss://u@anything.example/b'), false);
    assert.equal(ok('relay', `wss://anything.example/${'a'.repeat(512)}`), false, 'longer than 512');
    assert.equal(ok('other', 'wss://a.example/'), false);
    assert.equal(ok('relay', 'not a url'), false);
    assert.equal(hostLabel('wss://relay.example:8443/x'), 'relay.example:8443');
    assert.equal(hostLabel('nonsense'), '');
    const many = usableCarriers([
      { kind: 'lan', url: 'ws://10.0.0.1/b' },
      { kind: 'lan', urls: ['ws://10.0.0.9/b'] },
      { kind: 'relay', urls: ['ws://bad.example/b'] },
      { kind: 'tailscale', urls: ['wss://a.ts.net/1', 'wss://a.ts.net/2', 'wss://a.ts.net/3', 'wss://a.ts.net/4', 'wss://a.ts.net/5'] },
      null,
      { kind: 'x', urls: ['wss://a.example/'] },
    ]);
    assert.deepEqual(many, [{ kind: 'lan', urls: ['ws://10.0.0.1/b'] }, { kind: 'tailscale', urls: ['wss://a.ts.net/1', 'wss://a.ts.net/2', 'wss://a.ts.net/3', 'wss://a.ts.net/4'] }]);
    assert.deepEqual(usableCarriers(null), []);
  });

  it('the worker dials only URLs that pass: a stored record with a public address or a ws:// relay is not dialed', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const computer = coreComputer(desktop, phone, { carriers: [{ kind: 'lan', urls: ['ws://8.8.8.8:4318/b/k', desktop.url] }, { kind: 'relay', urls: ['ws://relay.example/r/x'] }] });
    const rig = coreRig({ net, clock, computer });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    assert.deepEqual(rig.dials.map(d => d.url), [desktop.url], 'only the passing URL was dialed');
    // No kind is dialed at more than four URLs: the fifth, which is the one that answers, is never tried.
    const dead = ['a', 'b', 'c', 'd'].map(n => `ws://dead-${n}.local/b/k`);
    const five = coreComputer(desktop, phone, { carriers: [{ kind: 'lan', urls: [...dead, desktop.url] }], counter: 1 });
    const fifth = coreRig({ net, clock, computer: five, stored: 1 });
    fifth.init();
    await settle();
    assert.deepEqual(fifth.dials.map(d => d.url), dead, 'four URLs, then the round is over');
    assert.notEqual(fifth.core.phase, 'connected');
  });

  it('&ci-confirm=1 skips the review only when devBuild; a release build strips it and still shows the review', async () => {
    const dev = pairingRig();
    const devShell = dev.shell({ devBuild: true });
    await devShell.boot();
    const pairing = devShell.handleHash(`${dev.link}&ci-confirm=1`);
    assert.match(await dev.codeUp(devShell.state), /^[0-9]{6}$/, 'a dev build pairs at once');
    assert.equal(devShell.state().pairing.state, 'confirm');
    dev.desktop.allow(dev.offer);
    assert.equal((await pairing).state, 'allowed');
    const release = pairingRig();
    const releaseShell = release.shell({ devBuild: false });
    await releaseShell.boot();
    const out = await releaseShell.handleHash(`${release.link}&ci-confirm=1`);
    assert.equal(out.kind, 'review', 'the marker is stripped and the review shows');
    await settle(30);
    assert.equal(release.desktop.stats.handshakes + release.desktop.stats.refused, 0);
    const confirming = releaseShell.confirmPair();
    assert.match(await release.codeUp(releaseShell.state), /^[0-9]{6}$/, 'the stripped link still pairs');
    release.desktop.allow(release.offer);
    assert.equal((await confirming).state, 'allowed');
  });

  it('iOS ignores plenum://app/#stop and #deny (links and launch link); Android handles them; plenum://pair reaches the shell on both', async () => {
    for (const [platform, handled] of [['ios', false], ['android', true], [null, true]]) {
      const calls = [];
      const app = fakeAppPlugin({ launch: 'plenum://app/#deny=abc' });
      const afterStart = wireAppPlugin({ appPlugin: app, shell: { handleHash: async link => { calls.push(link); } }, env: {}, pageKind: 'shell', platform });
      await afterStart();
      app.emit('appUrlOpen', { url: 'plenum://app/#stop' });
      app.emit('appUrlOpen', { url: 'plenum://app/#approve=ap1&line=x' });
      app.emit('appUrlOpen', { url: 'plenum://pair#eyJ2IjoxfQ' });
      assert.deepEqual(calls, handled ? ['#deny=abc', '#stop', '#approve=ap1&line=x', 'plenum://pair#eyJ2IjoxfQ'] : ['plenum://pair#eyJ2IjoxfQ'], String(platform));
    }
  });

  it('after pairing, showUi is not called until releaseUi (the onboarding screens come first)', async () => {
    const rig = pairingRig();
    const calls = [];
    const uiHost = { kind: 'web', show: async args => { calls.push(['show', args.computerId]); return { ok: true, status: 'updated', navigated: true }; }, refresh: async () => ({ ok: true, changed: false, reload: false }), loadedHash: async () => null, hasCopy: async () => false, useCopy: async () => ({ ok: true }), openShell: async () => true };
    const shell = rig.shell({ uiHost });
    await shell.boot();
    const pairing = shell.pair(rig.link);
    assert.match(await rig.codeUp(shell.state), /^[0-9]{6}$/);
    rig.desktop.allow(rig.offer);
    assert.equal((await pairing).state, 'allowed');
    await waitFor(() => shell.state().hello, 8000);
    await settle(30);
    assert.deepEqual(calls, [], 'the page is not handed to the UI while the onboarding is open');
    shell.releaseUi();
    await waitFor(() => calls.length === 1, 4000);
    assert.equal(calls[0][1], shell.state().activeId, 'the UI is pulled for the computer the page is connected to');
  });
});

describe('one UI per computer (DQ2 condition b)', () => {
  const uiHostOf = (computerId, calls = []) => ({
    kind: 'web',
    calls,
    uiComputerId: async () => (typeof computerId === 'function' ? computerId() : computerId),
    show: async args => { calls.push(['show', args.computerId]); return { ok: true, status: 'updated', navigated: true }; },
    refresh: async args => { calls.push(['refresh', args.computerId]); return { ok: true, changed: false, reload: false }; },
    loadedHash: async () => 'h',
    hasCopy: async () => true,
    useCopy: async () => ({ ok: true }),
    openShell: async hash => { calls.push(['openShell', hash ?? '']); return true; },
  });

  it('a UI page holding the UI of computer A, with computer B saved, opens #connect=B and opens no channel', async () => {
    const calls = [];
    const k = await lockedStopRig({ pin: false, shell: { uiHost: uiHostOf('a'.repeat(64), calls), pageKind: 'ui' } });
    assert.deepEqual(calls.filter(c => c[0] === 'openShell'), [['openShell', `#connect=${k.id}`]], 'a page that holds the UI of another computer hands over to the shell page');
    assert.equal(k.shell.channel, null, 'no channel was opened under the wrong UI');
    assert.equal(k.desktop.stats.handshakes, 0);
    assert.equal(k.shell.state().connection.status, 'idle');
  });

  it('a UI page whose UI is the saved computer\'s (or any: the LAN page, the iPhone) connects as before', async () => {
    for (const [what, owner] of [['the same computer', null], ['any', 'any']]) {
      const calls = [];
      const net = createFakeNet();
      const clock = createFakeClock(0);
      const desktop = createFakeDesktop({ net });
      const phone = generateKeyPair();
      desktop.counters.set(deviceId(phone.publicKey), 0);
      const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
      const record = freshComputer(desktop, phone);
      await store.put(record);
      const shell = createShell({ store, createWorker: fakeWorkerFactory({ net, clock, store }), uiHost: uiHostOf(owner ?? record.id, calls), pageKind: 'ui', stopClock: createFakeClock(1) });
      await shell.boot();
      await waitFor(() => shell.state().hello, 8000);
      assert.equal(calls.some(c => c[0] === 'openShell'), false, what);
      assert.ok(calls.some(c => c[0] === 'refresh' && c[1] === record.id), `${what}: the refresh names the computer`);
    }
  });

  it('connect(id) on the UI page for another computer opens the shell page with #connect=<id> and connects nothing here', async () => {
    const calls = [];
    let owner = 'any';
    const k = await lockedStopRig({ pin: false, shell: { uiHost: uiHostOf(() => owner, calls), pageKind: 'ui' } });
    await waitFor(() => k.shell.state().hello, 8000);
    owner = k.id;
    const same = await k.shell.connect(k.id);
    assert.equal(same.ok, true);
    assert.notEqual(same.reason, 'opening', 'the UI is this computer\'s: it reconnects here');
    assert.deepEqual(calls.filter(c => c[0] === 'openShell'), []);
    const other = await k.shell.connect('b'.repeat(64));
    assert.deepEqual(other, { ok: true, reason: 'opening' });
    assert.deepEqual(calls.filter(c => c[0] === 'openShell'), [['openShell', `#connect=${'b'.repeat(64)}`]]);
  });

  it('on the shell page #connect=<id> connects that computer and pulls its UI even on /?shell; an unknown id does nothing; locked, it waits', async () => {
    const calls = [];
    const k = await lockedStopRig({ pin: false, shell: { uiHost: uiHostOf(null, calls), pageKind: 'shell', stay: true } });
    await waitFor(() => k.shell.state().hello, 8000);
    assert.equal(calls.some(c => c[0] === 'show'), false, 'a page opened for the shell\'s own screens does not leave for the UI');
    assert.deepEqual(await k.shell.handleHash(`#connect=${'c'.repeat(64)}`), { ok: false, reason: 'unknown', kind: 'connect' });
    assert.equal(calls.some(c => c[0] === 'show'), false);
    const out = await k.shell.handleHash(`#connect=${k.id}`);
    assert.equal(out.ok, true);
    assert.equal(out.kind, 'connect');
    await waitFor(() => calls.some(c => c[0] === 'show'), 8000);
    assert.deepEqual(calls.find(c => c[0] === 'show'), ['show', k.id], 'forced past ?shell, for this computer');
    // Not a UI-page thing, and not a notification link: a UI page ignores it.
    const ui = await lockedStopRig({ pin: false, shell: { uiHost: uiHostOf('any'), pageKind: 'ui' } });
    assert.equal((await ui.shell.handleHash(`#connect=${ui.id}`)).reason, 'no link');
    // Behind the lock it is parked like #settings.
    const locked = await lockedStopRig({ shell: { uiHost: uiHostOf(null), pageKind: 'shell' } });
    assert.equal((await locked.shell.handleHash(`#connect=${locked.id}`)).reason, 'locked');
    assert.equal((await locked.shell.unlock('pin', '123456')).ok, true);
    await waitFor(() => locked.shell.state().hello, 8000);
    assert.equal(locked.shell.state().activeId, locked.id);
  });
});

describe('notification answers expire; the lock-off opt-out is retried (S10)', () => {
  it('an approve link older than 60 s is dropped at the unlock with the notice and opens the card; a fresh one is sent', async () => {
    const k = await connectedShell({ withLock: true });
    assert.equal((await k.shell.setPin('123456')).ok, true);
    await k.shell.lockNow();
    const parked = await k.shell.handleHash('#approve=ap1&line=Run%3A%20x');
    assert.equal(parked.reason, 'locked');
    k.wall.advance(61_000);
    assert.equal((await k.shell.unlock('pin', '123456')).ok, true);
    await settle(30);
    assert.equal(k.desktop.stats.approvals.length, 0, 'nothing was sent');
    assert.equal(k.shell.state().notice.text, NOTIFICATION_OLD);
    assert.equal(k.shell.state().notice.text, 'That notification is more than a minute old. Open the approval to answer it.');
    assert.equal(k.shell.state().intent.kind, 'waiting');
    assert.equal(k.shell.state().intent.id, 'ap1');
    // Within a minute it is sent, and a Stop or a deny that waits longer is not dropped silently: Stop is kept, a deny expires like an approve.
    await k.shell.lockNow();
    await k.shell.handleHash('#approve=ap2&line=Run%3A%20y');
    k.wall.advance(30_000);
    assert.equal((await k.shell.unlock('pin', '123456')).ok, true);
    await waitFor(() => k.desktop.stats.approvals.length === 1, 8000);
    assert.equal(k.desktop.stats.approvals[0].approvalId, 'ap2');
    await k.shell.lockNow();
    await k.shell.handleHash('#deny=ap3');
    k.wall.advance(61_000);
    await k.shell.unlock('pin', '123456');
    await settle(30);
    assert.equal(k.desktop.stats.approvals.length, 1, 'an old deny is dropped too');
  });

  it('lock off while the computer cannot be reached keeps the opt-out and sends it at the next HELLO', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const wall = createFakeClock(1_000_000);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(freshComputer(desktop, phone));
    await store.meta.put('approve', true);
    await store.meta.put('active', deviceId(desktop.keys.publicKey));
    const lock = createLock({ store, now: () => wall.now(), iterations: 2000 });
    await lock.setPin('123456');
    const shell = createShell({ store, lock, createWorker: fakeWorkerFactory({ net, clock, store }), caps: ['ui-from-desktop'], stopClock: wall });
    await shell.boot();
    assert.equal((await shell.unlock('pin', '123456')).ok, true);
    await waitFor(() => shell.state().hello, 8000);
    assert.equal(shell.state().approveStored, true);
    desktop.killAll();
    await settle();
    const before = desktop.stats.pushes.length;
    const off = await shell.lockOff('123456');
    assert.equal(off.ok, true);
    assert.equal(await store.meta.get('approve-off-pending'), true, 'the opt-out is remembered');
    assert.equal(shell.state().approveStored, true, 'and not yet told');
    assert.equal(desktop.stats.pushes.length, before);
    desktop.comeBack();
    await walk(clock, 20_000);
    await waitFor(() => desktop.stats.pushes.some(p => p.approveFromNotifications === false), 8000);
    await until(async () => (await store.meta.get('approve-off-pending')) === undefined, 'the flag to go', 4000);
    assert.equal(shell.state().approveStored, false);
  });
});

describe('the console, the link store and the storage notice (SL3, SL6)', () => {
  it('redactLine masks standard base64, byte lists and stopKey=', () => {
    const b64 = Buffer.from(new Uint8Array(40).map((_, i) => 250 - i * 3)).toString('base64');
    const std = `key bytes: Q${'+/'.repeat(25)}xyz and more`;
    assert.equal(redactLine(`got ${std}`).includes('+/+/+/'), false);
    assert.equal(redactLine(`stopKey=${b64}`), 'stopKey=[redacted]');
    assert.equal(redactLine('bytes [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]'), 'bytes [redacted-bytes]');
    assert.equal(redactLine('raw 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17 end'), 'raw [redacted-bytes] end');
    assert.equal(redactLine('myDeviceId: ' + 'ab'.repeat(32)), 'myDeviceId=[redacted]');
    assert.equal(redactLine('handshakeHash=zz pushKey: yy desktopPub = xx key=1'), 'handshakeHash=[redacted] pushKey=[redacted] desktopPub=[redacted] key=[redacted]');
    assert.equal(redactLine('channel: connect failed (timeout)'), 'channel: connect failed (timeout)', 'plain lines are left alone');
    assert.equal(redactLine('[1, 2, 3]'), '[1, 2, 3]', 'a short list is not bytes');
  });

  it('the shim\'s debug(line) reaches the computer redacted, through the shell scope', async () => {
    const k = await connectedShell();
    const facade = makeFacade(k.shell, null);
    const secret = 'Zy9Xw8Vu'.repeat(8);
    facade.log(`phone saw stopKey=${secret} and ${secret}`);
    await waitFor(() => k.desktop.stats.logs.length === 1, 4000);
    assert.equal(k.desktop.stats.logs[0].includes(secret), false);
    assert.match(k.desktop.stats.logs[0], /^phone saw stopKey=\[redacted\] and \[redacted\]$/);
    assert.ok(k.shell.debug.lines().some(l => l.level === 'page' && l.text.includes('[redacted]')), 'and it is in the phone console too');
    // No channel: the line is kept on the phone, nothing is posted, nothing throws.
    const away = createShell({ store: createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) }), createWorker: () => { throw new Error('no worker'); } });
    assert.equal(away.pageLog('hello'), true);
    assert.equal(away.pageLog(''), false);
  });

  it('storage is ok when the plugins loaded', async () => {
    const { env } = pageEnv({ Capacitor: NATIVE, androidBridge: {} });
    const shell = await startShell(env, { loadPlugins: async () => ({ secureStorage: fakeSecureStorage(), App: null }) });
    assert.equal(shell.state().storage, 'ok');
    assert.equal(shell.state().lock.mode, 'off');
    assert.equal(shell.debug.lines().some(l => l.text === 'storage: unavailable'), false);
  });

  it('after setPin, connect(id) works without a lock and unlock', async () => {
    const k = await connectedShell({ withLock: true });
    assert.equal((await k.shell.setPin('123456')).ok, true);
    const wrapped = await k.store.get(k.id);
    assert.equal(typeof wrapped.myPriv, 'object', 'the record is wrapped now');
    const out = await k.shell.connect(k.id);
    assert.equal(out.ok, true);
    await waitFor(() => k.shell.state().connection.status === 'connected', 8000);
    assert.equal(k.shell.state().locked, false);
  });

  it('the link store keeps a link for two minutes, hands it out once, and gives nothing for a damaged entry', async () => {
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    let now = 1000;
    const links = createLinkStore(store.meta, () => now);
    assert.equal(await links.take(), null);
    await links.put('plenum://pair#abc');
    assert.equal(await links.take(), 'plenum://pair#abc');
    assert.equal(await links.take(), null, 'once');
    await links.put('#settings');
    now += 119_999;
    assert.equal(await links.take(), '#settings');
    await links.put('#settings');
    now += 120_000;
    assert.equal(await links.take(), null, 'two minutes old');
    await store.meta.put('shell-link', 'garbage');
    assert.equal(await links.take(), null);
    await links.put('x'.repeat(20_000));
    assert.equal((await links.take()).length, 8192, 'capped');
  });
});

// ----- bug hunt 0.6, the phone shell (fix06 mobile-shell): B-117, B-118, B-119, B-120, B-121, B-122, B-124, B-125, B-128, B-130, B-131 -----

// A phone paired with two computers, Home PC and Work laptop. open: which one the phone has open (0 or 1). keys: whether the record holds that
// computer's Stop key. pin: the app is locked with a PIN. shell: createShell options, or a function of the two record ids. The fake net is shared;
// down(url) and up(url) take one computer away and bring it back.
async function twoComputers({ keys = [true, true], open = 0, pin = false, shell: shellOptions = {} } = {}) {
  const net = createFakeNet();
  const accepts = new Map();
  const listen = net.listen;
  net.listen = (url, accept) => {
    accepts.set(url, accept);
    listen(url, accept);
  };
  const clock = createFakeClock(0);
  const wall = createFakeClock(1_000_000);
  const names = ['Home PC', 'Work laptop'];
  const urls = ['ws://home-pc.local/b/key', 'ws://work-laptop.local/b/key'];
  const desktops = names.map((name, i) => createFakeDesktop({ net, url: urls[i], name }));
  const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const phone = generateKeyPair();
    desktops[i].counters.set(deviceId(phone.publicKey), 0);
    const record = keys[i] ? recordWithStopKey(desktops[i], phone) : freshComputer(desktops[i], phone);
    await store.put({ ...record, name: names[i] });
    ids.push(record.id);
  }
  await store.meta.put('active', ids[open]);
  const lock = pin ? createLock({ store, now: () => wall.now(), iterations: 2000 }) : null;
  if (lock) await lock.setPin('123456');
  const workers = [];
  const make = fakeWorkerFactory({ net, clock, store });
  const shell = createShell({
    store,
    lock,
    createWorker: () => {
      const worker = make();
      workers.push(worker);
      return worker;
    },
    device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
    caps: ['ui-from-desktop'],
    stopClock: wall,
    ...(typeof shellOptions === 'function' ? shellOptions(ids) : shellOptions),
  });
  return {
    net, clock, wall, store, shell, lock, ids, workers, names, urls,
    a: { id: ids[0], url: urls[0], desktop: desktops[0] },
    b: { id: ids[1], url: urls[1], desktop: desktops[1] },
    down: url => { net.unlisten(url); net.dropAll('away'); },
    up: url => net.listen(url, accepts.get(url)),
    async start() {
      await shell.start();
      if (!pin) await waitFor(() => shell.state().hello, 8000);
    },
  };
}

// The notification the computer `from` sends for an approval card, shown by the service worker and clicked there (action: 'stop', 'deny', 'approve' or '');
// the page the click reaches runs what the worker tells it. Resolves what the page answered.
async function clickNotification(k, from, action, { cold = null } = {}) {
  const built = buildPushText(
    { kind: 'approval', approvalId: 'ap-1', projectId: 'p1', projectName: 'Website', count: 1, firstLine: 'Run: npm test' },
    { prefs: { firstLine: true }, device: { tier: 'full', approveFromNotifications: true }, computer: { id: from.id, name: 'Computer' } },
  );
  const shown = [];
  await showPush({ data: { json: () => built.payload } }, { registration: { showNotification: async (title, options) => { shown.push(options); } }, maxActions: 3 });
  const answers = [];
  const messages = [];
  const client = { focus: async () => {}, postMessage: msg => { messages.push(msg); answers.push(k.shell.handleHash(msg.hash, msg.computer)); } };
  const opened = [];
  const clients = { matchAll: async () => (cold ? [] : [client]), openWindow: async url => { opened.push(url); } };
  await openFromNotification({ action, notification: { data: shown[0].data, close() {} } }, { clients, scope: '/' });
  return { answers: await Promise.all(answers), messages, opened, data: shown[0].data };
}

describe('B-117: Stop all, Deny and Approve from a notification act on the computer that sent it', () => {
  it('the service worker keeps the computer, tells the page which one, and a cold start opens the action with it (record ids only)', async () => {
    const id = 'ab'.repeat(32);
    const k = { shell: { handleHash: async () => ({}) } };
    const warm = await clickNotification(k, { id }, 'stop');
    assert.equal(warm.data.computer, id, 'the notification data names the computer');
    assert.deepEqual(warm.messages, [{ op: 'plenum-hash', hash: '#stop', computer: id }]);
    const cold = action => clickNotification(k, { id }, action, { cold: true }).then(r => r.opened[0]);
    assert.equal(await cold('stop'), `/#stop&computer=${id}`);
    assert.equal(await cold('deny'), `/#deny=ap-1&computer=${id}`);
    assert.equal(await cold('approve'), `/#approve=ap-1&line=${encodeURIComponent('Run: npm test')}&computer=${id}`);
    assert.equal(await cold(''), '/#waiting=ap-1', 'a tap is a place, not an action on a computer');
    // An older computer sends its own short id: the notification keeps it, the cold start link does not carry what the phone cannot match.
    assert.equal((await clickNotification(k, { id: 'f'.repeat(16) }, 'stop', { cold: true })).opened[0], '/#stop');
  });

  it('parseNotificationHash reads &computer=<id> after any link, and a link without it has no computer', () => {
    const id = 'cd'.repeat(32);
    assert.deepEqual(parseNotificationHash(`#stop&computer=${id}`), { kind: 'stop', computer: id });
    assert.deepEqual(parseNotificationHash(`#deny=ap-1&computer=${id}`), { kind: 'deny', id: 'ap-1', computer: id });
    assert.deepEqual(parseNotificationHash(`#approve=ap-1&line=${encodeURIComponent('Run: x')}&computer=${id}`), { kind: 'approve', id: 'ap-1', line: 'Run: x', computer: id });
    assert.deepEqual(parseNotificationHash('#stop'), { kind: 'stop' });
    assert.equal(parseNotificationHash(`#nothing&computer=${id}`), null);
  });

  it('Stop all from the other computer\'s notification stops that computer and only that one, and the open computer keeps its connection', async () => {
    const k = await twoComputers();
    await k.start();
    const { answers } = await clickNotification(k, k.b, 'stop');
    assert.equal(answers[0].state, 'done');
    assert.match(answers[0].text, /Work laptop/);
    assert.equal(k.b.desktop.stats.stopOnly.length, 1, 'Work laptop got the Stop');
    assert.equal(k.a.desktop.stats.stopOnly.length + k.a.desktop.stats.stops, 0, 'Home PC got none');
    assert.equal(k.shell.state().activeId, k.a.id, 'the open computer is still Home PC');
    assert.equal(k.shell.state().connection.status, 'connected');
  });

  it('and the other way round: Home PC\'s notification while Work laptop is open', async () => {
    const k = await twoComputers({ open: 1 });
    await k.start();
    assert.equal(k.shell.state().activeId, k.b.id);
    const { answers } = await clickNotification(k, k.a, 'stop');
    assert.equal(answers[0].state, 'done');
    assert.equal(k.a.desktop.stats.stopOnly.length, 1);
    assert.equal(k.b.desktop.stats.stopOnly.length + k.b.desktop.stats.stops, 0);
  });

  it('a computer whose Stop key this phone does not hold is opened and stopped on its own channel; the other computer gets nothing', async () => {
    const k = await twoComputers({ keys: [true, false] });
    await k.start();
    const { answers } = await clickNotification(k, k.b, 'stop');
    assert.equal(answers[0].state, 'done');
    assert.equal(k.b.desktop.stats.stops, 1);
    assert.equal(k.a.desktop.stats.stops + k.a.desktop.stats.stopOnly.length, 0);
    assert.equal(k.shell.state().activeId, k.b.id, 'Work laptop is the open computer now');
  });

  it('Deny and Approve are answered on the computer whose card it is, with the first line, and never on the open one', async () => {
    const k = await twoComputers();
    await k.start();
    const denied = await clickNotification(k, k.b, 'deny');
    assert.equal(denied.answers[0].ok, true);
    assert.deepEqual(k.b.desktop.stats.approvals, [{ approvalId: 'ap-1', allow: false, line: null }]);
    assert.deepEqual(k.a.desktop.stats.approvals, []);
    assert.equal(k.shell.state().activeId, k.b.id);
    const approved = await clickNotification(k, k.a, 'approve');
    assert.equal(approved.answers[0].ok, true);
    assert.deepEqual(k.a.desktop.stats.approvals, [{ approvalId: 'ap-1', allow: true, line: 'Run: npm test' }]);
    assert.equal(k.b.desktop.stats.approvals.length, 1, 'Work laptop heard only its own');
  });

  it('while the app is locked a Stop from the other computer still goes out at once to that computer, and a computer with no key waits for the unlock with its name kept', async () => {
    const k = await twoComputers({ pin: true });
    await k.start();
    assert.equal(k.shell.state().route, 'locked');
    const { answers } = await clickNotification(k, k.b, 'stop');
    assert.equal(answers[0].state, 'done');
    assert.equal(k.b.desktop.stats.stopOnly.length, 1);
    assert.equal(k.a.desktop.stats.stopOnly.length, 0);
    assert.equal(k.shell.state().route, 'locked', 'the lock stayed on');
    const waiting = await twoComputers({ keys: [true, false], pin: true });
    await waiting.start();
    const parked = await clickNotification(waiting, waiting.b, 'stop');
    assert.equal(parked.answers[0].reason, 'needs-unlock');
    assert.equal(waiting.b.desktop.stats.stops + waiting.b.desktop.stats.stopOnly.length, 0);
    assert.equal((await waiting.shell.unlock('pin', '123456')).ok, true);
    await waitFor(() => waiting.b.desktop.stats.stops === 1, 8000);
    assert.equal(waiting.a.desktop.stats.stops + waiting.a.desktop.stats.stopOnly.length, 0, 'the unlock sent the Stop to Work laptop, not to Home PC');
  });

  it('a cold start from the notification (the address ends in &computer=<id>) stops that computer', async () => {
    const k = await twoComputers({ shell: ids => ({ pageUrl: `https://phone.example/#stop&computer=${ids[1]}` }) });
    await k.start();
    await waitFor(() => k.b.desktop.stats.stopOnly.length === 1, 8000);
    assert.equal(k.a.desktop.stats.stopOnly.length + k.a.desktop.stats.stops, 0);
  });

  it('Android: the local notification carries the computer, and its action reaches that computer', async () => {
    const k = await twoComputers();
    await k.start();
    const built = buildPushText({ kind: 'approval', approvalId: 'ap-1', projectId: 'p1', count: 1, firstLine: 'Run: npm test' }, { prefs: { firstLine: true }, device: { tier: 'full', approveFromNotifications: true }, computer: { id: k.b.id, name: 'Work laptop' } });
    const note = notificationFor(parsePushPayload(built.payload));
    assert.equal(note.extra.computer, k.b.id);
    const running = [];
    const push = createAndroidPush({ native: { UnifiedPush: {}, LocalNotifications: {} }, requestOf: () => null, onLink: (link, computer) => running.push(k.shell.handleHash(link, computer)) });
    push.handlers.onAction({ actionId: 'stop', notification: { extra: note.extra } });
    push.handlers.onAction({ actionId: 'tap', notification: { extra: note.extra } });
    const [stopped] = await Promise.all(running);
    assert.equal(stopped.state, 'done');
    assert.equal(k.b.desktop.stats.stopOnly.length, 1);
    assert.equal(k.a.desktop.stats.stopOnly.length, 0);
  });

  it('a computer this phone does not know is refused with its own words and nothing is sent; an older computer\'s short id acts on the open one as before', async () => {
    const k = await twoComputers();
    await k.start();
    const stranger = 'ab'.repeat(32);
    const stop = await k.shell.handleHash('#stop', stranger);
    assert.deepEqual([stop.ok, stop.reason], [false, 'unknown-computer']);
    assert.equal(k.shell.state().notice.text, app.UNKNOWN_COMPUTER_STOP);
    const deny = await k.shell.handleHash('#deny=ap-1', stranger);
    assert.deepEqual([deny.ok, deny.reason], [false, 'unknown-computer']);
    assert.equal(k.shell.state().notice.text, app.UNKNOWN_COMPUTER);
    const approve = await k.shell.handleHash(`#approve=ap-1&line=${encodeURIComponent('Run: npm test')}`, stranger);
    assert.equal(approve.reason, 'unknown-computer');
    for (const side of [k.a, k.b]) {
      assert.equal(side.desktop.stats.stops + side.desktop.stats.stopOnly.length, 0);
      assert.deepEqual(side.desktop.stats.approvals, []);
    }
    assert.equal(k.shell.state().activeId, k.a.id);
    const legacy = await k.shell.handleHash('#stop', 'f'.repeat(16));
    assert.equal(legacy.state, 'done');
    assert.equal(k.a.desktop.stats.stops, 1, 'the short id names nothing the phone can match: the open computer');
    assert.equal(k.b.desktop.stats.stops + k.b.desktop.stats.stopOnly.length, 0);
  });

  it('the UI page hands a Deny for another computer to the shell page with the computer in the link, and connects nothing itself', async () => {
    const opened = [];
    const uiHost = {
      kind: 'web',
      uiComputerId: async () => 'someone-else',
      show: async () => ({ ok: true }),
      refresh: async () => ({ ok: true, changed: false, reload: false }),
      loadedHash: async () => null,
      hasCopy: async () => false,
      useCopy: async () => ({ ok: true }),
      openShell: async hash => { opened.push(hash); return true; },
    };
    const k = await twoComputers({ shell: { pageKind: 'ui', uiHost } });
    await k.shell.boot();
    k.shell.state();
    const out = await k.shell.handleHash('#deny=ap-1', k.b.id);
    assert.equal(out.opening, true);
    assert.deepEqual(opened.filter(h => h.startsWith('#deny')), [`#deny=ap-1&computer=${k.b.id}`]);
    assert.equal(k.b.desktop.stats.approvals.length + k.a.desktop.stats.approvals.length, 0, 'nothing was answered on this page');
  });
});

describe('B-119: a retired channel does not speak for the open one, and its Stop still reports', () => {
  it('after a switch, the retired computer\'s retries leave the open computer\'s connection and HELLO alone, and its queued Stop reports when it gets through', async () => {
    const k = await twoComputers();
    await k.start();
    k.down(k.a.url);
    await settle();
    const pressed = k.shell.stop();
    await settle();
    assert.equal(k.shell.state().stop.state, 'queued', 'the Stop waits for Home PC');
    assert.equal((await k.shell.connect(k.b.id)).ok, true);
    await waitFor(() => k.shell.state().hello?.desktopName === 'Work laptop', 8000);
    assert.equal(k.shell.state().stop.state, 'queued', 'the new channel\'s idle Stop does not replace the one that is waiting');
    // Home PC\'s retired channel keeps trying for a minute; none of it is the open connection.
    await walk(k.clock, 15_000);
    const s = k.shell.state();
    assert.equal(s.connection.status, 'connected');
    assert.equal(s.connection.desktopName, 'Work laptop');
    assert.equal(s.hello?.desktopName, 'Work laptop');
    k.up(k.a.url);
    await walk(k.clock, 20_000);
    assert.equal(k.a.desktop.stats.stops, 1, 'the Stop reached Home PC');
    assert.equal(k.shell.state().connection.desktopName, 'Work laptop', 'and Home PC\'s hello did not take over the connection');
    assert.equal(k.shell.state().stop.state, 'done');
    assert.match(k.shell.state().notice.text, /Home PC/);
    void pressed;
  });

  it('two connects that overlap open one channel, the later one; the earlier answers superseded and leaves no worker behind', async () => {
    const k = await twoComputers();
    await k.shell.boot();
    const before = k.workers.length;
    const [first, second] = await Promise.all([k.shell.connect(k.a.id), k.shell.connect(k.b.id)]);
    assert.deepEqual([first.ok, first.reason], [false, 'superseded']);
    assert.equal(second.ok, true);
    assert.equal(k.workers.length - before, 1, 'one worker for the two calls');
    assert.equal(k.shell.state().activeId, k.b.id);
  });

  it('lockNow marks the connection closed itself, since the retired channel no longer reports', async () => {
    const k = await connectedShell({ withLock: true });
    await k.shell.setPin('123456');
    assert.equal((await k.shell.lockNow()).ok, true);
    assert.equal(k.shell.state().connection.status, 'closed');
  });
});

describe('B-120: a Stop that is queued on the UI page goes with the page to the shell page', () => {
  const lanEnv = assigned => ({
    location: { href: 'http://192.168.1.5:7300/', pathname: '/', search: '', assign: url => assigned.push(url), replace: () => {} },
  });
  async function leave({ waitMs = 10_000 } = {}) {
    const net = createFakeNet();
    const clock1 = createFakeClock(0);
    const clock2 = createFakeClock(0);
    const wall = createFakeClock(1_000_000);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(freshComputer(desktop, phone, { counter: 0 }));
    const assigned = [];
    const parkedStop = app.createParkedStop(store.meta, () => wall.now());
    let ui = null;
    const uiHost = createUiHost({
      env: lanEnv(assigned),
      kind: 'lan',
      channelOf: () => ui?.channel ?? null,
      stopHandoff: { pending: () => ui?.pendingStop?.() ?? null, park: pending => parkedStop.put(pending), unpark: () => parkedStop.unpark() },
    });
    ui = createShell({
      store,
      createWorker: fakeWorkerFactory({ net, clock: clock1, store }),
      device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
      caps: ['ui-from-desktop'],
      stopClock: wall,
      pageKind: 'ui',
      uiHost,
      parkedStop,
    });
    desktop.killAll();
    await ui.start();
    const pressed = ui.stop();
    await settle();
    assert.equal(ui.state().stop.state, 'queued', 'the Stop waits for the computer');
    wall.advance(waitMs);
    await ui.openShell('#computers');
    void pressed;
    // The page is gone: the new page has its own worker and clock, and nothing of the old one runs.
    const page = createShell({
      store,
      createWorker: fakeWorkerFactory({ net, clock: clock2, store }),
      device: { name: 'Test phone', platform: 'web', app: 'pwa', appVersion: '1', uiHash: '' },
      caps: ['ui-from-desktop'],
      stopClock: wall,
      pageUrl: 'http://192.168.1.5:7300/?shell#computers',
      parkedStop,
    });
    return { desktop, store, assigned, page, clock2, wall, net };
  }

  it('the shell page sends the Stop the UI page left, to the computer it was pressed for, when it is under a minute old', async () => {
    const k = await leave();
    assert.deepEqual(k.assigned, ['/?shell#computers']);
    const note = await k.store.meta.get('pending-stop');
    assert.equal(note.computer, deviceId(k.desktop.keys.publicKey));
    k.desktop.comeBack();
    await k.page.start();
    await waitFor(() => k.desktop.stats.stops === 1, 8000);
    assert.equal(await k.store.meta.get('pending-stop'), undefined, 'the note is taken out once');
  });

  it('a Stop that is older than a minute is not sent by the next page', async () => {
    const k = await leave({ waitMs: 61_000 });
    k.desktop.comeBack();
    await k.page.start();
    await settle(50);
    assert.equal(k.desktop.stats.stops, 0);
    assert.equal(await k.store.meta.get('pending-stop'), undefined);
  });

  it('a UI page with no Stop pending leaves nothing behind', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const wall = createFakeClock(1_000_000);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(freshComputer(desktop, phone, { counter: 0 }));
    const assigned = [];
    const parkedStop = app.createParkedStop(store.meta, () => wall.now());
    let ui = null;
    const uiHost = createUiHost({ env: lanEnv(assigned), kind: 'lan', channelOf: () => ui?.channel ?? null, stopHandoff: { pending: () => ui?.pendingStop?.() ?? null, park: p => parkedStop.put(p), unpark: () => parkedStop.unpark() } });
    ui = createShell({ store, createWorker: fakeWorkerFactory({ net, clock, store }), stopClock: wall, pageKind: 'ui', uiHost, parkedStop });
    await ui.start();
    await waitFor(() => ui.state().hello, 8000);
    await ui.openShell('#settings');
    assert.deepEqual(assigned, ['/?shell#settings']);
    assert.equal(await store.meta.get('pending-stop'), undefined);
  });
});

describe('B-130: a lock that cannot be read and a Stop key that cannot be read leave no promise of a Stop', () => {
  async function unreadableLock({ withKey }) {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(withKey ? recordWithStopKey(desktop, phone) : freshComputer(desktop, phone));
    const unreadable = { lockOnLaunch: async () => { throw new Error('lock record unreadable'); }, status: async () => { throw new Error('lock record unreadable'); }, lock() {}, protect: async r => r };
    const shell = createShell({ store, lock: unreadable, createWorker: fakeWorkerFactory({ net, clock, store }), stopClock: createFakeClock(5) });
    await shell.boot();
    return { shell, desktop };
  }

  it('without a Stop key the phone says it cannot send Stop, parks nothing and sends nothing', async () => {
    const k = await unreadableLock({ withKey: false });
    assert.equal(k.shell.state().lock.mode, 'unknown');
    assert.equal(k.shell.state().lockStop.ready, false);
    const out = await k.shell.stop();
    assert.equal(out.reason, 'no-key');
    assert.equal(k.shell.state().notice.text, app.STOP_NO_KEY);
    assert.doesNotMatch(app.STOP_NO_KEY, /Unlock/);
    const link = await k.shell.handleHash('#stop');
    assert.equal(link.reason, 'no-key', 'a Stop from a notification says the same');
    assert.equal(k.desktop.stats.stopOnly.length + k.desktop.stats.stops, 0);
  });

  it('with a Stop key it still goes out, as before', async () => {
    const k = await unreadableLock({ withKey: true });
    assert.equal(k.shell.state().lockStop.ready, true);
    const out = await k.shell.stop();
    assert.equal(out.state, 'done');
    assert.equal(k.desktop.stats.stopOnly.length, 1);
  });
});

describe('B-121: a phone the computer does not know is shown the revoked screen, and a UI page hands over to it', () => {
  it('not-known routes to the revoked screen on the shell page', () => {
    const state = { computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'not-known' } };
    assert.equal(screenFor(state, {}), 'revoked');
    assert.equal(screenFor({ ...state, connection: { status: 'reconnecting' } }, {}), 'connecting', 'a plain reconnect is still the connecting screen');
  });

  it('a UI page whose phone the computer does not know goes to the shell page, which has the screen', async () => {
    const opened = [];
    const uiHost = { kind: 'web', openShell: async hash => { opened.push(hash ?? ''); return true; }, uiComputerId: async () => 'any', show: async () => ({ ok: true }), refresh: async () => ({ ok: true, changed: false, reload: false }), loadedHash: async () => null, hasCopy: async () => false, useCopy: async () => ({ ok: true }) };
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    // The computer has no record of this phone (it was removed there): every try is answered 4401.
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(freshComputer(desktop, phone, { counter: 0 }));
    const shell = createShell({ store, createWorker: fakeWorkerFactory({ net, clock, store }), stopClock: createFakeClock(5), pageKind: 'ui', uiHost });
    await shell.start();
    await walk(clock, 10_000);
    await waitFor(() => shell.state().connection.status === 'not-known', 8000);
    await waitFor(() => opened.length > 0, 8000);
    assert.deepEqual(opened, [''], 'the UI page handed over to the shell page');
  });
});

describe('B-122: the ways HELLO lists are kept, so a way turned on after pairing is used', () => {
  const RELAY = 'wss://relay.example/b/key';
  it('a HELLO with ways the record does not hold gives one carriers patch, and the next round dials the learned address', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, carriers: [{ kind: 'lan', url: 'ws://fake-pc.local/b/key' }, { kind: 'relay', url: RELAY }, { kind: 'relay', url: 'ws://insecure.example/b/key' }, { kind: 'lan', url: 'ws://8.8.8.8/b/key' }] });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    const patches = rig.messages.filter(m => m.op === 'patch' && m.patch.carriers);
    assert.equal(patches.length, 1, 'one patch');
    assert.deepEqual(patches[0].patch.carriers, [{ kind: 'lan', urls: [desktop.url] }, { kind: 'relay', urls: [RELAY] }], 'only addresses that pass the carrier rules, the record\'s own order first');
    assert.equal(JSON.stringify(patches).includes('8.8.8.8'), false, 'a public LAN address is not learned');
    // The computer goes away: the next rounds dial the relay address the phone learned.
    desktop.killAll();
    await settle();
    await walk(clock, 5000);
    assert.ok(rig.dials.some(d => d.url === RELAY), 'the relay address was dialled');
    // Connecting again with the same ways sends no second patch.
    desktop.comeBack();
    await walk(clock, 15_000);
    assert.equal(rig.core.phase, 'connected');
    assert.equal(rig.messages.filter(m => m.op === 'patch' && m.patch.carriers).length, 1, 'the same ways are not patched again');
  });

  it('a HELLO that lists nothing, or only ways that fail the carrier rules, changes nothing', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, carriers: [{ kind: 'relay', url: 'ws://insecure.example/b/key' }] });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.messages.filter(m => m.op === 'patch' && m.patch.carriers).length, 0);
  });

  it('the shell reads the record again at HELLO, so the Ways screen shows what was learned', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, carriers: [{ kind: 'lan', url: 'ws://fake-pc.local/b/key' }, { kind: 'relay', url: RELAY }] });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const store = createStore({ kv: createIdbKv({ indexedDB: createFakeIndexedDB() }) });
    await store.put(freshComputer(desktop, phone));
    const shell = createShell({ store, createWorker: fakeWorkerFactory({ net, clock, store }), stopClock: createFakeClock(5) });
    await shell.start();
    await waitFor(() => shell.state().hello, 8000);
    await waitFor(() => shell.state().computers[0].carriers.some(c => c.kind === 'relay'), 8000);
    assert.deepEqual(shell.state().computers[0].carriers.map(c => c.kind), ['lan', 'relay']);
  });
});

describe('B-118: reconnect and Stop check a session that is up', () => {
  const silent = ws => {
    ws.send = () => {};
    ws.deliver = () => {};
  };
  async function rigWithSockets() {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const sockets = [];
    const Capturing = class extends net.WebSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    };
    const rig = coreRig({ net: { WebSocket: Capturing }, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    return { rig, desktop, clock, sockets };
  }

  it('a session that died without a close is closed after PROBE_MS, the phone dials again at once, and the Stop pressed meanwhile is answered', async () => {
    const { rig, desktop, clock, sockets } = await rigWithSockets();
    clock.advance(2000);
    await settle();
    silent(sockets.at(-1));
    const dialled = rig.dials.length;
    rig.core.handle({ op: 'reconnect' });
    rig.core.handle({ op: 'stop', sid: 3, project: null });
    await settle();
    assert.equal(rig.core.phase, 'connected', 'nothing says the session is dead yet');
    for (let t = 0; t < workerMod.PROBE_MS + 1000; t += 500) {
      clock.advance(500);
      await settle();
    }
    assert.ok(rig.dials.length > dialled, 'the phone dialled again');
    assert.ok(rig.last('stopAck')?.ack?.id, 'the Stop was answered');
    assert.equal(desktop.stats.stops, 1, 'once, on the new session');
    assert.equal(rig.core.phase, 'connected');
  });

  it('a healthy session answers the probe and is left alone', async () => {
    const { rig, clock } = await rigWithSockets();
    const dialled = rig.dials.length;
    const session = rig.core.session;
    rig.core.handle({ op: 'reconnect' });
    for (let t = 0; t < workerMod.PROBE_MS + 1000; t += 500) {
      clock.advance(500);
      await settle();
    }
    assert.equal(rig.dials.length, dialled, 'no new dial');
    assert.equal(rig.core.session, session, 'the same session');
    assert.equal(rig.core.phase, 'connected');
  });
});

describe('B-124: the relay\'s 4001 (the computer is not connected to it) is asleep', () => {
  const RELAY = 'wss://relay.example/b/key';
  // A relay with no computer behind it: it accepts the upgrade and closes the socket 4001 host-offline.
  const sleepyRelay = (net, url) => net.listen(url, ws => {
    ws.dropFromDesktop(4001, 'host-offline');
    return { gone() {}, onMessage() {} };
  });

  it('every try ending in 4001 shows asleep, it stays asleep and not offline, and the phone connects once the computer is back', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const real = [];
    const listen = net.listen;
    net.listen = (url, accept) => {
      real.push([url, accept]);
      listen(url, accept);
    };
    const desktop = createFakeDesktop({ net, url: RELAY, carrier: 'relay' });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    net.unlisten(RELAY);
    net.listen = listen;
    sleepyRelay(net, RELAY);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone, { carriers: [{ kind: 'relay', urls: [RELAY] }] }) });
    rig.init();
    await settle();
    await walk(clock, 3000);
    assert.equal(rig.core.phase, 'asleep');
    assert.equal(rig.last('state').state.failure, 'host-offline');
    await walk(clock, 30_000);
    assert.equal(rig.core.phase, 'asleep', 'it stays asleep, it is not offline');
    net.unlisten(RELAY);
    net.listen(RELAY, real[0][1]);
    await walk(clock, 12_000);
    assert.equal(rig.core.phase, 'connected');
  });

  it('the LAN refused and the relay at 4001 is asleep too (LAN plus relay is the normal set of ways)', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net, url: 'ws://fake-pc.local/b/key' });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    net.unlisten('ws://fake-pc.local/b/key');
    sleepyRelay(net, RELAY);
    const rig = coreRig({ net, clock, computer: coreComputer(desktop, phone, { carriers: [{ kind: 'lan', urls: ['ws://fake-pc.local/b/key'] }, { kind: 'relay', urls: [RELAY] }] }) });
    rig.init();
    await settle();
    await walk(clock, 3000);
    assert.equal(rig.core.phase, 'asleep');
  });

  it('a session that was up and is closed with 4001 is asleep', async () => {
    const net = createFakeNet();
    const clock = createFakeClock(0);
    const desktop = createFakeDesktop({ net });
    const phone = generateKeyPair();
    desktop.counters.set(deviceId(phone.publicKey), 0);
    const sockets = [];
    const Capturing = class extends net.WebSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    };
    const rig = coreRig({ net: { WebSocket: Capturing }, clock, computer: coreComputer(desktop, phone) });
    rig.init();
    await settle();
    assert.equal(rig.core.phase, 'connected');
    sockets.at(-1).dropFromDesktop(4001, 'host-offline');
    await settle();
    assert.equal(rig.core.phase, 'asleep');
  });
});

describe('B-125: a tier the computer changes reaches the HELLO the screens read', () => {
  it('a tier event for this phone moves the tier and the caps in the shell\'s hello, and a later snapshot keeps them', async () => {
    const k = await connectedShell();
    assert.equal(k.shell.state().hello.tier, 'full');
    for (const s of k.desktop.sessions) s.frames.event({ type: 'phone', kind: 'tier', id: k.deviceId, tier: 'read', caps: ['events', 'chat'] });
    await waitFor(() => k.shell.state().hello.tier === 'read', 8000);
    assert.deepEqual(k.shell.state().hello.caps, ['events', 'chat']);
    await k.shell.setPrefs({ theme: 'dark' });
    assert.equal(k.shell.state().hello.tier, 'read', 'a later snapshot keeps it');
    // Another phone\'s tier is not this phone\'s.
    for (const s of k.desktop.sessions) s.frames.event({ type: 'phone', kind: 'tier', id: 'f'.repeat(64), tier: 'approve', caps: [] });
    await settle();
    assert.equal(k.shell.state().hello.tier, 'read');
  });
});

describe('B-128: web notifications and the browser\'s one subscription per address', () => {
  it('a second computer behind the same address is told so, nothing is replaced, and turning notifications off removes only the subscription this computer made', async () => {
    const vapidA = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
    const vapidB = Buffer.from(new Uint8Array(65).fill(5)).toString('base64url');
    let held = null;
    let unsubscribed = 0;
    const pushManager = {
      getSubscription: async () => held,
      subscribe: async options => {
        const key = new Uint8Array(options.applicationServerKey);
        if (held && Buffer.compare(Buffer.from(held.options.applicationServerKey), Buffer.from(key)) !== 0) throw Object.assign(new Error('another key'), { name: 'InvalidStateError' });
        if (!held) {
          held = {
            endpoint: `https://push.example/send/${key[0]}`,
            options: { applicationServerKey: key.buffer },
            toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'AAAA', auth: 'BBBB' } }; },
            unsubscribe: async () => { held = null; unsubscribed += 1; return true; },
          };
        }
        return held;
      },
    };
    const registration = { pushManager };
    const pushEnv = { isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
    const shellFor = vapid => ({ notifications: { permission: 'default', requestPermission: async () => 'granted' }, pushEnv, serviceWorker: { getRegistration: async () => registration } });
    const a = await connectedShell({ desktop: { vapidPublicKey: vapidA }, shell: shellFor(vapidA) });
    const b = await connectedShell({ desktop: { vapidPublicKey: vapidB }, shell: shellFor(vapidB) });
    assert.deepEqual(await a.shell.enableNotifications(), { ok: true, reason: null });
    assert.equal((await a.store.get(a.id)).pushEndpoint, 'https://push.example/send/4', 'the computer\'s record keeps its endpoint');
    assert.deepEqual(await b.shell.enableNotifications(), { ok: false, reason: 'other-computer' });
    assert.equal(b.desktop.stats.pushes.filter(p => p.subscription).length, 0, 'Work\'s computer was sent nothing');
    assert.equal(held.endpoint, 'https://push.example/send/4', 'the first computer\'s subscription is as it was');
    // B turns notifications off (it never had them): the browser\'s subscription is A\'s and stays.
    assert.equal((await b.shell.disableNotifications()).ok, true);
    assert.equal(unsubscribed, 0);
    // A turns them off: the computer drops its copy and the browser\'s subscription goes, so B can turn them on.
    assert.equal((await a.shell.disableNotifications()).ok, true);
    assert.equal(unsubscribed, 1);
    assert.equal(held, null);
    assert.equal((await a.store.get(a.id)).pushEndpoint, undefined, 'and the record forgets it');
    assert.deepEqual(await b.shell.enableNotifications(), { ok: true, reason: null });
  });

  it('a subscription made before the endpoint was recorded goes when this computer turns notifications off, only if it was made with the key of this computer', async () => {
    const vapidA = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
    const keyOf = fill => new Uint8Array(65).fill(fill).buffer;
    for (const [madeWith, removed] of [[4, 1], [5, 0]]) {
      let held = { endpoint: 'https://push.example/send/old', options: { applicationServerKey: keyOf(madeWith) }, unsubscribe: async () => { held = null; return true; } };
      const registration = { pushManager: { getSubscription: async () => held } };
      const pushEnv = { isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
      const k = await connectedShell({ desktop: { vapidPublicKey: vapidA }, shell: { notifications: { permission: 'granted', requestPermission: async () => 'granted' }, pushEnv, serviceWorker: { getRegistration: async () => registration } } });
      assert.equal((await k.store.get(k.id)).pushEndpoint, undefined, 'a record from before this version');
      assert.equal((await k.shell.disableNotifications()).ok, true);
      assert.equal(held === null ? 1 : 0, removed, madeWith === 4 ? 'its own key: removed' : 'the key of another computer: left alone');
    }
  });

  it('the browser refusing with InvalidStateError is the same answer, and an unrelated failure is still failed', async () => {
    const vapid = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
    const make = failure => ({ pushManager: { getSubscription: async () => null, subscribe: async () => { throw Object.assign(new Error('x'), { name: failure }); } } });
    const pushEnv = { isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
    for (const [name, reason] of [['InvalidStateError', 'other-computer'], ['AbortError', 'failed']]) {
      const k = await connectedShell({ desktop: { vapidPublicKey: vapid }, shell: { notifications: { requestPermission: async () => 'granted' }, pushEnv, serviceWorker: { getRegistration: async () => make(name) } } });
      assert.deepEqual(await k.shell.enableNotifications(), { ok: false, reason }, name);
    }
  });
});

describe('B-131: Test them now says which way a connected phone is using', () => {
  it('while connected it does not reconnect and answers the way in use; once the computer is away it tries them', async () => {
    const k = await connectedShell();
    const connected = await k.shell.testWays(k.id);
    assert.deepEqual([connected.ok, connected.reason, connected.carrier], [false, 'connected', 'lan']);
    k.desktop.killAll();
    await settle();
    assert.deepEqual(await k.shell.testWays(k.id), { ok: true, reason: null });
    assert.deepEqual(await k.shell.testWays('f'.repeat(64)), { ok: false, reason: 'offline' });
  });
});

// ----- helpers used by the tests above -----

function freshComputerRecord(desktop, phone) {
  return freshComputer(desktop, phone, { counter: 0 });
}

function bytesFromText(text) {
  return bytesToB64u(utf8.encode(text));
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

void openSocket;
void b64uToBytes;
void workerComputer;
void publicComputer;

// ----- bridge mode: the Electron harness, a sealed server and the Bridge in loopback LAN mode (MOB10_HARNESS=1) -----

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PHONE_VIEW, startPhoneHarness } from './harness/phone-window.mjs';
import { makeAppCopy, removeAppCopy } from './helpers/sealed-server.mjs';

// build-mobile.mjs takes esbuild and the phone packages from <root>/mobile/node_modules only, and a sealed app copy (makeAppCopy) has none: the
// copy links the install that holds the pinned esbuild (this project's, or the harness's shared one above the sealed copy), and unlinks it
// before the copy is removed, so nothing under the shared install can be touched.
function linkMobileInstall(app, here) {
  const install = [path.join(here, '..', 'node_modules'), path.resolve(here, '../../../node_modules')].find(d => existsSync(path.join(d, 'esbuild', 'package.json')));
  if (!install) throw new Error('no install holds esbuild: run npm ci in mobile/ (or use the harness shared install)');
  symlinkSync(install, path.join(app, 'mobile', 'node_modules'), 'junction');
}
// The sealed Electron window can reach only 127.0.0.1 (a LAN bind would make Windows ask the owner about the firewall), but the pairing link also
// lists this machine's real LAN addresses. The phone keeps the first carrier entry of a kind and tries only the addresses that pass the carrier
// rules (carriers.js), so the test link keeps just the loopback address the test server adds: the page then reconnects to the Bridge after pairing.
function loopbackOnly(link) {
  const at = link.indexOf('#pair=');
  const payload = JSON.parse(Buffer.from(link.slice(at + '#pair='.length), 'base64url').toString('utf8'));
  payload.carriers = payload.carriers
    .map(c => ({ ...c, urls: (c.urls ?? []).filter(u => /^ws:\/\/127\.0\.0\.1[:/]/.test(u)) }))
    .filter(c => c.urls.length);
  return `${link.slice(0, at)}#pair=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function unlinkMobileInstall(app) {
  try {
    const link = path.join(app, 'mobile', 'node_modules');
    if (lstatSync(link).isSymbolicLink()) rmdirSync(link);
  } catch { /* not linked */ }
}

const HARNESS = process.env.MOB10_HARNESS === '1';

async function until(fn, label, ms = 10_000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    let value = false;
    try { value = await fn(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, step));
  }
}
const APP = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'shell-core');

describe('bridge mode: pair in the page, REQ, server kill and restart, STOP of a running turn',
  { skip: HARNESS ? false : 'set MOB10_HARNESS=1 to run the Electron bridge mode' }, () => {
  let h = null;
  let bridge = null;
  let restarted = null;
  let app = null;   // this suite's own app folder (makeAppCopy): the build and the server never touch the sealed copy's mobile/www
  const evalPage = code => h.eval(code);
  const pageState = () => evalPage('plenumShellCore.state()');

  const restartServer = () => {
    const srv = h.server;
    const env = {
      ...process.env,
      PORT: String(srv.port),
      PLENUM_TOKEN: srv.token,
      MUSE_CONSOLE_HOME: srv.home,
      MUSE_CONSOLE_CLAUDE: 'api',
      MUSE_CONSOLE_NO_FALLBACK: '1',
      MUSE_CONSOLE_APP_ROOT: app,
      MOBILE_SEALED: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      PLENUM_REMOTE_LOOPBACK_HINT: '1',
    };
    delete env.PLENUM_TEST_REAL_LAN;
    return spawn(process.execPath, ['server.mjs'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  };
  const serverUp = async () => {
    try {
      const res = await fetch(`${h.server.url}/api/state`, { headers: { 'x-plenum-token': h.server.token }, signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };

  before(async () => {
    app = await makeAppCopy('shell-core');
    linkMobileInstall(app, import.meta.dirname);
    // A dev build (--dev): window.plenumShellCore and the &ci-confirm=1 pairing marker exist only there (plan C7).
    const built = spawnSync(process.execPath, [path.join(APP, 'scripts', 'build-mobile.mjs'), '--dev', '--root', app], { cwd: APP, encoding: 'utf8', timeout: 300_000 });
    assert.equal(built.status, 0, `build: ${built.stderr}`);
    const www = path.join(app, 'mobile', 'www');
    mkdirSync(www, { recursive: true });
    // The fixture page is the shell's page: data-shell-page says so (the harness window marks its page as the phone surface, which alone would make
    // it the UI page, and a UI page with no computer leaves for the shell's screens at once).
    writeFileSync(path.join(www, 'index.html'), readFileSync(path.join(FIXTURE, 'index.html'), 'utf8').replace('<html lang="en">', '<html lang="en" data-shell-page>'));
    h = await startPhoneHarness({ name: 'mob10-shell', appRoot: app });
    bridge = await h.enableBridge();
    // /?shell keeps the page on the shell's own screens: without it the page would hand itself over to the UI after HELLO (H3), and this fixture
    // page is not a UI page, so it would load itself again and again.
    // &ci-confirm=1 skips the review screen in a dev build, so the page pairs at once.
    await h.open(`${loopbackOnly(bridge.link).replace('/#pair=', '/?shell#pair=')}&ci-confirm=1`, { surface: 'phone', view: PHONE_VIEW, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
  });

  after(async () => {
    try { restarted?.kill(); } catch { /* already gone */ }
    const report = await h?.close();
    if (app) {
      unlinkMobileInstall(app);
      removeAppCopy(app);
    }
    if (report) assert.deepEqual(report.leftover, [], 'no process of the run is left');
  });

  it('pairs in the page: the six digits on the page are the six digits the computer shows, and the page connects after Allow', async () => {
    try {
      await until(async () => (await pageState()).pairing?.code, 'the six digits on the page', 20_000, 100);
    } catch (err) {
      const logs = await h.logs();
      const dom = await evalPage("(() => ({ shell: typeof plenumShellCore, html: document.body.innerHTML.slice(0, 300), url: location.href.slice(0, 80), state: (typeof plenumShellCore === 'object' && plenumShellCore) ? JSON.stringify(plenumShellCore.state()).slice(0, 400) : null }))()");
      console.log('DIAG logs ' + JSON.stringify(logs).slice(0, 1500));
      console.log('DIAG page ' + JSON.stringify(dom));
      throw err;
    }
    const pageCode = (await pageState()).pairing.code;
    assert.match(pageCode, /^[0-9]{6}$/);
    // The computer shows its code while the offer waits for Allow; it is read before Allow, as the Node suites do.
    await until(async () => (await h.server.get('/api/phones')).body.offer?.code, 'the computer to show its code', 10_000, 50);
    const offer = (await h.server.get('/api/phones')).body.offer;
    assert.equal(offer.code, pageCode, 'both show the same six digits');
    await h.confirmPairing();
    try {
      await until(async () => (await pageState()).connection.status === 'connected', 'the page connects', 20_000, 100);
    } catch (err) {
      const state = await pageState().catch(() => null);
      console.log('DIAG state ' + JSON.stringify({ connection: state?.connection, pairing: state?.pairing, route: state?.route, computers: state?.computers, hello: Boolean(state?.hello), notice: state?.notice, debug: state?.debugLines }).slice(0, 1500));
      console.log('DIAG logs ' + JSON.stringify(await h.logs()).slice(0, 2000));
      console.log('DIAG console ' + JSON.stringify(await evalPage('plenumShellCore.debug.lines().slice(-20)').catch(() => null)).slice(0, 2000));
      throw err;
    }
    const state = await pageState();
    assert.equal(state.route, 'connected');
    assert.equal(state.hello.desktopName !== '', true);
    assert.equal(state.computers.length, 1);
  });

  it('makes REQs through the Bridge: GET /api/state comes back as the server answers it', async () => {
    await until(async () => (await pageState()).connection.status === 'connected', 'the page to be connected', 20_000, 100);
    const out = await evalPage(`(async () => {
      const r = await plenumShellCore.channel.request({ method: 'GET', path: '/api/state' });
      const text = await new Response(r.body).text();
      return { status: r.status, json: JSON.parse(text).projects.map(p => p.id) };
    })()`);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, ['p1']);
  });

  it('survives a server kill and restart: PC offline within 3 s, back within 10 s, no pairing again', async () => {
    const before = (await h.server.get('/api/phones')).body.devices.length;
    assert.equal(before, 1);
    const killedAt = Date.now();
    h.server.proc.kill();
    await until(async () => (await pageState()).connection.status !== 'connected', 'the phone to notice the loss', 3000, 50);
    assert.ok(Date.now() - killedAt <= 3000, `noticed in ${Date.now() - killedAt} ms`);
    restarted = restartServer();
    await until(serverUp, 'the restarted server', 30_000, 100);
    const readyAt = Date.now();
    await until(async () => (await pageState()).connection.status === 'connected', 'the page reconnects', 10_000, 100);
    const back = Date.now() - readyAt;
    assert.ok(back <= 10_000, `reconnected ${back} ms after the server answered`);
    console.log(`reconnect: noticed the loss within 3 s; back ${back} ms after the server answered`);
    const state = await pageState();
    assert.equal(state.route, 'connected', 'no pairing screen came back');
    assert.equal(state.computers.length, 1);
    assert.equal((await h.server.get('/api/phones')).body.devices.length, 1, 'still one paired phone');
  });

  it('stops a running echo turn: the STOP_ACK carries the same id, the stream ends, and the counts are shown', async () => {
    const out = await evalPage(`(async () => {
      const r = await plenumShellCore.channel.request({ method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ project: 'p1', message: 'selftest: stop me' }));
      const reader = r.body.getReader();
      const first = await reader.read();
      const view = await plenumShellCore.stop(null);
      let chunks = 0;
      let ended = false;
      try {
        for (;;) {
          const x = await reader.read();
          if (x.done) { ended = true; break; }
          chunks += 1;
        }
      } catch (err) {
        ended = 'error ' + String(err.message);
      }
      return { status: r.status, firstBytes: first.value ? first.value.byteLength : 0, state: view.state, text: view.text,
        cancelled: view.ack ? view.ack.cancelled : null, id: view.ack ? view.ack.id : null, ended, chunks };
    })()`);
    assert.equal(out.status, 200);
    assert.equal(out.state, 'done', out.text);
    assert.match(out.id, /^[0-9a-f]{32}$/);
    assert.ok(out.firstBytes > 0, 'the turn was streaming');
    assert.equal(out.ended, true, 'the stream ended after the stop');
    console.log(`stop: cancelled ${out.cancelled}; ${out.text}`);
  });

  it('the debug console posts its lines to the computer, which keeps them for the Phones panel', async () => {
    const sent = await evalPage(`(async () => {
      plenumShellCore.debug.log('shell-core check line');
      const accepted = await plenumShellCore.debug.sendToComputer((spec, body) => plenumShellCore.channel.request(spec, body, { scope: 'shell' }), 3);
      return accepted;
    })()`);
    assert.ok(sent >= 1, 'the computer answered the debug lines');
    const lines = (await h.server.get('/api/phones')).status === 200 ? await evalPage(`(async () => {
      const r = await plenumShellCore.channel.request({ method: 'GET', path: '/_bridge/log' }, null, { scope: 'shell' });
      return JSON.parse(await new Response(r.body).text()).lines.map(l => l.text);
    })()`) : [];
    assert.ok(lines.some(text => text.includes('shell-core check line')), 'the line is on the computer');
  });

  it('runs the self test in the page and reports each step; the approval step needs a card the echo model never raises', async () => {
    const report = await evalPage('plenumShellCore.runSelftest({ approvalWaitMs: 3000 })');
    const byName = Object.fromEntries(report.steps.map(s => [s.name, s]));
    assert.equal(byName.connect.ok, true);
    assert.equal(byName['ui-pull'].ok, true);
    assert.equal(byName['chat-echo'].ok, true);
    assert.equal(byName.stop.ok, true);
    console.log(`selftest: ${report.passed}/${report.total}; approval: ${byName.approval.detail}`);
  });
});
