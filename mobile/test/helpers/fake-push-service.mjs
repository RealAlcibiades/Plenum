// A fake RFC 8030 push service for the sealed tests. It listens on 127.0.0.1 with
// a random port, records every POST, answers with a status chosen per path, and
// offers an independent RFC 8188 / RFC 8291 decoder (HKDF from node:crypto, not
// the sender's code) so a test can read what a phone would read.

import crypto from 'node:crypto';
import http from 'node:http';

export async function startFakePushService() {
  const received = [];
  const statusByPath = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ method: req.method, path: req.url, headers: { ...req.headers }, body });
      const status = statusByPath.get(req.url) ?? 201;
      res.writeHead(status, { 'Content-Length': '0' });
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    endpointFor(label) {
      return `http://127.0.0.1:${port}/push/${label}`;
    },
    received,
    setStatus(label, status) {
      statusByPath.set(`/push/${label}`, status);
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// A phone-side subscription: a P-256 key pair and a 16-byte auth secret.
export function makePhone(label) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    label,
    ecdh,
    auth,
    subscription(endpoint, extra = {}) {
      return {
        endpoint,
        ...extra,
        keys: {
          p256dh: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'),
          auth: auth.toString('base64url'),
        },
      };
    },
  };
}

// RFC 8188 decoding for a single record, with the RFC 8291 key schedule.
export function decryptPush(body, phone) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const keyId = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = phone.ecdh.computeSecret(keyId);
  const uaPublic = phone.ecdh.getPublicKey(null, 'uncompressed');
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, keyId]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, phone.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (end < 0 || padded[end] !== 0x02) {
    throw new Error('Record delimiter is missing.');
  }
  return { plaintext: padded.subarray(0, end), rs, sealedLength: sealed.length, keyIdLength: idlen };
}
