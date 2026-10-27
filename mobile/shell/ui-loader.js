// The phone's UI loader (mob-09, wave 105; MOBILE.json client_model.ui_source and client_model.shims). It pulls the desktop's UI over
// the channel, checks every file's sha256 against the manifest before it keeps the file, and makes the copy the UI loads from:
//   web (PWA):   Cache Storage. Each manifest gets its own cache (plenum-ui-<version>-<generation>-<hash>); sw.js serves from the
//                cache named in the active record. A file whose bytes do not match is refused and the old cache stays active.
//   Android:     files under the app-data folder, then Capacitor's WebView.persistServerBasePath and setServerBasePath (after every
//                file verified; persist goes first, because setServerBasePath reloads the WebView at once). The index and the shell
//                files (SHELL_FILES: boot.js, shell.js, channel.worker.js, styles.css) are written there too, so the base path
//                is a whole UI. A complete record whose base path the WebView no longer has is activated again (ensureActive).
//   iOS:         refused. The App Store build runs the bundled snapshot (MOBILE.json client_model.ui_source.ios); pull() throws
//                UiError('refused') and nothing is fetched.
//
// The loader holds no keys and no token. It talks to the computer only through channel.request (REQ GET of the manifest path and
// of each file); the Bridge answers /_bridge/ui-manifest and proxies the static paths.
//
//   const loader = createUiLoader({ channel, caches: globalThis.caches, platform: 'web' });
//   const result = await loader.check({ helloHash, loadedHash, computerId });
//     -> { status: 'current' | 'updated', hash, generation, changed: [paths], reload: boolean, record }
//     reload is true at most once per new UI hash (shouldReload), so a desktop update reloads the page one time.
//     computerId (plan C9) names the computer the active UI came from (null when unknown). A current hash with another computerId
//     rewrites the active record with that id and fetches nothing: one UI slot, owned by the computer it was pulled from.
//     Every request the loader makes carries { scope: 'shell' }, so the channel knows it is the shell's, not the page's.
//   Errors: UiError with a code: 'manifest' (damaged or missing), 'verify' (sha256 mismatch), 'size', 'fetch', 'refused', 'storage'.
//
// The pure functions (checkManifest, verifyBytes, diffFiles, shouldReload, cacheNameFor) are exported for the Node suites.

import { sha256 } from '@noble/hashes/sha2.js';
import { MANIFEST_PATH, contentTypeFor, fileNameFor, isUiPath, manifestHash, rewriteIndex } from '../../lib/remote/ui-manifest.mjs';

export const CACHE_PREFIX = 'plenum-ui-';
export const ACTIVE_CACHE = 'plenum-ui-active';
export const ACTIVE_PATH = '/__plenum/active.json';
export const SHA_HEADER = 'x-plenum-sha256';
export const SIZE_HEADER = 'x-plenum-size';
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const BOOT_FILE = 'shell/boot.js';
// The shell files the UI page loads from its own base: /shell/<name> always means the BUNDLE names scripts/build-mobile.mjs writes (boot.js,
// shell.js, channel.worker.js, styles.css), and readBundled(rel) reads `shell/<name>` from the root of the app's www folder. A file that is not
// bundled is skipped.
export const SHELL_FILES = Object.freeze([BOOT_FILE, 'shell/shell.js', 'shell/channel.worker.js', 'shell/styles.css']);

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();
const HEX64 = /^[0-9a-f]{64}$/;

export class UiError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'UiError';
    this.code = code;
  }
}

export function hexOf(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function sha256Hex(bytes) {
  return hexOf(sha256(bytes));
}

// Throws when the bytes are not the file the manifest names. Never keeps a copy that fails.
export function verifyBytes(bytes, entry) {
  if (bytes.byteLength !== entry.size) throw new UiError('size', `${entry.path} is ${bytes.byteLength} bytes, not ${entry.size}`);
  if (sha256Hex(bytes) !== entry.sha256) throw new UiError('verify', `${entry.path} does not match the manifest`);
  return true;
}

// Checks the manifest's shape and its hash (the same canonical list the desktop hashes). Returns a clean copy.
export function checkManifest(value) {
  const bad = (why) => new UiError('manifest', `The computer sent a damaged UI manifest (${why}).`);
  if (!value || typeof value !== 'object' || !Array.isArray(value.files) || typeof value.hash !== 'string') throw bad('shape');
  const seen = new Set();
  const files = [];
  for (const f of value.files) {
    if (!f || typeof f.path !== 'string' || !isUiPath(f.path)) throw bad('path');
    if (seen.has(f.path)) throw bad('duplicate');
    if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) throw bad('sha256');
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw bad('size');
    seen.add(f.path);
    files.push({ path: f.path, sha256: f.sha256, size: f.size, type: typeof f.type === 'string' ? f.type.slice(0, 100) : 'application/octet-stream' });
  }
  if (!seen.has('/')) throw bad('no index');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const desktopVersion = String(value.desktopVersion ?? '');
  if (desktopVersion.length > 40) throw bad('version');
  const generation = value.generation === null || value.generation === undefined ? null : value.generation;
  if (generation !== null && !Number.isInteger(generation)) throw bad('generation');
  // The hash covers the version, the generation and the files, exactly as the desktop computed it (ui-manifest.mjs manifestHash).
  const hashText = text => sha256Hex(utf8.encode(text));
  if (manifestHash(files, hashText, { desktopVersion, generation }) !== value.hash) throw bad('hash');
  return { desktopVersion, generation, hash: value.hash, files };
}

