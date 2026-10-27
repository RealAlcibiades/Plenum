// The UI manifest and the index rewrite (mob-09, wave 105; MOBILE.json protocol.carriage.ui_manifest and client_model.ui_source).
//
//   manifest(ctx)            the desktop's UI files: { desktopVersion, generation, hash, files:[ { path, sha256, size, type } ] }
//                            ctx = { desktopVersion, generation, startedAt, root?, overlay?, fs?, crypto? }. The files are the
//                            ones lib/overlay.mjs names for public/ (the applied update's copy when there is one), the static
//                            page files of server.mjs (minus overlay.html, which is for the computer-use bar) and every ext-*.js and
//                            ext-*.css the page can load, plus ext.js (the loader). Cached per desktopVersion and generation.
//   rewriteIndex(html, ctx)  the index the phone's page gets: <html data-surface="phone">, viewport-fit=cover, the strict CSP meta
//                            (UI_PAGE_CSP), the shim tag <script src="<shellBase>boot.js"> and the shell entry <script type="module"
//                            src="<shellBase>shell.js"> (startShell: it sets window.plenumShellCore, which boot.js waits for). Both go
//                            directly above the first <script> of the index, in that order, so they run before the desktop UI.
//                            Returns the new HTML string. A second rewrite changes nothing.
//                            <shellBase><name> always means the BUNDLE names scripts/build-mobile.mjs writes: boot.js, shell.js,
//                            channel.worker.js and styles.css (www/ for the shell's own origin, www/ui/shell/ in the bundled snapshot).
//   isUiPath(pathname)       true for the paths the manifest lists (the phone's service worker serves these from its cache).
//   manifestHash(files, sha256Hex)  the hash HELLO carries: sha256 over [path, sha256, size] of every entry, in path order.
//
// Isomorphic on purpose: lib/remote/ui-manifest.mjs is also copied into the phone shell (mobile/www/remote/, by
// scripts/build-mobile.mjs), so it loads no Node module at import time. The desktop-only parts (the files, the hash of a file) reach
// Node through process.getBuiltinModule and a dynamic import of ../overlay.mjs, which the phone never calls.
// Only URL paths, sizes, content types and sha256 values leave this module: never a folder on disk, a key or a token.

export const MANIFEST_PATH = '/_bridge/ui-manifest';
export const SHELL_BASE = '/shell/';
// The shell entry the UI page loads under SHELL_BASE: the bundle name of mobile/shell/app.js.
export const SHELL_ENTRY = 'shell.js';
// The static page files the phone loads, as the URL paths server.mjs answers for them (overlay.html is left out: it is the bar of
// the computer-use overlay, not part of the page). '/' is the index (public/index.html).
export const UI_STATIC_PATHS = Object.freeze(['/', '/app.js', '/markdown.js', '/music.js', '/style.css', '/icon.png', '/mark.svg', '/ext.js']);

// The strict Content-Security-Policy of the phone's UI page (plan C8). scripts/build-mobile.mjs keeps an identical copy, and build.test.mjs
// asserts the two are equal.
export const UI_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'self'";

const EXT_FILE = /^ext-[a-z0-9-]{1,60}\.(?:js|css)$/;
const EXT_PATH = /^\/ext(?:-[a-z0-9-]{1,60})?\.(?:js|css)$/;
const STATIC_SET = new Set(UI_STATIC_PATHS);
// A computed specifier, so a bundler does not try to follow it into Node modules. Node resolves it against this file.
const OVERLAY_MODULE = '../overlay.mjs';
const SHELL_BASE_OK = /^\/(?:[A-Za-z0-9._-]+\/)*$/;

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
});

let cache = { key: null, value: null };

function nodeBuiltin(name) {
  try {
    return typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule(name) : null;
  } catch {
    return null;
  }
}

// The file name in public/ for a URL path ('/' is the index).
export function fileNameFor(urlPath) {
  return urlPath === '/' ? 'index.html' : urlPath.slice(1);
}

export function contentTypeFor(name) {
  const dot = name.lastIndexOf('.');
  return TYPES[dot >= 0 ? name.slice(dot).toLowerCase() : ''] ?? 'application/octet-stream';
}

export function isUiPath(pathname) {
  return STATIC_SET.has(pathname) || EXT_PATH.test(pathname);
}

// sha256 over the desktop version, the generation and the canonical list of [path, sha256, size] in path order. The phone and the
// desktop compute it the same way, and a generation bump changes it even when no file did (so the phone checks once more).
export function manifestHash(files, sha256Hex, meta = {}) {
  const rows = files.map(f => [f.path, f.sha256, f.size]);
  return sha256Hex(JSON.stringify([String(meta.desktopVersion ?? ''), meta.generation ?? null, rows]));
}

