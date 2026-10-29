import fs from 'node:fs';
import os from 'node:os';
import { APP_ROOT } from './updates.mjs';
import { credentialPaths, pathFor, plenumDataDirs, systemDirs, systemMessage } from './platform/paths.mjs';

// Places the agent never touches, whatever the approval mode: credential stores, and the operating system's folders
// for writes. Muse Console's own source is changed through propose_update, so it is not written directly.
// The lists of credential and system folders are in lib/platform/paths.mjs, for Windows, macOS and Linux. Every function
// here takes its options last: platform defaults to process.platform, home to the user's folder and appRoot to Plenum's
// own folder, so a test can ask what a macOS or Linux path would do. A platform other than the one running cannot be
// checked against this machine's disk, so its paths are judged as written (no links are followed).
// The credential list is the sign-in folders under the home folder plus Plenum's own data folders (%APPDATA%\Plenum on
// Windows, ~/Library/Application Support/Plenum on macOS, ~/.config/Plenum on Linux), where the desktop app keeps its saved keys.
const HOME = os.homedir();
const lower = p => p.toLowerCase();
// The state folder in use is off limits too. By default it is ~/.muse-console (already in credentialPaths), but
// MUSE_CONSOLE_HOME can move it, and it holds state.json, checkpoints and the applied-updates overlay. Only this machine's
// own setting counts, so a check for another platform is not affected.
const stateHome = platform => {
  const dir = process.env.MUSE_CONSOLE_HOME;
  return platform === process.platform && typeof dir === 'string' && pathFor(platform).isAbsolute(dir) ? [pathFor(platform).resolve(dir)] : [];
};
const secretPaths = (home, platform) => [...credentialPaths(home, platform), ...plenumDataDirs({ platform, home }), ...stateHome(platform)];
const SECRET_PATHS = secretPaths(HOME, process.platform);
export const SECRET_DIRS = SECRET_PATHS.map(lower);
const under = (dir, p, sep) => p === dir || p.startsWith(dir + sep);

// The folder that holds every thread's isolated copy (pro-02, lib/worktree.mjs): %LOCALAPPDATA%\PlenumWT on Windows, ~/.plenum-wt on macOS
// and Linux. It is read from the environment each time, so a test can point LOCALAPPDATA somewhere else. It is never under ~/.muse-console
// (which is off limits to every tool, so a copy there could not be read by its own agent) and never under OneDrive.
export function worktreeRoot({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const P = pathFor(platform);
  if (platform === 'win32') {
    const given = env?.LOCALAPPDATA;
    const local = typeof given === 'string' && given && P.isAbsolute(given) ? given : P.join(home, 'AppData', 'Local');
    return P.join(local, 'PlenumWT');
  }
  return P.join(home, '.plenum-wt');
}

// True when a path is the isolated-copies folder or lies inside it. The path is compared as written and as it really is (links followed),
// and so is the folder, so a link into a copy is caught too. Only the platform that is running has a disk to ask.
export function insideWorktreeRoot(p, options = {}) {
  return copyOfWorktree(p, options) !== null;
}

// Which isolated copy a path belongs to: the lower-case path of the copy's own folder (the first folder under the copies folder),
// '' for the copies folder itself, and null for a path outside it. A path is judged as written and as it really is; when the two
// differ the one that is inside the copies folder counts. Used to tell "my own copy" from "another thread's copy" (lib/tools.mjs).
export function copyOfWorktree(p, { platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const P = pathFor(platform);
  if (typeof p !== 'string' || !p) return null;
  const root = worktreeRoot({ platform, home, env: platform === process.platform ? env : {} });
  // The real forms come first, so a path and a folder that were both resolved name the same copy the same way.
  const forms = [...new Set([lower(resolvedPlace(p, platform)), lower(P.resolve(p))])];
  for (const place of new Set([lower(resolvedPlace(root, platform)), lower(P.resolve(root))])) {
    for (const f of forms) {
      if (!isWithin(f, place, P.sep)) continue;
      const first = f.slice(trimSep(place).length + 1).split(/[\\/]/)[0];
      return first ? `${trimSep(place)}${P.sep}${first}` : '';
    }
  }
  return null;
}

// File names that mark a file as holding a secret, wherever it sits in a project. This is the one list for everything that must not
// copy such a file somewhere else: the turn snapshots (lib/shadow.mjs) leave these files out whatever a .gitignore says, and a rewind
// neither writes nor removes them. Nothing in this file refuses a path because of it. A pattern is matched against the file's name only
// (not its folders), ignoring case, and '*' stands for any run of characters. The exceptions are names that look like a secret's but hold
// none: the example files that projects commit, and public keys.
export const SECRET_FILE_PATTERNS = Object.freeze([
  '.env', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials',
  'credentials.json', 'client_secret*.json', 'service-account*.json', '*.tfstate',
]);
export const SECRET_FILE_EXCEPTIONS = Object.freeze(['.env.example', '.env.sample', '.env.template', 'id_*.pub']);

const nameMatcher = glob => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const SECRET_NAME_RES = SECRET_FILE_PATTERNS.map(nameMatcher);
const SECRET_EXCEPTION_RES = SECRET_FILE_EXCEPTIONS.map(nameMatcher);

// True when the last part of a path (written with / or \) is a secret file name: it fits a SECRET_FILE_PATTERNS entry and no
// SECRET_FILE_EXCEPTIONS entry.
export function isSecretFileName(p) {
  const name = String(p ?? '').split(/[\\/]/).pop();
  if (!name || SECRET_EXCEPTION_RES.some(re => re.test(name))) return false;
  return SECRET_NAME_RES.some(re => re.test(name));
}

// The last part of a path as a diff header or a ---/+++ line writes it (a quoted path has its quotes dropped).
const headerName = text => {
  const t = text.replace(/\t.*$/, '').trim().replace(/^"|"$/g, '');
  return t.slice(t.lastIndexOf('/') + 1);
};

// The diff without the sections of secret files. A section starts at its "diff --git" line, which no line inside a section can
// imitate (those start with a space, +, - or a backslash), and its header lines run to the first hunk. A section is dropped when any
// name in its header is a secret file name: the "diff --git" line, a ---/+++ line or a rename or copy line. The snapshot diffs
// (lib/shadow.mjs) and @diff in a git folder (lib/files.mjs workingDiff) both use it, so a secret file's change reaches no model.
export function dropSecretSections(text) {
  if (!text.includes('diff --git ')) return text;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith('diff --git ')) end += 1;
    const names = [headerName(lines[i].slice('diff --git '.length))];
    for (let k = i + 1; k < end && !lines[k].startsWith('@@'); k += 1) {
      const m = /^(?:--- |\+\+\+ |rename (?:from|to) |copy (?:from|to) )(.*)$/.exec(lines[k]);
      if (m) names.push(headerName(m[1]));
    }
    if (!names.some(isSecretFileName)) out.push(...lines.slice(i, end));
    i = end;
  }
  return out.join('\n');
}

