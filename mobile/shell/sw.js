// sw.js (mob-09, wave 105; MOBILE.json client_model.ui_source.pwa and the push rules of MOBILE-UI 10). The phone's service worker,
// bundled as a classic script and served at /shell/sw.js with Service-Worker-Allowed: / (scope /).
//   - The UI files: GET of a UI path (index, app.js, ext-*.js and the rest) is answered from the cache the active record names
//     (ui-loader.js). The index is rewritten on the way out (rewriteIndex: data-surface, viewport-fit, the shim tag).
//     Anything not cached goes to the network as usual.
//   - The shell's own files (/shell/boot.js, /shell/shell.js, /shell/channel.worker.js, /shell/styles.css: the BUNDLE names): answered from
//     the same cache when the loader copied them there (ui-loader.js copies the bundled SHELL_FILES). Not cached: the worker fetches the same
//     name beside itself (fetch(new URL(name, self.location.href)), so it works at / and at /p/<key>/), never a path outside the shell.
//   - The shell's own screens stay reachable: a navigation to /?shell is not answered with the UI, so Phone settings, the computer list, the
//     lock set-up and pairing (the shell page) open from the UI page and from a notification.
//   - The artifact iframe: GET /api/artifacts/view is answered by the page (boot.js holds the channel): the worker sends the
//     request to a window client and returns the answer with its headers (the Content-Security-Policy included).
//   - Web Push: a push is always shown. If its payload cannot be read it still shows "Plenum", so the browser never revokes the
//     permission for a push that showed nothing. The payload is lib/remote/push.mjs buildPushText: { kind, title, body, tag, tap, actions:
//     [{ action, title, route }], ids: { computer, project, approval }, firstLine? }. A tap opens payload.tap (#waiting=<id>, #handover=<id>,
//     #chat=<project>, #settings=limit, #home); an action opens its route (#deny=<id>, #stop, #approve=<id> with &line=<the first line>).
//     The browser shows at most Notification.maxActions buttons (2 on Chrome): Stop all is always kept, then Approve when the payload has
//     it (the person opted in), otherwise Deny.
//
// The handlers are plain functions over an environment object, so the Node suites drive them with fake caches and clients.
import { isUiPath, rewriteIndex, UI_PAGE_CSP } from '../../lib/remote/ui-manifest.mjs';

// The same names as ui-loader.js (kept here so this worker does not bundle the hash code): the active record's cache and path.
export const ACTIVE_CACHE = 'plenum-ui-active';
export const ACTIVE_PATH = '/__plenum/active.json';
export const ARTIFACT_VIEW = '/api/artifacts/view';
export const FALLBACK_TITLE = 'Plenum';
export const FALLBACK_BODY = 'Open Plenum to see what changed.';
// The page's own policy, sent with every UI file the worker answers. It is UI_PAGE_CSP (the meta tag rewriteIndex adds) plus
// frame-ancestors, which only a header can carry. connect-src keeps ws: and wss:: the channel worker's script is answered here too, and
// a dedicated worker runs under the policy of its own response, so 'self' alone would stop it reaching a computer by any other carrier.
export const UI_CSP = `${UI_PAGE_CSP}; frame-ancestors 'none'`;
const ARTIFACT_TIMEOUT_MS = 30000;
const RES_HEADERS = ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'x-plenum-auth', 'content-disposition', 'content-length'];

function text(value, fallback, max) {
  const clean = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  return (clean || fallback).slice(0, max);
}

// The fragment a notification action opens. An action without an id opens the app as it is.
export function hashFor(action, id = '') {
  const safeId = typeof id === 'string' ? id.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) : '';
  if (action === 'stop') return '#stop';
  if (action === 'deny' && safeId) return `#deny=${safeId}`;
  if (action === 'approve' && safeId) return `#approve=${safeId}`;
  return '';
}

async function readActive(caches) {
  const cache = await caches.open(ACTIVE_CACHE);
  const hit = await cache.match(ACTIVE_PATH);
  if (!hit) return null;
  try {
    const record = JSON.parse(await hit.text());
    return record && typeof record.cacheName === 'string' && record.complete === true ? record : null;
  } catch {
    return null;
  }
}

function plainHeaders(extra) {
  return { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...extra };
}

// A shell file (/shell/boot.js, /shell/app.js, ...): the page's own base. The loader copies the bundled ones into the active cache, so
// the worker answers them from there; a file that is not cached goes to the network as before.
export function isShellPath(pathname, shellBase = '/shell/') {
  return pathname.startsWith(shellBase) && pathname.length > shellBase.length;
}

