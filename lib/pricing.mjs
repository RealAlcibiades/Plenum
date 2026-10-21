// Token prices, and what a reply cost. Pure code: no network, no files, no clock (the caller passes the date).
//
// Every number in PRICES was read from the providers' own pricing pages on 2026-10-14 (checkedOn) and is kept in
// build\PRICES.md. A model that is not in the table, or is listed there as "not published", has no price: its cost
// is null with the reason "price not published". Nothing is ever estimated from another model's price, and tokens
// are never estimated at all: a model that reports none shows "usage not reported".
//
// A subscription CLI (Claude Code, Codex, Gemini CLI, Muse Code) is billed to the user's plan, not per token, so its
// replies carry tokens only, never a dollar amount. The reason for a plan reply is "plan use".
//
// A usage record, as the adapters report it and as it is stored on a reply:
//   { input, cached, output, at? }  input is every prompt token, cached ones included; cached is the part of it that
//   the provider read from its cache. at is when the request was sent (ms since 1970), which fixes the time-limited
//   prices. Prompt tokens here mean the same thing for every provider, so the tiers below compare against input.

export const PRICES = {
  checkedOn: '2026-10-14',
  // Every rate below is dollars per this many tokens.
  perTokens: 1_000_000,
  models: {},
};

export const PLAN_USE = 'plan use';
export const NOT_PUBLISHED = 'price not published';
export const NOT_REPORTED = 'usage not reported';

// A K here is a thousand tokens. The pages say "100K", "200K" and "272K" without saying whether they mean 1,000 or 1,024.
const K100 = 100_000;
const K200 = 200_000;
const K272 = 272_000;

const SOURCE = {
  anthropic: 'platform.claude.com/docs/en/about-claude/pricing',
  openai: 'developers.openai.com/api/docs/pricing',
  xai: 'docs.x.ai/developers/pricing',
  deepseek: 'api-docs.deepseek.com/quick_start/pricing/',
  mistral: 'docs.mistral.ai/inference/pricing',
  googleai: 'ai.google.dev/gemini-api/docs/pricing',
};

const rate = (input, output, cached, label = null) => ({ input, output, cached, label });

// Two rates by prompt size. xAI charges the higher rate for every token once the prompt reaches 200K ("atOrAbove");
// Anthropic Haiku charges it above 100K ("above").
const byPrompt = (limit, from, low, high, lowLabel, highLabel) => ({
  limit,
  from,
  low: { ...low, label: lowLabel },
  high: { ...high, label: highLabel },
});

