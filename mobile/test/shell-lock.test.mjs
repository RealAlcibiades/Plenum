// The phone's lock, store and pairing parser (mob-10, phone security fix round, G3: S8, S9, SL4, SL5, SL7c). Node only, no browser.
// The store runs over a Map that keeps values as they are (kind 'web', so the device-key path runs). Run through the sealed runner:
//   node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id sec-g3 shell-lock.test.mjs

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gcm } from '@noble/ciphers/aes.js';
import { createLock, derivePinKey } from '../shell/lock.js';
import { createIdbKv, createStore, publicComputer } from '../shell/store.js';
import { parsePairingText, validatePayload } from '../shell/pairing.js';

const subtle = globalThis.crypto.subtle;
// Few iterations keep the suite fast; the bound in lock.js is min(PIN_MIN_ITERATIONS, iterations), so these records are in bounds.
const ITS = 2000;
const b64u = {
  enc: bytes => Buffer.from(bytes).toString('base64url'),
  dec: text => new Uint8Array(Buffer.from(String(text), 'base64url')),
};
const VERIFIER_AAD = new TextEncoder().encode('plenum-lock-verifier');

// A key-value back end over a Map. kind 'web', so the device key (a WebCrypto key) is stored and read back.
function memoryKv() {
  const map = new Map();
  return {
    kind: 'web',
    map,
    get: async key => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    delete: async key => { map.delete(key); },
    keys: async () => [...map.keys()],
  };
}

function rig({ now = () => 1_000_000, mono = () => 0, biometric = null, passkey = null, lockSubtle = subtle } = {}) {
  const store = createStore({ kv: memoryKv() });
  const lock = createLock({ store, iterations: ITS, now, mono, biometric, passkey, subtle: lockSubtle });
  return { store, lock };
}

// One computer this phone holds a key for: the record keeps its key as a plain b64url value, as after a pairing.
async function addComputer(store, id = 'c1') {
  const key = new Uint8Array(randomBytes(32));
  await store.put({ id, name: 'Home PC', desktopPub: b64u.enc(randomBytes(32)), myPriv: b64u.enc(key), carriers: [], counter: 0 });
  return key;
}

