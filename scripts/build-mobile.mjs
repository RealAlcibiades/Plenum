#!/usr/bin/env node
// Builds the Plenum phone shell from mobile/shell into mobile/www/, and mirrors it into relay/public/ without the
// ui/ snapshot. Owned by mob-15 (wave 102, Track A). Binding inputs: MOBILE.json mobile.layout, desktop.new_files
// (scripts/build-mobile.mjs) and MOBILE-UI.md 16.3 S-08 (shell-tokens.css is the :root block of public/style.css).
//
// usage: node scripts/build-mobile.mjs [--check] [--dev] [--root <dir>]
//   no option   plans every file in memory, writes mobile/www/ and relay/public/, prints a summary, exits 0.
//   --check     plans the same files and compares them with what is on disk. Exits 1 when mobile/www or relay/public
//               is missing, changed or has extra files; exits 0 when both are current. Writes nothing. Always a release
//               build (no --dev), so a dev build can never be what relay/public is checked against.
//   --dev       a dev build (the device test jobs and the suites): __PLENUM_DEV_BUILD__ is true, which turns on the test hooks
//               (?selftest, ?debug=1, the fixture screens, the full core on window). Release builds have it false.
//   --root <d>  use <d> as the project root instead of this script's parent folder (the sealed suite uses a fixture).
//
// Output (mobile/www/): index.html, shell.js (mobile/shell/app.js bundled as an ES module), screens.js (the screen router,
// mobile/shell/screens/main.js, which index.html loads), boot.js and sw.js (bundled as classic scripts), channel.worker.js (bundled
// as a module worker), manifest.webmanifest, styles.css, shell-tokens.css, icons/, demo/, remote/ (copies of lib/remote noise.mjs,
// frames.mjs, ui-manifest.mjs), version.json, and ui/ (a copy of public/ with the shell tags inserted before app.js: the bundled UI
// snapshot for iOS). ui/shell/ holds boot.js, shell.js, channel.worker.js and styles.css, the files the snapshot's index names as
// /shell/<name>, so the snapshot is complete on its own. relay/public/ is the same tree without ui/.
//
// /shell/<name> always means the bundle names: boot.js, shell.js, channel.worker.js, styles.css.
//
// Entries that are not written yet are skipped with a warning on stderr (the shell lands in waves 104 to 107).
// Errors stop the build with exit 1 and nothing is written: an esbuild error, inline script or style, an event-handler
// attribute or an external script in mobile/shell/index.html (strict CSP), a colour literal outside a var() fallback in
// shell CSS, or a public/ file the build cannot place (no :root block, no app.js tag).
//
// Determinism: no timestamps, sorted file walks, fixed esbuild target. The same sources always give the same bytes,
// so --check can compare them.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isUiPath } from '../lib/remote/ui-manifest.mjs';

export const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The tags the UI snapshot gets. The shell serves www/boot.js and www/shell.js at these paths for the UI's origin (MOBILE.json
// decision.client_model.ui_source). boot.js runs before the UI's app.js (it is not deferred), and shell.js is a module, so it runs after
// the parser and before the deferred app.js; lib/remote/ui-manifest.mjs rewriteIndex inserts the same two tags for the live UI.
export const SHIM_SRC = '/shell/boot.js';
export const SHIM_TAG = `<script src="${SHIM_SRC}"></script>`;
export const SHELL_ENTRY_SRC = '/shell/shell.js';
export const SHELL_ENTRY_TAG = `<script type="module" src="${SHELL_ENTRY_SRC}"></script>`;

// The protocol version the shell speaks (MOBILE.json protocol.version).
export const PROTOCOL = '1.0';

// Bundles run in Android WebView (Chrome 100 and later, minSdk 26 with updates) and iOS 15 and later. Capacitor sets
// iOS 16.0 as the deployment target, so Safari 15 is the floor here.
const ESBUILD_TARGET = ['es2021', 'chrome100', 'safari15', 'firefox100'];

