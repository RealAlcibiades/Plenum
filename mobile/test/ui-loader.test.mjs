// The UI manifest, the sha256 check, the index rewrite, the UI loader and the phone's service worker (mob-09, wave 105).
// Everything here runs in Node on fake caches, fake files and a fake channel. A desktop is simulated by a temp public/ folder that
// lib/remote/ui-manifest.mjs reads, so the manifest the phone checks is the one the desktop computes.
// Run through the sealed runner, never from the project folder:
//   node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id mob-09-shims-ui-manifest-and-loader ui-loader.test.mjs
import { after, before, describe, test } from 'node:test';
import { startSealedServer } from './helpers/sealed-server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as overlay from '../../lib/overlay.mjs';
import {
  MANIFEST_PATH, UI_PAGE_CSP, UI_STATIC_PATHS, contentTypeFor, fileNameFor, isUiPath, manifest, manifestHash, resetManifestCache, rewriteIndex,
} from '../../lib/remote/ui-manifest.mjs';
import {
  ACTIVE_CACHE, ACTIVE_PATH, UiError, androidStorage, bundledOnly, cacheNameFor, checkManifest, createUiLoader, diffFiles, readAll,
  sha256Hex, shouldReload, verifyBytes, webStorage,
} from '../shell/ui-loader.js';
import { ARTIFACT_VIEW, artifactResponse, chooseActions, hashFor, hashForClick, installWorker, showPush, openFromNotification, uiResponse, UI_CSP } from '../shell/sw.js';
import { buildPushText } from '../../lib/remote/push.mjs';

const HERE = import.meta.dirname;
const PROJECT = path.resolve(HERE, '..', '..');
const enc = new TextEncoder();
const dec = new TextDecoder();

// ----- fixtures -----

const INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plenum</title>
</head>
<body>
  <main id="app"></main>
  <script src="/markdown.js" defer></script>
  <script src="/music.js" defer></script>
  <script src="/app.js" defer></script>
  <script src="/ext.js" defer></script>
