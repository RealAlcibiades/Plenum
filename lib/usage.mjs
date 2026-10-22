import os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { killTree, resolveLaunch, startChild, streamProcess } from './proc.mjs';
import { claudeCliUsage } from './claude-cli.mjs';

// Reads each provider's limits for the /usage command.
//   Muse Code: every reply carries the plan's usage; it shows up in the CLI's transport trace.
//   Codex:     the CLI's app server answers account/rateLimits/read.
//   Claude:    an API key has per-minute rate limits, returned as headers on any request.

// ---------- Muse Code ----------

const MUSE_FRESH_MS = 5 * 60 * 1000;
let museSeen = null;

// Extra environment for a Muse run: the trace is where the usage numbers appear.
export const MUSE_TRACE_ENV = { MUSE_TRANSPORT_TRACE: '1' };

// Takes one line of Muse stderr. Returns true for trace lines (so they stay out of error messages)
// and remembers the usage block when the line carries one.
export function noteMuseTrace(line) {
  if (!line.startsWith('REQUEST:') && !line.startsWith('SSE RESPONSE:')) return false;
  if (line.includes('response.subscription_usage')) {
    try {
      const sub = JSON.parse(line.match(/data: (\{.*\})\s*$/)[1]).subscription;
      museSeen = {
        observedAt: Date.now(),
        windows: [
          { name: windowName(sub.window.window_duration_mins), usedPercent: sub.window.used_percent, resetsAt: sub.window.resets_at * 1000 },
          { name: 'Weekly limit', usedPercent: sub.weekly.used_percent, resetsAt: sub.weekly.resets_at * 1000 },
        ],
      };
    } catch {
      // An unexpected shape: keep whatever was seen before.
    }
  }
  return true;
}

function windowName(minutes) {
  if (minutes === 10080) return 'Weekly limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

export const MUSE_NOT_SEEN = 'Not seen yet. Refresh to ask.';

// The numbers arrive with replies, so when none is recent this sends one very small request. With peek, nothing is started:
// the answer is what the last reply reported, or MUSE_NOT_SEEN (lib/quota.mjs reads it on every poll).
export async function museUsage({ installed, model, peek = false } = {}) {
  if (peek) return museSeen ?? { unavailable: MUSE_NOT_SEEN };
  if (!installed) return { unavailable: 'Muse Code is not installed or not signed in. Open Accounts.' };
  if (museSeen && Date.now() - museSeen.observedAt < MUSE_FRESH_MS) return museSeen;
  const before = museSeen;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const run = streamProcess({
      command: 'muse',
      args: ['exec', '--model', model, '--reasoning-effort', 'low', '--max-model-steps', '1', 'Reply with the single word ok.'],
      cwd: os.tmpdir(),
      signal: ac.signal,
      env: MUSE_TRACE_ENV,
      onStderrLine: noteMuseTrace,
    });
    for await (const _chunk of run) { /* the reply itself is not needed */ }
  } catch (err) {
    if (!museSeen) return { unavailable: `Muse Code did not report usage: ${String(err.message).split('\n')[0].slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
  if (museSeen && museSeen !== before) return museSeen;
  return museSeen ?? { unavailable: 'Muse Code did not report usage for this account. An API-key sign-in has no plan limits to show.' };
}

// The Muse Code reading the last reply left behind, without starting anything (lib/quota.mjs polls this).
export const peekMuse = () => museUsage({ peek: true });

// ---------- Codex ----------

function codexRpc(method, timeoutMs = 20_000) {
  return new Promise(async (resolve, reject) => {
    let launch;
    try {
      launch = await resolveLaunch('codex', ['app-server']);
    } catch (err) {
      return reject(err);
    }
    if (!launch) return reject(new Error('codex is not on PATH.'));
    const child = startChild('codex', launch, { stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (fn, value) => {
      clearTimeout(timer);
      killTree(child);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Codex did not answer in time.')), timeoutMs);
    const send = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.stdin.on('error', () => {});
    child.on('error', err => finish(reject, err));
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return finish(reject, new Error(msg.error.message));
          send({ method: 'initialized' });
          send({ id: 2, method });
        } else if (msg.id === 2) {
          if (msg.error) finish(reject, new Error(msg.error.message));
          else finish(resolve, msg.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'muse_console', title: 'Plenum', version: '1' } } });
  });
}

export async function codexUsage({ installed }) {
  if (!installed) return { unavailable: 'Codex is not installed. Open Accounts.' };
  try {
    const { rateLimits: r } = await codexRpc('account/rateLimits/read');
    if (!r) return { unavailable: 'Codex returned no limits for this account.' };
    const windows = [r.primary, r.secondary].filter(Boolean).map(w => ({
      name: windowName(w.windowDurationMins),
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt * 1000,
    }));
    const facts = [];
    if (r.credits?.unlimited) facts.push(['Credits', 'Unlimited']);
    else if (r.credits?.hasCredits) facts.push(['Credits', Number(r.credits.balance).toLocaleString('en-US', { maximumFractionDigits: 0 })]);
    if (r.rateLimitReachedType) facts.push(['Status', 'Limit reached']);
    return { observedAt: Date.now(), plan: r.planType ?? null, windows, facts };
  } catch (err) {
    return { unavailable: /auth|login|401/i.test(err.message) ? 'Codex is not signed in. Open Accounts.' : `Codex did not report usage: ${err.message.slice(0, 200)}` };
  }
}

// ---------- Claude ----------

// An API key has no plan allowance; what it has are per-minute limits for the model, read from the
// headers of one very small request.
async function claudeUsage({ cli, key, model }) {
  // Signed in through the Claude CLI: the plan's limits, as last reported during a reply.
  if (cli) return claudeCliUsage();
  if (!key) return { unavailable: 'No Claude key is saved. Open Accounts.' };
  try {
    const { response } = await new Anthropic({ apiKey: key }).messages
      .create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] })
      .withResponse();
    const h = name => response.headers.get(`anthropic-ratelimit-${name}`);
    const windows = [];
    for (const [kind, name] of [['requests', 'Requests per minute'], ['input-tokens', 'Input tokens per minute'], ['output-tokens', 'Output tokens per minute']]) {
      const limit = Number(h(`${kind}-limit`));
      const remaining = Number(h(`${kind}-remaining`));
      if (!limit || Number.isNaN(remaining)) continue;
      const reset = Date.parse(h(`${kind}-reset`) ?? '');
      windows.push({
        name,
        usedPercent: Math.round(((limit - remaining) / limit) * 100),
        resetsAt: Number.isNaN(reset) ? null : reset,
        detail: `${remaining.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} left`,
      });
    }
    if (!windows.length) return { unavailable: 'Anthropic did not return rate-limit headers for this key.' };
    return { observedAt: Date.now(), plan: `API key · ${model}`, windows, note: 'API keys are billed per token. These are rate limits, not a plan allowance.' };
  } catch (err) {
    if (err?.status === 401) return { unavailable: 'Anthropic rejected the saved key (401). Open Accounts.' };
    return { unavailable: `Claude did not report limits: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

// All three at once. Each entry is { observedAt, plan?, windows, facts?, note? } or { unavailable }.
export async function readUsage({ muse, codex, claude }) {
  const [museResult, codexResult, claudeResult] = await Promise.all([museUsage(muse), codexUsage(codex), claudeUsage(claude)]);
  return { muse: museResult, codex: codexResult, claude: claudeResult };
}
