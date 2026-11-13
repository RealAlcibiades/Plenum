import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from './proc.mjs';
import { runAcp } from './acp.mjs';
import { openSignIn } from './accounts.mjs';
import { acpAgentRun } from './grok.mjs';

// Antigravity through Google's Antigravity CLI (`agy`, installed with Google's installer; DECISIONS item 89). Google moved Google AI
// Pro and Ultra (and the free sign-in) from Gemini CLI to it on 18 June 2026, so it is how a Gemini subscription reaches Plenum.
// The transport is `agy acp`, the Agent Client Protocol over stdio (lib/acp.mjs), run by the same code as Grok Build
// (lib/grok.mjs acpAgentRun): Antigravity's permission requests become Plenum's approval cards, so Ask first works, and a read-only run
// (a council seat, a relay hop, a compare or pipeline step, plan mode) runs in an empty scratch folder and refuses every request.
// The session stays in Antigravity's Default mode ("Ask before edits and commands"); Plenum never selects its accept-edits or auto modes
// and never sends --dangerously-skip-permissions.
// Models: the session/new answer lists the models the signed-in account may use (models.availableModels). Plenum reads that list with a
// handshake that sends no prompt (it costs nothing), at most every 30 minutes, and lists each model as antigravity:<modelId>. A run on
// one of them selects it with session/set_model before the prompt. antigravity:default keeps the account's own default.
// Sign-in: `agy acp --login` in a terminal (Accounts). Antigravity keeps the sign-in itself; Plenum learns whether it is there only
// from the handshake ("Authentication required" means it is not). Its folder ~/.gemini is a credential folder for Plenum's tools.

export const AGY_HINT = 'Install the Antigravity CLI: on Windows run irm https://antigravity.google/cli/install.ps1 | iex in PowerShell; on macOS or Linux run curl -fsSL https://antigravity.google/cli/install.sh | bash. Then restart Plenum.';
const SIGN_IN = 'Antigravity is not signed in. Open Accounts and choose "Sign in to Antigravity".';
const LABEL = 'Antigravity';
const AUTH_REQUIRED = /authenticat|sign in|log ?in|unauthori[sz]ed/i;
export const FRESH_MS = 30 * 60_000;
export const RETRY_MS = 2 * 60_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_MODELS = 40;
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The CATALOG hook (lib/providers.mjs setAntigravityModels), set by providers.mjs so this file does not import it back.
let publish = () => 0;
export function onAntigravityModels(fn) {
  publish = typeof fn === 'function' ? fn : () => 0;
}

let last = { at: 0, ok: false, signedIn: null, tier: null, count: 0, error: null };
let inflight = null;

// ---------- status and sign-in ----------

// The Antigravity program on PATH, or null. The name it is started by is always `agy`.
export async function agyCommand() {
  return (await findExecutable('agy')) ? 'agy' : null;
}

// { installed, signedIn, email, tier } for Accounts and the model picker. signedIn is what the last model read found: true, false
// ("Authentication required"), or null before any read. tier is the plan name Antigravity reported (for example "Google AI Pro").
export async function antigravityStatus() {
  const installed = Boolean(await agyCommand());
  return { installed, signedIn: installed ? last.signedIn : null, email: null, tier: installed ? last.tier : null };
}

// Opens a terminal running `agy acp --login` (Antigravity opens the browser for the Google sign-in, then exits). Nothing is sent here.
// The next model read happens at once, so Accounts can show the result after Refresh.
export async function antigravitySignIn() {
  if (!(await agyCommand())) throw new Error(AGY_HINT);
  await openSignIn('agy', ['acp', '--login'], 'Sign in to Antigravity');
  last = { ...last, at: 0 };
}

// ---------- the account's models ----------

// session/new's models.availableModels to catalog entries { id, label }.
export function toEntries(available) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(available) ? available : []) {
    const id = isObject(m) ? m.modelId : null;
    if (typeof id !== 'string' || !MODEL_ID.test(id) || id.toLowerCase() === 'default' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: `${cleanName(m.name) || id} (Antigravity)` });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