// The cache a manifest's files live in. Two manifests never share one, so an update never mixes old and new files.
export function cacheNameFor(manifest) {
  const slug = text => String(text).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  return `${CACHE_PREFIX}${slug(manifest.desktopVersion || 'dev')}-${manifest.generation ?? 0}-${slug(manifest.hash.slice(0, 16))}`;
}

// Which files must be downloaded: every file whose sha256 is new, or whose copy the previous cache does not hold. Files the new
// manifest drops are listed as removed.
export function diffFiles(previousFiles, next, hasCopy = () => false) {
  const before = new Map((previousFiles ?? []).map(f => [f.path, f.sha256]));
  const changed = [];
  const reused = [];
  for (const f of next.files) {
    if (before.get(f.path) === f.sha256 && hasCopy(f)) reused.push(f.path);
    else changed.push(f);
  }
  const keep = new Set(next.files.map(f => f.path));
  const removed = [...before.keys()].filter(p => !keep.has(p));
  return { changed, reused, removed };
}

// True once for each new UI: the page has a loaded UI with another hash, and that new hash has not been reloaded for yet.
export function shouldReload({ loadedHash, nextHash, reloadedFor }) {
  if (!loadedHash || !nextHash || loadedHash === nextHash) return false;
  return reloadedFor !== nextHash;
}

