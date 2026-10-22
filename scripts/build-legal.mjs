#!/usr/bin/env node
// Builds the legal outputs and checks the legal texts. Run by "npm run legal", which every pack and
// dist script runs first.
//
//   node scripts/build-legal.mjs           checks everything, writes legal/EULA.txt and
//                                          THIRD-PARTY-NOTICES.txt when there are no errors
//   node scripts/build-legal.mjs --check   writes nothing; exits 1 on an error, or when a generated
//                                          file on disk is out of date
//
// What it does:
//  (a) Recomputes the sha256 of legal/EULA.md and legal/PRIVACY.md and compares them with
//      legal/terms.json. A text edit must either raise "version" with a "changes" line (material:
//      people accept again) or update its sha256 (editorial). Nothing else passes.
//  (b) Writes legal/EULA.txt: the agreement as plain text, Markdown marks removed, wrapped at 100
//      columns, CRLF line ends. The installers show it, and the app copies it next to LICENSE.txt.
//      It never writes LICENSE.txt: that file is decided (all rights reserved) and stays as it is.
//  (c) Runs scripts/third-party-notices.mjs, which writes THIRD-PARTY-NOTICES.txt.
//  (d) With PLENUM_RELEASE=1 (set in .github/workflows/release.yml) it fails while [LICENSOR NAME],
//      [CONTACT EMAIL], [GOVERNING LAW] or [EFFECTIVE DATE] remains in legal/*.md, legal/terms.json,
//      legal/EULA.txt, LICENSE.txt or package.json. Without it, that is a warning.
//  (e) Checks that every link in legal/*.md is https, because the desktop opens only https links
//      in the system browser and denies every other scheme.
//  Also checks legal/terms.json: its shape, the version in each document's header, and a changes
//  line for the current version.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runThirdParty, normalizeNewlines } from './third-party-notices.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HASHED_DOCS = Object.freeze(['EULA.md', 'PRIVACY.md']);
export const VERSIONED_DOCS = Object.freeze(['EULA.md', 'PRIVACY.md']);
export const PLACEHOLDERS = Object.freeze(['[LICENSOR NAME]', '[CONTACT EMAIL]', '[GOVERNING LAW]', '[EFFECTIVE DATE]']);
export const WRAP = 100;
export const EULA_TXT = 'legal/EULA.txt';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- plain text ----------

// Strips the Markdown marks this agreement uses: emphasis, code ticks, and [text](url) links,
// which become "text (url)". The middle dot and the single angle quote become ASCII, because the
// installer licence page may not show other characters.
export function cleanInline(s) {
  return s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/·/g, '-')
    .replace(/›/g, '>')
    .trim();
}

// Greedy word wrap. The first line starts with `first`, later lines with `rest`.
export function wrap(text, width = WRAP, first = '', rest = '') {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = first;
  let hasWord = false;
  for (const w of words) {
    const cand = hasWord ? `${cur} ${w}` : `${cur}${w}`;
    if (hasWord && cand.length > width) {
      lines.push(cur);
      cur = `${rest}${w}`;
    } else {
      cur = cand;
    }
    hasWord = true;
  }
  if (hasWord || lines.length === 0) lines.push(cur);
  return lines;
}

// Markdown to plain text for the installer's licence page. Headings get an underline. Bullets keep
// a hanging indent. Paragraph lines are joined and wrapped. Output uses LF; the writer adds CRLF.
export function plainText(md) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(...wrap(para.join(' ')));
      para = [];
    }
  };
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  for (const raw of normalizeNewlines(md).split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      blank();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blank();
      const t = cleanInline(h[2]);
      out.push(t);
      out.push((h[1].length === 1 ? '=' : '-').repeat(Math.min(Math.max(t.length, 3), WRAP)));
      out.push('');
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      flush();
      out.push(...wrap(cleanInline(b[1]), WRAP, '- ', '  '));
      continue;
    }
    para.push(cleanInline(line));
  }
  flush();
  while (out.length && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

// ---------- checks (exported for tests) ----------

export function readTerms(root = ROOT) {
  const p = path.join(root, 'legal', 'terms.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function checkTermsShape(terms) {
  const errors = [];
  if (!terms || typeof terms !== 'object') return ['legal/terms.json is not an object.'];
  if (!Number.isInteger(terms.version) || terms.version < 1) errors.push('legal/terms.json: version must be a whole number from 1.');
  if (typeof terms.effective !== 'string' || !terms.effective) errors.push('legal/terms.json: effective must be a string.');
  if (typeof terms.contact !== 'string' || !terms.contact) errors.push('legal/terms.json: contact must be a string.');
  for (const d of HASHED_DOCS) {
    if (!terms.sha256 || typeof terms.sha256[d] !== 'string' || !/^[0-9a-f]{64}$/.test(terms.sha256[d])) {
      errors.push(`legal/terms.json: sha256["${d}"] must be a 64-character hex hash.`);
    }
  }
  const lines = terms.changes && terms.changes[String(terms.version)];
  if (!Array.isArray(lines) || lines.length === 0 || !lines.every((x) => typeof x === 'string' && x.trim())) {
    errors.push(`legal/terms.json: changes["${terms.version}"] must list what changed in version ${terms.version}.`);
  }
  return errors;
}

// The exact message the spec asks for when a hashed document changed without a version or hash update.
export function hashMessage(doc) {
  return `legal/${doc} changed. For a material change, raise version in legal/terms.json and add a changes line. For an editorial fix, update its sha256.`;
}

export function checkHashes(terms, root = ROOT) {
  const errors = [];
  for (const d of HASHED_DOCS) {
    const p = path.join(root, 'legal', d);
    if (!fs.existsSync(p)) {
      errors.push(`legal/${d} is missing.`);
      continue;
    }
    const now = sha256(fs.readFileSync(p));
    if (!terms.sha256 || terms.sha256[d] !== now) errors.push(hashMessage(d));
  }
  return errors;
}

export function checkVersionHeaders(terms, root = ROOT) {
  const errors = [];
  for (const d of VERSIONED_DOCS) {
    const p = path.join(root, 'legal', d);
    if (!fs.existsSync(p)) continue;
    const m = /^Version (\d+) · Effective /m.exec(fs.readFileSync(p, 'utf8'));
    if (!m) errors.push(`legal/${d} has no "Version N · Effective" line in its header.`);
    else if (Number(m[1]) !== terms.version) {
      errors.push(`legal/${d} says Version ${m[1]} but legal/terms.json has version ${terms.version}.`);
    }
  }
  return errors;
}

// Every link must be https. Markdown link targets and any scheme://address in the text.
export function checkLinks(root = ROOT) {
  const errors = [];
  const dir = path.join(root, 'legal');
  if (!fs.existsSync(dir)) return errors;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s]*)/g)) {
      if (!m[1].startsWith('https://')) errors.push(`legal/${f}: link "${m[1]}" is not https.`);
    }
    for (const m of text.matchAll(/([a-zA-Z][a-zA-Z0-9+.-]*):\/\/[^\s)\]>]*/g)) {
      if (m[1] !== 'https') errors.push(`legal/${f}: "${m[0]}" is not an https address.`);
    }
  }
  return errors;
}

