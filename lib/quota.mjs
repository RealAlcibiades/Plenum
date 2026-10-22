// Plan use: how much of each subscription CLI's plan limit is used. It feeds the ring in the model picker, the Plan use pop-up
// and the limit banner (public/ext-quota.js), through GET /api/quota and POST /api/quota/refresh (lib/routes/quota.mjs).
//
// The rules that keep the meter from spending the quota it measures (UI-ARCH section 12, decision 24):
//   - A poll (readQuota) never sends a model request and never starts Muse Code or Claude Code. Codex is read from its app
//     server, which costs no model request, and that reading is kept for 10 minutes. Muse Code and Claude Code report what
//     their own last reply said. Gemini reports nothing, so it is unknown.
//   - A refresh that can send a request (Muse Code, Claude Code on the CLI route) runs at most once an hour when the person asks
//     (reason 'user'), and at most once every 15 minutes after a limit error (reason 'limit-error'). Each has its own budget.
//     Otherwise the last reading comes back with a note.
//   - Claude by API key has rate limits, not a plan allowance, so it has no reading and no ring.
//
// An entry is { provider, label, state, usedPercent, windows, observedAt, note }:
//   state        'ok' below 80 percent, 'warn' from 80, 'high' from 95, 'unknown' when no window is usable
//   usedPercent  the highest window's percentage (an integer), or null
//   windows      [{ name, usedPercent, resetsAt }], only the windows that passed usableWindows
//   observedAt   when the reading was taken (milliseconds), or null
//   note         one sentence for the person; for an unknown entry, the reason it is unknown

import { codexUsage, museUsage } from './usage.mjs';
import { claudeCliUsage, claudeRoute } from './claude-cli.mjs';
import { geminiUsage } from './gemini.mjs';
import { findExecutable } from './proc.mjs';

const MINUTE = 60_000;
const CODEX_CACHE_MS = 10 * MINUTE;
const USER_REFRESH_GAP_MS = 60 * MINUTE;
const LIMIT_REFRESH_GAP_MS = 15 * MINUTE;
const WARN_AT = 80;
const HIGH_AT = 95;
const MUSE_MODEL = 'muse-spark-1.2';
const API_NOTE = 'Claude by API key has rate limits, not a plan allowance.';
const NOTE_USER_LIMITED = 'Refreshed less than an hour ago.';
const NOTE_LIMIT_LIMITED = 'Refreshed less than 15 minutes ago.';
const NO_TEXT = 'Plan use was not reported.';
const FAILED = 'Plan use could not be read.';

export const QUOTA_PROVIDERS = ['codex', 'muse', 'anthropic', 'gemini'];
export const REFRESH_REASONS = ['user', 'limit-error'];

const badRequest = message => Object.assign(new Error(message), { status: 400 });

// The reader table. A future subscription CLI adds one row here:
//   label     the name the page shows
//   poll()    what the last reply or a free read reports; never sends a model request (may be missing for a row with cacheMs)
//   fresh()   a read that may send a request, or the free read for a row with cacheMs
//   sends     whether fresh() can cost plan quota
//   cacheMs   how long a free reading is kept (Codex)
//   route()   for a row with an API route: true when the subscription CLI is the route in use
//   apiNote   the note when route() is false
export function defaultReaders() {
  return {
    codex: {
      label: 'Codex',
      fresh: async () => codexUsage({ installed: Boolean(await findExecutable('codex')) }),
      sends: false,
      cacheMs: CODEX_CACHE_MS,
    },
    muse: {
      label: 'Muse Code',
      poll: () => museUsage({ peek: true }),
      fresh: async () => museUsage({ installed: Boolean(await findExecutable('muse')), model: MUSE_MODEL }),
      sends: true,
    },
    anthropic: {
      label: 'Claude',
      route: async () => (await claudeRoute()) === 'cli',
      apiNote: API_NOTE,
      poll: () => claudeCliUsage({ peek: true }),
      fresh: () => claudeCliUsage(),
      sends: true,
    },
    gemini: {
      label: 'Gemini',
      poll: () => geminiUsage(),
      fresh: () => geminiUsage(),
      sends: false,
    },
  };
}

export const stateOf = usedPercent => {
  if (usedPercent === null || usedPercent === undefined) return 'unknown';
  if (usedPercent >= HIGH_AT) return 'high';
  if (usedPercent >= WARN_AT) return 'warn';
  return 'ok';
};

