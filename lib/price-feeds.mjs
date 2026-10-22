// Keyless price lists from three routers, for the API finder (lib/routes/api-finder.mjs), and the code that joins every source into one
// comparison. Each list is one GET to a URL fixed in FEEDS: no key, no cookie, no chat or project data, redirects refused, a 15 second
// timeout and a byte cap. Nothing is fetched at app start; the finder asks only while its panel is open. Each list is kept in memory
// for ten minutes and never written to disk. OpenRouter's list is read by lib/openrouter.mjs (listCatalog).
//
// Models are matched by exact id after a few spelling fixes (matchKey). A model that two sources spell differently is two rows,
// never a guess, so a wrong merge cannot show a false "cheapest".
import { CATALOG } from './providers.mjs';
import { API_PROVIDERS, apiProvider } from './api-providers.mjs';
import { PRICES } from './pricing.mjs';
import { infoFor } from './model-info.mjs';
import { cleanText, perM } from './openrouter.mjs';

const MB = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const CACHE_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60_000;
// Most entries kept from one list, and most rows the comparison returns.
const ENTRY_CAP = 3000;
const ROW_CAP = 4000;
const FEED_ID = /^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,159}$/;

// The three lists, fixed. No URL ever comes from a request or from feed data.
export const FEEDS = Object.freeze([
  Object.freeze({ id: 'vercel', name: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh/v1/models', maxBytes: 4 * MB }),
  Object.freeze({ id: 'deepinfra', name: 'DeepInfra', url: 'https://api.deepinfra.com/models/list', maxBytes: 4 * MB }),
  Object.freeze({ id: 'martian', name: 'Martian', url: 'https://api.withmartian.com/v1/models', maxBytes: 2 * MB }),
]);

// ---------- reading one list ----------

function unreachedFeed(feed, err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `${feed.name} did not answer within 15 seconds.`;
  if (/redirect/i.test(String(err?.cause?.message ?? ''))) return `${feed.name} tried to redirect the request, so it was stopped.`;
  return `${feed.name} could not be reached. Check the internet connection and try again.`;
}

// Reads the body, at most max bytes. A longer body is stopped part way and reported as { tooLarge: true }, so nothing past the cap is parsed.
async function readBounded(res, max) {
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

async function dropBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    // The body is already closed; nothing to clean up.
  }
}

// One keyless GET of a list. Answers { body } when it parsed, else { message }, a plain sentence that names the router.
async function readFeed(feed) {
  let res;
  try {
    res = await fetch(feed.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { message: unreachedFeed(feed, err) };
  }
  if (!res.ok) {
    await dropBody(res);
    return { message: `${feed.name} did not answer the price request (HTTP ${res.status}).` };
  }
  let answer;
  try {
    answer = await readBounded(res, feed.maxBytes);
  } catch (err) {
    return { message: unreachedFeed(feed, err) };
  }
  if (answer.tooLarge) return { message: `${feed.name} sent a price list larger than ${feed.maxBytes / MB} MB, so it was not read.` };
  try {
    return { body: JSON.parse(answer.text) };
  } catch {
    return { message: `${feed.name} sent a price list this app could not read.` };
  }
}

// ---------- the normalisers (pure) ----------

const objectOf = value => (value && typeof value === 'object' ? value : {});
const positiveInt = value => (Number.isInteger(value) && value > 0 ? value : null);

// Vercel AI Gateway: language models only, batch ids left out. A model whose pricing does not give an input price stays, with null prices.
export function normalizeVercel(body) {
  const out = [];
  for (const e of Array.isArray(body?.data) ? body.data : []) {
    if (out.length >= ENTRY_CAP) break;
    if (!e || typeof e !== 'object' || e.type !== 'language') continue;
    if (typeof e.id !== 'string' || !FEED_ID.test(e.id) || e.id.endsWith('-batch')) continue;
    const pricing = objectOf(e.pricing);
    const modalities = objectOf(e.modalities);
    out.push({
      id: e.id,
      name: cleanText(e.name, 200),
      input: perM(pricing.input),
      output: perM(pricing.output),
      context: positiveInt(e.context_window),
      tools: (Array.isArray(e.supported_parameters) && e.supported_parameters.includes('tools')) || (Array.isArray(e.tags) && e.tags.includes('tool-use')),
      vision: Array.isArray(modalities.input) && modalities.input.includes('image'),
    });
  }
  return out;
}

// DeepInfra prices are in US cents per token: 1e-5 is $0.10 per million, 0.0002 is $2 per million. Only text generation billed per token
// is kept, and a model whose deprecated time has passed is dropped, so a retired model's price never shows as a current offer.
function centsPerM(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? Number((n * 10_000).toPrecision(6)) : null;
}

export function normalizeDeepInfra(body, { now = Date.now } = {}) {
  const out = [];
  const t = now();
  for (const e of Array.isArray(body) ? body : []) {
    if (out.length >= ENTRY_CAP) break;
    if (!e || typeof e !== 'object' || e.type !== 'text-generation' || e.pricing?.type !== 'tokens') continue;
    if (typeof e.model_name !== 'string' || !FEED_ID.test(e.model_name)) continue;
    if (typeof e.deprecated === 'number' && e.deprecated * 1000 <= t) continue;
    out.push({
      id: e.model_name,
      name: e.model_name,
      input: centsPerM(e.pricing.cents_per_input_token),
      output: centsPerM(e.pricing.cents_per_output_token),
      context: null,
      tools: null,
      vision: null,
    });
  }
  return out;
}

// Martian gives no names. Batch ids are left out.
export function normalizeMartian(body) {
  const out = [];
  for (const e of Array.isArray(body?.data) ? body.data : []) {
    if (out.length >= ENTRY_CAP) break;
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !FEED_ID.test(e.id)) continue;
    if (e.id.endsWith('-batch') || e.id.endsWith(':batch')) continue;
    const pricing = objectOf(e.pricing);
    out.push({ id: e.id, name: null, input: perM(pricing.prompt), output: perM(pricing.completion), context: null, tools: null, vision: null });
  }
  return out;
}

const NORMALIZERS = Object.freeze({
  vercel: (body) => normalizeVercel(body),
  deepinfra: (body, now) => normalizeDeepInfra(body, { now }),
  martian: (body) => normalizeMartian(body),
});

// ---------- the cache for each list ----------

const feedState = new Map(); // feed id -> { list: { at, offers }, fail: { at, message }, pending }

function stateOf(id) {
  let st = feedState.get(id);
  if (!st) {
    st = {};
    feedState.set(id, st);
  }
  return st;
}

// Forgets every kept list and any request in flight. The tests use it to start from nothing.
export function forgetFeeds() {
  feedState.clear();
}

const feedAnswer = (feed, fields) => ({
  id: feed.id,
  name: feed.name,
  ok: fields.ok,
  at: fields.at,
  cached: fields.cached,
  stale: fields.stale,
  fetched: fields.fetched,
  message: fields.message,
  offers: fields.offers,
});

// The answer after a failed read: the last good list stays and is marked stale when there is one.
const failedFeed = (feed, st, message, fetched) => feedAnswer(feed, {
  ok: false,
  at: st.list?.at ?? null,
  cached: false,
  stale: Boolean(st.list),
  fetched,
  message,
  offers: st.list?.offers ?? [],
});

function failFeed(feed, message, now) {
  const st = stateOf(feed.id);
  st.fail = { at: now(), message };
  return failedFeed(feed, st, message, true);
}

async function loadFeed(feed, now) {
  const got = await readFeed(feed);
  if (got.message) return failFeed(feed, got.message, now);
  const offers = NORMALIZERS[feed.id](got.body, now);
  if (!offers.length) return failFeed(feed, `${feed.name} sent a price list this app could not read.`, now);
  const at = now();
  const st = stateOf(feed.id);
  st.list = { at, offers };
  st.fail = null;
  return feedAnswer(feed, { ok: true, at, cached: false, stale: false, fetched: true, message: '', offers });
}

// One list for the finder: { id, name, ok, at, cached, stale, fetched, message, offers }. The same rules as listCatalog: ten minutes
// kept, a forced refresh inside the first minute gets the kept list, a failure is not asked again for a minute, and a request in
// flight is shared. now is for tests.
export async function getFeed(id, { now = Date.now, force = false } = {}) {
  const feed = FEEDS.find(f => f.id === id);
  if (!feed) {
    return { id: String(id ?? ''), name: String(id ?? ''), ok: false, at: null, cached: false, stale: false, fetched: false, message: 'Plenum does not read that price list.', offers: [] };
  }
  const t = now();
  const st = stateOf(feed.id);
  if (st.list && t - st.list.at < CACHE_MS && !(force && t - st.list.at >= MIN_REFRESH_MS)) {
    return feedAnswer(feed, { ok: true, at: st.list.at, cached: true, stale: false, fetched: false, message: '', offers: st.list.offers });
  }
  if (st.fail && t - st.fail.at < MIN_REFRESH_MS) return failedFeed(feed, st, st.fail.message, false);
  if (!st.pending) {
    const request = loadFeed(feed, now).finally(() => {
      st.pending = null;
    });
    st.pending = request;
  }
  return st.pending;
}

// ---------- matching ----------

// Spelling fixes for the maker part of an id, so the same model from two routers meets. Nothing fuzzier.
const VENDOR_ALIASES = new Map([
  ['x-ai', 'xai'],
  ['spacexai', 'xai'],
  ['mistralai', 'mistral'],
  ['z-ai', 'zai'],
  ['zai-org', 'zai'],
  ['bytedance-seed', 'bytedance'],
  ['deepseek-ai', 'deepseek'],
]);

// The key a model id is matched by: lower case, the maker alias applied, and '.' in the model part written as '-'. A ':free'
// variant keeps its suffix, so it is its own row. Batch, '~' alias and maker-less ids have no key (null).
export function matchKey(id) {
  const s = String(id ?? '').trim().toLowerCase();
  if (!s || s.startsWith('~') || s.endsWith(':batch') || s.endsWith('-batch')) return null;
  const cut = s.indexOf('/');
  if (cut < 1) return null;
  const rest = s.slice(cut + 1);
  if (!rest) return null;
  const maker = s.slice(0, cut);
  return `${VENDOR_ALIASES.get(maker) ?? maker}/${rest.replace(/\./g, '-')}`;
}

// Plenum's own model refs (provider:id) that OpenRouter lists under another id. Each pair was found in the 2026-10-20 OpenRouter list
// with a matching name. Refs left out (xAI's grok-4.20 reasoning and non-reasoning, and Mistral's small and ministral models) have no
// confirmed pair and stay their own rows.
export const DIRECT_MATCH = Object.freeze({
  'anthropic:claude-opus-5-5': 'anthropic/claude-opus-5.5',
  'anthropic:claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5',
  'anthropic:claude-haiku-5-5': 'anthropic/claude-haiku-5.5',
  'anthropic:claude-fable-5-1': 'anthropic/claude-fable-5.1',
  'xai:grok-4.7': 'x-ai/grok-4.7',
  'openai:gpt-6.1-sol': 'openai/gpt-6.1-sol',
  'openai:gpt-6-luna': 'openai/gpt-6-luna',
  'openai:gpt-6-astra': 'openai/gpt-6-astra',
  'deepseek:deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek:deepseek-flash': 'deepseek/deepseek-v4.1-flash',
  'googleai:gemini-4-argon': 'google/gemini-4-argon',
  'googleai:gemini-3.8-flash': 'google/gemini-3.8-flash',
  'googleai:gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
  'mistral:mistral-large-4': 'mistralai/mistral-large-4-0',
});

// Plenum's catalog providers that are not billed per token with a key. They have no direct price row in the finder.
const DIRECT_EXCLUDED = new Set(['muse', 'codex', 'gemini', 'echo', 'openrouter']);

// The first PRICES.models source of a provider prefix such as "xai:", as a link. Null when the table has none.
function priceSourceUrl(prefix) {
  for (const [key, entry] of Object.entries(PRICES.models)) {
    if (key.startsWith(prefix) && entry?.source) return `https://${entry.source}`;
  }
  return null;
}

// The table's own source for a ref, else the provider's. Only https links come out of here.
function directSourceUrl(ref) {
  const colon = ref.indexOf(':');
  if (colon < 1) return null;
  const own = Object.hasOwn(PRICES.models, ref) ? PRICES.models[ref]?.source : null;
  if (own) return `https://${own}`;
  return priceSourceUrl(ref.slice(0, colon + 1));
}

// Plenum's direct models with their table prices: every Anthropic and API-provider model in the catalog. A model Plenum supports is
// always here, even when its price is not published; its input and output are then null.
export function directOffers() {
  const providers = new Set(API_PROVIDERS.map(p => p.id));
  const out = [];
  for (const c of CATALOG) {
    if (DIRECT_EXCLUDED.has(c.provider)) continue;
    if (c.provider !== 'anthropic' && !providers.has(c.provider)) continue;
    const ref = `${c.provider}:${c.id}`;
    const info = infoFor(ref);
    const price = info.price;
    out.push({
      ref,
      provider: c.provider,
      label: c.label.replace(/\s*\([^()]*\)\s*$/, ''),
      input: price ? price.input : null,
      output: price ? price.output : null,
      context: info.context,
      note: price ? (price.label ?? '') : 'price not published',
      url: directSourceUrl(ref),
      published: Boolean(price),
    });
  }
  return out;
}

// Vendor names as people read them. A key with no name here shows the name OpenRouter gives, then the key itself.
export const VENDOR_NAMES = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  'meta-llama': 'Meta',
  qwen: 'Qwen',
  alibaba: 'Alibaba',
  zai: 'Z.ai',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  minimax: 'MiniMax',
  cohere: 'Cohere',
  amazon: 'Amazon',
  microsoft: 'Microsoft',
});

