import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Update outbox. A bundle is queued by Claude (propose_update) and only touches the install
// when the user applies it in the Updates panel. Applying backs up the replaced files first.

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = process.env.MUSE_CONSOLE_APP_ROOT || path.resolve(here, '..');

const ALLOWED = [
  /^server\.mjs$/,
  /^package\.json$/,
  /^README\.md$/,
  /^start\.bat$/,
  /^lib\/[\w.-]+\.mjs$/,
  /^public\/[\w.-]+\.(html|js|css)$/,
];
const MAX_FILE_BYTES = 300_000;
const MAX_TOTAL_BYTES = 1_500_000;
// A panel is a public/ext-*.js file. The server lists each one (lib/routes/ext-modules.mjs) and the page loads it on every page,
// so a new one is labelled as such in the Updates panel. The name length is the one ext-modules accepts.
const NEW_PANEL = /^public\/ext-[a-z0-9-]{1,40}\.js$/;

export function normalizeRel(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('Each file needs a path.');
  const rel = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`Path not allowed: ${p}`);
  }
  if (!ALLOWED.some(r => r.test(rel))) {
    throw new Error(`${rel} is not updatable. Allowed: server.mjs, package.json, README.md, start.bat, lib/*.mjs, public/*.html|js|css.`);
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
      const current = await fs.readFile(path.join(APP_ROOT, f.path), 'utf8').catch(() => null);
      const status = current === null
        ? (NEW_PANEL.test(f.path) ? 'new panel: loads on every page' : 'new file')
        : current === next ? 'unchanged' : 'changed';
      files.push({ path: f.path, bytes: f.bytes, status, lines: next.split('\n').length, preview: next.slice(0, 4000) });
    }
    out.push({ id, summary: manifest.summary, createdAt: manifest.createdAt, files });
  }
  return out;
}

export async function applyUpdate(home, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Bad update id.');
  const dir = path.join(home, 'outbox', id);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'update.json'), 'utf8').catch(() => {
    throw new Error('No such update. It may already have been applied or discarded.');
  }));
  // Check everything again before touching the install.
  const staged = [];
  for (const f of manifest.files) {
    const rel = normalizeRel(f.path);
    const content = await fs.readFile(path.join(dir, 'files', rel), 'utf8');
    await syntaxCheck(rel, content, path.join(home, 'tmp'));
    staged.push({ rel, content });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(home, 'backups', `${stamp}-${id}`);
  for (const f of staged) {
    const old = await fs.readFile(path.join(APP_ROOT, f.rel)).catch(() => null);
    if (old === null) continue;
    const dest = path.join(backupDir, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, old);
  }
  for (const f of staged) {
    const target = path.join(APP_ROOT, f.rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.new`;
    await fs.writeFile(tmp, f.content);
    await fs.rename(tmp, target);
  }
  await fs.mkdir(path.join(home, 'applied'), { recursive: true });
  await fs.rename(dir, path.join(home, 'applied', `${stamp}-${id}`));
  return { applied: staged.map(s => s.rel), backupDir };
}

export async function discardUpdate(home, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Bad update id.');
  const dir = path.join(home, 'outbox', id);
  await fs.mkdir(path.join(home, 'discarded'), { recursive: true });
  await fs.rename(dir, path.join(home, 'discarded', `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`)).catch(() => {
    throw new Error('No such update.');
  });
}
