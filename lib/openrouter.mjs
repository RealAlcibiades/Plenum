import { createHash } from 'node:crypto';
import { apiProvider } from './api-providers.mjs';
import { keyFor } from './keys.mjs';

// OpenRouter's model list and its key check, for the picker in the Accounts drawer (see lib/routes/openrouter.mjs).
// Both are GET requests to https://openrouter.ai/api/v1, the only host this file talks to: GET /models for the list and
// GET /key for the check (both read on OpenRouter's API reference; the pages are named in lib/api-providers.mjs).
// The saved key goes in the Authorization header, is read on every call and is never kept, logged or returned here.
// A redirect is refused rather than followed, so the key is never sent on to another host.

const PROVIDER = apiProvider('openrouter');
const BASE = PROVIDER.baseUrl.replace(/\/+$/, '');
// The list is kept in memory for ten minutes, so opening the Accounts drawer again does not ask OpenRouter again.
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15_000;
// The most of an answer that is read. A longer answer is stopped and refused before anything is parsed.
const MAX_BYTES = 2 * 1024 * 1024;
// Bounds on what is taken from the answer. An id that parseRef (lib/providers.mjs) would refuse is left out of the list.
const MAX_MODELS = 3000;
const MAX_NAME = 200;
const ID_SHAPE = /^[A-Za-z0-9._/:-]{1,120}$/;

const NO_KEY = 'No OpenRouter key is saved yet. Open Accounts, paste the key and save it.';

let cache = null; // { at, digest, models }: digest is of the key the list was fetched with
let pending = null; // { digest, request }: the request in flight, shared by callers that arrive while it runs with the same key

// Forgets the kept list and any request in flight. The tests use it to start from nothing.
export function forgetModels() {
  cache = null;
  pending = null;
}

// A digest of the saved key. The list is only used with the key it was fetched with, so a new key misses the cache. The digest
// is kept in memory only; it is never shown or sent.
const keyDigest = key => createHash('sha256').update(key).digest('hex');

// One GET with the key. The body is read by the caller or dropped by it.
function get(path, key) {
  return fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// A plain sentence for a request that never got an answer. Nothing from the error itself is repeated.
function unreached(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `OpenRouter did not answer within ${TIMEOUT_MS / 1000} seconds. Check the connection and try again.`;
  }
  if (/redirect/i.test(String(err?.cause?.message ?? ''))) {
    return 'OpenRouter tried to redirect the request, so it was stopped. The key was not sent on.';
  }
  return 'OpenRouter could not be reached. Check the internet connection and try again.';
}

// A plain sentence for an answer that was not a success. The provider's own error text is not repeated.
function refused(status) {
  if (status === 401) return 'OpenRouter did not accept the saved key (401). Open Accounts and save a valid key.';
  if (status >= 500) return `OpenRouter had a server error (${status}). Try again in a few minutes.`;
  return `OpenRouter did not accept the request (HTTP ${status}).`;
}

// Drops a body that is not wanted, so the connection is not left open.
async function drop(res) {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to clean up if the body is already closed.
  }
}

// Keeps the three fields the picker shows and nothing else from each model.
function slim(data) {
  const models = [];
  for (const m of Array.isArray(data) ? data : []) {
    if (models.length >= MAX_MODELS) break;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !ID_SHAPE.test(m.id)) continue;
    const name = typeof m.name === 'string' ? m.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
    const length = Number.isInteger(m.context_length) && m.context_length > 0 ? m.context_length : null;
    models.push({ id: m.id, name: name || m.id, contextLength: length });
  }
  return models;
}

// Reads the answer's body, at most MAX_BYTES of it. A longer answer is stopped part way, so nothing past the limit is read or
// parsed, and is reported as { tooLarge: true }. Otherwise the answer is { text }.
async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return { text: '' };
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

async function fetchModels(key, digest, now) {
  let res;
  try {
    res = await get('/models', key);
  } catch (err) {
    return { ok: false, models: [], message: unreached(err) };
  }
  if (!res.ok) {
    await drop(res);
    return { ok: false, models: [], message: refused(res.status) };
  }
  let answer;
  try {
    answer = await readCapped(res);
  } catch (err) {
    return { ok: false, models: [], message: unreached(err) };
  }
  if (answer.tooLarge) return { ok: false, models: [], message: 'OpenRouter sent a model list larger than 2 MB, so it was not read.' };
  let body;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return { ok: false, models: [], message: 'OpenRouter sent a model list this app could not read.' };
  }
  const models = slim(body?.data);
  if (!models.length) return { ok: false, models: [], message: 'OpenRouter sent a model list this app could not read.' };
  cache = { at: now(), digest, models };
  return { ok: true, models, cached: false };
}

// The models OpenRouter lists, as { id, name, contextLength }. Nothing is fetched until a key is saved. A list fetched less
// than ten minutes ago with the same key is returned as it was; a new key gets a fresh list. A failed request is not kept, so
// the next call tries again. Answers { ok, models, message?, cached? }; message is a plain sentence when ok is false.
// now is for tests.
export async function listModels({ now = Date.now } = {}) {
  const key = await keyFor(PROVIDER.id);
  if (!key) return { ok: false, models: [], message: NO_KEY };
  const digest = keyDigest(key);
  if (cache && cache.digest === digest && now() - cache.at < CACHE_MS) return { ok: true, models: cache.models, cached: true };
  if (pending?.digest !== digest) {
    const request = fetchModels(key, digest, now).finally(() => {
      if (pending?.request === request) pending = null;
    });
    pending = { digest, request };
  }
  return pending.request;
}

// Asks OpenRouter whether it accepts the saved key. Answers { ok, message } and nothing more: the account details in the
// answer are not read.
export async function checkKey() {
  const key = await keyFor(PROVIDER.id);
  if (!key) return { ok: false, message: NO_KEY };
  let res;
  try {
    res = await get('/key', key);
  } catch (err) {
    return { ok: false, message: unreached(err) };
  }
  await drop(res);
  if (res.ok) return { ok: true, message: 'OpenRouter accepted the saved key.' };
  return { ok: false, message: refused(res.status) };
}
