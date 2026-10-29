import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The runtime side of applied updates (lib/updates.mjs writes them, lib/overlay/register.cjs and hooks.mjs load them).
// An applied Plenum update lives in <state folder>/overlay/, not in the install folder. The generation that is active holds
// every overlaid file; this module answers "which copy of this file is the one in use" for the code that reads Plenum's own files
// by path (the static page files, the folders of routes, tools and prompt parts), and for the code that imports them.
//
// The overlay is in effect only when the bootstrap ran (plenum.mjs or desktop/server-entry.cjs sets PLENUM_OVERLAY_DIR, empty
// when no generation is active). `node server.mjs` never runs the bootstrap, so it runs the shipped files and nothing else.
// This file is never overlaid: it is on the update block list with the rest of the loader.

const here = path.dirname(fileURLToPath(import.meta.url));
// Where the shipped code is. This file is never overlaid, so its own place is always the install folder.
export const CODE_ROOT = path.resolve(here, '..');
// The install folder, as far as updates are concerned: where they are compared with and what the overlay shadows. Tests point
// MUSE_CONSOLE_APP_ROOT at a scratch copy; the code that finds Plenum's own modules (routes, tools, prompt parts) passes CODE_ROOT, so
// moving this does not move the code that is running.
export const APP_ROOT = process.env.MUSE_CONSOLE_APP_ROOT || CODE_ROOT;
// The state folder, the same one lib/store.mjs uses, which every tool already refuses to touch.
const HOME = process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
export const OVERLAY_ROOT = path.join(HOME, 'overlay');

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isGen = n => Number.isInteger(n) && n >= 1;

// A manifest file entry's path, kept only when it cannot leave the generation's folder.
function safeRel(p) {
  if (typeof p !== 'string') return null;
  const rel = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) return null;
  return rel;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The manifest as the bootstrap reads it (lib/overlay/register.cjs manifestOk), or null when there is none or it is damaged.
export function manifest(root = OVERLAY_ROOT) {
  const m = readJsonFile(path.join(root, 'manifest.json'));
  if (!isObject(m) || m.version !== 1 || !Array.isArray(m.generations)) return null;
  if (m.active !== null && !isGen(m.active)) return null;
  const seen = new Set();
  for (const g of m.generations) {
    if (!isObject(g) || !isGen(g.n) || g.dir !== `gen-${g.n}` || !Array.isArray(g.files) || seen.has(g.n)) return null;
    seen.add(g.n);
  }
  if (m.active !== null && !seen.has(m.active)) return null;
  return m;
}

// The active generation, or null. Read at first use and again after an apply, a rollback or a reset (invalidate).
let cached;
export function invalidate() {
  cached = undefined;
}

function load() {
  // Undefined: the bootstrap did not run. Empty: it ran and no generation is active.
  const boot = process.env.PLENUM_OVERLAY_DIR;
  if (boot === undefined || boot === '') return null;
  const m = manifest();
  if (!m || m.active === null) return null;
  const gen = m.generations.find(g => g.n === m.active);
  if (!gen) return null;
  const files = new Set();
  for (const f of gen.files) {
    const rel = safeRel(isObject(f) ? f.path : undefined);
    if (rel) files.add(rel);
  }
  return { generation: gen.n, dir: path.join(OVERLAY_ROOT, gen.dir), files, appliedAt: gen.appliedAt ?? null, updateId: gen.updateId ?? null, summary: gen.summary ?? '' };
}

export function active() {
  if (cached === undefined) cached = load();
  return cached;
}

const parts = rel => {
  const clean = safeRel(rel);
  if (!clean) throw new Error(`Not a path inside Plenum: ${rel}`);
  return clean.split('/');
};

// The file in use for a path relative to the install folder (forward slashes): the active generation's copy when it has one,
// else the shipped file.
export function filePath(rel, root = APP_ROOT) {
  const names = parts(rel);
  const a = active();
  if (a && a.files.has(names.join('/'))) return path.join(a.dir, ...names);
  return path.join(root, ...names);
}

// The names of the files in a folder (relative to the install folder) that pass test: the shipped files and the generation's,
// merged, sorted, each name once. A subfolder is never listed.
export function listFiles(relDir, test = () => true, root = APP_ROOT) {
  const names = new Set();
  const dir = parts(relDir).join('/');
  try {
    for (const e of fs.readdirSync(path.join(root, ...dir.split('/')), { withFileTypes: true })) {
      if (e.isFile() && test(e.name)) names.add(e.name);
    }
  } catch {
    // A missing folder lists nothing.
  }
  const a = active();
  if (a) {
    for (const p of a.files) {
      if (path.posix.dirname(p) === dir && test(path.posix.basename(p))) names.add(path.posix.basename(p));
    }
  }
  return [...names].sort();
}

// The URL to import a file of Plenum by. It names the install path; the resolve hook answers with the generation's copy when
// the generation has one, and also when the file exists only there.
export function moduleUrl(rel, root = APP_ROOT) {
  return pathToFileURL(path.join(root, ...parts(rel))).href;
}

// The server calls this once it listens. Until then pending.json says the newest generation has not started cleanly.
export function markHealthy(root = OVERLAY_ROOT) {
  try {
    fs.rmSync(path.join(root, 'pending.json'), { force: true });
  } catch {
    // Left in place: the next start counts it as a start that never got healthy.
  }
}

// The record of the last automatic rollback, or null. A set-aside after a Plenum version change (register.cjs) also carries
// setAsideFor (the version the changes were made for) and version (the one now running); those two appear only when the file has them.
export function lastRollback(root = OVERLAY_ROOT) {
  const r = readJsonFile(path.join(root, 'rollback.json'));
  if (!isObject(r)) return null;
  const out = {
    from: isGen(r.from) ? r.from : null,
    to: isGen(r.to) ? r.to : null,
    at: typeof r.at === 'string' ? r.at : null,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 400) : '',
  };
  if (r.ignored === true) out.ignored = true;
  if (typeof r.setAsideFor === 'string') out.setAsideFor = r.setAsideFor.slice(0, 40);
  if (typeof r.version === 'string') out.version = r.version.slice(0, 40);
  return out;
}

export function clearRollback(root = OVERLAY_ROOT) {
  fs.rmSync(path.join(root, 'rollback.json'), { force: true });
}