// Reads a ReadableStream to the end. Stops (and cancels the stream) past cap bytes.
export async function readAll(body, cap = MAX_FILE_BYTES) {
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      reader.cancel().catch(() => {});
      throw new UiError('size', 'The file is larger than the UI allows.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// The computer id a record carries: a string, or null (records written before plan C9 have none).
function computerOf(value) {
  return typeof value === 'string' ? value : null;
}

// Storage over the Cache API. A slot is one cache; its entries hold the bytes plus the sha256 and size the loader checked.
export function webStorage(caches) {
  const slotOn = cache => ({
    async get(path) {
      const res = await cache.match(path);
      if (!res) return null;
      return { bytes: new Uint8Array(await res.arrayBuffer()), sha256: res.headers.get(SHA_HEADER), size: Number(res.headers.get(SIZE_HEADER)) };
    },
    async put(path, bytes, entry) {
      await cache.put(path, new Response(bytes, {
        headers: { 'content-type': entry.type, [SHA_HEADER]: entry.sha256, [SIZE_HEADER]: String(entry.size), 'cache-control': 'no-store' },
      }));
    },
  });
  return {
    async readActive() {
      const cache = await caches.open(ACTIVE_CACHE);
      const res = await cache.match(ACTIVE_PATH);
      const record = res ? JSON.parse(await res.text()) : null;
      return record ? { ...record, computerId: computerOf(record.computerId) } : null;
    },
    async writeActive(record) {
      const cache = await caches.open(ACTIVE_CACHE);
      await cache.put(ACTIVE_PATH, new Response(JSON.stringify(record), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
    },
    async openSlot(name) {
      return slotOn(await caches.open(name));
    },
    async dropSlot(name) {
      if (name !== ACTIVE_CACHE) await caches.delete(name);
    },
    async dropSlotsExcept(name) {
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== ACTIVE_CACHE && key !== name) await caches.delete(key);
      }
    },
    async activate() {},
  };
}

// The bundled shell files that exist, as { path: '/shell/...', bytes }. readBundled(rel) returns the bytes or null.
async function bundledShellFiles(readBundled) {
  const out = [];
  if (!readBundled) return out;
  for (const rel of SHELL_FILES) {
    let bytes = null;
    try {
      bytes = await readBundled(rel);
    } catch {
      bytes = null;
    }
    if (bytes && bytes.byteLength) out.push({ path: `/${rel}`, bytes });
  }
  return out;
}

// Storage over the app-data folder (Android). files: { write(rel, bytes), read(rel) -> Uint8Array | null, removeDir(rel) }.
// webView: { setServerBasePath({ path }), persistServerBasePath({ path }), getServerBasePath() } (Capacitor core WebView plugin).
export function androidStorage({ files, webView, root = 'plenum-ui' }) {
  const base = name => `${root}/${name}`;
  const slotOn = name => ({
    async get(path) {
      const bytes = await files.read(`${base(name)}/${fileNameFor(path)}`);
      if (!bytes) return null;
      return { bytes, sha256: null, size: bytes.byteLength };
    },
    async put(path, bytes) {
      await files.write(`${base(name)}/${fileNameFor(path)}`, bytes);
    },
  });
  // Makes the slot the one the WebView serves: the shell files and the rewritten index go in first, and the base path is set only
  // after every file is in place. Persist goes before set: setServerBasePath reloads the WebView at once, and the page that awaits it
  // may be gone before a later call would run.
  async function activate(record, { readBundled, shellBase } = {}) {
    const dir = base(record.cacheName);
    const index = await files.read(`${dir}/index.html`);
    if (!index) throw new UiError('storage', 'The index is missing.');
    for (const file of await bundledShellFiles(readBundled)) await files.write(`${dir}/${fileNameFor(file.path)}`, file.bytes);
    const html = rewriteIndex(utf8Decode.decode(index), { shellBase });
    await files.write(`${dir}/index.html`, utf8.encode(html));
    await webView?.persistServerBasePath({ path: dir });
    await webView?.setServerBasePath({ path: dir });
  }
  return {
    async readActive() {
      const bytes = await files.read(`${root}/active.json`);
      const record = bytes ? JSON.parse(utf8Decode.decode(bytes)) : null;
      return record ? { ...record, computerId: computerOf(record.computerId) } : null;
    },
    async writeActive(record) {
      await files.write(`${root}/active.json`, utf8.encode(JSON.stringify(record)));
    },
    async openSlot(name) {
      return slotOn(name);
    },
    async dropSlot(name) {
      await files.removeDir(base(name));
    },
    activate,
    // A complete record the WebView does not serve (its persist or set was lost) is activated again. A WebView without
    // getServerBasePath is left alone.
    async ensureActive(record, opts = {}) {
      if (!webView?.getServerBasePath) return false;
      const current = await webView.getServerBasePath();
      if (current?.path === base(record.cacheName)) return false;
      await activate(record, opts);
      return true;
    },
    async dropSlotsExcept(name) {
      const dirs = (await files.listDirs?.(root)) ?? [];
      for (const dir of dirs) {
        if (dir !== name && dir.startsWith(CACHE_PREFIX)) await files.removeDir(base(dir));
      }
    },
  };
}

export function createUiLoader({
  channel,
  storage,
  platform = 'web',
  shellBase = '/shell/',
  readBundled = null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!channel || typeof channel.request !== 'function') throw new TypeError('createUiLoader needs a channel');
  if (!storage) throw new TypeError('createUiLoader needs a storage');

  async function fetchFile(path, max) {
    const res = await channel.request({ method: 'GET', path, headers: { accept: '*/*' } }, null, { scope: 'shell' });
    if (res.status !== 200) {
      res.cancel?.();
      throw new UiError('fetch', `${path}: the computer answered ${res.status}`);
    }
    return readAll(res.body, max);
  }

  async function fetchManifest() {
    const bytes = await fetchFile(MANIFEST_PATH, MAX_MANIFEST_BYTES);
    let value;
    try {
      value = JSON.parse(utf8Decode.decode(bytes));
    } catch {
      throw new UiError('manifest', 'The computer sent a UI manifest that is not JSON.');
    }
    return checkManifest(value);
  }

  // The active record already holds this hash: nothing to fetch. A page that runs another hash still reloads, once. A record that names
  // another computer is written again with this one's id (plan C9); the cache stays as it is.
  async function alreadyCurrent(prev, loadedHash, computerId = null) {
    const reload = shouldReload({ loadedHash, nextHash: prev.hash, reloadedFor: prev.reloadedFor ?? null });
    const owner = computerOf(computerId);
    const moved = computerOf(prev.computerId) !== owner;
    let record = prev;
    if (reload || moved) {
      record = { ...prev, computerId: owner, ...(reload ? { reloadedFor: prev.hash } : {}) };
      await storage.writeActive(record);
    }
    // On Android the WebView may have lost its base path (the persist or the set never landed): put it right here, before the early
    // return, so the next start serves this UI. A failure is logged and the check still answers 'current'.
    try {
      await storage.ensureActive?.(prev, { readBundled, shellBase });
    } catch (err) {
      log(`ui: ${err.code ?? 'error'}`);
    }
    return { status: 'current', hash: prev.hash, generation: prev.generation, changed: [], reload, record };
  }

  // Pulls what changed. loadedHash is the hash of the UI this page runs (null on the first load).
  async function pull({ loadedHash = null, computerId = null } = {}) {
    if (platform === 'ios') throw new UiError('refused', 'iOS runs the bundled UI; desktop files are refused.');
    const next = await fetchManifest();
    const prev = await storage.readActive();
    if (prev && prev.hash === next.hash && prev.complete) return alreadyCurrent(prev, loadedHash, computerId);
    const cacheName = cacheNameFor(next);
    const slot = await storage.openSlot(cacheName);
    const previousSlot = prev && prev.cacheName !== cacheName ? await storage.openSlot(prev.cacheName) : null;
    const diff = diffFiles(prev?.files ?? null, next, () => previousSlot !== null);
    const changed = [];
    try {
      for (const entry of diff.changed) {
        const have = await slot.get(entry.path);
        if (have && have.size === entry.size && sha256Hex(have.bytes) === entry.sha256) continue;
        const bytes = await fetchFile(entry.path, MAX_FILE_BYTES);
        verifyBytes(bytes, entry);
        await slot.put(entry.path, bytes, entry);
        changed.push(entry.path);
      }
      for (const path of diff.reused) {
        const old = await previousSlot.get(path);
        const entry = next.files.find(f => f.path === path);
        if (old && old.bytes.byteLength === entry.size && sha256Hex(old.bytes) === entry.sha256) {
          await slot.put(path, old.bytes, entry);
        } else {
          const bytes = await fetchFile(path, MAX_FILE_BYTES);
          verifyBytes(bytes, entry);
          await slot.put(path, bytes, entry);
          changed.push(path);
        }
      }
      // The shell files the page loads from its own base. They are not in the desktop's manifest (they come from the bundled www), so
      // they are not checked against it; the slot keeps their bytes and their sha256 for the service worker. Android also copies them
      // in activate.
      for (const file of await bundledShellFiles(readBundled)) {
        await slot.put(file.path, file.bytes, { type: contentTypeFor(fileNameFor(file.path)), sha256: sha256Hex(file.bytes), size: file.bytes.byteLength });
      }
    } catch (err) {
      // The active record is not written, so the old UI stays the one served. Only the half-filled cache is dropped.
      await storage.dropSlot(cacheName).catch(() => {});
      log(`ui: ${err.code ?? 'error'}`);
      throw err;
    }
    const reload = shouldReload({ loadedHash, nextHash: next.hash, reloadedFor: prev?.reloadedFor ?? null });
    const record = {
      hash: next.hash,
      generation: next.generation,
      desktopVersion: next.desktopVersion,
      cacheName,
      complete: true,
      reloadedFor: reload ? next.hash : (prev?.reloadedFor ?? null),
      files: next.files,
      pulledAt: now(),
      computerId: computerOf(computerId),
    };
    await storage.writeActive(record);
    await storage.activate?.(record, { readBundled, shellBase });
    await storage.dropSlotsExcept(cacheName);
    return { status: 'updated', hash: next.hash, generation: next.generation, changed, reload, record };
  }

  return {
    pull,
    // The HELLO's uiManifestHash decides whether anything needs fetching: equal hashes need no manifest request at all.
    async check({ helloHash = null, loadedHash = null, computerId = null } = {}) {
      if (platform === 'ios') throw new UiError('refused', 'iOS runs the bundled UI; desktop files are refused.');
      const prev = await storage.readActive();
      if (prev && prev.complete && helloHash && prev.hash === helloHash) return alreadyCurrent(prev, loadedHash, computerId);
      return pull({ loadedHash, computerId });
    },
    current: () => storage.readActive(),
  };
}

// The bundled UI for iOS and for a phone that has no desktop yet: nothing to pull, nothing to check.
export function bundledOnly() {
  return { status: 'bundled', hash: null, generation: null, changed: [], reload: false, record: null };
}
