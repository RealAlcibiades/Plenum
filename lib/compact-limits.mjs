// Auto-compact limits, one per model (DECISIONS item 86). The owner asked for "an adjuster dial for the autocompaction limit for each model",
// and then for the dial to be "in tokens not %". A limit is a whole number of tokens, at least COMPACT_RANGE.min and at most the model's
// context window (UNPUBLISHED_MAX for a model whose window is not published), or 'off'. A model with no limit keeps what it did before:
// Plenum never compacts its chats on its own, and Claude Code and Codex compact their own sessions at their own defaults.
//
// A limit does two things:
// 1. Plenum compacts a chat thread by itself. Before a chat message goes to a model, Plenum estimates how many tokens the thread holds (about
//    four characters a token). At the limit or above, the model first writes a summary that replaces the thread (as /compact does), and the
//    message then goes on with the summary. A CLI that keeps its own native session (Claude Code and Codex in Native session mode) is left
//    to compact its session itself. A CLI on a transcript is sent at most MAX_PROMPT characters in one prompt (lib/providers.mjs promptText
//    drops the oldest turns beyond it), so a limit above that lets the oldest messages drop out of the prompt until the thread is compacted.
// 2. Claude Code and Codex are told the limit for their own auto-compaction, which also runs inside one long turn (an agent with many tool
//    steps). Codex takes the tokens as they are: -c model_auto_compact_token_limit=<tokens>. Claude Code compacts at its auto-compact window
//    minus 13,000 tokens, or at CLAUDE_AUTOCOMPACT_PCT_OVERRIDE percent of that window when that is lower; the window it takes from
//    CLAUDE_CODE_AUTO_COMPACT_WINDOW is a whole number of tokens from 100,000 to 1,000,000, and never more than the model's own window. So a
//    limit of 87,000 tokens or more is told as the window limit + 13,000, and a smaller one as the 100,000 window and the share of it that is
//    the limit. 'off' sets DISABLE_AUTO_COMPACT=1. Codex has no switch that turns its compaction off, so 'off' leaves Codex at its default.
//    All of this was read from the installed CLIs on 9 Nov 2026 (claude.exe 2.1.x and codex.exe), not guessed. The other CLIs (Muse Code,
//    Gemini CLI, Cursor, Grok Build) take no such setting from Plenum, so for them only (1) applies.
//
// The limits live in the state file as compactAt: { "<provider:id>": 120000 | 'off' }. The first version of the dial saved percents (20 to
// 95); those are below COMPACT_RANGE.min, so they are dropped as invalid and the model is back on its default. Nothing here is a secret.
import { CONTEXT } from './model-info.mjs';
import { get as stateNow } from './store.mjs';

export const COMPACT_RANGE = Object.freeze({ min: 10_000, step: 1_000 });
// The top of the dial for a model whose window is not published (lib/model-info.mjs CONTEXT lists the published ones).
export const UNPUBLISHED_MAX = 1_000_000;
// The most a saved value can be at all, whatever the model: anything larger in the state file is dropped.
const MAX_TOKENS = 10_000_000;
// lib/providers.mjs MAX_PROMPT: the most characters one CLI prompt carries, the system text included.
export const CLI_PROMPT_CHARS = 150_000;
// Characters per token, for the estimate. Code and prose average about four.
const CHARS_PER_TOKEN = 4;
const MAX_MODELS = 200;
// Claude Code (claude.exe 2.1.x): the tokens it keeps free below its auto-compact window, and the window's bounds.
export const CLAUDE_BUFFER = 13_000;
const CLAUDE_MIN_WINDOW = 100_000;
const CLAUDE_MAX_WINDOW = 1_000_000;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const providerOf = ref => String(ref ?? '').split(':')[0];
const thousands = n => n.toLocaleString('en-US');

