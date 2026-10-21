import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, streamProcess } from './proc.mjs';
import { installHint } from './platform/index.mjs';
import { openSignIn } from './accounts.mjs';
import { goneError, looksGone } from './sessions.mjs';
import { argsFor } from './cli-options/gemini.mjs';
import { reportUsage, tokensFromGemini } from './pricing.mjs';
import { IMAGE_REFUSAL } from './images.mjs';
import { pdfRefusal } from './attachments.mjs';

// Gemini through the Gemini CLI (`gemini`), signed in with a Google account. No key is passed to it: childEnv in
// lib/proc.mjs removes GEMINI_API_KEY, GOOGLE_API_KEY and the Vertex and Code Assist switches from every child, so a run always uses the sign-in.
// The CLI runs headless with `-o stream-json`: one JSON object per stdout line, each with a timestamp
// (not used here). The shapes come from the 0.63 bundle (StreamJsonFormatter and the non-interactive
// runner), not from a signed-in run, so every field is read defensively:
//   init         { session_id, model }
//   message      { role: 'user'|'assistant', content, delta?: true }   (the first one echoes the prompt back)
//   tool_use     { tool_name, tool_id, parameters }
//   tool_result  { tool_id, status: 'success'|'error', output?, error?: { type, message } }
//   error        { severity: 'warning'|'error', message }             (not fatal: the run goes on)
//   result       { status: 'success'|'error', error?: { type, message }, stats }
//                stats { input_tokens, output_tokens, cached, input, ... } holds the run's token counts, which are reported
//                through onUsage as plan use. A run whose result carries no counts reports nothing ("not reported").
// A fatal error during the run arrives as a result with status 'error'. A sign-in failure before the run
// starts is not a stream event: the CLI writes to stderr and exits with code 41, which streamProcess reports.
// Unknown events and lines are skipped, never a crash.

export const GEMINI_HINT = `Install the Gemini CLI: ${installHint('@google/gemini-cli')}`;
const SIGN_IN = 'Gemini is not signed in. Open Accounts and choose "Sign in with Gemini".';
// The prompt goes on stdin. The CLI puts the -p text after the stdin text, so this only has to point back at it.
// It has no characters cmd.exe would treat specially when the CLI is a .cmd shim.
const INSTRUCTION = 'Reply to the request above, doing what it asks.';
// Words that mean "sign in" in an error. Exit code 41 is the CLI's own authentication failure code.
// 'authenticat' also matches FatalAuthenticationError, the error type the CLI puts in a result event.
const AUTH_ERROR = /auth method|\bsign[ -]?in\b|\blog[ -]?in\b|authenticat|exited with code 41\b/i;
// Stderr lines the CLI writes on every healthy run; they would only clutter an error message.
const STDERR_NOISE = /^\s*$|^Loaded cached credentials|YOLO mode is enabled|DeprecationWarning|ExperimentalWarning|--trace-(deprecation|warnings)/i;
const MAX_LINE = 8 * 1024 * 1024;
const TOOL_KEYS = ['command', 'file_path', 'absolute_path', 'dir_path', 'path', 'pattern', 'query', 'url'];

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------- reading the stream ----------

// Text out of a message's content: normally a string, but accept parts like [{ text }] too.
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return typeof content?.text === 'string' ? content.text : '';
}

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return [err.type, err.message].filter(s => typeof s === 'string' && s).join(': ');
}

function summarize(params) {
  if (params && typeof params === 'object') {
    for (const key of TOOL_KEYS) if (typeof params[key] === 'string' && params[key]) return clip(params[key], 200);
  }
  try {
    return clip(JSON.stringify(params ?? {}), 200);
  } catch {
    return '';
  }
}

