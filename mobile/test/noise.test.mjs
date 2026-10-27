// mob-01: tests for lib/remote/noise.mjs (Noise_IK and Noise_IKpsk2, 25519 / ChaChaPoly / SHA256 on @noble).
// Run: node --test mobile/test/noise.test.mjs   (sealed: build/mobile/run.mjs noise.test.mjs)
// Needs @noble/curves, @noble/ciphers, @noble/hashes 2.4.0 and esbuild 0.28.2 resolvable from this folder or the project root.
// Node only, no network, no files outside the project, nothing logged.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import * as N from '../../lib/remote/noise.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOISE_PATH = path.resolve(here, '../../lib/remote/noise.mjs');
const VECTOR_DIR = path.join(here, 'vectors');

const hex = N.hexToBytes;
const toHex = N.bytesToHex;
const utf8 = (s) => new TextEncoder().encode(s);
const unutf8 = (b) => new TextDecoder().decode(b);

/** Asserts `fn` throws a NoiseError with this code and exactly the fixed sentence for it. */
function throwsNoise(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof N.NoiseError, 'a NoiseError, got ' + (err && err.name));
    assert.equal(err.code, code);
    assert.equal(err.message, N.ERROR_MESSAGES[code]);
    return true;
  });
}

/** A `random` that hands out the given 32-byte keys in order (a fresh copy each call, as the contract requires). */
function seq(...keys) {
  let i = 0;
  return (n) => {
    assert.equal(n, 32);
    assert.ok(i < keys.length, 'random called more often than expected');
    return new Uint8Array(keys[i++]);
  };
}
const fill32 = (b) => new Uint8Array(32).fill(b);

// A fake monotonic clock for the cookie issuer.
function clock(start = 1000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}

