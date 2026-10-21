// The per-launch token. Every request to /api/ must carry it in the x-plenum-token header (server.mjs checks it before any
// route runs), so another program or web page on this computer cannot read or change Plenum's state.
//  - Under the desktop app the main process makes the token, hands it to this server over the keys channel (lib/keys.mjs
//    applyKeys) and gives it to the app page through a preload bridge. It is never on a command line, in an environment or in a URL.
//  - Started with plain Node, PLENUM_TOKEN (64 hex characters) is used when set; otherwise a token is made here and printed once,
//    in a URL fragment, which a browser never sends to the server.
// The token lives in memory only. It is never logged, never written to the state file and never put in a URL by the server.
// This file imports nothing from the app, so any module may import it without a cycle.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const HEADER = 'x-plenum-token';
export const TOKEN_RE = /^[a-f0-9]{64}$/;

// The answer to a request with no valid token. It says nothing about what a valid token looks like.
const REFUSAL = 'This request carries no valid Plenum token. Reload the Plenum window, or open the link printed where Plenum was started.';
const SOURCES = ['desktop', 'environment', 'generated'];

let current = '';
let currentSource = '';

// Sets the token. Only a 64-character lower-case hex string is accepted, from one of the three sources. Returns whether it was
// taken; a refused value leaves the token as it was. A second call replaces the token (the desktop's keys message does that).
export function setToken(value, source) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value) || !SOURCES.includes(source)) return false;
  current = value;
  currentSource = source;
  return true;
}

// Keeps a token that is already set. Otherwise takes PLENUM_TOKEN when it is a valid token, otherwise makes a new random one.
// The variable is removed from this process's environment once it has been read, so no child process (a model's command, a CLI
// agent) inherits it.
export function ensureToken() {
  if (current) return { token: current, source: currentSource };
  const fromEnv = process.env.PLENUM_TOKEN;
  if (typeof fromEnv === 'string' && TOKEN_RE.test(fromEnv)) {
    delete process.env.PLENUM_TOKEN;
    setToken(fromEnv, 'environment');
  } else {
    delete process.env.PLENUM_TOKEN;
    setToken(randomBytes(32).toString('hex'), 'generated');
  }
  return { token: current, source: currentSource };
}

export const token = () => current;
export const tokenSource = () => currentSource;

// null when the request carries the token, else an Error with status 401. The comparison is constant-time and runs only on
// buffers of equal length. With no token set at all, every request is refused.
export function checkRequest(req) {
  const given = req?.headers?.[HEADER];
  if (current && typeof given === 'string') {
    const a = Buffer.from(given);
    const b = Buffer.from(current);
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
  }
  return Object.assign(new Error(REFUSAL), { status: 401 });
}

// True for the refusal above. The server marks such an answer with an x-plenum-auth header, so a page can tell it from a 401 that
// a model provider sent back (an invalid API key) and only asks for a token for the first.
export const isRefusal = err => err?.status === 401 && err.message === REFUSAL;

// The same check for a route that must be safe on its own (defence in depth): throws the 401 through the server's httpError.
export function requireToken(req, httpError) {
  const bad = checkRequest(req);
  if (bad) throw httpError(bad.status, bad.message);
}
