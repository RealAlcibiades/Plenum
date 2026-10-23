import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, keyRoutesFrom, streamProcess, withoutKey } from './proc.mjs';
import { installHint } from './platform/index.mjs';
import { openSignIn } from './accounts.mjs';
import { keyFor } from './keys.mjs';
import { get as stateNow } from './store.mjs';
import { goneError, looksGone } from './sessions.mjs';
import { argsFor, envFor } from './cli-options/gemini.mjs';
import { reportUsage, tokensFromGemini } from './pricing.mjs';
import { stageImages } from './images.mjs';
import { pdfRefusal } from './attachments.mjs';

// Gemini through the Gemini CLI (`gemini`). Two routes, chosen in Accounts (lib/proc.mjs keyRoutesFrom):
//   'key'      the saved Google AI key is passed as GEMINI_API_KEY, in this run's env only (default when a key is saved);
//   'sign-in'  the Google account sign-in the CLI keeps itself (when the key route is off, or no key is saved).
// childEnv in lib/proc.mjs removes GEMINI_API_KEY, GOOGLE_API_KEY and the Vertex and Code Assist switches from every child; the
// key route adds its one variable back for its own run, and the server's environment never gets it.
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
const SIGN_IN = 'Gemini CLI is not signed in. Open Accounts and choose "Sign in to Gemini CLI".';
const KEY_REFUSED = 'Gemini CLI did not accept the saved Google AI key. Check the key in Accounts, or turn off "Use my Google AI key with Gemini CLI" to sign in to Gemini CLI instead.';
// The prompt goes on stdin. The CLI puts the -p text after the stdin text, so this only has to point back at it.
// It has no characters cmd.exe would treat specially when the CLI is a .cmd shim.
const INSTRUCTION = 'Reply to the request above, doing what it asks.';
// Words that mean "sign in" in an error. Exit code 41 is the CLI's own authentication failure code.
// 'authenticat' also matches FatalAuthenticationError, the error type the CLI puts in a result event.
const AUTH_ERROR = /auth method|\bsign[ -]?in\b|\blog[ -]?in\b|authenticat|exited with code 41\b/i;
// B-48: a line about an MCP server's login or authentication is the CLI reporting on that one server, not a sign-in failure for
// Gemini. signInText checks each line on its own and skips those lines, so the CLI's own text is shown instead.
const MCP_LINE = /\bMCP\b/i;
const signInText = text => String(text ?? '').split('\n').some(line => !MCP_LINE.test(line) && AUTH_ERROR.test(line));
// The sign-in error for the route the run took: a refused key gets its own words, because the sign-in button does not fix it.
const signInError = route => new Error(route === 'key' ? KEY_REFUSED : SIGN_IN);
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

// The route a Gemini run takes now: 'key' when the key route is on (keyRoutes.gemini, on by default), a Google AI key is saved, and
// the Gemini CLI would use that key (see keyChoice). Otherwise 'sign-in'. The key is returned to the caller only, for the run's env;
// it is never logged or put in the environment.
export async function geminiRoute() {
  const { key } = await keyChoice();
  return key ? { route: 'key', key } : { route: 'sign-in', key: null };
}

// The sign-in the Gemini CLI itself is set to: security.auth.selectedType in ~/.gemini/settings.json, which the CLI writes when its
// own sign-in (or /auth inside it) picks a type. The CLI takes that choice before it looks at GEMINI_API_KEY, so the saved key is used
// only when no choice is set or the choice is 'gemini-api-key'. Only that one field is read; the rest of the file is not kept.
// null when no choice is set or the file cannot be read.
async function cliAuthType() {
  try {
    const type = JSON.parse(await fs.readFile(path.join(geminiDir(), 'settings.json'), 'utf8'))?.security?.auth?.selectedType;
    return typeof type === 'string' && type.trim() ? type.trim() : null;
  } catch {
    return null;
  }
}
const keyUsedByCli = type => !type || type === 'gemini-api-key';