</body>
</html>
`;

// A temp folder shaped like the install folder: public/ with the page files, an overlay-less desktop.
function makeRoot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob09-root-'));
  fs.mkdirSync(path.join(root, 'public'));
  const files = {
    'index.html': INDEX,
    'app.js': 'window.appLoaded = true;\n',
    'markdown.js': 'window.md = 1;\n',
    'music.js': 'window.music = 1;\n',
    'style.css': 'body { color: #000; }\n',
    'icon.png': 'png-bytes',
    'mark.svg': '<svg></svg>',
    'ext.js': '// loader\n',
    'ext-drive.js': 'window.drive = 1;\n',
    'ext-drive.css': '.drive { }\n',
    'ext-phone.js': 'window.phone = 1;\n',
    'overlay.html': '<html></html>',
    'Ext-Bad.js': 'nope',
    ...extra,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'public', name), text);
  return root;
}

// The fake desktop: serves its manifest and its files, and can be changed (a new version, a tampered byte, an offline desktop).
function fakeDesktop(root, meta = { desktopVersion: '1.4.2', generation: 1 }) {
  const state = { root, meta, requests: [], online: true, tamper: new Map(), manifest: null };
  state.build = async () => {
    resetManifestCache();
    state.manifest = await manifest({ root, desktopVersion: state.meta.desktopVersion, generation: state.meta.generation, overlay, fs, crypto });
    return state.manifest;
  };
  state.bytesFor = urlPath => {
    const name = fileNameFor(urlPath);
    if (state.tamper.has(urlPath)) return state.tamper.get(urlPath);
    return fs.readFileSync(path.join(root, 'public', name));
  };
  state.channel = {
    async request({ method = 'GET', path: p = '/' } = {}) {
      state.requests.push(`${method} ${p}`);
      if (!state.online) throw Object.assign(new Error('offline'), { code: 'offline' });
      if (p === MANIFEST_PATH) return reply(200, enc.encode(JSON.stringify(state.manifest)));
      const entry = state.manifest.files.find(f => f.path === p);
      if (!entry) return reply(404, enc.encode('{}'));
      const bytes = state.bytesFor(p);
      // Two chunks, so readAll is exercised with more than one part.
      const half = Math.floor(bytes.byteLength / 2);
      const parts = [bytes.slice(0, half), bytes.slice(half)];
      return reply(200, null, parts);
    },
  };
  return state;
}

function reply(status, bytes, parts = null) {
  const chunks = parts ?? [bytes];
  const body = new ReadableStream({
    start(c) {
      for (const part of chunks) if (part.byteLength) c.enqueue(new Uint8Array(part));
      c.close();
    },
  });
  return { status, headers: { 'content-type': 'application/octet-stream' }, body, id: 1, cancel() {} };
}

// Fake Cache API: caches.open(name) -> cache with match/put, caches.keys(), caches.delete(name). Entries keep their bytes and headers.
function fakeCaches() {
  const store = new Map();
  const keyOf = k => (typeof k === 'string' ? k : new URL(k.url ?? k, 'http://x').pathname);
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const map = store.get(name);
      return {
        async match(k) {
          const hit = map.get(keyOf(k));
          return hit ? new Response(hit.bytes.slice(), { headers: hit.headers }) : undefined;
        },
        async put(k, res) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          const headers = [...res.headers.entries()];
          map.set(keyOf(k), { bytes, headers });
        },
      };
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
  };
}

function fakeFiles() {
  const map = new Map();
  return {
    map,
    async write(rel, bytes) {
      map.set(rel, new Uint8Array(bytes));
    },
    async read(rel) {
      return map.get(rel) ?? null;
    },
    async removeDir(rel) {
      for (const k of [...map.keys()]) if (k.startsWith(`${rel}/`)) map.delete(k);
    },
    async listDirs(root) {
      const set = new Set();
      for (const k of map.keys()) {
        if (k.startsWith(`${root}/`)) {
          const rest = k.slice(root.length + 1).split('/');
          if (rest.length > 1) set.add(rest[0]);
        }
      }
      return [...set];
    },
  };
}

// ----- the manifest -----

describe('ui-manifest: manifest()', () => {
  test('lists the static page files and every ext-*.js and ext-*.css, sorted, with sha256 and size', async () => {
    const root = makeRoot();
    const m = await manifest({ root, desktopVersion: '1.4.2', generation: null, overlay, fs, crypto });
    const paths = m.files.map(f => f.path);
    assert.deepEqual(paths, ['/', '/app.js', '/ext-drive.css', '/ext-drive.js', '/ext-phone.js', '/ext.js', '/icon.png', '/mark.svg', '/markdown.js', '/music.js', '/style.css']);
    const app = m.files.find(f => f.path === '/app.js');
    assert.equal(app.sha256, crypto.createHash('sha256').update('window.appLoaded = true;\n').digest('hex'));
    assert.equal(app.size, Buffer.byteLength('window.appLoaded = true;\n'));
    assert.equal(app.type, 'text/javascript; charset=utf-8');
    assert.equal(m.files.find(f => f.path === '/').type, 'text/html; charset=utf-8');
    assert.equal(m.desktopVersion, '1.4.2');
    assert.equal(m.generation, null);
  });

  test('never lists overlay.html, a name that is not a panel, or a file that is missing', async () => {
    const root = makeRoot();
    const m = await manifest({ root, desktopVersion: 'x', generation: 2, overlay, fs, crypto });
    const paths = m.files.map(f => f.path);
    assert.ok(!paths.includes('/overlay.html'));
    assert.ok(!paths.includes('/Ext-Bad.js'));
    assert.ok(paths.includes('/mark.svg'), 'a static file that exists is listed');
  });

  test('the hash covers the version, the generation and every file, so a generation bump changes it', async () => {
    const root = makeRoot();
    const sha = s => crypto.createHash('sha256').update(s).digest('hex');
    const a = await manifest({ root, desktopVersion: '1.4.2', generation: 1, overlay, fs, crypto });
    resetManifestCache();
    const b = await manifest({ root, desktopVersion: '1.4.2', generation: 2, overlay, fs, crypto });
    assert.equal(a.files.length, b.files.length);
    assert.notEqual(a.hash, b.hash);
    assert.equal(a.hash, manifestHash(a.files, sha, { desktopVersion: '1.4.2', generation: 1 }));
  });

  test('is cached per desktopVersion and generation', async () => {
    const root = makeRoot();
    resetManifestCache();
    const a = await manifest({ root, desktopVersion: '1.0', generation: 5, overlay, fs, crypto });
    const b = await manifest({ root, desktopVersion: '1.0', generation: 5, overlay, fs, crypto });
    assert.equal(a, b);
    const c = await manifest({ root, desktopVersion: '1.0', generation: 6, overlay, fs, crypto });
    assert.notEqual(a, c);
  });

  test('on this project folder: every ext-*.js and ext-*.css in public/ is listed (no count is assumed)', async () => {
    resetManifestCache();
    const m = await manifest({ root: PROJECT, desktopVersion: 'check', generation: null, overlay, fs, crypto });
    const onDisk = fs.readdirSync(path.join(PROJECT, 'public')).filter(n => /^ext-[a-z0-9-]{1,60}\.(js|css)$/.test(n));
    const listed = m.files.map(f => f.path).filter(p => /^\/ext-/.test(p));
    assert.equal(listed.length, onDisk.length);
    assert.ok(onDisk.length >= 40, 'the desktop has its panels');
    assert.ok(m.files.some(f => f.path === '/'), 'the index is listed');
  });

  test('every static path the phone loads is a UI path, and the list is the one the page needs', () => {
    assert.deepEqual([...UI_STATIC_PATHS].sort(), ['/', '/app.js', '/ext.js', '/icon.png', '/mark.svg', '/markdown.js', '/music.js', '/style.css']);
    assert.equal(contentTypeFor('style.css'), 'text/css; charset=utf-8');
    assert.equal(contentTypeFor('x.bin'), 'application/octet-stream');
    assert.equal(isUiPath('/ext.js'), true);
    assert.equal(isUiPath('/ext-phone.css'), true);
    assert.equal(isUiPath('/overlay.html'), false);
    assert.equal(isUiPath('/api/state'), false);
    assert.equal(isUiPath('/ext-Bad.js'), false);
  });
});

// ----- the index rewrite -----

describe('ui-manifest: rewriteIndex()', () => {
  test('adds data-surface, viewport-fit=cover, and the shim tag above the first desktop script, once', () => {
    const out = rewriteIndex(INDEX);
    assert.match(out, /<html lang="en" data-surface="phone">/);
    assert.match(out, /content="width=device-width, initial-scale=1, viewport-fit=cover"/);
    const tag = '<script src="/shell/boot.js"></script>';
    assert.equal(out.split(tag).length - 1, 1);
    assert.ok(out.indexOf(tag) < out.indexOf('<script src="/markdown.js" defer>'), 'boot runs before the desktop scripts');
    assert.equal(rewriteIndex(out), out, 'a second rewrite changes nothing');
  });

  test('the shell entry runs before the desktop scripts: boot.js, then /shell/shell.js as a module (the bundle name), then /markdown.js and /app.js, each added once', () => {
    const out = rewriteIndex(INDEX);
    const boot = out.indexOf('<script src="/shell/boot.js"></script>');
    const shell = out.indexOf('<script type="module" src="/shell/shell.js"></script>');
    const markdown = out.indexOf('<script src="/markdown.js" defer>');
    const desk = out.indexOf('<script src="/app.js" defer>');
    assert.ok(boot >= 0 && shell > boot && markdown > shell && desk > markdown, 'boot, then the shell entry, then the desktop scripts');
    assert.equal(out.split('/shell/shell.js').length - 1, 1, 'the shell entry is in the index once');
    assert.equal(out.includes('/shell/app.js'), false, 'app.js is a source name; the bundle is shell.js');
    assert.equal(rewriteIndex(out), out, 'a second rewrite changes nothing');
  });

  test('the shim lines sit directly above the first script, each on its own line with that line\'s indentation', () => {
    const out = rewriteIndex(INDEX);
    assert.ok(
      out.includes('  <script src="/shell/boot.js"></script>\n  <script type="module" src="/shell/shell.js"></script>\n  <script src="/markdown.js" defer></script>\n'),
      out,
    );
  });

  test('the CSP meta is present once, right after <meta charset>, with UI_PAGE_CSP', () => {
    const out = rewriteIndex(INDEX);
    const meta = `<meta http-equiv="Content-Security-Policy" content="${UI_PAGE_CSP}">`;
    assert.equal(out.split(meta).length - 1, 1, 'exactly one CSP meta, with the exact policy');
    assert.ok(out.includes(`<meta charset="utf-8">\n  ${meta}\n  <meta name="viewport"`), 'directly after the charset meta, on its own line');
    assert.equal(out.split('http-equiv="Content-Security-Policy"').length - 1, 1);
    assert.match(UI_PAGE_CSP, /default-src 'self'.*script-src 'self'.*base-uri 'none'/);
  });

  test('without a charset meta the CSP meta goes right after <head>; an index that already has a CSP meta gets no second one', () => {
    const noCharset = '<!doctype html>\n<html>\n<head>\n<title>x</title>\n</head>\n<body>\n<script src="/app.js" defer></script>\n</body>\n</html>\n';
    const out = rewriteIndex(noCharset);
    assert.ok(out.includes(`<head>\n  <meta http-equiv="Content-Security-Policy" content="${UI_PAGE_CSP}">\n<title>`), out);
    const withCsp = INDEX.replace('<meta name="viewport"', '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">\n  <meta name="viewport"');
    const kept = rewriteIndex(withCsp);
    assert.equal(kept.split('http-equiv="Content-Security-Policy"').length - 1, 1, 'the index keeps its one CSP meta');
    assert.equal(kept.includes(UI_PAGE_CSP), false, 'and does not gain a second policy');
  });

  test('a second rewrite changes nothing, with the CSP meta and the shell tags in place', () => {
    const once = rewriteIndex(INDEX);
    assert.equal(rewriteIndex(once), once);
    assert.equal(rewriteIndex(rewriteIndex(once, { shellBase: '/shell/' }), { shellBase: '/shell/' }), once);
  });

  test('an index without <head> throws', () => {
    assert.throws(() => rewriteIndex('<!doctype html><html><body><script src="/app.js" defer></script></body></html>'), /no <head>/);
  });

  test('uses the shell base it is given, and refuses a base that is not a path', () => {
    assert.match(rewriteIndex(INDEX, { shellBase: '/p/abc123/shell/' }), /src="\/p\/abc123\/shell\/boot\.js"/);
    assert.throws(() => rewriteIndex(INDEX, { shellBase: 'https://evil.example/' }), /shellBase/);
    assert.throws(() => rewriteIndex(INDEX, { shellBase: '/x"><script>/' }), /shellBase/);
  });

  test('introduces no inline script and no style attribute', () => {
    const out = rewriteIndex(INDEX);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(out), 'every script has a src');
    assert.ok(!/\sstyle="/i.test(out));
  });

  test('refuses an index with no app.js tag, because the shim would not run first', () => {
    assert.throws(() => rewriteIndex('<!doctype html><html><body></body></html>'), /app\.js/);
  });

  test('rewrites the real public/index.html of this project', () => {
    const html = fs.readFileSync(path.join(PROJECT, 'public', 'index.html'), 'utf8');
    const out = rewriteIndex(html);
    assert.match(out, /data-surface="phone"/);
    assert.match(out, /boot\.js/);
    assert.equal(out.split('http-equiv="Content-Security-Policy"').length - 1, 1, 'the real index gets one CSP meta');
  });
});

// ----- verification, the checked manifest and the diff -----

describe('ui-loader: verify and check', () => {
  const entry = { path: '/app.js', sha256: sha256Hex(enc.encode('abc')), size: 3, type: 'text/javascript' };

  test('verifyBytes accepts the file the manifest names', () => {
    assert.equal(verifyBytes(enc.encode('abc'), entry), true);
  });

  test('verifyBytes refuses one changed byte (same size) and a wrong size', () => {
    assert.throws(() => verifyBytes(enc.encode('abd'), entry), err => err instanceof UiError && err.code === 'verify');
    assert.throws(() => verifyBytes(enc.encode('abcd'), entry), err => err instanceof UiError && err.code === 'size');
  });

  test('checkManifest accepts a manifest the desktop computed and returns a clean copy', async () => {
    const root = makeRoot();
    const m = await manifest({ root, desktopVersion: '1.4.2', generation: 4, overlay, fs, crypto });
    const clean = checkManifest(JSON.parse(JSON.stringify(m)));
    assert.equal(clean.hash, m.hash);
    assert.equal(clean.files.length, m.files.length);
    assert.equal(clean.generation, 4);
  });

  test('checkManifest refuses a changed file hash (the list no longer matches the hash), a bad path, a missing index and a bad version', async () => {
    const root = makeRoot();
    const m = JSON.parse(JSON.stringify(await manifest({ root, desktopVersion: '1.4.2', generation: 4, overlay, fs, crypto })));
    const bad = JSON.parse(JSON.stringify(m));
    bad.files[1].sha256 = '0'.repeat(64);
    assert.throws(() => checkManifest(bad), err => err.code === 'manifest');
    const badPath = JSON.parse(JSON.stringify(m));
    badPath.files.push({ path: '/api/state', sha256: '1'.repeat(64), size: 1, type: 'text/plain' });
    assert.throws(() => checkManifest(badPath), err => err.code === 'manifest');
    const noIndex = JSON.parse(JSON.stringify(m));
    noIndex.files = noIndex.files.filter(f => f.path !== '/');
    assert.throws(() => checkManifest(noIndex), err => err.code === 'manifest');
    const longVersion = { ...JSON.parse(JSON.stringify(m)), desktopVersion: 'v'.repeat(41) };
    assert.throws(() => checkManifest(longVersion), err => err.code === 'manifest');
  });

  test('diffFiles lists what must be fetched, what can be reused, and what was dropped', () => {
    const prev = [{ path: '/a.js', sha256: 'h1' }, { path: '/b.js', sha256: 'h2' }, { path: '/gone.js', sha256: 'h3' }];
    const next = { files: [{ path: '/a.js', sha256: 'h1', size: 1, type: 't' }, { path: '/b.js', sha256: 'NEW', size: 1, type: 't' }, { path: '/c.js', sha256: 'h4', size: 1, type: 't' }] };
    const d = diffFiles(prev, next, () => true);
    assert.deepEqual(d.reused, ['/a.js']);
    assert.deepEqual(d.changed.map(f => f.path), ['/b.js', '/c.js']);
    assert.deepEqual(d.removed, ['/gone.js']);
    const none = diffFiles(null, next, () => false);
    assert.equal(none.changed.length, 3);
  });

  test('cacheNameFor differs for each manifest hash, and the reload rule fires once per new UI', () => {
    const a = cacheNameFor({ desktopVersion: '1.0', generation: 1, hash: 'a'.repeat(64) });
    const b = cacheNameFor({ desktopVersion: '1.0', generation: 1, hash: 'b'.repeat(64) });
    assert.notEqual(a, b);
    assert.ok(a.startsWith('plenum-ui-'));
    assert.equal(shouldReload({ loadedHash: null, nextHash: 'x', reloadedFor: null }), false, 'first load does not reload');
    assert.equal(shouldReload({ loadedHash: 'x', nextHash: 'x', reloadedFor: null }), false);
    assert.equal(shouldReload({ loadedHash: 'old', nextHash: 'new', reloadedFor: null }), true);
    assert.equal(shouldReload({ loadedHash: 'old', nextHash: 'new', reloadedFor: 'new' }), false, 'no second reload for the same UI');
  });

  test('readAll stops past its cap and joins chunks in order', async () => {
    const s = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } });
    assert.deepEqual([...await readAll(s, 10)], [1, 2, 3]);
    const big = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); c.close(); } });
    await assert.rejects(readAll(big, 10), err => err.code === 'size');
  });
});

// ----- the loader over fake caches and a fake desktop -----

describe('ui-loader: pull, reload and refusal', () => {
  test('first pull fetches, verifies and caches every file, then the next check needs no manifest fetch', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const caches = fakeCaches();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(caches), platform: 'web' });
    const first = await loader.check({ helloHash: desk.manifest.hash, loadedHash: null });
    assert.equal(first.status, 'updated');
    assert.equal(first.reload, false);
    assert.equal(first.changed.length, desk.manifest.files.length);
    assert.equal(desk.requests.filter(r => r === `GET ${MANIFEST_PATH}`).length, 1);
    const active = await loader.current();
    assert.equal(active.hash, desk.manifest.hash);
    assert.ok(caches.store.get(active.cacheName).has('/app.js'));
    desk.requests.length = 0;
    const again = await loader.check({ helloHash: desk.manifest.hash, loadedHash: desk.manifest.hash });
    assert.equal(again.status, 'current');
    assert.equal(desk.requests.length, 0, 'same hash: nothing requested');
  });

  test('a changed byte in one file is refused: the old copy stays active and the bad cache is dropped', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const caches = fakeCaches();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(caches), platform: 'web' });
    await loader.check({ helloHash: null, loadedHash: null });
    const before = await loader.current();
    // The desktop changes app.js, but the bytes the phone receives differ from what the manifest says.
    fs.writeFileSync(path.join(root, 'public', 'app.js'), 'window.appLoaded = "v2";\n');
    await desk.build();
    // Same length as the manifest's file, so only the sha256 check can catch it.
    desk.tamper.set('/app.js', enc.encode('window.appLoaded = "v3";\n'));
    await assert.rejects(loader.check({ helloHash: null, loadedHash: before.hash }), err => err instanceof UiError && err.code === 'verify');
    const after = await loader.current();
    assert.equal(after.hash, before.hash, 'the active record is unchanged');
    assert.equal(caches.store.has(cacheNameFor(desk.manifest)), false, 'the half-built cache is dropped');
    assert.ok(caches.store.has(before.cacheName), 'the old cache is kept');
  });

  test('a desktop update fetches only the changed file and asks for one reload, once', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root, { desktopVersion: '1.4.2', generation: 1 });
    await desk.build();
    const caches = fakeCaches();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(caches), platform: 'web' });
    await loader.check({ helloHash: null, loadedHash: null });
    const loaded = (await loader.current()).hash;
    fs.writeFileSync(path.join(root, 'public', 'ext-phone.js'), 'window.phone = 2;\n');
    desk.meta = { desktopVersion: '1.4.3', generation: 2 };
    await desk.build();
    desk.requests.length = 0;
    const up = await loader.check({ helloHash: desk.manifest.hash, loadedHash: loaded });
    assert.equal(up.status, 'updated');
    assert.deepEqual(up.changed, ['/ext-phone.js']);
    assert.equal(up.reload, true, 'the page runs the old UI: reload once');
    assert.equal(desk.requests.filter(r => r.startsWith('GET /') && r !== `GET ${MANIFEST_PATH}`).length, 1, 'only the changed file was requested');
    const again = await loader.check({ helloHash: desk.manifest.hash, loadedHash: loaded });
    assert.equal(again.reload, false, 'the second check does not reload again');
  });

  test('a generation bump with the same files still re-checks and reloads once', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root, { desktopVersion: '1.4.2', generation: 1 });
    await desk.build();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(fakeCaches()), platform: 'web' });
    await loader.check({ loadedHash: null });
    const loaded = (await loader.current()).hash;
    desk.meta = { desktopVersion: '1.4.2', generation: 2 };
    await desk.build();
    const bumped = await loader.check({ helloHash: desk.manifest.hash, loadedHash: loaded });
    assert.equal(bumped.hash !== loaded, true);
    assert.deepEqual(bumped.changed, []);
    assert.equal(bumped.reload, true);
  });

  test('iOS refuses desktop files: nothing is requested and the error says so', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(fakeCaches()), platform: 'ios' });
    await assert.rejects(loader.check({ helloHash: desk.manifest.hash }), err => err.code === 'refused');
    assert.equal(desk.requests.length, 0);
    assert.equal(bundledOnly().status, 'bundled');
  });

  test('an offline desktop leaves the active UI alone and the error reaches the caller', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const caches = fakeCaches();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(caches), platform: 'web' });
    await loader.check({ loadedHash: null });
    const active = await loader.current();
    desk.online = false;
    await assert.rejects(loader.check({ helloHash: 'other', loadedHash: active.hash }), err => err.code === 'offline');
    assert.equal((await loader.current()).hash, active.hash);
  });

  test('a damaged manifest is refused before any file is fetched', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const loader = createUiLoader({
      channel: { request: async () => reply(200, enc.encode(JSON.stringify({ ...desk.manifest, hash: 'f'.repeat(64) }))) },
      storage: webStorage(fakeCaches()),
      platform: 'web',
    });
    await assert.rejects(loader.pull({ loadedHash: null }), err => err.code === 'manifest');
  });

  test('the Android storage writes the files, the rewritten index and the boot file, then sets the base path once everything verified', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root, { desktopVersion: '1.4.2', generation: 3 });
    await desk.build();
    const files = fakeFiles();
    const calls = [];
    const webView = {
      setServerBasePath: async ({ path: p }) => calls.push(['set', p]),
      persistServerBasePath: async ({ path: p }) => calls.push(['persist', p]),
    };
    const storage = androidStorage({ files, webView });
    const loader = createUiLoader({
      channel: desk.channel,
      storage,
      platform: 'android',
      readBundled: async rel => (rel === 'shell/boot.js' ? enc.encode('/* boot */') : null),
    });
    const result = await loader.check({ loadedHash: null });
    assert.equal(result.status, 'updated');
    const base = calls.find(c => c[0] === 'set')[1];
    assert.match(base, /^plenum-ui\/plenum-ui-1\.4\.2-3-/);
    const index = dec.decode(files.map.get(`${base.replace(/^plenum-ui\//, 'plenum-ui/')}/index.html`));
    assert.match(index, /data-surface="phone"/);
    assert.equal(dec.decode(files.map.get(`${base}/shell/boot.js`)), '/* boot */');
    // Persist goes first: setServerBasePath reloads the WebView, and the page that awaits it may be gone before a later call.
    assert.deepEqual(calls.map(c => c[0]), ['persist', 'set']);
  });

  test('the Android activation writes the whole shell set (boot.js, shell.js, channel.worker.js, styles.css) next to the UI', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root, { desktopVersion: '1.4.2', generation: 4 });
    await desk.build();
    const files = fakeFiles();
    const calls = [];
    const webView = {
      persistServerBasePath: async ({ path: p }) => calls.push(['persist', p]),
      setServerBasePath: async ({ path: p }) => calls.push(['set', p]),
    };
    // The bundle names: /shell/<name> is boot.js, shell.js, channel.worker.js or styles.css, read from the root of the app's www folder. A
    // source name (app.js, channel.js) is not bundled, and the loader does not copy it.
    const bundled = { 'shell/boot.js': '/* boot */', 'shell/shell.js': 'import "./channel.worker.js";', 'shell/channel.worker.js': '// worker', 'shell/app.js': '// source', 'shell/channel.js': '// source' };
    const loader = createUiLoader({
      channel: desk.channel,
      storage: androidStorage({ files, webView }),
      platform: 'android',
      readBundled: async rel => (bundled[rel] ? enc.encode(bundled[rel]) : null),
    });
    await loader.check({ loadedHash: null });
    const base = calls.find(c => c[0] === 'set')[1];
    for (const rel of ['shell/boot.js', 'shell/shell.js', 'shell/channel.worker.js']) assert.equal(dec.decode(files.map.get(`${base}/${rel}`)), bundled[rel], rel);
    assert.equal(files.map.get(`${base}/shell/styles.css`), undefined, 'a file that is not bundled is skipped, not invented');
    assert.equal(files.map.get(`${base}/shell/app.js`), undefined, 'a source name is not a bundle name');
    assert.equal(files.map.get(`${base}/shell/channel.js`), undefined, 'a source module is not bundled on its own');
    assert.match(dec.decode(files.map.get(`${base}/index.html`)), /<script type="module" src="\/shell\/shell\.js"><\/script>/);
  });

  test('a complete record whose base path the WebView lost is activated again on the next check; a served one is left alone', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root, { desktopVersion: '1.4.2', generation: 5 });
    await desk.build();
    const files = fakeFiles();
    const calls = [];
    let served = null;
    const webView = {
      getServerBasePath: async () => ({ path: served }),
      persistServerBasePath: async ({ path: p }) => calls.push(['persist', p]),
      setServerBasePath: async ({ path: p }) => {
        calls.push(['set', p]);
        served = p;
      },
    };
    const loader = createUiLoader({ channel: desk.channel, storage: androidStorage({ files, webView }), platform: 'android' });
    await loader.check({ loadedHash: null });
    const base = calls.find(c => c[0] === 'set')[1];
    assert.equal(served, base);
    const record = await loader.current();

    calls.length = 0;
    served = null; // the persist or the set was lost: the WebView serves its default again
    const again = await loader.check({ helloHash: record.hash, loadedHash: record.hash });
    assert.equal(again.status, 'current');
    assert.deepEqual(calls.map(c => c[0]), ['persist', 'set'], 'activated again, once');
    assert.equal(served, base);

    calls.length = 0;
    await loader.check({ helloHash: record.hash, loadedHash: record.hash });
    assert.deepEqual(calls, [], 'a WebView that serves the slot is not touched');
  });

  test('check() stores computerId, and a current hash with another computerId rewrites the record without fetching', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(fakeCaches()), platform: 'web' });
    await loader.check({ helloHash: desk.manifest.hash, loadedHash: null, computerId: 'c-one' });
    const first = await loader.current();
    assert.equal(first.computerId, 'c-one');
    desk.requests.length = 0;
    const moved = await loader.check({ helloHash: desk.manifest.hash, loadedHash: desk.manifest.hash, computerId: 'c-two' });
    assert.equal(moved.status, 'current');
    assert.equal(desk.requests.length, 0, 'nothing is fetched, not even the manifest');
    const second = await loader.current();
    assert.equal(second.computerId, 'c-two');
    assert.equal(second.cacheName, first.cacheName, 'the cache stays the same');
    assert.equal(second.hash, first.hash);
  });

  test('every request the loader makes carries scope shell, in its options argument', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const seen = [];
    const channel = {
      request(spec, body, opts) {
        seen.push({ path: spec.path, scope: opts?.scope });
        return desk.channel.request(spec, body, opts);
      },
    };
    const loader = createUiLoader({ channel, storage: webStorage(fakeCaches()), platform: 'web' });
    await loader.check({ helloHash: desk.manifest.hash, loadedHash: null });
    assert.ok(seen.length > 1, 'the manifest and the files were requested');
    assert.deepEqual(seen.filter(r => r.scope !== 'shell'), [], 'every request is scoped to the shell');
  });
});