// mode: 'plan' is a read-only run. 'auto' lets Gemini auto-approve edits, and anything else asks before acting.
// The approval flag comes from argsFor in lib/cli-options/gemini.mjs (its ceiling follows mode, and the approve-all
// mode is never sent), so a headless run only gets what that flag allows.
// tools (optional) is effectiveSettings(appState, project).tools; tools.gemini holds the Gemini options.
// There is no effort setting: the Gemini CLI has no flag for reasoning effort, so `effort` is not taken
// and no effort flag is passed.
// emit (optional) receives { type: 'tool', id, name, summary } and { type: 'tool_result', id, ok, summary },
// the same shapes the chat stream uses, so a caller can show Gemini's steps.
// sessionId (native mode): the first turn starts that session with --session-id; resume (true after that)
// continues it with --resume. Only a session the CLI no longer has is reported as sessionGone.
// onUsage (optional) gets { at, input, cached, output } once, from the result event's stats, when it carries token counts.
// images and PDFs (documents) are not sent to Gemini in Plenum yet: a call that arrives with any is refused before the CLI is
// started. Text files are in the prompt already.
export async function* streamGemini({ id, prompt, cwd, signal, mode = 'ask', emit, sessionId, resume = false, tools, onUsage, images, documents }) {
  if (images?.length) throw new Error(IMAGE_REFUSAL);
  if (documents?.length) throw new Error(pdfRefusal(documents.length === 1 ? documents[0].name : ''));
  const model = String(id ?? 'default');
  // The id lands on a command line (through cmd.exe for the .cmd shim), so only plain model ids pass.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new Error(`"${model}" is not a Gemini model id.`);
  if (!String(prompt ?? '').trim()) throw new Error('There is nothing to send to Gemini.');
  if (signal?.aborted) return;
  const args = ['-p', INSTRUCTION, '-o', 'stream-json'];
  if (model !== 'default') args.push('-m', model);
  args.push('--skip-trust', ...argsFor(tools?.gemini, { mode }));
  if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);

  // Our own copy of stderr, minus the noise, to judge a run that ends without a reply.
  let stderrSeen = '';
  const onStderrLine = line => {
    if (STDERR_NOISE.test(line)) return true;
    stderrSeen = (stderrSeen + line).slice(-4000);
    return false;
  };
  const tell = event => {
    try {
      emit?.(event);
    } catch {
      // A broken hook must not break the reply.
    }
  };

  let buffer = '';
  let stray = '';        // stdout lines that were not JSON, for the error message if nothing else came
  let wrote = '';        // all text yielded
  let segment = '';      // text yielded since the last tool call
  let gap = false;       // a tool call came between two pieces of text
  let sawTool = false;
  let result = null;     // the result event
  let warned = '';       // the last error event
  const calls = new Map();

  // What to yield for a piece of assistant text, or '' for nothing.
  const take = (text, delta) => {
    let piece = text;
    // A whole message after its streamed pieces would print twice.
    if (!delta && segment) {
      if (piece === segment || segment.endsWith(piece)) piece = '';
      else if (piece.startsWith(segment)) piece = piece.slice(segment.length);
    }
    if (!piece) return '';
    let out = piece;
    // Text after a tool call starts a new paragraph, so it does not run into the text before the call.
    if (gap && wrote && !/^\s/.test(piece) && !wrote.endsWith('\n\n')) out = (wrote.endsWith('\n') ? '\n' : '\n\n') + out;
    gap = false;
    wrote += out;
    segment += piece;
    return out;
  };

  const handle = line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      stray = (stray + trimmed + '\n').slice(-1500);
      return '';
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return '';
    switch (event.type) {
      case 'message': {
        // The CLI echoes the prompt back as a user message. Only the model's own text is the reply.
        if (['user', 'system', 'tool'].includes(event.role)) return '';
        return take(textOf(event.content), event.delta === true);
      }
      case 'tool_use': {
        sawTool = true;
        gap = true;
        segment = '';
        const name = String(event.tool_name ?? event.name ?? 'tool');
        const callId = String(event.tool_id ?? event.id ?? `call-${calls.size + 1}`);
        calls.set(callId, name);
        tell({ type: 'tool', id: callId, name, summary: summarize(event.parameters ?? event.args) });
        return '';
      }
      case 'tool_result': {
        const callId = String(event.tool_id ?? event.id ?? '');
        const failed = event.status === 'error' || !!event.error;
        const detail = failed ? errorText(event.error) || textOf(event.output) : textOf(event.output);
        tell({ type: 'tool_result', id: callId, ok: !failed, summary: clip(detail.trim(), 300) });
        return '';
      }
      case 'error': {
        // Warnings and non-fatal errors (a loop stopped, a quota hit on one call): note them, carry on.
        warned = textOf(event.message) || errorText(event.error) || warned;
        return '';
      }
      case 'result': {
        result = event;
        return '';
      }
      default:
        return ''; // init and anything newer
    }
  };

  // After an abort nothing more is yielded, even lines that were already buffered.
  try {
    for await (const chunk of streamProcess({ command: 'gemini', args, cwd, signal, input: prompt, hint: GEMINI_HINT, onStderrLine })) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const out = handle(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (out && !signal?.aborted) yield out;
      }
      if (buffer.length > MAX_LINE) buffer = '';
    }
    const last = handle(buffer);
    if (last && !signal?.aborted) yield last;
  } catch (err) {
    if (signal?.aborted) return;
    // Exit code 41 (or the CLI's "set an Auth method" text on stderr) with nothing on stdout surfaces here.
    if (!wrote.trim() && AUTH_ERROR.test(String(err?.message ?? ''))) throw new Error(SIGN_IN);
    if (resume && !wrote.trim() && looksGone(err?.message)) throw goneError('Gemini has no saved session with that id.');
    throw err;
  }
  if (signal?.aborted) return;

  // The result event is the only place the CLI reports tokens. They are plan use: shown as counts, never priced.
  const tokens = tokensFromGemini(result?.stats);
  if (tokens) reportUsage(onUsage, { at: Date.now(), ...tokens });

  const failure = result && (result.status === 'error' || result.error) ? errorText(result.error) || 'unknown error' : '';
  if (wrote.trim()) {
    // The reply is on screen already; say so if the run then ended badly.
    if (failure) yield `\n\n[Gemini stopped with an error: ${clip(failure, 300)}]`;
    return;
  }
  if (failure) {
    if (AUTH_ERROR.test(failure)) throw new Error(SIGN_IN);
    if (resume && looksGone(failure)) throw goneError('Gemini has no saved session with that id.');
    throw new Error(`Gemini stopped with an error: ${clip(failure, 400)}`);
  }
  if (sawTool) {
    // An agent run can end after its last tool call without a closing message.
    yield '(Gemini finished without a written reply.)';
    return;
  }
  const why = (warned || stderrSeen || stray).trim();
  if (AUTH_ERROR.test(why)) throw new Error(SIGN_IN);
  if (resume && looksGone(why)) throw goneError('Gemini has no saved session with that id.');
  if (result) throw new Error(`Gemini returned an empty reply${warned ? `: ${clip(warned, 400)}` : '.'}`);
  throw new Error(`Gemini ended without a reply${why ? `:\n${clip(why, 1500)}` : '.'}`);
}