// Placeholders still in the release texts. Returns [{ file, token }].
export function scanPlaceholders(root = ROOT) {
  const files = [];
  const legal = path.join(root, 'legal');
  if (fs.existsSync(legal)) {
    for (const f of fs.readdirSync(legal)) {
      if (f.endsWith('.md') || f === 'terms.json' || f === 'EULA.txt') files.push(`legal/${f}`);
    }
  }
  files.push('LICENSE.txt', 'package.json');
  const found = [];
  for (const rel of files) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const token of PLACEHOLDERS) {
      if (text.includes(token)) found.push({ file: rel, token });
    }
  }
  return found;
}

// ---------- the run ----------

export function runLegal({
  root = ROOT,
  check = false,
  release = process.env.PLENUM_RELEASE === '1',
} = {}) {
  const errors = [];
  const warnings = [];
  const written = [];

  let terms = null;
  try {
    terms = readTerms(root);
  } catch (e) {
    errors.push(`legal/terms.json cannot be read: ${e.message}`);
  }
  if (terms) {
    errors.push(...checkTermsShape(terms));
    if (errors.length === 0) {
      errors.push(...checkHashes(terms, root));
      errors.push(...checkVersionHeaders(terms, root));
    }
  }
  errors.push(...checkLinks(root));

  const placeholders = scanPlaceholders(root);
  for (const p of placeholders) {
    const msg = `${p.file} still has ${p.token}.`;
    (release ? errors : warnings).push(msg);
  }

  // (b) legal/EULA.txt from legal/EULA.md
  let eulaTxt = null;
  const eulaMd = path.join(root, 'legal', 'EULA.md');
  if (fs.existsSync(eulaMd)) eulaTxt = plainText(fs.readFileSync(eulaMd, 'utf8'));
  else errors.push('legal/EULA.md is missing.');
  const eulaOut = path.join(root, EULA_TXT);
  if (eulaTxt !== null) {
    const disk = fs.existsSync(eulaOut) ? normalizeNewlines(fs.readFileSync(eulaOut, 'utf8')) : null;
    if (check && disk !== eulaTxt) errors.push(`${EULA_TXT} is out of date. Run npm run legal.`);
  }

  // (c) THIRD-PARTY-NOTICES.txt; in check mode this compares the file on disk
  const tp = runThirdParty({
    root,
    check,
    release,
    write: !check && errors.length === 0,
  });
  errors.push(...tp.errors);
  warnings.push(...tp.warnings);
  if (tp.written) written.push('THIRD-PARTY-NOTICES.txt');

  if (!check && eulaTxt !== null && errors.length === 0) {
    fs.writeFileSync(eulaOut, eulaTxt.replace(/\n/g, '\r\n'), 'utf8');
    written.push(EULA_TXT);
  }

  return { ok: errors.length === 0, errors, warnings, written, placeholders };
}

// ---------- command line ----------

function isMain() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const check = process.argv.includes('--check');
  const r = runLegal({ check });
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  for (const e of r.errors) console.error(`error: ${e}`);
  if (check) console.log(r.ok ? 'legal check passed' : 'legal check failed');
  else if (r.ok) console.log(`legal build ok${r.written.length ? `; wrote ${r.written.join(', ')}` : ''}`);
  else console.log('legal build failed; nothing written');
  process.exit(r.ok ? 0 : 1);
}
