// Module resolve hook for applied Plenum updates. lib/overlay/register.cjs registers it (module.register) when a generation is
// active; it runs on the loader's own thread, and it is never overlaid itself.
//
// What it does, and nothing else: an import whose target is a file in the install folder, and which the active generation holds,
// is answered with the same relative path under the generation's folder. The generation's file list is fixed at registration
// (data.files, each path checked by the bootstrap against the same rules as the Updates panel), so no path from a request or from
// the module being loaded can pick another file. Modules loaded from the generation resolve their own imports as if they sat at
// the same place in the install folder, so a bare package name finds the install's node_modules and a relative import finds the
// install's other files. A module that exists only in the generation (a new route) loads because the relative or file: import
// that names it is answered here before the loader looks for a file that is not there. There is no load hook.
//
// Node's resolver answers with real paths. When the install folder or the state folder, or a folder above one of them, is a junction
// or a symbolic link (C:\Users\me\Work a junction to D:\Moved\Work), an import comes back as file:///D:/Moved/Work/..., not in the
// spelling the bootstrap was given. Both spellings name the same files, so each folder is known in both, and a URL in either counts.
// The answer is always in the one spelling of overlayUrl.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Each list holds the folder as written first, then its real places when they are spelled otherwise.
let appRootHrefs = [];
let overlayDir = '';
let overlayHrefs = [];
let files = new Set();

// 'file:///C:/some/folder/' for a folder, always with the closing slash.
function folderHref(dir) {
  const href = pathToFileURL(path.resolve(dir)).href;
  return href.endsWith('/') ? href : `${href}/`;
}

// Windows paths are not case sensitive, so the folder prefix is compared without case there. The relative path stays as written.
const fold = text => (process.platform === 'win32' ? text.toLowerCase() : text);

// The folder as written, then where it really is: fs.realpathSync.native (what the system says), and fs.realpathSync (the one Node's
// resolver uses, which keeps a subst or mapped drive letter). A folder that cannot be resolved has the written spelling only.
function folderHrefs(dir) {
  const written = path.resolve(dir);
  const hrefs = [folderHref(written)];
  for (const real of [fs.realpathSync.native, fs.realpathSync]) {
    let href;
    try {
      href = folderHref(real(written));
    } catch {
      continue;
    }
    if (!hrefs.some(h => fold(h) === fold(href))) hrefs.push(href);
  }
  return hrefs;
}

// The first of the folders that the URL is under, or null.
function folderOf(href, folders) {
  const bare = fold(href.split(/[?#]/, 1)[0]);
  return folders.find(folder => bare.startsWith(fold(folder))) ?? null;
}

// The path under one of the folders, in forward slashes and decoded, or null when the URL is under none of them.
function relativeUnder(href, folders) {
  const folder = folderOf(href, folders);
  if (folder === null) return null;
  try {
    return decodeURIComponent(href.split(/[?#]/, 1)[0].slice(folder.length));
  } catch {
    return null;
  }
}

// The URL of a file of the generation. Every module is loaded from this one spelling, so a module is never loaded twice.
const overlayUrl = rel => pathToFileURL(path.join(overlayDir, ...rel.split('/'))).href;

export function initialize(data) {
  appRootHrefs = folderHrefs(data.appRoot);
  overlayDir = path.resolve(data.overlayDir);
  overlayHrefs = folderHrefs(overlayDir);
  files = new Set((Array.isArray(data.files) ? data.files : []).filter(p => typeof p === 'string'));
}

const isFileSpecifier = spec => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('file:');

export async function resolve(specifier, context, nextResolve) {
  let ctx = context;
  let parent = context.parentURL;
  // A module that was loaded from the generation behaves as if it sat at the same place in the install folder.
  const from = typeof parent === 'string' ? folderOf(parent, overlayHrefs) : null;
  if (from !== null) {
    parent = appRootHrefs[0] + parent.slice(from.length);
    ctx = { ...context, parentURL: parent };
  }
  if (typeof parent === 'string' && isFileSpecifier(specifier)) {
    let target = null;
    try {
      target = new URL(specifier, parent);
    } catch {
      target = null;
    }
    if (target && target.protocol === 'file:') {
      const rel = relativeUnder(target.href, appRootHrefs);
      if (rel !== null && files.has(rel)) return { url: overlayUrl(rel) + target.search + target.hash, shortCircuit: true };
    }
  }
  const result = await nextResolve(specifier, ctx);
  if (typeof result.url === 'string' && result.url.startsWith('file:')) {
    // A file of the generation that the resolver found in the install folder, or in the generation's own folder under its real
    // spelling, is answered with the one overlay URL.
    const rel = [relativeUnder(result.url, appRootHrefs), relativeUnder(result.url, overlayHrefs)].find(r => r !== null && files.has(r));
    if (rel !== undefined) {
      const tail = result.url.slice(result.url.split(/[?#]/, 1)[0].length);
      return { ...result, url: overlayUrl(rel) + tail };
    }
  }
  return result;
}
