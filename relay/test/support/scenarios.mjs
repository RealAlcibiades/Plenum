// The relay scenarios. Each one runs against a driver: the miniflare driver
// (the real Worker and Durable Object under workerd) or the fake runtime (the
// same Worker and class under an in-process stand-in for the Cloudflare
// runtime). The driver interface is documented in miniflare-driver.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesOf,
  connIdOf,
  control,
  framed,
  hashOf,
  hexRoom,
  hostHeaders,
  newSecret,
  unusedConn,
} from './frames.mjs';

const MAX_WIRE = 65540;
const MAX_PHONE = 65536;
const IDLE_MS = 30 * 24 * 60 * 60 * 1000;

// skip is false, or a reason string: node:test then reports every scenario as skipped with that reason and runs none of them.
export function scenarios(d, label, { skip = false } = {}) {
  const t = (name, fn) => test(`${label}: ${name}`, { skip }, fn);

  const storedOf = async (room) => (await d.hook(room, '/__test/storage')).json();

  t('the first host claims the room and a wrong secret is refused with 403', async () => {
    const room = hexRoom();
    const secret = newSecret();
    const host = await d.connect(room, hostHeaders(secret));
    assert.equal(await d.handshakeStatus(room, hostHeaders(newSecret())), 403);
    assert.equal(host.isOpen, true);
    host.close();
  });

  t('the room stores only the hash of the host secret', async () => {
    const room = hexRoom();
    const secret = newSecret();
    const host = await d.connect(room, hostHeaders(secret));
    const stored = await storedOf(room);
    assert.equal(stored.hostHash, hashOf(secret));
    assert.equal(JSON.stringify(stored).includes(secret), false);
    host.close();
  });

  t('a host with a missing, malformed or unknown role is refused with 403', async () => {
    const room = hexRoom();
    assert.equal(await d.handshakeStatus(room, { 'x-plenum-role': 'host' }), 403);
    assert.equal(await d.handshakeStatus(room, hostHeaders('short')), 403);
    assert.equal(await d.handshakeStatus(room, { 'x-plenum-role': 'admin' }), 403);
  });

  t('a second host with the same secret replaces the first and resets the phones', async () => {
    const room = hexRoom();
    const secret = newSecret();
    const first = await d.connect(room, hostHeaders(secret));
    const phone = await d.connect(room);
    const second = await d.connect(room, hostHeaders(secret));
    assert.deepEqual(await first.closed(), { code: 4003, reason: 'host-replaced' });
    assert.deepEqual(await phone.closed(), { code: 4004, reason: 'host-reset' });
    const fresh = await d.connect(room);
    fresh.send(bytesOf(3));
    assert.equal(connIdOf(await second.next()) !== 0, true);
    second.close();
    fresh.close();
  });

  t('phones are refused with host-offline while no host is connected', async () => {
    const phone = await d.connect(hexRoom());
    assert.deepEqual(await phone.closed(), { code: 4001, reason: 'host-offline' });
  });

  t('frames carry connection ids both ways and reach only their phone', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const a = await d.connect(room);
    const b = await d.connect(room);

    a.send(Buffer.from('from-a'));
    const inA = await host.next();
    const connA = connIdOf(inA);
    assert.equal(Buffer.from(inA).subarray(4).toString(), 'from-a');
    assert.notEqual(connA, 0);

    b.send(Buffer.from('from-b'));
    const connB = connIdOf(await host.next());
    assert.notEqual(connB, connA);

    host.send(framed(connA, 'to-a'));
    assert.equal(Buffer.from(await a.next()).toString(), 'to-a');
    assert.equal(await b.quiet(300), true);

    host.send(framed(connB, 'to-b'));
    assert.equal(Buffer.from(await b.next()).toString(), 'to-b');
    assert.equal(await a.quiet(300), true);

    host.send(framed(unusedConn([connA, connB]), 'nobody'));
    assert.equal(await a.quiet(300), true);
    assert.equal(await b.quiet(300), true);

    host.close();
    a.close();
    b.close();
  });

  t('a host disconnect closes every phone with host-offline', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const a = await d.connect(room);
    const b = await d.connect(room);
    host.close();
    assert.deepEqual(await a.closed(), { code: 4001, reason: 'host-offline' });
    assert.deepEqual(await b.closed(), { code: 4001, reason: 'host-offline' });
  });

  t('the room takes eight phones and the ninth gets 1008', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const phones = [];
    for (let i = 0; i < 8; i += 1) phones.push(await d.connect(room));
    const ninth = await d.connect(room);
    assert.deepEqual(await ninth.closed(), { code: 1008, reason: 'room-full' });
    for (const phone of phones) assert.equal(phone.isOpen, true);
    phones[0].send(Buffer.from('still-here'));
    assert.equal(Buffer.from(await host.next()).subarray(4).toString(), 'still-here');
    host.close();
    for (const phone of phones) phone.close();
  });

  t('rotate control replaces the stored host secret hash', async () => {
    const room = hexRoom();
    const first = newSecret();
    const next = newSecret();
    const host = await d.connect(room, hostHeaders(first));
    host.send(control({ op: 'rotate', secretHash: hashOf(next) }));
    await d.settle();
    assert.equal(await d.handshakeStatus(room, hostHeaders(first)), 403);
    const rotated = await d.connect(room, hostHeaders(next));
    assert.deepEqual(await host.closed(), { code: 4003, reason: 'host-replaced' });
    rotated.close();
  });

  t('kick control closes one phone with 4002 and leaves the others open', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const a = await d.connect(room);
    const b = await d.connect(room);
    a.send(Buffer.from('hi'));
    const connA = connIdOf(await host.next());
    host.send(control({ op: 'kick', conn: connA }));
    assert.deepEqual(await a.closed(), { code: 4002, reason: 'kicked' });
    assert.equal(b.isOpen, true);
    host.close();
    b.close();
  });

  t('a phone that closes is reported to the host with a closed control frame; a kicked phone is not', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const a = await d.connect(room);
    const b = await d.connect(room);
    a.send(Buffer.from('hi-a'));
    const connA = connIdOf(await host.next());
    b.send(Buffer.from('hi-b'));
    const connB = connIdOf(await host.next());
    a.close();
    const note = await host.next();
    assert.equal(connIdOf(note), 0, 'the report is control (conn 0)');
    assert.deepEqual(JSON.parse(Buffer.from(note).subarray(4).toString()), { op: 'closed', conn: connA });
    host.send(control({ op: 'kick', conn: connB }));
    assert.deepEqual(await b.closed(), { code: 4002, reason: 'kicked' });
    assert.equal(await host.quiet(300), true, 'a phone the host kicked is not reported back');
    host.close();
  });

  t('a phone frame over 65536 bytes closes the phone with 1009; the largest frames pass', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const tooBig = await d.connect(room);
    tooBig.send(bytesOf(MAX_PHONE + 1));
    assert.deepEqual(await tooBig.closed(), { code: 1009, reason: 'frame-too-big' });

    const largest = await d.connect(room);
    largest.send(bytesOf(MAX_PHONE));
    const forwarded = await host.next();
    assert.equal(forwarded.byteLength, MAX_WIRE);
    const conn = connIdOf(forwarded);

    host.send(framed(conn, bytesOf(MAX_PHONE)));
    assert.equal((await largest.next()).byteLength, MAX_PHONE);

    host.send(framed(conn, bytesOf(MAX_PHONE + 1)));
    assert.deepEqual(await host.closed(), { code: 1009, reason: 'frame-too-big' });
    largest.close();
  });

  t('a phone that sends more than 200 messages in one second is closed with 1008', async () => {
    const room = hexRoom();
    await d.hook(room, '/__test/freeze');
    const host = await d.connect(room, hostHeaders(newSecret()));
    const flooder = await d.connect(room);
    for (let i = 0; i < 200; i += 1) flooder.send(Buffer.from([i & 0xff]));
    for (let i = 0; i < 200; i += 1) await host.next();
    flooder.send(Buffer.from([1]));
    assert.deepEqual(await flooder.closed(), { code: 1008, reason: 'rate-limit' });
    host.close();
  });

  t('phone frames are capped at 2 MiB a second per phone connection; the 33rd 64 KiB frame closes that phone with 1008', async () => {
    const room = hexRoom();
    await d.hook(room, '/__test/freeze');
    const host = await d.connect(room, hostHeaders(newSecret()));
    const flooder = await d.connect(room);
    const bystander = await d.connect(room);
    for (let i = 0; i < 33; i += 1) flooder.send(bytesOf(MAX_PHONE));
    for (let i = 0; i < 32; i += 1) await host.next(10000);
    assert.deepEqual(await flooder.closed(), { code: 1008, reason: 'rate-limit' });
    assert.equal(await host.quiet(400), true, 'the refused 33rd frame is not forwarded');
    // The same second, another phone: its frame still reaches the host, and it stays open.
    bystander.send(Buffer.from('still-here'));
    assert.equal(Buffer.from(await host.next()).subarray(4).toString(), 'still-here');
    assert.equal(bystander.isOpen, true);
    host.close();
    bystander.close();
  });

  t('a phone over its byte budget does not close another phone', async () => {
    const room = hexRoom();
    await d.hook(room, '/__test/freeze');
    const host = await d.connect(room, hostHeaders(newSecret()));
    const flooder = await d.connect(room);
    const others = [await d.connect(room), await d.connect(room)];
    for (let i = 0; i < 33; i += 1) flooder.send(bytesOf(MAX_PHONE));
    for (let i = 0; i < 32; i += 1) await host.next(10000);
    assert.deepEqual(await flooder.closed(), { code: 1008, reason: 'rate-limit' });
    // Each of the others has its own 2 MiB for this second: 32 full frames each all reach the host, and neither is closed.
    for (const phone of others) {
      for (let i = 0; i < 32; i += 1) phone.send(bytesOf(MAX_PHONE));
    }
    for (let i = 0; i < 64; i += 1) await host.next(10000);
    assert.equal(others.every((phone) => phone.isOpen), true);
    assert.equal(await host.quiet(400), true);
    host.close();
    for (const phone of others) phone.close();
  });

  t('text ping gets pong from the runtime and never reaches the host', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const phone = await d.connect(room);
    phone.send('ping');
    assert.equal(await phone.next(), 'pong');
    assert.equal(await host.quiet(300), true);
    host.close();
    phone.close();
  });

  t('a text frame other than ping closes the sender with 1003', async () => {
    const room = hexRoom();
    const host = await d.connect(room, hostHeaders(newSecret()));
    const phone = await d.connect(room);
    phone.send('hello');
    assert.deepEqual(await phone.closed(), { code: 1003, reason: 'binary-only' });
    host.close();
  });

  t('frames still route after the object is evicted and restarted (hibernation)', async () => {
    const room = hexRoom();
    const secret = newSecret();
    const host = await d.connect(room, hostHeaders(secret));
    const phone = await d.connect(room);
    phone.send(Buffer.from('one'));
    const conn = connIdOf(await host.next());
    await d.restart(room);
    assert.equal(host.isOpen && phone.isOpen, true);
    phone.send(Buffer.from('two'));
    const again = await host.next();
    assert.equal(connIdOf(again), conn);
    assert.equal(Buffer.from(again).subarray(4).toString(), 'two');
    host.send(framed(conn, 'three'));
    assert.equal(Buffer.from(await phone.next()).toString(), 'three');
    assert.equal((await storedOf(room)).hostHash, hashOf(secret));
    host.close();
    phone.close();
  });

  t('the alarm clears an idle room after 30 days and keeps it before that, leaving only its host hash', async () => {
    const room = hexRoom();
    const secret = newSecret();
    const host = await d.connect(room, hostHeaders(secret));
    host.close();
    await d.settle();
    const stored = await storedOf(room);
    const alarm = await (await d.hook(room, '/__test/alarm-time')).json();
    assert.equal(alarm.alarm - stored.lastSeen, IDLE_MS);

    await d.hook(room, `/__test/offset?ms=${IDLE_MS - 60_000}`);
    await d.hook(room, '/__test/alarm');
    assert.equal((await storedOf(room)).hostHash, hashOf(secret));

    await d.hook(room, `/__test/offset?ms=${IDLE_MS + 60_000}`);
    await d.hook(room, '/__test/alarm');
    assert.deepEqual(await storedOf(room), { hostHash: hashOf(secret) });
  });

  t('after the 30-day alarm the room keeps its host hash: a different secret gets 403, the same secret is admitted', async () => {
    const room = hexRoom();
    const secret = newSecret();
    const host = await d.connect(room, hostHeaders(secret));
    host.close();
    await d.settle();
    await d.hook(room, `/__test/offset?ms=${IDLE_MS + 60_000}`);
    await d.hook(room, '/__test/alarm');
    assert.equal(await d.handshakeStatus(room, hostHeaders(newSecret())), 403);
    const again = await d.connect(room, hostHeaders(secret));
    assert.equal(again.isOpen, true);
    again.close();
  });

  t('the alarm never deletes a room with a connected host', async () => {
    const room = hexRoom();
    const secret = newSecret();
    const host = await d.connect(room, hostHeaders(secret));
    await d.hook(room, `/__test/offset?ms=${IDLE_MS + 60_000}`);
    await d.hook(room, '/__test/alarm');
    assert.equal((await storedOf(room)).hostHash, hashOf(secret));
    host.close();
  });

  t('GET /room/<id> without an upgrade answers 426', async () => {
    assert.equal((await d.httpGet(`/room/${hexRoom()}`)).status, 426);
    assert.equal((await d.httpGet('/room/not-a-room')).status, 426);
  });

  t('GET / serves the shell with the strict CSP', async () => {
    const response = await d.httpGet('/');
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self' wss:/);
    assert.match(csp, /img-src 'self' data:/);
    assert.doesNotMatch(csp, /unsafe/);
    // The page is the phone shell once the build has written relay/public (its title is Plenum), or the placeholder before that.
    const html = await response.text();
    assert.match(html, /<title>Plenum( relay)?<\/title>/);
  });

  t('every file the shell page and its manifest name is served, and /shell/<bundle name> is the root file of that name', async () => {
    const page = await d.httpGet('/');
    const html = await page.text();
    const named = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]).filter((u) => !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//'));
    const manifestResponse = await d.httpGet('/manifest.webmanifest');
    if (manifestResponse.status === 200) {
      const manifest = JSON.parse(await manifestResponse.text());
      for (const url of [manifest.start_url, ...(manifest.icons ?? []).map((i) => i.src)]) {
        if (typeof url === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(url)) named.push(url);
      }
    }
    for (const url of named) {
      const path = new URL(url, 'https://relay.test/').pathname;
      const response = await d.httpGet(path);
      assert.equal(response.status, 200, `${url} (${path}) is named by the page or the manifest and must be served`);
      await response.arrayBuffer();
    }
    // The UI page names its shell files /shell/<name>; they are the files of that name at the root, and nothing else is under /shell/.
    for (const name of ['boot.js', 'shell.js', 'channel.worker.js', 'styles.css']) {
      const root = await d.httpGet(`/${name}`);
      const alias = await d.httpGet(`/shell/${name}`);
      assert.equal(alias.status, root.status, `/shell/${name} follows /${name}`);
      if (root.status === 200) assert.equal(await alias.text(), await root.text());
      else await alias.arrayBuffer();
    }
    for (const path of ['/shell/', '/shell/app.js', '/shell/..%2Fsw.js', '/shell/sw.js', '/icons/']) {
      const response = await d.httpGet(path);
      assert.notEqual(response.status, 200, `${path} is not served`);
      await response.arrayBuffer();
    }
  });

  t('version.json, sw.js, unknown paths and bad methods', async () => {
    const version = await d.httpGet('/version.json');
    assert.equal(version.status, 200);
    assert.equal((await version.json()).protocol, '1.0');
    const sw = await d.httpGet('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await d.httpGet('/nope')).status, 404);
    assert.equal((await d.httpGet('/room/not-hex', { upgrade: true })).status, 404);
    assert.equal((await d.httpGet('/', { method: 'POST' })).status, 405);
  });
}
