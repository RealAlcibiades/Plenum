// Suite for pairing (mob-03): the offer state machine, the check code, Allow and Deny, and what is written when. An in-process Bridge with a
// fake clock (offers live 120 seconds on the monotonic clock), memory storage and real WebSockets on loopback; phones are phone-sim.
// Run it through the sealed runner: node build/mobile/run.mjs --id mob-03 pairing.test.mjs
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createMemoryStorage, makeBridge, sleep, until } from './helpers/sealed-server.mjs';
import { ChannelClosed, b64uDecode, createPhone, decodeLink, openChannel } from './helpers/phone-sim.mjs';
import { TYPE, encodeFrame } from '../../lib/remote/frames.mjs';
import { CLOSE_CODES } from '../../lib/remote/listener.mjs';
import * as noise from '../../lib/remote/noise.mjs';
import { cleanName, createFileStorage, createRegistry, createShellStorage } from '../../lib/remote/registry.mjs';
import { buildLinks, buildPayload, createPairing } from '../../lib/remote/pairing.mjs';

// The fake clock moves in big steps, and a phone cannot answer a PING in the same instant: the desktop must not give up on it.
const NO_PING_MISSES = { pingMisses: 1_000_000 };
const closeReason = async p => {
  const info = await Promise.race([p.closed, sleep(3000).then(() => null)]);
  assert.ok(info, 'the channel closed');
  return info.frames.at(-1) ?? info.socket?.reason ?? null;
};
const stateOf = bridge => bridge.remote.pairing.view().state;

// IKpsk2 as phone-sim does it, but the finished handshake is kept: the Stop key is derived from its hash (noise.stopKey), and a test needs
// that hash to know what the desktop should have stored. The first transport message (a PING) proves the phone holds the secret.
async function pairKeeping(phone, link, { counter } = {}) {
  const desktopPublic = b64uDecode(link.pub);
  const channel = await openChannel(link.carriers[0].urls[0]);
  phone.counter = counter ?? phone.counter + 1;
  const payload = { v: '1.0', kind: 'pair', counter: phone.counter, offer: link.offer, device: phone.device, caps: [] };
  const hs = noise.handshakeInitiator({
    staticPrivate: phone.keys.privateKey, remoteStaticPublic: desktopPublic, prologue: noise.prologue('lan', link.offer), psk: b64uDecode(link.psk),
  });
  channel.send(noise.sealMessage1(desktopPublic, hs.writeMessage1(new TextEncoder().encode(JSON.stringify(payload)))));
  hs.readMessage2(await channel.next());
  const cs = hs.finish();
  channel.send(cs.send.encrypt(encodeFrame(TYPE.PING, 0, 0, new Uint8Array(8))));
  return { cs, channel, h: new Uint8Array(cs.handshakeHash) };
}

async function offer(bridge) {
  const started = await bridge.remote.pairStart();
  assert.equal(started.ok, true);
  return { started, link: decodeLink(started.link) };
}

