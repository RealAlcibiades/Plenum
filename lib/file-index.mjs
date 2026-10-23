// The file list behind the @ picker (pro-09). indexFor(root) answers with the files and folders of a project folder, for the picker in
// public/ext-mentions.js to filter. Two sources:
//   - git: git's own list of tracked and untracked files, with ignored ones left out (git ls-files through lib/git-run.mjs, so no
//     fsmonitor, hook or filter program of the repository runs);
//   - walk: outside a repository, a walk that skips SNAP_SKIP (lib/delegate.mjs) and applies the root .gitignore ('#' and blank lines
//     skipped, '!' lines ignored; 'name', 'dir/', '*.ext' and a leading '/' supported; a slash inside a pattern anchors it).
// Nothing is written to the folder. The list never holds:
//   - a path with a .git segment;
//   - a credential folder, or a file whose link (a symbolic link or junction on the way) leads into one (isCredentialPath);
//   - anything inside Plenum's own source (APP_ROOT), or a file whose link leads into it;
//   - more than SNAP_FILES_MAX entries: the rest are cut and truncated is true.
// The walk is bounded three ways, and truncated is true when any one stops it: WALK_MAX files, WALK_DIRS_MAX folders (the nearest ones
// are read) and WALK_BUDGET_MS of time, so a tree of very many folders is not read to the end.
// forbiddenPlace and realAppRoot are shared with the turn snapshots (lib/shadow.mjs), which refuse the same places behind a link.
// A folder is an entry with a trailing '/' and dir: true when a listed file is inside it. secret: true marks a name that may hold
// secrets (lib/guard.mjs isSecretFileName, the list the snapshots leave out; the picker says so); space: true marks a path with a
// space (the picker cannot insert it, see the attach button).
// The result is cached per folder for CACHE_MS. refresh rebuilds at most once every REFRESH_MS; a refresh inside that time gets the
// cached list. Concurrent calls for one folder share one build.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGit } from './git-run.mjs';
import { SNAP_FILES_MAX, SNAP_SKIP } from './delegate.mjs';
import { isCredentialPath, isSecretFileName } from './guard.mjs';
import { APP_ROOT } from './updates.mjs';

export const CACHE_MS = 60_000;
export const REFRESH_MS = 2_000;
// The walk stops collecting after this many files, so a very large folder is not read in full. The walk is breadth first, so the files
// nearest the top are the ones kept. truncated is then true.
const WALK_MAX = SNAP_FILES_MAX * 2;
// It also stops after this many folders have been read (a folder past the cap is never queued) or when this much time has passed, whichever
// comes first. The folders are read one at a time, so a tree of very many small folders would otherwise hold the build for as long as it is.
export const WALK_DIRS_MAX = 50_000;
export const WALK_BUDGET_MS = 15_000;
// How many candidates are checked at once (their lstat calls run together).
const CHUNK = 256;
const CACHE_LIMIT = 16;
const WIN = process.platform === 'win32';

const fold = p => (WIN ? p.toLowerCase() : p);
// True when p is dir or lies inside it. Both are resolved paths.
export function inside(dir, p) {
  const d = fold(dir);
  const q = fold(p);
  return q === d || q.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}
const credentialOpts = home => (home ? { home } : {});

// Plenum's source folder as it really is on disk (links followed); as written when it cannot be resolved.
export async function realAppRoot(appRoot = APP_ROOT) {
  return fs.realpath(appRoot).catch(() => path.resolve(appRoot));
}

// True when a place that is already resolved (every link followed) is one that no list and no snapshot may read: a credential folder
// (isCredentialPath: the sign-in folders, Plenum's data folders and the state folder) or Plenum's own source (appReal, from realAppRoot).
// home is the user's folder the credential check uses, for tests.
export function forbiddenPlace(place, { appReal, home } = {}) {
  return isCredentialPath(place, credentialOpts(home)) || inside(appReal ?? path.resolve(APP_ROOT), place);
}

// ---------- .gitignore (the walk only) ----------

