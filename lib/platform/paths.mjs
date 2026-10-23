import os from 'node:os';
import path from 'node:path';

// Where things live, and which folders are off limits, on each platform. Every path here is built with the path
// module of the platform it is for (win32 or posix) and never by gluing strings with a separator, so a macOS or
// Linux path never holds a backslash, and a test can force "darwin" or "linux" on Windows and still get real POSIX
// paths. Every function takes the platform as a parameter that defaults to process.platform.

export const pathFor = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix);

// The state folder is ~/.muse-console on every platform. MUSE_CONSOLE_HOME replaces it (the tests use that).
export function museHome({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  return env.MUSE_CONSOLE_HOME || pathFor(platform).join(home, '.muse-console');
}

// Muse Console keeps its own copies of the Claude, Codex and Gemini CLIs here.
export function toolsDir(options = {}) {
  return pathFor(options.platform).join(museHome(options), 'tools');
}

// Credential locations under the user's folder, as path segments. The list is the same on every platform: the
// Windows and POSIX folders sit under the home folder in the same way (~/.ssh, ~/.config/gcloud, ~/.docker/config.json).
// .docker/config.json is the one file here; the rest of ~/.docker holds no sign-in.
export const CREDENTIAL_PARTS = Object.freeze([
  ['.codex'],
  ['.config', 'muse'],
  ['.muse-console'],
  ['.claude'],
  ['.ssh'],
  ['.aws'],
  ['.gnupg'],
  ['.gemini'],
  // Cursor's CLI keeps its sign-in in ~/.cursor (cli-config.json), so the folder is off limits as a whole.
  ['.cursor'],
  // Grok Build keeps its SuperGrok or X Premium sign-in in ~/.grok, so that folder is off limits as a whole too (lib/grok.mjs).
  ['.grok'],
  ['.config', 'gcloud'],
  ['.kube'],
  ['.docker', 'config.json'],
  ['.netrc'],
]);

export function credentialPaths(home = os.homedir(), platform = process.platform) {
  const p = pathFor(platform);
  return CREDENTIAL_PARTS.map(parts => p.join(home, ...parts));
}

// The folders the desktop app keeps its own data in: Electron's per-user data folder for the app, named Plenum. It holds the
// saved-keys file and the server log, so lib/guard.mjs treats it as a credential folder. Windows: %APPDATA%\Plenum (and the
// default place for it under the home folder, in case the variable is missing or belongs to another user). macOS:
// ~/Library/Application Support/Plenum. Linux: ~/.config/Plenum (and $XDG_CONFIG_HOME/Plenum when that is set to a full path).
export function plenumDataDirs({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const P = pathFor(platform);
  const named = base => (typeof base === 'string' && P.isAbsolute(base) ? P.join(base, 'Plenum') : null);
  let dirs;
  if (platform === 'win32') dirs = [named(env.APPDATA), P.join(home, 'AppData', 'Roaming', 'Plenum')];
  else if (platform === 'darwin') dirs = [P.join(home, 'Library', 'Application Support', 'Plenum')];
  else dirs = [named(env.XDG_CONFIG_HOME), P.join(home, '.config', 'Plenum')];
  return [...new Set(dirs.filter(Boolean))];
}

const WINDOWS_SYSTEM = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
// The root itself is listed, and is matched only as itself (see guard.mjs): everything is "inside" it.
const POSIX_SYSTEM = ['/', '/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/Applications', '/var'];
// macOS keeps /etc at /private/etc, and a path that has been resolved shows the real place. (/private/var is left out on
// purpose: the temporary folders the app writes to live there.)
const DARWIN_REAL = ['/private/etc'];

// Folders where writes are refused, and where a folder cannot be handed to an agent as an extra writable folder.
export function systemDirs(platform = process.platform) {
  if (platform === 'win32') return [...WINDOWS_SYSTEM];
  return platform === 'darwin' ? [...POSIX_SYSTEM, ...DARWIN_REAL] : [...POSIX_SYSTEM];
}

// What the refusal says. The Windows words stay as they were, because the options tests quote them.
export const systemMessage = (platform = process.platform) =>
  (platform === 'win32' ? 'Windows system folders are read-only here.' : 'Operating system folders are read-only here.');