// 37_500 -> "38K", 1_000_000 -> "1M", 1_250_000 -> "1.3M".
export function tokenText(n) {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// A number of tokens as a person or a client may give it: 120000, "120000", "120,000", "120k" or "1.2m". NaN when it is none of those.
function parseTokens(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(v.replace(/[,_]/g, ''));
  if (!m) return NaN;
  const scale = { '': 1, k: 1000, m: 1_000_000 }[m[2].toLowerCase()];
  // A fraction of a token is not a limit; "1.5k" is 1,500 tokens.
  if (scale === 1 && m[1].includes('.')) return NaN;
  return Math.round(Number(m[1]) * scale);
}

// The top of the dial for this model: its published context window, or UNPUBLISHED_MAX.
export function maxOf(ref) {
  const w = windowOf(ref);
  return w.published ? w.tokens : UNPUBLISHED_MAX;
}

// Where Limit starts for a model that had no limit: 80% of its window, in whole thousands. With no published window the dial still goes to
// UNPUBLISHED_MAX, but the start assumes the common 200K window (Claude Haiku 5.5, for one, has none published here), so a model with a
// smaller window than the dial's top is not handed a limit it can never reach.
const ASSUMED_WINDOW = 200_000;
export function suggestedOf(ref) {
  const w = windowOf(ref);
  const base = w.published ? w.tokens : ASSUMED_WINDOW;
  return Math.max(COMPACT_RANGE.min, Math.round((base * 0.8) / COMPACT_RANGE.step) * COMPACT_RANGE.step);
}

// One saved value: a whole number of tokens from COMPACT_RANGE.min to max, or 'off'. Throws a plain Error for anything else.
export function compactValue(v, max = MAX_TOKENS) {
  if (v === 'off') return 'off';
  const n = parseTokens(v);
  if (!Number.isInteger(n) || n < COMPACT_RANGE.min || n > max) {
    throw new Error(`An auto-compact limit is a whole number of tokens from ${thousands(COMPACT_RANGE.min)} to ${thousands(max)}, or off.`);
  }
  return n;
}

// The saved limits with one change applied: { ref, value } where value is a limit, or null (or 'default') to take the model's limit off.
// A limit may not be more than the model's window. checkRef turns the given model name into its ref, or throws (lib/providers.mjs
// parseRef). Returns a new object.
export function withLimit(saved, { ref, value }, checkRef) {
  const key = checkRef(ref);
  const out = cleanLimits(saved);
  if (value === null || value === undefined || value === '' || value === 'default') {
    delete out[key];
    return out;
  }
  out[key] = compactValue(value, maxOf(key));
  if (Object.keys(out).length > MAX_MODELS) throw new Error(`At most ${MAX_MODELS} models can have an auto-compact limit.`);
  return out;
}

// The saved limits that are still valid. A value that no longer passes (an edited state file, or a percent saved by the first version of
// the dial) is dropped, never read as a limit.
export function cleanLimits(saved) {
  const out = {};
  if (!isObject(saved)) return out;
  for (const [ref, v] of Object.entries(saved)) {
    if (!ref.includes(':')) continue;
    try {
      out[ref] = compactValue(v);
    } catch {
      // Dropped.
    }
  }
  return out;
}

// The limit of one model: tokens, 'off', or null when it has none. A saved limit above the model's window (its published window changed
// since) is read as the window.
export function limitOf(ref, st = stateNow()) {
  const v = st?.compactAt?.[ref];
  if (v === undefined) return null;
  try {
    const n = compactValue(v);
    return typeof n === 'number' ? Math.min(n, maxOf(ref)) : n;
  } catch {
    return null;
  }
}

// The model's context window in tokens, and whether it is published.
export function windowOf(ref) {
  const tokens = Object.hasOwn(CONTEXT.windows, ref) ? CONTEXT.windows[ref] : null;
  return tokens ? { tokens, published: true } : { tokens: UNPUBLISHED_MAX, published: false };
}

// What Claude Code is told, as environment variables for its process: {} when the model has no limit. With a limit, the variables it does
// not need are set empty, so a value inherited from the person's own environment cannot change what the limit means (Claude Code reads an
// empty value as unset).
export function claudeCompactEnv(ref, st = stateNow()) {
  const v = limitOf(ref, st);
  if (v === 'off') return { DISABLE_AUTO_COMPACT: '1' };
  if (typeof v !== 'number') return {};
  if (v + CLAUDE_BUFFER >= CLAUDE_MIN_WINDOW) {
    return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.min(v + CLAUDE_BUFFER, CLAUDE_MAX_WINDOW)), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '', DISABLE_AUTO_COMPACT: '' };
  }
  // Below the smallest window Claude Code takes: that window, and the share of it that is the limit. Claude Code rounds window x share
  // down, so the share carries half a token more: 10,008 tokens is 10.0085%, which it reads as 10,008 (10.008% would read as 10,007.99...).
  const pct = ((v + 0.5) * 100) / CLAUDE_MIN_WINDOW;
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_MIN_WINDOW), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct), DISABLE_AUTO_COMPACT: '' };
}