// The rules of a .gitignore text. Each rule is { re, anchored, dirOnly }. Anchored rules match the path from the folder root; the others
// match the name of an entry at any depth, as git does.
export function ignoreRules(text) {
  const rules = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1);
    }
    if (line.includes('/')) anchored = true;
    if (!line) continue;
    rules.push({ re: globRegExp(line), anchored, dirOnly });
  }
  return rules;
}

// A glob with '*' (any run of characters inside one name) and '?' (one character). Everything else is literal.
function globRegExp(glob) {
  let source = '';
  for (const ch of glob) {
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, WIN ? 'i' : '');
}

// True when a rule ignores the entry rel (a path with '/' separators), which is a folder when isDir.
export function ignored(rules, rel, isDir) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return rules.some(rule => (!rule.dirOnly || isDir) && rule.re.test(rule.anchored ? rel : base));
}

// ---------- the two sources ----------

// Git's list: tracked and untracked files that are not ignored, relative to the folder. null when the folder is not in a repository
// (or git cannot run), so the walk is used instead.
async function gitFiles(real) {
  const r = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: real, timeoutMs: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok) return null;
  return r.stdout.split('\0').filter(Boolean).map(rel => ({ rel, link: null }));
}

// The walk: breadth first, so the top of the folder comes first. A folder that is a link is not entered; a link to a file is a candidate
// (checked when it is vetted). Each candidate is { rel, link } where link is false for a plain file found by readdir.
// It stops with truncated true after WALK_MAX files, when dirMax folders are queued (the rest are not read) or when the time is spent.
// The top folder is always read; the clock is looked at before each folder after it.
async function walkFiles(real, rules, { dirMax = WALK_DIRS_MAX, budgetMs = WALK_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  const files = [];
  const queue = [''];
  let capped = false;
  for (let at = 0; at < queue.length; at += 1) {
    if (at > 0 && Date.now() >= deadline) return { files, truncated: true };
    const dir = queue[at];
    const entries = await fs.readdir(path.join(real, dir), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SNAP_SKIP.has(entry.name) || ignored(rules, rel, true)) continue;
        if (queue.length >= Math.max(1, dirMax)) {
          capped = true;
          continue;
        }
        queue.push(rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (ignored(rules, rel, false)) continue;
        if (files.length >= WALK_MAX) return { files, truncated: true };
        files.push({ rel, link: entry.isSymbolicLink() });
      }
    }
  }
  return { files, truncated: capped };
}

// ---------- vetting ----------

// True when a candidate may be listed. Plain files found by the walk need no check here: readdir showed them as files, and the walk
// enters no link. Anything else is looked at on disk: it must still exist, and when it is a link, or a folder on its path is one, the
// place it really is must be a file that is neither a credential nor inside Plenum's source.
function vetter({ real, appReal, home }) {
  const stats = new Map();
  const lstatOf = abs => {
    if (!stats.has(abs)) stats.set(abs, fs.lstat(abs).catch(() => null));
    return stats.get(abs);
  };
  return async ({ rel, link }) => {
    const abs = path.join(real, rel);
    let place = abs;
    if (link !== false) {
      const st = await lstatOf(abs);
      if (!st) return false;
      let linked = st.isSymbolicLink();
      if (!linked && link === null) {
        const parts = rel.split('/');
        for (let i = 1; i < parts.length && !linked; i += 1) {
          linked = (await lstatOf(path.join(real, ...parts.slice(0, i))))?.isSymbolicLink() === true;
        }
      }
      if (linked) {
        try {
          place = await fs.realpath(abs);
        } catch {
          return false;
        }
        const target = await fs.stat(place).catch(() => null);
        if (!target?.isFile()) return false;
      } else if (!st.isFile()) {
        return false;
      }
    }
    return !forbiddenPlace(place, { appReal, home });
  };
}

// The part of a path that is not a credential, a .git folder or Plenum's source, before anything is read from disk.
function lexicallyListable(real, appLex, opts) {
  return rel => {
    if (rel.split('/').some(part => part.toLowerCase() === '.git')) return false;
    const abs = path.join(real, rel);
    return !isCredentialPath(abs, opts) && !inside(appLex, abs);
  };
}

