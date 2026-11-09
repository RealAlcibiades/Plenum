// Auto-compact limits, one per model (DECISIONS item 86). The owner asked for "an adjuster dial for the autocompaction limit for each model".
// A limit is a whole percent from 20 to 95, or 'off'. A model with no limit keeps what it did before: Plenum never compacts its chats on
// its own, and Claude Code and Codex compact their own sessions at their own defaults.
//
// A limit does two things:
// 1. Plenum compacts a chat thread by itself. Before a chat message goes to a model, Plenum estimates how much of the room that model gets
//    the thread already fills. At the limit or above, the model first writes a summary that replaces the thread (as /compact does), and the
//    message then goes on with the summary. The room is what Plenum sends: a CLI on a transcript gets at most MAX_PROMPT characters in one
//    prompt (lib/providers.mjs promptText drops older turns beyond it), and an API model gets its context window. A CLI that keeps its own
//    native session (Claude Code and Codex in Native session mode) is left to compact its session itself.
// 2. Claude Code and Codex are told the limit for their own auto-compaction, which also runs inside one long turn (an agent with many tool
//    steps): Claude Code through CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (a percent of its window), or DISABLE_AUTO_COMPACT=1 for 'off'; Codex through
//    -c model_auto_compact_token_limit=<tokens>, the percent of the model's window (the fallback window when none is published). Codex has no
//    switch that turns its compaction off, so 'off' leaves Codex at its own default. Both names were read from the installed CLIs on
//    9 Nov 2026 (claude.exe 2.1.x and codex.exe), not guessed. The other CLIs (Muse Code, Gemini CLI, Cursor, Grok Build) take no such
//    setting from Plenum, so for them only (1) applies.
//
// The limits live in the state file as compactAt: { "<provider:id>": 80 | 'off' }. Nothing here is a secret.
import { CONTEXT } from './model-info.mjs';
import { get as stateNow } from './store.mjs';

export const COMPACT_RANGE = Object.freeze({ min: 20, max: 95, step: 5 });
// The window assumed for a model whose window is not published (lib/model-info.mjs CONTEXT lists the published ones).
export const FALLBACK_WINDOW = 200_000;
// lib/providers.mjs MAX_PROMPT: the most characters one CLI prompt carries, the system text included.
export const CLI_PROMPT_CHARS = 150_000;
// Characters per token, for the estimate. Code and prose average about four.
const CHARS_PER_TOKEN = 4;
const MAX_MODELS = 200;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const providerOf = ref => String(ref ?? '').split(':')[0];

// One saved value: a whole percent in COMPACT_RANGE (a number or its text), or 'off'. Throws a plain Error for anything else.
export function compactValue(v) {
  if (v === 'off') return 'off';
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < COMPACT_RANGE.min || n > COMPACT_RANGE.max) {
    throw new Error(`An auto-compact limit is a whole percent from ${COMPACT_RANGE.min} to ${COMPACT_RANGE.max}, or off.`);
  }
  return n;
}

// The saved limits with one change applied: { ref, value } where value is a limit, or null (or 'default') to take the model's limit off.
// checkRef turns the given model name into its ref, or throws (lib/providers.mjs parseRef). Returns a new object.
export function withLimit(saved, { ref, value }, checkRef) {
  const key = checkRef(ref);
  const out = cleanLimits(saved);
  if (value === null || value === undefined || value === '' || value === 'default') {
    delete out[key];
    return out;
  }
  out[key] = compactValue(value);
  if (Object.keys(out).length > MAX_MODELS) throw new Error(`At most ${MAX_MODELS} models can have an auto-compact limit.`);
  return out;
}

// The saved limits that are still valid. A value that no longer passes (an edited state file) is dropped, never read as a limit.
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

// The limit of one model: a percent, 'off', or null when it has none.
export function limitOf(ref, st = stateNow()) {
  const v = st?.compactAt?.[ref];
  if (v === undefined) return null;
  try {
    return compactValue(v);
  } catch {
    return null;
  }
}

// The model's context window in tokens, and whether it is published (else FALLBACK_WINDOW is assumed).
export function windowOf(ref) {
  const tokens = Object.hasOwn(CONTEXT.windows, ref) ? CONTEXT.windows[ref] : null;
  return tokens ? { tokens, published: true } : { tokens: FALLBACK_WINDOW, published: false };
}

// What Claude Code is told, as environment variables for its process: {} when the model has no limit.
export function claudeCompactEnv(ref, st = stateNow()) {
  const v = limitOf(ref, st);
  if (v === 'off') return { DISABLE_AUTO_COMPACT: '1' };
  if (typeof v === 'number') return { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(v) };
  return {};
}

// The token count Codex compacts at, or null when it is not told one.
export function codexCompactTokens(ref, st = stateNow()) {
  const v = limitOf(ref, st);
  if (typeof v !== 'number') return null;
  return Math.floor((windowOf(ref).tokens * v) / 100);
}

// The -c override Codex is given (a whole number, so it needs no quoting on a command line), or [].
export function codexCompactArgs(ref, st = stateNow()) {
  const n = codexCompactTokens(ref, st);
  return n ? ['-c', `model_auto_compact_token_limit=${n}`] : [];
}

// The room a chat turn of this model has, in tokens, and what it is. cli is true when the turn goes to a CLI as one prompt (every CLI
// provider, and Claude through its CLI); native is true when that CLI keeps its own session for this turn.
export function roomOf(ref, { cli, native = false }) {
  if (cli && native) return { tokens: windowOf(ref).tokens, kind: 'session' };
  if (cli) return { tokens: Math.floor(CLI_PROMPT_CHARS / CHARS_PER_TOKEN), kind: 'prompt' };
  const w = windowOf(ref);
  return { tokens: w.tokens, kind: w.published ? 'window' : 'assumed' };
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
// system text. Returns { due, limit, used, room, pct }: due is false when the model has no limit, the limit is off, the CLI keeps its own
// session, or the thread is below the limit. pct is the share of the room the thread fills, rounded.
export function compactDue({ ref, log, extraChars = 0, cli, native = false, st = stateNow() }) {
  const limit = limitOf(ref, st);
  const room = roomOf(ref, { cli, native });
  const used = estimateTokens(log, extraChars);
  const pct = room.tokens ? Math.round((used / room.tokens) * 100) : 0;
  const chats = (Array.isArray(log) ? log : []).filter(m => m?.kind === 'chat').length;
  const due = typeof limit === 'number' && room.kind !== 'session' && chats >= 2 && used >= (room.tokens * limit) / 100;
  return { due, limit, used, room, pct };
}

// Whether the provider's CLI is told the limit itself, and how: 'claude', 'codex' or null.
export function cliKnob(ref) {
  const p = providerOf(ref);
  return p === 'anthropic' ? 'claude' : p === 'codex' ? 'codex' : null;
}
