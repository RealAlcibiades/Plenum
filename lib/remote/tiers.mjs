// What a paired phone may do: the three tiers and the rule-based policy the Bridge applies to every request a phone makes
// (MOBILE.json decision.powers.tiers). Owned by mob-03.
//
//   full     everything the desktop window can do. The default for a new phone.
//   approve  Approve and watch: every GET that is not gated, plus the answers and the stops listed in WATCH_POSTS and the
//            /api/notices/ routes.
//   read     Read only: every GET that is not gated, plus POST /api/stop-all, the STOP frame and a phone's own push settings (SELF_POSTS).
//
// The policy is a rule, not a table of routes, so a route that does not exist yet lands in a tier by default: any POST that no
// rule names needs 'full', any GET that reaches a provider (GATED_GETS in lib/legal.mjs, or a route entry with gated: true) needs
// 'full', and every other GET needs 'read'. classify() answers the tier a request needs; allows() compares it with a phone's tier.
// classifyDetailed() also says which rule decided, so a test can walk every route and check none escapes the rules.
//
// The path is always judged the way the server will read it: pathnameOf() normalises dot segments and percent-encoded dots with the
// same URL parser the server uses, and the Bridge forwards that normalised path, never the raw one, so a request cannot be
// classified as one route and handled as another.
//
// This file imports nothing from the app except the list of gated reads, and it logs nothing.
import { GATED_GETS } from '../legal.mjs';

export const TIERS = Object.freeze(['full', 'approve', 'read']);
const RANK = Object.freeze({ read: 0, approve: 1, full: 2 });

// The POSTs an Approve-and-watch phone may make (everything else that is a POST needs full). /api/phones/remove is for the phone's
// own entry only; lib/routes/remote.mjs checks that, because only the route can see the body and the device header together.
export const WATCH_POSTS = Object.freeze([
  '/api/approve',
  '/api/cancel',
  '/api/drive/pause',
  '/api/drive/resume',
  '/api/drive/stop',
  '/api/agents/stop',
  '/api/stop-all',
  '/api/phones/remove',
]);
// A Read-only phone may stop everything, and nothing else that writes.
export const READ_POSTS = Object.freeze(['/api/stop-all']);
// A phone's own push settings (Approve from a notification and its push subscription): every tier, because a Read-only phone is the one
// that most needs to be told when to look. lib/routes/remote.mjs lets a phone below Full change only its own entry: the five desktop-wide
// switches are refused to it (403), and Approve-from-notification is refused to a Read-only phone.
export const SELF_POSTS = Object.freeze(['/api/phones/push']);
export const WATCH_PREFIXES = Object.freeze(['/api/notices/']);

export const isTier = value => typeof value === 'string' && Object.hasOwn(RANK, value);
export const tierRank = tier => (isTier(tier) ? RANK[tier] : -1);

// The sentence a refused request gets, in the server's own { error } shape (MOBILE-UI 14.3).
export const REFUSAL_TEXT = 'This phone can’t do that. Change what it can do at the computer under Settings › Phones.';
export const NO_METHOD_TEXT = 'Method not allowed.';

// The path part of a request target as the server will read it, or null when the target is not an absolute path of this server
// (a scheme, a host, a backslash, control characters or a second leading slash all make it null). Dot segments are resolved.
export function pathnameOf(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 8192) return null;
  if (target[0] !== '/' || target[1] === '/') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(target)) return null;
  let url;
  try {
    url = new URL(target, 'http://plenum.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://plenum.invalid') return null;
  return { pathname: url.pathname, search: url.search };
}

const isRead = method => method === 'GET' || method === 'HEAD';