Object.assign(PRICES.models, {
  'anthropic:claude-opus-5-5': { source: SOURCE.anthropic, rate: rate(4.0, 20.0, 0.2) },
  'anthropic:claude-sonnet-5-5': { source: SOURCE.anthropic, rate: rate(2.0, 10.0, 0.1) },
  'anthropic:claude-haiku-5-5': {
    source: SOURCE.anthropic,
    byPrompt: byPrompt(K100, 'above', rate(0.1, 0.5, 0.01), rate(0.5, 2.5, 0.05), 'prompt up to 100K', 'prompt above 100K'),
  },

  // The page prices prompts up to 272K tokens (standard tier). Its long-context rate was not extracted, so a longer
  // prompt has no price here.
  'openai:gpt-6-astra': { source: SOURCE.openai, maxPrompt: K272, rate: rate(10.0, 50.0, 1.0) },
  'openai:gpt-6.1-sol': { source: SOURCE.openai, maxPrompt: K272, rate: rate(2.0, 10.0, 0.1) },
  'openai:gpt-6-luna': { source: SOURCE.openai, maxPrompt: K272, rate: rate(0.1, 0.5, 0.01) },

  'xai:grok-4.7': {
    source: SOURCE.xai,
    byPrompt: byPrompt(K200, 'atOrAbove', rate(2.0, 6.0, 0.5), rate(4.0, 12.0, 1.0), 'prompt under 200K', 'prompt 200K and above'),
  },
  'xai:grok-4.20-0309-reasoning': {
    source: SOURCE.xai,
    byPrompt: byPrompt(K200, 'atOrAbove', rate(1.25, 2.5, 0.2), rate(2.5, 5.0, 0.4), 'prompt under 200K', 'prompt 200K and above'),
  },
  'xai:grok-4.20-0309-non-reasoning': {
    source: SOURCE.xai,
    byPrompt: byPrompt(K200, 'atOrAbove', rate(1.25, 2.5, 0.2), rate(2.5, 5.0, 0.4), 'prompt under 200K', 'prompt 200K and above'),
  },

  // Peak 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday; any other time is off-peak (see deepseekPeak).
  'deepseek:deepseek-flash': { source: SOURCE.deepseek, peak: rate(0.3, 1.2, 0.006, 'peak'), offPeak: rate(0.15, 0.6, 0.003, 'off-peak') },
  'deepseek:deepseek-v4-pro': { source: SOURCE.deepseek, peak: rate(1.32, 3.96, 0.044, 'peak'), offPeak: rate(0.66, 1.98, 0.022, 'off-peak') },

  // Mistral Large 4 is on sale with no end date. The "was" prices are kept for the record and never used.
  'mistral:mistral-large-4': {
    source: SOURCE.mistral,
    rate: rate(0.68, 2.09, 0.07, 'sale price, Mistral page'),
    was: rate(1.36, 4.18, 0.14),
  },
  // The Mistral page does not list these three, so they have no cost.
  'mistral:mistral-small-2603': { source: SOURCE.mistral, unpublished: true },
  'mistral:ministral-3b-2512': { source: SOURCE.mistral, unpublished: true },
  'mistral:ministral-8b-2512': { source: SOURCE.mistral, unpublished: true },

  // Changes are dated at 00:00 UTC. rate holds until the first change.
  'googleai:gemini-4-argon': {
    source: SOURCE.googleai,
    rate: rate(2.0, 10.0, 0.1, 'to 30 Nov 2026'),
    changes: [{ from: '2026-12-01', rate: rate(4.0, 20.0, 0.2, 'from 1 Dec 2026') }],
  },
  'googleai:gemini-3.8-flash': {
    source: SOURCE.googleai,
    rate: rate(0.75, 3.75, 0.075, 'to 31 Dec 2026'),
    changes: [{ from: '2027-01-01', rate: rate(1.5, 7.5, 0.15, 'from 1 Jan 2027') }],
  },
  'googleai:gemini-3.5-flash-lite': { source: SOURCE.googleai, rate: rate(0.3, 2.5, 0.03) },
});

// These providers are subscription CLIs: tokens only, never a price. Anthropic is in neither list, because Claude runs
// through the API key or through the Claude CLI, and the record says which (billing).
const PLAN_PROVIDERS = new Set(['muse', 'codex', 'gemini']);

const MAX_STEPS = 60;

// ---------- small helpers ----------

const splitRef = ref => {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  return i < 0 ? { provider: '', id: text } : { provider: text.slice(0, i), id: text.slice(i + 1) };
};

// A whole number of tokens, or null when the value is not a usable count.
const count = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const n0 = v => count(v) ?? 0;

