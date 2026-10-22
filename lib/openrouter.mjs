import { createHash } from 'node:crypto';
import { apiProvider } from './api-providers.mjs';
import { keyFor } from './keys.mjs';

// OpenRouter's model list and its key check, for the picker in the Accounts drawer (see lib/routes/openrouter.mjs).
// Both are GET requests to https://openrouter.ai/api/v1, the only host this file talks to: GET /models for the list and
// GET /key for the check (both read on OpenRouter's API reference; the pages are named in lib/api-providers.mjs).
// The saved key goes in the Authorization header, is read on every call and is never kept, logged or returned here.
// A redirect is refused rather than followed, so the key is never sent on to another host.
// This file also makes two keyless GETs for the API finder (lib/routes/api-finder.mjs): GET /models, the public price list, and
// GET /models/{id}/endpoints, the providers behind one model. They go through getPublic, which never reads the saved key and never
// sends an authorization header. Their answers are kept in memory only (listCatalog, listEndpoints), never on disk.

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
// The API finder's keyless reads (see listCatalog and listEndpoints below).
const CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const ENDPOINTS_MAX_BYTES = 512 * 1024;
// A forced refresh, or a retry after a failure, waits at least this long, so pressing Refresh cannot ask OpenRouter over and over.
const MIN_REFRESH_MS = 60_000;
const ENDPOINT_CACHE_MAX = 100;
// An OpenRouter model id in the one-slash shape that the endpoints path takes. A '..' segment or a second slash never matches.
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HF_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const UNREADABLE_LIST = 'OpenRouter sent a price list this app could not read.';

const NO_KEY = 'No OpenRouter key is saved yet. Open Accounts, paste the key and save it.';

let cache = null; // { at, digest, models }: digest is of the key the list was fetched with
let pending = null; // { digest, request }: the request in flight, shared by callers that arrive while it runs with the same key
let catalog = null; // { at, models }: the last public list that was read (listCatalog)
let catalogFail = null; // { at, message }: the last public read that failed, kept for the back-off
let catalogPending = null; // the public list request in flight, shared by every caller that arrives while it runs
const endpointsCache = new Map(); // model id -> { at, endpoints }, at most ENDPOINT_CACHE_MAX; the oldest goes first
const endpointsPending = new Map(); // model id -> the endpoints request in flight

