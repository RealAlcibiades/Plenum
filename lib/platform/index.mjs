import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { pathFor } from './paths.mjs';

export * from './paths.mjs';

// Every choice that differs between Windows, macOS and Linux lives in lib/platform/, so the rest of the app asks
// here and never tests process.platform itself. Every function takes the platform as a parameter that defaults to
// process.platform, which is how the tests run the macOS and Linux branches on a Windows machine.

export const osName = (platform = process.platform) => (platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux');

// ---------- the shell run_command uses ----------

// The shell on Windows. run_command used cmd.exe before the platform work, and this one word is that choice again.
// The PowerShell shell below is kept: shellFor(platform, { windows: 'powershell' }) still builds it.
export const WINDOWS_SHELL = 'cmd';

// The output is written as UTF-8, and so is a file made with ">" (Windows PowerShell 5.1 would write UTF-16). The last
// line passes the exit code of a native program on: without it -Command turns any failure into 1.
const PS_PRELUDE = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; $ProgressPreference = 'SilentlyContinue'";
const PS_EXIT = 'if ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }';

// Windows PowerShell 5.1 is on every Windows. It is started by its full path, so a PATH without its folder still finds it.
function powershellFile(env, exists) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  if (root) {
    const full = pathFor('win32').join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(full)) return full;
  }
  return 'powershell.exe';
}

// { name, file, argv(command), verbatim, hint, osLine }. file and argv(command) are what to spawn for one command line;
// verbatim is windowsVerbatimArguments; hint is the sentence the run_command tool description carries; osLine is the
// sentence for an agent's system prompt. `windows` picks the Windows shell ('powershell' or 'cmd').
export function shellFor(platform = process.platform, { windows = WINDOWS_SHELL, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') {
    return {
      name: 'sh',
      file: '/bin/sh',
      argv: command => ['-c', command],
      verbatim: false,
      hint: 'It runs with /bin/sh -c.',
      osLine: `Operating system: ${osName(platform)} (run_command uses /bin/sh).`,
    };
  }
  if (windows === 'cmd') {
    return {
      name: 'cmd',
      file: 'cmd.exe',
      argv: command => ['/d', '/s', '/c', `"${command}"`],
      verbatim: true,
      hint: 'Windows cmd.exe; for PowerShell use: powershell -NoProfile -Command "...".',
      osLine: 'Operating system: Windows (run_command uses cmd.exe).',
    };
  }
  return {
    name: 'powershell',
    file: powershellFile(env, exists),
    argv: command => ['-NoProfile', '-NonInteractive', '-Command', `${PS_PRELUDE}\n${command}\n${PS_EXIT}`],
    verbatim: false,
    hint: 'It runs in Windows PowerShell 5.1: join commands with ";" (this version has no "&&" or "||"), and use cmd /c "..." for cmd.exe syntax.',
    osLine: 'Operating system: Windows (run_command uses PowerShell 5.1: join commands with ";", not "&&").',
  };
}

// ---------- finding a command-line tool ----------

