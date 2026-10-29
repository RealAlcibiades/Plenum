// Push on the phone (mob-10, wave 104; H7, M10, M15; MOBILE.json push; MOBILE-UI 6.9 and 10).
//
//   web (PWA)    subscribeWebPush: after a tap the page asks for the permission, subscribes with the computer's VAPID public key (HELLO) and sends
//                the subscription over the channel to POST /api/phones/push. sw.js shows the notification.
//   Android      createAndroidPush: UnifiedPush through the person's push app (ntfy and others). The endpoint the push app gives, with its key set,
//                goes to POST /api/phones/push as { subscription: { kind: 'unifiedpush', endpoint, keys } } (lib/remote/push.mjs
//                normalizeSubscription). While Plenum is in front, a message becomes a local notification here (channels plenum-approvals,
//                plenum-finished, plenum-limits; Deny, Stop all and an opt-in Approve); while it is behind, the plugin's own service already
//                showed the notification, so none is shown a second time.
//
// A notification opens the app at a fragment (parseNotificationHash): #stop, #deny=<id>, #approve=<id>&line=<first line>, #waiting[=<id>],
// #handover=<id>, #chat[=<project>], #settings=limit or #home. app.js runs them (handleHash); a Stop is sent at once, a Deny after the card is
// checked by the computer, and an Approve only with the first line the notification showed (the computer compares it with the waiting card).
// Not available on the plain LAN web page (no service worker, no push); the caller shows that copy instead.

import { channelForKind, parseEndpointEvent, parseMessageEvent, routeForAction } from '../plugins/unifiedpush/src/core.js';

// An id the computer made: letters, digits, dots, dashes and underscores (a UUID for an approval card, hex for a stop).
const ID = /^[A-Za-z0-9_.-]{1,80}$/;
const FIRST_LINE_MAX = 200;

export function pushAvailable(env = globalThis) {
  const nav = env.navigator;
  return Boolean(env.isSecureContext && nav && 'serviceWorker' in nav && env.PushManager && env.Notification);
}

function cleanLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, FIRST_LINE_MAX);
}

