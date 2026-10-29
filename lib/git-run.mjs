// Runs git for the review pane, /review, the advisor, @diff and the header's status chip (lib/git-status.mjs). Every call has a fixed
// argument list. The only variable parts are the folder the command runs in and, for a few calls, paths that git itself reported.
// Repository config cannot change what runs:
//  - core.fsmonitor is set to empty, so no fsmonitor program is started;
//  - core.hooksPath points at an empty folder Plenum owns, so no hook runs;
//  - diffs add DIFF_SAFE (--no-ext-diff, --no-textconv), so no external diff program or textconv filter runs;
//  - a command that compares the working tree with the index (diff, status) empties every filter driver the git configuration
//    defines (filter.<name>.clean, smudge and process, with required off), because git runs a clean filter to hash a file whose
//    stat data changed, and it does not scan the working tree of a submodule, whose own configuration could name another program.
//    A repository that uses Git LFS then shows its tracked files as pointer against content (DECISIONS item 30).
// The environment is gitEnv() from lib/git-env.mjs: no API keys, no GIT_DIR, no terminal prompt.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from './store.mjs';
import { gitEnv } from './git-env.mjs';

// Added to diff calls. They fix the output shape, so repository settings cannot change what the pane reads.
export const DIFF_SAFE = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv']);

const MIB = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BUFFER = 16 * MIB;
// The stderr kept for an error message. Git's own text is short; more is cut.
const STDERR_KEEP = 64 * 1024;
// On Windows without LongPathsEnabled, a program cannot start in a folder whose path is this long or longer: the start fails with ENOENT,
// the same error a missing git gives (B-47). The caller is told, so it can say the path is too long.
const WIN_PATH_LIMIT = 259;
// The git commands that read working-tree files to compare them with the index, which is where git runs a clean filter.
const FILTERED_COMMANDS = new Set(['diff', 'status', 'diff-files', 'diff-index']);
// More drivers than this means a configuration made to be hostile or broken; the command is not run.
const MAX_FILTER_DRIVERS = 64;
const FILTER_VARIABLES = Object.freeze([['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']]);
const FILTER_KEY = /^filter\.([\s\S]+)\.(clean|smudge|process|required)$/i;

// The folder git reads its hooks from instead of the repository's own. It is made once and nothing is written to it.
export function emptyHooksDir() {
  return path.join(HOME, 'git-empty-hooks');
}

let hooksMade = null;
function ensureHooksDir() {
  hooksMade ??= fs.mkdir(emptyHooksDir(), { recursive: true }).catch(() => {});
  return hooksMade;
}

// The git command in an argument list: the first argument that is not an option (the value after -c or -C is skipped).
export function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c' || args[i] === '-C') {
      i += 1;
      continue;
    }
    if (!args[i].startsWith('-')) return args[i];
  }
  return '';
}

// The -c options that switch off the filter drivers with these names. An empty clean, smudge or process command does nothing, and
// required off keeps git from stopping because a required filter did nothing. A name that holds an equals sign or a line break
// cannot be written as a -c option, so null is returned and the caller does not run git.
export function filterOverrides(names) {
  const out = [];
  for (const name of names) {
    if (/[=\r\n\0]/.test(name)) return null;
    for (const [variable, value] of FILTER_VARIABLES) out.push('-c', `filter.${name}.${variable}=${value}`);
  }
  return out;
}