/** A complete handshake between fresh random keys. Returns both sessions and the pieces. */
function connect({ psk, carrier = 'lan', offer, payload1 = utf8('one'), payload2 = utf8('two') } = {}) {
  const phone = N.generateKeyPair();
  const desktop = N.generateKeyPair();
  const pro = N.prologue(carrier, offer);
  const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro, psk });
  const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, psk });
  const m1 = i.writeMessage1(payload1);
  const got1 = r.readMessage1(m1);
  const m2 = r.writeMessage2(payload2);
  const got2 = i.readMessage2(m2);
  return { phone, desktop, i, r, m1, m2, got1, got2, si: i.finish(), sr: r.finish() };
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe('published vectors (cacophony, noise-c)', () => {
  const files = fs.readdirSync(VECTOR_DIR).filter((f) => f.endsWith('.json')).sort();
  const all = [];
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, f), 'utf8'));
    assert.ok(doc.source && doc.source.repository && doc.source.licence, f + ' carries its attribution');
    for (const v of doc.vectors) all.push({ file: f, v, name: v.name || v.protocol_name });
  }

  test('both required suites are present and nothing else was vendored', () => {
    const names = all.map((x) => x.name);
    assert.ok(names.includes(N.PROTOCOL_IK));
    assert.ok(names.includes(N.PROTOCOL_IKPSK2));
    for (const n of names) assert.ok(n === N.PROTOCOL_IK || n === N.PROTOCOL_IKPSK2, n);
  });

  for (const { file, v, name } of all) {
    test(file + ' / ' + name, () => {
      const pskI = v.init_psks ? hex(v.init_psks[0]) : undefined;
      const pskR = v.resp_psks ? hex(v.resp_psks[0]) : undefined;
      assert.equal(name === N.PROTOCOL_IKPSK2, Boolean(pskI), 'psk present exactly for IKpsk2');
      // the vector's remote static is the public key of the responder's static private key
      assert.equal(toHex(N.publicKeyOf(hex(v.resp_static))), v.init_remote_static);

      const i = N.handshakeInitiator({
        staticPrivate: hex(v.init_static), remoteStaticPublic: hex(v.init_remote_static), prologue: hex(v.init_prologue), psk: pskI,
        random: seq(hex(v.init_ephemeral)),
      });
      const r = N.handshakeResponder({
        staticPrivate: hex(v.resp_static), prologue: hex(v.resp_prologue), psk: pskR, random: seq(hex(v.resp_ephemeral)),
      });
      assert.equal(i.protocol, name);
      assert.equal(r.protocol, name);

      const [m0, m1] = v.messages;
      const w1 = i.writeMessage1(hex(m0.payload));
      assert.equal(toHex(w1), m0.ciphertext, 'message 1 bytes');
      assert.equal(toHex(r.readMessage1(w1)), m0.payload);
      assert.equal(toHex(r.remoteStatic), toHex(N.publicKeyOf(hex(v.init_static))), 'responder learned the initiator static key');

      const w2 = r.writeMessage2(hex(m1.payload));
      assert.equal(toHex(w2), m1.ciphertext, 'message 2 bytes');
      assert.equal(toHex(i.readMessage2(w2)), m1.payload);

      const si = i.finish();
      const sr = r.finish();
      assert.equal(toHex(si.handshakeHash), v.handshake_hash);
      assert.equal(toHex(sr.handshakeHash), v.handshake_hash);
      assert.equal(toHex(si.remoteStatic), v.init_remote_static);

      for (let k = 2; k < v.messages.length; k++) {
        const [from, to] = k % 2 === 0 ? [si, sr] : [sr, si];
        const ct = from.send.encrypt(hex(v.messages[k].payload));
        assert.equal(toHex(ct), v.messages[k].ciphertext, 'transport message ' + k);
        assert.equal(toHex(to.recv.decrypt(ct)), v.messages[k].payload);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('handshake behaviour', () => {
  test('IK: payloads, transport both ways, matching hash, sas and push key', () => {
    const c = connect();
    assert.equal(unutf8(c.got1), 'one');
    assert.equal(unutf8(c.got2), 'two');
    assert.equal(c.si.protocol, N.PROTOCOL_IK);
    assert.equal(toHex(c.si.handshakeHash), toHex(c.sr.handshakeHash));
    assert.equal(c.si.handshakeHash.length, 32);
    assert.equal(toHex(c.si.remoteStatic), toHex(c.desktop.publicKey));
    assert.equal(toHex(c.sr.remoteStatic), toHex(c.phone.publicKey));
    assert.equal(N.sas(c.si.handshakeHash), N.sas(c.sr.handshakeHash));
    assert.equal(toHex(N.pushKey(c.si.handshakeHash)), toHex(N.pushKey(c.sr.handshakeHash)));
    assert.equal(unutf8(c.sr.recv.decrypt(c.si.send.encrypt(utf8('phone to desktop')))), 'phone to desktop');
    assert.equal(unutf8(c.si.recv.decrypt(c.sr.send.encrypt(utf8('desktop to phone')))), 'desktop to phone');
    assert.equal(c.si.send.nonce, 1n);
    assert.equal(c.sr.recv.nonce, 1n);
  });

  test('IKpsk2: same checks while pairing, with an offer id in the prologue', () => {
    const psk = crypto.randomBytes(32);
    const offer = crypto.randomBytes(16).toString('hex');
    const c = connect({ psk: new Uint8Array(psk), carrier: 'tailscale', offer });
    assert.equal(c.si.protocol, N.PROTOCOL_IKPSK2);
    assert.equal(toHex(c.si.handshakeHash), toHex(c.sr.handshakeHash));
    assert.equal(N.sas(c.si.handshakeHash), N.sas(c.sr.handshakeHash));
    assert.equal(unutf8(c.si.recv.decrypt(c.sr.send.encrypt(utf8('after allow')))), 'after allow');
  });

  test('IKpsk2: a different pairing secret fails on the phone at message 2 with the fixed error', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan', '00112233445566778899aabbccddeeff');
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro, psk: fill32(1) });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, psk: fill32(2) });
    r.readMessage1(i.writeMessage1(utf8('hi')));
    const m2 = r.writeMessage2(utf8('hello'));
    throwsNoise(() => i.readMessage2(m2), 'HANDSHAKE');
    throwsNoise(() => i.finish(), 'DEAD');
  });

  test('the phone and desktop reach different handshake hashes and sas values in different sessions', () => {
    const a = connect();
    const b = connect();
    assert.notEqual(toHex(a.si.handshakeHash), toHex(b.si.handshakeHash));
    assert.notEqual(toHex(N.pushKey(a.si.handshakeHash)), toHex(N.pushKey(b.si.handshakeHash)));
  });

  test('prologue mismatch (carrier) fails message 1 with the fixed error and kills the handshake', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: N.prologue('lan') });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: N.prologue('relay') });
    const m1 = i.writeMessage1(utf8('x'));
    throwsNoise(() => r.readMessage1(m1), 'HANDSHAKE');
    throwsNoise(() => r.writeMessage2(utf8('y')), 'DEAD');
    throwsNoise(() => r.finish(), 'DEAD');
  });

  test('prologue mismatch (offer id) fails in IKpsk2 as well', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const i = N.handshakeInitiator({
      staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: N.prologue('lan', '11'.repeat(16)), psk: fill32(9),
    });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: N.prologue('lan', '22'.repeat(16)), psk: fill32(9) });
    throwsNoise(() => r.readMessage1(i.writeMessage1(utf8('x'))), 'HANDSHAKE');
  });

  test('prologue mismatch (known-device session against a pairing prologue) fails', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: N.prologue('lan') });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: N.prologue('lan', '33'.repeat(16)) });
    throwsNoise(() => r.readMessage1(i.writeMessage1(utf8('x'))), 'HANDSHAKE');
  });

  test('a phone that expects a different desktop key cannot complete message 1', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const other = N.generateKeyPair();
    const pro = N.prologue('relay');
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: other.publicKey, prologue: pro });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    throwsNoise(() => r.readMessage1(i.writeMessage1(utf8('x'))), 'HANDSHAKE');
  });

  test('steps out of order are refused without damaging the handshake', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan');
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    throwsNoise(() => i.readMessage2(new Uint8Array(60)), 'STATE');
    throwsNoise(() => i.finish(), 'STATE');
    throwsNoise(() => r.writeMessage2(utf8('x')), 'STATE');
    const m1 = i.writeMessage1(utf8('a'));
    throwsNoise(() => i.writeMessage1(utf8('a')), 'STATE');
    assert.equal(i.complete, false);
    r.readMessage1(m1);
    throwsNoise(() => r.readMessage1(m1), 'STATE');
    const m2 = r.writeMessage2(utf8('b'));
    i.readMessage2(m2);
    assert.equal(i.complete, true);
    assert.equal(r.complete, true);
    i.finish();
    r.finish();
    throwsNoise(() => i.finish(), 'DEAD');
    throwsNoise(() => r.writeMessage2(utf8('x')), 'DEAD');
  });

  test('a flipped byte anywhere in message 1 or message 2 fails with the fixed error', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan');
    const mk = () => ({
      i: N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro }),
      r: N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro }),
    });
    const base = mk();
    const m1 = base.i.writeMessage1(utf8('payload'));
    for (let p = 0; p < m1.length; p++) {
      const { r } = mk();
      const bad = new Uint8Array(m1);
      bad[p] ^= 0x01;
      throwsNoise(() => r.readMessage1(bad), 'HANDSHAKE');
    }
    base.r.readMessage1(m1);
    const m2 = base.r.writeMessage2(utf8('reply'));
    for (let p = 0; p < m2.length; p++) {
      const i2 = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
      const r2 = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
      const x1 = i2.writeMessage1(utf8('payload'));
      r2.readMessage1(x1);
      const x2 = r2.writeMessage2(utf8('reply'));
      const bad = new Uint8Array(x2);
      bad[p] ^= 0x80;
      throwsNoise(() => i2.readMessage2(bad), 'HANDSHAKE');
    }
  });

  test('truncated, empty and oversized handshake input fails with the fixed error', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan');
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
    const m1 = i.writeMessage1(new Uint8Array(0));
    assert.equal(m1.length, 96); // e (32) + encrypted s (48) + payload tag (16)
    for (const len of [0, 1, 31, 32, 79, 80, 95]) {
      const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
      throwsNoise(() => r.readMessage1(m1.slice(0, len)), 'HANDSHAKE');
    }
    const big = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    throwsNoise(() => big.readMessage1(new Uint8Array(65536)), 'HANDSHAKE');
    const notBytes = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    throwsNoise(() => notBytes.readMessage1('text'), 'ARG');
  });

  test('a low-order or all-zero ephemeral key in message 1 is refused', () => {
    const desktop = N.generateKeyPair();
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: N.prologue('lan') });
    throwsNoise(() => r.readMessage1(new Uint8Array(96)), 'HANDSHAKE');
  });

  test('garbage input only ever produces fixed NoiseErrors', () => {
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan');
    const known = new Set(Object.values(N.ERROR_MESSAGES));
    for (let n = 0; n < 300; n++) {
      const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, psk: n % 2 ? fill32(3) : undefined });
      try {
        r.readMessage1(new Uint8Array(crypto.randomBytes(1 + (n * 7) % 220)));
        assert.fail('garbage must not be accepted');
      } catch (err) {
        assert.ok(err instanceof N.NoiseError, 'a NoiseError, got ' + err.name);
        assert.ok(known.has(err.message));
      }
    }
  });

  test('message size cap: payloads that would make a handshake message exceed 65535 bytes are refused first and can be retried', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan');
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    throwsNoise(() => i.writeMessage1(new Uint8Array(65440)), 'TOO_BIG'); // 96 bytes of overhead
    const m1 = i.writeMessage1(new Uint8Array(65439));
    assert.equal(m1.length, 65535);
    assert.equal(r.readMessage1(m1).length, 65439);
    throwsNoise(() => r.writeMessage2(new Uint8Array(65488)), 'TOO_BIG'); // 48 bytes of overhead
    const m2 = r.writeMessage2(new Uint8Array(65487));
    assert.equal(m2.length, 65535);
    assert.equal(i.readMessage2(m2).length, 65487);
    i.finish();
    r.finish();
  });

  test('key arguments are validated with the fixed key sentence', () => {
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan');
    throwsNoise(() => N.handshakeInitiator({ staticPrivate: new Uint8Array(31), remoteStaticPublic: desktop.publicKey, prologue: pro }), 'KEY');
    throwsNoise(() => N.handshakeInitiator({ staticPrivate: fill32(1), remoteStaticPublic: new Uint8Array(33), prologue: pro }), 'KEY');
    throwsNoise(() => N.handshakeInitiator({ staticPrivate: fill32(1), remoteStaticPublic: desktop.publicKey, prologue: pro, psk: new Uint8Array(16) }), 'KEY');
    throwsNoise(() => N.handshakeResponder({ staticPrivate: 'nope', prologue: pro }), 'KEY');
    throwsNoise(() => N.handshakeResponder({ staticPrivate: fill32(1), prologue: 'text' }), 'ARG');
    throwsNoise(() => N.handshakeResponder(null), 'ARG');
    throwsNoise(() => N.handshakeResponder({ staticPrivate: fill32(1), prologue: pro, lastCounter: 5 }), 'ARG');
    throwsNoise(() => N.handshakeInitiator({ staticPrivate: fill32(1), remoteStaticPublic: desktop.publicKey, prologue: pro, random: () => new Uint8Array(5) })
      .writeMessage1(new Uint8Array(0)), 'RANDOM');
  });

  test('inputs are copied: changing a caller buffer after the call does not change the handshake', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const priv = new Uint8Array(phone.privateKey);
    const pro = N.prologue('lan');
    const i = N.handshakeInitiator({ staticPrivate: priv, remoteStaticPublic: desktop.publicKey, prologue: pro });
    priv.fill(0);
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    r.readMessage1(i.writeMessage1(utf8('a')));
    assert.equal(toHex(r.remoteStatic), toHex(phone.publicKey));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('handshake replay counter', () => {
  const desktop = N.generateKeyPair();
  const phone = N.generateKeyPair();
  const pro = N.prologue('lan');
  const store = new Map(); // device public key hex -> highest counter seen
  store.set(toHex(phone.publicKey), 4); // this phone was paired earlier, so IK knows it and its counter is stored

  const msg1 = (counter, extra = {}) => {
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
    return i.writeMessage1(utf8(JSON.stringify({ v: '1.0', kind: 'session', counter, device: { name: 'Test' }, ...extra })));
  };
  const accept = (m1) => {
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, lastCounter: (pub) => store.get(toHex(pub)) });
    const payload = r.readMessage1(m1);
    store.set(toHex(r.remoteStatic), r.counter); // the Bridge stores the counter before it answers
    return { r, payload };
  };

  test('IKpsk2 first contact (pairing, no stored counter) is accepted at any valid counter, and the counter is exposed', () => {
    const pairing = N.generateKeyPair();
    const offer = N.prologue('lan', '55'.repeat(16));
    const psk = fill32(7);
    const i = N.handshakeInitiator({ staticPrivate: pairing.privateKey, remoteStaticPublic: desktop.publicKey, prologue: offer, psk });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: offer, psk, lastCounter: (pub) => store.get(toHex(pub)) });
    const payload = r.readMessage1(i.writeMessage1(utf8(JSON.stringify({ v: '1.0', kind: 'pair', counter: 5 }))));
    assert.equal(r.counter, 5);
    assert.equal(JSON.parse(unutf8(payload)).counter, 5);
    assert.equal(r.writeMessage2(utf8('{}')).length, 48 + 2); // e (32) + 2 payload bytes + tag (16)
  });

  test('IK: a phone with no stored counter (never paired, or removed by returning undefined or null) is refused with UNKNOWN', () => {
    for (const lastCounter of [() => undefined, () => null]) {
      const stranger = N.generateKeyPair();
      const i = N.handshakeInitiator({ staticPrivate: stranger.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
      const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, lastCounter });
      throwsNoise(() => r.readMessage1(i.writeMessage1(utf8(JSON.stringify({ counter: 99 })))), 'UNKNOWN');
      assert.equal(r.counter, null);
      throwsNoise(() => r.writeMessage2(utf8('x')), 'DEAD'); // nothing can be answered after the refusal
    }
  });

  test('the same message 1 replayed with the same counter is refused', () => {
    const again = msg1(6);
    accept(again);
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, lastCounter: (pub) => store.get(toHex(pub)) });
    throwsNoise(() => r.readMessage1(again), 'REPLAY');
    throwsNoise(() => r.writeMessage2(utf8('x')), 'DEAD'); // a refused replay leaves nothing to continue
  });

  test('an equal counter from a fresh message 1 and a lower counter are refused', () => {
    const last = store.get(toHex(phone.publicKey));
    for (const c of [last, last - 1, 0]) {
      const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, lastCounter: (pub) => store.get(toHex(pub)) });
      throwsNoise(() => r.readMessage1(msg1(c)), 'REPLAY');
    }
  });

  test('a higher counter is accepted, including a large jump', () => {
    const last = store.get(toHex(phone.publicKey));
    accept(msg1(last + 1));
    assert.equal(store.get(toHex(phone.publicKey)), last + 1);
    accept(msg1(1_000_000));
    assert.equal(store.get(toHex(phone.publicKey)), 1_000_000);
    accept(msg1(Number.MAX_SAFE_INTEGER));
  });

  test('a payload without a usable counter is refused with PAYLOAD', () => {
    const mk = (bytes) => {
      const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
      return i.writeMessage1(bytes);
    };
    const bodies = [
      utf8('not json'), utf8('null'), utf8('[]'), utf8('{}'), utf8('{"counter":"7"}'), utf8('{"counter":-1}'), utf8('{"counter":1.5}'),
      utf8('{"counter":1e999}'), new Uint8Array([0xff, 0xfe, 0xfd]), new Uint8Array(0),
    ];
    for (const b of bodies) {
      const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, lastCounter: () => undefined });
      throwsNoise(() => r.readMessage1(mk(b)), 'PAYLOAD');
    }
  });

  test('checkCounter is strict and total', () => {
    assert.equal(N.checkCounter(undefined, 0), 0);
    assert.equal(N.checkCounter(null, 3), 3);
    assert.equal(N.checkCounter(3, 4), 4);
    throwsNoise(() => N.checkCounter(3, 3), 'REPLAY');
    throwsNoise(() => N.checkCounter(3, 2), 'REPLAY');
    throwsNoise(() => N.checkCounter(3, -1), 'PAYLOAD');
    throwsNoise(() => N.checkCounter(3, 2.5), 'PAYLOAD');
    throwsNoise(() => N.checkCounter(3, '4'), 'PAYLOAD');
    throwsNoise(() => N.checkCounter(-2, 4), 'ARG');
  });

  test('without lastCounter the core does not interpret the payload (vectors use arbitrary bytes)', () => {
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
    assert.equal(unutf8(r.readMessage1(i.writeMessage1(utf8('plain text')))), 'plain text');
    assert.equal(r.counter, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('CipherState', () => {
  const key = () => new Uint8Array(32).map((_, i) => i + 1);

  test('round trip, empty and keyless states, key copied on the way in', () => {
    const k = key();
    const a = new N.CipherState(k);
    const b = new N.CipherState(key());
    k.fill(0);
    assert.equal(a.hasKey(), true);
    assert.equal(unutf8(b.decrypt(a.encrypt(utf8('hello')))), 'hello');
    assert.equal(b.decrypt(a.encrypt(new Uint8Array(0))).length, 0);
    const none = new N.CipherState();
    assert.equal(none.hasKey(), false);
    assert.equal(unutf8(none.encrypt(utf8('plain'))), 'plain'); // pass-through per spec
    throwsNoise(() => new N.CipherState(new Uint8Array(16)), 'KEY');
  });

  test('associated data is authenticated', () => {
    const a = new N.CipherState(key());
    const b = new N.CipherState(key());
    const ct = a.encryptWithAd(utf8('ad'), utf8('m'));
    throwsNoise(() => b.decryptWithAd(utf8('AD'), ct), 'AUTH');
    assert.equal(unutf8(b.decryptWithAd(utf8('ad'), ct)), 'm');
  });

  test('every single-bit tamper fails with the fixed error and the nonce does not advance', () => {
    const a = new N.CipherState(key());
    const b = new N.CipherState(key());
    const ct = a.encrypt(utf8('twenty bytes of text'));
    for (let p = 0; p < ct.length; p++) {
      for (const bit of [0x01, 0x80]) {
        const bad = new Uint8Array(ct);
        bad[p] ^= bit;
        throwsNoise(() => b.decrypt(bad), 'AUTH');
        assert.equal(b.nonce, 0n, 'nonce stayed at 0 after a failed decrypt');
      }
    }
    assert.equal(unutf8(b.decrypt(ct)), 'twenty bytes of text'); // the untouched message still decrypts at nonce 0
    assert.equal(b.nonce, 1n);
  });

  test('too-short input (under one tag) is an AUTH failure and does not advance', () => {
    const b = new N.CipherState(key());
    for (const len of [0, 1, 15]) throwsNoise(() => b.decrypt(new Uint8Array(len)), 'AUTH');
    assert.equal(b.nonce, 0n);
  });

  test('replayed, dropped and reordered transport messages are refused', () => {
    const a = new N.CipherState(key());
    const b = new N.CipherState(key());
    const c0 = a.encrypt(utf8('0'));
    const c1 = a.encrypt(utf8('1'));
    const c2 = a.encrypt(utf8('2'));
    throwsNoise(() => b.decrypt(c1), 'AUTH'); // out of order: expects nonce 0
    assert.equal(unutf8(b.decrypt(c0)), '0');
    throwsNoise(() => b.decrypt(c0), 'AUTH'); // replay of the one just accepted
    throwsNoise(() => b.decrypt(c2), 'AUTH'); // c1 was dropped
    assert.equal(unutf8(b.decrypt(c1)), '1');
    assert.equal(unutf8(b.decrypt(c2)), '2');
  });

  test('size cap: 65519 bytes of plaintext fit exactly, one more is refused before encryption and the nonce does not move', () => {
    const a = new N.CipherState(key());
    const b = new N.CipherState(key());
    throwsNoise(() => a.encrypt(new Uint8Array(N.MAX_PLAINTEXT + 1)), 'TOO_BIG');
    throwsNoise(() => a.encrypt(new Uint8Array(1 << 20)), 'TOO_BIG');
    assert.equal(a.nonce, 0n);
    const ct = a.encrypt(new Uint8Array(N.MAX_PLAINTEXT));
    assert.equal(ct.length, N.MAX_NOISE_MESSAGE);
    assert.equal(b.decrypt(ct).length, N.MAX_PLAINTEXT); // nonce 0 was still free, so the peer decrypts it
    throwsNoise(() => b.decrypt(new Uint8Array(N.MAX_NOISE_MESSAGE + 1)), 'TOO_BIG');
    assert.equal(b.nonce, 1n);
    assert.equal(N.MAX_NOISE_MESSAGE, 65535);
    assert.equal(N.MAX_PLAINTEXT, 65519);
  });

  test('2^64-1 is never used as a nonce', () => {
    const a = new N.CipherState(key());
    const b = new N.CipherState(key());
    const last = 0xffffffffffffffffn - 1n;
    a.setNonce(last);
    b.setNonce(last);
    const ct = a.encrypt(utf8('last'));
    assert.equal(unutf8(b.decrypt(ct)), 'last');
    assert.equal(a.nonce, 0xffffffffffffffffn);
    throwsNoise(() => a.encrypt(utf8('one too many')), 'NONCE');
    throwsNoise(() => b.decrypt(ct), 'NONCE');
    throwsNoise(() => a.setNonce(-1), 'ARG');
    throwsNoise(() => a.setNonce(1.5), 'ARG');
    throwsNoise(() => a.setNonce(0x10000000000000000n), 'ARG');
    a.setNonce(7);
    assert.equal(a.nonce, 7n);
  });

  test('the nonce is a 64-bit little-endian counter after four zero bytes (checked against node:crypto)', () => {
    const k = key();
    const a = new N.CipherState(k);
    a.setNonce(0x0102030405060708n);
    const ad = utf8('ad');
    const ct = a.encryptWithAd(ad, utf8('abc'));
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(0x0102030405060708n, 4);
    const c = crypto.createCipheriv('chacha20-poly1305', Buffer.from(k), nonce, { authTagLength: 16 });
    c.setAAD(Buffer.from(ad));
    const expected = Buffer.concat([c.update(Buffer.from('abc')), c.final(), c.getAuthTag()]);
    assert.equal(toHex(ct), expected.toString('hex'));
  });

  test('wipe clears the key and every later call throws instead of passing plaintext through', () => {
    const a = new N.CipherState(key());
    a.wipe();
    assert.equal(a.hasKey(), false);
    throwsNoise(() => a.encrypt(utf8('x')), 'WIPED');
    throwsNoise(() => a.decrypt(new Uint8Array(32)), 'WIPED');
  });

  test('a finished session can be wiped: ciphers refuse, the handshake hash is zeroed', () => {
    const c = connect();
    const h = c.si.handshakeHash;
    assert.ok(h.some((x) => x !== 0));
    c.si.wipe();
    assert.ok(h.every((x) => x === 0));
    throwsNoise(() => c.si.send.encrypt(utf8('x')), 'WIPED');
    throwsNoise(() => c.si.recv.decrypt(new Uint8Array(32)), 'WIPED');
  });

  test('a failed handshake leaves nothing usable', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: N.prologue('lan') });
    throwsNoise(() => r.readMessage1(new Uint8Array(200)), 'HANDSHAKE');
    throwsNoise(() => r.readMessage1(new Uint8Array(200)), 'DEAD');
    r.wipe(); // idempotent
    assert.equal(r.remoteStatic, null);
    assert.ok(phone);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('prologue, sas, push key, device id', () => {
  test('prologue layout', () => {
    const noOffer = N.prologue('lan');
    assert.equal(toHex(noOffer), toHex(Buffer.concat([Buffer.from('plenum-remote/1'), Buffer.from([0]), Buffer.from('lan'), Buffer.from([0]), Buffer.alloc(16)])));
    const offerHex = '0123456789abcdeffedcba9876543210';
    const viaHex = N.prologue('relay', offerHex);
    const viaBytes = N.prologue('relay', hex(offerHex));
    assert.equal(toHex(viaHex), toHex(viaBytes));
    assert.equal(toHex(viaHex), toHex(Buffer.concat([Buffer.from('plenum-remote/1'), Buffer.from([0]), Buffer.from('relay'), Buffer.from([0]), Buffer.from(offerHex, 'hex')])));
    assert.equal(toHex(N.prologue('tailscale', null)), toHex(N.prologue('tailscale')));
    assert.notEqual(toHex(N.prologue('lan')), toHex(N.prologue('relay')));
  });

  test('prologue rejects unknown carriers and malformed offer ids', () => {
    throwsNoise(() => N.prologue('wifi'), 'CARRIER');
    throwsNoise(() => N.prologue(undefined), 'CARRIER');
    throwsNoise(() => N.prologue('lan', 'abcd'), 'ARG');
    throwsNoise(() => N.prologue('lan', new Uint8Array(15)), 'ARG');
    throwsNoise(() => N.prologue('lan', 'zz'.repeat(16)), 'ARG');
    throwsNoise(() => N.prologue('lan', 5), 'ARG');
  });

  test('sas matches an independent HKDF-SHA256 (node:crypto) and keeps leading zeros', () => {
    let sawLeadingZero = false;
    for (let n = 0; n < 400; n++) {
      const h = new Uint8Array(crypto.createHash('sha256').update('h' + n).digest());
      const okm = Buffer.from(crypto.hkdfSync('sha256', h, Buffer.alloc(0), 'plenum-sas', 4));
      const expected = String(okm.readUInt32BE(0) % 1000000).padStart(6, '0');
      const got = N.sas(h);
      assert.equal(got, expected);
      assert.match(got, /^[0-9]{6}$/);
      if (got[0] === '0') sawLeadingZero = true;
    }
    assert.ok(sawLeadingZero, 'the sample included a code that starts with 0');
    assert.equal(N.formatSas('482913'), '482 913');
    assert.equal(N.formatSas('000042'), '000 042');
    throwsNoise(() => N.formatSas('12345'), 'ARG');
    throwsNoise(() => N.formatSas(482913), 'ARG');
    throwsNoise(() => N.sas(new Uint8Array(31)), 'ARG');
  });

  test('sas known answer', () => {
    const h = new Uint8Array(32).map((_, i) => i);
    const okm = Buffer.from(crypto.hkdfSync('sha256', h, Buffer.alloc(0), 'plenum-sas', 4));
    assert.equal(N.sas(h), String(okm.readUInt32BE(0) % 1000000).padStart(6, '0'));
    assert.equal(N.sas(h), N.sas(new Uint8Array(h)));
  });

  test('two honest sides get the same sas; an attacker who ran the pairing with a photographed QR gets a different one', () => {
    const psk = fill32(7);
    const offer = 'ab'.repeat(16);
    const pro = N.prologue('lan', offer);
    const desktop = N.generateKeyPair();
    const phone = N.generateKeyPair();
    const attacker = N.generateKeyPair();
    const handshake = (initKeys) => {
      const i = N.handshakeInitiator({ staticPrivate: initKeys.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro, psk });
      const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro, psk });
      r.readMessage1(i.writeMessage1(utf8('{}')));
      i.readMessage2(r.writeMessage2(utf8('{}')));
      return { si: i.finish(), sr: r.finish() };
    };
    const honest = handshake(phone);
    const raced = handshake(attacker);
    assert.equal(N.sas(honest.si.handshakeHash), N.sas(honest.sr.handshakeHash));
    assert.notEqual(toHex(honest.si.handshakeHash), toHex(raced.sr.handshakeHash));
    assert.notEqual(N.sas(honest.si.handshakeHash), N.sas(raced.sr.handshakeHash));
  });

  test('pushKey is HKDF-SHA256(h, salt empty, info plenum-push, 32) and differs from the sas input use', () => {
    const h = new Uint8Array(crypto.createHash('sha256').update('push').digest());
    const expected = Buffer.from(crypto.hkdfSync('sha256', h, Buffer.alloc(0), 'plenum-push', 32)).toString('hex');
    assert.equal(toHex(N.pushKey(h)), expected);
    assert.equal(N.pushKey(h).length, 32);
    throwsNoise(() => N.pushKey(new Uint8Array(33)), 'ARG');
  });

  test('stopKey is 32 bytes, differs from pushKey for the same h, and throws on a 31-byte hash', () => {
    const h = new Uint8Array(crypto.createHash('sha256').update('stop').digest());
    const expected = Buffer.from(crypto.hkdfSync('sha256', h, Buffer.alloc(0), 'plenum-stop', 32)).toString('hex');
    assert.equal(N.stopKey(h).length, 32);
    assert.equal(toHex(N.stopKey(h)), expected, 'HKDF-SHA256(h, salt empty, info plenum-stop, 32), checked against node:crypto');
    assert.notEqual(toHex(N.stopKey(h)), toHex(N.pushKey(h)), 'a different info string gives a different key');
    assert.notEqual(toHex(N.stopKey(h)), toHex(N.stopKey(new Uint8Array(crypto.createHash('sha256').update('other').digest()))), 'another handshake hash gives another key');
    throwsNoise(() => N.stopKey(new Uint8Array(31)), 'ARG');
    throwsNoise(() => N.stopKey(new Uint8Array(33)), 'ARG');
    throwsNoise(() => N.stopKey('not bytes'), 'ARG');
  });

  test('deviceId is the lowercase hex sha256 of the public key', () => {
    const pub = N.generateKeyPair().publicKey;
    assert.equal(N.deviceId(pub), crypto.createHash('sha256').update(pub).digest('hex'));
    throwsNoise(() => N.deviceId(new Uint8Array(31)), 'KEY');
  });

  test('hex helpers and constant-time equality', () => {
    assert.equal(toHex(Uint8Array.of(0, 15, 16, 255)), '000f10ff');
    assert.deepEqual([...hex('000F10ff')], [0, 15, 16, 255]);
    throwsNoise(() => hex('abc'), 'ARG');
    throwsNoise(() => hex('zz'), 'ARG');
    throwsNoise(() => toHex('00'), 'ARG');
    assert.equal(N.equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
    assert.equal(N.equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3)), false);
    assert.equal(N.equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2)), false);
    assert.equal(N.equalBytes('a', 'a'), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('DoS controls: mac1, mac2, cookies', () => {
  const desktop = N.generateKeyPair();
  const phone = N.generateKeyPair();
  const pro = N.prologue('lan');
  const body = () => N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro })
    .writeMessage1(utf8('{"counter":1}'));

  test('mac1 key and tag follow the specification (checked against node:crypto)', () => {
    const b = body();
    const key = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('plenum-mac1'), Buffer.from(desktop.publicKey)])).digest();
    assert.equal(toHex(N.mac1Key(desktop.publicKey)), key.toString('hex'));
    assert.equal(N.mac1, N.computeMac1);
    assert.equal(N.mac2, N.computeMac2);
    const mac = crypto.createHmac('sha256', key).update(b).digest().subarray(0, 16);
    assert.equal(toHex(N.computeMac1(desktop.publicKey, b)), mac.toString('hex'));
    const wire = N.sealMessage1(desktop.publicKey, b);
    assert.equal(wire.length, b.length + 32);
    assert.equal(toHex(wire.subarray(0, b.length)), toHex(b));
    assert.equal(toHex(wire.subarray(b.length, b.length + 16)), mac.toString('hex'));
    assert.ok(wire.subarray(b.length + 16).every((x) => x === 0), 'mac2 is zero without a cookie');
  });

  test('checkMac1 accepts a sealed message 1 and refuses every tampered, wrong-key, short or long one without throwing', () => {
    const wire = N.sealMessage1(desktop.publicKey, body());
    assert.equal(N.checkMac1(desktop.publicKey, wire), true);
    for (let p = 0; p < wire.length - 16; p++) { // the mac2 bytes are not part of mac1
      const bad = new Uint8Array(wire);
      bad[p] ^= 0x01;
      assert.equal(N.checkMac1(desktop.publicKey, bad), false, 'byte ' + p);
    }
    assert.equal(N.checkMac1(N.generateKeyPair().publicKey, wire), false);
    assert.equal(N.checkMac1(desktop.publicKey, wire.subarray(0, 31)), false);
    assert.equal(N.checkMac1(desktop.publicKey, new Uint8Array(0)), false);
    assert.equal(N.checkMac1(desktop.publicKey, new Uint8Array(65535 + 33)), false);
    assert.equal(N.checkMac1(desktop.publicKey, 'text'), false);
    assert.equal(N.checkMac1(desktop.publicKey, new Uint8Array(32)), false);
  });

  test('splitMessage1 returns the Noise bytes and both macs, or null', () => {
    const b = body();
    const wire = N.sealMessage1(desktop.publicKey, b);
    const parts = N.splitMessage1(wire);
    assert.equal(toHex(parts.body), toHex(b));
    assert.equal(parts.mac1.length, 16);
    assert.equal(parts.mac2.length, 16);
    assert.equal(N.splitMessage1(new Uint8Array(31)), null);
    assert.equal(N.splitMessage1(null), null);
  });

  test('a sealed message 1 goes through the handshake: no DH is needed to reject, and the body is what the responder reads', () => {
    const wire = N.sealMessage1(desktop.publicKey, body());
    assert.equal(N.checkMac1(desktop.publicKey, wire), true);
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: pro });
    assert.equal(unutf8(r.readMessage1(N.splitMessage1(wire).body)), '{"counter":1}');
  });

  test('cookie replies and mac2', () => {
    const clk = clock();
    const issuer = N.createCookieIssuer({ now: clk });
    const cookie = issuer.cookie('192.168.1.7');
    assert.equal(cookie.length, 16);
    const reply = N.cookieReply(cookie);
    assert.equal(reply.length, 17);
    assert.equal(reply[0], 0x7f);
    assert.equal(toHex(N.parseCookieReply(reply)), toHex(cookie));
    assert.equal(N.parseCookieReply(new Uint8Array(17)), null);
    assert.equal(N.parseCookieReply(reply.subarray(0, 16)), null);
    assert.equal(N.parseCookieReply('x'), null);
    throwsNoise(() => N.cookieReply(new Uint8Array(15)), 'ARG');

    const b = body();
    const noCookie = N.sealMessage1(desktop.publicKey, b);
    const withCookie = N.sealMessage1(desktop.publicKey, b, cookie);
    assert.equal(N.checkMac1(desktop.publicKey, withCookie), true);
    assert.equal(N.checkMac2(cookie, withCookie), true);
    assert.equal(N.checkMac2(cookie, noCookie), false);
    assert.equal(N.checkMac2(issuer.cookie('192.168.1.8'), withCookie), false);
    assert.equal(N.checkMac2(cookie, new Uint8Array(10)), false);
    const bad = new Uint8Array(withCookie);
    bad[0] ^= 1; // a changed body also invalidates mac2
    assert.equal(N.checkMac2(cookie, bad), false);
    throwsNoise(() => N.sealMessage1(desktop.publicKey, b, new Uint8Array(3)), 'ARG');
  });

  test('cookie secrets rotate every 120 s and a cookie lives 120 to 240 s (fake clock)', () => {
    const clk = clock(5000);
    const issuer = N.createCookieIssuer({ now: clk });
    const addr = '[fe80::1]:5555';
    const c0 = issuer.cookie(addr);
    assert.equal(toHex(issuer.cookie(addr)), toHex(c0), 'stable inside the window');
    clk.advance(119_000);
    assert.equal(issuer.check(addr, c0), true);
    clk.advance(2_000); // 121 s: one rotation, the old secret is still accepted
    assert.equal(issuer.check(addr, c0), true);
    assert.notEqual(toHex(issuer.cookie(addr)), toHex(c0), 'new cookies come from the new secret');
    assert.equal(issuer.check('10.0.0.9', c0), false, 'bound to the source address');
    clk.advance(125_000); // 246 s after issue: second rotation drops it
    assert.equal(issuer.check(addr, c0), false);
    const c1 = issuer.cookie(addr);
    clk.advance(10 * 60_000); // a long gap rotates twice in one step
    assert.equal(issuer.check(addr, c1), false);
    assert.equal(issuer.check(addr, new Uint8Array(15)), false);
    throwsNoise(() => issuer.cookie(''), 'ARG');
    throwsNoise(() => issuer.cookie(42), 'ARG');
    issuer.wipe();
  });

  test('cookie issuer uses the injected random source and fixed rotation', () => {
    const clk = clock();
    const a = N.createCookieIssuer({ now: clk, random: seq(fill32(1), fill32(2), fill32(3)) });
    const c = a.cookie('a');
    const expected = crypto.createHmac('sha256', Buffer.alloc(32, 1)).update('a').digest().subarray(0, 16);
    assert.equal(toHex(c), expected.toString('hex'));
    throwsNoise(() => N.createCookieIssuer({ now: clk, rotateMs: 0 }), 'ARG');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('errors and source hygiene', () => {
  const source = fs.readFileSync(NOISE_PATH, 'utf8');
  // comments removed so the checks look at code only
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

  test('every error code has one fixed sentence; sentences carry no digits or hex that could hold key material', () => {
    for (const [codeName, msg] of Object.entries(N.ERROR_MESSAGES)) {
      assert.match(msg, /^[A-Z][A-Za-z ,.0-9-]*\.$/, codeName);
      assert.ok(!/[0-9a-f]{8,}/i.test(msg), codeName);
    }
    assert.ok(Object.isFrozen(N.ERROR_MESSAGES));
    const e = new N.NoiseError('nonsense');
    assert.equal(e.code, 'ARG');
    assert.equal(e.message, N.ERROR_MESSAGES.ARG);
    assert.equal(new N.NoiseError('AUTH').name, 'NoiseError');
  });

  test('errors thrown by real failures never contain the keys, hashes or payload involved', () => {
    const phone = N.generateKeyPair();
    const desktop = N.generateKeyPair();
    const pro = N.prologue('lan');
    const i = N.handshakeInitiator({ staticPrivate: phone.privateKey, remoteStaticPublic: desktop.publicKey, prologue: pro });
    const r = N.handshakeResponder({ staticPrivate: desktop.privateKey, prologue: N.prologue('relay') });
    const secret = 'super-secret-payload-text';
    let caught;
    try { r.readMessage1(i.writeMessage1(utf8(secret))); } catch (err) { caught = err; }
    assert.ok(caught instanceof N.NoiseError);
    const dump = caught.message + ' ' + (caught.stack || '') + JSON.stringify(caught);
    for (const needle of [secret, toHex(phone.privateKey), toHex(desktop.privateKey), toHex(phone.publicKey), toHex(desktop.publicKey)]) {
      assert.ok(!dump.includes(needle));
    }
  });

  test('noise.mjs is isomorphic: only the five @noble subpath imports, no node:, process, Buffer, require, console, SubtleCrypto or Math.random', () => {
    const imports = [...code.matchAll(/^import\s.+?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), [
      '@noble/ciphers/chacha.js', '@noble/curves/ed25519.js', '@noble/hashes/hkdf.js', '@noble/hashes/hmac.js', '@noble/hashes/sha2.js', '@noble/hashes/utils.js',
    ].sort());
    for (const banned of [/node:/, /\brequire\s*\(/, /\bprocess\b/, /\bBuffer\b/, /\bconsole\b/, /\bsubtle\b/, /Math\.random/, /\bimport\s*\(/, /\bfs\b/, /\bfetch\b/]) {
      assert.ok(!banned.test(code), String(banned));
    }
    assert.equal(/export default/.test(code), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('esbuild bundle smoke (the phone shell bundle)', () => {
  const VECTOR_FILE = path.join(VECTOR_DIR, 'cacophony-ik-ikpsk2-25519-chachapoly-sha256.json');
  const SMOKE_ENTRY = `
    import * as N from ${JSON.stringify(NOISE_PATH)};
    import vectors from ${JSON.stringify(VECTOR_FILE)};
    const out = { vectors: [], roundtrip: false, pskRoundtrip: false, macs: false, sas: '', pushKeyLen: 0, tamper: '', cap: '' };
    const once = (h) => { let used = false; return (n) => { if (used || n !== 32) throw new Error('random misuse'); used = true; return N.hexToBytes(h); }; };
    for (const v of vectors.vectors) {
      const psk = v.init_psks ? N.hexToBytes(v.init_psks[0]) : undefined;
      const i = N.handshakeInitiator({ staticPrivate: N.hexToBytes(v.init_static), remoteStaticPublic: N.hexToBytes(v.init_remote_static),
        prologue: N.hexToBytes(v.init_prologue), psk, random: once(v.init_ephemeral) });
      const r = N.handshakeResponder({ staticPrivate: N.hexToBytes(v.resp_static), prologue: N.hexToBytes(v.resp_prologue), psk, random: once(v.resp_ephemeral) });
      const m1 = i.writeMessage1(N.hexToBytes(v.messages[0].payload));
      r.readMessage1(m1);
      const m2 = r.writeMessage2(N.hexToBytes(v.messages[1].payload));
      i.readMessage2(m2);
      const si = i.finish(), sr = r.finish();
      const t = si.send.encrypt(N.hexToBytes(v.messages[2].payload));
      out.vectors.push({ name: v.protocol_name, ok: N.bytesToHex(m1) === v.messages[0].ciphertext && N.bytesToHex(m2) === v.messages[1].ciphertext
        && N.bytesToHex(si.handshakeHash) === v.handshake_hash && N.bytesToHex(sr.handshakeHash) === v.handshake_hash
        && N.bytesToHex(t) === v.messages[2].ciphertext && N.bytesToHex(sr.recv.decrypt(t)) === v.messages[2].payload });
    }
    function live(psk) {
      const enc = new TextEncoder();
      const a = N.generateKeyPair(), b = N.generateKeyPair();     // uses crypto.getRandomValues of the scope
      const pro = N.prologue('relay', psk ? '00112233445566778899aabbccddeeff' : undefined);
      const i = N.handshakeInitiator({ staticPrivate: a.privateKey, remoteStaticPublic: b.publicKey, prologue: pro, psk });
      const r = N.handshakeResponder({ staticPrivate: b.privateKey, prologue: pro, psk, lastCounter: () => (psk ? undefined : 0) });
      const wire = N.sealMessage1(b.publicKey, i.writeMessage1(enc.encode('{"counter":1}')));
      if (!N.checkMac1(b.publicKey, wire)) return false;
      r.readMessage1(N.splitMessage1(wire).body);
      i.readMessage2(r.writeMessage2(enc.encode('{}')));
      const si = i.finish(), sr = r.finish();
      out.sas = N.sas(si.handshakeHash) === N.sas(sr.handshakeHash) ? N.formatSas(N.sas(si.handshakeHash)) : '';
      out.pushKeyLen = N.pushKey(si.handshakeHash).length;
      const ct = si.send.encrypt(enc.encode('hello'));
      const bad = new Uint8Array(ct); bad[0] ^= 1;
      try { sr.recv.decrypt(bad); out.tamper = 'accepted'; } catch (e) { out.tamper = e.message; }
      try { si.send.encrypt(new Uint8Array(65520)); out.cap = 'accepted'; } catch (e) { out.cap = e.message; }
      return new TextDecoder().decode(sr.recv.decrypt(ct)) === 'hello';
    }
    out.roundtrip = live(undefined);
    out.pskRoundtrip = live(crypto.getRandomValues(new Uint8Array(32)));
    out.macs = true;
    postMessage(out);
  `;

  async function loadEsbuild() {
    try {
      return await import('esbuild');
    } catch {
      assert.fail('esbuild is not installed: the sealed run installs esbuild 0.28.2 next to the project (mobile/package.json devDependency)');
    }
  }

  function checkResult(out) {
    assert.equal(out.vectors.length, 2, 'IK and IKpsk2 vectors ran in the bundle');
    for (const v of out.vectors) assert.equal(v.ok, true, v.name);
    assert.equal(out.roundtrip, true);
    assert.equal(out.pskRoundtrip, true);
    assert.match(out.sas, /^[0-9]{3} [0-9]{3}$/);
    assert.equal(out.pushKeyLen, 32);
    assert.equal(out.tamper, N.ERROR_MESSAGES.AUTH);
    assert.equal(out.cap, N.ERROR_MESSAGES.TOO_BIG);
  }

  let bundle;
  async function build() {
    if (bundle) return bundle;
    const esbuild = await loadEsbuild();
    const result = await esbuild.build({
      stdin: { contents: SMOKE_ENTRY, resolveDir: path.dirname(NOISE_PATH), sourcefile: 'smoke-entry.js', loader: 'js' },
      bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', metafile: true, logLevel: 'silent', legalComments: 'none',
    });
    assert.equal(result.errors.length, 0);
    const text = result.outputFiles[0].text;
    const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, '/'));
    bundle = { text, inputs, version: esbuild.version };
    return bundle;
  }

  test('the bundle contains only noise.mjs, the vector JSON and @noble files, and no Node-only code', async (t) => {
    const b = await build();
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const noise = norm(NOISE_PATH);
    for (const p of b.inputs) {
      const ok = p === '<stdin>' || /(^|\/)node_modules\/@noble\//.test(p) || norm(p) === noise || norm(p) === norm(VECTOR_FILE) || p.endsWith('smoke-entry.js');
      assert.ok(ok, 'unexpected bundle input ' + p);
    }
    assert.ok(b.inputs.some((p) => /@noble\/curves/.test(p)));
    assert.ok(b.inputs.some((p) => /@noble\/ciphers/.test(p)));
    assert.ok(b.inputs.some((p) => /@noble\/hashes/.test(p)));
    assert.ok(!/\brequire\s*\(/.test(b.text), 'no require() in the bundle');
    assert.ok(!/node:/.test(b.text), 'no node: specifier in the bundle');
    assert.ok(!/\bBuffer\b/.test(b.text), 'no Buffer in the bundle');
    assert.ok(!/\bimport\.meta\b/.test(b.text), 'no import.meta in the bundle');
    assert.ok(b.text.length < 400_000, 'bundle size sanity, got ' + b.text.length);
    t.diagnostic('esbuild ' + b.version + ': bundle ' + b.text.length + ' bytes from ' + b.inputs.length + ' inputs');
  });

  test('the bundle runs inside a worker_threads Worker (browser-style scope: self, postMessage, no Node imports)', async () => {
    const b = await build();
    const shim = "const { parentPort } = require('node:worker_threads'); globalThis.self = globalThis; globalThis.postMessage = (m) => parentPort.postMessage(m);\n";
    // A machine out of commit memory (many parallel test runs) cannot start a thread: ERR_WORKER_INIT_FAILED. That says nothing about the
    // bundle, so only that one error is retried, a few times; any failure of the bundle itself fails the test at once.
    let worker;
    for (let attempt = 1; ; attempt++) {
      try {
        worker = new Worker(shim + b.text, { eval: true });
        break;
      } catch (err) {
        if (err && err.code === 'ERR_WORKER_INIT_FAILED' && attempt < 8) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw err;
      }
    }
    const out = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timed out')), 30000);
      worker.once('message', (m) => { clearTimeout(timer); resolve(m); });
      worker.once('error', (e) => { clearTimeout(timer); reject(e); });
      worker.once('exit', (c) => { clearTimeout(timer); reject(new Error('worker exited with code ' + c + ' before it answered')); });
    });
    await worker.terminate();
    checkResult(out);
  });

  test('the bundle also runs in a bare vm context that has only the Web globals a Worker has', async () => {
    const b = await build();
    let result;
    const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, postMessage: (m) => { result = m; } };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(b.text, sandbox, { timeout: 20000 });
    assert.ok(result, 'the bundle posted its result');
    // the object was built in another realm: round-trip it through JSON before the deep assertions
    checkResult(JSON.parse(JSON.stringify(result)));
  });
});
