// Sealed suite for lib/remote/push.mjs (mob-08). Run with node --test under the
// sealed environment (see build/mobile/run.mjs). Uses a fake push service on
// 127.0.0.1 with a random port; nothing reaches a real push service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  aes128gcmEncrypt,
  buildPushText,
  createPusher,
  encryptPushPayload,
  firstLineOf,
  generateVapidKeys,
  normalizeSubscription,
  validVapidKeys,
  vapidAuthorization,
  MAX_PAYLOAD_BYTES,
  PAD_LONG,
  PAD_SHORT,
  RECORD_SIZE,
} from '../../lib/remote/push.mjs';
import { decryptPush, makePhone, startFakePushService } from './helpers/fake-push-service.mjs';

const HOUR = 3600 * 1000;

// RFC 8291 appendix A, the example's keys, salt and expected body.
const RFC = {
  plaintext: Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url'),
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function rfcEcdh() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(RFC.asPrivate, 'base64url'));
  return ecdh;
}

function deviceId(phone) {
  return crypto.createHash('sha256').update(phone.ecdh.getPublicKey(null, 'uncompressed')).digest('hex');
}

function harness({ phones, presence = { focused: false, idleS: 0 }, foregroundAt = {}, prefs, vapid, allowLocal = true }) {
  const state = {
    nowMs: Date.UTC(2026, 9, 22, 12, 0, 0),
    presence,
    foregroundAt,
    prefs: prefs ?? { approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false },
    logs: [],
    removed: [],
  };
  const devices = phones.map((phone) => ({
    id: deviceId(phone),
    name: phone.label,
    tier: 'full',
    approveFromNotifications: false,
    pushSubscription: null,
    phone,
  }));
  const pusher = createPusher({
    devices: { list: () => devices.filter((d) => d.pushSubscription) },
    removeSubscription: (id, endpoint) => {
      state.removed.push({ id, endpoint });
      const d = devices.find((x) => x.id === id);
      if (d) d.pushSubscription = null;
    },
    presence: async () => state.presence,
    foreground: (id) => state.foregroundAt[id] ?? 0,
    settings: () => ({ push: state.prefs, computer: { id: 'computer-opaque-1', name: 'Home PC' } }),
    log: (line) => state.logs.push(line),
    vapid,
    now: () => state.nowMs,
    allowLocalEndpoints: allowLocal,
  });
  return { state, devices, pusher };
}

test('RFC 8291 appendix A: keys, intermediates and the expected body match', () => {
  const ecdh = rfcEcdh();
  assert.equal(ecdh.getPublicKey(null, 'uncompressed').toString('base64url'), RFC.asPublic);
  const uaPublic = Buffer.from(RFC.uaPublic, 'base64url');
  const authSecret = Buffer.from(RFC.authSecret, 'base64url');
  const shared = ecdh.computeSecret(uaPublic);
  assert.equal(shared.toString('base64url'), RFC.ecdhSecret);
  assert.equal(crypto.createHmac('sha256', authSecret).update(shared).digest('base64url'), RFC.prkKey);
  const body = aes128gcmEncrypt({
    plaintext: RFC.plaintext,
    uaPublic,
    authSecret,
    salt: Buffer.from(RFC.salt, 'base64url'),
    asEcdh: rfcEcdh(),
  });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(body.readUInt32BE(16), 4096);
});

test('padding: ordinary payloads share one 2 KB bucket and the long bucket fits one record', () => {
  const phone = makePhone('pad');
  const sub = phone.subscription('https://push.example.test/x');
  const short = encryptPushPayload(Buffer.from('{"a":1}'), sub);
  const other = encryptPushPayload(Buffer.from('{"title":"Home PC · my-app","body":"An approval is waiting."}'), sub);
  assert.equal(short.length, other.length);
  assert.equal(short.length, 86 + PAD_SHORT + 16);
  const long = encryptPushPayload(Buffer.alloc(3000, 0x61), sub);
  assert.equal(long.length, 86 + PAD_LONG + 16);
  assert.ok(PAD_LONG + 16 <= RECORD_SIZE);
  assert.equal(decryptPush(short, phone).plaintext.toString(), '{"a":1}');
  assert.equal(decryptPush(long, phone).plaintext.length, 3000);
  assert.throws(() => encryptPushPayload(Buffer.alloc(4080, 0x61), sub), /larger than one record/);
});