// The number of folders above a path plus one: 'a.txt' is 1, 'src/lib/x.ts' is 3. Counted once per entry, not per comparison.
const depthOf = rel => {
  let n = 1;
  for (let i = 0; i < rel.length; i += 1) if (rel.charCodeAt(i) === 47) n += 1;
  return n;
};
const byDepthThenName = (a, b) => a.depth - b.depth || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
const byPath = (a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0);

// Builds the list for a folder. Options (for tests): home (the user's folder the credential check uses), appRoot (Plenum's source,
// APP_ROOT by default), and dirMax and budgetMs (the walk's folder cap and time budget, WALK_DIRS_MAX and WALK_BUDGET_MS by default).
// Resolves to { files, truncated, source, at }.
export async function buildIndex(root, { home, appRoot = APP_ROOT, dirMax, budgetMs } = {}) {
  const real = await fs.realpath(root);
  const appLex = path.resolve(appRoot);
  const appReal = await realAppRoot(appRoot);
  const opts = credentialOpts(home);
  const fromGit = await gitFiles(real);
  let source = 'walk';
  let raw;
  let truncated = false;
  if (fromGit) {
    source = 'git';
    raw = fromGit;
  } else {
    const rules = ignoreRules(await fs.readFile(path.join(real, '.gitignore'), 'utf8').catch(() => ''));
    const walked = await walkFiles(real, rules, { dirMax, budgetMs });
    raw = walked.files;
    truncated = walked.truncated;
  }
  const listable = lexicallyListable(real, appLex, opts);
  // Shallow paths first, so a folder past the cap loses its deepest files. The lexical checks run as the list fills, not on every entry.
  const candidates = raw.map(entry => ({ ...entry, depth: depthOf(entry.rel) })).sort(byDepthThenName);
  const vet = vetter({ real, appReal, home });
  const out = [];
  const folders = new Set();
  // A walk that stopped early still lists what it found (the nearest files); truncated says the rest is missing.
  let cut = false;
  for (let at = 0; at < candidates.length && !cut; at += CHUNK) {
    const chunk = candidates.slice(at, at + CHUNK).filter(entry => listable(entry.rel));
    const passed = await Promise.all(chunk.map(vet));
    for (let i = 0; i < chunk.length && !cut; i += 1) {
      if (!passed[i]) continue;
      const rel = chunk[i].rel;
      const parts = rel.split('/');
      const dirs = [];
      for (let k = 1; k < parts.length; k += 1) {
        const dir = parts.slice(0, k).join('/');
        if (!folders.has(dir)) dirs.push(dir);
      }
      if (out.length + dirs.length + 1 > SNAP_FILES_MAX) {
        cut = true;
        break;
      }
      for (const dir of dirs) {
        folders.add(dir);
        out.push({ p: `${dir}/`, dir: true, ...(dir.includes(' ') ? { space: true } : {}) });
      }
      out.push({ p: rel, ...(isSecretFileName(rel) ? { secret: true } : {}), ...(rel.includes(' ') ? { space: true } : {}) });
    }
  }
  out.sort(byPath);
  return { files: out, truncated: cut || truncated, source, at: Date.now() };
}

// ---------- cache ----------

const cache = new Map();
const building = new Map();

// The list for a folder, from the cache when it is fresh (CACHE_MS old at most). refresh=true rebuilds it unless it was built less than
// REFRESH_MS ago. A failed build is not cached; it rejects with the error.
export async function indexFor(root, { refresh = false } = {}) {
  const key = path.resolve(root);
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.built : Infinity;
  if (hit && age < (refresh ? REFRESH_MS : CACHE_MS)) return hit.data;
  if (building.has(key)) return building.get(key);
  const job = buildIndex(key)
    .then(data => {
      cache.delete(key);
      cache.set(key, { data, built: Date.now() });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return data;
    })
    .finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

// Drops the cached lists (for the tests and for a project whose folder was moved).
export function forgetIndexes() {
  cache.clear();
}