// ----- the service worker (sw.js) over the same fake caches -----

describe('sw.js: the UI, the artifact iframe, push and notifications', () => {
  function workerEnv(caches, extra = {}) {
    return {
      origin: 'https://phone.example',
      caches,
      clients: extra.clients ?? { matchAll: async () => [], openWindow: async () => {} },
      Response,
      MessageChannel,
      setTimeout,
      clearTimeout,
      shellBase: '/shell/',
      scope: '/',
      ...extra,
    };
  }

  test('serves the cached index rewritten and a cached UI file with its type and the page CSP', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const caches = fakeCaches();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(caches), platform: 'web' });
    await loader.check({ loadedHash: null });
    const env = workerEnv(caches);
    const index = await uiResponse(new Request('https://phone.example/'), env);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-security-policy'), UI_CSP);
    const html = await index.text();
    assert.match(html, /data-surface="phone"/);
    assert.match(html, /src="\/shell\/boot\.js"/);
    const js = await uiResponse(new Request('https://phone.example/app.js'), env);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await js.text(), 'window.appLoaded = true;\n');
  });

  test('a shell file the loader copied is answered from the active cache with the page CSP; one that is not copied goes to the network', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const caches = fakeCaches();
    const bundled = { 'shell/boot.js': '/* boot shim */' };
    const loader = createUiLoader({
      channel: desk.channel,
      storage: webStorage(caches),
      platform: 'web',
      readBundled: async rel => (bundled[rel] ? enc.encode(bundled[rel]) : null),
    });
    await loader.check({ loadedHash: null });
    const env = workerEnv(caches);
    const boot = await uiResponse(new Request('https://phone.example/shell/boot.js'), env);
    assert.equal(boot.status, 200);
    assert.equal(boot.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(boot.headers.get('content-security-policy'), UI_CSP);
    // The channel worker's script gets this header too, and a dedicated worker runs under its own response's policy: it must allow the
    // sockets to every carrier (27 Oct), not only this origin.
    assert.match(UI_CSP, /connect-src 'self' ws: wss:/);
    assert.equal(await boot.text(), '/* boot shim */');
    assert.equal(await uiResponse(new Request('https://phone.example/shell/channel.js'), env), null, 'not copied: the network answers');
    assert.equal(await uiResponse(new Request('https://phone.example/shell/'), env), null, 'the bare base is not a file');
    assert.equal(await uiResponse(new Request('https://other.example/shell/boot.js'), env), null, 'another origin is not answered');
  });

  test('a /shell/<bundle name> request that is not cached is fetched beside the worker, at / and at /p/<key>/, and no other name is', async () => {
    const asked = [];
    const fetched = async url => { asked.push(url); return new Response('/* from beside the worker */', { status: 200, headers: { 'content-type': 'text/javascript' } }); };
    const caches = fakeCaches();
    const root = new URL('https://phone.example/sw.js');
    const env = workerEnv(caches, { fetch: fetched, workerUrl: root.href });
    const res = await uiResponse(new Request('https://phone.example/shell/shell.js'), env);
    assert.equal(res.status, 200);
    assert.deepEqual(asked, ['https://phone.example/shell.js'], 'the bundle name, beside the worker');
    asked.length = 0;
    const lan = workerEnv(caches, { fetch: fetched, workerUrl: 'https://pc.tail.ts.net/p/abc123/sw.js', origin: 'https://pc.tail.ts.net' });
    await uiResponse(new Request('https://pc.tail.ts.net/shell/channel.worker.js'), lan);
    assert.deepEqual(asked, ['https://pc.tail.ts.net/p/abc123/channel.worker.js']);
    asked.length = 0;
    for (const name of ['app.js', 'channel.js', '..%2Fapp.js', 'sw.js']) assert.equal(await uiResponse(new Request(`https://phone.example/shell/${name}`), env), null, name);
    assert.deepEqual(asked, [], 'nothing else is fetched on the page\'s behalf');
  });

  test('the shell\'s own screens stay reachable: /?shell is not answered with the UI, even when a UI is cached', async () => {
    const root = makeRoot();
    const desk = fakeDesktop(root);
    await desk.build();
    const caches = fakeCaches();
    const loader = createUiLoader({ channel: desk.channel, storage: webStorage(caches), platform: 'web' });
    await loader.check({ loadedHash: null });
    const env = workerEnv(caches);
    assert.equal((await uiResponse(new Request('https://phone.example/'), env)).status, 200, 'the UI index');
    assert.equal(await uiResponse(new Request('https://phone.example/?shell'), env), null, 'the shell page goes to the network');
    assert.equal(await uiResponse(new Request('https://phone.example/?shell=1'), env), null);
  });

  test('answers nothing for another origin, a POST, a path that is not UI, or when no UI is cached', async () => {
    const caches = fakeCaches();
    const env = workerEnv(caches);
    assert.equal(await uiResponse(new Request('https://other.example/app.js'), env), null);
    assert.equal(await uiResponse(new Request('https://phone.example/app.js', { method: 'POST', body: 'x' }), env), null);
    assert.equal(await uiResponse(new Request('https://phone.example/api/state'), env), null);
    assert.equal(await uiResponse(new Request('https://phone.example/app.js'), env), null, 'nothing cached yet');
  });

  test('the artifact iframe is answered by the page, with its headers and the CSP it was sent', async () => {
    const seen = [];
    const client = {
      postMessage(msg, transfer) {
        seen.push(msg.path);
        const port = transfer[0];
        port.postMessage({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'", 'x-secret': 'no' }, body: enc.encode('<p>art</p>').buffer });
      },
    };
    const env = workerEnv(fakeCaches(), { clients: { matchAll: async () => [client], openWindow: async () => {} } });
    const res = await uiResponse(new Request(`https://phone.example${ARTIFACT_VIEW}?id=abc`), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(res.headers.get('x-secret'), null, 'headers outside the allowlist are dropped');
    assert.equal(await res.text(), '<p>art</p>');
    assert.deepEqual(seen, [`${ARTIFACT_VIEW}?id=abc`]);
  });

  test('the artifact iframe says Plenum is not connected when no window is open', async () => {
    const env = workerEnv(fakeCaches());
    const res = await artifactResponse(new URL(`https://phone.example${ARTIFACT_VIEW}?id=x`), env);
    assert.equal(res.status, 503);
  });

  test('a push that cannot be read still shows Plenum', async () => {
    const shown = [];
    const registration = { showNotification: async (title, options) => { shown.push({ title, options }); } };
    const env = { ...workerEnv(fakeCaches()), registration };
    await showPush({ data: { json() { throw new SyntaxError('bad'); } } }, env);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, 'Plenum');
    await showPush({ data: null }, env);
    assert.equal(shown[1].title, 'Plenum');
  });

  test('a push with a title keeps the stop and approve actions only when they are named', async () => {
    const shown = [];
    const registration = { showNotification: async (title, options) => { shown.push({ title, options }); } };
    const env = { ...workerEnv(fakeCaches()), registration };
    await showPush({ data: { json: () => ({ title: 'Plenum · Home PC', body: 'Codex wants to run a command', tag: 'approval', kind: 'approval', ids: { approval: 'a1', project: 'p1' }, actions: [{ action: 'approve', title: 'Approve', route: '/#approve=a1' }, { action: 'shell', title: 'x', route: '/#shell' }] }) } }, env);
    assert.equal(shown[0].title, 'Plenum · Home PC');
    assert.deepEqual(shown[0].options.actions, [{ action: 'approve', title: 'Approve' }]);
    assert.equal(shown[0].options.data.id, 'a1', 'the approval id comes from payload.ids.approval, where lib/remote/push.mjs puts it');
    assert.equal(shown[0].options.data.project, 'p1');
  });

  // The payload the computer really sends (buildPushText), for a single approval whose phone has the opt-in and the first line on.
  const REAL = buildPushText(
    { kind: 'approval', approvalId: '4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11', projectId: 'p1', projectName: 'my-app', count: 1, firstLine: 'Run: npm test -- --watch=false' },
    { prefs: { firstLine: true }, device: { tier: 'full', approveFromNotifications: true }, computer: { id: 'c1', name: 'Home PC' } },
  ).payload;
  const withRealPush = async (payload, extra = {}) => {
    const shown = [];
    const registration = { showNotification: async (title, options) => { shown.push({ title, options }); } };
    await showPush({ data: { json: () => payload } }, { ...workerEnv(fakeCaches()), registration, ...extra });
    return shown[0];
  };

  test('the real payload: Stop all is always kept, then Approve when the person opted in, else Deny, within what the browser allows', async () => {
    assert.deepEqual(REAL.actions.map(a => a.action), ['deny', 'stop', 'approve'], 'the computer sends all three');
    const two = await withRealPush(REAL, { maxActions: 2 });
    assert.deepEqual(two.options.actions.map(a => a.action), ['stop', 'approve'], 'Chrome shows two: Stop all and Approve');
    const three = await withRealPush(REAL, { maxActions: 3 });
    assert.deepEqual(three.options.actions.map(a => a.action), ['deny', 'stop', 'approve']);
    const none = await withRealPush(REAL, { maxActions: 0 });
    assert.deepEqual(none.options.actions, []);
    const noOptIn = buildPushText(
      { kind: 'approval', approvalId: 'a-1', projectId: 'p1', count: 1, firstLine: 'Run: x' },
      { prefs: { firstLine: true }, device: { tier: 'full', approveFromNotifications: false }, computer: { id: 'c1', name: 'Home PC' } },
    ).payload;
    assert.deepEqual((await withRealPush(noOptIn, { maxActions: 2 })).options.actions.map(a => a.action), ['deny', 'stop'], 'without the opt-in: Deny and Stop all');
    assert.deepEqual(chooseActions([{ action: 'stop' }, { action: 'nope' }], 2).map(a => a.action), ['stop']);
  });

  test('the real payload: the notification keeps the approval id, the project, the tap route, the first line and each action\'s route', async () => {
    const note = await withRealPush(REAL, { maxActions: 2 });
    assert.deepEqual(note.options.data, {
      kind: 'approval',
      id: '4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11',
      project: 'p1',
      tap: '/#waiting=4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11',
      line: 'Run: npm test -- --watch=false',
      routes: { deny: '/#deny=4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11', stop: '/#stop', approve: '/#approve=4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11' },
    });
    assert.equal(note.options.body.includes('npm test'), true);
  });

  test('a click opens the route the payload named: a tap the card, Deny and Stop their routes, Approve its route with the first line', async () => {
    const note = await withRealPush(REAL, { maxActions: 3 });
    const data = note.options.data;
    const id = '4f6f2c1e-8d6a-4a1e-9b1d-5d3c9a7a0b11';
    assert.equal(hashForClick('', data), `#waiting=${id}`);
    assert.equal(hashForClick('deny', data), `#deny=${id}`);
    assert.equal(hashForClick('stop', data), '#stop');
    assert.equal(hashForClick('approve', data), `#approve=${id}&line=${encodeURIComponent('Run: npm test -- --watch=false')}`, 'the first line rides along');
    assert.equal(hashForClick('approve', { ...data, line: '' }), `#approve=${id}`);
    assert.equal(hashForClick('', { ...data, tap: '/x' }), '', 'a tap route that is not a plenum route opens the app as it is');
    const opened = [];
    const noWindow = { clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
    await openFromNotification({ action: 'approve', notification: { data, close() {} } }, { ...workerEnv(fakeCaches()), ...noWindow });
    await openFromNotification({ action: '', notification: { data, close() {} } }, { ...workerEnv(fakeCaches()), ...noWindow });
    assert.deepEqual(opened, [`/#approve=${id}&line=${encodeURIComponent('Run: npm test -- --watch=false')}`, `/#waiting=${id}`]);
    // Every kind the computer sends has a tap route the page knows (push.js parseNotificationHash).
    for (const event of [{ kind: 'handover', approvalId: 'd1', projectId: 'p1', firstLine: 'Enter the code' }, { kind: 'finished', projectId: 'p1' }, { kind: 'failed', projectId: 'p1' }, { kind: 'limit', limitKind: 'spend' }, { kind: 'test' }]) {
      const payload = buildPushText(event, { prefs: {}, device: { tier: 'full' }, computer: { id: 'c1', name: 'Home PC' } }).payload;
      const shownNote = await withRealPush(payload);
      assert.match(hashForClick('', shownNote.options.data), /^#(handover=d1|chat=p1|settings=limit|home)$/, event.kind);
    }
  });

  test('a notification tap opens the app at the matching fragment, or focuses the window that is open', async () => {
    assert.equal(hashFor('stop'), '#stop');
    assert.equal(hashFor('deny', 'x1'), '#deny=x1');
    assert.equal(hashFor('approve', 'x/../2'), '#approve=x..2', 'a slash is dropped from an id');
    assert.equal(hashFor('approve', ''), '');
    const opened = [];
    const focused = [];
    const noWindow = { clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
    await openFromNotification({ action: 'approve', notification: { data: { id: 'a9' }, close() {} } }, { ...workerEnv(fakeCaches()), ...noWindow });
    assert.deepEqual(opened, ['/#approve=a9']);
    const client = { focus: async () => focused.push('focus'), postMessage: msg => focused.push(msg) };
    await openFromNotification({ action: 'stop', notification: { data: {}, close() {} } }, { ...workerEnv(fakeCaches()), clients: { matchAll: async () => [client], openWindow: async () => {} } });
    assert.deepEqual(focused, ['focus', { op: 'plenum-hash', hash: '#stop' }]);
  });

  test('installWorker wires the events and never answers a request it does not own', async () => {
    const handlers = new Map();
    const self = {
      location: new URL('https://phone.example/'),
      Response,
      MessageChannel,
      setTimeout,
      clearTimeout,
      addEventListener: (name, fn) => handlers.set(name, fn),
      skipWaiting: async () => {},
    };
    installWorker(self, { caches: fakeCaches(), clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} }, registration: {} });
    assert.deepEqual([...handlers.keys()].sort(), ['activate', 'fetch', 'install', 'notificationclick', 'push']);
    let responded = false;
    handlers.get('fetch')({ request: new Request('https://phone.example/api/state'), respondWith() { responded = true; } });
    assert.equal(responded, false);
  });
});

// ----- the real sealed server: the desktop's own files, pulled through a loopback bridge -----
// The Bridge's part is played here: the manifest is computed from the sealed copy's public/ (what the Bridge does), and each file
// is read from the sealed server's own static route with the real token. The loader then verifies and caches them as on the phone.
describe('ui-loader against the sealed server (loopback bridge)', () => {
  let server = null;
  before(async () => {
    server = await startSealedServer({ name: 'mob09-loader', projects: ['p1'] });
  });
  after(async () => {
    await server?.stop();
  });

  function serverBridge(root, desktop) {
    return {
      async request({ method = 'GET', path: p = '/' } = {}) {
        if (p === MANIFEST_PATH) return reply(200, enc.encode(JSON.stringify(desktop)));
        const res = await fetch(`${server.url}${p}`, { method, headers: { 'x-plenum-token': server.token } });
        const bytes = new Uint8Array(await res.arrayBuffer());
        return reply(res.status, bytes);
      },
    };
  }

  test('index.html, app.js and every ext-*.js and ext-*.css are pulled, verified and cached; a changed byte is rejected and the old copy kept', async () => {
    resetManifestCache();
    const desktop = await manifest({ root: server.appRoot, desktopVersion: 'sealed', generation: 1, overlay, fs, crypto });
    const extCount = desktop.files.filter(f => /^\/ext-/.test(f.path)).length;
    assert.ok(extCount >= 40, 'the sealed copy has its panels');
    const caches = fakeCaches();
    const loader = createUiLoader({ channel: serverBridge(server.appRoot, desktop), storage: webStorage(caches), platform: 'web' });
    const first = await loader.check({ helloHash: desktop.hash, loadedHash: null });
    assert.equal(first.status, 'updated');
    assert.equal(first.changed.length, desktop.files.length, 'every file was fetched once');
    const active = await loader.current();
    const slot = caches.store.get(active.cacheName);
    assert.ok(slot.has('/') && slot.has('/app.js') && slot.has('/ext.js'));
    const appOnDisk = fs.readFileSync(path.join(server.appRoot, 'public', 'app.js'));
    assert.deepEqual(new Uint8Array(slot.get('/app.js').bytes), new Uint8Array(appOnDisk), 'the cached app.js is the server\'s file');
    // The server's copy changes after the manifest was made: the phone must refuse it and keep what it had.
    const file = path.join(server.appRoot, 'public', 'app.js');
    const original = fs.readFileSync(file);
    const tampered = Buffer.from(original);
    tampered[0] ^= 1; // one bit, same size: only the sha256 check can catch it
    try {
      // The manifest claims the tampered bytes; the server then serves the original, which does not match what was claimed.
      fs.writeFileSync(file, tampered);
      const claimed = await manifest({ root: server.appRoot, desktopVersion: 'sealed', generation: 2, overlay, fs, crypto });
      fs.writeFileSync(file, original);
      const next = createUiLoader({ channel: serverBridge(server.appRoot, claimed), storage: webStorage(caches), platform: 'web' });
      await assert.rejects(next.check({ helloHash: claimed.hash, loadedHash: active.hash }), err => err.code === 'verify');
      assert.equal((await loader.current()).hash, active.hash, 'the old UI stays active');
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});

// ----- storage round trips -----

describe('webStorage and the active record', () => {
  test('a slot keeps the bytes and the checked sha256 and size; dropSlotsExcept never removes the active record', async () => {
    const caches = fakeCaches();
    const storage = webStorage(caches);
    await storage.writeActive({ hash: 'h', cacheName: 'plenum-ui-a', complete: true });
    const slot = await storage.openSlot('plenum-ui-a');
    await slot.put('/app.js', enc.encode('x'), { type: 'text/javascript', sha256: sha256Hex(enc.encode('x')), size: 1 });
    const got = await slot.get('/app.js');
    assert.equal(dec.decode(got.bytes), 'x');
    assert.equal(got.sha256, sha256Hex(enc.encode('x')));
    await storage.openSlot('plenum-ui-old');
    await storage.dropSlotsExcept('plenum-ui-a');
    assert.ok(caches.store.has(ACTIVE_CACHE), 'the active record survives');
    assert.ok(!caches.store.has('plenum-ui-old'));
    assert.equal((await storage.readActive()).hash, 'h');
    assert.equal(ACTIVE_PATH, '/__plenum/active.json');
  });

  test('readActive gives the computerId of the record, and null for a record written before plan C9, on web and Android', async () => {
    const web = webStorage(fakeCaches());
    await web.writeActive({ hash: 'h', cacheName: 'plenum-ui-a', complete: true });
    assert.equal((await web.readActive()).computerId, null);
    await web.writeActive({ hash: 'h', cacheName: 'plenum-ui-a', complete: true, computerId: 'c-9' });
    assert.equal((await web.readActive()).computerId, 'c-9');
    const android = androidStorage({ files: fakeFiles() });
    await android.writeActive({ hash: 'h', cacheName: 'plenum-ui-a', complete: true });
    assert.equal((await android.readActive()).computerId, null);
    await android.writeActive({ hash: 'h', cacheName: 'plenum-ui-a', complete: true, computerId: 'c-9' });
    assert.equal((await android.readActive()).computerId, 'c-9');
  });
});
