// Plenum relay Worker. Routes:
//   GET /room/<id> with Upgrade: websocket   forwarded to the room's Durable Object
//   GET /room/<id> without an upgrade        426
//   GET the shell (public/), with CSP: / and the files scripts/build-mobile.mjs writes at the root (shell.js, screens.js, boot.js,
//     channel.worker.js, sw.js, styles.css, shell-tokens.css, manifest.webmanifest, version.json), icons/, demo/, remote/ and assets/,
//     and /shell/<boot.js|shell.js|channel.worker.js|styles.css>, which is the same root file (the UI page names its shell files so)
//   everything else                          404
// The Worker never reads a frame. It checks the host secret by hashing it, and
// passes only the hash to the room. No secret or hash is ever logged.
export { Room } from './room.mjs';

const ROOM_ID = /^[0-9a-f]{32}$/;
const HOST_SECRET = /^[A-Za-z0-9_-]{22,128}$/;

const SHELL_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
});

function text(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function notFound() {
  return text(404, 'Not found\n');
}

// The shell the build writes into public/ (scripts/build-mobile.mjs, without the ui/ snapshot). A request outside this list is a 404.
const SHELL_FILES = new Set([
  '/', '/sw.js', '/version.json', '/manifest.webmanifest', '/shell.js', '/screens.js', '/boot.js', '/channel.worker.js', '/styles.css', '/shell-tokens.css',
]);
const SHELL_DIRS = ['/assets/', '/icons/', '/demo/', '/remote/'];
// /shell/<name> is the UI page's name for a shell file; the file itself sits at the root of public/.
const SHELL_ALIAS = /^\/shell\/(boot\.js|shell\.js|channel\.worker\.js|styles\.css)$/;

function isShellPath(path) {
  if (SHELL_FILES.has(path) || SHELL_ALIAS.test(path)) return true;
  return SHELL_DIRS.some((dir) => path.startsWith(dir) && path.length > dir.length && !path.split('/').some((part) => part === '..' || part === '.'));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function room(request, env, id) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return text(426, 'Upgrade Required\n', { Upgrade: 'websocket' });
  }
  if (request.method !== 'GET') return text(405, 'Method Not Allowed\n', { Allow: 'GET' });
  if (!ROOM_ID.test(id)) return notFound();

  const headers = new Headers({ Upgrade: 'websocket' });
  const role = request.headers.get('x-plenum-role');
  if (role === null) {
    headers.set('x-relay-role', 'phone');
    // The phone's address, set by Cloudflare's edge (a client cannot set it), so the computer can rate-limit handshakes per phone address
    // instead of one shared 'relay' source. Absent when the Worker runs locally.
    const ip = request.headers.get('cf-connecting-ip');
    if (ip !== null) headers.set('cf-connecting-ip', ip);
  } else if (role === 'host') {
    const secret = request.headers.get('x-plenum-host-secret');
    if (secret === null || !HOST_SECRET.test(secret)) return text(403, 'Forbidden\n');
    headers.set('x-relay-role', 'host');
    headers.set('x-relay-host-hash', await sha256Hex(secret));
  } else {
    return text(403, 'Forbidden\n');
  }

  const stub = env.ROOM.get(env.ROOM.idFromName(id));
  return stub.fetch(new Request(request.url, { method: 'GET', headers }));
}

async function shell(request, env) {
  const url = new URL(request.url);
  const alias = SHELL_ALIAS.exec(url.pathname);
  const asked = alias ? new Request(new URL(`/${alias[1]}`, url), request) : request;
  const response = await env.ASSETS.fetch(asked);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SHELL_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const match = /^\/room\/([^/]+)$/.exec(path);
    if (match) return room(request, env, match[1]);
    if (path.startsWith('/room/') || !isShellPath(path)) return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
    }
    return shell(request, env);
  },
};
