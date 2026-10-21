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

// True when the path is a credential folder or is inside one. realPath should already be resolved; it is normalised
// here as well, so a trailing separator or forward slashes cannot slip past the check.
export function isCredentialPath(realPath, { platform = process.platform, home = HOME } = {}) {
  const P = pathFor(platform);
  const p = lower(P.resolve(realPath));
  return secretPaths(home, platform).map(lower).some(d => under(d, p, P.sep));
}

// realPath should already be resolved (no symlinks left to follow).
export function checkAccess(realPath, { write = false, platform = process.platform, home = HOME, appRoot = APP_ROOT } = {}) {
  const P = pathFor(platform);
  const p = lower(realPath);
  if (isCredentialPath(realPath, { platform, home })) throw new Error('That folder holds credentials and is off limits.');
  if (write && systemDirs(platform).map(lower).some(d => underSystem(d, p, P.sep))) throw new Error(systemMessage(platform));
  if (write && under(lower(appRoot), p, P.sep)) {
    throw new Error('Plenum changes its own files through propose_update, so they are not written directly.');
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

// Returns null when a folder is safe to grant to an agent as an extra writable folder, or a short plain message
// saying why not. Refused: a drive or filesystem root; the user's folder or any folder above it; a credential folder,
// anything inside one, or a folder that holds one; Plenum's own folder, anything inside it, or a folder that holds it;
// and the system folders (Windows, or the macOS and Linux ones). Links and junctions are followed, and the path as
// written is checked as well.
export function folderRisk(absPath, { platform = process.platform, home = HOME, appRoot = APP_ROOT } = {}) {
  const P = pathFor(platform);
  const text = typeof absPath === 'string' ? plainPath(absPath, platform) : '';
  if (!text || !P.isAbsolute(text)) return 'The folder must be a full path.';
  const written = lower(P.resolve(text));
  const real = lower(resolvedPlace(text, platform));
  const ctx = { P, platform, home, appRoot };
  for (const p of new Set([written, real])) {
    const message = riskAt(p, ctx);
    if (message) return message;
  }
  return null;
}

// The reason a resolved, lower-cased folder is refused, or null. Each reference place is compared as written and as
// it really is, so a link to a credential folder is caught as well as the folder itself.
function riskAt(p, { P, platform, home, appRoot }) {
  if (trimSep(p) === trimSep(lower(P.parse(p).root))) return ROOT_MESSAGE;
  if (placesOf(home, platform).some(h => isWithin(h, p, P.sep))) return HOME_MESSAGE;
  const secrets = secretPaths(home, platform).flatMap(s => placesOf(s, platform));
  if (secrets.some(s => isWithin(p, s, P.sep))) return CREDENTIAL_MESSAGE;
  if (secrets.some(s => isWithin(s, p, P.sep))) return HOLDS_CREDENTIAL_MESSAGE;
  const plenum = placesOf(appRoot, platform);
  if (plenum.some(a => isWithin(p, a, P.sep))) return PLENUM_MESSAGE;
  if (plenum.some(a => isWithin(a, p, P.sep))) return HOLDS_PLENUM_MESSAGE;
  if (systemDirs(platform).map(lower).some(s => (trimSep(s) ? isWithin(p, s, P.sep) : p === s))) return systemMessage(platform);
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