// Reads the account's models again when the last read is stale (or force is set), with a handshake that sends no prompt, in an empty
// scratch folder. Resolves to the state, never throws. run replaces runAcp in the tests.
export function refreshAntigravityModels({ force = false, now = Date.now, run = runAcp } = {}) {
  if (inflight) return inflight;
  const age = now() - last.at;
  if (!force && last.at && age < (last.ok ? FRESH_MS : RETRY_MS)) return Promise.resolve(antigravityModelsState());
  inflight = (async () => {
    let scratch = null;
    try {
      if (!(await agyCommand())) throw new Error(AGY_HINT);
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-agy-'));
      const { session } = await run({ command: 'agy', args: ['acp'], cwd: scratch, prompt: '', label: LABEL, sessionOnly: true, handshakeMs: 20_000 });
      const entries = toEntries(session?.models?.availableModels);
      publish(entries);
      const tier = cleanName(session?._meta?.antigravity?.tier?.name) || null;
      last = { at: now(), ok: true, signedIn: true, tier, count: entries.length, error: null };
    } catch (err) {
      const message = String(err?.message ?? err).split('\n')[0].slice(0, 200);
      const signedIn = AUTH_REQUIRED.test(message) ? false : last.signedIn;
      if (signedIn === false) publish([]);
      last = { at: now(), ok: false, signedIn, tier: signedIn === false ? null : last.tier, count: signedIn === false ? 0 : last.count, error: message };
    } finally {
      if (scratch) await removeScratch(scratch);
      inflight = null;
    }
    return antigravityModelsState();
  })();
  return inflight;
}

// Waits for a read for at most waitMs, so the first menu can include the list without a slow start holding it up.
export async function antigravityModelsWithin(waitMs, opts) {
  const run = refreshAntigravityModels(opts);
  let timer;
  await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  return antigravityModelsState();
}

export const antigravityModelsState = () => ({ ...last, reading: !!inflight });

// For tests: forget the last read and take the listed models out of the catalog.
export function resetAntigravityModels() {
  last = { at: 0, ok: false, signedIn: null, tier: null, count: 0, error: null };
  inflight = null;
  publish([]);
}

// ---------- running ----------

// Chooses the run's model once the session exists. antigravity:default keeps the account's default. Any other id must be one the
// session offers: session/set_model selects it; an agent that refuses that method gets session/set_config_option for its model option.
export function modelChooser(id) {
  return async ({ request, sessionId, created }) => {
    if (!id || id === 'default') return;
    const offered = Array.isArray(created?.models?.availableModels) ? created.models.availableModels.map(m => m?.modelId).filter(Boolean) : [];
    if (offered.length && !offered.includes(id)) {
      throw new Error(`${id} is not offered to this Antigravity account right now. It offers: ${offered.join(', ')}.`);
    }
    try {
      await request('session/set_model', { sessionId, modelId: id });
    } catch (err) {
      const option = Array.isArray(created?.configOptions) ? created.configOptions.find(o => o?.id === 'model') : null;
      const value = option?.options?.find(o => o?.value === id)?.value;
      if (!value) throw err;
      await request('session/set_config_option', { sessionId, configId: 'model', value });
    }
  };
}

// Runs one Antigravity turn and yields its reply text. prompt is the whole prompt (lib/providers.mjs promptText). ctx (optional) is the
// tool context of the run: its approve, root, denyPatterns, mode and scope are used. emit (optional) receives the step events.
export async function* streamAntigravity({ id = 'default', prompt, cwd, signal, ctx, mode = 'ask', readOnly = false, emit, mcp = null, onActivity } = {}) {
  const tell = ev => {
    try {
      (emit ?? ctx?.emit)?.(ev);
    } catch {
      // A broken hook must not break the reply.
    }
  };
  if (signal?.aborted) return;
  if (!String(prompt ?? '').trim()) throw new Error('There is nothing to send to Antigravity.');
  const name = await agyCommand();
  if (!name) throw new Error(AGY_HINT);
  if (signal?.aborted) return;
  // A read-only run starts in an empty folder of its own, never the project, and is judged as ask.
  const scratch = readOnly ? await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-readonly-')) : null;
  try {
    yield* acpAgentRun({
      name, cwd: scratch ?? cwd, prompt, signal, ctx: readOnly ? null : ctx, mode: readOnly ? 'ask' : mode, readOnly, tell,
      mcp: readOnly ? null : mcp, onActivity, label: LABEL, acpArgs: ['acp'], signIn: SIGN_IN, acpOptions: { afterSession: modelChooser(id) },
    });
  } finally {
    if (scratch) await removeScratch(scratch);
  }
}

// Removes a scratch folder. Windows refuses while the agent still has it as its working folder, so a refused removal is tried again for
// a moment; the run has already ended the agent (lib/acp.mjs waits for it).
async function removeScratch(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
