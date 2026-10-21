// What the model picker shows about each model: its price, its context window and whether it can use the project tools, and
// whether each provider can answer right now. Pure code: no network and no files. The prices are PRICES in lib/pricing.mjs
// (build\PRICES.md), the tool support is lib/api-providers.mjs, and the context windows are CONTEXT below.
import { PRICES } from './pricing.mjs';
import { API_PROVIDERS, apiProvider } from './api-providers.mjs';

// Context windows, in tokens, read on 2026-10-17 from the pages that lib/pricing.mjs lists as SOURCE:
// - platform.claude.com pricing: Claude 4.6 and later models, except Claude Haiku 5.5, include the full 1M token context window.
// - docs.x.ai pricing, Context column: grok-4.7 500K; grok-4.20-0309 reasoning and non-reasoning 1M.
// - api-docs.deepseek.com pricing, Model Details table: CONTEXT LENGTH 1M, one row that covers deepseek-flash and deepseek-v4-pro.
// - ai.google.dev pricing: Gemini 2.5 Flash supports a 1M token context window.
// No window is stated for Claude Haiku 5.5, for the OpenAI models, for the Mistral models or for the other Google models. The
// 272K and 200K figures on those pages are pricing breakpoints, not windows, so those models have no entry and the picker
// says the context is not published.
export const CONTEXT = {
  checkedOn: '2026-10-17',
  windows: {
    'anthropic:claude-opus-5-5': 1_000_000,
    'anthropic:claude-sonnet-5-5': 1_000_000,
    'anthropic:claude-fable-5-1': 1_000_000,
    'xai:grok-4.7': 500_000,
    'xai:grok-4.20-0309-reasoning': 1_000_000,
    'xai:grok-4.20-0309-non-reasoning': 1_000_000,
    'deepseek:deepseek-flash': 1_000_000,
    'deepseek:deepseek-v4-pro': 1_000_000,
    'gemini:gemini-2.5-flash': 1_000_000,
  },
};

// Subscription CLIs: their replies are billed to the user's plan, and their tools are their own.
const CLI_PROVIDERS = new Set(['muse', 'codex', 'gemini']);

// The day as UTC yyyy-mm-dd, the way lib/pricing.mjs compares its dated prices.
const dayOf = date => date.toISOString().slice(0, 10);

// The rate that applies now, following PRICES.md: the rate for the date, the peak rate where the price changes by time of
// day, and the lower prompt-size rate where the price has two tiers. Null when the table has no rate for the model.
function rateNow(entry, date) {
  if (!entry || entry.unpublished) return null;
  if (entry.rate) {
    let current = entry.rate;
    for (const change of entry.changes ?? []) if (dayOf(date) >= change.from) current = change.rate;
    return current;
  }
  if (entry.byPrompt) return entry.byPrompt.low;
  if (entry.peak) return entry.peak;
  return null;
}

// 'yes' when the project tools reach the model, 'cli' when the CLI runs its own tools, 'no' when the reply is text only.
function toolsFor(provider) {
  if (provider === 'anthropic') return 'yes';
  if (CLI_PROVIDERS.has(provider)) return 'cli';
  const api = apiProvider(provider);
  if (api) return api.toolsVerified ? 'yes' : 'no';
  return 'no';
}

// What the picker shows for one model ref ("provider:id"): { price, context, tools }. price is { input, output, cached, label }
// in dollars per million tokens, or null. context is a token count, or null when no window is documented. The date is the
// day the price is read for (today by default).
export function infoFor(ref, date = new Date()) {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  const provider = i < 0 ? text : text.slice(0, i);
  const rate = rateNow(Object.hasOwn(PRICES.models, text) ? PRICES.models[text] : null, date);
  const price = rate ? { input: rate.input, output: rate.output, cached: rate.cached, label: rate.label ?? null } : null;
  const context = Object.hasOwn(CONTEXT.windows, text) ? CONTEXT.windows[text] : null;
  return { price, context, tools: toolsFor(provider) };
}

const row = (label, ready, why) => ({ label, ready, why: ready ? '' : why });

// Whether each provider can answer now. status is what providerStatus() in lib/providers.mjs returns, and keys is a list of
// { id, configured } for the API providers (keyStatus in lib/keys.mjs). It is pure: it reads no key and no file. why is ''
// when the provider is ready, and label is the name the picker uses for it.
export function readinessFrom(status, keys) {
  const s = status ?? {};
  const saved = new Map((Array.isArray(keys) ? keys : []).map(k => [k?.id, k?.configured === true]));
  const gemini = s.gemini ?? {};
  const claude = s.anthropic ?? {};
  const out = {
    muse: row('Muse Code', Boolean(s.muse?.installed), 'Not installed'),
    codex: row('Codex', Boolean(s.codex?.installed), 'Not installed'),
    gemini: gemini.installed
      ? row('Gemini', gemini.signedIn !== false, 'Needs sign-in')
      : row('Gemini', false, 'Not installed'),
    anthropic: row('Claude', Boolean(claude.credentials), claude.route === 'cli' ? 'Needs sign-in' : 'Needs an API key'),
    echo: row('Test', true, ''),
  };
  for (const p of API_PROVIDERS) out[p.id] = row(p.label, saved.get(p.id) === true, 'Needs an API key');
  return out;
}
