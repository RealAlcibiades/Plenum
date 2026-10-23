// The text of a PDF, for a model that takes no PDF (every model except Claude through an API key). The text is read with pdfjs-dist
// (Mozilla's PDF reader, pure JavaScript, pinned in package.json) inside a worker thread, so a malicious or huge file cannot hold up
// or crash the server: the worker has a memory limit, and it is terminated after 20 seconds whatever it is doing.
//
//   pdfTexts(documents, options) -> [{ name, text, pages }]   documents: [{ name, data }] with data in base64.
//
// A PDF is refused with a plain message (and nothing is sent) when it has more than 100 pages, when its text is more than 200 KB, when
// it has no text layer (fewer than 20 characters that are not spaces, as for a scanned image), when it takes longer than 20 seconds,
// or when it is not a PDF pdfjs can read. A Node older than pdfjs-dist's engines field is refused the same way, before any file is read.
//
// Only the text is taken: pdfjs parses fonts and text positions, and its image decoders are never run, because Plenum makes no page
// images (that needs a native canvas module). Each document is read with eval disabled (isEvalSupported false), no font or CMap is
// fetched from the network (disableAutoFetch, disableStream, and the font and CMap folders are read from the package), and the worker's
// output is only the page texts.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatBytes } from './images.mjs';

const require = createRequire(import.meta.url);

export const MAX_PAGES = 100;
export const MAX_TEXT_BYTES = 200 * 1024;
export const MAX_SECONDS = 20;
const MIN_NON_SPACE = 20;
const WORKER_MEMORY_MB = 512;

// The worker's code. It runs as a script (eval), so it reads its input from workerData only. It posts { type: 'pages', count } first, so
// a PDF over the page limit is refused before its text is read, then { type: 'text', pages } or { type: 'failed' }.
function workerMain() {
  const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    try {
      const lib = await import(workerData.library);
      const doc = await lib.getDocument({
        data: new Uint8Array(workerData.bytes),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        disableAutoFetch: true,
        disableStream: true,
        verbosity: 0,
        cMapUrl: workerData.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: workerData.standardFontDataUrl,
      }).promise;
      parentPort.postMessage({ type: 'pages', count: doc.numPages });
      if (doc.numPages > workerData.maxPages) return;
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => (typeof item.str === 'string' ? item.str : '') + (item.hasEOL ? '\n' : ' ')).join('').trim());
      }
      parentPort.postMessage({ type: 'text', pages });
    } catch {
      parentPort.postMessage({ type: 'failed' });
    }
  })();
}

// A folder as pdfjs wants it: forward slashes and a trailing slash, on every platform.
const folderUrl = dir => `${dir.split(path.sep).join('/')}/`;

// The pdfjs-dist package: its engines field, and the folders it reads fonts and CMaps from. Read from the installed package.
function pdfjsPackage() {
  const json = require('pdfjs-dist/package.json');
  const dir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return { engines: String(json.engines?.node ?? ''), dir };
}

// The version triple of a ">=22.13.0" alternative, or null.
const bound = text => {
  const m = String(text).trim().match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// null when this Node can run pdfjs-dist, otherwise the plain sentence that says what Node is needed. The lowest alternative of the
// engines field is the version named.
export function pdfTextSupport(nodeVersion = process.versions.node, pkg = pdfjsPackage()) {
  const bounds = pkg.engines.split('||').map(bound).filter(Boolean);
  if (!bounds.length) return null;
  const here = nodeVersion.split('.').map(Number);
  if (bounds.some(b => cmp(here, b) >= 0)) return null;
  const lowest = bounds.reduce((a, b) => (cmp(a, b) <= 0 ? a : b));
  return `Reading PDFs as text needs Node ${lowest.join('.')} or later.`;
}

// The reason a file is refused. The name is shown as the person sees it.
const refuse = message => new Error(message);

function refusePages(name, count) {
  return refuse(`"${name}" has ${count} pages. Plenum reads at most ${MAX_PAGES} pages of a PDF as text.`);
}

function refuseSize(name, bytes) {
  return refuse(`"${name}" holds ${formatBytes(bytes)} of text. Plenum sends at most ${formatBytes(MAX_TEXT_BYTES)} of text from one file and never part of a file. Split the PDF, or send it to Claude by API key.`);
}

const NO_TEXT = name => `"${name}" has no text layer (it may be a scanned image), so Plenum cannot read it as text. Attach its pages as images to a model that takes images, or send the PDF to Claude by API key.`;
const SLOW = name => refuse(`"${name}" took too long to read.`);
const DAMAGED = name => refuse(`"${name}" could not be read as a PDF.`);

// The text of the pages, each under its number. Pages are separated by a blank line, so the model can see where a page starts.
function joinPages(pages) {
  return pages.map((text, i) => `[Page ${i + 1}]\n${text}`).join('\n\n');
}

// Reads one PDF in a worker. options.library (tests) is the module path to load instead of pdfjs-dist; options.timeoutMs (tests) is
// the limit instead of 20 seconds. Resolves { name, text, pages } or rejects with a plain Error.
function readOne({ name, data }, { library, timeoutMs, pkg }) {
  const bytes = Buffer.from(String(data ?? ''), 'base64');
  const libraryFile = library ?? path.join(pkg.dir, 'legacy', 'build', 'pdf.mjs');
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate().catch(() => {});
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(SLOW(name)), timeoutMs ?? MAX_SECONDS * 1000);
    try {
      worker = new Worker(`(${workerMain.toString()})();`, {
        eval: true,
        workerData: {
          bytes,
          library: pathToFileURL(libraryFile).href,
          cMapUrl: folderUrl(path.join(pkg.dir, 'cmaps')),
          standardFontDataUrl: folderUrl(path.join(pkg.dir, 'standard_fonts')),
          maxPages: MAX_PAGES,
        },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
      });
    } catch {
      finish(DAMAGED(name));
      return;
    }
    worker.on('message', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'pages') {
        if (msg.count > MAX_PAGES) finish(refusePages(name, msg.count));
        return;
      }
      if (msg.type === 'failed') {
        finish(DAMAGED(name));
        return;
      }
      if (msg.type === 'text' && Array.isArray(msg.pages)) {
        const text = joinPages(msg.pages);
        if (msg.pages.join('').replace(/\s/g, '').length < MIN_NON_SPACE) {
          finish(refuse(NO_TEXT(name)));
          return;
        }
        if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
          finish(refuseSize(name, Buffer.byteLength(text, 'utf8')));
          return;
        }
        finish(null, { name, text, pages: msg.pages.length });
      }
    });
    // A worker that dies (memory limit, a crash) without an answer is a PDF that could not be read.
    worker.on('error', () => finish(DAMAGED(name)));
    worker.on('exit', () => finish(DAMAGED(name)));
  });
}

// The text of each PDF, in order. The first refusal stops the list and throws its message. Documents are read one after another,
// so no two workers run at once. options.library and options.timeoutMs are for tests only.
export async function pdfTexts(documents, options = {}) {
  const pkg = options.pkg ?? pdfjsPackage();
  const unsupported = pdfTextSupport(options.nodeVersion ?? process.versions.node, pkg);
  const out = [];
  const list = Array.isArray(documents) ? documents : [];
  for (const doc of list) {
    if (unsupported) throw new Error(unsupported);
    out.push(await readOne(doc, { library: options.library, timeoutMs: options.timeoutMs, pkg }));
  }
  return out;
}