// The -c override Codex is given (a whole number, so it needs no quoting on a command line), or [].
export function codexCompactArgs(ref, st = stateNow()) {
  const v = limitOf(ref, st);
  return typeof v === 'number' ? ['-c', `model_auto_compact_token_limit=${v}`] : [];
}

// What a chat turn of this model is sent, in tokens, and what it is. cli is true when the turn goes to a CLI as one prompt (every CLI
// provider, and Claude through its CLI); native is true when that CLI keeps its own session for this turn.
//   session: the CLI keeps its own session, so Plenum does not compact the thread;
//   prompt:  one prompt of at most CLI_PROMPT_CHARS;
//   window / unpublished: the model's context window, published or not.
export function roomOf(ref, { cli, native = false }) {
  const w = windowOf(ref);
  if (cli && native) return { tokens: w.tokens, kind: 'session' };
  if (cli) return { tokens: Math.floor(CLI_PROMPT_CHARS / CHARS_PER_TOKEN), kind: 'prompt' };
  return { tokens: w.tokens, kind: w.published ? 'window' : 'unpublished' };
}

// About how many tokens the chat messages of a thread hold. A reply that keeps its tool turns (api) counts those, not its text.
export function estimateTokens(log, extraChars = 0) {
  let chars = extraChars;
  for (const m of Array.isArray(log) ? log : []) {
    if (!m || m.kind !== 'chat') continue;
    if (Array.isArray(m.api) && m.api.length) {
      try {
        chars += JSON.stringify(m.api).length;
        continue;
      } catch {
        // Counted by its text instead.
      }
    }
    chars += String(m.content ?? '').length;
    for (const t of Array.isArray(m.tools) ? m.tools : []) chars += String(t?.summary ?? '').length + 20;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// Whether a chat turn should compact the thread first. log is the thread before the new message; extraChars is the new message and the
// system text. Returns { due, limit, used, room }: due is false when the model has no limit, the limit is off, the CLI keeps its own
// session, the thread has fewer than two chat messages, or it holds fewer tokens than the limit.
export function compactDue({ ref, log, extraChars = 0, cli, native = false, st = stateNow() }) {
  const limit = limitOf(ref, st);
  const room = roomOf(ref, { cli, native });
  const used = estimateTokens(log, extraChars);
  const chats = (Array.isArray(log) ? log : []).filter(m => m?.kind === 'chat').length;
  const due = typeof limit === 'number' && room.kind !== 'session' && chats >= 2 && used >= limit;
  return { due, limit, used, room };
}

// Whether the provider's CLI is told the limit itself, and how: 'claude', 'codex' or null.
export function cliKnob(ref) {
  const p = providerOf(ref);
  return p === 'anthropic' ? 'claude' : p === 'codex' ? 'codex' : null;
}