// An IndexedDB factory that records the options of every transaction. Requests and the transaction finish on later ticks, as they do.
function recordingIdb(calls) {
  const data = new Map();
  const later = fn => queueMicrotask(fn);
  const request = result => {
    const req = { result, error: null, onsuccess: null };
    later(() => req.onsuccess?.());
    return req;
  };
  return {
    open() {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      later(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction(name, mode, options) {
            calls.push({ mode, options });
            const tx = {
              error: null,
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: () => ({
                get: key => request(data.get(key)),
                put: (value, key) => { data.set(key, value); return request(key); },
                delete: key => { data.delete(key); return request(undefined); },
                getAllKeys: () => request([...data.keys()]),
              }),
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
}

describe('the PIN lock (S8, S9, SL4)', () => {
  test('setPin answers ok with the keys Map (S9): the caller keeps them, so connect works without a relock', async () => {
    const { store, lock } = rig();
    const key = await addComputer(store);
    const r = await lock.setPin('123456');
    assert.equal(r.ok, true);
    assert.ok(r.keys instanceof Map, 'the keys come back as a Map');
    assert.deepEqual(r.keys.get('c1'), key);
  });

  test('five unlockPin wrong calls at once count five failures, not one (S8: the count is serialised)', async () => {
    const { store, lock } = rig();
    await addComputer(store);
    await lock.setPin('123456');
    await Promise.all([1, 2, 3, 4, 5].map(() => lock.unlockPin('000000')));
    assert.equal((await store.meta.get('lock')).failures, 5);
  });

  test('a PIN record with 1 or 10^9 iterations answers damaged and is not derived (S8: bounded iterations)', async () => {
    const { store, lock } = rig();
    await addComputer(store);
    await lock.setPin('123456');
    const rec = await store.meta.get('pin');
    for (const iterations of [1, 1_000_000_000]) {
      await store.meta.put('pin', { ...rec, iterations });
      assert.equal((await lock.unlockPin('123456')).reason, 'damaged', `iterations ${iterations}`);
    }
  });

  test('a v2 PIN record with its device key gone answers damaged; the PBKDF2 key alone does not open the verifier (S8)', async () => {
    const { store, lock } = rig();
    await addComputer(store);
    await lock.setPin('123456');
    const rec = await store.meta.get('pin');
    assert.equal(rec.v, 2, 'a new PIN on this browser is a v2 record');
    const stretched = derivePinKey('123456', b64u.dec(rec.salt), rec.iterations);
    assert.throws(() => gcm(stretched, b64u.dec(rec.nonce), VERIFIER_AAD).decrypt(b64u.dec(rec.ct)), 'the PIN alone is not the key');
    await store.meta.remove('pin-device');
    assert.equal((await lock.unlockPin('123456')).reason, 'damaged');
  });

  test('a v1 PIN record unlocks with the right PIN, is moved to v2, and the keys still open', async () => {
    const { store } = rig();
    const key = await addComputer(store);
    // A v1 record: written without a device key (no WebCrypto), as before this round.
    const first = createLock({ store, iterations: ITS, subtle: null });
    assert.equal((await first.setPin('123456')).ok, true);
    assert.notEqual((await store.meta.get('pin')).v, 2);
    const lock = createLock({ store, iterations: ITS, subtle });
    const r = await lock.unlockPin('123456');
    assert.equal(r.ok, true);
    assert.deepEqual(r.keys.get('c1'), key);
    assert.equal((await store.meta.get('pin')).v, 2, 'the record is now v2');
    assert.equal(typeof (await store.get('c1')).myPriv, 'object', 'the key is wrapped under the device-mixed key');
    const again = await createLock({ store, iterations: ITS, subtle }).unlockPin('123456');
    assert.deepEqual(again.keys.get('c1'), key, 'a fresh lock opens the migrated record');
  });

  test('moving the wall clock past lockedUntil does not end a PIN wait inside the same lock', async () => {
    let wall = 1_000_000;
    let steady = 0;
    const { store, lock } = rig({ now: () => wall, mono: () => steady });
    await addComputer(store);
    await lock.setPin('123456');
    for (let i = 0; i < 5; i += 1) await lock.unlockPin('000000');
    wall += 120_000;
    const r = await lock.unlockPin('123456');
    assert.equal(r.reason, 'wait', 'the right PIN still waits');
    assert.equal(r.waitSec, 30);
    steady += 31_000;
    assert.equal((await lock.unlockPin('123456')).ok, true, 'the wait ends when its time has passed on the steady clock too');
  });

  test('disable in biometric mode asks the biometric check first; a failed check changes nothing (C12)', async () => {
    const asked = [];
    const biometric = { available: async () => true, verify: async reason => { asked.push(reason); return false; } };
    const { store, lock } = rig({ biometric });
    await store.meta.put('lock', { mode: 'biometric', failures: 0, lockedUntil: 0 });
    assert.deepEqual(await lock.disable(), { ok: false, reason: 'cancelled' });
    assert.deepEqual(asked, ['Turn off app lock for Plenum']);
    assert.equal((await store.meta.get('lock')).mode, 'biometric');
  });

  test('disable in biometric mode turns the lock off when the check passes', async () => {
    const biometric = { available: async () => true, verify: async () => true };
    const { store, lock } = rig({ biometric });
    await store.meta.put('lock', { mode: 'biometric', failures: 0, lockedUntil: 0 });
    assert.deepEqual(await lock.disable(), { ok: true });
    assert.equal((await store.meta.get('lock')).mode, 'off');
  });

  test('disable in passkey mode asks the passkey for its stored id first; a failed check changes nothing (C12)', async () => {
    const asked = [];
    const passkey = { available: async () => true, register: async () => 'unused', verify: async id => { asked.push(id); return false; } };
    const { store, lock } = rig({ passkey });
    await store.meta.put('passkey', { id: 'cred-1' });
    await store.meta.put('lock', { mode: 'passkey', failures: 0, lockedUntil: 0 });
    assert.deepEqual(await lock.disable(), { ok: false, reason: 'cancelled' });
    assert.deepEqual(asked, ['cred-1']);
    assert.equal((await store.meta.get('lock')).mode, 'passkey');
    assert.ok(await store.meta.get('passkey'), 'the passkey record is kept');
  });

  test('disable in PIN mode with the right PIN stores the keys plain and removes the PIN and the device key', async () => {
    const { store, lock } = rig();
    const key = await addComputer(store);
    await lock.setPin('123456');
    assert.deepEqual(await lock.disable({ pin: '123456' }), { ok: true });
    assert.equal((await store.get('c1')).myPriv, b64u.enc(key));
    assert.equal(await store.meta.get('pin'), undefined);
    assert.equal(await store.meta.get('pin-device'), undefined);
    assert.equal((await store.meta.get('lock')).mode, 'off');
  });
});

describe('the store (SL7c, C5)', () => {
  test('an IndexedDB write asks for a strict transaction (SL7c); a read does not', async () => {
    const calls = [];
    const kv = createIdbKv({ indexedDB: recordingIdb(calls) });
    await kv.put('k', 1);
    await kv.get('k');
    assert.deepEqual(calls.find(c => c.mode === 'readwrite').options, { durability: 'strict' });
    assert.equal(calls.find(c => c.mode === 'readonly').options, undefined);
  });

  test('publicComputer says stopReady only with a 43-character stop key and a 64-hex device id, and shows neither (C5)', () => {
    const stopKey = b64u.enc(randomBytes(32));
    const myDeviceId = randomBytes(32).toString('hex');
    const ready = publicComputer({ id: 'x', name: 'Home PC', stopKey, myDeviceId });
    assert.equal(ready.stopReady, true);
    assert.equal('stopKey' in ready, false, 'the Stop key is never in the public view');
    assert.equal('myDeviceId' in ready, false, 'the device id is never in the public view');
    assert.equal(publicComputer({ id: 'x', stopKey: stopKey.slice(0, 42), myDeviceId }).stopReady, false, 'a short key is not ready');
    assert.equal(publicComputer({ id: 'x', stopKey, myDeviceId: myDeviceId.toUpperCase() }).stopReady, false, 'an upper-case id is not ready');
    assert.equal(publicComputer({ id: 'x', stopKey }).stopReady, false, 'no device id is not ready');
  });
});

describe('the pairing text (SL5)', () => {
  const pub = () => b64u.enc(randomBytes(32));
  const base = () => ({ v: 1, pub: pub(), psk: pub(), offer: randomBytes(16).toString('hex'), ttl: 120, carriers: [{ kind: 'relay', url: 'wss://relay.example/room' }] });
  const linkOf = payload => `plenum://pair#${b64u.enc(new TextEncoder().encode(JSON.stringify(payload)))}`;

  test('a pairing text over 8192 characters is refused, even when it would otherwise parse', () => {
    const long = linkOf({ ...base(), name: 'x'.repeat(9000) });
    assert.ok(long.length > 8192);
    assert.throws(() => parsePairingText(long), err => err.code === 'not-plenum');
    assert.equal(parsePairingText(linkOf(base())).carriers[0].kind, 'relay', 'a normal link still parses');
  });

  test('validatePayload keeps one entry per kind, at most three, and four URLs an entry', () => {
    const urls = Array.from({ length: 6 }, (_, i) => `ws://192.168.1.2:${4000 + i}/b/${'1'.repeat(32)}`);
    const p = validatePayload({
      ...base(),
      carriers: [
        { kind: 'lan', urls },
        { kind: 'lan', urls: ['ws://192.168.1.9:1/b/1'] },
        { kind: 'relay', url: 'wss://relay.example/room' },
        { kind: 'tailscale', urls: ['wss://pc.tail.ts.net/b/1'] },
      ],
    });
    assert.deepEqual(p.carriers.map(c => c.kind), ['lan', 'relay', 'tailscale']);
    assert.deepEqual(p.carriers[0].urls, urls.slice(0, 4));
  });
});