describe('an offer', () => {
  test('nothing is in the registry before Allow; both screens show the same six digits; Allow registers the phone and sends HELLO', async () => {
    const clock = createFakeClock(5000);
    const bridge = await makeBridge({ clock, limits: NO_PING_MISSES });
    try {
      const { started, link } = await offer(bridge);
      assert.equal(started.expiresInS, 120);
      assert.equal(stateOf(bridge), 'offer');
      assert.equal(link.v, 1);
      assert.equal(link.ttl, 120);
      assert.equal(link.sas, '6');
      assert.match(link.offer, /^[0-9a-f]{32}$/);
      assert.equal(Buffer.from(link.psk, 'base64url').length, 32);
      assert.equal(Buffer.from(link.pub, 'base64url').length, 32);
      assert.equal(link.carriers[0].kind, 'lan');
      assert.match(link.carriers[0].urls[0], new RegExp(`^ws://127.0.0.1:${bridge.port}/b/${bridge.pathKey}$`));
      assert.match(started.link, new RegExp(`^http://127.0.0.1:${bridge.port}/p/${bridge.pathKey}/#pair=`), 'the link opens the shell page, with the code in the fragment');

      const phone = createPhone({ name: "Will's iPhone", platform: 'ios', app: 'pwa' });
      const paired = await phone.pair(link);
      assert.match(paired.code, /^\d{6}$/);
      assert.equal(paired.state.state, 'confirm');
      assert.equal(paired.state.deviceId, phone.id);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const view = bridge.remote.pairing.view();
      assert.equal(view.code, paired.code, 'the computer shows the same code as the phone');
      assert.deepEqual(view.device, { name: "Will's iPhone", platform: 'ios', app: 'pwa', appVersion: '1.0.0', carrier: 'lan' });
      assert.equal(view.second, false);
      assert.equal(bridge.remote.registry.list().length, 0, 'nothing is written before Allow');
      assert.equal(JSON.parse(bridge.storage.text).devices.length, 0);

      const answer = await bridge.remote.pairConfirm(true);
      assert.equal(answer.ok, true);
      const hello = await paired.hello;
      assert.equal(hello.deviceId, phone.id);
      assert.equal(hello.tier, 'full', 'a new phone has full control by default');
      assert.deepEqual(hello.protocol, { major: 1, minor: 1 });
      assert.ok(Array.isArray(hello.carriers) && hello.carriers[0].kind === 'lan');
      assert.deepEqual(hello.pending, { approvals: 0, running: 0 });
      const [device] = bridge.remote.registry.list();
      assert.equal(device.id, phone.id);
      assert.equal(device.name, "Will's iPhone");
      assert.equal(device.tier, 'full');
      assert.equal(JSON.parse(bridge.storage.text).devices[0].handshakeCounter, phone.counter, 'the pairing counter is stored');
      assert.equal(stateOf(bridge), 'allowed');
      assert.equal(bridge.remote.pairing.current(), null, 'the secret is wiped');
      assert.equal(JSON.stringify(JSON.parse(bridge.storage.text)).includes(link.psk), false, 'the secret is nowhere in the registry');
      const state = JSON.stringify(await bridge.remote.state());
      assert.equal(state.includes(link.psk), false);

      // The same code cannot be used again.
      await assert.rejects(() => createPhone({ name: 'Late' }).pair(link), error => error instanceof ChannelClosed || /closed|message/.test(String(error.message)));
      // The paired phone reconnects with Noise IK, and the live session answers requests.
      paired.session.close();
      const again = await phone.connect(bridge.desktopPublic, bridge.url);
      assert.equal(again.hello.deviceId, phone.id);
      again.close();
    } finally {
      await bridge.close();
    }
  });

  test('Deny sends CLOSE denied to the waiting phone, registers nothing and wipes the secret', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const phone = createPhone({ name: 'Unwanted' });
      const paired = await phone.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      assert.deepEqual(bridge.remote.pairing.deny(), { ok: true });
      assert.equal(await closeReason(paired), 'denied');
      await assert.rejects(paired.hello, error => error.reason === 'denied');
      assert.equal(stateOf(bridge), 'denied');
      assert.equal(bridge.remote.registry.list().length, 0);
      assert.equal(bridge.remote.pairing.current(), null);
      assert.equal((await bridge.remote.pairConfirm(true)).ok, false, 'there is nothing left to allow');
    } finally {
      await bridge.close();
    }
  });

  test('an offer expires at 120 seconds on the fake clock: waiting phones get CLOSE expired and Allow is refused', async () => {
    const clock = createFakeClock(0);
    const bridge = await makeBridge({ clock, limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const phone = createPhone({ name: 'Slow' });
      const paired = await phone.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      clock.advance(119_999);
      assert.equal(stateOf(bridge), 'confirm');
      assert.equal(bridge.remote.pairing.view().expiresInS, 1);
      clock.advance(1);
      assert.equal(stateOf(bridge), 'expired');
      assert.equal(await closeReason(paired), 'expired');
      const answer = await bridge.remote.pairConfirm(true);
      assert.equal(answer.ok, false);
      assert.equal(bridge.remote.registry.list().length, 0);
      // A phone that scans the dead code is turned away before anything is answered.
      await assert.rejects(() => createPhone({ name: 'Later' }).pair(link), ChannelClosed);
      clock.advance(60_000);
      assert.equal(stateOf(bridge), 'idle', 'the finished state is forgotten after a minute');
    } finally {
      await bridge.close();
    }
  });

  test('three wrong-psk attempts leave the offer open with tried true, and a phone with the code still pairs', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      assert.equal(bridge.remote.pairing.view().tried, false, 'nobody has tried yet');
      for (let i = 1; i <= 3; i++) {
        assert.equal(stateOf(bridge), 'offer', `still up before failure ${i}`);
        const bad = await createPhone({ name: `Guess ${i}` }).pair(link, { wrongFirst: true });
        const info = await Promise.race([bad.closed, sleep(3000).then(() => null)]);
        assert.ok(info, `failure ${i}: the desktop closed the socket`);
        assert.equal(info.socket.code, CLOSE_CODES.unknown);
      }
      assert.equal(stateOf(bridge), 'offer', 'three bad tries no longer end the offer');
      assert.equal(bridge.remote.pairing.view().tried, true, 'the window is told that a device tried');
      assert.equal(bridge.remote.pairing.view().left, false);
      assert.ok(bridge.remote.pairing.current(), 'the secret is still up');
      assert.equal((await bridge.remote.state()).offer.tried, true, 'GET /api/phones carries tried');
      assert.equal((await bridge.remote.state()).offer.left, false);
      // A phone that has the code still pairs: Allow registers it.
      const phone = createPhone({ name: 'Right secret' });
      const paired = await phone.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      assert.equal(bridge.remote.pairing.view().tried, true, 'the flag stays for this offer');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      assert.equal((await paired.hello).deviceId, phone.id);
      assert.deepEqual(bridge.remote.registry.list().map(d => d.id), [phone.id]);
      // A new code starts clean.
      const next = await offer(bridge);
      assert.ok(next.link.offer);
      assert.equal(bridge.remote.pairing.view().tried, false, 'a new offer resets tried');
    } finally {
      await bridge.close();
    }
  });

  test('when the shown phone leaves, the offer is back in offer with left true, the other waiting attempt is closed, and Allow pairs nobody', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const first = await createPhone({ name: 'First' }).pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const second = await createPhone({ name: 'Second' }).pair(link);
      await until(() => bridge.remote.pairing.view().second === true, 'the second phone');
      assert.equal(bridge.remote.pairing.view().code, first.code, 'the first phone is on screen');
      first.channel.close();
      await until(() => stateOf(bridge) === 'offer', 'the offer to go back to offer');
      const view = bridge.remote.pairing.view();
      assert.equal(view.left, true, 'the window says the phone left');
      assert.equal('code' in view, false, 'no code is shown');
      assert.equal('device' in view, false, 'nobody is on screen');
      assert.equal(view.second, false);
      assert.equal(await closeReason(second), 'denied', 'the other waiting phone is closed, not promoted in place');
      const none = await bridge.remote.pairConfirm(true);
      assert.equal(none.ok, false, 'Allow with nobody on screen pairs nobody');
      assert.equal(bridge.remote.registry.list().length, 0);
      assert.ok(bridge.remote.pairing.current(), 'the offer itself is still live');
      assert.equal((await bridge.remote.state()).offer.left, true);
      // A phone that proves the code again is shown, and left turns false.
      const third = createPhone({ name: 'Third' });
      const again = await third.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm for the new phone');
      assert.equal(bridge.remote.pairing.view().left, false);
      assert.equal(bridge.remote.pairing.view().code, again.code);
      assert.equal(bridge.remote.pairing.view().device.name, 'Third');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      assert.equal((await again.hello).deviceId, third.id);
      assert.deepEqual(bridge.remote.registry.list().map(d => d.id), [third.id]);
    } finally {
      await bridge.close();
    }
  });

  test('Allow stores stopKey = stopKey(h) of the IKpsk2 handshake; nothing before Allow; a re-pair brings a new key; no view carries it', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const phone = createPhone({ name: 'Keeper' });
      const kept = await pairKeeping(phone, link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      assert.equal(bridge.remote.registry.stopKeyOf(phone.id), null, 'no key before Allow');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      const stored = bridge.remote.registry.stopKeyOf(phone.id);
      assert.ok(stored instanceof Uint8Array && stored.length === 32);
      assert.equal(noise.bytesToHex(stored), noise.bytesToHex(noise.stopKey(kept.h)), 'the desktop derives the key from the same handshake hash');
      assert.notEqual(noise.bytesToHex(stored), noise.bytesToHex(noise.pushKey(kept.h)), 'it is not the push key');
      const record = JSON.parse(bridge.storage.text).devices.find(d => d.publicKey === noise.bytesToHex(phone.keys.publicKey));
      assert.match(record.stopKey, /^[0-9a-f]{64}$/, 'saved in phones.json as 64 lowercase hex');
      assert.equal(record.stopKey, noise.bytesToHex(stored));
      // It is in no view: the list, GET /api/phones and the pairing view.
      for (const text of [JSON.stringify(bridge.remote.registry.list()), JSON.stringify(await bridge.remote.state()), JSON.stringify(bridge.remote.pairing.view())]) {
        assert.equal(text.includes(record.stopKey), false);
      }
      // stopKeyOf hands out a fresh copy each time: wiping it does not wipe the registry's.
      stored.fill(0);
      assert.equal(noise.bytesToHex(bridge.remote.registry.stopKeyOf(phone.id)), record.stopKey);
      // A re-pair brings a new key.
      kept.channel.close();
      const second = await offer(bridge);
      const again = await pairKeeping(phone, second.link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm again');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      const renewed = noise.bytesToHex(bridge.remote.registry.stopKeyOf(phone.id));
      assert.equal(renewed, noise.bytesToHex(noise.stopKey(again.h)));
      assert.notEqual(renewed, record.stopKey, 'a re-pair brings a new key');
      again.channel.close();
    } finally {
      await bridge.close();
    }
  });

  test('a phone that never proves it holds the secret counts as a failure after 10 seconds, and two failures do not end the offer', async () => {
    const clock = createFakeClock(0);
    const bridge = await makeBridge({ clock, limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const silent = await createPhone({ name: 'Silent' }).pair(link, { skipFirst: true });
      clock.advance(10_000);
      const info = await Promise.race([silent.closed, sleep(3000).then(() => null)]);
      assert.equal(info.socket.code, CLOSE_CODES.timeout);
      // A wrong secret cannot even read message 2.
      await assert.rejects(() => createPhone({ name: 'Wrong' }).pair(link, { wrongPsk: true }));
      clock.advance(10_000);
      await sleep(30);
      assert.equal(stateOf(bridge), 'offer', 'two failures: the offer lives');
      const good = createPhone({ name: 'Good' });
      const paired = await good.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      await paired.hello;
    } finally {
      await bridge.close();
    }
  });

  test('two phones with the same QR get different check codes; only the allowed one is registered and the other gets CLOSE denied', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const honest = createPhone({ name: 'Honest' });
      const mallory = createPhone({ name: 'Mallory' });
      const a = await honest.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const b = await mallory.pair(link);
      await until(() => bridge.remote.pairing.view().second === true, 'the second phone');
      assert.notEqual(a.code, b.code, 'each handshake has its own check code');
      assert.equal(bridge.remote.pairing.view().code, a.code, 'the window shows the first');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      assert.equal((await a.hello).deviceId, honest.id);
      assert.equal(await closeReason(b), 'denied');
      assert.deepEqual(bridge.remote.registry.list().map(d => d.id), [honest.id], 'only the allowed phone is registered');
    } finally {
      await bridge.close();
    }
  });

  test('Deny with two phones waiting closes both', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const a = await createPhone({ name: 'A' }).pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const b = await createPhone({ name: 'B' }).pair(link);
      await until(() => bridge.remote.pairing.view().second, 'two');
      bridge.remote.pairing.deny();
      assert.equal(await closeReason(a), 'denied');
      assert.equal(await closeReason(b), 'denied');
      assert.equal(bridge.remote.registry.list().length, 0);
    } finally {
      await bridge.close();
    }
  });

  test('a copy of the first message, sent again, is refused as a replay: no failure counts, the offer lives, the real phone can still be allowed', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      // The real phone's first transport bytes as they leave it: a sniffer on the same network keeps a copy.
      const sent = [];
      class Sniffer extends globalThis.WebSocket {
        send(data) {
          if (sent.length === 0) sent.push(new Uint8Array(data));
          return super.send(data);
        }
      }
      const honest = createPhone({ name: 'Honest' });
      const real = await honest.pair(link, { WebSocketImpl: Sniffer });
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const [copied] = sent;
      assert.ok(copied?.length > 64, 'the first message was captured');
      const url = link.carriers[0].urls[0];
      // Three copies, each followed by a garbage proof on the same socket. Each copy is refused before it is answered.
      for (let i = 1; i <= 3; i++) {
        const raw = await openChannel(url);
        raw.send(copied);
        const answer = await raw.next(2000).then(reply => reply, error => error);
        assert.ok(answer instanceof ChannelClosed, `copy ${i} is refused, not answered`);
        assert.equal(answer.code, CLOSE_CODES.protocol);
        assert.equal(answer.reason, 'replay');
        raw.send(new Uint8Array(40).fill(9));
        raw.close();
      }
      assert.equal(stateOf(bridge), 'confirm', 'the offer is still live: no copy counted as a failed handshake');
      assert.ok(bridge.remote.pairing.current(), 'the secret is still up');
      const answer = await bridge.remote.pairConfirm(true);
      assert.equal(answer.ok, true, 'the real phone can still be allowed');
      assert.equal((await real.hello).deviceId, honest.id);
      assert.deepEqual(bridge.remote.registry.list().map(d => d.id), [honest.id]);
    } finally {
      await bridge.close();
    }
  });

  test('a new offer ends the old one, and no more than four phones wait at once', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const first = await offer(bridge);
      const waiting = await createPhone({ name: 'Waiting' }).pair(first.link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const second = await offer(bridge);
      assert.notEqual(second.link.offer, first.link.offer);
      assert.equal(await closeReason(waiting), 'denied');
      assert.equal(stateOf(bridge), 'offer');
      await assert.rejects(() => createPhone({ name: 'Old code' }).pair(first.link), ChannelClosed);
      const phones = [];
      for (let i = 0; i < 4; i++) phones.push(await createPhone({ name: `P${i}` }).pair(second.link));
      await until(() => bridge.remote.pairing.view().second, 'several');
      const fifth = await createPhone({ name: 'P5' }).pair(second.link).catch(error => error);
      const info = fifth instanceof ChannelClosed ? { code: fifth.code } : (await Promise.race([fifth.closed, sleep(3000).then(() => null)]))?.socket;
      assert.equal(info?.code, CLOSE_CODES.rate, 'the fifth phone is told the Bridge is busy');
      bridge.remote.pairing.cancel();
      for (const p of phones) await closeReason(p);
      assert.equal(stateOf(bridge), 'idle');
    } finally {
      await bridge.close();
    }
  });

  test('a registry that cannot save leaves the phone waiting, with the storage sentence; the next try works', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const phone = createPhone({ name: 'Unlucky' });
      const paired = await phone.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      bridge.storage.failNext = true;
      const failed = await bridge.remote.pairConfirm(true);
      assert.equal(failed.ok, false);
      assert.equal(failed.status, 503);
      assert.match(failed.error, /could not be saved/);
      assert.equal(stateOf(bridge), 'confirm');
      assert.equal(bridge.remote.registry.list().length, 0);
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      await paired.hello;
      assert.equal(bridge.remote.registry.list().length, 1);
    } finally {
      await bridge.close();
    }
  });

  test('two Allow clicks at once register the phone once, and the second removes nothing', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const phone = createPhone({ name: 'Double' });
      const paired = await phone.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const [a, b] = await Promise.all([bridge.remote.pairConfirm(true), bridge.remote.pairConfirm(true)]);
      assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
      assert.equal((a.ok ? b : a).status, 409);
      assert.equal((await paired.hello).deviceId, phone.id);
      assert.deepEqual(bridge.remote.registry.list().map(d => d.id), [phone.id]);
      assert.equal(JSON.parse(bridge.storage.text).devices.length, 1);
    } finally {
      await bridge.close();
    }
  });

  test('a phone name is cleaned: control, direction and zero-width characters out, 60 characters at most', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const { link } = await offer(bridge);
      const dirty = `Will${String.fromCodePoint(0x202e)}'s\r\nphone${String.fromCodePoint(0x200b)} ${'x'.repeat(100)}`;
      const phone = createPhone({ name: dirty });
      const paired = await phone.pair(link);
      await until(() => stateOf(bridge) === 'confirm', 'confirm');
      const shown = bridge.remote.pairing.view().device.name;
      assert.ok(shown.length <= 60);
      assert.match(shown, /^Will's phone x+$/);
      await bridge.remote.pairConfirm(true);
      await paired.hello;
      assert.equal(bridge.remote.registry.list()[0].name, shown);
    } finally {
      await bridge.close();
    }
  });

  test('pairing a phone whose key is already registered updates its record instead of adding another', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), limits: NO_PING_MISSES });
    try {
      const phone = createPhone({ name: 'First name' });
      const first = await bridge.pairPhone(phone, { counter: 5 });
      await bridge.remote.setTier(phone.id, 'read');
      first.session.close();
      assert.equal(bridge.remote.registry.counterOf(phone.keys.publicKey), 5);
      phone.device.name = 'Second name';
      const second = await bridge.pairPhone(phone, { counter: 2 });
      assert.equal(second.hello.tier, 'read', 'the tier the person chose is kept');
      const list = bridge.remote.registry.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'Second name');
      assert.equal(bridge.remote.registry.counterOf(phone.keys.publicKey), 5, 'a re-pairing with a lower counter does not lower the stored one');
      assert.equal(JSON.parse(bridge.storage.text).devices[0].handshakeCounter, 5);
      second.session.close();
    } finally {
      await bridge.close();
    }
  });

  test('with no way for a phone to reach this computer, no offer is made', async () => {
    const bridge = await makeBridge({ clock: createFakeClock(0), carrier: false, limits: NO_PING_MISSES });
    try {
      const made = await bridge.remote.pairStart();
      assert.deepEqual(made, { ok: false, state: 'no-carrier' });
      assert.equal(bridge.remote.pairing.current(), null);
      assert.equal(stateOf(bridge), 'no-carrier');
    } finally {
      await bridge.close();
    }
  });
});

