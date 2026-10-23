#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.txt at the project root. Every runtime package in package-lock.json
// (the packages electron-builder ships: those without "dev": true) is listed with its licence,
// its source and the full text of its licence files, copied from node_modules. Fixed entries cover
// what the lock file cannot see: Electron (a dev dependency that ships in the app), Chromium (its
// text is LICENSES.chromium.html beside the app), partial-json-parser (vendored inside
// @anthropic-ai/sdk), elevate.exe (electron-builder's NSIS tools, Windows only) and any package
// whose npm package ships no licence file (standardwebhooks, lazy-val). A lock package whose folder build.files leaves out of
// the app whole ('!node_modules/<folder>/**', such as the optional @napi-rs canvas packages) is not shipped, so it is skipped:
// neither listed nor checked.
//
// Usage: node scripts/third-party-notices.mjs [--check]
//   (no flag)  writes THIRD-PARTY-NOTICES.txt when there are no errors
//   --check    writes nothing; exits 1 on an error or when the file on disk is out of date
// Environment: PLENUM_RELEASE=1 turns unconfirmed entries and dependencies missing from the lock
// file into errors. Without it they are printed as warnings. Licence errors are always errors.
//
// Called by scripts/build-legal.mjs (npm run legal, which every pack and dist script runs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'THIRD-PARTY-NOTICES.txt';

// Licences a shipped package may carry. Anything else, or no licence at all, is an error.
// Python-2.0 is the Python Software Foundation licence that argparse (a js-yaml dependency of electron-updater) carries. It is
// permissive: it asks only that the licence text and the copyright notices stay with the software, which the notices file does.
export const ALLOWED_LICENCES = Object.freeze([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', '0BSD', 'CC0-1.0',
  'BlueOak-1.0.0', 'Zlib', 'Python-2.0',
]);

// Licence file names inside a package folder (any depth, vendored copies included).
const LICENCE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)/i;

// Lock-file keys whose text comes from a fixed source instead of (or because of) the scan.
// textFrom: a path under the project (read at build time). textFile: a file under legal/third-party/.
// status 'unconfirmed' marks a licence that the developer has not yet checked against the upstream.
export const FIXED_BY_KEY = Object.freeze({
  'node_modules/electron': {
    name: 'Electron',
    licence: 'MIT',
    textFrom: 'node_modules/electron/dist/LICENSE',
    status: 'confirmed',
    note: 'Electron is the app runtime. It is a dev dependency in package.json, but it ships in the app.',
  },
  'node_modules/standardwebhooks': {
    name: 'standardwebhooks',
    licence: 'MIT (declared; not confirmed)',
    textFile: 'legal/third-party/standardwebhooks.txt',
    status: 'unconfirmed',
    note: 'The npm package declares MIT and ships no licence file. See the text below.',
  },
  // electron-updater and builder-util-runtime depend on lazy-val, which states MIT in its package.json but ships no licence file.
  // Its repository (github.com/develar/lazy-val) has none either (checked in October 2026), so there is no upstream text to copy.
  // The text is the standard MIT licence with the author that package.json names as the copyright holder. The licence itself is
  // confirmed: the package, the lock file and the repository all say MIT.
  'node_modules/lazy-val': {
    name: 'lazy-val',
    licence: 'MIT',
    textFile: 'legal/third-party/lazy-val.txt',
    status: 'confirmed',
    note: 'The npm package declares MIT and ships no licence file, and neither does its repository. The text below is the standard MIT licence, with the author named in the package as the copyright holder.',
  },
});

// Components with no node_modules entry of their own.
export const EXTRA_ENTRIES = Object.freeze([
  {
    key: 'chromium',
    name: 'Chromium (inside Electron)',
    licence: 'See LICENSES.chromium.html',
    pointer: 'The Chromium licences and the notices of its third-party components are in LICENSES.chromium.html, which electron-builder places beside the app (inside the app bundle on macOS). The text is about 20 MB, so it is not copied here.',
    status: 'confirmed',
  },
  {
    key: 'partial-json-parser',
    name: 'partial-json-parser (vendored in @anthropic-ai/sdk at src/_vendor/partial-json-parser)',
    licence: 'MIT',
    textFile: 'legal/third-party/partial-json-parser.txt',
    requires: 'node_modules/@anthropic-ai/sdk/src/_vendor/partial-json-parser',
    status: 'confirmed',
    note: 'The vendored copy carries no licence file. The licence text is the upstream MIT licence of partial-json-parser.',
  },
  {
    key: 'elevate.exe',
    name: 'elevate.exe (electron-builder NSIS tools, Windows build only)',
    licence: 'UNCONFIRMED',
    textFile: 'legal/third-party/elevate.txt',
    status: 'unconfirmed',
    note: 'Placed in the resources folder of the Windows build by electron-builder. It is not in package-lock.json.',
  },
]);

// ---------- pure helpers (exported for tests) ----------

export function normalizeNewlines(s) {
  return s.replace(/\r\n/g, '\n');
}

