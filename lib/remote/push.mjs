// Web Push sender for the phone bridge (Plenum mobile track A, mob-08).
// RFC 8291 (aes128gcm content coding with ECDH P-256 and HKDF-SHA256),
// RFC 8292 (VAPID, ES256 JWT) and RFC 8030 (HTTP POST to a push service).
// node:crypto and node:net only. Nothing here logs or returns keys, tokens or
// endpoints, and every error is a fixed sentence.

import crypto from 'node:crypto';
import net from 'node:net';

export const RECORD_SIZE = 4096;
export const PAD_SHORT = 2048; // plaintext bucket for ordinary payloads (padded length incl. delimiter)
export const PAD_LONG = RECORD_SIZE - 16; // 4080: the AES-GCM tag takes 16 octets of the record
export const MAX_PAYLOAD_BYTES = 4000;
export const PUSH_TTL_S = 3600;
export const VAPID_TTL_S = 12 * 3600;
export const VAPID_REFRESH_MS = 3600 * 1000;
export const PRESENCE_IDLE_S = 120;
export const FOREGROUND_WINDOW_MS = 30 * 1000;
export const SEND_TIMEOUT_MS = 15 * 1000;
export const PUSH_KINDS = Object.freeze(['webpush', 'unifiedpush', 'apns-forwarder']);
export const EVENT_KINDS = Object.freeze(['approval', 'handover', 'finished', 'failed', 'limit', 'test']);

const FIRST_LINE_MAX = 120;
const PART_MAX = 60;
const APNS_REFUSAL = 'Phone push through the forwarder is not available in this version.';
const SWITCH_DEFAULTS = Object.freeze({ approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false });

function refusal(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function b64uDecode(text, label) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`${label} is not base64url.`);
  }
  return Buffer.from(text, 'base64url');
}

function ephemeralEcdh() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
}

// ---------------------------------------------------------------- VAPID (RFC 8292)

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return { publicKey: point.toString('base64url'), privateKey: priv.d };
}