// True when the path is a credential folder or is inside one. realPath should already be resolved; it is normalised
// here as well, so a trailing separator or forward slashes cannot slip past the check.
export function isCredentialPath(realPath, { platform = process.platform, home = HOME } = {}) {
  const P = pathFor(platform);
  const p = lower(P.resolve(realPath));
  return secretPaths(home, platform).map(lower).some(d => under(d, p, P.sep));
}

// What a write into another thread's isolated copy is refused with (pro-02). It holds in every approval mode.
export const OTHER_COPY_MESSAGE = "That folder is another thread's isolated copy. Each thread changes only its own copy.";

// realPath should already be resolved (no symlinks left to follow).
// copyRoot (pro-02) is the folder the run works in. When it is given, a write into the isolated copies folder is allowed only into the
// copy that copyRoot belongs to; a run whose folder is not a copy cannot write into any copy. Callers that do not pass it are unchanged.
export function checkAccess(realPath, { write = false, platform = process.platform, home = HOME, appRoot = APP_ROOT, copyRoot } = {}) {
  const P = pathFor(platform);
  const p = lower(realPath);
  if (isCredentialPath(realPath, { platform, home })) throw new Error('That folder holds credentials and is off limits.');
  if (write && systemDirs(platform).map(lower).some(d => underSystem(d, p, P.sep))) throw new Error(systemMessage(platform));
  if (write && under(lower(appRoot), p, P.sep)) {
    throw new Error('Plenum changes its own files through propose_update, so they are not written directly.');
  }
  if (write && typeof copyRoot === 'string' && copyRoot) {
    const copy = copyOfWorktree(realPath, { platform, home });
    if (copy !== null && copy !== copyOfWorktree(copyRoot, { platform, home })) throw new Error(OTHER_COPY_MESSAGE);
  }
}

// ---------- folderRisk: may a folder be granted to an agent as an extra writable folder? ----------

const MAX_LINKS = 32;
const ROOT_MESSAGE = 'A whole drive or filesystem root cannot be an extra folder. Name a folder inside it.';
const HOME_MESSAGE = 'That folder is your user folder or contains it, so it could reach your sign-in files there. Name a narrower folder.';
const CREDENTIAL_MESSAGE = 'That folder holds credentials and is off limits.';
const HOLDS_CREDENTIAL_MESSAGE = 'That folder contains a credential folder, so it is off limits. Name a narrower folder.';
const PLENUM_MESSAGE = 'Plenum changes its own files through propose_update, so they are not written directly.';
const HOLDS_PLENUM_MESSAGE = 'That folder contains the Plenum source folder, so it is off limits. Name a narrower folder.';
const COPY_MESSAGE = 'That folder is a thread\'s isolated copy. Open its thread instead.';