// The names of the filter drivers the git configuration defines for this folder: the repository's own, the user's and the system's.
// Resolves { ok: true, names } or { ok: false, notFound, timedOut } when git could not read its configuration (the command is then not
// run; notFound and timedOut say why, so a caller can tell git missing or slow from a refusal).
async function filterDriverNames(cwd, env) {
  const r = await runGit(['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { cwd, env, filters: false, timeoutMs: 5000 });
  // git config exits 1 when no key matches.
  if (r.code === 1 && r.stdout === '') return { ok: true, names: [] };
  if (!r.ok) return { ok: false, notFound: r.notFound, timedOut: r.timedOut, longPath: r.longPath };
  const names = new Set();
  for (const key of r.stdout.split('\0')) {
    const m = FILTER_KEY.exec(key);
    if (m) names.add(m[1]);
  }
  return names.size > MAX_FILTER_DRIVERS ? { ok: false } : { ok: true, names: [...names] };
}

// Runs git with args (an array of strings). Resolves, and never rejects, with:
//   { ok, code, stdout, stderr, notFound, longPath, timedOut, tooBig }
// ok is true only for exit code 0 within the time and output limits. notFound is true when git itself is not installed, and longPath is
// true when the start failed because the folder path is too long for Windows (notFound is then true too; see WIN_PATH_LIMIT).
// input, when given, is written to git's stdin. encoding 'buffer' keeps stdout as a Buffer.
// filters: left out, the filter drivers are emptied for the commands in FILTERED_COMMANDS and kept for the rest; true empties them
// for any command and false never does. When the drivers cannot be listed, git is not run and the answer is { ok: false }.
export async function runGit(args, { cwd, input, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, env = {}, encoding = 'utf8', filters } = {}) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('git arguments must be a list of strings');
  const empty = { ok: false, code: null, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: '', notFound: false, longPath: false, timedOut: false, tooBig: false };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { ...empty, stderr: 'no folder' };
  const folder = await fs.stat(cwd).catch(() => null);
  if (!folder?.isDirectory()) return { ...empty, stderr: 'no folder' };
  await ensureHooksDir();
  const command = gitSubcommand(args);
  const neutralise = filters === undefined ? FILTERED_COMMANDS.has(command) : filters === true;
  let driverArgs = [];
  if (neutralise) {
    const found = await filterDriverNames(cwd, env);
    driverArgs = found.ok ? filterOverrides(found.names) : null;
    if (driverArgs === null) return { ...empty, notFound: found.notFound === true, longPath: found.longPath === true, timedOut: found.timedOut === true, stderr: 'git was not run: its filter drivers could not be switched off' };
  }
  let tail = args;
  // A submodule is compared by its commit only: git would otherwise run git status in it, under the submodule's own configuration.
  if (FILTERED_COMMANDS.has(command) && neutralise) {
    const at = args.indexOf(command);
    tail = [...args.slice(0, at + 1), '--ignore-submodules=dirty', ...args.slice(at + 1)];
  }
  const full = ['-c', 'core.fsmonitor=', '-c', `core.hooksPath=${emptyHooksDir()}`, ...driverArgs, ...tail];
  const childEnv = { ...gitEnv(), ...env };

  return new Promise(resolve => {
    let child;
    try {
      child = spawn('git', full, { cwd, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ ...empty, notFound: true });
      return;
    }
    // A start that fails (a folder path too long for Windows, say) still gives the child its pipes, and each reports the failure as an
    // 'error' event of its own. With no listener that is an uncaught exception, which ends the server in the middle of a review, an
    // advisor call or an @diff. The child's own 'error' event below has the answer.
    for (const stream of [child.stdout, child.stderr]) stream?.on('error', () => {});
    const out = [];
    let outSize = 0;
    const err = [];
    let errSize = 0;
    let settled = false;
    let timedOut = false;
    let tooBig = false;
    let notFound = false;
    let longPath = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        ok: code === 0 && !timedOut && !tooBig && !notFound,
        code: typeof code === 'number' ? code : null,
        stdout: encoding === 'buffer' ? buf : buf.toString('utf8'),
        stderr,
        notFound,
        longPath,
        timedOut,
        tooBig,
      });
    };
    // A run past its time limit is answered at once; git and anything it started are stopped, but the pipes may stay open a moment.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      if (tooBig) return;
      outSize += chunk.length;
      if (outSize > maxBuffer) {
        tooBig = true;
        child.kill();
        finish(null);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (errSize < STDERR_KEEP) {
        err.push(chunk);
        errSize += chunk.length;
      }
    });
    // git may exit before it reads its input; the write error is then not useful.
    child.stdin.on('error', () => {});
    child.on('error', e => {
      notFound = e.code === 'ENOENT';
      // A start that fails in a folder path of 259 characters or more is reported as a long path, not as a missing git (B-47).
      longPath = notFound && process.platform === 'win32' && cwd.length >= WIN_PATH_LIMIT;
      finish(null);
    });
    child.on('close', code => finish(code));
    child.stdin.end(input === undefined ? undefined : input);
  });
}
