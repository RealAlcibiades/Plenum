// Pure helpers shared by the suites: ids, secrets, the connection-id envelope.
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const hexRoom = () => randomBytes(16).toString('hex');
export const newSecret = () => randomBytes(24).toString('base64url');
export const hashOf = (secret) => createHash('sha256').update(secret, 'utf8').digest('hex');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const bytesOf = (length, fill = 7) => Buffer.alloc(length, fill);

// Host handshake headers, as the desktop sends them.
export const hostHeaders = (secret) => ({ 'x-plenum-role': 'host', 'x-plenum-host-secret': secret });

// [conn u32 big-endian][payload]. Connection 0 is control to the room.
export function framed(conn, payload) {
  const body = Buffer.from(payload);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(conn >>> 0, 0);
  body.copy(out, 4);
  return out;
}

export const control = (object) => framed(0, JSON.stringify(object));

export const connIdOf = (message) => Buffer.from(message).readUInt32BE(0);

// A random connection id that is not 0 and not in the list.
export function unusedConn(taken = []) {
  for (;;) {
    const id = randomInt(1, 0xffffffff);
    if (!taken.includes(id)) return id;
  }
}
