// The phone registry: this computer's static key, the LAN path key, the relay room and host secret, the VAPID key pair, and one record
// per paired phone (MOBILE.json transport.identity_storage, revocation). Owned by mob-03.
//
// Where it is kept. The whole registry is one JSON text, written through a storage object:
//   - under the desktop app, the shell channel ('phones-store-load' / 'phones-store-save', desktop/handlers/phones.cjs), which encrypts
//     it with Electron safeStorage into phones.json in the user-data folder;
//   - under plain node, phones.json in the state folder, written through a temporary file and a rename, mode 0600 where the system has
//     modes (the phone-plain-node notice says it is not encrypted).
// A storage that cannot be read or written leaves the registry `unavailable`: nothing is created and every change answers 503 with the
// storage's own sentence. Nothing is ever kept as plain text under the desktop app.
//
// What a record holds: { id (sha256 of the phone's static public key, lower-case hex), publicKey (hex), name, platform ('ios' |
// 'android' | 'web'), app ('pwa' | 'android' | 'ios' | 'lan-web'), appVersion, created, lastSeen, lastCarrier, tier ('full' | 'approve' |
// 'read'), handshakeCounter (the highest the phone has used; it only rises), pushSubscription, pushKey (hex, native push),
// stopKey (hex, the Stop-only key of lib/remote/stop-only.mjs; '' when none), expiresAfterDays, approveFromNotifications }. Names are cleaned (control, format and bidirectional characters out, 60 characters).
//
// Changes that matter are saved before the call returns (add, counters, remove, remove-all, tiers). lastSeen is saved later, in the
// background. Listeners: on('removed', ({ id })), on('reset', ({ pathKey })), on('relay-room', {}), on('tier', ({ id, tier })), on('changed').
//
// Nothing here logs a key, a counter, a subscription or a name. Errors are fixed sentences.
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { bytesToHex, deviceId, generateKeyPair, hexToBytes, publicKeyOf } from './noise.mjs';
import { isTier } from './tiers.mjs';

export const STORE_FILE = 'phones.json';
export const STORE_VERSION = 1;
export const MAX_DEVICES = 32;
export const MAX_NAME = 60;
export const PLATFORMS = Object.freeze(['ios', 'android', 'web']);
export const APPS = Object.freeze(['pwa', 'android', 'ios', 'lan-web']);
const MAX_STORE_TEXT = 1024 * 1024;
const MAX_SUBSCRIPTION_JSON = 4096;
const SEEN_SAVE_MS = 30_000;
const DAY_MS = 86_400_000;
const HEX = /^[0-9a-f]+$/;

const MESSAGES = Object.freeze({
  unavailable: 'Phone keys cannot be kept on this computer right now.',
  full: 'This computer already has the most phones it can hold. Remove one first.',
  unknown: 'That phone is not paired.',
  tier: 'The tier must be full, approve or read.',
  save: 'The phone data could not be saved.',
  key: 'The phone sent a key that is not valid.',
});

