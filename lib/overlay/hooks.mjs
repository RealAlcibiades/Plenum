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
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let appRootHref = '';
let overlayDir = '';
let overlayHref = '';
let files = new Set();

// 'file:///C:/some/folder/' for a folder, always with the closing slash.
function folderHref(dir) {
  const href = pathToFileURL(path.resolve(dir)).href;
  return href.endsWith('/') ? href : `${href}/`;
}

// Windows paths are not case sensitive, so the folder prefix is compared without case there. The relative path stays as written.
const fold = text => (process.platform === 'win32' ? text.toLowerCase() : text);

// The path under a folder, in forward slashes and decoded, or null when the URL is not under it.
function relativeUnder(href, folder) {
  const bare = href.split(/[?#]/, 1)[0];
  if (!fold(bare).startsWith(fold(folder))) return null;
  try {
    return decodeURIComponent(bare.slice(folder.length));
  } catch {
    return null;
  }
}

// The URL of a file of the generation. Every module is loaded from this one spelling, so a module is never loaded twice.
const overlayUrl = rel => pathToFileURL(path.join(overlayDir, ...rel.split('/'))).href;

export function initialize(data) {
  appRootHref = folderHref(data.appRoot);
  overlayDir = path.resolve(data.overlayDir);
  overlayHref = folderHref(overlayDir);
  files = new Set((Array.isArray(data.files) ? data.files : []).filter(p => typeof p === 'string'));
}

const isFileSpecifier = spec => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('file:');

export async function resolve(specifier, context, nextResolve) {
  let ctx = context;
  let parent = context.parentURL;
  // A module that was loaded from the generation behaves as if it sat at the same place in the install folder.
  if (typeof parent === 'string' && relativeUnder(parent, overlayHref) !== null) {
    parent = appRootHref + parent.slice(overlayHref.length);
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
      const rel = relativeUnder(target.href, appRootHref);
      if (rel !== null && files.has(rel)) return { url: overlayUrl(rel) + target.search + target.hash, shortCircuit: true };
    }
  }
  const result = await nextResolve(specifier, ctx);
  if (typeof result.url === 'string' && result.url.startsWith('file:')) {
    const rel = relativeUnder(result.url, appRootHref);
    if (rel !== null && files.has(rel)) {
      const tail = result.url.slice(result.url.split(/[?#]/, 1)[0].length);
      return { ...result, url: overlayUrl(rel) + tail };
    }
  }
  return result;
}
