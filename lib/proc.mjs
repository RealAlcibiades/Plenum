import { spawn, execFile } from 'node:child_process';
import { killGroupPlan, killTreePlan, locateCommand, ownsProcessGroup, pathWithCliDirs, shellFor, toolsDir, usesCmdShim } from './platform/index.mjs';

// Process helpers shared by the CLI adapters and the run_command tool.
// On Windows, .cmd shims go through cmd.exe because Node refuses to spawn them directly.
// What differs between Windows, macOS and Linux (finding a tool, the shell, ending a process tree) is decided in
// lib/platform/, and the functions here that depend on it take the platform as a parameter that defaults to process.platform.

const found = new Map();

// Muse Console keeps its own copies of the Claude and Codex CLIs here, so they are found however
// the app was started. (%APPDATA%\npm is not reliable: a program installed from a packaged app can
// land in that app's private copy of AppData, which nothing else can see.)
export const TOOLS_DIR = toolsDir();

// The PATH a CLI is looked up on and run with. It is built here, in one place: the PATH the process has, then (macOS and
// Linux only) each common CLI folder that exists and is not on it yet (cliDirs in lib/platform/index.mjs). An app started
// from a desktop launcher gets a short PATH, and this puts Homebrew, npm's global folder and the user's own bin folders
// back. childEnv gives it to a child as its PATH and findExecutable searches it, so a tool is found in the same folders
// it can later be run from. Nothing is put in front of what the user already has, and on Windows the PATH comes back
// exactly as it was. home and exists replace the real ones in the tests.
export function cliSearchPath(env = process.env, { platform = process.platform, home, exists } = {}) {
  return pathWithCliDirs(env.PATH, { platform, home, exists });
}

// The augmented PATH is searched first, so a tool that is on PATH (and any test shim placed there) is always the one used.
// The tools folder is the fallback for an app started without the right PATH.
// Windows asks where.exe; macOS and Linux search PATH in Node, with no shell (locateCommand in lib/platform/index.mjs).
// The answer is kept for 30 seconds, per platform, name and PATH. env, home, exists, isExecutable and toolsDir replace the
// real ones in the tests.
export function findExecutable(name, platform = process.platform, { env = process.env, home, exists, isExecutable, toolsDir: tools = TOOLS_DIR } = {}) {
  const search = cliSearchPath(env, { platform, home, exists });
  const key = `${platform}:${name}:${search ?? ''}`;
  const hit = found.get(key);
  if (hit && Date.now() - hit.at < 30_000) return Promise.resolve(hit.path);
  return locateCommand(name, { platform, env: { PATH: search }, toolsDir: tools, isExecutable }).then(exe => {
    found.set(key, { path: exe, at: Date.now() });
    return exe;
  });
}

// The options every child process is started with. macOS and Linux start it in its own process group (detached), so that
// killTree can signal the whole group; Windows keeps its console hidden and uses taskkill /t instead.
export function spawnOptions({ cwd, env, stdio, verbatim = false }, platform = process.platform) {
  return { cwd, env, windowsHide: true, stdio, windowsVerbatimArguments: verbatim, detached: ownsProcessGroup(platform) };
}

// Starts every child process of the CLI adapters and the shell tool: streamProcess and runShell here, capture and the run
// in lib/claude-cli.mjs, and the Codex app server in lib/usage.mjs. This is the one place that calls spawn, so every child
// gets the same three things: spawnOptions (detached on macOS and Linux, so killTree can signal its whole group), the
// environment from childEnv(command) with `env` added on top, and `launch` (a resolveLaunch result, or { file, argv,
// verbatim } for the shell) as the program to start. platform, source and spawner replace the real ones in the tests,
// which is how a test sees the options built without starting anything.
export function startChild(command, launch, { cwd, env, stdio, platform = process.platform, source = process.env, spawner = spawn }) {
  return spawner(launch.file, launch.argv, spawnOptions({
    cwd,
    env: { ...childEnv(command, { source, platform }), ...env },
    stdio,
    verbatim: launch.verbatim,
  }, platform));
}

// Ends a child and everything it started. A run is stopped here: the abort signal of /cancel (and the run timeout) reach
// this function through the listeners in streamProcess, runShell and the Claude adapter, and the timers of capture and the
// Codex app server call it too. Windows runs taskkill /t.
// macOS and Linux signal the child's process group (negative pid), which is the child's own group because startChild
// starts it detached; with no such group (a child started some other way) the signal goes to the child alone.
// run and signalGroup replace execFile and process.kill in the tests, so a test never ends a real process.
export function killTree(child, platform = process.platform, { run = execFile, signalGroup = (pid, signal) => process.kill(pid, signal) } = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const plan = killTreePlan(child.pid, platform);
  if (plan) {
    run(plan.file, plan.args, { windowsHide: true }, () => {});
    return;
  }
  const group = killGroupPlan(child.pid, platform);
  if (group) {
    try {
      signalGroup(group.pid, group.signal);
      return;
    } catch {
      // There is no group of that name, so the child is signalled alone.
    }
  }
  child.kill('SIGTERM');
}