const vendorName = key => (Object.hasOwn(VENDOR_NAMES, key) ? VENDOR_NAMES[key] : null);

// Plenum's provider id as a vendor key, where the two differ.
const DIRECT_VENDOR = Object.freeze({ googleai: 'google' });

// The page on a router that shows one model, where the pattern was confirmed with two models on the same host (2026-10-21: a real
// model answers 200 and a made-up one 404). Any other router links to its site.
const PAGE_PATTERNS = Object.freeze({ vercel: true, deepinfra: true });
const SITE_LINK = Object.freeze({
  vercel: 'https://vercel.com/ai-gateway',
  deepinfra: 'https://deepinfra.com',
  martian: 'https://withmartian.com',
});

// A link to one model's page on a router. A feed id never supplies a URL: only the id, in a fixed pattern, and only when it has no
// '..' or empty segment.
export function modelPage(source, id) {
  const text = String(id ?? '');
  const safe = text.length > 0 && !text.split('/').some(part => part === '' || part === '.' || part === '..');
  if (safe && source === 'vercel' && PAGE_PATTERNS.vercel) {
    const part = text.split('/')[1];
    if (part) return `https://vercel.com/ai-gateway/models/${part}`;
  }
  if (safe && source === 'deepinfra' && PAGE_PATTERNS.deepinfra) return `https://deepinfra.com/${text}`;
  return SITE_LINK[source] ?? null;
}