test('VAPID keys are P-256 and the ES256 JWT verifies with the public key', () => {
  const keys = generateVapidKeys();
  assert.ok(validVapidKeys(keys));
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  assert.equal(validVapidKeys({ publicKey: keys.publicKey, privateKey: 'AAAA' }), false);
  const nowMs = Date.UTC(2026, 9, 22);
  const endpoint = 'https://fcm.example.test/send/abc';
  const auth = vapidAuthorization({ endpoint, keys, nowMs, contact: 'mailto:ops@example.test' });
  const match = /^vapid t=([^,]+), k=(\S+)$/.exec(auth);
  assert.ok(match);
  assert.equal(match[2], keys.publicKey);
  const [h, b, s] = match[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.example.test');
  assert.equal(claims.sub, 'mailto:ops@example.test');
  assert.ok(claims.exp - Math.floor(nowMs / 1000) <= 12 * 3600);
  const point = Buffer.from(keys.publicKey, 'base64url');
  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
});

test('subscriptions: https only, public hosts, exact key sizes, apns refused', () => {
  const phone = makePhone('v');
  const good = phone.subscription('https://fcm.example.test/send/1');
  assert.equal(normalizeSubscription(good).endpoint, 'https://fcm.example.test/send/1');
  assert.throws(() => normalizeSubscription(phone.subscription('http://fcm.example.test/1')), /https/);
  assert.throws(() => normalizeSubscription(phone.subscription('https://u:p@fcm.example.test/1')), /credentials/);
  assert.throws(() => normalizeSubscription(phone.subscription('https://localhost/1')), /public address/);
  assert.throws(() => normalizeSubscription(phone.subscription('https://10.0.0.5/1')), /public address/);
  assert.throws(() => normalizeSubscription(phone.subscription('https://[::1]/1')), /public address/);
  assert.throws(() => normalizeSubscription({ endpoint: good.endpoint, keys: { p256dh: 'AAAA', auth: good.keys.auth } }), /P-256|base64url/);
  assert.throws(() => normalizeSubscription({ endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh, auth: Buffer.alloc(15).toString('base64url') } }), /wrong size/);
  assert.throws(() => normalizeSubscription({ kind: 'apns-forwarder', endpoint: good.endpoint, keys: good.keys }), (e) => e.code === 'kind-unavailable');
  assert.throws(() => normalizeSubscription({ kind: 'carrier-pigeon', endpoint: good.endpoint, keys: good.keys }), /not known/);
  // 0x04 followed by 64 bytes that are not a point on P-256: the right shape, the wrong curve point
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0x11)]).toString('base64url');
  assert.throws(() => normalizeSubscription({ endpoint: good.endpoint, keys: { p256dh: offCurve, auth: good.keys.auth } }), /P-256/);
});

test('an off-curve push key fails that device alone; the device after it in the list is still sent', async () => {
  const service = await startFakePushService();
  try {
    const bad = makePhone('offcurve');
    const good = makePhone('oncurve');
    const h = harness({ phones: [bad, good], vapid: generateVapidKeys() });
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0x11)]).toString('base64url');
    h.devices[0].pushSubscription = { endpoint: service.endpointFor('offcurve'), keys: { p256dh: offCurve, auth: bad.auth.toString('base64url') } };
    h.devices[1].pushSubscription = good.subscription(service.endpointFor('oncurve'));
    const results = await h.pusher.sendEvent({ kind: 'finished', projectName: 'my-app', projectId: 'p1' });
    assert.equal(results[0].outcome, 'skipped');
    assert.equal(results[0].reason, 'invalid-subscription');
    assert.equal(results[1].outcome, 'sent');
    assert.equal(service.received.length, 1);
    assert.equal(JSON.parse(decryptPush(service.received[0].body, good).plaintext).body, 'The run finished.');
  } finally {
    await service.close();
  }
});

