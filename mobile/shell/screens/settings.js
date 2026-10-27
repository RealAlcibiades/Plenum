// The phone settings rules (mob-10, wave 107; MOBILE-UI 6.17, 8.12, 10 and 14.1). Pure functions: no DOM, no store, no channel. The
// screens call these to decide what a control shows, and the shell core stores the answer. Nothing here holds a key or a token.

// Lock after (6.17): the background time before the app locks again. "Immediately" locks on the first return.
export const LOCK_AFTER = Object.freeze([
  Object.freeze({ id: 'immediately', ms: 0, label: 'Immediately' }),
  Object.freeze({ id: 'm1', ms: 60 * 1000, label: '1 minute' }),
  Object.freeze({ id: 'm5', ms: 5 * 60 * 1000, label: '5 minutes' }),
  Object.freeze({ id: 'm15', ms: 15 * 60 * 1000, label: '15 minutes' }),
  Object.freeze({ id: 'h1', ms: 60 * 60 * 1000, label: '1 hour' }),
]);
export const DEFAULT_LOCK_AFTER = 'm5';

export function lockAfter(id) {
  return LOCK_AFTER.find(o => o.id === id) ?? LOCK_AFTER.find(o => o.id === DEFAULT_LOCK_AFTER);
}

// Ways to reach (6.17): the order this phone tries the carriers in. Move up and Move down swap a way with its neighbour; the ends
// do not move. The order is stored on the computer's record and used at the next connection.
export const WAY_KINDS = Object.freeze(['lan', 'tailscale', 'relay']);

export function moveWay(order, kind, dir) {
  const list = Array.isArray(order) ? [...order] : [];
  const i = list.indexOf(kind);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

// The carriers in the order the record holds, with the ones this record lacks added at the end in the default order.
export function orderedWays(stored) {
  const seen = [];
  for (const kind of Array.isArray(stored) ? stored : []) {
    if (WAY_KINDS.includes(kind) && !seen.includes(kind)) seen.push(kind);
  }
  for (const kind of WAY_KINDS) if (!seen.includes(kind)) seen.push(kind);
  return seen;
}

// Approve from notifications (10, 14.1). The switch can be turned on only while "Include the first line" is on and the app lock is
// on (on the web app, a PIN or a passkey). A read-only phone never sees the row. The result says which condition is missing.
export function approveSwitch({ tier = 'full', firstLine = false, lockMode = 'off', native = false } = {}) {
  if (tier === 'read') return { visible: false, enabled: false, missing: null };
  const lockOn = native
    ? lockMode === 'biometric' || lockMode === 'pin' || lockMode === 'passkey'
    : lockMode === 'pin' || lockMode === 'passkey';
  if (!firstLine) return { visible: true, enabled: false, missing: 'first-line' };
  if (!lockOn) return { visible: true, enabled: false, missing: 'app-lock' };
  return { visible: true, enabled: true, missing: null };
}

export const APPROVE_MISSING_TEXT = Object.freeze({
  'first-line': 'Turn on "Include the first line" first.',
  'app-lock': 'Turn on the app lock first. On the web app that means a PIN or a passkey.',
});

// The approve switch shows checked only when it is allowed now. A stored "on" that no longer meets the conditions shows off.
export function approveChecked(stored, rule) {
  return Boolean(stored) && Boolean(rule?.enabled);
}

// Text size (8.12, 6.17): Follow phone, or a fixed percentage from 85 to 200 in steps of 5.
export const TEXT_MIN = 85;
export const TEXT_MAX = 200;
export const TEXT_STEP = 5;
export const TEXT_DEFAULT = 100;

export function clampText(value) {
  const n = Math.round((Number(value) || TEXT_DEFAULT) / TEXT_STEP) * TEXT_STEP;
  return Math.min(TEXT_MAX, Math.max(TEXT_MIN, n));
}

// Appearance (6.17): the theme for this phone only. "follow" leaves the page to the phone's own setting.
export const THEMES = Object.freeze(['follow', 'dark', 'light']);
export const THEME_LABEL = Object.freeze({ follow: 'Follow phone', dark: 'Dark', light: 'Light' });

export function normaliseTheme(value) {
  return THEMES.includes(value) ? value : 'follow';
}

export function normaliseStopSide(value) {
  return value === 'left' ? 'left' : 'right';
}

// Notifications kept on the computer (6.17, 10). The keys are the POST /api/phones/push fields.
export const PUSH_SWITCHES = Object.freeze([
  Object.freeze({ key: 'approvals', label: 'Approvals and your turn' }),
  Object.freeze({ key: 'finished', label: 'Finished and failed runs' }),
  Object.freeze({ key: 'limits', label: 'Spend and plan limits' }),
  Object.freeze({ key: 'onlyWhenAway', label: 'Only when I am away from {computer}' }),
  Object.freeze({ key: 'firstLine', label: 'Include the first line' }),
]);

// A push switch's value from the last answer the shell has, with the defaults of the design when nothing is known yet.
export const PUSH_DEFAULTS = Object.freeze({ approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false });

export function pushValues(known) {
  const out = { ...PUSH_DEFAULTS };
  for (const { key } of PUSH_SWITCHES) {
    if (typeof known?.[key] === 'boolean') out[key] = known[key];
  }
  return out;
}

// Keeps one push key and says what the switch means for the approve rule: turning first line off also turns off the approve switch,
// so a notification never approves a card whose first line it no longer shows.
export function pushPatch(key, value, approveStored) {
  const patch = { [key]: value === true };
  if (key === 'firstLine' && value !== true && approveStored) patch.approveFromNotifications = false;
  return patch;
}

// The Android UnifiedPush line (6.17) is shown on Android only. It names the push app the phone has chosen (its Android package name),
// and gives the install hint when none is chosen.
export function unifiedPushLine(distributor) {
  if (!distributor) return 'Install a UnifiedPush app such as ntfy to get notifications while Plenum is closed.';
  if (distributor === 'io.heckel.ntfy') return 'Notifications from closed app: through ntfy (UnifiedPush).';
  return 'Notifications from closed app: through your UnifiedPush app.';
}

// The stored preferences the phone keeps itself (store meta "prefs"), with safe defaults for a missing or damaged record.
export function normalisePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: normaliseTheme(p.theme),
    textSize: p.textSize == null ? null : clampText(p.textSize),
    stopSide: normaliseStopSide(p.stopSide),
    haptics: p.haptics !== false,
    hideSwitcher: p.hideSwitcher !== false,
    lockAfter: lockAfter(p.lockAfter).id,
    dictationOnDevice: p.dictationOnDevice !== false,
    dictationAllowService: p.dictationAllowService !== false,
    lanDismissed: p.lanDismissed === true,
  };
}