// Forgets the kept list and any request in flight. The tests use it to start from nothing.
export function forgetModels() {
  cache = null;
  pending = null;
  catalog = null;
  catalogFail = null;
  catalogPending = null;
  endpointsCache.clear();
  endpointsPending.clear();
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
async function readCapped(res, max = MAX_BYTES) {
  const reader = res.body?.getReader();
  if (!reader) return { text: '' };
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
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

// ---------- the keyless reads for the API finder ----------
// One GET with no key. Nothing from keyFor is read here and no authorization header is ever set, whatever key is saved.
function getPublic(path) {
  return fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// A plain sentence for an answer to the keyless read that was not a success. If OpenRouter starts to refuse keyless reads, the
// saved key is never tried as a fallback; the finder shows this sentence instead.
function refusedPublic(status) {
  if (status === 401 || status === 403) return 'OpenRouter now asks for a key to list its models, so its prices could not be read here.';
  if (status === 429) return 'OpenRouter asked Plenum to slow down (429). Try again in a few minutes.';
  if (status >= 500) return `OpenRouter had a server error (${status}). Try again in a few minutes.`;
  return `OpenRouter did not answer the price request (HTTP ${status}).`;
}

// Plain text from a value a router sent: control characters become spaces, runs of whitespace collapse, the ends are trimmed and
// the result is cut at max. A value that is not a string is ''.
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trimEnd();
}

// A price per token, as a number, turned into dollars per million tokens. A price that is not a number from 0 to $10,000 per
// million (0.01 a token) is null, so "-1" (OpenRouter's marker for a model that routes) and blanks have no price.
export function perM(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 0.01) return null;
  return Number((n * 1e6).toPrecision(6));
}

// A price that changes with the prompt's size or the time of day, as OpenRouter lists it in pricing.overrides: { kind: 'prompt',
// above, input, output } for the first override with a numeric min_prompt_tokens, else { kind: 'time' } when an override has
// utc_start, utc_end or utc_days, else null. The base price stays the one the list shows.
export function tierNote(overrides) {
  if (!Array.isArray(overrides)) return null;
  const objects = overrides.filter(o => o && typeof o === 'object');
  const prompt = objects.find(o => Number.isFinite(o.min_prompt_tokens));
  if (prompt) return { kind: 'prompt', above: prompt.min_prompt_tokens, input: perM(prompt.prompt), output: perM(prompt.completion) };
  if (objects.some(o => o.utc_start != null || o.utc_end != null || o.utc_days != null)) return { kind: 'time' };
  return null;
}

const positiveInt = value => (Number.isInteger(value) && value > 0 ? value : null);

// Keeps what the finder needs from each model of OpenRouter's list: { id, label, vendor, hfId, context, input, output, tools, vision,
// tier }. Batch and '~' alias ids are left out, and so is a model whose output is not text. The vendor and label come from the
// "Vendor: Name" form OpenRouter uses; a name without ': ' is all label.
export function slimCatalog(data, max = MAX_MODELS) {
  const out = [];
  for (const m of Array.isArray(data) ? data : []) {
    if (out.length >= max) break;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !ID_SHAPE.test(m.id)) continue;
    if (m.id.startsWith('~') || m.id.endsWith(':batch')) continue;
    const outputs = m.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes('text')) continue;
    const name = cleanText(m.name, MAX_NAME);
    const cut = name.indexOf(': ');
    const pricing = m.pricing && typeof m.pricing === 'object' ? m.pricing : {};
    const inputs = m.architecture?.input_modalities;
    out.push({
      id: m.id,
      label: cut >= 0 ? name.slice(cut + 2) : name || m.id,
      vendor: cut >= 0 ? name.slice(0, cut) : '',
      hfId: typeof m.hugging_face_id === 'string' && HF_ID.test(m.hugging_face_id) ? m.hugging_face_id : null,
      context: positiveInt(m.context_length),
      input: perM(pricing.prompt),
      output: perM(pricing.completion),
      tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
      vision: Array.isArray(inputs) && inputs.includes('image'),
      tier: tierNote(pricing.overrides),
    });
  }
  return out;
}

// The shape every keyless answer takes for the finder. models is the last list read (kept when a refresh fails), so the page can
// show it stale.
function catalogAnswer({ ok, at, models, cached, stale, fetched, message }) {
  return { ok, at, models, cached, stale, fetched, message };
}

function catalogFailure(message, fetched) {
  return catalogAnswer({ ok: false, at: catalog?.at ?? null, models: catalog?.models ?? [], cached: false, stale: Boolean(catalog), fetched, message });
}

// Reads the public list once. Success replaces the kept list; a failure is remembered for the back-off and the old list stays.
async function fetchCatalog(now) {
  const failed = message => {
    catalogFail = { at: now(), message };
    return catalogFailure(message, true);
  };
  let res;
  try {
    res = await getPublic('/models');
  } catch (err) {
    return failed(unreached(err));
  }
  if (!res.ok) {
    await drop(res);
    return failed(refusedPublic(res.status));
  }
  let answer;
  try {
    answer = await readCapped(res, CATALOG_MAX_BYTES);
  } catch (err) {
    return failed(unreached(err));
  }
  if (answer.tooLarge) return failed('OpenRouter sent a price list larger than 4 MB, so it was not read.');
  let body;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return failed(UNREADABLE_LIST);
  }
  const models = slimCatalog(body?.data);
  if (!models.length) return failed(UNREADABLE_LIST);
  const at = now();
  catalog = { at, models };
  catalogFail = null;
  return catalogAnswer({ ok: true, at, models, cached: false, stale: false, fetched: true, message: '' });
}