// The URL paths of the UI files the desktop has now: the static list, then every ext-*.js and ext-*.css in public/.
export function uiPaths(overlay, root) {
  const extras = overlay.listFiles('public', name => EXT_FILE.test(name), root)
    .map(name => `/${name}`);
  return [...UI_STATIC_PATHS, ...extras];
}

// manifest(ctx): see the header. Reads the files with the overlay's view of public/, hashes each one, and sorts the list by path.
export async function manifest(ctx = {}) {
  const key = `${ctx.desktopVersion ?? ''}\u0000${ctx.generation ?? ''}\u0000${ctx.root ?? ''}`;
  if (cache.key === key && cache.value) return cache.value;
  const overlay = ctx.overlay ?? await import(OVERLAY_MODULE);
  const fs = ctx.fs ?? nodeBuiltin('node:fs');
  const nodeCrypto = ctx.crypto ?? nodeBuiltin('node:crypto');
  if (!fs || !nodeCrypto) throw new Error('The UI manifest needs Node.');
  const sha256Hex = bytes => nodeCrypto.createHash('sha256').update(bytes).digest('hex');
  const files = [];
  for (const urlPath of uiPaths(overlay, ctx.root)) {
    const name = fileNameFor(urlPath);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(overlay.filePath(`public/${name}`, ctx.root));
    } catch {
      continue; // a file that is not there is not listed; the page then asks for nothing it cannot load
    }
    files.push({ path: urlPath, sha256: sha256Hex(bytes), size: bytes.length, type: contentTypeFor(name) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const meta = { desktopVersion: String(ctx.desktopVersion ?? ''), generation: ctx.generation ?? null };
  const value = {
    ...meta,
    hash: manifestHash(files, sha256Hex, meta),
    files,
  };
  cache = { key, value };
  return value;
}

// rewriteIndex(html, ctx): ctx.shellBase (default '/shell/') is the URL of the shell's files. Throws when the index has no app.js tag,
// because the shim must run before it and the page would load without the shim.
export function rewriteIndex(html, ctx = {}) {
  const shellBase = ctx.shellBase ?? SHELL_BASE;
  if (typeof shellBase !== 'string' || !SHELL_BASE_OK.test(shellBase)) throw new Error('shellBase must be a path such as /shell/');
  const text = String(html);
  if (!/<script\b[^>]*\bsrc="\/app\.js"/i.test(text)) throw new Error('The index has no app.js tag.');
  let out = text.replace(/<html\b([^>]*)>/i, (whole, attrs) => `<html${attrs.replace(/\s+data-surface="[^"]*"/i, '')} data-surface="phone">`);
  out = out.replace(/(<meta\b[^>]*\bname="viewport"[^>]*\bcontent=")([^"]*)(")/i, (whole, open, content, close) => (
    /viewport-fit=/.test(content) ? whole : `${open}${content}, viewport-fit=cover${close}`
  ));
  // The CSP meta, once: after the first charset meta, else after <head>. An index that already has a CSP meta gets no second one.
  if (!/http-equiv="Content-Security-Policy"/i.test(out)) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${UI_PAGE_CSP}">`;
    if (/<meta\b[^>]*\bcharset=[^>]*>/i.test(out)) out = out.replace(/(<meta\b[^>]*\bcharset=[^>]*>)/i, whole => `${whole}\n  ${meta}`);
    else if (/<head\b[^>]*>/i.test(out)) out = out.replace(/(<head\b[^>]*>)/i, whole => `${whole}\n  ${meta}`);
    else throw new Error('The index has no <head>.');
  }
  // The shim (boot.js) first, then the shell entry (shell.js, built from app.js) that creates the core the shim binds to. Both go directly
  // above the first <script> of the index (today /markdown.js), each on its own line with that line's indentation. Each tag is added only
  // when the index does not have it yet, so a second rewrite changes nothing.
  const shimTags = [
    `<script src="${shellBase}boot.js"></script>`,
    `<script type="module" src="${shellBase}${SHELL_ENTRY}"></script>`,
  ].filter(tag => !out.includes(tag));
  if (shimTags.length) {
    out = out.replace(/([ \t]*)<script\b/i, (whole, indent) => `${shimTags.map(tag => `${indent}${tag}\n`).join('')}${whole}`);
  }
  return out;
}

// For tests: forgets the cached manifest.
export function resetManifestCache() {
  cache = { key: null, value: null };
}