test('text: generic approval, opt-in first line, Approve only behind the switch and never on defaultDeny', () => {
  const computer = { id: 'c1', name: 'Home PC' };
  const base = { kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'a1', firstLine: 'npm test -- --watch=false' };
  const generic = buildPushText(base, { prefs: {}, device: { tier: 'full' }, computer });
  assert.equal(generic.payload.title, 'Home PC · my-app');
  assert.equal(generic.payload.body, 'An approval is waiting.');
  assert.equal(generic.urgency, 'high');
  assert.deepEqual(generic.payload.actions.map((a) => a.action), ['deny', 'stop']);
  assert.equal(JSON.stringify(generic.payload).includes('npm test'), false);

  const optIn = { firstLine: true };
  const withLine = buildPushText(base, { prefs: optIn, device: { tier: 'full', approveFromNotifications: false }, computer });
  assert.equal(withLine.payload.body, 'Waiting: npm test -- --watch=false');
  assert.deepEqual(withLine.payload.actions.map((a) => a.action), ['deny', 'stop']);

  const approve = buildPushText(base, { prefs: optIn, device: { tier: 'approve', approveFromNotifications: true }, computer });
  assert.deepEqual(approve.payload.actions.map((a) => a.action), ['deny', 'stop', 'approve']);
  assert.equal(approve.payload.actions[2].route, '/#approve=a1');
  assert.equal(approve.payload.firstLine, 'npm test -- --watch=false');

  const denied = buildPushText({ ...base, defaultDeny: true }, { prefs: optIn, device: { tier: 'full', approveFromNotifications: true }, computer });
  assert.equal(denied.payload.actions.some((a) => a.action === 'approve'), false);
  const readOnly = buildPushText(base, { prefs: optIn, device: { tier: 'read', approveFromNotifications: true }, computer });
  assert.equal(readOnly.payload.actions.some((a) => a.action === 'approve'), false);
  const noLine = buildPushText({ ...base, firstLine: '' }, { prefs: optIn, device: { tier: 'full', approveFromNotifications: true }, computer });
  assert.equal(noLine.payload.actions.some((a) => a.action === 'approve'), false);
});

test('text: several approvals share the tag, handover, finished, failed and limit copy', () => {
  const computer = { id: 'c1', name: 'Home PC' };
  const single = buildPushText({ kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'a1' }, { prefs: {}, computer });
  const several = buildPushText({ kind: 'approval', projectName: 'my-app', projectId: 'p1', count: 3 }, { prefs: {}, computer });
  assert.equal(several.payload.body, '3 approvals are waiting.');
  assert.equal(several.tag, single.tag);
  assert.deepEqual(several.payload.actions.map((a) => a.action), ['stop']);
  const other = buildPushText({ kind: 'approval', projectName: 'other', projectId: 'p2', approvalId: 'a9' }, { prefs: {}, computer });
  assert.notEqual(other.tag, single.tag);
  assert.equal(JSON.stringify(single.payload).includes('my-app'), true);
  assert.equal(JSON.stringify(single.payload.ids).includes('my-app'), false);

  const hand = buildPushText({ kind: 'handover', projectName: 'my-app', approvalId: 'h1', firstLine: 'Enter the 2FA code' }, { prefs: { firstLine: true }, computer });
  assert.equal(hand.payload.body, 'The model asks: "Enter the 2FA code"');
  assert.equal(hand.urgency, 'high');
  const handGeneric = buildPushText({ kind: 'handover', projectName: 'my-app', approvalId: 'h1' }, { prefs: {}, computer });
  assert.equal(handGeneric.payload.body, 'The model needs you to do a step.');

  const finished = buildPushText({ kind: 'finished', projectName: 'my-app', projectId: 'p1', firstLine: 'Fix the login redirect' }, { prefs: { firstLine: true }, computer });
  assert.equal(finished.payload.body, 'Finished: Fix the login redirect');
  assert.equal(finished.urgency, 'normal');
  assert.equal(finished.payload.tap, '/#chat=p1');
  const failed = buildPushText({ kind: 'failed', projectName: 'my-app' }, { prefs: {}, computer });
  assert.equal(failed.payload.body, 'The run failed.');
  const limit = buildPushText({ kind: 'limit', limitKind: 'plan' }, { prefs: { firstLine: true }, computer });
  assert.equal(limit.payload.body, 'A plan limit was reached.');
  assert.equal(limit.payload.title, 'Home PC');
  assert.equal(buildPushText({ kind: 'limit' }, { prefs: {}, computer }).payload.body, 'A spend limit was reached.');
});