export function licenceOf(pkgJson) {
  let l = pkgJson.license;
  if (l && typeof l === 'object') l = l.type;
  if (!l && Array.isArray(pkgJson.licenses)) {
    l = pkgJson.licenses.map((x) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean).join(' OR ');
  }
  return typeof l === 'string' ? l.trim() : '';
}

// An SPDX-like expression. OR: any alternative on the allowlist is enough (the user may take it).
// AND: every part must be on the allowlist.
export function licenceAllowed(expr) {
  const e = expr.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!e) return false;
  if (/ OR /.test(e)) return e.split(' OR ').some((part) => licenceAllowed(part));
  if (/ AND /.test(e)) return e.split(' AND ').every((part) => licenceAllowed(part));
  return ALLOWED_LICENCES.includes(e);
}

export function repoUrl(pkgJson) {
  let r = pkgJson.repository;
  if (r && typeof r === 'object') r = r.url;
  if (typeof r !== 'string' || !r.trim()) r = pkgJson.homepage;
  if (typeof r !== 'string') return '';
  r = r.trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`;
  return r.startsWith('https://') ? r : '';
}

// Licence files under a package folder, sorted, skipping nested node_modules and .git.
export function licenceFiles(dir) {
  const found = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile() && LICENCE_FILE.test(ent.name)) found.push(r);
    }
  };
  walk(dir, '');
  return found.sort();
}

// The folders under node_modules that build.files leaves out of the app whole: a plain '!node_modules/<folder>/**' pattern with no
// wildcard or brace in the folder name. A pattern that leaves out only part of a package (pdfjs-dist/web, or the koffi platform
// builds in braces) does not exclude the package: the rest of it still ships.
export function wholeFolderExclusions(buildFiles) {
  const folders = [];
  for (const p of Array.isArray(buildFiles) ? buildFiles : []) {
    if (typeof p !== 'string' || !p.startsWith('!node_modules/') || !p.endsWith('/**')) continue;
    const folder = p.slice(1, -3);
    if (!/[*?{}[\]]/.test(folder)) folders.push(folder);
  }
  return folders;
}

// True when a lock-file key (node_modules/<name>, or a package nested under it) lies inside one of those folders.
export function isExcludedFromApp(key, folders) {
  return folders.some((f) => key === f || key.startsWith(`${f}/`));
}

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readTextIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return normalizeNewlines(fs.readFileSync(p, 'utf8')).replace(/\n+$/, '');
}

// ---------- the build ----------

// Returns { entries, errors, warnings }. Entries are sorted by name and carry their licence texts.
export function buildNotices({ root = ROOT, release = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const releaseOnly = (m) => (release ? errors : warnings).push(m);

  const lock = readJsonIfExists(path.join(root, 'package-lock.json'));
  const pkg = readJsonIfExists(path.join(root, 'package.json'));
  if (!lock || !lock.packages) {
    err('package-lock.json is missing or has no packages list.');
    return { entries: [], errors, warnings };
  }
  if (!pkg) {
    err('package.json is missing.');
    return { entries: [], errors, warnings };
  }

  // Every declared runtime dependency must be in the lock file, or the notices would miss it.
  for (const dep of Object.keys(pkg.dependencies || {})) {
    const e = lock.packages[`node_modules/${dep}`];
    if (!e || e.dev) {
      releaseOnly(`${dep} is in package.json dependencies but not in package-lock.json. Run npm install and commit the lock file; until then it is missing from the notices.`);
    }
  }

  // Packages that build.files leaves out of the app whole are not shipped, so they are neither listed nor checked.
  const outOfApp = wholeFolderExclusions(pkg.build && pkg.build.files);
  const scannedKeys = Object.keys(lock.packages)
    .filter((k) => k.startsWith('node_modules/') && !lock.packages[k].dev)
    .filter((k) => !isExcludedFromApp(k, outOfApp));
  const keys = [...new Set([...scannedKeys, ...Object.keys(FIXED_BY_KEY)])];
  const entries = [];

  for (const key of keys) {
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const dir = path.join(root, key);
    const fixed = FIXED_BY_KEY[key];
    const lockVersion = lock.packages[key] && lock.packages[key].version;

    if (fixed) {
      const pj = readJsonIfExists(path.join(dir, 'package.json'));
      const files = [];
      if (fixed.textFrom) {
        const t = readTextIfExists(path.join(root, fixed.textFrom));
        if (t === null) err(`${fixed.name}: licence text ${fixed.textFrom} is missing. Run npm install.`);
        else files.push({ name: fixed.textFrom, text: t });
      }
      if (fixed.textFile) {
        const t = readTextIfExists(path.join(root, fixed.textFile));
        if (t === null) err(`${fixed.name}: licence text ${fixed.textFile} is missing.`);
        else files.push({ name: fixed.textFile, text: t });
      }
      if (fixed.status === 'unconfirmed') {
        releaseOnly(`${fixed.name}: licence not confirmed (${fixed.textFile}). Confirm it and replace that file before a release.`);
      }
      entries.push({
        name: fixed.name,
        version: (pj && pj.version) || lockVersion || '',
        licence: fixed.licence,
        source: pj ? repoUrl(pj) : '',
        note: fixed.note || '',
        status: fixed.status,
        files,
      });
      continue;
    }

    const pj = readJsonIfExists(path.join(dir, 'package.json'));
    if (!pj) {
      err(`${name}: not installed (no ${key}/package.json). Run npm ci.`);
      continue;
    }
    const licence = licenceOf(pj);
    if (!licence) err(`${name}: package.json states no licence.`);
    else if (!licenceAllowed(licence)) err(`${name}: licence "${licence}" is not on the allowlist.`);

    const rels = licenceFiles(dir);
    if (rels.length === 0) err(`${name}: no licence file in the package. Add a fixed entry in scripts/third-party-notices.mjs with its licence text.`);
    const files = rels.map((rel) => ({ name: rel, text: readTextIfExists(path.join(dir, rel)) || '' }));

    entries.push({
      name,
      version: pj.version || lockVersion || '',
      licence: licence || 'none stated',
      source: repoUrl(pj),
      note: '',
      status: 'confirmed',
      files,
    });
  }

  for (const extra of EXTRA_ENTRIES) {
    if (extra.requires && !fs.existsSync(path.join(root, extra.requires))) {
      warnings.push(`${extra.name}: ${extra.requires} is not present, so this entry is skipped.`);
      continue;
    }
    const files = [];
    if (extra.textFile) {
      const t = readTextIfExists(path.join(root, extra.textFile));
      if (t === null) err(`${extra.name}: licence text ${extra.textFile} is missing.`);
      else files.push({ name: extra.textFile, text: t });
    }
    if (extra.status === 'unconfirmed') {
      releaseOnly(`${extra.name}: licence not confirmed (${extra.textFile}). Confirm it and replace that file before a release.`);
    }
    entries.push({
      name: extra.name,
      version: '',
      licence: extra.licence,
      source: '',
      note: extra.note || '',
      pointer: extra.pointer || '',
      status: extra.status,
      files,
    });
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, errors, warnings };
}

// The notice file as text with LF line ends. Deterministic: no dates and no machine paths.
export function renderNotices(entries) {
  const L = [];
  const rule = '='.repeat(72);
  const thin = '-'.repeat(72);
  L.push('THIRD-PARTY NOTICES');
  L.push('');
  L.push('Plenum includes the open-source components listed below. Each is used under the licence shown');
  L.push('with it, and that licence text follows its entry.');
  L.push('Plenum itself is under LICENSE.txt. The end-user agreement is EULA.txt beside the app.');
  L.push('Chromium and its third-party components are in LICENSES.chromium.html, beside the app.');
  L.push('This file is generated by scripts/third-party-notices.mjs from package-lock.json and node_modules.');
  L.push('Do not edit it by hand. Run npm run legal.');
  L.push('');
  L.push(`Components: ${entries.length}`);
  L.push('');
  for (const e of entries) {
    L.push(rule);
    const head = `${e.name}${e.version ? ` ${e.version}` : ''}`;
    L.push(e.status === 'unconfirmed' ? `${head}  [UNCONFIRMED LICENCE]` : head);
    L.push(`Licence: ${e.licence}`);
    if (e.source) L.push(`Source: ${e.source}`);
    if (e.note) L.push(e.note);
    if (e.pointer) L.push(e.pointer);
    for (const f of e.files) {
      L.push(thin);
      L.push(`File: ${f.name}`);
      L.push('');
      L.push(f.text.replace(/\n+$/, ''));
    }
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

// Build, then either check the file on disk or write it. Used by build-legal.mjs too.
export function runThirdParty({
  root = ROOT,
  check = false,
  release = process.env.PLENUM_RELEASE === '1',
  write = !check,
} = {}) {
  const built = buildNotices({ root, release });
  const text = renderNotices(built.entries);
  const errors = [...built.errors];
  let written = false;
  const target = path.join(root, OUTPUT);
  if (check) {
    const disk = fs.existsSync(target) ? normalizeNewlines(fs.readFileSync(target, 'utf8')) : null;
    if (disk !== text) errors.push(`${OUTPUT} is out of date. Run npm run legal.`);
  } else if (write && errors.length === 0) {
    fs.writeFileSync(target, text.replace(/\n/g, '\r\n'), 'utf8');
    written = true;
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings: built.warnings,
    entries: built.entries.map((e) => e.name),
    text,
    written,
  };
}

// ---------- command line ----------

function isMain() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const check = process.argv.includes('--check');
  const r = runThirdParty({ check });
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  for (const e of r.errors) console.error(`error: ${e}`);
  console.log(`${r.entries.length} components: ${r.entries.join(', ')}`);
  if (check) console.log(r.ok ? 'check passed' : 'check failed');
  else console.log(r.ok ? `wrote ${OUTPUT}` : `not written: ${OUTPUT}`);
  process.exit(r.ok ? 0 : 1);
}