// What a run would do with the saved key, and why. keyOn is the Accounts choice; keySaved is whether a Google AI key is saved;
// keyBlocked is true when the key route is on and a key is saved, but the CLI is set to another sign-in, so a run would not use the
// key. key is the saved key only when a run uses it (route 'key'), and null otherwise.
async function keyChoice() {
  const keyOn = keyRoutesFrom(stateNow()).gemini;
  const [savedKey, cliType] = await Promise.all([keyFor('googleai'), cliAuthType()]);
  const keySaved = !!savedKey;
  const keyBlocked = keyOn && keySaved && !keyUsedByCli(cliType);
  const key = keyOn && keySaved && !keyBlocked ? savedKey : null;
  return { keyOn, keySaved, keyBlocked, key };
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
// images (optional) are the pictures of the newest message, each { name, mime, data }. The CLI reads an image from a file, so they are
// written to a folder of their own under the system temp folder (lib/images.mjs stageImages), the folder is added with
// --include-directories, and the prompt names each file with @path. The folder is removed when the run ends, whether it
// finished, failed or was stopped. A folder whose path has a space or a symbol is refused: the path goes on a command line, so only
// plain path characters are passed. Documents (PDFs) are not sent here: streamChat turns them into text first.
export async function* streamGemini(options) {
  const { route, key } = await geminiRoute();
  const staged = options.images?.length ? await stagedGeminiImages(options.images) : null;
  try {
    // The key reaches the child only as this run's env (streamProcess adds it on top of childEnv), and an error that carries it is scrubbed.
    yield* withoutKey(key, runGemini({ ...options, route, env: route === 'key' ? { GEMINI_API_KEY: key } : undefined, staged }));
  } finally {
    await staged?.cleanup();
  }
}

// Plain path characters only: letters, digits, '.', '_', '-', ':', '\' and '/'. Anything else (a space in the user name, '~' in a
// short name, a '&') is refused, because the folder goes on the command line.
const SAFE_FOLDER = /^[A-Za-z0-9._:\\/-]+$/;

// Stages the images for one run, or throws a plain Error (nothing is left behind when it does).
async function stagedGeminiImages(images) {
  const staged = await stageImages(images);
  if (!SAFE_FOLDER.test(staged.dir)) {
    await staged.cleanup();
    throw new Error(`Gemini CLI cannot take images from a folder whose path has spaces or symbols (${staged.dir}). Attach them to another model.`);
  }
  return staged;
}

async function* runGemini({ id, prompt, cwd, signal, mode = 'ask', emit, sessionId, resume = false, tools, onUsage, images, documents, route = 'sign-in', env, staged = null, mcp = null }) {
  if (documents?.length) throw new Error(pdfRefusal(documents.length === 1 ? documents[0].name : ''));
  const model = String(id ?? 'default');
  // The id lands on a command line (through cmd.exe for the .cmd shim), so only plain model ids pass.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new Error(`"${model}" is not a Gemini model id.`);
  if (!String(prompt ?? '').trim()) throw new Error('There is nothing to send to Gemini.');
  if (signal?.aborted) return;
  // The staged images are named in the -p text with @path, and their folder is allowed for the run.
  const files = staged?.files ?? [];
  const instruction = files.length ? `${INSTRUCTION} Attached images: ${files.map(f => `@${f}`).join(' ')}` : INSTRUCTION;
  const args = ['-p', instruction, '-o', 'stream-json'];
  if (model !== 'default') args.push('-m', model);
  args.push('--skip-trust', ...argsFor(tools?.gemini, { mode, mcp: mcp?.descriptor }));
  if (staged) args.push(`--include-directories=${staged.dir}`);
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
    // The Plenum bridge (lib/mcp-server.mjs) reaches Gemini through its settings file, named in this run's environment.
    const cliEnv = { ...(env ?? {}), ...(mcp ? envFor(mcp.descriptor, { mode, settings: tools?.gemini }) : {}) };
    for await (const chunk of streamProcess({ command: 'gemini', args, cwd, signal, input: prompt, hint: GEMINI_HINT, onStderrLine, env: cliEnv })) {
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
    if (!wrote.trim() && signInText(err?.message)) throw signInError(route);
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
    if (signInText(failure)) throw signInError(route);
    if (resume && looksGone(failure)) throw goneError('Gemini has no saved session with that id.');
    throw new Error(`Gemini stopped with an error: ${clip(failure, 400)}`);
  }
  if (sawTool) {
    // An agent run can end after its last tool call without a closing message.
    yield '(Gemini finished without a written reply.)';
    return;
  }
  const why = (warned || stderrSeen || stray).trim();
  if (signInText(why)) throw signInError(route);
  if (resume && looksGone(why)) throw goneError('Gemini has no saved session with that id.');
  if (result) throw new Error(`Gemini returned an empty reply${warned ? `: ${clip(warned, 400)}` : '.'}`);
  throw new Error(`Gemini ended without a reply${why ? `:\n${clip(why, 1500)}` : '.'}`);
}

// ---------- status ----------

// The CLI keeps its files in ~/.gemini (GEMINI_CLI_HOME replaces the home folder).
const geminiDir = () => path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
const exists = file => fs.access(file).then(() => true, () => false);

// { installed, signedIn, email, route, keySaved, keyOn }. Reads no secrets and makes no network call: it checks which files
// exist, and reads the account email the CLI caches in google_accounts.json ({ active, old }), which holds no token.
// route names the route a run takes, always one of the two: 'key' (the saved Google AI key, see geminiRoute), or 'sign-in' (the Google account the CLI
// keeps: oauth_creds.json exists (the older CLIs' file), the CLI wrote gemini-credentials.json (its encrypted file fallback),
// or google_accounts.json names an active account). signedIn says whether the route is ready: a key is saved, or a sign-in is on disk.
// The last two sign-in files go beyond the contract's rule on purpose: 0.63 keeps the Google login in the OS keychain
// (service gemini-cli-oauth) and no longer writes oauth_creds.json, so a fresh sign-in would look signed out.
// The cached account is set on a successful login and cleared on logout, so it stands for the login.
// GEMINI_API_KEY in the server's environment is not counted: no run ever gets it (childEnv removes it), so it cannot be the route.
// keySaved is whether a Google AI key is saved; keyOn is the Accounts choice (the key route is on).
// keyBlocked is true when the key route is on and a key is saved, but the CLI's own sign-in choice (~/.gemini/settings.json) would
// be used instead of the key, so a run goes through the Google sign-in and not the key (see keyChoice). Accounts says so and how to fix it.
export async function geminiStatus() {
  const dir = geminiDir();
  const [exe, oauthFile, fallbackFile, accounts, choice] = await Promise.all([
    findExecutable('gemini'),
    exists(path.join(dir, 'oauth_creds.json')),
    exists(path.join(dir, 'gemini-credentials.json')),
    fs.readFile(path.join(dir, 'google_accounts.json'), 'utf8').then(s => JSON.parse(s)).catch(() => null),
    keyChoice(),
  ]);
  const email = typeof accounts?.active === 'string' && accounts.active.trim() ? accounts.active.trim() : null;
  const signedInWithGoogle = oauthFile || fallbackFile || !!email;
  // The route is always one of the two: a run takes it whether or not it is ready. signedIn says whether it is ready.
  const route = choice.key ? 'key' : 'sign-in';
  return {
    installed: !!exe,
    signedIn: route === 'key' || signedInWithGoogle,
    email,
    route,
    keySaved: choice.keySaved,
    keyOn: choice.keyOn,
    keyBlocked: choice.keyBlocked,
  };
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
  await openSignIn(command, args, 'Sign in to Gemini CLI');
}