// Keys and settings that would make a CLI bill a per-token API key instead of its subscription login are kept
// out of its child process. Each rule is an exact name, or a prefix that ends in "_". Names are compared in
// upper case, because Windows environment variable names are not case-sensitive.
// On macOS and Linux the common CLI folders are added to the end of its PATH when they exist and are not on it
// (an app started from Finder gets a short PATH). source, platform, home and exists replace the real ones in the tests.
export function childEnv(command, { source = process.env, platform = process.platform, home, exists } = {}) {
  const env = { ...source, NO_COLOR: '1' };
  const cliPath = cliSearchPath(env, { platform, home, exists });
  if (cliPath !== env.PATH) env.PATH = cliPath;
  // Claude Code's own keys and settings: ANTHROPIC_ would bill a key, CLAUDE_ holds its settings, and CLAUDECODE is
  // the marker Claude Code sets on the processes it starts. Every CLI except the shell gets this rule.
  const agent = ['ANTHROPIC_', 'CLAUDE_', 'CLAUDECODE'];
  // API keys for the providers. Every child loses these, the shell included. The API adapters read their keys with
  // keyFor on every request, and Codex uses its own sign-in, so no child needs one in its environment.
  const providerKeys = ['XAI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
  const rules = {
    // Claude takes the agent rule, so it keeps its subscription login.
    claude: agent,
    // Codex bills an OPENAI_API_KEY instead of the ChatGPT login. Every OPENAI_ variable is removed, so no other
    // OPENAI_ setting can do the same.
    codex: [...agent, 'OPENAI_'],
    // These make Gemini use a Gemini or Google API key, Vertex AI or Code Assist instead of the Google sign-in,
    // so they are removed.
    gemini: [...agent, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'],
    // Muse keeps the OPENAI_ rule and also drops the other providers' keys, so a run cannot bill a key from
    // another provider.
    muse: [...agent, 'OPENAI_', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY'],
    // The shell keeps every other variable. The Anthropic keys and the CLAUDE_CODE_ settings go from this rule,
    // because they can switch a claude started from run_command to another login. The provider keys go as well.
    shell: ['ANTHROPIC_', 'CLAUDE_CODE_'],
    // Cursor's CLI (`agent`, or `cursor-agent`) keeps its Cursor account sign-in. A saved or inherited CURSOR_API_KEY would bill
    // instead, so it goes, with every other CURSOR_ setting (lib/cursor.mjs).
    agent: [...agent, 'CURSOR_API_KEY', 'CURSOR_'],
    'cursor-agent': [...agent, 'CURSOR_API_KEY', 'CURSOR_'],
  };
  // A command with no rules of its own gets the agent rule, the same as before. The provider keys go for every command.
  const own = Object.hasOwn(rules, command) ? rules[command] : agent;
  // META_API_KEY is Muse Code's key (README.md: it is passed to Muse Code), so only the muse run keeps it. Every other
  // child, the shell included, loses it.
  const drop = [...own, ...providerKeys, ...(command === 'muse' ? [] : ['META_API_KEY'])];
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (drop.some(rule => (rule.endsWith('_') ? name.startsWith(rule) : name === rule))) delete env[key];
  }
  return env;
}

// The key routes the person chose in Accounts. They are kept in the state file as plain values, never a key: keyRoutes
// = { gemini, codex, claude }. A run passes a saved provider key to its own child only through its env (startChild adds
// `env` on top of childEnv), and only when the route says so. childEnv above still removes every key from every child.
//   gemini: true (the default) sends the saved Google AI key to Gemini CLI whenever one is saved; false signs in with Google.
//   codex:  false (the default) uses the ChatGPT sign-in; true sends the saved OpenAI API key to Codex.
//   claude: 'cli' (Claude Code with the subscription) or 'api' (the Anthropic API key); null means automatic, which is the
//           CLI when it is installed and the API otherwise. A choice that was made is never switched on its own.
// st is the state object (lib/store.mjs get()). The function takes it as a parameter, so this module imports nothing new.
export function keyRoutesFrom(st) {
  const r = st && typeof st.keyRoutes === 'object' && st.keyRoutes !== null ? st.keyRoutes : {};
  return {
    gemini: r.gemini !== false,
    codex: r.codex === true,
    claude: r.claude === 'cli' || r.claude === 'api' ? r.claude : null,
  };
}

// Passes a stream through unchanged, except that an error it throws has the key taken out of its message and its stack, so a
// key a run was given never reaches a message, a log or the screen (the CLI's own stderr is the usual source of such text).
// The stack is a separate string that carries its own copy of the message (V8 writes it the first time it is read, and an
// error rebuilt from text can have one set outright), so changing err.message alone can leave the key in err.stack.
// key may be null.
export async function* withoutKey(key, stream) {
  try {
    yield* stream;
  } catch (err) {
    if (key && err) {
      for (const field of ['message', 'stack']) {
        if (typeof err[field] === 'string' && err[field].includes(key)) err[field] = err[field].split(key).join('[key removed]');
      }
    }
    throw err;
  }
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = s => s.replace(ANSI, '');

// cmd.exe quoting for .cmd shims. A value with a character cmd.exe would read (" % ! ^ & | < >) is refused, not rewritten:
// a rewritten folder is a different folder, and the CLI would run in it with no error. The values that reach here are paths
// and settings, which the CLI adapters have already checked for plain names.
const CMD_UNSAFE = /["%!^&|<>]/;
function cmdArg(value, command) {
  const text = String(value);
  if (CMD_UNSAFE.test(text)) {
    throw new Error(`${command} cannot start on Windows with this command line: a value in it has characters cmd.exe cannot pass (" % ! ^ & | < >). If it is a folder, rename it, or use one without these characters.`);
  }
  return `"${text.replace(/[\r\n]+/g, ' ')}"`;
}

export async function resolveLaunch(command, args, platform = process.platform) {
  const exe = await findExecutable(command, platform);
  if (!exe) return null;
  if (usesCmdShim(exe, platform)) {
    // cmd.exe cannot open batch files at paths over 260 characters.
    if (exe.length > 240) {
      throw new Error(`${command} shim path is too long for cmd.exe (${exe.length} characters). Install ${command} to a shorter folder, or use its .exe.`);
    }
    const quoted = [exe, ...args].map(part => cmdArg(part, command));
    return { file: 'cmd.exe', argv: ['/d', '/s', '/c', `"${quoted.join(' ')}"`], verbatim: true };
  }
  return { file: exe, argv: args, verbatim: false };
}

// How long a run keeps reading after its CLI has exited. A helper process the CLI started can inherit the output pipes and
// hold them open after the CLI is gone, so a run cannot wait for the end of the output. Whatever arrives in this time is kept.
const EXIT_GRACE_MS = 300;

// Resolves when `done` does, or after `ms`, whichever comes first.
function settleWithin(done, ms) {
  let timer;
  return Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

// An ANSI escape that the end of a chunk cuts short (ESC, or ESC [ and some of its parameters). It is held back and joined to
// the next chunk, so an escape split across two chunks is still stripped. A held part longer than MAX_HELD_ESCAPE is not an
// escape a CLI writes, so it is shown as it arrived.
const OPEN_ESCAPE = /\u001b(\[[0-9;?]*[ -/]*)?$/;
const MAX_HELD_ESCAPE = 64;
function openEscapeAt(text) {
  const match = OPEN_ESCAPE.exec(text);
  return match && text.length - match.index <= MAX_HELD_ESCAPE ? match.index : -1;
}

// Streams stdout chunks. Optional `input` is written to stdin and closed. `env` adds variables for
// this run. `onStderrLine` sees each stderr line; a line it returns true for is left out of error text.
// A run that exits non-zero with no output throws. After output, a non-zero exit is not an error here (a CLI can exit
// non-zero after a complete answer), so `onExit({ code, stderr })` is called instead, with the tail of stderr, and the
// caller decides what it means. Without onExit nothing is reported.
export async function* streamProcess({ command, args, cwd, signal, input, hint, env, onStderrLine, onExit }) {
  const launch = await resolveLaunch(command, args);
  if (!launch) throw new Error(`${command} is not on PATH. ${hint ?? ''}`.trim());
  // A Stop that came while the launch was being found ends the run before anything starts. Nothing is awaited between
  // this check and the abort listener below, so a Stop cannot land in that gap unseen.
  if (signal?.aborted) return;
  const child = startChild(command, launch, { cwd, env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input != null) {
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  let spawnError = null;
  let partial = '';
  const keep = text => { stderr = (stderr + text).slice(-4000); };
  child.stderr.on('data', d => {
    if (!onStderrLine) return keep(d);
    partial += d;
    let end;
    while ((end = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, end + 1);
      partial = partial.slice(end + 1);
      if (!onStderrLine(line)) keep(line);
    }
  });
  // The exit of the CLI is what ends the run, not the end of its output (see EXIT_GRACE_MS).
  let exitCode = null;
  const exited = new Promise(resolve => {
    child.once('exit', code => { exitCode = code; resolve(); });
    child.on('error', err => { spawnError = err; resolve(); });
  });
  // Output goes into a queue as the stream delivers it, so a chunk that has arrived is never dropped, however long the
  // caller takes between them. The read ends when stdout ends, when the grace after the exit has passed, or on a Stop.
  const queue = [];
  let streamEnded = false;
  let leaving = false;
  let finished = false;
  let wake = null;
  const poke = () => { const go = wake; wake = null; go?.(); };
  child.stdout.on('data', chunk => { queue.push(chunk); poke(); });
  child.stdout.on('end', () => { streamEnded = true; poke(); });
  child.stdout.on('error', () => { streamEnded = true; poke(); });
  const leave = () => { leaving = true; poke(); };
  let graceTimer = null;
  exited.then(() => { if (!finished) graceTimer = setTimeout(leave, EXIT_GRACE_MS); });
  const stop = () => { killTree(child); leave(); };
  signal?.addEventListener('abort', stop, { once: true });
  const stderrEnded = new Promise(resolve => { child.stderr.on('end', resolve); child.stderr.on('error', resolve); });
  let produced = 0;
  let held = '';
  try {
    for (;;) {
      if (signal?.aborted) break;
      if (queue.length) {
        const chunk = queue.shift();
        produced += chunk.length;
        const text = held + chunk;
        const at = openEscapeAt(text);
        held = at < 0 ? '' : text.slice(at);
        const clean = stripAnsi(at < 0 ? text : text.slice(0, at));
        if (clean) yield clean;
        continue;
      }
      if (streamEnded || leaving) break;
      await new Promise(resolve => { wake = resolve; });
    }
    if (signal?.aborted) return;
    if (held) yield stripAnsi(held);
    await exited;
    await settleWithin(stderrEnded, EXIT_GRACE_MS);
    if (partial && !onStderrLine(partial)) keep(partial);
    if (spawnError) throw spawnError;
    const code = exitCode;
    const tail = stripAnsi(stderr).trim().slice(-1500);
    // A CLI can exit non-zero after a complete answer (for example a background MCP login failing).
    // Only treat it as an error when nothing came back.
    if (code !== 0 && produced === 0) throw new Error(`${command} exited with code ${code}${tail ? `:\n${tail}` : ''}`);
    if (code !== 0 && onExit) onExit({ code, stderr: tail });
  } finally {
    finished = true;
    clearTimeout(graceTimer);
    signal?.removeEventListener('abort', stop);
    // Both pipes are let go, so a helper that still holds them cannot keep the run open.
    child.stdout.destroy();
    child.stderr.destroy();
    killTree(child);
  }
}

// Runs one shell command to completion (used by the run_command tool). `shell` is a shellFor() result. Without one the
// command runs as it always has: cmd.exe on Windows, /bin/sh elsewhere. The run_command tool passes the platform's own
// choice (lib/tools.mjs).
export function runShell(command, { cwd, timeoutMs = 120_000, signal, maxOutput = 30_000, shell = shellFor(process.platform, { windows: 'cmd' }) }) {
  return new Promise(resolve => {
    const child = startChild('shell', { file: shell.file, argv: shell.argv(command), verbatim: shell.verbatim }, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitInfo = null;
    let graceTimer = null;
    const ended = new Set();
    const add = d => {
      out += d;
      if (out.length > maxOutput * 2) out = out.slice(-maxOutput * 2);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      // Both pipes are let go here: a helper process the shell started can hold them open after the shell has finished.
      child.stdout.destroy();
      child.stderr.destroy();
      let text = stripAnsi(out);
      if (text.length > maxOutput) text = `…[earlier output cut]\n${text.slice(-maxOutput)}`;
      resolve({ code, output: text, timedOut, aborted, error });
    };
    // The command ends at the shell's exit, once both of its outputs have ended, or EXIT_GRACE_MS after the exit when an
    // output is still held open (see streamProcess).
    const onEnded = name => {
      ended.add(name);
      if (exitInfo && ended.size === 2) finish(exitInfo.code);
    };
    child.stdout.on('end', () => onEnded('out'));
    child.stderr.on('end', () => onEnded('err'));
    child.on('exit', code => {
      exitInfo = { code };
      if (ended.size === 2) finish(code);
      else graceTimer = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    child.on('error', err => finish(null, err.message));
    const timer = setTimeout(() => { timedOut = true; killTree(child); finish(null); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); finish(null); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