describe('under the desktop app', () => {
  function desktopShell() {
    const calls = [];
    const handlers = new Map();
    return {
      calls,
      handlers,
      available: () => true,
      request: async (type, payload) => { calls.push({ type, payload }); return { ok: true }; },
      post: message => { calls.push({ type: message.type, payload: message, post: true }); return true; },
      on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); },
      shows: () => calls.filter(c => c.type === 'phones-pair-show').map(c => c.payload),
    };
  }

  test('the link and the code go only to the pairing window; the page and the answers never carry them', async () => {
    const shell = desktopShell();
    const bridge = await makeBridge({ clock: createFakeClock(0), shell, limits: NO_PING_MISSES });
    try {
      const started = await bridge.remote.pairStart();
      assert.equal(started.ok, true);
      assert.equal('link' in started, false, 'pairStart does not hand the link to the page');
      await until(() => shell.shows().length >= 1, 'the window to be told');
      const offerShow = shell.shows().at(-1);
      assert.equal(offerShow.state, 'offer');
      assert.match(offerShow.offer, /^[0-9a-f]{32}$/);
      assert.match(offerShow.link, /#pair=/);
      assert.equal(offerShow.name, 'Test PC');
      assert.deepEqual(offerShow.hints, [{ label: 'Same network (test)', on: true }]);
      const link = decodeLink(offerShow.link);
      const phone = createPhone({ name: "Will's iPhone" });
      const paired = await phone.pair(link);
      await until(() => shell.shows().some(s => s.state === 'confirm'), 'the confirm state in the window');
      const confirmShow = shell.shows().find(s => s.state === 'confirm');
      assert.equal(confirmShow.code, paired.code);
      assert.equal(confirmShow.device.name, "Will's iPhone");
      assert.equal(confirmShow.link, '', 'the link is not sent again once a phone is waiting');
      const view = await bridge.remote.state();
      assert.equal('code' in view.offer, false, 'GET /api/phones does not carry the code under the desktop app');
      assert.equal('device' in view.offer, false);
      assert.equal(JSON.stringify(view).includes(link.psk), false);
      // Allow is the window's button: a phones-pair-answer message.
      const answer = shell.handlers.get('phones-pair-answer');
      assert.equal(typeof answer, 'function');
      await answer({ type: 'phones-pair-answer', offer: 'not-the-offer', action: 'allow' });
      assert.equal(bridge.remote.registry.list().length, 0, 'an answer for another offer is ignored');
      await answer({ type: 'phones-pair-answer', offer: offerShow.offer, action: 'allow' });
      await paired.hello;
      assert.equal(bridge.remote.registry.list().length, 1);
      await until(() => shell.shows().some(s => s.state === 'allowed'), 'the allowed state in the window');
    } finally {
      await bridge.close();
    }
  });

  test('phones-pair-show carries qrKind lan when LAN is the only way, tier full for a new phone and the stored tier for a re-pair, tried, left and device.app', async () => {
    const shell = desktopShell();
    const bridge = await makeBridge({ clock: createFakeClock(0), shell, limits: NO_PING_MISSES });
    try {
      await bridge.remote.pairStart();
      await until(() => shell.shows().length >= 1, 'the window to be told');
      const offerShow = shell.shows().at(-1);
      assert.equal(offerShow.state, 'offer');
      assert.equal(offerShow.qrKind, 'lan', 'LAN is the only way, so the QR is the plain-http LAN page');
      assert.equal(offerShow.tier, null, 'nobody is shown yet');
      assert.equal(offerShow.tried, false);
      assert.equal(offerShow.left, false);
      const link = decodeLink(offerShow.link);
      // A device that fails the proof: the offer stays, the window is told.
      const bad = await createPhone({ name: 'Guess' }).pair(link, { wrongFirst: true });
      await Promise.race([bad.closed, sleep(3000)]);
      await until(() => shell.shows().some(s => s.state === 'offer' && s.tried === true), 'tried to reach the window');
      // A new phone: tier full, its app, and the same QR kind.
      const phone = createPhone({ name: 'Newbie', platform: 'android', app: 'android' });
      const first = await phone.pair(link);
      await until(() => shell.shows().some(s => s.state === 'confirm'), 'confirm');
      const confirmShow = shell.shows().find(s => s.state === 'confirm');
      assert.equal(confirmShow.tier, 'full', 'a new phone gets Full control if allowed');
      assert.equal(confirmShow.device.app, 'android');
      assert.equal(confirmShow.device.name, 'Newbie');
      assert.equal(confirmShow.qrKind, 'lan');
      assert.equal(confirmShow.tried, true);
      assert.equal(confirmShow.left, false);
      // The phone on screen leaves: back to the code, with left.
      first.channel.close();
      await until(() => shell.shows().some(s => s.state === 'offer' && s.left === true), 'left to reach the window');
      const leftShow = shell.shows().findLast(s => s.left === true);
      assert.equal(leftShow.tier, null);
      assert.equal(leftShow.code, '');
      // It pairs for real, then the person lowers its tier and it pairs again: the window shows the tier it already has.
      const second = await phone.pair(link);
      await until(() => shell.shows().filter(s => s.state === 'confirm').length >= 2, 'confirm again');
      assert.equal(shell.shows().at(-1).left, false, 'left turns false when a new phone proves the code');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      await second.hello;
      await bridge.remote.setTier(phone.id, 'read');
      second.session.close();
      await bridge.remote.pairStart();
      await until(() => shell.shows().at(-1).state === 'offer' && shell.shows().at(-1).offer !== offerShow.offer, 'a second offer');
      const link2 = decodeLink(shell.shows().at(-1).link);
      const third = await phone.pair(link2);
      await until(() => shell.shows().at(-1).state === 'confirm', 'confirm for the re-pair');
      assert.equal(shell.shows().at(-1).tier, 'read', 'a re-pair shows the stored tier');
      assert.equal(shell.shows().at(-1).tried, false, 'a new offer starts without tried');
      assert.equal((await bridge.remote.pairConfirm(true)).ok, true);
      assert.equal((await third.hello).tier, 'read');
      // The LAN-web page is labelled by its app (D6): the window gets 'lan-web' and still shows Full for a new phone.
      third.session.close();
      await bridge.remote.pairStart();
      await until(() => shell.shows().at(-1).state === 'offer' && shell.shows().at(-1).tier === null, 'a third offer');
      const web = createPhone({ name: 'Web page', platform: 'ios', app: 'lan-web' });
      await web.pair(decodeLink(shell.shows().at(-1).link));
      await until(() => shell.shows().at(-1).state === 'confirm', 'confirm for the web page');
      assert.equal(shell.shows().at(-1).device.app, 'lan-web');
      assert.equal(shell.shows().at(-1).tier, 'full', 'the owner\'s default tier is unchanged (D6)');
      bridge.remote.pairing.cancel();
    } finally {
      await bridge.close();
    }
  });

  test('Deny, Cancel, Copy link and New code from the window', async () => {
    const shell = desktopShell();
    const bridge = await makeBridge({ clock: createFakeClock(0), shell, limits: NO_PING_MISSES });
    try {
      await bridge.remote.pairStart();
      await until(() => shell.shows().length >= 1, 'the window');
      const first = shell.shows().at(-1);
      const answer = shell.handlers.get('phones-pair-answer');
      await answer({ type: 'phones-pair-answer', offer: first.offer, action: 'copy' });
      const copied = shell.calls.find(c => c.type === 'phones-clipboard');
      assert.equal(copied.payload.text, first.link);
      assert.ok(copied.payload.clearAfterMs >= 5000 && copied.payload.clearAfterMs <= 120_000);
      const phone = createPhone({ name: 'Denied' });
      const paired = await phone.pair(decodeLink(first.link));
      await until(() => shell.shows().some(s => s.state === 'confirm'), 'confirm');
      await answer({ type: 'phones-pair-answer', offer: first.offer, action: 'deny' });
      assert.equal(await closeReason(paired), 'denied');
      assert.equal(shell.shows().at(-1).state, 'denied');
      await answer({ type: 'phones-pair-answer', offer: '', action: 'new-code' });
      await until(() => shell.shows().at(-1).state === 'offer' && shell.shows().at(-1).offer !== first.offer, 'a new code');
      const second = shell.shows().at(-1);
      await answer({ type: 'phones-pair-answer', offer: second.offer, action: 'cancel' });
      assert.equal(stateOf(bridge), 'idle');
      assert.ok(shell.calls.some(c => c.type === 'phones-pair-close' && c.post), 'the window is told to close');
      assert.equal(bridge.remote.registry.list().length, 0);
    } finally {
      await bridge.close();
    }
  });
});

