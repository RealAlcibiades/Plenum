// Plenum remote channel: Noise_IK and Noise_IKpsk2 (25519, ChaChaPoly, SHA256) on the @noble primitives.
//
// Isomorphic on purpose. This one file runs in the desktop Bridge (Node) and, copied by scripts/build-mobile.mjs, in the phone shell's
// Web Worker (Safari, Chrome, Capacitor WebViews). So: no node: imports, no Buffer, no process, no WebCrypto SubtleCrypto (crypto.subtle
// needs a secure context and http://<LAN IP> is not one). The only runtime services used are TextEncoder, BigInt, DataView and
// crypto.getRandomValues (through @noble/hashes randomBytes), and callers may inject their own `random` for tests.
//
// Implements the Noise Protocol Framework revision 34 (https://noiseprotocol.org/noise.html):
//   Noise_IK_25519_ChaChaPoly_SHA256       known phones, one round trip on every reconnect
//       <- s
//       ...
//       -> e, es, s, ss
//       <- e, ee, se
//   Noise_IKpsk2_25519_ChaChaPoly_SHA256   pairing; the 32-byte QR secret is the psk, mixed at the end of message 2
//       -> e, es, s, ss
//       <- e, ee, se, psk
// plus HandshakeState / SymmetricState / CipherState, the "psk" token (MixKeyAndHash), MixKey(e) on every 'e' of a psk pattern, Split,
// 64-bit nonces (2^64-1 is reserved and refused), the 65535-byte message cap and the Plenum add-ons below.
//
// Plenum add-ons (MOBILE.json protocol.*):
//   prologue(carrier, offerId?)      'plenum-remote/1' 00 carrier 00 offerId(16 bytes, zeros for a known-device session)
//   sas(h) / formatSas(code)         6-digit short authentication string from the final handshake hash: '482913' / '482 913'
//   pushKey(h)                       32-byte key for native push, HKDF-SHA256(h, salt '', info 'plenum-push')
//   stopKey(h)                       32-byte Stop-only key (stop-only.mjs), HKDF-SHA256(h, salt '', info 'plenum-stop')
//   deviceId(publicKey)              lowercase hex sha256 of a static public key (the registry id and HELLO deviceId)
//   checkCounter(last, next)         replay rule: a handshake counter must be strictly higher than the last one stored for the device
//   mac1 / mac2 / cookie helpers     WireGuard-style DoS controls checked BEFORE any DH, see "Wire layout" below
//
// Wire layout (one WebSocket binary message is exactly one of these):
//   message 1 (phone to desktop) = <Noise message 1 bytes> || mac1 (16) || mac2 (16)
//       mac1 = HMAC-SHA256(key = SHA256('plenum-mac1' || desktop static public key), msg = Noise message 1 bytes)[0..16]
//       mac2 = 16 zero bytes, or, once the phone holds a cookie, HMAC-SHA256(key = cookie, msg = Noise message 1 bytes || mac1)[0..16]
//   cookie reply (desktop to phone, only while under load) = 0x7f || cookie (16)
//       cookie = HMAC-SHA256(secret rotating every 120 s, source address text)[0..16]; valid for 120 to 240 s
//   message 2 (desktop to phone) = <Noise message 2 bytes>, no MACs
//   transport = <ChaChaPoly ciphertext || tag>, empty associated data, nonce = the CipherState counter (never sent)
//
// Typical use (desktop, known phone):
//   if (!checkMac1(myPublic, wire)) drop;                 // no DH spent
//   const r = handshakeResponder({ staticPrivate, prologue: prologue('lan'), lastCounter: (pub) => registry.counter(pub) }); // undefined: UNKNOWN
//   const payload = r.readMessage1(splitMessage1(wire).body);   // JSON { counter, ... }; throws NoiseError REPLAY on a stale counter
//   const reply = r.writeMessage2(helloBytes);
//   const session = r.finish();                            // { send, recv, handshakeHash, remoteStatic, protocol, wipe() }
// Phone: handshakeInitiator({ staticPrivate, remoteStaticPublic, prologue, psk? }), writeMessage1, sealMessage1, readMessage2, finish.
//
// Notes for the Bridge (pairing.mjs / listener.mjs):
//   - A handshake object is single use. Any failed read, a REPLAY or a finish() leaves it dead (every later call throws DEAD), so build a
//     fresh responder for every attempt.
//   - The bytes of message 1 do not say whether the phone ran IK or IKpsk2. Try IK with prologue(carrier) first (known phones); if that
//     throws HANDSHAKE and an offer is live, try IKpsk2 with prologue(carrier, offerId) and psk = the offer's secret. Rate limits and the
//     offer's failure counter belong to the caller.
//   - The counter is checked after message 1 is authenticated and before anything is answered; store it before sending message 2.
//   - IK refuses a phone the caller does not hold: lastCounter returning undefined or null makes readMessage1 throw UNKNOWN before any
//     answer. Pass lastCounter on every IK responder; without it the core checks no membership at all. IKpsk2 (pairing) takes
//     undefined or null as first contact and accepts any valid counter.
//   - sas(handshakeHash) is read from the finished Session on both sides once message 2 has been written / read.
//   - IKpsk2 mixes the psk at the END of message 2, so message 1 is not psk-protected: the desktop only learns that the phone holds the
//     psk when the phone's first transport message decrypts (session.recv.decrypt). Show the code and the Allow buttons only after that.
//
// Rules this file keeps: every thrown error is a NoiseError whose message is one of the fixed sentences in ERROR_MESSAGES (never any
// key, nonce, length or payload); nothing here logs; key buffers are copied on the way in and overwritten with zeros when a handshake
// ends or fails and on wipe(). JavaScript cannot promise that the engine made no other copy, so this is hygiene, not a guarantee.