const modelPart = id => {
  const text = String(id ?? '');
  const cut = text.indexOf('/');
  return cut >= 0 ? text.slice(cut + 1) : text;
};

const SOURCE_ORDER = ['openrouter', 'vercel', 'deepinfra', 'martian', 'direct'];
const FEED_SOURCES = ['vercel', 'deepinfra', 'martian'];

// Joins the sources into one row per model. openrouter is the slimCatalog list (lib/openrouter.mjs), feeds is { vercel, deepinfra,
// martian } offer lists from normalizeVercel and the others, and direct is directOffers(). Each row has its offers, the cheapest
// blend and the sources that tie for it. The blend is (3 x input + output) / 4, a typical chat before any fee.
export function buildComparison({ openrouter = [], feeds = {}, direct = [] } = {}) {
  const rows = new Map(); // row key -> row
  const alias = new Map(); // matchKey of a model's hugging_face_id -> the key of the OpenRouter row that carries it
  const hfPairs = [];

  for (const m of openrouter) {
    const key = matchKey(m.id);
    if (!key || rows.has(key)) continue;
    const vendorKey = key.slice(0, key.indexOf('/'));
    rows.set(key, {
      key,
      id: m.id,
      name: m.label,
      vendor: vendorName(vendorKey) || m.vendor || vendorKey,
      vendorKey,
      context: m.context,
      tools: m.tools,
      vision: m.vision,
      openrouterId: m.id,
      plenumRef: null,
      offers: [{ source: 'openrouter', id: m.id, input: m.input, output: m.output, context: m.context, tier: m.tier, url: `https://openrouter.ai/${m.id}` }],
    });
    if (m.hfId) hfPairs.push([m.hfId, key]);
  }
  for (const [hfId, key] of hfPairs) {
    const own = matchKey(hfId);
    if (own && !rows.has(own) && !alias.has(own)) alias.set(own, key);
  }

  for (const source of FEED_SOURCES) {
    for (const f of Array.isArray(feeds[source]) ? feeds[source] : []) {
      const key = matchKey(f.id);
      if (!key) continue;
      const row = rows.get(key) ?? rows.get(alias.get(key));
      const offer = { source, id: f.id, input: f.input, output: f.output, context: f.context, tier: null, url: modelPage(source, f.id) };
      if (row) {
        if (row.offers.some(o => o.source === source)) continue;
        row.offers.push(offer);
        if (row.context === null) row.context = f.context ?? null;
        if (row.tools === null) row.tools = f.tools ?? null;
        if (row.vision === null) row.vision = f.vision ?? null;
        continue;
      }
      const vendorKey = key.slice(0, key.indexOf('/'));
      rows.set(key, {
        key,
        id: f.id,
        name: f.name || modelPart(f.id),
        vendor: vendorName(vendorKey) || vendorKey,
        vendorKey,
        context: f.context ?? null,
        tools: f.tools ?? null,
        vision: f.vision ?? null,
        openrouterId: null,
        plenumRef: null,
        offers: [offer],
      });
    }
  }

  for (const d of Array.isArray(direct) ? direct : []) {
    const mapped = Object.hasOwn(DIRECT_MATCH, d.ref) ? matchKey(DIRECT_MATCH[d.ref]) : null;
    const key = mapped ?? `direct/${d.ref}`;
    const row = rows.get(key) ?? rows.get(alias.get(key));
    const offer = { source: 'direct', id: d.ref, label: d.label, input: d.input, output: d.output, context: d.context, note: d.note, url: d.url, published: d.published };
    if (row) {
      if (!row.offers.some(o => o.source === 'direct')) row.offers.push(offer);
      if (row.plenumRef === null) row.plenumRef = d.ref;
      if (row.context === null) row.context = d.context ?? null;
      continue;
    }
    const vendorKey = DIRECT_VENDOR[d.provider] ?? d.provider;
    rows.set(key, {
      key,
      id: d.ref,
      name: d.label,
      vendor: vendorName(vendorKey) || vendorKey,
      vendorKey,
      context: d.context ?? null,
      tools: null,
      vision: null,
      openrouterId: null,
      plenumRef: d.ref,
      offers: [offer],
    });
  }

  for (const row of rows.values()) {
    const priced = row.offers.filter(o => o.input !== null && o.output !== null);
    if (!priced.length) {
      row.best = null;
      row.free = false;
      continue;
    }
    const blends = priced.map(o => ({ source: o.source, blend: (3 * o.input + o.output) / 4 }));
    const min = Math.min(...blends.map(b => b.blend));
    const sources = blends
      .filter(b => Math.abs(b.blend - min) <= 1e-9)
      .map(b => b.source)
      .sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
    row.best = {
      blend: min,
      sources,
      input: Math.min(...priced.map(o => o.input)),
      output: Math.min(...priced.map(o => o.output)),
    };
    row.free = min === 0;
  }

  const byBlend = (a, b) => {
    const x = a.best?.blend;
    const y = b.best?.blend;
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  };
  return [...rows.values()]
    .sort((a, b) => b.offers.length - a.offers.length || byBlend(a, b) || String(a.name).localeCompare(String(b.name)))
    .slice(0, ROW_CAP);
}
