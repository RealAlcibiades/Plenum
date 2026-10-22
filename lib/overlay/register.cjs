'use strict';
// Bootstrap for applied Plenum updates. It runs before any ES module is loaded (plenum.mjs and desktop/server-entry.cjs call
// activate() first), and it is never overlaid itself: an update cannot replace the thing that decides which code runs.
//
// An applied update lives in <state folder>/overlay/ (see lib/updates.mjs), never in the install folder:
//   manifest.json  { version: 1, active: n | null, generations: [{ n, dir: 'gen-<n>', files: [{ path, sha256 }], appliedAt,
//                    updateId, summary, previous }] }. The one rename that writes it is the switch to a new generation.
//   gen-<n>/<rel>  every file of generation n. A generation is complete on its own.
//   pending.json   { gen, previous, attempts } while the newest generation has not yet started cleanly. attempts is 0 after an
//                  apply and 1 once this bootstrap has let the generation start; the server deletes the file when it listens
//                  (lib/overlay.mjs markHealthy). A start that finds attempts already at 1 means the last start never got
//                  healthy, so this start goes back to `previous`.
//   rollback.json  { from, to, at, reason } after an automatic rollback, until the page acknowledges it.
// The active generation is loaded by a module resolve hook (hooks.mjs): an import that resolves to a file in the install folder
// is answered with the same relative path in the generation, when the generation has that file. Nothing in the install folder is
// ever written.
//
// activate() never throws. Any trouble reading the overlay means the shipped files run, and rollback.json says why.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

// The same rules as normalizeRel in lib/updates.mjs (a test keeps the two in step). This file cannot import that one: it is an ES
// module, and loading it here would load it before the hook that lets an update replace it.
const ALLOWED = [
  /^server\.mjs$/,
  /^lib\/(?:(?:routes|tools|prompt-parts)\/)?[\w.-]+\.mjs$/,
  /^public\/[\w.-]+\.(html|js|css)$/,
];
const BLOCKED = [/^lib\/overlay\.mjs$/i, /^lib\/overlay\//i, /^lib\/auth\.mjs$/i];
// The legal gate and the safety notices (lib/legal.mjs, lib/notices.mjs, their routes and panels, every file under legal/): the same
// four rules as LEGAL_BLOCKED in lib/updates.mjs, which a test keeps in step. A list of its own so BLOCKED stays equal to the one in
// lib/updates.mjs. The Updates panel never carries these, so a generation that lists one was not made by it, and activate() does not
// run such a generation at all (see legalListed).
const LEGAL_BLOCKED = [
  /^lib\/(?:legal|notices)\.mjs$/i,
  /^lib\/routes\/(?:legal|notices)\.mjs$/i,
  /^public\/ext-(?:legal|notices)\.(?:js|css)$/i,
  /^legal\//i,
];

// The path in forward slashes, or null when it is not an updatable file.
function normalizeRel(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const rel = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) return null;
  if (BLOCKED.some(r => r.test(rel)) || LEGAL_BLOCKED.some(r => r.test(rel))) return null;
  return ALLOWED.some(r => r.test(rel)) ? rel : null;
}

// True when a manifest file entry names a legal gate or notices file, in any case or slash, and also with the trailing dots or spaces
// and the alternate-stream suffix that Windows drops when it opens a file. Ignoring the entry would not be enough: lib/overlay.mjs
// serves a generation's public/ files from the manifest's own list, so ext-legal and ext-notices would still come from the overlay.
function legalListed(f) {
  const p = isObject(f) ? f.path : undefined;
  if (typeof p !== 'string') return false;
  const rel = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const bare = rel.replace(/::\$.*$/, '').replace(/[. ]+$/, '');
  return LEGAL_BLOCKED.some(r => r.test(rel) || r.test(bare));
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isGen = n => Number.isInteger(n) && n >= 1;

// { state: 'none' } when the file does not exist, { state: 'damaged' } when it cannot be read or is not a manifest, else { state: 'ok', value }.
function readJson(file, check) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err && err.code === 'ENOENT' ? { state: 'none' } : { state: 'damaged' };
  }
  try {
    const value = JSON.parse(text);
    return check(value) ? { state: 'ok', value } : { state: 'damaged' };
  } catch {
    return { state: 'damaged' };
  }
}

function manifestOk(m) {
  if (!isObject(m) || m.version !== 1 || !Array.isArray(m.generations)) return false;
  if (m.active !== null && !isGen(m.active)) return false;
  const seen = new Set();
  for (const g of m.generations) {
    if (!isObject(g) || !isGen(g.n) || g.dir !== `gen-${g.n}` || !Array.isArray(g.files) || seen.has(g.n)) return false;
    seen.add(g.n);
  }
  return m.active === null || seen.has(m.active);
}

const pendingOk = p => isObject(p) && isGen(p.gen) && (p.previous === null || isGen(p.previous)) && Number.isInteger(p.attempts) && p.attempts >= 0;

// False when a file the generation lists is in its folder with other bytes than the manifest recorded, so it was changed outside the
// Updates panel. A listed file that is not there is skipped, as before: the shipped one runs for it.
function intact(gen, dir) {
  for (const f of gen.files) {
    const rel = normalizeRel(isObject(f) ? f.path : undefined);
    if (rel === null) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(dir, ...rel.split('/')));
    } catch {
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== (isObject(f) ? f.sha256 : undefined)) return false;
  }
  return true;
}

