import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as overlay from './overlay.mjs';

// Update outbox. A bundle is queued by Claude (propose_update) and only changes Plenum when the user applies it in the Updates
// panel. Applying never writes the install folder: it makes a new generation of the overlay under the state folder
// (<home>/overlay/gen-<n>/, see lib/overlay.mjs and lib/overlay/register.cjs), checks it, and switches to it with one rename of
// overlay/manifest.json. A new generation is complete on its own: it holds the files of the one before it that the bundle does not
// replace. The last three generations are kept, so the one before is always there to go back to, and a generation that does not
// start is rolled back by the bootstrap on the next start (B-3). A failure before the switch removes the half-made generation and
// changes nothing (B-26).

// The install folder, where the shipped files are. Other modules import it from here.
export const APP_ROOT = overlay.APP_ROOT;

// What an update may carry. lib/overlay/register.cjs keeps a copy of these rules (a test keeps the two the same).
export const ALLOWED = [
  /^server\.mjs$/,
  /^lib\/(?:(?:routes|tools|prompt-parts)\/)?[\w.-]+\.mjs$/,
  /^public\/[\w.-]+\.(html|js|css)$/,
];
// What an update can never carry, even when ALLOWED would let it through: the loader that decides which code runs and the file that
// checks the request token. A new release changes them. Checked before ALLOWED so these paths get this answer, and compared
// without case so a spelling that differs only in case on Windows is blocked too. Other features add their entries here.
export const BLOCKED = [/^lib\/overlay\.mjs$/i, /^lib\/overlay\//i, /^lib\/auth\.mjs$/i];
const BLOCKED_MESSAGE = 'The update loader and the request token are not updatable from the app. Change them in a new release.';
// These belong to the install, and a copy of one in the overlay would do nothing.
const INSTALL_ONLY = /^(?:package\.json|README\.md|start\.bat)$/;

const MAX_FILE_BYTES = 300_000;
const MAX_TOTAL_BYTES = 1_500_000;
// How many generations are kept: the active one, the one it replaced, and one before that.
const KEEP_GENERATIONS = 3;
// A panel is a public/ext-*.js file. The server lists each one (lib/routes/ext-modules.mjs) and the page loads it on every page,
// so a new one is labelled as such in the Updates panel. The name length is the one ext-modules accepts.
const NEW_PANEL = /^public\/ext-[a-z0-9-]{1,40}\.js$/;

export function normalizeRel(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('Each file needs a path.');
  const rel = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`Path not allowed: ${p}`);
  }
  if (BLOCKED.some(r => r.test(rel))) throw new Error(BLOCKED_MESSAGE);
  if (INSTALL_ONLY.test(rel)) {
    throw new Error(`${rel} is not updatable: applied updates run from an overlay beside Plenum's data, so a copy of ${rel} would do nothing. Change it in a new release.`);
  }
  if (!ALLOWED.some(r => r.test(rel))) {
    throw new Error(`${rel} is not updatable. Allowed: server.mjs, lib/*.mjs (also in lib/routes, lib/tools and lib/prompt-parts), public/*.html|js|css.`);
  }
  return rel;
}