import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { randomBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------------------------------------------------------------
// Constants

export const PROTOCOL_IK = 'Noise_IK_25519_ChaChaPoly_SHA256';
export const PROTOCOL_IKPSK2 = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256';
export const MAX_NOISE_MESSAGE = 65535;
export const MAX_PLAINTEXT = 65519; // MAX_NOISE_MESSAGE minus the 16-byte tag
export const KEY_LEN = 32;
export const TAG_LEN = 16;
export const MAC_LEN = 16;
export const COOKIE_TYPE = 0x7f;
export const COOKIE_ROTATE_MS = 120000;
export const CARRIERS = Object.freeze(['lan', 'tailscale', 'relay']);

const DHLEN = 32;
const HASHLEN = 32;
const MAX_NONCE = 0xffffffffffffffffn; // 2^64-1 is reserved by the spec: never used for a message
const EMPTY = new Uint8Array(0);
const utf8 = new TextEncoder();

// ---------------------------------------------------------------------------------------------------------------------------------
// Errors: fixed sentences only

export const ERROR_MESSAGES = Object.freeze({
  ARG: 'An argument has the wrong type or size.',
  KEY: 'A key must be exactly 32 bytes.',
  TOO_BIG: 'A message may not be larger than 65535 bytes.',
  AUTH: 'The message could not be authenticated.',
  NONCE: 'The message counter for this key is used up.',
  WIPED: 'The cipher state has been cleared.',
  STATE: 'The handshake step is out of order.',
  DEAD: 'The handshake has failed or finished and cannot be used again.',
  HANDSHAKE: 'The handshake message could not be verified.',
  REPLAY: 'The handshake counter is not higher than the last one used by this device.',
  UNKNOWN: 'This device is not paired with this computer.',
  PAYLOAD: 'The handshake payload is not valid.',
  CARRIER: 'The carrier must be lan, tailscale or relay.',
  RANDOM: 'No secure random source is available.',
});

export class NoiseError extends Error {
  /** @param {keyof typeof ERROR_MESSAGES} code */
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.ARG);
    this.name = 'NoiseError';
    this.code = ERROR_MESSAGES[code] ? code : 'ARG';
  }
}
const fail = (code) => new NoiseError(code);

// ---------------------------------------------------------------------------------------------------------------------------------
// Byte helpers

function isBytes(x) {
  return ArrayBuffer.isView(x) && Object.prototype.toString.call(x) === '[object Uint8Array]';
}
function copyBytes(x, code = 'ARG') {
  if (!isBytes(x)) throw fail(code);
  return new Uint8Array(x);
}
function key32(x) {
  if (!isBytes(x) || x.length !== KEY_LEN) throw fail('KEY');
  return new Uint8Array(x);
}
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function wipe(...arrays) {
  for (const a of arrays) if (a && typeof a.fill === 'function') a.fill(0);
}