// Writes a file through a temporary name and renames it over the target, so a reader sees the old file or the new one.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function remove(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Left in place; the next start looks again.
  }
}

// Reads the overlay, settles a pending generation, and registers the resolve hook for the active one. Returns what it decided:
// { generation, dir, files, rolledBack }. generation is null when the shipped files run. It sets
//   process.env.MUSE_CONSOLE_APP_ROOT   the install folder (lib/updates.mjs and lib/guard.mjs read it)
//   process.env.PLENUM_OVERLAY_DIR      the active generation's absolute folder, or '' for none (lib/overlay.mjs reads it)
function activate({ appRoot, home } = {}) {
  const result = { generation: null, dir: '', files: [], rolledBack: false };
  try {
    const root = path.resolve(String(appRoot));
    process.env.MUSE_CONSOLE_APP_ROOT = root;
    process.env.PLENUM_OVERLAY_DIR = '';
    const base = path.resolve(String(home), 'overlay');
    const stop = () => result;
    const note = (from, to, reason) => {
      try {
        writeAtomic(path.join(base, 'rollback.json'), JSON.stringify({ from, to, at: new Date().toISOString(), reason }, null, 2));
      } catch {
        // The notice is lost; the files still run correctly.
      }
    };

    const read = readJson(path.join(base, 'manifest.json'), manifestOk);
    if (read.state === 'none') {
      remove(path.join(base, 'pending.json'));
      return stop();
    }
    if (read.state === 'damaged') {
      note(null, null, 'The applied updates could not be read');
      remove(path.join(base, 'pending.json'));
      return stop();
    }
    const manifest = read.value;
    const byN = new Map(manifest.generations.map(g => [g.n, g]));
    const usable = n => n !== null && byN.has(n) && fs.existsSync(path.join(base, byN.get(n).dir));
    const save = () => {
      try {
        writeAtomic(path.join(base, 'manifest.json'), JSON.stringify(manifest, null, 2));
      } catch {
        // The change is kept for this run only; the next start settles it again.
      }
    };
    const pendingFile = path.join(base, 'pending.json');
    let active = manifest.active;

    // The generation named by an unfinished pending.json is the one being tried. A pending file for another generation is left
    // over from a switch that never completed or from a manual rollback, and means nothing.
    const pending = readJson(pendingFile, pendingOk);
    if (pending.state === 'damaged' || (pending.state === 'ok' && pending.value.gen !== active)) {
      remove(pendingFile);
    } else if (pending.state === 'ok') {
      const back = () => (usable(pending.value.previous) ? pending.value.previous : null);
      if (pending.value.attempts >= 1) {
        // The last start of this generation never became healthy. Go back, and keep the generation's files for inspection.
        const to = back();
        note(pending.value.gen, to, 'Plenum did not start with it');
        manifest.active = to;
        active = to;
        save();
        remove(pendingFile);
        result.rolledBack = true;
      } else {
        try {
          writeAtomic(pendingFile, JSON.stringify({ ...pending.value, attempts: 1 }));
        } catch {
          // Without the counter a bad generation could loop, so it does not start. This run uses the one before it.
          const to = back();
          note(pending.value.gen, to, 'Plenum could not record this start');
          active = to;
          result.rolledBack = true;
        }
      }
    }

    // The active generation's folder must exist, or the manifest is pointing at nothing.
    if (active !== null && !usable(active)) {
      note(active, null, 'The applied updates could not be read');
      manifest.active = null;
      active = null;
      save();
      remove(pendingFile);
      result.rolledBack = true;
    }
    if (active === null) return stop();

    const gen = byN.get(active);
    const dir = path.join(base, gen.dir);
    // A generation that lists the legal gate or a notices file is not run at all either: the Updates panel never writes one, so this
    // was made outside it. The shipped files run, and rollback.json says why.
    if (gen.files.some(legalListed)) {
      note(active, null, 'An applied update held the legal gate or notices files, which updates never carry');
      manifest.active = null;
      save();
      remove(pendingFile);
      result.rolledBack = true;
      return stop();
    }
    // A generation with a file that no longer matches its checksum is not run at all: the shipped files run, and rollback.json says why.
    if (!intact(gen, dir)) {
      note(active, null, 'An applied update file was changed outside the Updates panel');
      manifest.active = null;
      save();
      remove(pendingFile);
      result.rolledBack = true;
      return stop();
    }
    const files = [];
    for (const f of gen.files) {
      const rel = normalizeRel(isObject(f) ? f.path : undefined);
      if (rel === null) continue;
      let isFile = false;
      try {
        isFile = fs.statSync(path.join(dir, ...rel.split('/'))).isFile();
      } catch {
        // A file the generation lacks is ignored: the shipped one runs.
      }
      if (isFile && !files.includes(rel)) files.push(rel);
    }
    try {
      require('node:module').register('./hooks.mjs', {
        parentURL: pathToFileURL(__filename),
        data: { appRoot: root, overlayDir: dir, files },
      });
    } catch {
      note(active, null, 'The applied updates could not be loaded');
      return stop();
    }
    process.env.PLENUM_OVERLAY_DIR = dir;
    result.generation = active;
    result.dir = dir;
    result.files = files;
    return result;
  } catch {
    process.env.PLENUM_OVERLAY_DIR = '';
    return { generation: null, dir: '', files: [], rolledBack: false };
  }
}

module.exports = { activate, normalizeRel, ALLOWED, BLOCKED, LEGAL_BLOCKED };