describe('the link', () => {
  test('buildPayload and buildLinks carry what MOBILE.json lists, and the app-only form works without a web page', () => {
    const psk = new Uint8Array(32).fill(5);
    const pub = '0a'.repeat(32);
    const hints = [
      { kind: 'lan', on: true, urls: ['ws://192.168.1.5:40123/b/k', 'ws://[fe80::1]:40123/b/k'], web: 'http://192.168.1.5:40123/p/k/' },
      { kind: 'tailscale', on: true, url: 'wss://pc.tail1.ts.net/b/k', web: 'https://pc.tail1.ts.net/p/k/' },
      { kind: 'relay', on: true, url: 'wss://w.a.workers.dev/room/r', web: 'https://w.a.workers.dev/' },
    ];
    const payload = buildPayload({ name: 'Home PC', pub, psk, offer: 'f'.repeat(32), hints });
    assert.deepEqual(Object.keys(payload).sort(), ['carriers', 'name', 'offer', 'psk', 'pub', 'sas', 'ttl', 'v']);
    assert.deepEqual(payload.carriers.map(c => c.kind), ['lan', 'tailscale', 'relay']);
    const links = buildLinks(payload, hints);
    assert.equal(links.primary, links.tailscale, 'Tailscale\'s secure page first');
    assert.match(links.tailscale, /^https:\/\/pc\.tail1\.ts\.net\/p\/k\/#pair=/);
    assert.match(links.lan, /^http:\/\/192\.168\.1\.5:40123\/p\/k\/#pair=/);
    assert.match(links.relay, /^https:\/\/w\.a\.workers\.dev\/#pair=/);
    assert.match(links.native, /^plenum:\/\/pair#/);
    for (const form of [links.tailscale, links.lan, links.relay, links.native]) assert.deepEqual(decodeLink(form), payload);
    assert.equal(buildLinks(payload, [hints[2]]).primary, buildLinks(payload, [hints[2]]).relay);
    assert.match(buildLinks(payload, []).primary, /^plenum:\/\//);
    assert.equal(links.primaryKind, 'tailscale');
    assert.equal(buildLinks(payload, [hints[0]]).primaryKind, 'lan', 'the LAN page is the QR when it is the only way');
    assert.equal(buildLinks(payload, [hints[0], hints[2]]).primaryKind, 'lan');
    assert.equal(buildLinks(payload, [hints[2]]).primaryKind, 'relay');
    assert.equal(buildLinks(payload, []).primaryKind, 'native');
    assert.ok(JSON.stringify(payload).length < 700, 'small enough for one QR');
  });

  test('the state machine alone: states, the view never holds the secret, and a stopped Bridge ends the offer quietly', async () => {
    const clock = createFakeClock(0);
    const registry = { add: async () => ({ id: 'x' }), remove: async () => true };
    const seen = [];
    let n = 0;
    const pairing = createPairing({ registry, clock, random: size => new Uint8Array(size).fill(++n), onChange: (view, change) => seen.push([change, view.state]) });
    assert.equal(pairing.view().state, 'idle');
    const made = pairing.start({ name: 'PC', pub: '0b'.repeat(32), hints: [{ kind: 'relay', on: true, url: 'wss://r', web: 'https://r/' }] });
    assert.equal(made.ok, true);
    assert.equal(pairing.view().active, true);
    assert.equal(JSON.stringify(pairing.view()).includes(made.link.split('#pair=')[1]), false, 'the view never holds the link');
    assert.ok(pairing.link().length > 0);
    assert.equal(pairing.current().psk.length, 32);
    assert.equal(pairing.deny().ok, false, 'nothing to deny before a phone is waiting');
    pairing.shutdown();
    assert.equal(pairing.current(), null);
    assert.equal(pairing.link(), '');
    assert.equal(clock.pending, 0, 'no timer survives a shutdown');
    assert.deepEqual(seen.map(s => s[1]).slice(0, 1), ['offer']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The registry

describe('the registry', () => {
  const dirs = [];
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const key = n => new Uint8Array(32).fill(n);
  const cp = n => String.fromCodePoint(n);

  test('cleanName strips control, direction and invisible characters, keeps emoji joiners, and clips by characters', () => {
    assert.equal(cleanName(`  A${cp(7)}B\r\nC  `), 'A B C');
    assert.equal(cleanName(`x${cp(0x202e)}y${cp(0x2066)}z${cp(0xfeff)}`), 'xyz');
    assert.equal(cleanName(`a${cp(0x2028)}b`), 'a b');
    const family = `${cp(0x1f469)}${cp(0x200d)}${cp(0x1f4bb)}`;
    assert.equal(cleanName(family), family, 'a joined emoji survives');
    assert.equal(Array.from(cleanName(cp(0x1f600).repeat(100))).length, 60, 'clipped by characters, never in half a pair');
    assert.equal(cleanName('', 60, 'Phone'), 'Phone');
    assert.equal(cleanName(42, 60, 'fallback'), 'fallback');
    assert.equal(cleanName('x'.repeat(200), 10), 'x'.repeat(10));
  });

  test('the file storage writes through a temporary file, reads back, and keeps nothing else behind', async () => {
    const dir = tempDir();
    const storage = createFileStorage({ dir });
    const registry = createRegistry({ storage });
    assert.equal((await registry.ready()).ok, true);
    assert.equal((await registry.ready()).storage, 'file');
    const ids = await registry.ensureIdentity();
    assert.equal(ids.publicKey.length, 32);
    assert.match(registry.pathKey(), /^[0-9a-f]{32}$/);
    await registry.add({ publicKey: key(1), name: 'One', counter: 4, carrier: 'lan' });
    assert.deepEqual(readdirSync(dir), ['phones.json'], 'no temporary file is left');
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'phones.json')).mode & 0o777, 0o600);
    // A second registry on the same folder sees the same computer and the same phone.
    const again = createRegistry({ storage: createFileStorage({ dir }) });
    await again.ready();
    assert.deepEqual([...again.identity().publicKey], [...ids.publicKey]);
    assert.equal(again.pathKey(), registry.pathKey());
    assert.equal(again.list().length, 1);
    assert.equal(again.counterOf(key(1)), 4);
    assert.equal(again.counterOf(key(2)), undefined, 'a key that is not held has no counter');
    assert.equal(again.counterOf(new Uint8Array(5)), undefined);
  });

  test('B-56: two damaged files on two starts keep both copies; a later start never replaces the first one', async () => {
    const dir = tempDir();
    const first = '{"v":1,"identity":';
    const second = '{"v":1,"devices":[';
    writeFileSync(path.join(dir, 'phones.json'), first);
    assert.equal((await createRegistry({ storage: createFileStorage({ dir }) }).ready()).damaged, true);
    writeFileSync(path.join(dir, 'phones.json'), second);
    assert.equal((await createRegistry({ storage: createFileStorage({ dir }) }).ready()).damaged, true);
    assert.deepEqual(readdirSync(dir).sort(), ['phones.json.damaged', 'phones.json.damaged-2']);
    assert.equal(readFileSync(path.join(dir, 'phones.json.damaged'), 'utf8'), first, 'the first copy is untouched');
    assert.equal(readFileSync(path.join(dir, 'phones.json.damaged-2'), 'utf8'), second);
  });

  test('a damaged file is set aside and the registry starts empty; a file that cannot be read makes it unavailable with the reason', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'phones.json'), '{"v":1,"identity":');
    const registry = createRegistry({ storage: createFileStorage({ dir }) });
    const status = await registry.ready();
    assert.equal(status.ok, true);
    assert.equal(status.damaged, true);
    assert.deepEqual(readdirSync(dir), ['phones.json.damaged'], 'the old text is kept under another name');
    await registry.ensureIdentity();
    assert.ok(readdirSync(dir).includes('phones.json'));
    // A wrong version is damage too.
    const dir2 = tempDir();
    writeFileSync(path.join(dir2, 'phones.json'), JSON.stringify({ v: 99, devices: [] }));
    assert.equal((await createRegistry({ storage: createFileStorage({ dir: dir2 }) }).ready()).damaged, true);
    // A directory where the file should be cannot be read: nothing is created, and every change says why.
    const dir3 = tempDir();
    mkdirSync(path.join(dir3, 'phones.json'));
    const locked = createRegistry({ storage: createFileStorage({ dir: dir3 }) });
    const lockedStatus = await locked.ready();
    assert.equal(lockedStatus.ok, false);
    assert.equal(locked.available(), false);
    await assert.rejects(() => locked.ensureIdentity(), error => error.status === 503 && /phones file could not be read/.test(error.message));
    await assert.rejects(() => locked.add({ publicKey: key(3), name: 'x', counter: 0 }), error => error.status === 503);
  });

  test('the shell storage speaks phones-store-load and phones-store-save and reports what the desktop says', async () => {
    const calls = [];
    const reply = { load: { ok: true, storage: 'keychain', text: '', damaged: false }, save: { ok: true, storage: 'keychain' } };
    const registry = createRegistry({ storage: createShellStorage({ request: async (type, payload) => { calls.push([type, payload]); return type === 'phones-store-load' ? reply.load : reply.save; } }) });
    assert.equal((await registry.ready()).storage, 'keychain');
    await registry.ensureIdentity();
    assert.deepEqual(calls.map(c => c[0]), ['phones-store-load', 'phones-store-save']);
    assert.equal(typeof calls[1][1].text, 'string');
    assert.equal(JSON.parse(calls[1][1].text).v, 1);
    const refused = createRegistry({ storage: createShellStorage({ request: async () => ({ ok: false, storage: 'unavailable', message: 'Windows encryption is not available to this app.' }) }) });
    assert.equal((await refused.ready()).ok, false);
    assert.match(refused.status().message, /Windows encryption/);
    const silent = createRegistry({ storage: createShellStorage({ request: async () => { throw new Error('no answer'); } }) });
    assert.equal((await silent.ready()).ok, false);
    assert.match(silent.status().message, /did not answer/);
    const failingSave = createRegistry({ storage: createShellStorage({ request: async type => (type === 'phones-store-load' ? reply.load : { ok: false, message: 'The phones file is open in another program.' }) }) });
    await failingSave.ready();
    await assert.rejects(() => failingSave.ensureIdentity(), error => error.status === 503 && /open in another program/.test(error.message));
  });

  test('records that do not check out are dropped on load: a bad key goes, an unknown tier is read-only, the id is recomputed', async () => {
    const storage = createMemoryStorage();
    const registry = createRegistry({ storage });
    await registry.ready();
    await registry.ensureIdentity();
    await registry.add({ publicKey: key(7), name: 'Real', counter: 1 });
    const doc = JSON.parse(storage.text);
    doc.devices.push({ ...doc.devices[0], publicKey: 'zz'.repeat(32) });
    doc.devices.push({ ...doc.devices[0], publicKey: '0f'.repeat(32), id: 'f'.repeat(64), tier: 'admin', name: 'Odd' });
    doc.devices[0].tier = 'root';
    storage.text = JSON.stringify(doc);
    const reloaded = createRegistry({ storage });
    await reloaded.ready();
    const list = reloaded.list();
    assert.equal(list.length, 2, 'the record with a bad key is gone');
    assert.deepEqual(list.map(d => d.name).sort(), ['Odd', 'Real']);
    const odd = list.find(d => d.name === 'Odd');
    assert.equal(odd.id, noise.deviceId(noise.hexToBytes('0f'.repeat(32))), 'the id is recomputed from the key');
    assert.ok(list.every(d => d.tier === 'read'), 'an unknown tier is the least a phone can have');
  });

  test('handshake counters only rise, a failed save puts everything back, and the limit is 32 phones', async () => {
    const storage = createMemoryStorage();
    const registry = createRegistry({ storage });
    await registry.ready();
    await registry.ensureIdentity();
    const device = await registry.add({ publicKey: key(9), name: 'Counter', counter: 5 });
    await assert.rejects(() => registry.recordHandshake(device.id, 5, 'lan'), error => error.status === 409);
    await assert.rejects(() => registry.recordHandshake(device.id, 3, 'lan'), error => error.status === 409);
    await registry.recordHandshake(device.id, 6, 'tailscale');
    assert.equal(registry.counterOf(key(9)), 6);
    assert.equal(registry.get(device.id).lastCarrier, 'tailscale');
    storage.failNext = true;
    await assert.rejects(() => registry.recordHandshake(device.id, 9, 'lan'), error => error.status === 503);
    assert.equal(registry.counterOf(key(9)), 6, 'the counter that was not saved is not kept');
    storage.failNext = true;
    await assert.rejects(() => registry.update(device.id, { tier: 'read' }), error => error.status === 503);
    assert.equal(registry.get(device.id).tier, 'full');
    storage.failNext = true;
    await assert.rejects(() => registry.add({ publicKey: key(10), name: 'Not saved', counter: 0 }), error => error.status === 503);
    assert.equal(registry.get(noise.deviceId(key(10))), null, 'a phone whose record was not saved is not kept');
    for (let n = 11; n < 11 + 31; n++) await registry.add({ publicKey: key(n), name: `P${n}`, counter: 0 });
    assert.equal(registry.size(), 32);
    await assert.rejects(() => registry.add({ publicKey: key(99), name: 'One too many', counter: 0 }), error => error.status === 409 && /most phones/.test(error.message));
    await registry.add({ publicKey: key(9), name: 'Counter again', counter: 20 });
    assert.equal(registry.size(), 32, 'an existing phone can still be updated');
    await registry.add({ publicKey: key(9), name: 'Counter lower', counter: 7 });
    assert.equal(registry.counterOf(key(9)), 20, 'a phone added again with a lower counter keeps the higher one');
    await assert.rejects(() => registry.update('nobody', { tier: 'read' }), error => error.status === 404);
    await assert.rejects(() => registry.update(device.id, { tier: 'god' }), error => error.status === 400);
  });

  test('tiers, push subscriptions and the notification opt-in are kept per phone and announced', async () => {
    const registry = createRegistry({ storage: createMemoryStorage() });
    await registry.ready();
    await registry.ensureIdentity();
    const heard = [];
    registry.on('tier', e => heard.push(e));
    registry.on('removed', e => heard.push(['removed', e.id]));
    const d = await registry.add({ publicKey: key(1), name: 'A', counter: 0 });
    await registry.update(d.id, { tier: 'approve' });
    await registry.update(d.id, { tier: 'approve' });
    await registry.update(d.id, { approveFromNotifications: true, pushSubscription: { endpoint: 'https://p.example/x', keys: {} } });
    assert.deepEqual(heard, [{ id: d.id, tier: 'approve' }], 'a tier change is announced once');
    assert.equal(registry.get(d.id).push, 'webpush');
    assert.equal(registry.get(d.id).approveFromNotifications, true);
    assert.equal(registry.tierOf(d.id), 'approve');
    await assert.rejects(() => registry.update(d.id, { pushSubscription: 'x' }), error => error.status === 400);
    await registry.update(d.id, { pushSubscription: null });
    assert.equal(registry.get(d.id).push, null);
    assert.equal(registry.pushSubscriptionOf(d.id), null);
    await registry.remove(d.id);
    assert.deepEqual(heard.at(-1), ['removed', d.id]);
    assert.equal(registry.tierOf(d.id), null);
    assert.equal(await registry.remove(d.id), false);
  });

  test('phones not seen for their number of days are removed unless they are connected; zero means never', async () => {
    let wall = Date.UTC(2026, 0, 1);
    const registry = createRegistry({ storage: createMemoryStorage(), wallNow: () => wall });
    await registry.ready();
    await registry.ensureIdentity();
    const old = await registry.add({ publicKey: key(1), name: 'Old', counter: 0, expiresAfterDays: 90 });
    const live = await registry.add({ publicKey: key(2), name: 'Live', counter: 0, expiresAfterDays: 90 });
    const never = await registry.add({ publicKey: key(3), name: 'Never', counter: 0 });
    wall += 89 * 86_400_000;
    registry.touch(never.id);
    assert.deepEqual(await registry.sweepExpired(), [], '89 days is not 90');
    wall += 2 * 86_400_000;
    const gone = await registry.sweepExpired({ connected: id => id === live.id });
    assert.deepEqual(gone, [old.id]);
    assert.deepEqual(registry.list().map(d => d.name).sort(), ['Live', 'Never']);
    await registry.updateAll({ expiresAfterDays: 0 });
    wall += 3650 * 86_400_000;
    assert.deepEqual(await registry.sweepExpired(), []);
  });

  test('Remove all with a new key gives a new relay room id and host secret, and tells the listeners; the VAPID keys stay', async () => {
    const registry = createRegistry({ storage: createMemoryStorage() });
    await registry.ready();
    const before = await registry.ensureIdentity();
    const relay = await registry.ensureRelay();
    assert.equal((await registry.ensureRelay()).hostSecret, relay.hostSecret, 'made once');
    assert.match(relay.roomId, /^[0-9a-f]{32}$/);
    assert.match(relay.hostSecret, /^[0-9a-f]{64}$/);
    registry.vapidStore.save({ publicKey: 'pub', privateKey: 'priv' });
    await registry.add({ publicKey: key(1), name: 'A', counter: 0 });
    const events = [];
    registry.on('reset', e => events.push(e));
    const pathKey = registry.pathKey();
    const result = await registry.removeAll({ rotate: true });
    assert.equal(result.removed, 1);
    assert.notEqual(registry.pathKey(), pathKey);
    assert.notDeepEqual([...registry.identity().publicKey], [...before.publicKey]);
    assert.notEqual(registry.relay().hostSecret, relay.hostSecret);
    assert.notEqual(registry.relay().roomId, relay.roomId, 'the room id rotates too (F3): an idle old room cannot be claimed by someone who kept the id');
    assert.match(registry.relay().roomId, /^[0-9a-f]{32}$/);
    assert.match(registry.relay().hostSecret, /^[0-9a-f]{64}$/);
    assert.deepEqual(registry.vapidStore.load(), { publicKey: 'pub', privateKey: 'priv' });
    assert.deepEqual(events, [{ pathKey: registry.pathKey(), rotated: true }]);
    const keep = registry.pathKey();
    await registry.add({ publicKey: key(2), name: 'B', counter: 0 });
    const room = registry.relay();
    await registry.removeAll({ rotate: false });
    assert.equal(registry.pathKey(), keep, 'without a new key the address stays');
    assert.deepEqual(registry.relay(), room, 'and the relay room stays');
    assert.equal(registry.list().length, 0);
  });

  test('registry: newRelayRoom gives a new room id and host secret, tells the listeners, and puts the old room back when the save fails', async () => {
    const storage = createMemoryStorage();
    const registry = createRegistry({ storage });
    await registry.ready();
    await registry.ensureIdentity();
    assert.equal(registry.relay(), null, 'no relay yet');
    const heard = [];
    registry.on('relay-room', e => heard.push(e));
    const made = await registry.newRelayRoom();
    assert.match(made.roomId, /^[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(made), ['roomId'], 'only the room id comes back, never the host secret');
    assert.equal(registry.relay().roomId, made.roomId);
    assert.deepEqual(heard, [{}]);
    const one = registry.relay();
    const next = await registry.newRelayRoom();
    assert.notEqual(next.roomId, one.roomId);
    assert.notEqual(registry.relay().hostSecret, one.hostSecret);
    assert.equal(JSON.parse(storage.text).relay.roomId, next.roomId, 'saved before the call returns');
    assert.equal(heard.length, 2);
    storage.failNext = true;
    await assert.rejects(() => registry.newRelayRoom(), error => error.status === 503);
    assert.equal(registry.relay().roomId, next.roomId, 'the room that was not saved is not kept');
    assert.equal(heard.length, 2, 'and nobody is told');
  });

  test('registry: the stopKey survives save and load, is a fresh copy each time, goes with Remove, and a bad value on disk is dropped', async () => {
    const storage = createMemoryStorage();
    const registry = createRegistry({ storage });
    await registry.ready();
    await registry.ensureIdentity();
    const stop = new Uint8Array(32).map((_, i) => i + 1);
    const d = await registry.add({ publicKey: key(1), name: 'A', counter: 0, stopKey: stop });
    const none = await registry.add({ publicKey: key(2), name: 'B', counter: 0 });
    assert.deepEqual([...registry.stopKeyOf(d.id)], [...stop]);
    assert.equal(registry.stopKeyOf(none.id), null, 'a phone paired without one has none');
    assert.equal(registry.stopKeyOf('nobody'), null);
    assert.notEqual(registry.stopKeyOf(d.id), registry.stopKeyOf(d.id), 'a fresh Uint8Array each time');
    assert.equal('stopKey' in registry.list()[0], false, 'a device row carries no key');
    assert.equal('stopKey' in registry.get(d.id), false);
    const reloaded = createRegistry({ storage });
    await reloaded.ready();
    assert.deepEqual([...reloaded.stopKeyOf(d.id)], [...stop], 'it survives save and load');
    // setStopKey replaces it, and a failed save puts the old one back.
    const fresh = new Uint8Array(32).fill(9);
    await registry.setStopKey(d.id, fresh);
    assert.deepEqual([...registry.stopKeyOf(d.id)], [...fresh]);
    assert.equal(JSON.parse(storage.text).devices.find(x => x.name === 'A').stopKey, '09'.repeat(32));
    storage.failNext = true;
    await assert.rejects(() => registry.setStopKey(d.id, new Uint8Array(32).fill(3)), error => error.status === 503);
    assert.deepEqual([...registry.stopKeyOf(d.id)], [...fresh], 'the old key is back');
    await assert.rejects(() => registry.setStopKey('nobody', fresh), error => error.status === 404);
    await assert.rejects(() => registry.setStopKey(d.id, new Uint8Array(31)), error => error.status === 400);
    await assert.rejects(() => registry.setStopKey(d.id, 'x'), error => error.status === 400);
    // A phone with no key can be given one (the top-up).
    await registry.setStopKey(none.id, stop);
    assert.deepEqual([...registry.stopKeyOf(none.id)], [...stop]);
    // A value on disk that is not 64 lowercase hex is dropped.
    const doc = JSON.parse(storage.text);
    doc.devices.find(x => x.name === 'A').stopKey = 'ZZ'.repeat(32);
    doc.devices.find(x => x.name === 'B').stopKey = 'AB'.repeat(32);
    storage.text = JSON.stringify(doc);
    const damaged = createRegistry({ storage });
    await damaged.ready();
    assert.equal(damaged.stopKeyOf(d.id), null);
    assert.equal(damaged.stopKeyOf(none.id), null, 'upper-case hex is not what this code writes');
    // Remove deletes the record and with it the key; so does Remove all.
    await registry.remove(d.id);
    assert.equal(registry.stopKeyOf(d.id), null);
    assert.equal(JSON.stringify(JSON.parse(storage.text)).includes('09'.repeat(32)), false);
    await registry.removeAll({ rotate: true });
    assert.equal(registry.stopKeyOf(none.id), null);
    assert.equal(JSON.stringify(JSON.parse(storage.text).devices), '[]');
    // A pairing again with a record that had a key brings a new key, or none: the old one is not kept.
    await registry.add({ publicKey: key(1), name: 'A', counter: 0, stopKey: stop });
    await registry.add({ publicKey: key(1), name: 'A', counter: 0 });
    assert.equal(registry.stopKeyOf(noise.deviceId(key(1))), null);
  });
});