// Shell sources in mobile/shell and where each goes in www/. kind: 'copy' (byte copy), 'json' (copy, must parse),
// 'dir' (every file below it, copied), 'bundle' (esbuild, format given).
const SHELL_OUTPUTS = [
  { out: 'index.html', src: 'index.html', kind: 'copy' },
  { out: 'shell.js', src: 'app.js', kind: 'bundle', format: 'esm' },
  { out: 'screens.js', src: 'screens/main.js', kind: 'bundle', format: 'esm' },
  { out: 'boot.js', src: 'boot.js', kind: 'bundle', format: 'iife' },
  { out: 'channel.worker.js', src: 'channel.worker.js', kind: 'bundle', format: 'esm' },
  { out: 'sw.js', src: 'sw.js', kind: 'bundle', format: 'iife' },
  { out: 'manifest.webmanifest', src: 'manifest.webmanifest', kind: 'json' },
  { out: 'styles.css', src: 'styles.css', kind: 'copy' },
  { out: 'icons', src: 'icons', kind: 'dir' },
  { out: 'demo', src: 'demo', kind: 'dir' },
];

// The shell files the UI page loads from /shell/<name> (rewriteIndex), by their bundle names. ui/shell/ gets a copy of each.
export const UI_SHELL_FILES = Object.freeze(['boot.js', 'shell.js', 'channel.worker.js', 'styles.css']);

// Files copied from lib/remote into www/remote/. The shell's Worker reads noise and frames; ui-manifest is the
// desktop's manifest module (not written yet, so it is skipped with a warning until it is).
const REMOTE_FILES = ['noise.mjs', 'frames.mjs', 'ui-manifest.mjs'];

// CSS colour keywords a shell stylesheet must not use as a declaration value. The list is the basic CSS set plus the
// names a designer would reach for. transparent and currentcolor are not colours in this sense and are allowed.
const NAMED_COLOURS = [
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'brown', 'gray', 'grey', 'silver',
  'gold', 'navy', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'cyan', 'magenta', 'fuchsia', 'indigo', 'violet',
  'crimson', 'tomato', 'coral', 'khaki', 'beige', 'ivory', 'salmon', 'plum', 'tan', 'turquoise', 'orchid', 'sienna',
];
const COLOUR_FUNCTIONS = /(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk)\(/i;
const HEX_COLOUR = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/;
const NAMED_COLOUR = new RegExp(`(?<![\\w-])(${NAMED_COLOURS.join('|')})(?![\\w-])`, 'i');
const DECLARATION = /([a-zA-Z-]+)\s*:\s*([^;{}]*?)\s*(?=[;}])/g;

export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

// Every file below dir, sorted by name, as { rel (posix), abs }.
function walk(dir, prefix = '') {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(abs, rel));
    else if (ent.isFile()) out.push({ rel, abs });
  }
  return out;
}

// The :root block of a stylesheet, from the line that starts with ":root {" to the first later line that is "}".
// The block is returned exactly, with LF newlines and one trailing newline.
export function rootBlock(css) {
  const lines = css.split(/\r?\n/);
  const start = lines.findIndex(l => /^:root\s*\{/.test(l));
  if (start < 0) throw new BuildError('public/style.css has no ":root {" block to copy into shell-tokens.css');
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) throw new BuildError('public/style.css: the ":root {" block never closes with a "}" on its own line');
  return lines.slice(start, end + 1).join('\n') + '\n';
}