/** Constant-time comparison of two byte arrays (false when either is not a Uint8Array or the lengths differ). */
export function equalBytes(a, b) {
  if (!isBytes(a) || !isBytes(b) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const HEX = '0123456789abcdef';
export function bytesToHex(bytes) {
  if (!isBytes(bytes)) throw fail('ARG');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw fail('ARG');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function defaultRandom(n) {
  try {
    return randomBytes(n);
  } catch {
    throw fail('RANDOM');
  }
}
function pickRandom(random) {
  if (random === undefined || random === null) return defaultRandom;
  if (typeof random !== 'function') throw fail('ARG');
  return random;
}
/** One fresh private key from `random`. The returned array is used (and later cleared) in place, so `random` must return a new array each call. */
function freshKey(random) {
  const k = random(KEY_LEN);
  if (!isBytes(k) || k.length !== KEY_LEN) throw fail('RANDOM');
  return k;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Primitives (Noise section 4)

function dh(privateKey, publicKey) {
  try {
    return x25519.getSharedSecret(privateKey, publicKey); // throws on low-order points / an all-zero result
  } catch {
    throw fail('HANDSHAKE');
  }
}
function publicOf(privateKey) {
  try {
    return x25519.getPublicKey(privateKey);
  } catch {
    throw fail('KEY');
  }
}

/** A fresh X25519 key pair: { privateKey, publicKey }, both 32-byte Uint8Arrays. */
export function generateKeyPair(random) {
  const sk = freshKey(pickRandom(random));
  return { privateKey: sk, publicKey: publicOf(sk) };
}
/** The X25519 public key for a 32-byte private key. */
export function publicKeyOf(privateKey) {
  return publicOf(key32(privateKey));
}
/** Lowercase hex of sha256(static public key): the device id used by the registry and carried in HELLO. */
export function deviceId(publicKey) {
  return bytesToHex(sha256(key32(publicKey)));
}

/** Noise HKDF (section 4.3): returns `n` (2 or 3) 32-byte outputs. */
function noiseHkdf(chainingKey, inputKeyMaterial, n) {
  const temp = hmac(sha256, chainingKey, inputKeyMaterial);
  const o1 = hmac(sha256, temp, Uint8Array.of(1));
  const o2 = hmac(sha256, temp, concat(o1, Uint8Array.of(2)));
  let o3 = null;
  if (n === 3) o3 = hmac(sha256, temp, concat(o2, Uint8Array.of(3)));
  wipe(temp);
  return n === 3 ? [o1, o2, o3] : [o1, o2];
}

function nonceBytes(n) {
  const out = new Uint8Array(12); // 32 bits of zeros, then the 64-bit little-endian counter
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// CipherState (section 5.1)

export class CipherState {
  #k = null;
  #n = 0n;
  #wiped = false;

  /** @param {Uint8Array|null} [key] 32-byte key, or nothing for the empty (pass-through) state. The key is copied. */
  constructor(key = null) {
    if (key !== null && key !== undefined) this.#k = key32(key);
  }

  hasKey() {
    return this.#k !== null;
  }

  /** The next nonce as a BigInt (also the number of messages sent or received with this key so far). */
  get nonce() {
    return this.#n;
  }

  /** Spec SetNonce(). Accepts a safe integer or BigInt in 0 .. 2^64-1. */
  setNonce(n) {
    let v;
    if (typeof n === 'bigint') v = n;
    else if (Number.isSafeInteger(n) && n >= 0) v = BigInt(n);
    else throw fail('ARG');
    if (v < 0n || v > MAX_NONCE) throw fail('ARG');
    this.#n = v;
  }

  /** EncryptWithAd. The size cap is checked before anything is encrypted; the nonce advances only after a successful encryption. */
  encryptWithAd(ad, plaintext) {
    if (this.#wiped) throw fail('WIPED');
    if (!isBytes(ad) || !isBytes(plaintext)) throw fail('ARG');
    if (this.#k === null) {
      if (plaintext.length > MAX_NOISE_MESSAGE) throw fail('TOO_BIG');
      return new Uint8Array(plaintext);
    }
    if (plaintext.length > MAX_PLAINTEXT) throw fail('TOO_BIG');
    if (this.#n >= MAX_NONCE) throw fail('NONCE');
    let out;
    try {
      out = chacha20poly1305(this.#k, nonceBytes(this.#n), ad).encrypt(plaintext);
    } catch {
      throw fail('AUTH');
    }
    this.#n += 1n;
    return out;
  }

  /** DecryptWithAd. A bad tag, a wrong or replayed message or a short input all give the same AUTH error and leave the nonce where it was. */
  decryptWithAd(ad, ciphertext) {
    if (this.#wiped) throw fail('WIPED');
    if (!isBytes(ad) || !isBytes(ciphertext)) throw fail('ARG');
    if (ciphertext.length > MAX_NOISE_MESSAGE) throw fail('TOO_BIG');
    if (this.#k === null) return new Uint8Array(ciphertext);
    if (this.#n >= MAX_NONCE) throw fail('NONCE');
    if (ciphertext.length < TAG_LEN) throw fail('AUTH');
    let out;
    try {
      out = chacha20poly1305(this.#k, nonceBytes(this.#n), ad).decrypt(ciphertext);
    } catch {
      throw fail('AUTH');
    }
    this.#n += 1n;
    return out;
  }

  /** Transport helper: EncryptWithAd with empty associated data. */
  encrypt(plaintext) {
    return this.encryptWithAd(EMPTY, plaintext);
  }
  /** Transport helper: DecryptWithAd with empty associated data. */
  decrypt(ciphertext) {
    return this.decryptWithAd(EMPTY, ciphertext);
  }

  /** Overwrites the key with zeros; every later call throws. */
  wipe() {
    if (this.#k) wipe(this.#k);
    this.#k = null;
    this.#wiped = true;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// SymmetricState (section 5.2)

class SymmetricState {
  ck;
  h;
  cs;

  constructor(protocolName) {
    const name = utf8.encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = new Uint8Array(this.h);
    this.cs = new CipherState();
  }

  hasKey() {
    return this.cs.hasKey();
  }

  #setKey(k) {
    this.cs.wipe();
    this.cs = new CipherState(k);
    wipe(k);
  }

  mixKey(inputKeyMaterial) {
    const [ck, k] = noiseHkdf(this.ck, inputKeyMaterial, 2);
    wipe(this.ck);
    this.ck = ck;
    this.#setKey(k);
  }

  mixHash(data) {
    this.h = sha256(concat(this.h, data));
  }

  mixKeyAndHash(inputKeyMaterial) {
    const [ck, tempH, k] = noiseHkdf(this.ck, inputKeyMaterial, 3);
    wipe(this.ck);
    this.ck = ck;
    this.mixHash(tempH);
    wipe(tempH);
    this.#setKey(k);
  }

  encryptAndHash(plaintext) {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  /** Split(): returns [c1, c2] and clears the chaining key and the handshake cipher. */
  split() {
    const [k1, k2] = noiseHkdf(this.ck, EMPTY, 2);
    const c1 = new CipherState(k1);
    const c2 = new CipherState(k2);
    wipe(k1, k2);
    this.wipe();
    return [c1, c2];
  }

  /** Clears ck and the handshake cipher (h is not secret and is kept for the handshake hash). */
  wipe() {
    wipe(this.ck);
    this.cs.wipe();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// HandshakeState (section 5.3): token interpreter for the two patterns Plenum uses

const PATTERNS = Object.freeze({
  IK: Object.freeze({ name: 'IK', psk: false, messages: Object.freeze([['e', 'es', 's', 'ss'], ['e', 'ee', 'se']]) }),
  IKpsk2: Object.freeze({ name: 'IKpsk2', psk: true, messages: Object.freeze([['e', 'es', 's', 'ss'], ['e', 'ee', 'se', 'psk']]) }),
});

/**
 * @typedef {Object} Session
 * @property {CipherState} send   encrypts what this side sends
 * @property {CipherState} recv   decrypts what this side receives
 * @property {Uint8Array} handshakeHash  32-byte final h: input of sas() and pushKey()
 * @property {Uint8Array} remoteStatic   the other side's static public key
 * @property {string} protocol    PROTOCOL_IK or PROTOCOL_IKPSK2
 * @property {() => void} wipe    clears both ciphers and the handshake hash
 */

/**
 * @typedef {Object} InitiatorHandshake
 * @property {string} protocol
 * @property {boolean} complete
 * @property {(payload: Uint8Array) => Uint8Array} writeMessage1  Noise message 1; wrap with sealMessage1() before sending
 * @property {(message: Uint8Array) => Uint8Array} readMessage2   returns the desktop's payload
 * @property {() => Session} finish
 * @property {() => void} wipe
 */
/**
 * @typedef {Object} ResponderHandshake
 * @property {string} protocol
 * @property {boolean} complete
 * @property {Uint8Array|null} remoteStatic  the phone's static public key once message 1 was read
 * @property {number|null} counter           the accepted handshake counter (only when lastCounter was given)
 * @property {(message: Uint8Array) => Uint8Array} readMessage1   Noise message 1 without the MACs; returns the phone's payload
 * @property {(payload: Uint8Array) => Uint8Array} writeMessage2
 * @property {() => Session} finish
 * @property {() => void} wipe
 */

class HandshakeState {
  #pattern;
  #initiator;
  #random;
  #ss;
  #s;
  #sPub;
  #e = null;
  #rs = null;
  #re = null;
  #psk = null;
  #index = 0;
  #dead = false;
  #done = false;
  protocolName;

  constructor({ pattern, initiator, prologue: pro, staticPrivate, remoteStaticPublic, psk, random }) {
    this.#pattern = pattern;
    this.#initiator = initiator;
    this.#random = pickRandom(random);
    this.protocolName = 'Noise_' + pattern.name + '_25519_ChaChaPoly_SHA256';
    const prologueBytes = copyBytes(pro);
    this.#s = key32(staticPrivate);
    try {
      this.#sPub = publicOf(this.#s);
      if (pattern.psk) this.#psk = key32(psk);
      if (initiator) this.#rs = key32(remoteStaticPublic);
      this.#ss = new SymmetricState(this.protocolName);
      this.#ss.mixHash(prologueBytes);
      this.#ss.mixHash(initiator ? this.#rs : this.#sPub); // pre-message "<- s" (the responder's static key)
    } catch (err) {
      this.wipe();
      throw err;
    }
  }

  get remoteStatic() {
    return this.#rs ? new Uint8Array(this.#rs) : null;
  }
  get complete() {
    return this.#index === this.#pattern.messages.length && !this.#dead;
  }
  get finished() {
    return this.#done;
  }

  /** Exact byte length of message `index` with an empty payload (tokens only plus the payload tag), from the pattern alone. */
  #minLength(index) {
    let n = 0;
    let keyed = this.#ss.hasKey();
    for (const t of this.#pattern.messages[index]) {
      if (t === 'e') { n += DHLEN; if (this.#pattern.psk) keyed = true; }
      else if (t === 's') n += DHLEN + (keyed ? TAG_LEN : 0);
      else keyed = true; // every DH token and psk keys the cipher
    }
    return n + (keyed ? TAG_LEN : 0);
  }

  #guard(write) {
    if (this.#dead || this.#done) throw fail('DEAD');
    if (this.#index >= this.#pattern.messages.length) throw fail('STATE');
    const myTurn = this.#initiator ? this.#index % 2 === 0 : this.#index % 2 === 1;
    if (myTurn !== write) throw fail('STATE');
  }

  #dhToken(token) {
    const [a, b] = token; // a: the initiator's key, b: the responder's key
    const local = this.#initiator ? (a === 'e' ? this.#e : this.#s) : (b === 'e' ? this.#e : this.#s);
    const remote = this.#initiator ? (b === 'e' ? this.#re : this.#rs) : (a === 'e' ? this.#re : this.#rs);
    const shared = dh(local, remote);
    this.#ss.mixKey(shared);
    wipe(shared);
  }

  writeMessage(payload) {
    this.#guard(true);
    const body = copyBytes(payload);
    // The size cap is enforced before anything is encrypted or any state changes, so a too-large payload can be retried smaller.
    if (this.#minLength(this.#index) + body.length > MAX_NOISE_MESSAGE) throw fail('TOO_BIG');
    try {
      const parts = [];
      for (const token of this.#pattern.messages[this.#index]) {
        if (token === 'e') {
          this.#e = freshKey(this.#random);
          const ePub = publicOf(this.#e);
          parts.push(ePub);
          this.#ss.mixHash(ePub);
          if (this.#pattern.psk) this.#ss.mixKey(ePub);
        } else if (token === 's') {
          parts.push(this.#ss.encryptAndHash(this.#sPub));
        } else if (token === 'psk') {
          this.#ss.mixKeyAndHash(this.#psk);
        } else {
          this.#dhToken(token);
        }
      }
      parts.push(this.#ss.encryptAndHash(body));
      this.#index += 1;
      return concat(...parts);
    } catch (err) {
      this.wipe();
      throw err instanceof NoiseError && (err.code === 'TOO_BIG' || err.code === 'RANDOM') ? err : fail('HANDSHAKE');
    }
  }

  readMessage(message) {
    this.#guard(false);
    if (!isBytes(message)) throw fail('ARG');
    try {
      if (message.length > MAX_NOISE_MESSAGE || message.length < this.#minLength(this.#index)) throw fail('HANDSHAKE');
      let off = 0;
      for (const token of this.#pattern.messages[this.#index]) {
        if (token === 'e') {
          this.#re = message.slice(off, off + DHLEN);
          off += DHLEN;
          this.#ss.mixHash(this.#re);
          if (this.#pattern.psk) this.#ss.mixKey(this.#re);
        } else if (token === 's') {
          const len = DHLEN + (this.#ss.hasKey() ? TAG_LEN : 0);
          this.#rs = this.#ss.decryptAndHash(message.slice(off, off + len));
          off += len;
        } else if (token === 'psk') {
          this.#ss.mixKeyAndHash(this.#psk);
        } else {
          this.#dhToken(token);
        }
      }
      const payload = this.#ss.decryptAndHash(message.slice(off));
      this.#index += 1;
      return payload;
    } catch {
      this.wipe();
      throw fail('HANDSHAKE');
    }
  }

  finish() {
    if (this.#dead || this.#done) throw fail('DEAD');
    if (this.#index !== this.#pattern.messages.length) throw fail('STATE');
    const [c1, c2] = this.#ss.split();
    const handshakeHash = new Uint8Array(this.#ss.h);
    const remoteStatic = new Uint8Array(this.#rs);
    const send = this.#initiator ? c1 : c2;
    const recv = this.#initiator ? c2 : c1;
    this.#done = true;
    this.#clearKeys();
    return Object.freeze({
      send,
      recv,
      handshakeHash,
      remoteStatic,
      protocol: this.protocolName,
      wipe() {
        send.wipe();
        recv.wipe();
        wipe(handshakeHash);
      },
    });
  }

  #clearKeys() {
    wipe(this.#s, this.#e, this.#psk);
    this.#e = null;
  }

  /** Marks the handshake unusable and overwrites its secrets. Safe to call at any time and more than once. */
  wipe() {
    this.#dead = true;
    this.#clearKeys();
    if (this.#ss) this.#ss.wipe();
  }
}

/** Parses the handshake payload's `counter` (a JSON object with a non-negative safe integer). Throws PAYLOAD. */
function readCounter(payload) {
  let obj;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw fail('PAYLOAD');
  }
  if (!obj || typeof obj !== 'object' || !Number.isSafeInteger(obj.counter) || obj.counter < 0) throw fail('PAYLOAD');
  return obj.counter;
}

/**
 * Replay rule for handshake counters. `last` is the highest counter stored for this device (undefined or null when the device has none),
 * `next` is the counter in the new message 1. Returns `next` when it is strictly higher; throws REPLAY when it is equal or lower and
 * PAYLOAD when it is not a non-negative safe integer. The caller stores `next` before it answers.
 */
export function checkCounter(last, next) {
  if (!Number.isSafeInteger(next) || next < 0) throw fail('PAYLOAD');
  if (last !== undefined && last !== null) {
    if (!Number.isSafeInteger(last) || last < 0) throw fail('ARG');
    if (next <= last) throw fail('REPLAY');
  }
  return next;
}

/**
 * @typedef {Object} InitiatorOptions
 * @property {Uint8Array} staticPrivate       this phone's 32-byte X25519 private key
 * @property {Uint8Array} remoteStaticPublic  the desktop's 32-byte static public key (from the QR or the stored computer)
 * @property {Uint8Array} prologue            from prologue()
 * @property {Uint8Array} [psk]               32-byte pairing secret: present means Noise_IKpsk2, absent means Noise_IK
 * @property {(n: number) => Uint8Array} [random]  tests only: must return a NEW n-byte array each call
 */
/**
 * Phone side. Methods: writeMessage1(payload) -> Noise message 1 (add the MACs with sealMessage1), readMessage2(message) -> payload,
 * finish() -> Session, wipe(); properties: protocol, complete.
 * @param {InitiatorOptions} options
 * @returns {InitiatorHandshake}
 */
export function handshakeInitiator(options) {
  if (!options || typeof options !== 'object') throw fail('ARG');
  const pattern = options.psk === undefined || options.psk === null ? PATTERNS.IK : PATTERNS.IKpsk2;
  const hs = new HandshakeState({ ...options, pattern, initiator: true });
  return Object.freeze({
    get protocol() { return hs.protocolName; },
    get complete() { return hs.complete; },
    writeMessage1: (payload) => hs.writeMessage(payload),
    readMessage2: (message) => hs.readMessage(message),
    finish: () => hs.finish(),
    wipe: () => hs.wipe(),
  });
}

/**
 * @typedef {Object} ResponderOptions
 * @property {Uint8Array} staticPrivate  the desktop's 32-byte X25519 private key
 * @property {Uint8Array} prologue       from prologue(); a mismatch makes message 1 fail with HANDSHAKE
 * @property {Uint8Array} [psk]          32-byte pairing secret of the live offer: present means Noise_IKpsk2, absent means Noise_IK
 * @property {(remoteStaticPublic: Uint8Array) => (number|null|undefined)} [lastCounter]
 *     when given, message 1's payload must be JSON with a `counter` strictly higher than what this returns. IK (no psk) refuses a
 *     phone with no stored counter (undefined or null) with UNKNOWN; IKpsk2 (pairing) takes undefined or null as first contact and
 *     accepts any valid counter. A refused message 1 leaves the handshake dead (readMessage1 throws REPLAY, PAYLOAD or UNKNOWN)
 * @property {(n: number) => Uint8Array} [random]  tests only: must return a NEW n-byte array each call
 */
/**
 * Desktop side. Methods: readMessage1(noiseMessage1) -> payload, writeMessage2(payload) -> Noise message 2, finish() -> Session, wipe();
 * properties: protocol, complete, remoteStatic (the phone's static public key, after readMessage1), counter (after readMessage1 when
 * lastCounter was given). Check mac1 with checkMac1 BEFORE constructing this: it is the DH-free filter.
 * @param {ResponderOptions} options
 * @returns {ResponderHandshake}
 */
export function handshakeResponder(options) {
  if (!options || typeof options !== 'object') throw fail('ARG');
  if (options.lastCounter !== undefined && typeof options.lastCounter !== 'function') throw fail('ARG');
  const pattern = options.psk === undefined || options.psk === null ? PATTERNS.IK : PATTERNS.IKpsk2;
  const hs = new HandshakeState({ ...options, pattern, initiator: false });
  let counter = null;
  return Object.freeze({
    get protocol() { return hs.protocolName; },
    get complete() { return hs.complete; },
    get remoteStatic() { return hs.remoteStatic; },
    get counter() { return counter; },
    readMessage1(message) {
      const payload = hs.readMessage(message);
      if (options.lastCounter) {
        try {
          const next = readCounter(payload);
          const last = options.lastCounter(hs.remoteStatic);
          // IK is the known-device pattern: a static key with no stored counter is a phone this desktop does not hold, so it is
          // refused here, before anything is answered. IKpsk2 is pairing, where first contact is expected.
          if (!pattern.psk && (last === undefined || last === null)) throw fail('UNKNOWN');
          counter = checkCounter(last, next);
        } catch (err) {
          hs.wipe();
          throw err instanceof NoiseError ? err : fail('ARG');
        }
      }
      return payload;
    },
    writeMessage2: (payload) => hs.writeMessage(payload),
    finish: () => hs.finish(),
    wipe: () => hs.wipe(),
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Plenum add-ons

/**
 * 'plenum-remote/1' 00 carrier 00 offerId. Both sides must pass the same carrier and offer id or message 1 fails to verify.
 * @param {'lan'|'tailscale'|'relay'} carrier
 * @param {Uint8Array|string|null} [offerId] 16 bytes or 32 hex characters while pairing; omitted (16 zero bytes) for a known-device session
 */
export function prologue(carrier, offerId) {
  if (!CARRIERS.includes(carrier)) throw fail('CARRIER');
  let id;
  if (offerId === undefined || offerId === null) id = new Uint8Array(16);
  else if (typeof offerId === 'string') id = hexToBytes(offerId);
  else id = copyBytes(offerId);
  if (id.length !== 16) throw fail('ARG');
  return concat(utf8.encode('plenum-remote/1'), Uint8Array.of(0), utf8.encode(carrier), Uint8Array.of(0), id);
}

const SAS_INFO = utf8.encode('plenum-sas');
const PUSH_INFO = utf8.encode('plenum-push');
const STOP_INFO = utf8.encode('plenum-stop');
const MAC1_LABEL = utf8.encode('plenum-mac1');

function checkedHash(h) {
  if (!isBytes(h) || h.length !== HASHLEN) throw fail('ARG');
  return h;
}

/** The 6-digit short authentication string of a finished handshake, e.g. '482913' (leading zeros kept). Same value on both sides. */
export function sas(handshakeHash) {
  const o = hkdf(sha256, checkedHash(handshakeHash), EMPTY, SAS_INFO, 4);
  const n = (((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0) % 1000000;
  return String(n).padStart(6, '0');
}
/** '482913' -> '482 913', the form shown on both screens. */
export function formatSas(code) {
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) throw fail('ARG');
  return code.slice(0, 3) + ' ' + code.slice(3);
}
/** The 32-byte key for native push (phase 3b): HKDF-SHA256(h, salt '', info 'plenum-push'). Both sides store it at pairing. */
export function pushKey(handshakeHash) {
  return hkdf(sha256, checkedHash(handshakeHash), EMPTY, PUSH_INFO, 32);
}
// The device's Stop key: HKDF-SHA256(ikm = handshake hash h, salt = '', info = 'plenum-stop', L = 32).
export function stopKey(handshakeHash) {
  return hkdf(sha256, checkedHash(handshakeHash), EMPTY, STOP_INFO, 32);
}

// --- DoS controls ----------------------------------------------------------------------------------------------------------------

/** SHA256('plenum-mac1' || desktop static public key): the mac1 HMAC key. */
export function mac1Key(desktopPublic) {
  return sha256(concat(MAC1_LABEL, key32(desktopPublic)));
}
/** The 16-byte mac1 of a Noise message 1. */
export function computeMac1(desktopPublic, body) {
  return hmac(sha256, mac1Key(desktopPublic), copyBytes(body)).slice(0, MAC_LEN);
}
export { computeMac1 as mac1 };
/** mac2 over (Noise message 1 || mac1) keyed by a cookie; 16 zero bytes when there is no cookie. */
export function computeMac2(cookie, bodyAndMac1) {
  if (cookie === undefined || cookie === null) return new Uint8Array(MAC_LEN);
  if (!isBytes(cookie) || cookie.length !== MAC_LEN) throw fail('ARG');
  return hmac(sha256, cookie, copyBytes(bodyAndMac1)).slice(0, MAC_LEN);
}
export { computeMac2 as mac2 };
/** Phone side: Noise message 1 -> wire message 1 = body || mac1 || mac2 (mac2 only when a cookie reply was received). */
export function sealMessage1(desktopPublic, body, cookie) {
  const b = copyBytes(body);
  if (b.length > MAX_NOISE_MESSAGE) throw fail('TOO_BIG');
  const mac1 = computeMac1(desktopPublic, b);
  const withMac1 = concat(b, mac1);
  return concat(withMac1, computeMac2(cookie, withMac1));
}
/** Splits wire message 1 into { body, mac1, mac2 }, or returns null when it is too short or too long. No cryptography is done. */
export function splitMessage1(wire) {
  if (!isBytes(wire) || wire.length < 2 * MAC_LEN || wire.length > MAX_NOISE_MESSAGE + 2 * MAC_LEN) return null;
  const end = wire.length - 2 * MAC_LEN;
  return { body: wire.subarray(0, end), mac1: wire.subarray(end, end + MAC_LEN), mac2: wire.subarray(end + MAC_LEN) };
}
/** Desktop side, before any DH: does the wire message carry the right mac1 for this desktop key? Constant-time; false for malformed input. */
export function checkMac1(desktopPublic, wire) {
  const parts = splitMessage1(wire);
  if (!parts) return false;
  return equalBytes(computeMac1(desktopPublic, parts.body), parts.mac1);
}
/** Desktop side, while under load: does mac2 prove the sender holds this cookie? Constant-time; false for malformed input. */
export function checkMac2(cookie, wire) {
  const parts = splitMessage1(wire);
  if (!parts || !isBytes(cookie) || cookie.length !== MAC_LEN) return false;
  return equalBytes(computeMac2(cookie, wire.subarray(0, wire.length - MAC_LEN)), parts.mac2);
}
/** The 17-byte cookie reply 0x7f || cookie. */
export function cookieReply(cookie) {
  if (!isBytes(cookie) || cookie.length !== MAC_LEN) throw fail('ARG');
  return concat(Uint8Array.of(COOKIE_TYPE), cookie);
}
/** Phone side: the cookie inside a cookie reply, or null when the bytes are not one. */
export function parseCookieReply(bytes) {
  if (!isBytes(bytes) || bytes.length !== 1 + MAC_LEN || bytes[0] !== COOKIE_TYPE) return null;
  return bytes.slice(1);
}

function monotonicNow() {
  const p = typeof performance !== 'undefined' ? performance : null;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

/**
 * Cookie secrets that rotate every `rotateMs` (120 s). cookie(address) is HMAC-SHA256(secret, address)[0..16]; check() accepts the
 * current and the previous secret, so a cookie lives 120 to 240 s. `now` is a monotonic millisecond clock (inject a fake one in tests).
 * @param {{ now?: () => number, random?: (n: number) => Uint8Array, rotateMs?: number }} [options]
 */
export function createCookieIssuer(options = {}) {
  const now = options.now || monotonicNow;
  const random = pickRandom(options.random);
  const rotateMs = options.rotateMs === undefined ? COOKIE_ROTATE_MS : options.rotateMs;
  if (typeof now !== 'function' || !(rotateMs > 0)) throw fail('ARG');
  let cur = freshKey(random);
  let prev = null;
  let since = now();
  const roll = () => {
    const elapsed = now() - since;
    if (elapsed >= 2 * rotateMs) {
      wipe(cur, prev);
      cur = freshKey(random);
      prev = null;
      since = now();
    } else if (elapsed >= rotateMs) {
      wipe(prev);
      prev = cur;
      cur = freshKey(random);
      since = now();
    }
  };
  const derive = (secret, address) => hmac(sha256, secret, utf8.encode(address)).slice(0, MAC_LEN);
  const addr = (a) => {
    if (typeof a !== 'string' || a.length === 0) throw fail('ARG');
    return a;
  };
  return Object.freeze({
    /** The 16-byte cookie for a source address string. */
    cookie(address) {
      roll();
      return derive(cur, addr(address));
    },
    /** True when `cookie` is the current or previous cookie for this source address. */
    check(address, cookie) {
      roll();
      if (!isBytes(cookie) || cookie.length !== MAC_LEN) return false;
      const a = equalBytes(derive(cur, addr(address)), cookie);
      const b = prev ? equalBytes(derive(prev, addr(address)), cookie) : false;
      return a || b;
    },
    wipe() {
      wipe(cur, prev);
      prev = null;
    },
  });
}