// Returns null when a folder is safe to grant to an agent as an extra writable folder, or a short plain message
// saying why not. Refused: a drive or filesystem root; the user's folder or any folder above it; a credential folder,
// anything inside one, or a folder that holds one; Plenum's own folder, anything inside it, or a folder that holds it;
// the system folders (Windows, or the macOS and Linux ones); and the folder of the threads' isolated copies with everything in it
// (pro-02: a copy cannot be added as a project or handed to an agent as an extra folder). copiesOk: true leaves that last rule out,
// for the one caller that checks the copies folder itself (lib/worktree.mjs, before it makes the folder). Links and junctions
// are followed, and the path as written is checked as well.
export function folderRisk(absPath, { platform = process.platform, home = HOME, appRoot = APP_ROOT, copiesOk = false } = {}) {
  const P = pathFor(platform);
  const text = typeof absPath === 'string' ? plainPath(absPath, platform) : '';
  if (!text || !P.isAbsolute(text)) return 'The folder must be a full path.';
  const written = lower(P.resolve(text));
  const real = lower(resolvedPlace(text, platform));
  const ctx = { P, platform, home, appRoot, copiesOk };
  for (const p of new Set([written, real])) {
    const message = riskAt(p, ctx);
    if (message) return message;
  }
  return null;
}

// The reason a resolved, lower-cased folder is refused, or null. Each reference place is compared as written and as
// it really is, so a link to a credential folder is caught as well as the folder itself.
function riskAt(p, { P, platform, home, appRoot, copiesOk }) {
  if (trimSep(p) === trimSep(lower(P.parse(p).root))) return ROOT_MESSAGE;
  if (placesOf(home, platform).some(h => isWithin(h, p, P.sep))) return HOME_MESSAGE;
  const secrets = secretPaths(home, platform).flatMap(s => placesOf(s, platform));
  if (secrets.some(s => isWithin(p, s, P.sep))) return CREDENTIAL_MESSAGE;
  if (secrets.some(s => isWithin(s, p, P.sep))) return HOLDS_CREDENTIAL_MESSAGE;
  const plenum = placesOf(appRoot, platform);
  if (plenum.some(a => isWithin(p, a, P.sep))) return PLENUM_MESSAGE;
  if (plenum.some(a => isWithin(a, p, P.sep))) return HOLDS_PLENUM_MESSAGE;
  if (systemDirs(platform).map(lower).some(s => (trimSep(s) ? isWithin(p, s, P.sep) : p === s))) return systemMessage(platform);
  if (!copiesOk) {
    const copies = placesOf(worktreeRoot({ platform, home, env: platform === process.platform ? process.env : {} }), platform);
    if (copies.some(c => isWithin(p, c, P.sep))) return COPY_MESSAGE;
  }
  return null;
}

// True when p is inside the system folder dir or is it. The filesystem root is in the POSIX list, and everything is
// inside it, so it counts only as itself.
function underSystem(dir, p, sep) {
  return trimSep(dir) ? under(dir, p, sep) : p === dir;
}

// True when p is the folder dir or lies inside it. Both are lower-cased and resolved.
function isWithin(p, dir, sep) {
  return p === dir || p.startsWith(trimSep(dir) + sep);
}

// A root keeps its trailing separator in a path; this drops it, so 'c:\' and 'c:' compare the same way.
function trimSep(s) {
  return s.replace(/[\\/]+$/, '');
}

// The two forms of a place that the checks compare: as written, and as it really is (links followed).
function placesOf(p, platform) {
  return [...new Set([lower(pathFor(platform).resolve(p)), lower(resolvedPlace(p, platform))])];
}

// On Windows a \\?\ or \\.\ prefix names the same place without it, so it is removed before the comparison.
function plainPath(p, platform) {
  if (platform !== 'win32') return p;
  return p.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\/, '');
}

// The place a path really is. Symlinks and junctions are followed as far as the path exists, and the part that does
// not exist yet is kept as written after the part that does. A link to a missing place is followed to where it points.
// Falls back to the path as written when nothing can be resolved. Only the platform that is running has a disk to ask.
function resolvedPlace(p, platform, depth = 0) {
  const P = pathFor(platform);
  const full = P.resolve(p);
  if (platform !== process.platform) return full;
  let dir = full;
  const tail = [];
  for (;;) {
    try {
      return P.join(fs.realpathSync.native(dir), ...tail);
    } catch {
      const target = linkTarget(dir);
      if (target !== null && depth < MAX_LINKS) {
        return resolvedPlace(P.resolve(P.dirname(dir), target, ...tail), platform, depth + 1);
      }
      const parent = P.dirname(dir);
      if (parent === dir) return full;
      tail.unshift(P.basename(dir));
      dir = parent;
    }
  }
}

// Where a link points, or null when the path is not a link (or cannot be read).
function linkTarget(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}