// The bundle names a /shell/<name> request may fetch beside the worker when the loader has not cached it.
export const SHELL_NAMES = Object.freeze(['boot.js', 'shell.js', 'channel.worker.js', 'styles.css']);

// The shell's own screens at /?shell: the worker does not answer them with the UI.
export function wantsShellPage(url) {
  return url.pathname === '/' && url.searchParams.has('shell');
}

// The UI answer for one request, or null when the worker should not answer it (the browser then goes to the network).
export async function uiResponse(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== env.origin) return null;
  if (url.pathname === ARTIFACT_VIEW) return artifactResponse(url, env);
  if (wantsShellPage(url)) return null;
  const shellBase = env.shellBase ?? '/shell/';
  if (!isUiPath(url.pathname) && !isShellPath(url.pathname, shellBase)) return null;
  const active = await readActive(env.caches);
  if (!active) return isShellPath(url.pathname, shellBase) ? shellFromNetwork(url, env, shellBase) : null;
  const cache = await env.caches.open(active.cacheName);
  const hit = await cache.match(url.pathname);
  if (!hit) return isShellPath(url.pathname, shellBase) ? shellFromNetwork(url, env, shellBase) : null;
  if (url.pathname === '/') {
    const html = rewriteIndex(await hit.text(), { shellBase: env.shellBase ?? '/shell/' });
    return new env.Response(html, { status: 200, headers: plainHeaders({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': UI_CSP }) });
  }
  const type = hit.headers.get('content-type') ?? 'application/octet-stream';
  const headers = plainHeaders({ 'content-type': type });
  if (type.startsWith('text/html') || type.includes('javascript') || type.includes('css')) headers['content-security-policy'] = UI_CSP;
  return new env.Response(await hit.arrayBuffer(), { status: 200, headers });
}

// A shell file the loader has not cached: the same file by its bundle name, beside this worker. Only the four bundle names, so the worker never
// becomes a way to fetch another path of the origin.
async function shellFromNetwork(url, env, shellBase) {
  const name = url.pathname.slice(shellBase.length);
  if (!SHELL_NAMES.includes(name) || typeof env.fetch !== 'function') return null;
  try {
    const res = await env.fetch(new URL(name, env.workerUrl ?? env.origin + '/').href);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function windowClients(clients) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true });
}

// The artifact iframe: the page fetches it through the channel and answers on the port.
export async function artifactResponse(url, env) {
  const list = await windowClients(env.clients);
  const client = list[0];
  const failed = (status, message) => new env.Response(message, { status, headers: plainHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });
  if (!client) return failed(503, 'Plenum is not connected.');
  const channel = new env.MessageChannel();
  const answer = new Promise((resolve, reject) => {
    const timer = env.setTimeout(() => reject(new Error('timed out')), ARTIFACT_TIMEOUT_MS);
    channel.port1.onmessage = event => {
      env.clearTimeout(timer);
      resolve(event.data);
    };
  });
  client.postMessage({ op: 'plenum-fetch', path: url.pathname + url.search }, [channel.port2]);
  let data;
  try {
    data = await answer;
  } catch {
    return failed(502, 'The preview could not be loaded.');
  } finally {
    channel.port1.close();
  }
  const headers = {};
  for (const name of RES_HEADERS) {
    const value = data?.headers?.[name];
    if (value !== undefined && value !== null) headers[name] = String(value);
  }
  const status = Number.isInteger(data?.status) && data.status >= 200 && data.status <= 599 ? data.status : 502;
  // A status without a body (204, 205, 304) is answered without one, as the Response constructor requires.
  const body = [204, 205, 304].includes(status) ? null : (data?.body ?? null);
  return new env.Response(body, { status, headers: plainHeaders(headers) });
}

// Web Push. Always shows something: a payload that cannot be read shows the fallback text.
const ROUTE = /^\/#[\x21-\x7e]{1,200}$/;
const ACTION_NAMES = ['deny', 'stop', 'approve'];

function routeOf(value) {
  return typeof value === 'string' && ROUTE.test(value) ? value : '';
}

// The actions to show: at most `max` (what the browser allows), Stop all always kept, then Approve when the payload has it (the person
// opted in), otherwise Deny. They keep the order the payload gave them. max 0 shows none.
export function chooseActions(list, max) {
  const limit = Number.isInteger(max) && max >= 0 ? max : 2;
  const valid = (Array.isArray(list) ? list : []).filter(a => a && ACTION_NAMES.includes(a.action));
  if (valid.length <= limit) return valid;
  const keep = [];
  for (const name of ['stop', 'approve', 'deny']) {
    const found = valid.find(a => a.action === name);
    if (found && keep.length < limit) keep.push(found);
  }
  return valid.filter(a => keep.includes(a));
}

export async function showPush(event, env) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const title = text(data?.title, FALLBACK_TITLE, 60);
  const body = text(data?.body, FALLBACK_BODY, 200);
  const chosen = chooseActions(data?.actions, env.maxActions);
  const routes = {};
  for (const a of Array.isArray(data?.actions) ? data.actions : []) {
    if (a && ACTION_NAMES.includes(a.action) && routeOf(a.route)) routes[a.action] = a.route;
  }
  const ids = data?.ids && typeof data.ids === 'object' ? data.ids : {};
  const options = {
    body,
    tag: text(data?.tag, 'plenum', 40),
    data: {
      kind: text(data?.kind, 'open', 20),
      id: text(ids.approval, '', 80),
      project: text(ids.project, '', 80),
      tap: routeOf(data?.tap),
      line: text(data?.firstLine, '', 200),
      routes,
    },
    actions: chosen.map(a => ({ action: a.action, title: text(a.title, a.action, 20) })),
  };
  try {
    await env.registration.showNotification(title, options);
  } catch {
    await env.registration.showNotification(FALLBACK_TITLE, { body: FALLBACK_BODY, tag: 'plenum' }).catch(() => {});
  }
}

// The fragment a click means. An action opens its route (the payload's own, so the id it carries is the one the computer made); a plain tap opens
// the payload's tap route. Approve carries the first line the notification showed (&line=...), which the computer checks against the card.
export function hashForClick(action, data = {}) {
  const routes = data.routes && typeof data.routes === 'object' ? data.routes : {};
  let route = '';
  if (action && ACTION_NAMES.includes(action)) route = routeOf(routes[action]);
  else if (!action) route = routeOf(data.tap);
  if (!route) return action ? hashFor(action, data.id ?? '') : (hashFor(data.kind ?? '', data.id ?? '') || '');
  let hash = route.slice(1);
  if (action === 'approve' && data.line) hash += `&line=${encodeURIComponent(String(data.line))}`;
  return hash;
}

// notificationclick: focus the open window and tell it the fragment, or open the app at it.
export async function openFromNotification(event, env) {
  event.notification?.close?.();
  const data = event.notification?.data ?? {};
  const hash = hashForClick(event.action || '', data);
  const list = await windowClients(env.clients);
  if (list.length) {
    const client = list[0];
    if (typeof client.focus === 'function') await client.focus();
    client.postMessage({ op: 'plenum-hash', hash });
    return 'focused';
  }
  await env.clients.openWindow(`${env.scope ?? '/'}${hash}`);
  return 'opened';
}

// Wires the worker's events when it runs in a service worker scope. Nothing runs when the file is only imported.
export function installWorker(self, { caches, clients, registration, shellBase = '/shell/' }) {
  const env = {
    origin: self.location.origin,
    caches,
    clients,
    registration,
    Response: self.Response ?? globalThis.Response,
    MessageChannel: self.MessageChannel ?? globalThis.MessageChannel,
    setTimeout: (fn, ms) => self.setTimeout(fn, ms),
    clearTimeout: id => self.clearTimeout(id),
    shellBase,
    scope: '/',
    fetch: (...args) => fetch(...args),
    workerUrl: self.location.href,
    maxActions: self.Notification?.maxActions,
  };
  self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', event => event.waitUntil(clients.claim()));
  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== env.origin) return;
    if (wantsShellPage(url)) return;
    if (url.pathname !== ARTIFACT_VIEW && !isUiPath(url.pathname) && !isShellPath(url.pathname, shellBase)) return;
    event.respondWith(uiResponse(event.request, env).then(res => res ?? fetch(event.request)));
  });
  self.addEventListener('push', event => event.waitUntil(showPush(event, env)));
  self.addEventListener('notificationclick', event => event.waitUntil(openFromNotification(event, env)));
}

if (typeof self !== 'undefined' && self.registration && typeof self.addEventListener === 'function' && typeof self.clients !== 'undefined') {
  installWorker(self, { caches: self.caches, clients: self.clients, registration: self.registration });
}