// What a notification link means. Anything else is null: the shell opens the app as it is.
//   #stop                       { kind: 'stop' }
//   #deny=<id>                  { kind: 'deny', id }
//   #approve=<id>[&line=<text>] { kind: 'approve', id, line }   (line: percent-encoded, '' when absent)
//   #waiting[=<id>]             { kind: 'waiting', id? }        the Waiting card in Agents
//   #handover=<id>              { kind: 'handover', id }        a model asking the person to do a step
//   #chat[=<project>]           { kind: 'chat', project? }      the project's chat
//   #settings=limit             { kind: 'settings', section: 'limit' }
//   #home                       { kind: 'home' }
// B-117: any of them may end in &computer=<id>, the computer that sent the notification (the service worker adds it to a cold start, and an
// Android route may carry it): the result then has computer: <id>. Without it there is no computer key, and the shell acts on the open one.
export function parseNotificationHash(hash) {
  let text = String(hash ?? '').replace(/^#/, '');
  const named = /&computer=([A-Za-z0-9_.-]{1,80})$/.exec(text);
  if (named) {
    const link = parseNotificationHash(text.slice(0, named.index));
    return link ? { ...link, computer: named[1] } : null;
  }
  if (text === 'stop') return { kind: 'stop' };
  if (text === 'home') return { kind: 'home' };
  if (text === 'waiting') return { kind: 'waiting' };
  if (text === 'chat') return { kind: 'chat' };
  if (text === 'settings=limit') return { kind: 'settings', section: 'limit' };
  let m = /^(deny|approve|waiting|handover)=([A-Za-z0-9_.-]{1,80})(?:&line=([^&]*))?$/.exec(text);
  if (m && ID.test(m[2])) {
    if (m[1] === 'approve') {
      let line = '';
      try {
        line = cleanLine(decodeURIComponent(m[3] ?? ''));
      } catch {
        line = '';
      }
      return { kind: 'approve', id: m[2], line };
    }
    if (m[3] !== undefined) return null;
    return { kind: m[1], id: m[2] };
  }
  m = /^chat=([A-Za-z0-9_.-]{1,80})$/.exec(text);
  if (m) return { kind: 'chat', project: m[1] };
  return null;
}

// True for the fragments that only name a place in the UI (the shell hands them to the UI page as a route).
export function isRouteLink(link) {
  return Boolean(link) && ['waiting', 'handover', 'chat', 'settings', 'home'].includes(link.kind);
}

// Asks for the permission (after a tap), subscribes and sends the subscription to the computer. `request` is channel.request.
// Returns { ok, state, status, endpoint? } where state is 'on' | 'denied' | 'unsupported' | 'failed' | 'other-computer'.
// B-128: a browser keeps one push subscription per address, made with one computer's key. When another computer already holds it (the PWA at a
// relay address serves every computer behind it), subscribing with this computer's key is refused by the browser; that is 'other-computer', and the
// other computer's subscription is left as it is (replacing it would silence that computer without a word).
export async function subscribeWebPush({ registration, applicationServerKey, request, deviceId, notification, env = globalThis } = {}) {
  if (!pushAvailable(env) || !registration?.pushManager) return { ok: false, state: 'unsupported', status: 0 };
  if (!applicationServerKey || typeof request !== 'function' || !deviceId) return { ok: false, state: 'failed', status: 0 };
  const permission = await (notification ?? env.Notification).requestPermission();
  if (permission !== 'granted') return { ok: false, state: 'denied', status: 0 };
  const key = bytesFromB64u(applicationServerKey);
  let held = null;
  try {
    held = (await registration.pushManager.getSubscription?.()) ?? null;
  } catch {
    held = null;
  }
  if (held && !sameKey(held.options?.applicationServerKey, key)) return { ok: false, state: 'other-computer', status: 0 };
  let subscription;
  try {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (err) {
    return { ok: false, state: err?.name === 'InvalidStateError' ? 'other-computer' : 'failed', status: 0 };
  }
  const json = subscription.toJSON ? subscription.toJSON() : subscription;
  const body = JSON.stringify({ id: deviceId, subscription: { endpoint: json.endpoint, keys: json.keys } });
  const res = await request({ method: 'POST', path: '/api/phones/push', headers: { 'content-type': 'application/json' } }, body);
  try { await res.body?.cancel(); } catch { /* nothing to drain */ }
  if (res.status !== 200) return { ok: false, state: 'failed', status: res.status };
  return { ok: true, state: 'on', status: res.status, endpoint: typeof json.endpoint === 'string' ? json.endpoint : '' };
}

// Whether the key a held subscription was made with (an ArrayBuffer or a view, or nothing when the browser does not say) is this computer's.
// A subscription that does not say is taken to be this computer's: subscribe() then settles it, and an InvalidStateError is 'other-computer'.
function sameKey(held, key) {
  if (!held) return true;
  const a = held instanceof Uint8Array ? held : ArrayBuffer.isView(held) ? new Uint8Array(held.buffer, held.byteOffset, held.byteLength) : new Uint8Array(held);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
  return true;
}

// B-128: turning web notifications off at a computer takes this computer's subscription out of the browser as well, so another computer behind the
// same address can turn them on. Only the subscription this phone recorded for the computer (its endpoint) is removed; one that belongs to
// another computer is never touched. Resolves true when the browser's subscription was removed.
// A phone that turned notifications on before the endpoint was recorded has none stored: the subscription is then taken out only when it was made
// with this computer's own key (applicationServerKey), which no other computer shares.
export async function dropWebPush({ registration, endpoint, applicationServerKey = null } = {}) {
  if ((!endpoint && !applicationServerKey) || !registration?.pushManager) return false;
  try {
    const held = await registration.pushManager.getSubscription?.();
    if (!held) return false;
    if (endpoint ? held.endpoint !== endpoint : !(held.options?.applicationServerKey && sameKey(held.options.applicationServerKey, bytesFromB64u(applicationServerKey)))) return false;
    return (await held.unsubscribe?.()) !== false;
  } catch {
    return false;
  }
}

function bytesFromB64u(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ----- Android: UnifiedPush -----

export const ANDROID_CHANNELS = Object.freeze([
  Object.freeze({ id: 'plenum-approvals', name: 'Approvals and your turn', importance: 4 }),
  Object.freeze({ id: 'plenum-finished', name: 'Finished and failed runs', importance: 3 }),
  Object.freeze({ id: 'plenum-limits', name: 'Spend and plan limits', importance: 3 }),
]);
const ENDPOINT_WAIT_MS = 15000;

// The body of POST /api/phones/push for a UnifiedPush endpoint event (the plugin's `endpoint` event): the push app's https address and the
// key set it was given once. Null when the event has no key set (the computer could not encrypt for it).
export function unifiedPushSubscription(event) {
  const endpoint = parseEndpointEvent(event);
  if (!endpoint.keys) return null;
  return { subscription: { kind: 'unifiedpush', endpoint: endpoint.url, keys: { p256dh: endpoint.keys.pubKey, auth: endpoint.keys.auth } } };
}

// The notification a message shows: channel by kind, the actions the desktop sent (Deny, Stop all, an opt-in Approve) and the routes they open.
// Every action (Deny and Stop all too) asks for the device's own authentication first, as PlenumNotifier.kt does for the system notification.
export function notificationFor(payload) {
  const names = payload.actions.map(a => a.action);
  const routes = {};
  for (const a of payload.actions) routes[a.action] = a.route;
  return {
    title: payload.title,
    body: payload.body,
    channelId: channelForKind(payload.kind),
    actionTypeId: names.length ? `plenum-${names.join('-')}` : undefined,
    actions: payload.actions.map(a => ({
      id: a.action,
      title: a.title,
      requiresAuthentication: true,
      destructive: a.action !== 'approve',
      foreground: false,
    })),
    extra: { tap: payload.tap, routes, line: payload.firstLine ?? '', computer: payload.ids?.computer ?? '' },
  };
}

function notificationId(tag) {
  let h = 0;
  for (const ch of String(tag ?? 'plenum')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 2147483000 + 1;
}

// native: the registry from native.js (UnifiedPush, LocalNotifications). request: channel.request (a getter, because the channel changes).
// isVisible(): true while Plenum is in front. onLink(hash, computer): runs a notification fragment (app.js handleHash). setTimer/clearTimer: for the wait.
// pendingStore (B-129, optional): { load(), save(body), clear() }, where an endpoint the computer has not accepted yet waits, so a restart of the app
// does not lose the key set the push app gave once. The body is never logged.
export function createAndroidPush({
  native,
  requestOf,
  vapidOf = () => null,
  isVisible = () => true,
  onLink = () => {},
  pendingStore = null,
  log = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  const up = native?.UnifiedPush ?? null;
  const local = native?.LocalNotifications ?? null;
  let started = false;
  let waiting = null;          // { resolve, timer } while enable() waits for the push app's endpoint
  let lastEndpoint = null;
  let failure = null;
  let posted = false;          // the computer has this phone's subscription
  let pending = null;          // B-129: the body of an endpoint the computer has not accepted yet; resend() sends it again
  const types = new Set();

  async function post(body) {
    const request = requestOf?.();
    if (typeof request !== 'function') return { ok: false, status: 0 };
    try {
      const res = await request({ method: 'POST', path: '/api/phones/push', headers: { 'content-type': 'application/json' } }, JSON.stringify(body));
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      return { ok: res.status === 200, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  async function onEndpoint(event) {
    let body = null;
    try {
      body = unifiedPushSubscription(event);
    } catch {
      body = null;
    }
    if (!body) {
      failure = 'endpoint';
      waiting?.resolve({ ok: false, reason: 'endpoint' });
      return;
    }
    lastEndpoint = body.subscription.endpoint;
    pending = body;
    try { await pendingStore?.save(body); } catch { /* the endpoint is still held in memory */ }
    const out = await post(body);
    posted = out.ok;
    if (out.ok) {
      failure = null;
      pending = null;
      try { await pendingStore?.clear(); } catch { /* a note that stays is sent once more and replaced */ }
    }
    waiting?.resolve(out.ok ? { ok: true, reason: null } : { ok: false, reason: 'failed' });
  }

  async function showLocal(payload) {
    if (!local?.schedule) return;
    const note = notificationFor(payload);
    if (note.actionTypeId && !types.has(note.actionTypeId)) {
      types.add(note.actionTypeId);
      await local.registerActionTypes?.({ types: [{ id: note.actionTypeId, actions: note.actions }] });
    }
    await local.schedule({
      notifications: [{
        id: notificationId(payload.tag),
        title: note.title,
        body: note.body,
        channelId: note.channelId,
        actionTypeId: note.actionTypeId,
        extra: note.extra,
      }],
    });
  }

  async function onMessage(event) {
    let parsed = null;
    try {
      parsed = parseMessageEvent(event);
    } catch {
      return;
    }
    if (!parsed.payload) return;
    // The plugin's own service shows the notification while Plenum is behind; showing it here too would make two.
    if (!isVisible()) return;
    try {
      await showLocal(parsed.payload);
    } catch (err) {
      log(`push: local notification ${err?.code ?? 'failed'}`);
    }
  }

  function onAction(event) {
    const extra = event?.notification?.extra ?? {};
    const id = String(event?.actionId ?? 'tap');
    const route = id === 'tap' ? extra.tap : extra.routes?.[id];
    if (typeof route !== 'string') return;
    const link = routeForAction({ action: id === 'tap' ? 'tap' : id, route }, extra.line ? String(extra.line) : '');
    // B-117: the computer that sent the notification goes with the link (only the three actions act on a computer; a tap is a place).
    const computer = id !== 'tap' && typeof extra.computer === 'string' ? extra.computer.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) : '';
    onLink(String(link).replace(/^\//, ''), computer);
  }

  return {
    // Channels, action types and listeners. Safe to call again; a plugin that is missing does nothing.
    async start() {
      if (started || !up) return false;
      started = true;
      try {
        for (const c of ANDROID_CHANNELS) await local?.createChannel?.({ id: c.id, name: c.name, importance: c.importance, visibility: 0 });
        await up.addListener('endpoint', onEndpoint);
        await up.addListener('message', onMessage);
        await up.addListener('registrationFailed', event => { failure = String(event?.reason ?? 'INTERNAL_ERROR'); waiting?.resolve({ ok: false, reason: 'registration' }); });
        await up.addListener('unregistered', () => {
          posted = false;
          lastEndpoint = null;
          pending = null;
          Promise.resolve(pendingStore?.clear?.()).catch(() => {});
        });
        await local?.addListener?.('localNotificationActionPerformed', onAction);
        // An endpoint the last run could not hand to the computer is still waiting (resend sends it at the next HELLO).
        if (!pending && pendingStore) {
          const kept = await pendingStore.load().catch(() => null);
          if (kept?.subscription?.kind === 'unifiedpush' && typeof kept.subscription.endpoint === 'string') pending = kept;
        }
      } catch (err) {
        log(`push: start ${err?.code ?? 'failed'}`);
        return false;
      }
      return true;
    },

    // What the settings line shows: whether UnifiedPush is on this phone, which push app, and whether the computer has the subscription.
    async state() {
      if (!up) return { supported: false, distributor: null, registered: false, failure };
      try {
        const s = await up.getState();
        return { supported: s?.supported !== false, distributor: s?.distributor ?? null, registered: posted, endpoint: Boolean(lastEndpoint) || Object.keys(s?.endpoints ?? {}).length > 0, failure };
      } catch {
        return { supported: false, distributor: null, registered: false, failure };
      }
    },

    // The system chooser for the push app (when more than one is installed, or none is chosen).
    async chooseDistributor() {
      if (!up) return { ok: false, reason: 'unavailable' };
      try {
        const out = await up.pickDistributor();
        return { ok: out?.ok !== false, reason: null };
      } catch {
        return { ok: false, reason: 'failed' };
      }
    },

    // Turn on: the permissions (after a tap), a push app, then register. Resolves once the computer has the subscription.
    async enable() {
      if (!up) return { ok: false, reason: 'unavailable' };
      await this.start();
      try {
        const granted = await up.requestNotificationPermission();
        if (granted?.granted === false) return { ok: false, reason: 'denied' };
        await local?.requestPermissions?.();
        const s = await up.getState();
        if (s?.supported === false) return { ok: false, reason: 'unavailable' };
        if (!s?.distributor) {
          const list = await up.getDistributors();
          const names = list?.distributors ?? [];
          if (list?.saved) {
            // Already chosen: register below.
          } else if (names.length === 1) {
            await up.chooseDistributor({ packageName: names[0] });
          } else if (names.length === 0) {
            return { ok: false, reason: 'no-distributor' };
          } else {
            const picked = await up.pickDistributor();
            if (picked?.ok === false) return { ok: false, reason: 'no-distributor' };
          }
        }
        const answer = new Promise(resolve => {
          const timer = setTimer(() => resolve({ ok: false, reason: 'timeout' }), ENDPOINT_WAIT_MS);
          waiting = { resolve: value => { clearTimer(timer); waiting = null; resolve(value); } };
        });
        const vapid = vapidOf();
        await up.register({ instance: 'default', messageForDistributor: 'Plenum', ...(vapid ? { vapid } : {}) });
        return await answer;
      } catch (err) {
        waiting = null;
        return { ok: false, reason: err?.code === 'VAPID_REQUIRED' ? 'vapid' : 'failed' };
      }
    },

    // B-129: an endpoint the computer did not get (no channel when the push app gave it, or the computer refused) is sent again. app.js calls this at
    // every HELLO. The computer replaces the phone's subscription with each body, so a second send is harmless. Nothing is sent after a turn off.
    async resend() {
      if (posted || !pending) return { ok: posted, reason: null };
      const out = await post(pending);
      posted = out.ok;
      if (out.ok) {
        pending = null;
        failure = null;
        try { await pendingStore?.clear(); } catch { /* sent again once and replaced */ }
      }
      return { ok: out.ok, reason: out.ok ? null : 'failed' };
    },

    // Turn off: the computer forgets the subscription and the push app registration ends.
    async disable() {
      if (!up) return { ok: false, reason: 'unavailable' };
      const out = await post({ subscription: null });
      try {
        await up.unregister({ instance: 'default' });
      } catch {
        // The registration is already gone.
      }
      posted = false;
      lastEndpoint = null;
      pending = null;
      try { await pendingStore?.clear(); } catch { /* nothing kept */ }
      return { ok: out.ok, reason: out.ok ? null : 'failed' };
    },

    // Test hooks: the handlers the listeners call.
    handlers: { onEndpoint, onMessage, onAction },
  };
}
