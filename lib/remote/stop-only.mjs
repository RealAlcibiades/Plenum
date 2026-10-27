// Stop without unlocking (MOBILE.json floor: Stop from the phone always works). A locked phone opens a carrier socket and sends one
// STOP_ONLY message instead of a Noise handshake; the desktop checks it before any DH, stops everything, answers one STOP_ONLY_ACK and
// closes. The message is signed, not encrypted, with the device's Stop key (noise.mjs stopKey): all it can do is stop runs.
//
// STOP_ONLY, phone -> desktop, 90 bytes:
//   [0]       0x7e  type
//   [1]       0x01  version
//   [2..34)   deviceId, 32 bytes (the registry id as bytes: sha256 of the phone's static public key)
//   [34..42)  counter, unsigned 64-bit big-endian (a safe integer; the handshake counter, strictly rising)
//   [42..58)  stopId, 16 random bytes (the same id on every resend of one press)
//   [58..90)  HMAC-SHA256(stopKey, bytes [0..58))
// STOP_ONLY_ACK, desktop -> phone, 66 bytes:
//   [0]       0x7d  type
//   [1]       0x01  version
//   [2..18)   stopId
//   [18..34)  cancelled, drivesStopped, agentsStopped, cardsDenied as u32 big-endian, XOR a pad:
//             pad = HMAC-SHA256(stopKey, utf8('plenum-stop-ack') || stopId)[0..16]
//   [34..66)  HMAC-SHA256(stopKey, bytes [0..34))
// A Noise message 1 is at least 128 bytes, so a 90-byte first message that starts 0x7e 0x01 is never one.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const STOP_ONLY_TYPE = 0x7e;
export const STOP_ACK_TYPE = 0x7d;
export const STOP_ONLY_VERSION = 0x01;
export const STOP_ONLY_LEN = 90;
export const STOP_ACK_LEN = 66;
const PAD_INFO = new TextEncoder().encode('plenum-stop-ack');
const COUNT_KEYS = ['cancelled', 'drivesStopped', 'agentsStopped', 'cardsDenied'];
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function key32(k) {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new TypeError('stop key length');
  return k;
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function idBytes(stopId) {
  const b = typeof stopId === 'string' ? (HEX32.test(stopId) ? hexToBytes(stopId) : null) : stopId;
  if (!(b instanceof Uint8Array) || b.length !== 16) throw new TypeError('stop id');
  return b;
}
function padFor(stopKey, idB) {
  const msg = new Uint8Array(PAD_INFO.length + 16);
  msg.set(PAD_INFO);
  msg.set(idB, PAD_INFO.length);
  return hmac(sha256, stopKey, msg).subarray(0, 16);
}

export function isStopOnly(bytes) {
  return bytes instanceof Uint8Array && bytes.length === STOP_ONLY_LEN && bytes[0] === STOP_ONLY_TYPE && bytes[1] === STOP_ONLY_VERSION;
}

export function encodeStopOnly({ stopKey, deviceId, counter, stopId }) {
  key32(stopKey);
  if (!HEX64.test(String(deviceId))) throw new TypeError('device id');
  if (!Number.isSafeInteger(counter) || counter < 1) throw new TypeError('counter');
  const out = new Uint8Array(STOP_ONLY_LEN);
  out[0] = STOP_ONLY_TYPE;
  out[1] = STOP_ONLY_VERSION;
  out.set(hexToBytes(deviceId), 2);
  const view = new DataView(out.buffer);
  view.setUint32(34, Math.floor(counter / 2 ** 32));
  view.setUint32(38, counter >>> 0);
  out.set(idBytes(stopId), 42);
  out.set(hmac(sha256, stopKey, out.subarray(0, 58)), 58);
  return out;
}

// { deviceId (hex), counter, stopId (hex) }, or null when the bytes are not a well-formed STOP_ONLY. Checks no signature.
export function decodeStopOnly(bytes) {
  if (!isStopOnly(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const counter = view.getUint32(34) * 2 ** 32 + view.getUint32(38);
  if (!Number.isSafeInteger(counter) || counter < 1) return null;
  return { deviceId: bytesToHex(bytes.subarray(2, 34)), counter, stopId: bytesToHex(bytes.subarray(42, 58)) };
}

export function verifyStopOnly(stopKey, bytes) {
  if (!isStopOnly(bytes) || !(stopKey instanceof Uint8Array) || stopKey.length !== 32) return false;
  return equal(hmac(sha256, stopKey, bytes.subarray(0, 58)), bytes.subarray(58, 90));
}

export function encodeStopAck({ stopKey, stopId, counts = {} }) {
  key32(stopKey);
  const idB = idBytes(stopId);
  const out = new Uint8Array(STOP_ACK_LEN);
  out[0] = STOP_ACK_TYPE;
  out[1] = STOP_ONLY_VERSION;
  out.set(idB, 2);
  const view = new DataView(out.buffer);
  COUNT_KEYS.forEach((k, i) => {
    const n = Number(counts[k]);
    view.setUint32(18 + i * 4, Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 0xffffffff) : 0);
  });
  const pad = padFor(stopKey, idB);
  for (let i = 0; i < 16; i++) out[18 + i] ^= pad[i];
  out.set(hmac(sha256, stopKey, out.subarray(0, 34)), 34);
  return out;
}

// The four counts when the bytes are the ACK of this stopId under this key, else null.
export function decodeStopAck(stopKey, bytes, stopId) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== STOP_ACK_LEN || bytes[0] !== STOP_ACK_TYPE || bytes[1] !== STOP_ONLY_VERSION) return null;
  if (!(stopKey instanceof Uint8Array) || stopKey.length !== 32) return null;
  const idB = idBytes(stopId);
  if (!equal(bytes.subarray(2, 18), idB)) return null;
  if (!equal(hmac(sha256, stopKey, bytes.subarray(0, 34)), bytes.subarray(34, 66))) return null;
  const plain = bytes.slice(18, 34);
  const pad = padFor(stopKey, idB);
  for (let i = 0; i < 16; i++) plain[i] ^= pad[i];
  const view = new DataView(plain.buffer);
  const out = {};
  COUNT_KEYS.forEach((k, i) => { out[k] = view.getUint32(i * 4); });
  return out;
}