// Replaces every call of the named functions (var, url) with "()", so their arguments (fallbacks, data URIs) are not
// read as colours. Quotes and nested parentheses inside a call are respected.
export function stripCalls(text, names) {
  const re = new RegExp(`(?<![\\w-])(?:${names.join('|')})\\(`, 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let quote = null;
    let j = m.index + m[0].length;
    for (; j < text.length && depth > 0; j++) {
      const c = text[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out += `${text.slice(last, m.index)}()`;
    last = j;
    re.lastIndex = j;
  }
  return out + text.slice(last);
}

// Colour literals in a stylesheet's declaration values, outside var() fallbacks and url() arguments. Returns the
// offending declarations as "property: value" strings. Comments are ignored.
export function colourLiterals(css) {
  const text = stripCalls(css.replace(/\/\*[\s\S]*?\*\//g, ' '), ['var', 'url']);
  const found = [];
  DECLARATION.lastIndex = 0;
  let m;
  while ((m = DECLARATION.exec(text))) {
    // Quoted strings are text (a font family such as "Red Hat Display", a content string), not colour values.
    const value = m[2].replace(/"[^"]*"|'[^']*'/g, '""');
    if (HEX_COLOUR.test(value) || COLOUR_FUNCTIONS.test(value) || NAMED_COLOUR.test(value)) {
      found.push(`${m[1]}: ${value}`);
    }
  }
  return found;
}

// Strict CSP problems in a shell page: inline script, inline style, style and on* attributes, javascript: URLs,
// external script sources. The page may load same-origin scripts and stylesheets only.
export function cspViolations(html) {
  const problems = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (!/\bsrc\s*=/i.test(attrs)) {
      if (!/type\s*=\s*["']?(application\/json|text\/template)/i.test(attrs)) problems.push('inline <script>');
    } else if (/\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(attrs)) {
      problems.push('external <script src>');
    }
  }
  if (/<style\b/i.test(html)) problems.push('<style> element');
  if (/\sstyle\s*=/i.test(html)) problems.push('style attribute');
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) problems.push('event-handler attribute');
  if (/javascript:/i.test(html)) problems.push('javascript: URL');
  return problems;
}

// The strict Content-Security-Policy of the phone's UI page (plan C8). lib/remote/ui-manifest.mjs exports the same string, and build.test.mjs
// asserts the two are equal.
export const UI_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'self'";

// The UI index as the iPhone snapshot gets it (plan C8, the same changes rewriteIndex makes): the CSP meta, once, after the first charset
// meta (else after <head>), and the shim and shell entry tags directly above the first <script> of the document, each on its own line with
// that line's indentation. The index must still carry the app.js tag. Throws when the tags are already there.
export function insertShim(html) {
  if (html.includes(SHIM_SRC)) throw new BuildError(`public/index.html already contains ${SHIM_SRC}`);
  if (!/<script\b[^>]*\bsrc=["']\/app\.js["'][^>]*>/i.test(html)) {
    throw new BuildError('public/index.html has no <script src="/app.js"> to put the shim before');
  }
  let out = html;
  if (!/http-equiv="Content-Security-Policy"/i.test(out)) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${UI_PAGE_CSP}">`;
    if (/<meta\b[^>]*\bcharset=[^>]*>/i.test(out)) out = out.replace(/(<meta\b[^>]*\bcharset=[^>]*>)/i, whole => `${whole}\n  ${meta}`);
    else if (/<head\b[^>]*>/i.test(out)) out = out.replace(/(<head\b[^>]*>)/i, whole => `${whole}\n  ${meta}`);
    else throw new BuildError('public/index.html has no <head> to put the CSP meta in');
  }
  // The first <script> of the document, which is where the shim goes (today /markdown.js), with that line's indentation.
  out = out.replace(/([ \t]*)<script\b/i, (whole, indent) => `${indent}${SHIM_TAG}\n${indent}${SHELL_ENTRY_TAG}\n${whole}`);
  return out;
}

// esbuild is a dev dependency of mobile/ (the pinned 0.28.2), so it comes from <root>/mobile/node_modules and from nowhere else. Node's
// own search walks every parent folder, which could pick up another copy (a shared install beside a sealed test copy) and make the
// bundle depend on the machine. A missing install is an error, not a fallback.
function loadEsbuild(root) {
  const dir = path.join(root, 'mobile', 'node_modules', 'esbuild');
  if (!exists(path.join(dir, 'package.json'))) {
    throw new BuildError('esbuild is not installed in mobile/node_modules: run npm ci --prefix mobile first (see README, Platforms)');
  }
  return createRequire(path.join(root, 'mobile', 'package.json'))(dir);
}

// lib/remote files resolve from lib/remote when the shell imports them beside its source. The shell can then import
// './noise.mjs' or './remote/noise.mjs' without a copy in mobile/shell.
function sharedRemotePlugin(root) {
  return {
    name: 'plenum-shared-remote',
    setup(build) {
      build.onResolve({ filter: /(^|[\\/])(noise|frames|ui-manifest)\.mjs$/ }, args => {
        if (args.kind === 'entry-point') return undefined;
        if (exists(path.resolve(args.resolveDir, args.path))) return undefined;
        const shared = path.join(root, 'lib', 'remote', path.basename(args.path));
        return exists(shared) ? { path: shared } : undefined;
      });
    },
  };
}

// Bare package names (the phone packages: @noble/*, @capacitor/*, @aparajita/*, jsqr, ws) resolve only inside <root>/mobile/node_modules,
// from any file, lib/remote included. esbuild would otherwise walk up to a parent node_modules. The second resolve is the one that
// answers, marked by pluginData so this callback leaves it alone.
function mobilePackagesPlugin(root) {
  const nm = path.join(root, 'mobile', 'node_modules');
  return {
    name: 'plenum-mobile-packages',
    setup(build) {
      build.onResolve({ filter: /^[^./\\]/ }, async args => {
        if (args.pluginData?.plenumMobile || path.isAbsolute(args.path)) return undefined;
        const [first, second] = args.path.split('/');
        const name = first.startsWith('@') ? `${first}/${second}` : first;
        if (!exists(path.join(nm, name, 'package.json'))) {
          return { errors: [{ text: `${name} is not installed in mobile/node_modules (npm ci in mobile/ first)` }] };
        }
        const found = await build.resolve(args.path, { resolveDir: nm, kind: args.kind, pluginData: { plenumMobile: true } });
        if (found.errors.length) return { errors: found.errors };
        return { path: found.path, namespace: found.namespace, external: found.external };
      });
    },
  };
}

// The address the phone's Report sheet may offer to email (package.json bugs.email). Anything that is not a plain address is dropped, so a
// stray value cannot become a mailto: target; with none set the phone says so instead of inventing one.
function contactEmailOf(pkg) {
  const value = typeof pkg?.bugs?.email === 'string' ? pkg.bugs.email.trim() : '';
  return /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/.test(value) && value.length <= 120 ? value : '';
}

async function bundle(root, from, format, version, contact, warnings, dev = false) {
  const esbuild = loadEsbuild(root);
  const rel = path.relative(root, from).split(path.sep).join('/');
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [from],
      absWorkingDir: root,
      outfile: path.join(root, 'mobile', 'www', 'bundle.out.js'), // named only; write:false keeps it in memory
      bundle: true,
      write: false,
      format,
      platform: 'browser',
      target: ESBUILD_TARGET,
      define: {
        __PLENUM_SHELL_VERSION__: JSON.stringify(version),
        __PLENUM_PROTOCOL__: JSON.stringify(PROTOCOL),
        __PLENUM_CONTACT_EMAIL__: JSON.stringify(contact),
        __PLENUM_DEV_BUILD__: dev ? 'true' : 'false',
      },
      nodePaths: [path.join(root, 'mobile', 'node_modules')],
      plugins: [sharedRemotePlugin(root), mobilePackagesPlugin(root)],
      // A release bundle folds the define's false branches away, so dev-only code (the self-test, the fixture screens) is not shipped.
      minifySyntax: !dev,
      logLevel: 'silent',
    });
  } catch (err) {
    const detail = Array.isArray(err.errors) ? err.errors.map(e => e.text).join('; ') : err.message;
    throw new BuildError(`esbuild failed for ${rel}: ${detail}`);
  }
  for (const w of result.warnings) warnings.push(`esbuild ${rel}: ${w.text}`);
  return Buffer.from(result.outputFiles[0].contents);
}

// Every shell colour and CSP rule, checked before anything is bundled.
function checkShellSources(shell) {
  if (!exists(shell)) return;
  const html = path.join(shell, 'index.html');
  if (exists(html)) {
    const problems = cspViolations(fs.readFileSync(html, 'utf8'));
    if (problems.length) {
      throw new BuildError(`mobile/shell/index.html breaks the strict CSP: ${problems.join(', ')}`);
    }
  }
  const bad = [];
  for (const f of walk(shell)) {
    if (!f.rel.endsWith('.css')) continue;
    for (const decl of colourLiterals(fs.readFileSync(f.abs, 'utf8'))) bad.push(`mobile/shell/${f.rel}: ${decl}`);
  }
  if (bad.length) {
    throw new BuildError(`shell CSS uses colour literals outside shell-tokens.css (use a var(--token) instead):\n  ${bad.join('\n  ')}`);
  }
}

// The whole build plan, in memory. Keys are posix paths relative to mobile/www (ui/, remote/, icons/ and so on).
export async function plan(root, { dev = false } = {}) {
  const warnings = [];
  const files = new Map();
  const add = (key, buf) => files.set(key, buf);

  const pkgPath = path.join(root, 'package.json');
  if (!exists(pkgPath)) throw new BuildError(`no package.json in ${root}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = String(pkg.version);
  const contact = contactEmailOf(pkg);

  const shell = path.join(root, 'mobile', 'shell');
  checkShellSources(shell);

  for (const e of SHELL_OUTPUTS) {
    const from = path.join(shell, e.src);
    if (!exists(from)) {
      warnings.push(`skipped mobile/shell/${e.src} (not written yet)`);
      continue;
    }
    if (e.kind === 'copy') {
      add(e.out, fs.readFileSync(from));
    } else if (e.kind === 'json') {
      const buf = fs.readFileSync(from);
      try { JSON.parse(buf.toString('utf8')); } catch (err) {
        throw new BuildError(`mobile/shell/${e.src} is not valid JSON: ${err.message}`);
      }
      add(e.out, buf);
    } else if (e.kind === 'dir') {
      for (const f of walk(from)) add(`${e.out}/${f.rel}`, fs.readFileSync(f.abs));
    } else if (e.kind === 'bundle') {
      add(e.out, await bundle(root, from, e.format, version, contact, warnings, dev));
    }
  }

  const stylePath = path.join(root, 'public', 'style.css');
  if (!exists(stylePath)) throw new BuildError('public/style.css is missing');
  add('shell-tokens.css', Buffer.from(rootBlock(fs.readFileSync(stylePath, 'utf8')), 'utf8'));

  for (const name of REMOTE_FILES) {
    const from = path.join(root, 'lib', 'remote', name);
    if (!exists(from)) {
      warnings.push(`skipped lib/remote/${name} (not written yet)`);
      continue;
    }
    add(`remote/${name}`, fs.readFileSync(from));
  }

  // ui/ is a byte copy of public/, except index.html, which gets the shim and shell entry tags. ui/shell/ carries the four files those
  // tags (and boot.js's stylesheet link) name, so the bundled snapshot of the iPhone app loads everything from its own folder.
  // Only the files the UI page loads (isUiPath, the manifest's list): overlay.* and other public/ files are not part of the snapshot.
  for (const f of walk(path.join(root, 'public'))) {
    const buf = fs.readFileSync(f.abs);
    if (f.rel === 'index.html') add('ui/index.html', Buffer.from(insertShim(buf.toString('utf8')), 'utf8'));
    else if (isUiPath(`/${f.rel}`)) add(`ui/${f.rel}`, buf);
  }
  for (const name of UI_SHELL_FILES) {
    if (files.has(name)) add(`ui/shell/${name}`, files.get(name));
    else warnings.push(`skipped ui/shell/${name} (${name} was not built)`);
  }

  // The version file is last: it hashes every shell file (everything outside ui/), so a change to any of them,
  // or to the version number, changes it. It has no timestamp, so --check stays reproducible.
  const h = crypto.createHash('sha256');
  for (const key of [...files.keys()].filter(k => !k.startsWith('ui/')).sort()) {
    h.update(`${key}\0${sha256(files.get(key))}\n`);
  }
  const versionFile = {
    name: 'plenum-shell',
    version,
    protocol: PROTOCOL,
    shellSha256: h.digest('hex'),
  };
  add('version.json', Buffer.from(`${JSON.stringify(versionFile, null, 2)}\n`, 'utf8'));

  return { files, warnings, version };
}

// relay/public is www without the ui/ snapshot.
export function relayTree(files) {
  const out = new Map();
  for (const [key, buf] of files) if (!key.startsWith('ui/')) out.set(key, buf);
  return out;
}

// What is on disk under dir, as the same kind of map (posix keys, Buffer values). A missing folder is an empty map.
export function readTree(dir) {
  const out = new Map();
  if (!exists(dir)) return out;
  for (const f of walk(dir)) out.set(f.rel, fs.readFileSync(f.abs));
  return out;
}

// Differences between the expected tree and the one on disk, as readable lines. Empty when they match.
export function diffTrees(expected, actual, label) {
  const lines = [];
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const k of [...keys].sort()) {
    const e = expected.get(k);
    const a = actual.get(k);
    if (e && !a) lines.push(`missing ${label}/${k}`);
    else if (!e && a) lines.push(`extra ${label}/${k}`);
    else if (!e.equals(a)) lines.push(`changed ${label}/${k}`);
  }
  return lines;
}

// Writes the whole tree into a sibling folder first, then swaps it in, so a failed write leaves the old tree in place (the phone and the
// desktop never see half a build). A failure before the swap removes the new folder and rethrows.
export function writeTree(dir, files, { fsImpl = fs } = {}) {
  const tmp = `${dir}.tmp-${process.pid}`;
  fsImpl.rmSync(tmp, { recursive: true, force: true });
  try {
    fsImpl.mkdirSync(tmp, { recursive: true });
    for (const [key, buf] of files) {
      const target = path.join(tmp, ...key.split('/'));
      fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      fsImpl.writeFileSync(target, buf);
    }
    fsImpl.rmSync(dir, { recursive: true, force: true });
    fsImpl.renameSync(tmp, dir);
  } catch (err) {
    fsImpl.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

const USAGE = 'usage: node scripts/build-mobile.mjs [--check] [--dev] [--root <dir>]';

// The command line. Returns the exit code; writes nothing to the console itself except through io.
export async function run(argv, io = {}) {
  const out = io.out ?? (s => console.log(s));
  const err = io.err ?? (s => console.error(s));
  let check = false;
  let dev = false;
  let root = SCRIPT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--dev') dev = true;
    else if (a === '--root') {
      if (!argv[i + 1]) { err(USAGE); return 2; }
      root = path.resolve(argv[++i]);
    } else if (a === '-h' || a === '--help') { out(USAGE); return 0; }
    else { err(`unknown option ${a}\n${USAGE}`); return 2; }
  }

  let planned;
  let relayPlanned;
  try {
    // --check is always a release build, so the committed relay/public never carries the dev define.
    planned = await plan(root, { dev: dev && !check });
    // --dev changes mobile/www only: relay/public is always the release tree, so a dev build can never be committed there.
    relayPlanned = dev && !check ? await plan(root, { dev: false }) : planned;
  } catch (e) {
    if (e instanceof BuildError) { err(`build-mobile: ${e.message}`); return 1; }
    throw e;
  }
  for (const w of planned.warnings) err(`build-mobile: warning: ${w}`);

  const www = planned.files;
  const relay = relayTree(relayPlanned.files);

  if (check) {
    const lines = [
      ...diffTrees(www, readTree(path.join(root, 'mobile', 'www')), 'mobile/www'),
      ...diffTrees(relay, readTree(path.join(root, 'relay', 'public')), 'relay/public'),
    ];
    if (lines.length) {
      err(`build-mobile: stale, run node scripts/build-mobile.mjs, then git add relay/public and commit it (${lines.length} difference${lines.length === 1 ? '' : 's'}):`);
      for (const l of lines.slice(0, 40)) err(`  ${l}`);
      if (lines.length > 40) err(`  ... and ${lines.length - 40} more`);
      return 1;
    }
    out(`build-mobile: mobile/www (${www.size} files) and relay/public (${relay.size} files) are current`);
    return 0;
  }

  writeTree(path.join(root, 'mobile', 'www'), www);
  writeTree(path.join(root, 'relay', 'public'), relay);
  out(`build-mobile: wrote mobile/www (${www.size} files) and relay/public (${relay.size} files, without ui/)`);
  return 0;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  run(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    e => { console.error(e); process.exitCode = 1; },
  );
}