test('firstLineOf takes one cleaned line and caps it at 120 characters', () => {
  assert.equal(firstLineOf('\n\n  first  \nsecond'), 'first');
  assert.equal(firstLineOf('a\u0007b c'), 'a b c');
  const long = firstLineOf('x'.repeat(500));
  assert.equal(Array.from(long).length, 121);
  assert.ok(long.endsWith('…'));
});

test('a generic push reaches the fake service, decrypts to generic text and carries the headers', async () => {
  const service = await startFakePushService();
  try {
    const phone = makePhone('a');
    const keys = generateVapidKeys();
    const { state, devices, pusher } = harness({ phones: [phone], vapid: keys });
    devices[0].pushSubscription = phone.subscription(service.endpointFor('a'));
    const results = await pusher.sendEvent({ kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'a1', firstLine: 'rm -rf build', defaultDeny: false });
    assert.equal(results[0].outcome, 'sent');
    assert.equal(service.received.length, 1);
    const req = service.received[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-encoding'], 'aes128gcm');
    assert.equal(req.headers.ttl, '3600');
    assert.equal(req.headers.urgency, 'high');
    assert.equal(req.headers.authorization.startsWith('vapid t='), true);
    assert.ok(req.headers.authorization.endsWith(`k=${keys.publicKey}`));
    const { plaintext } = decryptPush(req.body, phone);
    const payload = JSON.parse(plaintext.toString('utf8'));
    assert.equal(payload.title, 'Home PC · my-app');
    assert.equal(payload.body, 'An approval is waiting.');
    assert.equal(plaintext.toString('utf8').includes('rm -rf'), false);
    assert.equal(state.logs.some((l) => l.includes('rm -rf')), false);
  } finally {
    await service.close();
  }
});

test('firstLine on: the phone sees the first line; the default never does', async () => {
  const service = await startFakePushService();
  try {
    const phone = makePhone('b');
    const { devices, pusher } = harness({ phones: [phone], prefs: { approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: true }, vapid: generateVapidKeys() });
    devices[0].pushSubscription = phone.subscription(service.endpointFor('b'));
    const [result] = await pusher.sendEvent({ kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'a2', firstLine: 'npm test -- --watch=false\nsecond line' });
    assert.equal(result.outcome, 'sent');
    const payload = JSON.parse(decryptPush(service.received[0].body, phone).plaintext.toString('utf8'));
    assert.equal(payload.body, 'Waiting: npm test -- --watch=false');
    assert.equal(payload.firstLine, 'npm test -- --watch=false');
    assert.equal(JSON.stringify(payload).includes('second line'), false);
  } finally {
    await service.close();
  }
});

test('unifiedpush sends without VAPID; apns-forwarder is refused and never sent', async () => {
  const service = await startFakePushService();
  try {
    const phone = makePhone('u');
    const apns = makePhone('apns');
    const { devices, pusher, state } = harness({ phones: [phone, apns], vapid: generateVapidKeys() });
    devices[0].pushSubscription = phone.subscription(service.endpointFor('u'), { kind: 'unifiedpush' });
    devices[1].pushSubscription = { kind: 'apns-forwarder', endpoint: service.endpointFor('apns'), keys: { p256dh: 'AAAA', auth: 'AAAA' } };
    const results = await pusher.sendEvent({ kind: 'finished', projectName: 'my-app', projectId: 'p1' });
    assert.equal(results[0].outcome, 'sent');
    assert.equal(service.received[0].headers.authorization, undefined);
    assert.equal(results[1].outcome, 'refused');
    assert.equal(service.received.length, 1);
    assert.equal(state.removed.length, 0);
  } finally {
    await service.close();
  }
});

test('presence: no push while focused and idle under 2 minutes; the phone in front holds it for 30 s', async () => {
  const service = await startFakePushService();
  try {
    const phone = makePhone('p');
    const h = harness({ phones: [phone], vapid: generateVapidKeys(), presence: { focused: true, idleS: 30 } });
    h.devices[0].pushSubscription = phone.subscription(service.endpointFor('p'));
    const event = { kind: 'approval', projectName: 'my-app', approvalId: 'a3' };
    assert.equal((await h.pusher.sendEvent(event))[0].reason, 'at-computer');
    h.state.presence = { focused: true, idleS: 150 };
    assert.equal((await h.pusher.sendEvent(event))[0].outcome, 'sent');
    h.state.presence = { focused: false, idleS: 0 };
    assert.equal((await h.pusher.sendEvent(event))[0].outcome, 'sent');
    h.state.presence = { focused: true, idleS: 1 };
    h.state.foregroundAt[h.devices[0].id] = h.state.nowMs - 10_000;
    assert.equal((await h.pusher.sendEvent(event))[0].reason, 'at-computer');
    h.state.presence = { focused: false, idleS: 0 };
    assert.equal((await h.pusher.sendEvent(event))[0].reason, 'phone-foreground');
    h.state.foregroundAt[h.devices[0].id] = h.state.nowMs - 40_000;
    assert.equal((await h.pusher.sendEvent(event))[0].outcome, 'sent');
    h.state.presence = { focused: true, idleS: 1 };
    h.state.prefs = { ...h.state.prefs, onlyWhenAway: false };
    assert.equal((await h.pusher.sendEvent(event))[0].outcome, 'sent');
    h.state.prefs = { ...h.state.prefs, onlyWhenAway: true, approvals: false };
    assert.equal((await h.pusher.sendEvent(event))[0].reason, 'switch-off');
    const finished = await h.pusher.sendEvent({ kind: 'finished', projectName: 'my-app', projectId: 'p1' });
    assert.equal(finished[0].reason, 'at-computer');
    const testPush = await h.pusher.sendEvent({ kind: 'test' });
    assert.equal(testPush[0].outcome, 'sent');
  } finally {
    await service.close();
  }
});

test('410 and 404 remove the subscription; 413 does not', async () => {
  const service = await startFakePushService();
  try {
    const gone = makePhone('gone');
    const missing = makePhone('missing');
    const big = makePhone('big');
    service.setStatus('gone', 410);
    service.setStatus('missing', 404);
    service.setStatus('big', 413);
    const h = harness({ phones: [gone, missing, big], vapid: generateVapidKeys() });
    h.devices[0].pushSubscription = gone.subscription(service.endpointFor('gone'));
    h.devices[1].pushSubscription = missing.subscription(service.endpointFor('missing'));
    h.devices[2].pushSubscription = big.subscription(service.endpointFor('big'));
    const results = await h.pusher.sendEvent({ kind: 'finished', projectName: 'my-app', projectId: 'p1' });
    assert.equal(results[0].outcome, 'removed');
    assert.equal(results[1].outcome, 'removed');
    assert.equal(results[2].outcome, 'failed');
    assert.equal(h.devices[0].pushSubscription, null);
    assert.equal(h.devices[1].pushSubscription, null);
    assert.ok(h.devices[2].pushSubscription);
    assert.deepEqual(h.state.removed.map((r) => r.id), [h.devices[0].id, h.devices[1].id]);
    const again = await h.pusher.sendEvent({ kind: 'finished', projectName: 'my-app', projectId: 'p1' });
    assert.equal(again.length, 1);
    assert.equal(again[0].outcome, 'failed');
  } finally {
    await service.close();
  }
});

test('each device gets its own ciphertext that only its key opens; logs hold no secret', async () => {
  const service = await startFakePushService();
  try {
    const a = makePhone('ca');
    const b = makePhone('cb');
    const vapid = generateVapidKeys();
    const h = harness({ phones: [a, b], vapid });
    h.devices[0].pushSubscription = a.subscription(service.endpointFor('ca'));
    h.devices[1].pushSubscription = b.subscription(service.endpointFor('cb'));
    await h.pusher.sendEvent({ kind: 'finished', projectName: 'my-app', projectId: 'p1' });
    assert.equal(service.received.length, 2);
    const [first, second] = service.received;
    assert.notDeepEqual(first.body, second.body);
    assert.throws(() => decryptPush(first.body, b), /Unsupported state|bad|Record delimiter|authenticate/i);
    assert.equal(JSON.parse(decryptPush(first.body, a).plaintext).body, 'The run finished.');
    assert.equal(JSON.parse(decryptPush(second.body, b).plaintext).body, 'The run finished.');
    const everything = h.state.logs.join('\n') + JSON.stringify(h.devices.map((d) => d.pushSubscription));
    assert.equal(everything.includes(vapid.privateKey), false);
    assert.equal(h.state.logs.join('\n').includes(service.origin), false);
    assert.equal(h.state.logs.join('\n').includes(a.auth.toString('base64url')), false);
    assert.ok(h.state.logs.length >= 2);
  } finally {
    await service.close();
  }
});

test('the payload stays under 4000 bytes even with a 10 000 character first line', async () => {
  const service = await startFakePushService();
  try {
    const phone = makePhone('huge');
    const h = harness({ phones: [phone], vapid: generateVapidKeys(), prefs: { approvals: true, finished: true, limits: true, onlyWhenAway: false, firstLine: true } });
    h.devices[0].pushSubscription = phone.subscription(service.endpointFor('huge'));
    const [result] = await h.pusher.sendEvent({ kind: 'approval', projectName: 'my-app', approvalId: 'a4', firstLine: 'y'.repeat(10000) });
    assert.equal(result.outcome, 'sent');
    const plaintext = decryptPush(service.received[0].body, phone).plaintext;
    assert.ok(plaintext.length <= MAX_PAYLOAD_BYTES);
    assert.ok(JSON.parse(plaintext.toString('utf8')).body.length <= 130);
  } finally {
    await service.close();
  }
});

test('VAPID Authorization is cached per origin for an hour and refreshed after', async () => {
  const service = await startFakePushService();
  try {
    const phone = makePhone('cache');
    const h = harness({ phones: [phone], vapid: generateVapidKeys(), presence: { focused: false, idleS: 0 } });
    h.devices[0].pushSubscription = phone.subscription(service.endpointFor('cache'));
    const event = { kind: 'finished', projectName: 'my-app', projectId: 'p1' };
    await h.pusher.sendEvent(event);
    h.state.nowMs += 30 * 60 * 1000;
    await h.pusher.sendEvent(event);
    h.state.nowMs += 31 * 60 * 1000;
    await h.pusher.sendEvent(event);
    const [one, two, three] = service.received.map((r) => r.headers.authorization);
    assert.equal(one, two);
    assert.notEqual(two, three);
    const exp = (auth) => JSON.parse(Buffer.from(auth.split('t=')[1].split('.')[1], 'base64url').toString()).exp;
    assert.ok(exp(three) > exp(one));
    assert.ok(HOUR > 0);
  } finally {
    await service.close();
  }
});

test('a stored VAPID key that does not validate is refused, not silently replaced', () => {
  const vapidStore = { load: () => ({ publicKey: 'AAAA', privateKey: 'AAAA' }), save: () => { throw new Error('should not save'); } };
  assert.throws(() => createPusher({ devices: { list: () => [] }, vapidStore }), /damaged/);
});

test('production endpoints: plain http on loopback is refused outside the sealed tests', async () => {
  const service = await startFakePushService();
  try {
    const phone = makePhone('prod');
    const h = harness({ phones: [phone], vapid: generateVapidKeys(), allowLocal: false });
    h.devices[0].pushSubscription = phone.subscription(service.endpointFor('prod'));
    const [result] = await h.pusher.sendEvent({ kind: 'finished', projectName: 'my-app' });
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.reason, 'invalid-subscription');
    assert.equal(service.received.length, 0);
  } finally {
    await service.close();
  }
});