function fail(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

// Code points a name never keeps. Controls and line or paragraph separators become a space; the soft hyphen, the Arabic letter mark,
// zero-width space, the left-to-right and right-to-left marks, the bidirectional embeddings, overrides and isolates, the invisible
// operators, the byte order mark and the interlinear annotation marks are deleted. The zero-width joiners (U+200C and U+200D) stay,
// because emoji and some scripts need them. Both sets are built from numbers so the source holds no invisible characters.
const range = list => new RegExp(`[${list.map(([a, b]) => String.fromCodePoint(a) + (b > a ? `-${String.fromCodePoint(b)}` : '')).join('')}]+`, 'g');
const TO_SPACE = range([[0, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029]]);
const DELETE = range([[0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]]);

// Text from a phone that fits on one line of a window, a notification or a list: control, format and bidirectional characters out,
// spaces collapsed, clipped to `max` characters (not UTF-16 units, so a name never ends in half an emoji).
export function cleanName(value, max = MAX_NAME, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value
    .replace(DELETE, '')
    .replace(TO_SPACE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = Array.from(text).slice(0, max).join('').trim();
  return clipped || fallback;
}

const pick = (value, list, fallback) => (typeof value === 'string' && list.includes(value) ? value : fallback);
const whole = (value, min, max, fallback) => (Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const versionText = value => (typeof value === 'string' && /^[A-Za-z0-9._+-]{1,24}$/.test(value) ? value : '');
const hexOf = (value, bytes) => (typeof value === 'string' && value.length === bytes * 2 && HEX.test(value) ? value : '');

// ---------------------------------------------------------------------------------------------------------------------------------
// Storage

/**
 * Plain node: phones.json in `dir`. Written through a temporary file and a rename, mode 0600.
 * @param {{ dir: string, fs?: typeof fsp, random?: (n: number) => Uint8Array }} options
 */
export function createFileStorage({ dir, fs = fsp, random = nodeRandomBytes } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new TypeError('A file storage needs a folder.');
  const file = path.join(dir, STORE_FILE);
  let damagedCount = 0;
  return {
    kind: 'file',
    file,
    async load() {
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return { ok: true, storage: 'file', text: '', damaged: false };
        return { ok: false, storage: 'locked', message: 'The phones file could not be read, so phone keys cannot be used. Check that no other program has it open.' };
      }
      if (text.length > MAX_STORE_TEXT) return { ok: true, storage: 'file', text: '', damaged: true };
      return { ok: true, storage: 'file', text, damaged: false };
    },
    // A file that parsed badly is renamed, never deleted, the first time something new is saved.
    async setAside() {
      damagedCount += 1;
      const target = `${file}.damaged${damagedCount > 1 ? `-${damagedCount}` : ''}`;
      try {
        await fs.rename(file, target);
      } catch {
        // If it cannot be moved the new file replaces it.
      }
    },
    async save(text) {
      if (typeof text !== 'string' || text.length > MAX_STORE_TEXT) return { ok: false, message: MESSAGES.save };
      const temp = `${file}.${process.pid}.${Buffer.from(random(4)).toString('hex')}.tmp`;
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, file);
        return { ok: true, storage: 'file' };
      } catch {
        try {
          await fs.rm(temp, { force: true });
        } catch {
          // Nothing more to clean.
        }
        return { ok: false, message: MESSAGES.save };
      }
    },
  };
}

/**
 * The desktop app: the shell channel. `request(type, payload)` is lib/shell.mjs shellRequest.
 * @param {{ request: (type: string, payload?: object) => Promise<any> }} options
 */