// True for a regular file the user can run. (Windows has no execute bit, so any file passes there.)
export function isExecutableFile(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// What `which` does, in Node and without a shell: the first folder on PATH that holds a runnable file of that name.
// An empty or relative PATH entry means "the current folder" to a shell; it is skipped, so a tool planted in a project
// folder is never picked up.
export function findOnPath(name, { platform = process.platform, env = process.env, isExecutable = isExecutableFile } = {}) {
  const p = pathFor(platform);
  const bare = String(name ?? '');
  if (!bare || bare === '.' || bare === '..' || /[\\/\u0000]/.test(bare)) return null;
  for (const dir of String(env.PATH ?? '').split(p.delimiter)) {
    if (!dir || !p.isAbsolute(dir)) continue;
    const full = p.join(dir, bare);
    if (isExecutable(full)) return full;
  }
  return null;
}

// Resolves to the path of a tool, or null. Windows asks where.exe; macOS and Linux search PATH themselves. PATH comes
// first, so a tool that is on PATH (and any test shim placed there) is the one used. The tools folder is the fallback
// for an app started without the right PATH: npm puts a .cmd shim in node_modules\.bin on Windows and a plain link on macOS and Linux.
// exec, env, isExecutable and exists replace the real ones in the tests.
export function locateCommand(name, { platform = process.platform, env = process.env, toolsDir = null, exec = execFile, isExecutable = isExecutableFile, exists = existsSync } = {}) {
  const p = pathFor(platform);
  const own = bin => (toolsDir && /^[\w-]+$/.test(name) ? p.join(toolsDir, 'node_modules', '.bin', bin) : null);
  if (platform !== 'win32') {
    const exe = findOnPath(name, { platform, env, isExecutable });
    const fallback = own(name);
    return Promise.resolve(exe ?? (fallback && isExecutable(fallback) ? fallback : null));
  }
  return new Promise(resolve => {
    exec('where.exe', [name], { windowsHide: true, timeout: 5000, cwd: os.tmpdir() }, (err, out) => {
      const lines = err || !out ? [] : String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // Prefer a real .exe, then a .cmd shim. Extensionless npm shims are shell scripts and cannot be spawned on Windows.
      let exe = lines.find(l => /\.exe$/i.test(l)) ?? lines.find(l => /\.(cmd|bat)$/i.test(l)) ?? lines[0] ?? null;
      const fallback = own(`${name}.cmd`);
      if (!exe && fallback && exists(fallback)) exe = fallback;
      resolve(exe);
    });
  });
}

// ---------- running and stopping processes ----------

// A .cmd or .bat shim cannot be spawned directly on Windows, so it goes through cmd.exe. Nowhere else.
export const usesCmdShim = (file, platform = process.platform) => platform === 'win32' && /\.(cmd|bat)$/i.test(file);

// The command that ends a process and everything it started, or null where a signal is used instead (killGroupPlan).
export function killTreePlan(pid, platform = process.platform) {
  if (platform !== 'win32') return null;
  return { file: 'taskkill', args: ['/pid', String(pid), '/t', '/f'] };
}

// macOS and Linux start a child in its own process group, so one signal to the group reaches everything it started.
// Windows has no process groups; taskkill /t does that job there.
export const ownsProcessGroup = (platform = process.platform) => platform !== 'win32';

// The signal that ends a child's whole process group, as { pid, signal } for process.kill, or null on Windows. A negative
// pid names the group, and the child leads its own group when it was started detached. A pid of 0 or 1 would name this
// process's own group or every process of the user, so only a pid above 1 gets a plan.
export function killGroupPlan(pid, platform = process.platform) {
  if (!ownsProcessGroup(platform) || !Number.isInteger(pid) || pid <= 1) return null;
  return { pid: -pid, signal: 'SIGTERM' };
}

// ---------- the PATH a child gets ----------

// Where command-line tools usually live on macOS and Linux. An app started from Finder or a launcher gets a short PATH
// (often only /usr/bin:/bin:/usr/sbin:/sbin) without Homebrew, npm's global folder or the user's own bin folders.
// Windows has no such list: its PATH is left as it is.
export function cliDirs({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') return [];
  const p = pathFor(platform);
  // A home folder that is not an absolute path would put a relative folder on PATH, which a shell reads as the current folder.
  return ['/opt/homebrew/bin', '/usr/local/bin', p.join(home, '.local', 'bin'), p.join(home, '.npm-global', 'bin'), p.join(home, '.volta', 'bin')].filter(dir => p.isAbsolute(dir));
}

export function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// The PATH value for a child: the PATH it has, then each of those folders that exists and is not on it yet. Nothing is
// ever put in front, so a tool the user already reaches stays the one that is found. With nothing to add (and always on
// Windows) the PATH comes back exactly as it was. exists replaces the real folder check in the tests.
export function pathWithCliDirs(current, { platform = process.platform, home = os.homedir(), exists = isDirectory } = {}) {
  const p = pathFor(platform);
  const have = String(current ?? '').split(p.delimiter).map(dir => dir.replace(/\/+$/, '') || '/');
  const add = cliDirs({ platform, home }).filter(dir => !have.includes(dir) && exists(dir));
  if (!add.length) return current;
  return [String(current ?? '') || null, ...add].filter(Boolean).join(p.delimiter);
}

// The command tools Claude Code is given (--tools): Bash everywhere, and its PowerShell tool as well on Windows.
export const agentShellTools = (platform = process.platform) => (platform === 'win32' ? 'Bash,PowerShell' : 'Bash');

// The npm command that puts a CLI in the tools folder, written for the shell of that platform.
export function installHint(pkg, platform = process.platform) {
  const dir = platform === 'win32' ? '%USERPROFILE%\\.muse-console\\tools' : '$HOME/.muse-console/tools';
  return `npm install --prefix "${dir}" ${pkg}`;
}