// ---------- status ----------

// The CLI keeps its files in ~/.gemini (GEMINI_CLI_HOME replaces the home folder).
const geminiDir = () => path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
const exists = file => fs.access(file).then(() => true, () => false);

// { installed, signedIn, email }. Reads no secrets and makes no network call: it checks which files exist,
// and reads the account email the CLI caches in google_accounts.json ({ active, old }), which holds no token.
// Signed in means any of: GEMINI_API_KEY is set; oauth_creds.json exists (the older CLIs' file); the CLI wrote
// gemini-credentials.json (its encrypted file fallback); or google_accounts.json names an active account.
// The last two go beyond the contract's rule on purpose: 0.63 keeps the Google login in the OS keychain
// (service gemini-cli-oauth) and no longer writes oauth_creds.json, so a fresh sign-in would look signed out.
// The cached account is set on a successful login and cleared on logout, so it stands for the login.
export async function geminiStatus() {
  const dir = geminiDir();
  const [exe, oauthFile, fallbackFile, accounts] = await Promise.all([
    findExecutable('gemini'),
    exists(path.join(dir, 'oauth_creds.json')),
    exists(path.join(dir, 'gemini-credentials.json')),
    fs.readFile(path.join(dir, 'google_accounts.json'), 'utf8').then(s => JSON.parse(s)).catch(() => null),
  ]);
  const email = typeof accounts?.active === 'string' && accounts.active.trim() ? accounts.active.trim() : null;
  const hasKey = !!process.env.GEMINI_API_KEY?.trim();
  return { installed: !!exe, signedIn: hasKey || oauthFile || fallbackFile || !!email, email };
}

export async function geminiUsage() {
  return { unavailable: 'Gemini plan limits are not available here: the Gemini CLI does not report them when it runs without a terminal.' };
}

// ---------- sign-in ----------

// What the sign-in terminal runs: the interactive CLI, where the user chooses "Sign in with Google".
// --skip-trust trusts the folder for this session only, so the CLI does not ask to trust (and remember) the home folder.
export function geminiSignInCommand() {
  return { command: 'gemini', args: ['--skip-trust'] };
}

// Opens a terminal (in the home folder) running the interactive Gemini CLI so the user can sign in with Google.
export async function geminiSignIn() {
  const { command, args } = geminiSignInCommand();
  await openSignIn(command, args, 'Sign in to Gemini');
}