export function createShellStorage({ request } = {}) {
  if (typeof request !== 'function') throw new TypeError('A shell storage needs a request function.');
  return {
    kind: 'shell',
    async load() {
      try {
        const r = await request('phones-store-load', {});
        if (!r || r.ok !== true) return { ok: false, storage: r?.storage === 'locked' ? 'locked' : 'unavailable', message: typeof r?.message === 'string' ? r.message.slice(0, 400) : MESSAGES.unavailable };
        return { ok: true, storage: 'keychain', text: typeof r.text === 'string' ? r.text : '', damaged: r.damaged === true, message: typeof r.message === 'string' ? r.message.slice(0, 400) : '' };
      } catch {
        return { ok: false, storage: 'unavailable', message: 'The desktop app did not answer, so phone keys cannot be used.' };
      }
    },
    async save(text) {
      try {
        const r = await request('phones-store-save', { text });
        if (!r || r.ok !== true) return { ok: false, message: typeof r?.message === 'string' ? r.message.slice(0, 400) : MESSAGES.save };
        return { ok: true, storage: 'keychain' };
      } catch {
        return { ok: false, message: MESSAGES.save };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The registry

/**
 * @param {{ storage: object, wallNow?: () => number, random?: (n: number) => Uint8Array, setTimer?: Function }} options
 *   random must return a NEW n-byte array each call (it is also used for key pairs).
 */
export function createRegistry({ storage, wallNow = Date.now, random = n => new Uint8Array(nodeRandomBytes(n)), setTimer = setTimeout } = {}) {
  if (!storage || typeof storage.load !== 'function' || typeof storage.save !== 'function') throw new TypeError('A registry needs a storage object.');

  const data = { identity: null, pathKey: '', relay: null, vapid: null, computerId: '', devices: new Map() };
  const byPublic = new Map(); // public key hex -> device id
  const listeners = new Map();
  let loaded = null;
  let status = { loaded: false, ok: false, storage: 'unavailable', message: MESSAGES.unavailable, damaged: false };
  let saving = null;
  let dirty = false;
  let lastSave = { ok: true, message: '' };
  let seenTimer = null;

  const emit = (name, payload) => {
    for (const fn of [...(listeners.get(name) ?? [])]) {
      try {
        fn(payload);
      } catch {
        // A listener that throws changes nothing for the others.
      }
    }
  };

  const randomHex = n => bytesToHex(random(n));

  // ----- loading and saving -----

  function readDevice(raw) {
    if (!isObject(raw)) return null;
    const publicKey = hexOf(raw.publicKey, 32);
    if (!publicKey) return null;
    let id;
    try {
      id = deviceId(hexToBytes(publicKey));
    } catch {
      return null;
    }
    const now = wallNow();
    let subscription = null;
    if (isObject(raw.pushSubscription) && JSON.stringify(raw.pushSubscription).length <= MAX_SUBSCRIPTION_JSON) subscription = raw.pushSubscription;
    return {
      id,
      publicKey,
      name: cleanName(raw.name, MAX_NAME, 'Phone'),
      platform: pick(raw.platform, PLATFORMS, 'web'),
      app: pick(raw.app, APPS, 'pwa'),
      appVersion: versionText(raw.appVersion),
      created: whole(raw.created, 0, 8.64e15, now),
      lastSeen: whole(raw.lastSeen, 0, 8.64e15, 0),
      lastCarrier: pick(raw.lastCarrier, ['lan', 'tailscale', 'relay'], ''),
      // A record with a tier this code does not know gets the least: Full is only ever given by Allow.
      tier: isTier(raw.tier) ? raw.tier : 'read',
      handshakeCounter: whole(raw.handshakeCounter, 0, Number.MAX_SAFE_INTEGER, 0),
      pushSubscription: subscription,
      pushKey: hexOf(raw.pushKey, 32),
      stopKey: hexOf(raw.stopKey, 32),
      expiresAfterDays: whole(raw.expiresAfterDays, 0, 3650, 0),
      approveFromNotifications: raw.approveFromNotifications === true,
    };
  }

  function adopt(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isObject(parsed) || parsed.v !== STORE_VERSION) return false;
    let identity = null;
    if (isObject(parsed.identity)) {
      const priv = hexOf(parsed.identity.privateKey, 32);
      if (priv) {
        try {
          const pub = bytesToHex(publicKeyOf(hexToBytes(priv)));
          identity = { privateKey: priv, publicKey: pub };
        } catch {
          identity = null;
        }
      }
    }
    data.identity = identity;
    data.pathKey = hexOf(parsed.pathKey, 16);
    data.computerId = hexOf(parsed.computerId, 8);
    data.relay = isObject(parsed.relay) && typeof parsed.relay.roomId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(parsed.relay.roomId) && hexOf(parsed.relay.hostSecret, 32)
      ? { roomId: parsed.relay.roomId, hostSecret: parsed.relay.hostSecret }
      : null;
    data.vapid = isObject(parsed.vapid) && typeof parsed.vapid.publicKey === 'string' && typeof parsed.vapid.privateKey === 'string'
      ? { publicKey: parsed.vapid.publicKey.slice(0, 200), privateKey: parsed.vapid.privateKey.slice(0, 200) }
      : null;
    data.devices.clear();
    byPublic.clear();
    for (const raw of Array.isArray(parsed.devices) ? parsed.devices.slice(0, MAX_DEVICES * 2) : []) {
      const record = readDevice(raw);
      if (!record || data.devices.has(record.id) || data.devices.size >= MAX_DEVICES) continue;
      data.devices.set(record.id, record);
      byPublic.set(record.publicKey, record.id);
    }
    return true;
  }

  function serialize() {
    return JSON.stringify({
      v: STORE_VERSION,
      identity: data.identity,
      pathKey: data.pathKey,
      computerId: data.computerId,
      relay: data.relay,
      vapid: data.vapid,
      devices: [...data.devices.values()],
    });
  }

  // Loads once. Resolves the status; never rejects.
  function ready() {
    if (!loaded) {
      loaded = (async () => {
        let result;
        try {
          result = await storage.load();
        } catch {
          result = { ok: false, storage: 'unavailable', message: MESSAGES.unavailable };
        }
        if (!result?.ok) {
          status = { loaded: true, ok: false, storage: result?.storage ?? 'unavailable', message: result?.message || MESSAGES.unavailable, damaged: false };
          return status;
        }
        let damaged = result.damaged === true;
        if (typeof result.text === 'string' && result.text.length > 0 && !damaged) {
          if (!adopt(result.text)) damaged = true;
        }
        if (damaged) {
          // The old text stays on disk under another name (plain node) or is set aside by the handler at the next save (desktop).
          try {
            await storage.setAside?.();
          } catch {
            // The next save replaces it.
          }
        }
        status = { loaded: true, ok: true, storage: result.storage ?? storage.kind, message: result.message || '', damaged };
        return status;
      })();
    }
    return loaded;
  }

  function persist() {
    dirty = true;
    if (!saving) {
      saving = (async () => {
        try {
          while (dirty) {
            dirty = false;
            const result = await storage.save(serialize());
            lastSave = result?.ok ? { ok: true, message: '' } : { ok: false, message: result?.message || MESSAGES.save };
          }
        } finally {
          saving = null;
        }
        return lastSave;
      })();
    }
    return saving;
  }

  // Saves and throws the storage's sentence when the save did not work, so a pairing is never reported for a key that was not kept.
  async function persistNow() {
    const result = await persist();
    if (!result.ok) throw fail(result.message || MESSAGES.save, 503);
  }

  function requireStorage() {
    if (!status.loaded) throw fail('The phone registry has not loaded yet.', 503);
    if (!status.ok) throw fail(status.message || MESSAGES.unavailable, 503);
  }

  // ----- identity -----

  async function ensureIdentity() {
    await ready();
    requireStorage();
    let changed = false;
    if (!data.identity) {
      const pair = generateKeyPair(random);
      data.identity = { privateKey: bytesToHex(pair.privateKey), publicKey: bytesToHex(pair.publicKey) };
      pair.privateKey.fill(0);
      changed = true;
    }
    if (!data.pathKey) {
      data.pathKey = randomHex(16);
      changed = true;
    }
    if (!data.computerId) {
      data.computerId = randomHex(8);
      changed = true;
    }
    if (changed) await persistNow();
    return identity();
  }

  // Copies of the key bytes; the caller wipes its copy when it is done.
  function identity() {
    if (!data.identity) return null;
    return { privateKey: hexToBytes(data.identity.privateKey), publicKey: hexToBytes(data.identity.publicKey) };
  }

  // ----- views -----

  const view = d => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    app: d.app,
    appVersion: d.appVersion,
    tier: d.tier,
    created: d.created,
    lastSeen: d.lastSeen,
    lastCarrier: d.lastCarrier,
    push: d.pushSubscription ? (d.pushSubscription.kind ?? 'webpush') : null,
    expiresAfterDays: d.expiresAfterDays,
    approveFromNotifications: d.approveFromNotifications,
  });

  const list = () => [...data.devices.values()].sort((a, b) => a.created - b.created).map(view);
  const get = id => (typeof id === 'string' && data.devices.has(id) ? view(data.devices.get(id)) : null);
  const tierOf = id => data.devices.get(id)?.tier ?? null;

  // What the handshake needs: the highest counter stored for a phone's static key, or undefined for a key this computer does not hold.
  function counterOf(publicKey) {
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return undefined;
    const id = byPublic.get(bytesToHex(publicKey));
    return id === undefined ? undefined : data.devices.get(id).handshakeCounter;
  }
  const idOfPublic = publicKey => (publicKey instanceof Uint8Array && publicKey.length === 32 ? byPublic.get(bytesToHex(publicKey)) ?? null : null);

  // ----- changes -----

  /**
   * Writes a newly allowed phone. Called only after the person pressed Allow. A phone whose key is already here is updated, not doubled.
   * @param {{ publicKey: Uint8Array, name: string, platform?: string, app?: string, appVersion?: string, counter: number, carrier?: string, tier?: string, pushKey?: Uint8Array, stopKey?: Uint8Array, expiresAfterDays?: number }} input
   */
  async function add(input) {
    await ready();
    requireStorage();
    if (!(input?.publicKey instanceof Uint8Array) || input.publicKey.length !== 32) throw fail(MESSAGES.key, 400);
    const publicKey = bytesToHex(input.publicKey);
    const id = deviceId(input.publicKey);
    const existing = data.devices.get(id);
    if (!existing && data.devices.size >= MAX_DEVICES) throw fail(MESSAGES.full, 409);
    const now = wallNow();
    const record = {
      id,
      publicKey,
      name: cleanName(input.name, MAX_NAME, 'Phone'),
      platform: pick(input.platform, PLATFORMS, 'web'),
      app: pick(input.app, APPS, 'pwa'),
      appVersion: versionText(input.appVersion),
      created: existing?.created ?? now,
      lastSeen: now,
      lastCarrier: pick(input.carrier, ['lan', 'tailscale', 'relay'], ''),
      // D6: the owner's default; 'approve' for input.app === 'lan-web' would go here
      tier: isTier(input.tier) ? input.tier : (existing?.tier ?? 'full'),
      // A re-pairing never lowers the counter: a phone's earlier message 1 must stay refused (the counter only rises).
      handshakeCounter: Math.max(existing?.handshakeCounter ?? 0, whole(input.counter, 0, Number.MAX_SAFE_INTEGER, 0)),
      pushSubscription: null,
      pushKey: input.pushKey instanceof Uint8Array && input.pushKey.length === 32 ? bytesToHex(input.pushKey) : '',
      // A re-pair brings a new Stop key.
      stopKey: input.stopKey instanceof Uint8Array && input.stopKey.length === 32 ? bytesToHex(input.stopKey) : '',
      expiresAfterDays: whole(input.expiresAfterDays, 0, 3650, existing?.expiresAfterDays ?? 0),
      approveFromNotifications: false,
    };
    data.devices.set(id, record);
    byPublic.set(publicKey, id);
    try {
      await persistNow();
    } catch (err) {
      // Nothing is kept for a pairing whose key could not be saved.
      if (existing) {
        data.devices.set(id, existing);
      } else {
        data.devices.delete(id);
        byPublic.delete(publicKey);
      }
      throw err;
    }
    emit('changed', { id });
    return view(record);
  }

  // Read-only: whether recordHandshake would take this counter for this device right now (the device is held and the counter is a safe
  // integer above the stored one). Nothing is saved or changed. A STOP_ONLY asks this before it counts against the phone's window, so copies
  // of one captured message (a valid signature, a counter that does not rise) cannot use up the window of the real phone.
  const counterRises = (id, counter) => {
    const d = data.devices.get(id);
    return d !== undefined && Number.isSafeInteger(counter) && counter > d.handshakeCounter;
  };

  // Stores the handshake counter of a phone before the handshake is answered. Throws when it could not be saved, and then nothing
  // is answered: a counter that was not kept would let the same message 1 be played again after a restart.
  async function recordHandshake(id, counter, carrier) {
    const d = data.devices.get(id);
    if (!d) throw fail(MESSAGES.unknown, 404);
    if (!Number.isSafeInteger(counter) || counter <= d.handshakeCounter) throw fail('The handshake counter did not rise.', 409);
    const before = { handshakeCounter: d.handshakeCounter, lastSeen: d.lastSeen, lastCarrier: d.lastCarrier };
    d.handshakeCounter = counter;
    d.lastSeen = wallNow();
    d.lastCarrier = pick(carrier, ['lan', 'tailscale', 'relay'], d.lastCarrier);
    try {
      await persistNow();
    } catch (err) {
      Object.assign(d, before);
      throw err;
    }
  }

  // The Stop-only key of a phone (stop-only.mjs): a fresh 32-byte copy the caller wipes, or null when the phone has none.
  const stopKeyOf = id => {
    const hex = data.devices.get(id)?.stopKey;
    return hex ? hexToBytes(hex) : null;
  };

  // Stores a phone's Stop key (a session's top-up, listener.mjs startSession). The old key is replaced. On a failed save the old value
  // comes back and this throws.
  async function setStopKey(id, bytes) {
    await ready();
    requireStorage();
    const d = data.devices.get(id);
    if (!d) throw fail(MESSAGES.unknown, 404);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw fail(MESSAGES.key, 400);
    const before = d.stopKey;
    d.stopKey = bytesToHex(bytes);
    try {
      await persistNow();
    } catch (err) {
      d.stopKey = before;
      throw err;
    }
  }

  // lastSeen (and the carrier) is saved in the background, at most every 30 seconds.
  function touch(id, carrier) {
    const d = data.devices.get(id);
    if (!d) return;
    d.lastSeen = wallNow();
    if (carrier) d.lastCarrier = pick(carrier, ['lan', 'tailscale', 'relay'], d.lastCarrier);
    if (seenTimer === null) {
      seenTimer = setTimer(() => {
        seenTimer = null;
        persist();
      }, SEEN_SAVE_MS);
      seenTimer?.unref?.();
    }
  }

  async function update(id, patch) {
    const d = data.devices.get(id);
    if (!d) throw fail(MESSAGES.unknown, 404);
    const before = { ...d };
    if (patch.tier !== undefined) {
      if (!isTier(patch.tier)) throw fail(MESSAGES.tier, 400);
      d.tier = patch.tier;
    }
    if (patch.expiresAfterDays !== undefined) d.expiresAfterDays = whole(patch.expiresAfterDays, 0, 3650, d.expiresAfterDays);
    if (patch.approveFromNotifications !== undefined) d.approveFromNotifications = patch.approveFromNotifications === true;
    if (patch.pushSubscription !== undefined) {
      if (patch.pushSubscription === null) d.pushSubscription = null;
      else if (isObject(patch.pushSubscription) && JSON.stringify(patch.pushSubscription).length <= MAX_SUBSCRIPTION_JSON) d.pushSubscription = patch.pushSubscription;
      else throw fail('That push subscription is not valid.', 400);
    }
    if (patch.name !== undefined) d.name = cleanName(patch.name, MAX_NAME, d.name);
    try {
      await persistNow();
    } catch (err) {
      Object.assign(d, before);
      throw err;
    }
    if (patch.tier !== undefined && patch.tier !== before.tier) emit('tier', { id, tier: d.tier });
    emit('changed', { id });
    return view(d);
  }

  // Applies one setting to every phone (auto-expire days). Saved once.
  async function updateAll(patch) {
    const before = [...data.devices.values()].map(d => ({ d, expiresAfterDays: d.expiresAfterDays }));
    for (const d of data.devices.values()) {
      if (patch.expiresAfterDays !== undefined) d.expiresAfterDays = whole(patch.expiresAfterDays, 0, 3650, 0);
    }
    try {
      await persistNow();
    } catch (err) {
      for (const b of before) b.d.expiresAfterDays = b.expiresAfterDays;
      throw err;
    }
    emit('changed', {});
  }

  // Deletes one phone (its push subscription goes with the record). Listeners hear 'removed' before the save finishes, so the live
  // channel is closed within one tick whatever the disk does.
  async function remove(id) {
    const d = data.devices.get(id);
    if (!d) return false;
    data.devices.delete(id);
    byPublic.delete(d.publicKey);
    emit('removed', { id });
    try {
      await persistNow();
    } catch (err) {
      // The phone is gone from memory and its channels are closed; the file still lists it until the next save works.
      throw err;
    }
    emit('changed', { id });
    return true;
  }

  // Remove all and change this computer's key: every phone goes; the static key, the path key and the relay room id and host secret are replaced.
  async function removeAll({ rotate = true } = {}) {
    await ready();
    requireStorage();
    const ids = [...data.devices.keys()];
    data.devices.clear();
    byPublic.clear();
    for (const id of ids) emit('removed', { id });
    if (rotate) {
      const pair = generateKeyPair(random);
      data.identity = { privateKey: bytesToHex(pair.privateKey), publicKey: bytesToHex(pair.publicKey) };
      pair.privateKey.fill(0);
      data.pathKey = randomHex(16);
      if (data.relay) data.relay = { roomId: randomHex(16), hostSecret: randomHex(32) };
    }
    emit('reset', { pathKey: data.pathKey, rotated: rotate });
    await persistNow();
    emit('changed', {});
    return { removed: ids.length, pathKey: data.pathKey };
  }

  // Removes phones not seen for their own number of days. `connected(id)` spares a phone that is connected now.
  async function sweepExpired({ connected = () => false } = {}) {
    const now = wallNow();
    const gone = [];
    for (const d of data.devices.values()) {
      if (!(d.expiresAfterDays > 0) || connected(d.id)) continue;
      const seen = d.lastSeen || d.created;
      if (now - seen > d.expiresAfterDays * DAY_MS) gone.push(d.id);
    }
    for (const id of gone) await remove(id);
    return gone;
  }

  // ----- relay room, VAPID keys -----

  const relay = () => (data.relay ? { ...data.relay } : null);
  async function ensureRelay() {
    await ready();
    requireStorage();
    if (!data.relay) {
      data.relay = { roomId: randomHex(16), hostSecret: randomHex(32) };
      await persistNow();
    }
    return relay();
  }

  // A new room id and host secret (D9). The old room keeps no host; phones paired through it must pair again. Listeners hear
  // 'relay-room' and the relay carrier reconnects to the new room.
  async function newRelayRoom() {
    await ensureRelay();
    const before = data.relay;
    data.relay = { roomId: randomHex(16), hostSecret: randomHex(32) };
    try {
      await persistNow();
    } catch (err) {
      data.relay = before;
      throw err;
    }
    emit('relay-room', {});
    return { roomId: data.relay.roomId };
  }

  const vapidStore = Object.freeze({
    load: () => (data.vapid ? { ...data.vapid } : null),
    save: keys => {
      if (!isObject(keys) || typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') return;
      data.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
      persist();
    },
  });

  return {
    ready,
    status: () => ({ ...status }),
    available: () => status.loaded && status.ok,
    ensureIdentity,
    identity,
    publicKeyHex: () => data.identity?.publicKey ?? '',
    pathKey: () => data.pathKey,
    computerId: () => data.computerId,
    relay,
    ensureRelay,
    newRelayRoom,
    vapidStore,
    list,
    get,
    tierOf,
    counterOf,
    idOfPublic,
    publicKeyOfDevice: id => (data.devices.has(id) ? hexToBytes(data.devices.get(id).publicKey) : null),
    pushSubscriptionOf: id => data.devices.get(id)?.pushSubscription ?? null,
    pushKeyOf: id => data.devices.get(id)?.pushKey ?? '',
    stopKeyOf,
    setStopKey,
    add,
    counterRises,
    recordHandshake,
    touch,
    update,
    updateAll,
    remove,
    removeAll,
    sweepExpired,
    // Waits for the save in progress, and saves a pending lastSeen now instead of at its timer.
    flush() {
      if (seenTimer !== null) {
        clearTimeout(seenTimer);
        seenTimer = null;
        return persist();
      }
      return saving ?? Promise.resolve(lastSave);
    },
    on(name, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    size: () => data.devices.size,
  };
}