// OpenRouter's public model list for the finder, as { ok, at, models, cached, stale, fetched, message }. It is kept for ten minutes.
// A forced refresh inside the first minute gets the kept list; a failure is not asked again for a minute. fetched is true only
// when this call made the request (a caller that joins a request already in flight counts as fetched too). now is for tests.
export async function listCatalog({ now = Date.now, force = false } = {}) {
  const t = now();
  if (catalog && t - catalog.at < CACHE_MS && !(force && t - catalog.at >= MIN_REFRESH_MS)) {
    return catalogAnswer({ ok: true, at: catalog.at, models: catalog.models, cached: true, stale: false, fetched: false, message: '' });
  }
  if (catalogFail && t - catalogFail.at < MIN_REFRESH_MS) return catalogFailure(catalogFail.message, false);
  if (!catalogPending) {
    const request = fetchCatalog(now).finally(() => {
      if (catalogPending === request) catalogPending = null;
    });
    catalogPending = request;
  }
  return catalogPending;
}

// The providers behind one OpenRouter model: [{ provider, input, output, context, quantization, uptime1d, tier }], sorted by input
// price with the unpriced last. Status numbers are left out: OpenRouter does not document them.
function endpointsFrom(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (out.length >= 100) break;
    if (!e || typeof e !== 'object') continue;
    const pricing = e.pricing && typeof e.pricing === 'object' ? e.pricing : {};
    const quant = typeof e.quantization === 'string' && /^[a-z0-9_-]{1,20}$/i.test(e.quantization) && e.quantization.toLowerCase() !== 'unknown'
      ? e.quantization
      : null;
    const uptime = e.uptime_last_1d;
    out.push({
      provider: cleanText(e.provider_name, 80),
      input: perM(pricing.prompt),
      output: perM(pricing.completion),
      context: positiveInt(e.context_length),
      quantization: quant,
      uptime1d: typeof uptime === 'number' && Number.isFinite(uptime) && uptime >= 0 && uptime <= 100 ? uptime : null,
      tier: tierNote(pricing.overrides),
    });
  }
  out.sort((a, b) => (a.input === null) - (b.input === null) || (a.input ?? 0) - (b.input ?? 0));
  return out;
}

async function fetchEndpoints(id, now) {
  const failed = message => ({ ok: false, at: null, endpoints: [], message });
  let res;
  try {
    res = await getPublic(`/models/${id}/endpoints`);
  } catch (err) {
    return failed(unreached(err));
  }
  if (!res.ok) {
    await drop(res);
    return failed(refusedPublic(res.status));
  }
  let answer;
  try {
    answer = await readCapped(res, ENDPOINTS_MAX_BYTES);
  } catch (err) {
    return failed(unreached(err));
  }
  if (answer.tooLarge) return failed('OpenRouter sent a providers list larger than 512 KB, so it was not read.');
  let body;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return failed('OpenRouter sent a providers list this app could not read.');
  }
  const endpoints = endpointsFrom(body?.data?.endpoints);
  const at = now();
  endpointsCache.delete(id);
  if (endpointsCache.size >= ENDPOINT_CACHE_MAX) endpointsCache.delete(endpointsCache.keys().next().value);
  endpointsCache.set(id, { at, endpoints });
  return { ok: true, at, endpoints, message: '' };
}

// The providers OpenRouter routes one model to, as { ok, at, endpoints, message }. An id that is not in the one-slash shape gets no
// request. A list is kept for ten minutes per id, and one request per id runs at a time.
export async function listEndpoints(id, { now = Date.now } = {}) {
  if (typeof id !== 'string' || !ENDPOINT_ID.test(id)) return { ok: false, at: null, endpoints: [], message: 'That is not an OpenRouter model id.' };
  const kept = endpointsCache.get(id);
  if (kept && now() - kept.at < CACHE_MS) return { ok: true, at: kept.at, endpoints: kept.endpoints, message: '' };
  if (!endpointsPending.has(id)) {
    const request = fetchEndpoints(id, now).finally(() => {
      if (endpointsPending.get(id) === request) endpointsPending.delete(id);
    });
    endpointsPending.set(id, request);
  }
  return endpointsPending.get(id);
}