// A date, a number of milliseconds or a date string. A missing or unreadable one means now.
function toDate(value) {
  const d = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// DeepSeek peak: 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday. Chinese public holidays are off-peak
// for DeepSeek, but PRICES.md has no holiday list and says to use the peak rate unless the time is known to be
// off-peak, so a holiday inside those hours is still priced as peak.
function deepseekPeak(at) {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

// The rate for one request: { input, output, cached, label }, or null when the table has no rate for it.
function rateFor(entry, prompt, at) {
  if (!entry || entry.unpublished) return null;
  if (entry.maxPrompt && prompt > entry.maxPrompt) return null;
  if (entry.byPrompt) {
    const t = entry.byPrompt;
    return (t.from === 'atOrAbove' ? prompt >= t.limit : prompt > t.limit) ? t.high : t.low;
  }
  if (entry.peak) return deepseekPeak(at) ? entry.peak : entry.offPeak;
  if (entry.changes) {
    const iso = at.toISOString().slice(0, 10);
    let current = entry.rate;
    for (const change of entry.changes) if (iso >= change.from) current = change.rate;
    return current;
  }
  return entry.rate ?? null;
}

const refuse = reason => ({ dollars: null, rate: null, reason });

// One reported request, cleaned up. Null when it carries no tokens.
function cleanStep(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cached = n0(raw.cached);
  const input = Math.max(n0(raw.input), cached);
  const output = n0(raw.output);
  if (!input && !output) return null;
  const cacheWrite = Math.min(n0(raw.cacheWrite), input - cached);
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null;
  return { ...(at === null ? {} : { at }), input, cached, output, ...(cacheWrite ? { cacheWrite } : {}) };
}

const stepsOf = usage => {
  if (!usage || typeof usage !== 'object' || usage.reported === false) return [];
  const list = Array.isArray(usage.steps) && usage.steps.length ? usage.steps : [usage];
  return list.map(cleanStep).filter(Boolean);
};

const money = v => Math.round(v * 1e10) / 1e10;

// ---------- the cost of a reply ----------

// What a reply cost, from the published price. ref is "provider:model", usage is one usage record (or a stored reply's
// usage, which may carry the record of each request in steps), date is when the reply was made. Each request is priced
// on its own, because the tiers go by the prompt size of one request and the time-limited prices by its own time.
//
// Returns { dollars, rate, reason, estimated, checkedOn }. dollars is a number of dollars and rate is the rate used
// (dollars per million tokens: input, output, cached, and a label for the tier or window). rates lists every distinct
// rate when the requests did not all use the same one. When there is no amount, dollars and rate are null and reason
// says why: "plan use", "price not published" or "usage not reported".
export function priceUsage(ref, usage, date = new Date()) {
  const { provider } = splitRef(ref);
  if (PLAN_PROVIDERS.has(provider) || usage?.billing === 'plan') return refuse(PLAN_USE);
  const entry = Object.hasOwn(PRICES.models, ref) ? PRICES.models[ref] : null;
  if (!entry || entry.unpublished) return refuse(NOT_PUBLISHED);
  const steps = stepsOf(usage);
  if (!steps.length) return refuse(NOT_REPORTED);

  let dollars = 0;
  let writes = 0;
  const used = new Map();
  for (const step of steps) {
    const found = rateFor(entry, step.input, toDate(step.at ?? date));
    // One request with no published rate (an OpenAI prompt over 272K) leaves the whole reply without a price.
    if (!found) return refuse(NOT_PUBLISHED);
    dollars += ((step.input - step.cached) * found.input + step.cached * found.cached + step.output * found.output) / PRICES.perTokens;
    writes += step.cacheWrite ?? 0;
    used.set(JSON.stringify(found), { input: found.input, output: found.output, cached: found.cached, label: found.label });
  }
  const rates = [...used.values()];
  return {
    dollars: money(dollars),
    rate: rates[0],
    ...(rates.length > 1 ? { rates } : {}),
    reason: null,
    estimated: true,
    checkedOn: PRICES.checkedOn,
    // No cache-write price is published, so tokens written to a cache are counted at the plain input rate.
    ...(writes ? { note: 'Tokens written to a cache are counted at the input rate, because no cache-write price is published.' } : {}),
  };
}

// The usage to store on a reply. reports is every record the adapters sent for the turn (one per model request);
// billing is "api" (billed per token with a key) or "plan" (a subscription CLI); anything else means no model was
// called, and the result is null. partial marks a turn that was stopped, whose last request may have used tokens
// that were never reported.
//
// Result: { billing, reported, input, cached, output, requests, steps?, cost, partial? }. When nothing was reported
// there are no token fields, and reported is false: the page says "not reported" and nothing is estimated.
export function summarizeUsage(ref, reports, { billing, date = new Date(), partial = false } = {}) {
  if (billing !== 'api' && billing !== 'plan') return null;
  const steps = (Array.isArray(reports) ? reports : []).map(cleanStep).filter(Boolean).slice(-MAX_STEPS);
  const head = { billing, reported: steps.length > 0, ...(partial ? { partial: true } : {}) };
  if (!steps.length) return { ...head, cost: priceUsage(ref, { billing, reported: false }, date) };
  const sum = key => steps.reduce((total, s) => total + (s[key] ?? 0), 0);
  const writes = sum('cacheWrite');
  const usage = {
    ...head,
    input: sum('input'),
    cached: sum('cached'),
    output: sum('output'),
    requests: steps.length,
    ...(writes ? { cacheWrite: writes } : {}),
    // The record of each request is kept for API replies only: it is what the price tiers and time windows need.
    ...(billing === 'api' ? { steps } : {}),
  };
  return { ...usage, cost: priceUsage(ref, usage, date) };
}

// The running total for a project, worked out from its stored messages. Chat and review replies carry usage;
// council, build and relay replies do not, so they are not counted. The total covers the messages the transcript
// still holds (clearing or compacting the chat starts it again).
export function totalUsage(messages) {
  const bucket = () => ({ replies: 0, input: 0, cached: 0, output: 0, unreported: 0 });
  const api = { ...bucket(), dollars: 0, priced: 0, unpublished: 0 };
  const plan = bucket();
  const unpublishedModels = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    const u = m?.role === 'assistant' ? m.usage : null;
    if (!u || typeof u !== 'object' || (u.billing !== 'api' && u.billing !== 'plan')) continue;
    const side = u.billing === 'api' ? api : plan;
    side.replies++;
    if (!u.reported) {
      side.unreported++;
      continue;
    }
    side.input += n0(u.input);
    side.cached += n0(u.cached);
    side.output += n0(u.output);
    if (side !== api) continue;
    if (typeof u.cost?.dollars === 'number') {
      api.dollars += u.cost.dollars;
      api.priced++;
    } else {
      api.unpublished++;
      if (typeof m.model === 'string') unpublishedModels.add(m.model);
    }
  }
  api.dollars = money(api.dollars);
  return { replies: api.replies + plan.replies, api, plan, unpublishedModels: [...unpublishedModels].sort().slice(0, 8), checkedOn: PRICES.checkedOn };
}

// ---------- reading the token figures the providers send ----------

// Each reader takes the usage object a provider sent and returns { input, cached, output }, or null when it holds no
// token counts at all. They read defensively: a missing field counts as zero, a missing object as "not reported".

// Anthropic (the Messages API events, and the Claude CLI's result event). input_tokens leaves out the cached tokens, so
// the prompt is the sum of the three input counts. cacheWrite is kept apart because it has no published price.
export function tokensFromAnthropic(u) {
  if (!u || typeof u !== 'object') return null;
  const fresh = n0(u.input_tokens);
  const read = n0(u.cache_read_input_tokens);
  const write = n0(u.cache_creation_input_tokens);
  const output = n0(u.output_tokens);
  if (!fresh && !read && !write && !output) return null;
  return { input: fresh + read + write, cached: read, output, ...(write ? { cacheWrite: write } : {}) };
}

// OpenAI-compatible chat completions. prompt_tokens already includes the cached part, which is reported as
// prompt_tokens_details.cached_tokens (OpenAI, xAI, Google AI) or prompt_cache_hit_tokens (DeepSeek).
export function tokensFromChat(u) {
  if (!u || typeof u !== 'object') return null;
  const input = count(u.prompt_tokens ?? u.input_tokens);
  const output = count(u.completion_tokens ?? u.output_tokens);
  if (input === null && output === null) return null;
  const cached = count(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? u.input_tokens_details?.cached_tokens) ?? 0;
  return { input: input ?? 0, cached: Math.min(cached, input ?? 0), output: output ?? 0 };
}

// Gemini CLI result event: stats { input_tokens, output_tokens, cached, input }. input_tokens counts the cached part and
// input leaves it out. UNVERIFIED against a signed-in run (see the note at the top of lib/gemini.mjs).
export function tokensFromGemini(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const cached = n0(stats.cached);
  const input = count(stats.input_tokens) ?? (count(stats.input) === null ? null : stats.input + cached);
  const output = count(stats.output_tokens);
  if (input === null && output === null) return null;
  return { input: input ?? 0, cached: Math.min(cached, input ?? 0), output: output ?? 0 };
}

// Codex `exec --json` turn.completed event: usage { input_tokens, cached_input_tokens, output_tokens }. input_tokens
// counts the cached part. UNVERIFIED against a signed-in run.
export function tokensFromCodex(u) {
  if (!u || typeof u !== 'object') return null;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  if (input === null && output === null) return null;
  return { input: input ?? 0, cached: Math.min(n0(u.cached_input_tokens), input ?? 0), output: output ?? 0 };
}

// Sends one usage record to an adapter's onUsage callback. A broken callback must never break a reply.
export function reportUsage(onUsage, record) {
  if (typeof onUsage !== 'function' || !record) return;
  try {
    onUsage(record);
  } catch {
    // The reply matters more than its bookkeeping.
  }
}
