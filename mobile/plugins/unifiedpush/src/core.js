// Pure logic for the UnifiedPush plugin's JavaScript side (mob-13, wave 105). No imports, so the same file runs in the
// Node tests, in the shell and in the browser. The Kotlin side under android/ mirrors the payload rules; the sealed suite
// mobile/test/plugins.test.mjs checks both against the desktop's own payload builder (lib/remote/push.mjs).
//
// Payloads: the desktop sends the event as an encrypted Web Push message (RFC 8291) through the distributor. The
// distributor delivers the decrypted bytes to the app; the plugin passes them to JavaScript as base64.

export const UNIFIEDPUSH_EVENTS = Object.freeze(['endpoint', 'registrationFailed', 'unregistered', 'tempUnavailable', 'message']);
export const FAILED_REASONS = Object.freeze(['INTERNAL_ERROR', 'NETWORK', 'ACTION_REQUIRED', 'VAPID_REQUIRED']);
export const DEFAULT_INSTANCE = 'default';
export const DEFAULT_MESSAGE_FOR_DISTRIBUTOR = 'Plenum';
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const PUSH_KINDS = Object.freeze(['approval', 'handover', 'finished', 'failed', 'limit', 'test']);
export const PUSH_ACTIONS = Object.freeze(['deny', 'stop', 'approve']);
export const NOTIFICATION_CHANNELS = Object.freeze({
  approvals: 'plenum-approvals',
  finished: 'plenum-finished',
  limits: 'plenum-limits',
});
// Taps and notification actions open the app at this prefix plus the desktop's route, for example plenum://app/#deny=<id>.
export const INTENT_PREFIX = 'plenum://app';

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const VAPID_RE = /^[A-Za-z0-9_-]{87}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const HTTPS_URL_RE = /^https:\/\/\S{1,2000}$/;
const TAG_RE = /^plenum-[0-9a-f]{32}$/;
const ROUTE_RE = /^\/#[\x21-\x7e]{1,200}$/;

export class UnifiedPushError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UnifiedPushError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Removes control characters and trims. Text from the desktop is data: it is only ever shown as text.
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function isRoute(value) {
  return typeof value === 'string' && ROUTE_RE.test(value);
}

export function normaliseInstance(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_INSTANCE;
  if (typeof value !== 'string' || !INSTANCE_RE.test(value)) {
    throw new UnifiedPushError('bad-instance', 'A registration name is 1 to 64 letters, digits, dots, dashes or underscores.');
  }
  return value;
}

export function normaliseMessageForDistributor(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MESSAGE_FOR_DISTRIBUTOR;
  if (typeof value !== 'string') {
    throw new UnifiedPushError('bad-message-for-distributor', 'The label for the push app must be text.');
  }
  return cleanText(value, 120) || DEFAULT_MESSAGE_FOR_DISTRIBUTOR;
}

// The VAPID public key is the 87-character base64url form of the uncompressed P-256 point (RFC 8292).
export function normaliseVapid(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !VAPID_RE.test(value)) {
    throw new UnifiedPushError('bad-vapid', 'The VAPID key is the 87-character base64url public key.');
  }
  return value;
}

export function normalisePackageName(value) {
  if (typeof value !== 'string' || value.length > 200 || !PACKAGE_RE.test(value)) {
    throw new UnifiedPushError('bad-package', 'Name the push app by its package name, for example io.heckel.ntfy.');
  }
  return value;
}

export function normaliseRegisterOptions(options = {}) {
  if (!isPlainObject(options)) options = {};
  return {
    instance: normaliseInstance(options.instance),
    messageForDistributor: normaliseMessageForDistributor(options.messageForDistributor),
    vapid: normaliseVapid(options.vapid),
  };
}