// { tier, rule }. `gated` is true for a GET whose route entry sets gated: true (lib/routes/index.mjs allRoutes), and the static
// GATED_GETS list counts too, so a caller that only knows the path is still safe.
export function classifyDetailed(method, path, gated = false) {
  const m = String(method ?? '').toUpperCase();
  const parsed = pathnameOf(path);
  // A target that is not an absolute path of this server is not guessed at: it needs full (the Bridge refuses it with 400 before this).
  if (!parsed) return { tier: 'full', rule: 'bad-path' };
  const p = parsed.pathname;
  if (!isRead(m) && m !== 'POST') return { tier: 'full', rule: 'method' };
  if (isRead(m)) {
    if (p.startsWith('/api/') && (gated === true || GATED_GETS.includes(p))) return { tier: 'full', rule: 'gated-get' };
    return { tier: 'read', rule: p.startsWith('/api/') ? 'get' : 'static' };
  }
  if (READ_POSTS.includes(p)) return { tier: 'read', rule: 'stop' };
  if (SELF_POSTS.includes(p)) return { tier: 'read', rule: 'self' };
  if (p === '/_bridge/log') return { tier: 'read', rule: 'bridge' };
  if (WATCH_POSTS.includes(p)) return { tier: 'approve', rule: 'watch' };
  if (WATCH_PREFIXES.some(prefix => p.startsWith(prefix) && p.length > prefix.length)) return { tier: 'approve', rule: 'watch' };
  return { tier: 'full', rule: 'default' };
}

// The tier a request needs: 'read', 'approve' or 'full'.
export function classify(method, path, gated = false) {
  return classifyDetailed(method, path, gated).tier;
}

// Whether a phone of tier `have` may make a request that needs `need`. An unknown tier on either side allows nothing.
export function allows(have, need) {
  const a = tierRank(have);
  const b = tierRank(need);
  return a >= 0 && b >= 0 && a >= b;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The shape of state.json's `phones` record. It lives in this file because this file loads on a build that has no phone support (it
// needs no packages), and lib/routes/remote.mjs and lib/remote/index.mjs must both read the record the same way.
//   { enabled, port, lan: { enabled, anyAddress }, tailscale: { enabled, name }, relay: { enabled, url },
//     push: { approvals, finished, limits, onlyWhenAway, firstLine }, autoExpireDays, activity: [last 50 { at, device, text }] }
// Secrets are never in it (they are in phones.json).
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const ACTIVITY_MAX = 50;
export function phonesShape(raw) {
  const shape = plainObject(raw) ? raw : {};
  shape.enabled = shape.enabled === true;
  shape.port = Number.isInteger(shape.port) && shape.port >= 1024 && shape.port <= 65535 ? shape.port : null;
  shape.lan = { enabled: shape.lan?.enabled === true, anyAddress: shape.lan?.anyAddress === true };
  shape.tailscale = { enabled: shape.tailscale?.enabled === true, name: typeof shape.tailscale?.name === 'string' ? shape.tailscale.name.slice(0, 253) : '' };
  shape.relay = { enabled: shape.relay?.enabled === true, url: typeof shape.relay?.url === 'string' ? shape.relay.url.slice(0, 300) : '' };
  const push = plainObject(shape.push) ? shape.push : {};
  shape.push = {
    approvals: push.approvals !== false,
    finished: push.finished !== false,
    limits: push.limits !== false,
    onlyWhenAway: push.onlyWhenAway !== false,
    firstLine: push.firstLine === true,
  };
  shape.autoExpireDays = Number.isInteger(shape.autoExpireDays) && shape.autoExpireDays >= 0 && shape.autoExpireDays <= 3650 ? shape.autoExpireDays : 0;
  shape.activity = Array.isArray(shape.activity) ? shape.activity.filter(plainObject).slice(0, ACTIVITY_MAX) : [];
  return shape;
}

// The capabilities HELLO.caps names for a tier. The phone gates features by these names, never by comparing versions.
export function capsForTier(tier) {
  const read = ['events', 'stop-all', 'browser-picture', 'ui-manifest'];
  const approve = [...read, 'approvals', 'drive', 'agents'];
  const full = [...approve, 'chat', 'computer', 'artifacts', 'type-secret', 'push-webpush'];
  if (tier === 'full') return full;
  if (tier === 'approve') return approve;
  if (tier === 'read') return read;
  return [];
}