// Parses a JS module before it is allowed anywhere near the install.
async function syntaxCheck(rel, content, tmpDir) {
  if (!/\.(mjs|js)$/.test(rel)) return;
  await fs.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `check-${randomUUID()}.mjs`);
  await fs.writeFile(tmp, content);
  try {
    await new Promise((resolve, reject) => {
      execFile(process.execPath, ['--check', tmp], { windowsHide: true, timeout: 20_000 }, (err, _out, stderr) => {
        if (err) reject(new Error(`${rel} has a syntax error:\n${String(stderr).trim().slice(0, 1200)}`));
        else resolve();
      });
    });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

// Every relative specifier of a static import, a re-export, a side-effect import or a dynamic import() with a plain string. The
// scan between the keyword and "from" is capped, so a file of nothing but keywords cannot make it slow.
const IMPORT_SPECIFIER = /\b(?:import|export)\b[^'"`;]{0,2000}?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

// B-3. node --check parses a module but never resolves its imports, so a bundle that imports a file that is not there passes it and
// then cannot start. This finds each relative import of each staged .mjs or .js file and requires the target to be staged too, or
// to be in the active generation, or in the install (`present(rel)` answers for the last two). It checks the file name as written,
// which is what a module import needs. A bare package name is not checked here.
export async function checkImports(staged, { present } = {}) {
  const stagedPaths = new Set(staged.map(f => f.rel));
  for (const f of staged) {
    if (!/\.(mjs|js)$/.test(f.rel)) continue;
    const checked = new Set();
    for (const m of String(f.content).matchAll(IMPORT_SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (typeof spec !== 'string' || !(spec.startsWith('./') || spec.startsWith('../')) || checked.has(spec)) continue;
      checked.add(spec);
      const target = path.posix.join(path.posix.dirname(f.rel), spec.split(/[?#]/, 1)[0]);
      const found = !target.startsWith('../') && (stagedPaths.has(target) || (typeof present === 'function' && await present(target)));
      if (!found) throw new Error(`${f.rel} imports ${spec}, which does not exist.`);
    }
  }
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const overlayRoot = home => path.join(home, 'overlay');
const relParts = rel => rel.split('/');

// Whether a path exists once an update is applied, apart from the files that update carries: in the active generation of this
// state folder, else in the install.
function presentIn(home) {
  const root = overlayRoot(home);
  const m = overlay.manifest(root);
  const gen = m && m.active !== null ? m.generations.find(g => g.n === m.active) : null;
  const held = new Set(gen ? gen.files.map(f => f?.path) : []);
  return async rel => (held.has(rel) && await isFile(path.join(root, gen.dir, ...relParts(rel)))) || isFile(path.join(APP_ROOT, ...relParts(rel)));
}

export async function queueUpdate({ home, summary, files }) {
  const text = String(summary ?? '').trim();
  if (!text) throw new Error('Give the update a summary.');
  if (!Array.isArray(files) || !files.length) throw new Error('An update needs at least one file.');
  const seen = new Set();
  const clean = [];
  let total = 0;
  for (const f of files) {
    const rel = normalizeRel(f?.path);
    if (seen.has(rel)) throw new Error(`Duplicate path in update: ${rel}`);
    seen.add(rel);
    const content = String(f?.content ?? '');
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES) throw new Error(`${rel} is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}.`);
    total += bytes;
    clean.push({ path: rel, content });
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`Update is ${total} bytes; the limit is ${MAX_TOTAL_BYTES}.`);
  const tmpDir = path.join(home, 'tmp');
  for (const f of clean) await syntaxCheck(f.path, f.content, tmpDir);
  await checkImports(clean.map(f => ({ rel: f.path, content: f.content })), { present: presentIn(home) });

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(home, 'outbox', id);
  await fs.mkdir(path.join(dir, 'files'), { recursive: true });
  for (const f of clean) {
    const dest = path.join(dir, 'files', f.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content);
  }
  const manifest = {
    id,
    summary: text.slice(0, 500),
    createdAt: new Date().toISOString(),
    files: clean.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content) })),
  };
  await fs.writeFile(path.join(dir, 'update.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function listUpdates(home) {
  const base = path.join(home, 'outbox');
  const ids = await fs.readdir(base).catch(() => []);
  const out = [];
  for (const id of ids.sort().reverse()) {
    const dir = path.join(base, id);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'update.json'), 'utf8').catch(() => 'null'));
    if (!manifest) continue;
    const files = [];
    for (const f of manifest.files) {
      const next = await fs.readFile(path.join(dir, 'files', f.path), 'utf8').catch(() => '');
      // The file in use: the active generation's copy when it has one, else the shipped file.
      const current = await fs.readFile(overlay.filePath(f.path), 'utf8').catch(() => null);
      const status = current === null
        ? (NEW_PANEL.test(f.path) ? 'new panel: loads on every page' : 'new file')
        : current === next ? 'unchanged' : 'changed';
      files.push({ path: f.path, bytes: f.bytes, status, lines: next.split('\n').length, preview: next.slice(0, 4000) });
    }
    out.push({ id, summary: manifest.summary, createdAt: manifest.createdAt, files });
  }
  return out;
}

// ---------- the overlay: generations ----------

// Renames, trying again a few times for the short locks that antivirus and indexers take on Windows.
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      await new Promise(r => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

// Writes a JSON file through a temporary name, flushed to disk, then renames it over the target: a reader or a crash sees the old
// file or the new one, never half of one.
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameRetry(tmp, file);
}

// The numbers of the gen-<n> and gen-<n>.tmp folders on disk, so a new generation never takes a number that something already holds.
async function numbersOnDisk(root) {
  const names = await fs.readdir(root).catch(() => []);
  return names.map(n => /^gen-(\d+)(?:\.tmp)?$/.exec(n)).filter(Boolean).map(m => Number(m[1]));
}

const genDirs = async root => (await fs.readdir(root).catch(() => [])).filter(n => /^gen-\d+(?:\.tmp)?$/.test(n));

// The text of an error with a full stop, so ' Nothing was applied.' reads as a sentence.
const sentence = err => {
  const text = String(err?.message ?? err).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

// Apply, roll back and reset all write the manifest and the generation folders, so they run one at a time. Two at once would work out
// the same generation number from the same manifest and remove each other's folders. A call that fails does not hold up the next one.
let queue = Promise.resolve();
const serial = fn => {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
};

export const applyUpdate = (home, id) => serial(() => applyNow(home, id));

async function applyNow(home, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Bad update id.');
  const dir = path.join(home, 'outbox', id);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'update.json'), 'utf8').catch(() => {
    throw new Error('No such update. It may already have been applied or discarded.');
  }));
  // Check everything again before anything is written.
  const staged = [];
  for (const f of manifest.files) {
    const rel = normalizeRel(f.path);
    const bytes = await fs.readFile(path.join(dir, 'files', rel));
    const content = bytes.toString('utf8');
    await syntaxCheck(rel, content, path.join(home, 'tmp'));
    staged.push({ rel, content, bytes, sha256: sha256(bytes) });
  }
  await checkImports(staged, { present: presentIn(home) });

  const root = overlayRoot(home);
  const current = overlay.manifest(root) ?? { version: 1, active: null, generations: [] };
  const from = current.active === null ? null : (current.generations.find(g => g.n === current.active) ?? null);
  const n = Math.max(0, current.active ?? 0, ...current.generations.map(g => g.n), ...await numbersOnDisk(root)) + 1;
  const tmpDir = path.join(root, `gen-${n}.tmp`);
  const finalDir = path.join(root, `gen-${n}`);
  const pendingFile = path.join(root, 'pending.json');
  // pending.json is written before the switch and put back if the switch fails. One that belongs to a generation that never became
  // healthy hands its own `previous` on, so a rollback goes back to the last one that did start.
  const priorPending = await fs.readFile(pendingFile, 'utf8').catch(() => null);
  let knownGood = current.active;
  try {
    const p = JSON.parse(priorPending ?? 'null');
    if (p && p.gen === current.active && (p.previous === null || Number.isInteger(p.previous))) knownGood = p.previous;
  } catch {
    // A damaged pending file is replaced below.
  }
  let switched = false;
  let renamed = false;
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
    const entries = new Map();
    const replaced = new Set(staged.map(s => s.rel));
    // The files of the generation in use that this bundle does not replace come along, so the new generation is complete.
    for (const f of from?.files ?? []) {
      let rel;
      try {
        rel = normalizeRel(f?.path);
      } catch {
        continue;
      }
      if (replaced.has(rel)) continue;
      const source = path.join(root, from.dir, ...relParts(rel));
      const dest = path.join(tmpDir, ...relParts(rel));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.copyFile(source, dest);
      } catch (err) {
        throw new Error(`Generation ${from.n} is missing ${rel} (${err.code ?? err.message}). Use "Remove all applied updates", then apply this update again.`);
      }
      const hash = sha256(await fs.readFile(dest));
      if (hash !== f.sha256) throw new Error(`${rel} in generation ${from.n} does not match its checksum. Use "Remove all applied updates", then apply this update again.`);
      entries.set(rel, hash);
    }
    // Each new file goes through a temporary name and a rename, and is read back and checked against the bundle.
    for (const f of staged) {
      const dest = path.join(tmpDir, ...relParts(f.rel));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const part = `${dest}.${process.pid}.new`;
      await fs.writeFile(part, f.bytes);
      await fs.rename(part, dest);
      if (sha256(await fs.readFile(dest)) !== f.sha256) throw new Error(`${f.rel} did not read back the way it was written.`);
      entries.set(f.rel, f.sha256);
    }
    await fs.rm(finalDir, { recursive: true, force: true });
    await renameRetry(tmpDir, finalDir);
    renamed = true;

    const record = {
      n,
      dir: `gen-${n}`,
      files: [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, hash]) => ({ path: p, sha256: hash })),
      appliedAt: new Date().toISOString(),
      updateId: id,
      summary: String(manifest.summary ?? '').slice(0, 500),
      previous: current.active,
    };
    const all = [...current.generations, record];
    const byN = new Map(all.map(g => [g.n, g]));
    const keep = [];
    for (let g = record; g && keep.length < KEEP_GENERATIONS; g = byN.get(g.previous)) keep.push(g.n);
    const kept = all.filter(g => keep.includes(g.n)).map(g => (g.previous !== null && !keep.includes(g.previous) ? { ...g, previous: null } : g));
    await writeJsonAtomic(pendingFile, { gen: n, previous: knownGood, attempts: 0 });
    // The switch: before this rename the running Plenum and the next start see the generation they had; after it, the new one, whole.
    await writeJsonAtomic(path.join(root, 'manifest.json'), { version: 1, active: n, generations: kept });
    switched = true;
    overlay.invalidate();
    const doomed = all.filter(g => !keep.includes(g.n)).map(g => g.dir);
    for (const name of [...doomed, ...(await genDirs(root)).filter(d => !keep.some(k => d === `gen-${k}`))]) {
      await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    if (switched) {
      // The new generation is active and complete; only the tidying after it failed.
    } else {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      // Only the folder this call renamed into place is removed, never one another call made.
      if (renamed) await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
      if (priorPending === null) await fs.rm(pendingFile, { force: true }).catch(() => {});
      else await fs.writeFile(pendingFile, priorPending).catch(() => {});
      await fs.rm(`${pendingFile}.tmp`, { force: true }).catch(() => {});
      await fs.rm(path.join(root, 'manifest.json.tmp'), { force: true }).catch(() => {});
      throw Object.assign(new Error(`${sentence(err)} Nothing was applied.`), { code: err?.code });
    }
  }
  await fs.mkdir(path.join(home, 'applied'), { recursive: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.rename(dir, path.join(home, 'applied', `${stamp}-${id}`)).catch(() => {});
  return { applied: staged.map(s => s.rel), generation: n, previous: current.active };
}

// Makes the generation before the active one the active one (the shipped files when there is none), with one atomic write of the
// manifest. The generation that was active stays on disk until a later apply prunes it.
export const rollbackUpdate = home => serial(() => rollbackNow(home));

async function rollbackNow(home) {
  const root = overlayRoot(home);
  const m = overlay.manifest(root);
  if (!m || m.active === null) throw new Error('Plenum is running its shipped files, so there is nothing to roll back.');
  const gen = m.generations.find(g => g.n === m.active);
  let to = gen?.previous ?? null;
  const folderExists = async number => fs.stat(path.join(root, `gen-${number}`)).then(stat => stat.isDirectory(), () => false);
  if (to !== null && !(m.generations.some(g => g.n === to) && await folderExists(to))) to = null;
  await writeJsonAtomic(path.join(root, 'manifest.json'), { ...m, active: to });
  await fs.rm(path.join(root, 'pending.json'), { force: true }).catch(() => {});
  overlay.invalidate();
  return { generation: to };
}

// Stops using every applied update: the manifest is written with nothing active first, then the generation folders are removed. The
// shipped files are in use from the next start.
export const resetOverlay = home => serial(() => resetNow(home));

async function resetNow(home) {
  const root = overlayRoot(home);
  await fs.mkdir(root, { recursive: true });
  await writeJsonAtomic(path.join(root, 'manifest.json'), { version: 1, active: null, generations: [] });
  await fs.rm(path.join(root, 'pending.json'), { force: true }).catch(() => {});
  for (const name of await genDirs(root)) await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  overlay.invalidate();
  return { generation: null };
}

// What GET /api/updates tells the page about the overlay.
export function overlayStatus(home) {
  const root = overlayRoot(home);
  const m = overlay.manifest(root);
  const generations = (m?.generations ?? [])
    .map(g => ({ n: g.n, appliedAt: g.appliedAt ?? null, summary: g.summary ?? '', previous: g.previous ?? null, files: g.files.map(f => f?.path).filter(p => typeof p === 'string') }))
    .sort((a, b) => a.n - b.n);
  return { active: m?.active ?? null, generations, rollback: overlay.lastRollback(root) };
}

export function acknowledgeRollback(home) {
  overlay.clearRollback(overlayRoot(home));
}

export async function discardUpdate(home, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Bad update id.');
  const dir = path.join(home, 'outbox', id);
  await fs.mkdir(path.join(home, 'discarded'), { recursive: true });
  await fs.rename(dir, path.join(home, 'discarded', `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`)).catch(() => {
    throw new Error('No such update.');
  });
}