// The windows a reading may show. A window is kept only when its usedPercent is a finite number from 0 to 100 (it is rounded);
// anything else ('85', 'abc', 140, a missing value) is dropped. resetsAt is kept when it is a finite number, else null.
export function usableWindows(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list) {
    if (!w || typeof w !== 'object') continue;
    const p = w.usedPercent;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) continue;
    const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null;
    const name = typeof w.name === 'string' && w.name.trim() ? w.name.trim().slice(0, 80) : 'Plan limit';
    out.push({ name, usedPercent: Math.round(p), resetsAt });
  }
  return out;
}

// The entry for one provider from its reading ({ observedAt, windows } or { unavailable }). limitNote, when given, is the note
// for a reading that was kept back by a refresh limit; for an unknown entry it is added after the reader's own text.
export function entryOf(provider, label, reading, limitNote) {
  const windows = usableWindows(reading?.windows);
  if (windows.length) {
    const usedPercent = Math.max(...windows.map(w => w.usedPercent));
    const observedAt = typeof reading.observedAt === 'number' && Number.isFinite(reading.observedAt) ? reading.observedAt : null;
    const own = typeof reading.note === 'string' ? reading.note : '';
    return { provider, label, state: stateOf(usedPercent), usedPercent, windows, observedAt, note: limitNote ?? own };
  }
  const text = typeof reading?.unavailable === 'string' && reading.unavailable.trim() ? reading.unavailable.trim() : NO_TEXT;
  return { provider, label, state: 'unknown', usedPercent: null, windows: [], observedAt: null, note: limitNote ? `${text} ${limitNote}` : text };
}

const apiEntry = (provider, label, note) => ({ provider, label, state: 'unknown', usedPercent: null, windows: [], observedAt: null, note });

// The quota state of the readers. now() is injectable, and so are the readers, so the tests can run without any CLI.
export function createQuota({ readers = defaultReaders(), now = () => Date.now() } = {}) {
  const cache = new Map(); // provider -> { reading, at }, for a row with cacheMs
  const lastUser = new Map(); // provider -> when the person last asked for a fresh reading that can send a request
  const lastLimit = new Map(); // provider -> when a limit error last asked for one

  // true when a row with an API route is on its API route (no plan allowance to read).
  async function offPlan(row) {
    return row.route ? !(await row.route()) : false;
  }

  async function cachedFresh(provider, row) {
    const hit = cache.get(provider);
    if (hit && now() - hit.at < row.cacheMs) return hit.reading;
    const reading = await row.fresh();
    cache.set(provider, { reading, at: now() });
    return reading;
  }

  // One provider's entry for a poll. It reports a failure as unknown, so one reader cannot take the others down.
  async function pollOne(provider) {
    const row = Object.hasOwn(readers, provider) ? readers[provider] : { label: provider, poll: () => ({ unavailable: FAILED }) };
    const label = row.label;
    try {
      if (await offPlan(row)) return apiEntry(provider, label, row.apiNote);
      const reading = row.cacheMs ? await cachedFresh(provider, row) : await row.poll();
      return entryOf(provider, label, reading);
    } catch {
      return apiEntry(provider, label, FAILED);
    }
  }

  return {
    // GET /api/quota: every provider's entry, from readings that cost nothing.
    async read() {
      const pairs = await Promise.all(QUOTA_PROVIDERS.map(async provider => [provider, await pollOne(provider)]));
      return { providers: Object.fromEntries(pairs), at: now() };
    },

    // POST /api/quota/refresh. A provider or reason that is not known is refused (400); the rest answers with the entry.
    async refresh(provider, reason) {
      if (!Object.hasOwn(readers, provider)) throw badRequest('Unknown provider.');
      if (!REFRESH_REASONS.includes(reason)) throw badRequest('Unknown reason.');
      const row = readers[provider];
      const label = row.label;
      try {
        if (await offPlan(row)) return apiEntry(provider, label, row.apiNote);
        if (!row.sends) {
          const reading = row.cacheMs ? await cachedFresh(provider, row) : await row.fresh();
          return entryOf(provider, label, reading);
        }
        const books = reason === 'user' ? lastUser : lastLimit;
        const gap = reason === 'user' ? USER_REFRESH_GAP_MS : LIMIT_REFRESH_GAP_MS;
        const last = books.get(provider);
        if (last !== undefined && now() - last < gap) {
          const reading = row.poll ? await row.poll() : undefined;
          return entryOf(provider, label, reading, reason === 'user' ? NOTE_USER_LIMITED : NOTE_LIMIT_LIMITED);
        }
        // The time is kept before the request, so a second refresh that starts meanwhile is held back too.
        books.set(provider, now());
        return entryOf(provider, label, await row.fresh());
      } catch {
        return apiEntry(provider, label, FAILED);
      }
    },
  };
}

const quota = createQuota();

export const readQuota = () => quota.read();
export const refreshQuota = (provider, reason) => quota.refresh(provider, reason);