function vapidSigningKey(keys) {
  const point = b64uDecode(keys.publicKey, 'VAPID public key');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: keys.privateKey,
    x: point.subarray(1, 33).toString('base64url'),
    y: point.subarray(33, 65).toString('base64url'),
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

export function validVapidKeys(keys) {
  try {
    if (!keys || typeof keys !== 'object') return false;
    const pub = b64uDecode(keys.publicKey, 'VAPID public key');
    const priv = b64uDecode(keys.privateKey, 'VAPID private key');
    if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return false;
    vapidSigningKey(keys);
    return true;
  } catch {
    return false;
  }
}

// The Authorization value for one push origin. Expires after VAPID_TTL_S (12 h).
export function vapidAuthorization({ endpoint, keys, nowMs, contact }) {
  const origin = new URL(endpoint).origin;
  const claims = { aud: origin, exp: Math.floor(nowMs / 1000) + VAPID_TTL_S };
  if (contact) claims.sub = contact;
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: vapidSigningKey(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------- aes128gcm (RFC 8291 / RFC 8188)

// Core encryption for one record. padTo is the padded plaintext length including
// the 0x02 delimiter (0 means no padding). Used by the production path with a
// fixed bucket and by the RFC 8291 appendix A test with no padding.
export function aes128gcmEncrypt({ plaintext, uaPublic, authSecret, salt, asEcdh, padTo = 0, recordSize = RECORD_SIZE }) {
  const asPublic = asEcdh.getPublicKey(null, 'uncompressed');
  const shared = asEcdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const padLength = padTo > 0 ? padTo - plaintext.length - 1 : 0;
  if (padLength < 0) {
    throw new Error('Push payload does not fit its padding bucket.');
  }
  const padded = Buffer.concat([plaintext, Buffer.from([0x02]), Buffer.alloc(padLength)]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  if (sealed.length > recordSize) {
    throw new Error('Push payload does not fit one push record.');
  }
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, sealed]);
}

// Production path: pads to PAD_SHORT (2 KB) for ordinary payloads and to PAD_LONG
// for the larger bucket, so the ciphertext length does not reveal the text length
// within a bucket. The ephemeral key and salt are random unless injected for tests.
export function encryptPushPayload(plaintext, subscription, { salt, asEcdh } = {}) {
  if (plaintext.length + 1 > PAD_LONG) {
    throw new Error('Push payload is larger than one record.');
  }
  const padTo = plaintext.length + 1 <= PAD_SHORT ? PAD_SHORT : PAD_LONG;
  return aes128gcmEncrypt({
    plaintext,
    uaPublic: b64uDecode(subscription.keys.p256dh, 'Push key'),
    authSecret: b64uDecode(subscription.keys.auth, 'Push auth secret'),
    salt: salt ?? crypto.randomBytes(16),
    asEcdh: asEcdh ?? ephemeralEcdh(),
    padTo,
    recordSize: RECORD_SIZE,
  });
}

// ---------------------------------------------------------------- subscriptions

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const family = net.isIP(host);
  if (family === 6) return true;
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

// A 65-byte uncompressed point is a P-256 key only when it lies on the curve. Node refuses an off-curve point when the JWK is
// imported, so the import is the check.
function onP256Curve(point) {
  try {
    crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

// Validates a PushSubscription-shaped object: { kind?, endpoint, keys: { p256dh, auth } }.
// allowLocalEndpoints is for the sealed tests only; the desktop never sets it.
export function normalizeSubscription(raw, { allowLocalEndpoints = false } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Push subscription is missing.');
  const kind = raw.kind ?? 'webpush';
  if (!PUSH_KINDS.includes(kind)) throw new Error('Push kind is not known.');
  if (kind === 'apns-forwarder') throw refusal(APNS_REFUSAL, 'kind-unavailable');
  if (typeof raw.endpoint !== 'string' || raw.endpoint.length > 2048) {
    throw new Error('Push endpoint is missing or too long.');
  }
  let url;
  try {
    url = new URL(raw.endpoint);
  } catch {
    throw new Error('Push endpoint is not a URL.');
  }
  const localHttp = allowLocalEndpoints && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !localHttp) throw new Error('Push endpoint must use https.');
  if (url.username || url.password) throw new Error('Push endpoint must not carry credentials.');
  if (!allowLocalEndpoints && isPrivateHost(url.hostname)) throw new Error('Push endpoint must be a public address.');
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const p256dh = b64uDecode(keys.p256dh, 'Push key');
  if (p256dh.length !== 65 || p256dh[0] !== 4 || !onP256Curve(p256dh)) throw new Error('Push key is not a P-256 public key.');
  const auth = b64uDecode(keys.auth, 'Push auth secret');
  if (auth.length !== 16) throw new Error('Push auth secret has the wrong size.');
  return {
    kind,
    endpoint: url.href,
    keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') },
  };
}

// ---------------------------------------------------------------- text and payload (MOBILE-UI section 10)

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

function cleanText(text) {
  return String(text ?? '').replace(CONTROL_CHARS, ' ').trim();
}

function truncate(text, max) {
  const chars = Array.from(cleanText(text));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

// The first non-empty line of a card or run text, cleaned and capped at 120 characters.
export function firstLineOf(text) {
  if (typeof text !== 'string') return '';
  const line = text.split(/\r\n|\r|\n/).map(cleanText).find((s) => s.length > 0) ?? '';
  return truncate(line, FIRST_LINE_MAX);
}

// Builds the generic text, actions and the encrypted payload for one device.
// event: { kind, computerName?, projectName?, projectId?, approvalId?, count?, firstLine?, limitKind?, defaultDeny? }
// prefs: state.phones.push (switches); device: { tier, approveFromNotifications }; computer: { id, name }.
export function buildPushText(event, { prefs, device, computer }) {
  const kind = event?.kind;
  if (!EVENT_KINDS.includes(kind)) throw new Error('Push event kind is not known.');
  const sw = { ...SWITCH_DEFAULTS, ...(prefs ?? {}) };
  const computerName = truncate(computer?.name || 'Plenum', PART_MAX);
  const projectName = truncate(event.projectName ?? '', PART_MAX);
  const title = projectName ? `${computerName} · ${projectName}` : computerName;
  const count = kind === 'approval' ? Math.max(1, Math.floor(Number(event.count) || 1)) : 1;
  const single = kind === 'approval' && count === 1;
  const approvalId = String(event.approvalId ?? '');
  const projectId = String(event.projectId ?? '');
  const line = sw.firstLine ? firstLineOf(event.firstLine) : '';

  let body;
  switch (kind) {
    case 'approval':
      if (count > 1) body = line || `${count} approvals are waiting.`;
      else body = line ? `Waiting: ${line}` : 'An approval is waiting.';
      break;
    case 'handover':
      body = line ? `The model asks: "${line}"` : 'The model needs you to do a step.';
      break;
    case 'finished':
      body = line ? `Finished: ${line}` : 'The run finished.';
      break;
    case 'failed':
      body = line ? `Failed: ${line}` : 'The run failed.';
      break;
    case 'limit':
      body = event.limitKind === 'plan' ? 'A plan limit was reached.' : 'A spend limit was reached.';
      break;
    default:
      body = 'Test notification: Plenum can reach this phone.';
  }

  const approveAllowed = single
    && device?.approveFromNotifications === true
    && sw.firstLine === true
    && line !== ''
    && event.defaultDeny !== true
    && device?.tier !== 'read';
  const actions = [];
  if (single) actions.push({ action: 'deny', title: 'Deny', route: `/#deny=${approvalId}` });
  if (kind === 'approval' || kind === 'handover') actions.push({ action: 'stop', title: 'Stop all', route: '/#stop' });
  if (approveAllowed) actions.push({ action: 'approve', title: 'Approve', route: `/#approve=${approvalId}` });

  let tap;
  if (kind === 'approval') tap = single ? `/#waiting=${approvalId}` : '/#waiting';
  else if (kind === 'handover') tap = `/#handover=${approvalId}`;
  else if (kind === 'finished' || kind === 'failed') tap = projectId ? `/#chat=${projectId}` : '/#chat';
  else if (kind === 'limit') tap = '/#settings=limit';
  else tap = '/#home';

  const tag = `plenum-${crypto.createHash('sha256')
    .update(`${computer?.id ?? ''}|${projectId}|${kind}`)
    .digest('hex')
    .slice(0, 32)}`;
  const urgency = kind === 'approval' || kind === 'handover' ? 'high' : 'normal';

  const payload = {
    v: 1,
    kind,
    title,
    body,
    tag,
    tap,
    actions,
    ids: { computer: String(computer?.id ?? ''), project: projectId, approval: approvalId },
  };
  if (line && (kind === 'approval' || kind === 'handover')) payload.firstLine = line;
  return { payload, urgency, tag, title, body };
}

// ---------------------------------------------------------------- the pusher

export function createPusher(options = {}) {
  const {
    devices,
    removeSubscription,
    presence,
    foreground,
    settings,
    log = () => {},
    vapid: vapidInput = null,
    vapidStore = null,
    now = () => Date.now(),
    fetch: fetchImpl = globalThis.fetch,
    allowLocalEndpoints = false,
  } = options;
  if (!devices || typeof devices.list !== 'function') throw new Error('Push needs a device list.');
  if (typeof fetchImpl !== 'function') throw new Error('Push needs a fetch function.');

  let keys = vapidInput;
  if (!keys && vapidStore) {
    const stored = vapidStore.load();
    if (stored) {
      if (!validVapidKeys(stored)) throw new Error('Stored VAPID keys are damaged.');
      keys = stored;
    }
  }
  if (!keys) {
    keys = generateVapidKeys();
    if (vapidStore) vapidStore.save(keys);
  }
  if (!validVapidKeys(keys)) throw new Error('VAPID keys are not valid.');

  const authCache = new Map(); // origin -> { value, madeMs }

  function authFor(endpoint, nowMs) {
    const origin = new URL(endpoint).origin;
    const hit = authCache.get(origin);
    if (hit && nowMs - hit.madeMs < VAPID_REFRESH_MS) return hit.value;
    const contact = readSettings().contact;
    const safeContact = typeof contact === 'string' && /^(mailto:|https:\/\/)\S+$/.test(contact) ? contact : undefined;
    const value = vapidAuthorization({ endpoint, keys, nowMs, contact: safeContact });
    authCache.set(origin, { value, madeMs: nowMs });
    return value;
  }

  function readSettings() {
    try {
      return settings?.() ?? {};
    } catch {
      return {};
    }
  }

  function readPrefs() {
    const s = readSettings();
    return { ...SWITCH_DEFAULTS, ...(s.push ?? {}) };
  }

  function readComputer() {
    const c = readSettings().computer ?? {};
    return { id: String(c.id ?? ''), name: String(c.name ?? '') };
  }

  async function atComputer() {
    if (typeof presence !== 'function') return false;
    try {
      const answer = await presence();
      return Boolean(answer && answer.focused === true && Number(answer.idleS) < PRESENCE_IDLE_S);
    } catch {
      return false;
    }
  }

  function phoneInForeground(deviceId, nowMs) {
    if (typeof foreground !== 'function') return false;
    try {
      const at = Number(foreground(deviceId)) || 0;
      const age = nowMs - at;
      return at > 0 && age >= 0 && age < FOREGROUND_WINDOW_MS;
    } catch {
      return false;
    }
  }

  function switchOn(kind, prefs) {
    if (kind === 'approval' || kind === 'handover') return prefs.approvals !== false;
    if (kind === 'finished' || kind === 'failed') return prefs.finished !== false;
    if (kind === 'limit') return prefs.limits !== false;
    return true;
  }

  function outcome(deviceId, result, extra = {}) {
    return { deviceId, outcome: result, ...extra };
  }

  async function deliver(device, event, ctx) {
    const deviceId = String(device?.id ?? '');
    const short = deviceId.slice(0, 8);
    if (!deviceId) return outcome('', 'skipped', { reason: 'no-device-id' });
    if (!device.pushSubscription) return outcome(deviceId, 'skipped', { reason: 'no-subscription' });

    let sub;
    try {
      sub = normalizeSubscription(device.pushSubscription, { allowLocalEndpoints });
    } catch (error) {
      const reason = error.code === 'kind-unavailable' ? 'refused' : 'invalid-subscription';
      log(`push: ${reason} for device ${short}`);
      return outcome(deviceId, reason === 'refused' ? 'refused' : 'skipped', { reason });
    }

    if (!ctx.switchOn) return outcome(deviceId, 'skipped', { reason: 'switch-off' });
    if (ctx.presenceRules) {
      if (ctx.atComputer) return outcome(deviceId, 'skipped', { reason: 'at-computer' });
      if (phoneInForeground(deviceId, ctx.nowMs)) return outcome(deviceId, 'skipped', { reason: 'phone-foreground' });
    }

    let plaintext;
    let urgency;
    try {
      const built = buildPushText(event, { prefs: ctx.prefs, device, computer: ctx.computer });
      plaintext = Buffer.from(JSON.stringify(built.payload), 'utf8');
      urgency = built.urgency;
      if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error('Push payload is too large.');
    } catch (error) {
      log(`push: text not built for device ${short}`);
      return outcome(deviceId, 'failed', { reason: 'bad-event' });
    }

    // A device whose key cannot be used fails alone: the loop in sendEvent goes on to the devices after it.
    let body;
    try {
      body = encryptPushPayload(plaintext, sub);
    } catch {
      log(`push: could not encrypt for device ${short}`);
      return outcome(deviceId, 'failed', { reason: 'bad-subscription' });
    }
    const headers = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(PUSH_TTL_S),
      Urgency: urgency,
    };
    if (sub.kind === 'webpush') headers.Authorization = authFor(sub.endpoint, ctx.nowMs);

    let response;
    try {
      response = await fetchImpl(sub.endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      log(`push: network error for device ${short}`);
      return outcome(deviceId, 'failed', { reason: 'network' });
    }
    const status = response.status;
    try {
      await response.arrayBuffer();
    } catch {
      // The status is what matters; the body is discarded.
    }
    if (status === 404 || status === 410) {
      if (typeof removeSubscription === 'function') removeSubscription(deviceId, sub.endpoint);
      log(`push: subscription removed for device ${short} (HTTP ${status})`);
      return outcome(deviceId, 'removed', { status });
    }
    if (status >= 200 && status < 300) {
      log(`push: sent ${event.kind} to device ${short} (HTTP ${status})`);
      return outcome(deviceId, 'sent', { status });
    }
    log(`push: failed for device ${short} (HTTP ${status})`);
    return outcome(deviceId, 'failed', { status });
  }

  async function sendEvent(event) {
    if (!event || !EVENT_KINDS.includes(event.kind)) throw new Error('Push event kind is not known.');
    const prefs = readPrefs();
    const computer = readComputer();
    const nowMs = now();
    // A test notification is sent on request at the computer, so presence does not hold it.
    const presenceRules = prefs.onlyWhenAway === true && event.kind !== 'test';
    const ctx = {
      prefs,
      computer,
      nowMs,
      presenceRules,
      atComputer: presenceRules ? await atComputer() : false,
      switchOn: switchOn(event.kind, prefs),
    };
    const results = [];
    for (const device of devices.list()) {
      results.push(await deliver(device, event, ctx));
    }
    return results;
  }

  return {
    sendEvent,
    vapidPublicKey: () => keys.publicKey,
  };
}