// Standard or URL-safe base64, with or without padding. Returns the decoded bytes.
export function decodeBase64(text) {
  if (typeof text !== 'string' || text.length > Math.ceil((MAX_MESSAGE_BYTES * 4) / 3) + 8) {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  if (!BASE64_RE.test(standard)) {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  const unpadded = standard.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new UnifiedPushError('bad-message', 'The push message is not base64 text.');
  }
  if (binary.length > MAX_MESSAGE_BYTES) {
    throw new UnifiedPushError('message-too-large', 'The push message is larger than the 256 KB limit.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || text.trimStart()[0] !== '{') return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

// Validates one desktop payload (version 1 of lib/remote/push.mjs). Unknown fields are ignored; an unknown kind or
// version returns null, so the shell shows the generic "Plenum has an update" path instead of acting on it.
export function parsePushPayload(value) {
  if (!isPlainObject(value) || value.v !== 1 || !PUSH_KINDS.includes(value.kind)) return null;
  const title = cleanText(value.title, 120) || 'Plenum';
  const body = cleanText(value.body, 240) || 'Plenum has an update.';
  const tag = typeof value.tag === 'string' && TAG_RE.test(value.tag) ? value.tag : 'plenum';
  const tap = isRoute(value.tap) ? value.tap : '/#home';
  const firstLine = cleanText(value.firstLine, 200);
  const actions = [];
  if (Array.isArray(value.actions)) {
    // The first three valid actions count; invalid entries are skipped rather than hiding the valid ones after them.
    for (const entry of value.actions) {
      if (actions.length >= 3) break;
      if (isPlainObject(entry) && PUSH_ACTIONS.includes(entry.action) && isRoute(entry.route)) {
        actions.push({ action: entry.action, title: cleanText(entry.title, 40) || entry.action, route: entry.route });
      }
    }
  }
  const ids = isPlainObject(value.ids) ? value.ids : {};
  return {
    v: 1,
    kind: value.kind,
    title,
    body,
    tag,
    tap,
    actions,
    firstLine: firstLine || undefined,
    ids: {
      computer: cleanText(ids.computer, 80),
      project: cleanText(ids.project, 80),
      approval: cleanText(ids.approval, 80),
    },
  };
}

// An approve route carries the first line the notification showed, so the server can match the card (MOBILE-UI 10).
export function routeForAction(action, firstLine) {
  if (action.action !== 'approve' || !firstLine) return action.route;
  return `${action.route}&line=${encodeURIComponent(firstLine)}`;
}

export function intentUrlForRoute(route) {
  if (!isRoute(route)) throw new UnifiedPushError('bad-route', 'The route is not a Plenum route.');
  return `${INTENT_PREFIX}${route}`;
}

export function channelForKind(kind) {
  if (kind === 'approval' || kind === 'handover') return NOTIFICATION_CHANNELS.approvals;
  if (kind === 'limit') return NOTIFICATION_CHANNELS.limits;
  return NOTIFICATION_CHANNELS.finished;
}

export function parseMessageEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError('bad-event', 'The push event is not an object.');
  const instance = normaliseInstance(event.instance);
  const decrypted = event.decrypted === true;
  const bytes = decodeBase64(event.content);
  const text = decrypted ? decodeUtf8(bytes) : null;
  const payload = text === null ? null : parsePushPayload(parseJsonObject(text));
  return { instance, decrypted, bytes, text, payload };
}

// The endpoint is the distributor's https push address. The key set (P-256 public key and auth secret) is passed on
// once so the shell can send it to the computer over its channel; it is never logged or written anywhere by this plugin.
export function parseEndpointEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError('bad-event', 'The endpoint event is not an object.');
  const instance = normaliseInstance(event.instance);
  if (typeof event.url !== 'string' || !HTTPS_URL_RE.test(event.url)) {
    throw new UnifiedPushError('endpoint-not-https', 'The push app gave an address that is not https.');
  }
  const keys = isPlainObject(event.pubKeySet)
    && typeof event.pubKeySet.pubKey === 'string' && BASE64URL_RE.test(event.pubKeySet.pubKey)
    && typeof event.pubKeySet.auth === 'string' && BASE64URL_RE.test(event.pubKeySet.auth)
    ? { pubKey: event.pubKeySet.pubKey, auth: event.pubKeySet.auth }
    : null;
  return { instance, url: event.url, temporary: event.temporary === true, keys };
}

// What the person sees and what the shell does next, for each registration failure.
export function describeRegistrationFailure(reason) {
  const known = FAILED_REASONS.includes(reason) ? reason : 'INTERNAL_ERROR';
  switch (known) {
    case 'NETWORK':
      return { reason: known, retry: 'when-online', message: 'The push app could not be reached. Plenum tries again when the network is back.' };
    case 'ACTION_REQUIRED':
      return { reason: known, retry: 'after-person', message: 'Open your push app, such as ntfy, sign in or allow Plenum, then try again.' };
    case 'VAPID_REQUIRED':
      return { reason: known, retry: 'with-vapid', message: 'This push app asks for a VAPID key. Plenum registers again with its key.' };
    default:
      return { reason: 'INTERNAL_ERROR', retry: 'now', message: 'The push app failed. Try again.' };
  }
}
