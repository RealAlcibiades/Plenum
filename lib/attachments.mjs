import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkAccess } from './guard.mjs';
import { BASE64, formatBytes, plainName, sniffImage, validateImage, within } from './images.mjs';

// Files that go with a chat message, besides pictures: text and code (sent inline for every model) and PDF (a document
// block for Claude through an API key; for every other model, the text Plenum reads out of it, see lib/pdf-text.mjs). The page sends each file as { name, data } with data in base64. The kind of
// a file is told by its bytes, never by its name or by the type a page claims, so a program named notes.txt is refused and a
// PNG named notes.txt is still a picture. A picture goes to lib/images.mjs unchanged. Whatever is not a picture, a PDF or
// text is refused with a plain message. Like pictures, these bytes live only for the one request: the transcript keeps a
// name and a size (describeUploads), and the model sees the file only in the message it came with.

export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;
export const MAX_TEXT_TOTAL = 600 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export const CANNOT_ATTACH = 'This file type cannot be attached yet. Plenum attaches text, code, images (PNG, JPEG, GIF, WebP) and PDF (for Claude by API key).';
export const PDF_REFUSAL = 'Plenum sends a PDF only to Claude through an API key. Claude through the CLI, Codex, Gemini, Muse Code and the OpenAI-compatible models cannot take one yet. Paste the text you need, or ask Claude by API key (Accounts).';
// Anthropic's limit, not Plenum's: pages are not counted here, and a PDF that is over it is refused by Anthropic and said so.
export const PDF_PAGE_LIMIT = 100;
export const PDF_NAME = /\.pdf$/i;

const TOO_MANY = `At most ${MAX_FILES} files can go with one message.`;
const SAVE_AS_UTF8 = 'Save it as UTF-8 and attach it again.';

const ascii = text => [...text].map(c => c.charCodeAt(0));
const startsWith = (bytes, signature, at = 0) => bytes.length >= at + signature.length && signature.every((v, i) => bytes[at + i] === v);
const PDF_HEAD = ascii('%PDF-');

// Every model can take a PDF now: Claude through an API key as a document block (nativePdf), and every other model as the text Plenum
// reads out of it (lib/pdf-text.mjs, applied in lib/providers.mjs streamChat). route is claudeRoute() for Claude and ignored otherwise.
export const takesDocuments = () => true;

// True only for Claude through an API key, the one route whose request carries the PDF itself (a document block).
export const nativePdf = (provider, route) => provider === 'anthropic' && route === 'api';

// The refusal for a PDF sent to a model that cannot take one, with the file named when it is known.
export const pdfRefusal = name => (name ? `"${name}" is a PDF. ${PDF_REFUSAL}` : PDF_REFUSAL);

// Bytes in a base64 string, worked out without decoding it.
function base64Bytes(data) {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

// "201 KB", or the exact number of bytes when the rounded size would read the same as the limit it is over.
const sizeText = (n, limit) => (formatBytes(n) === formatBytes(limit) ? `${n.toLocaleString('en-US')} bytes` : formatBytes(n));

const dataOf = item => (item && typeof item === 'object' && typeof item.data === 'string' ? item.data : '');

// ---------- what a file that is not text looks like ----------

// A short phrase for a file that is not a picture, a PDF or text, from its first bytes, or null when it is not one of these.
function looksLike(bytes) {
  const is = (signature, at = 0) => startsWith(bytes, signature, at);
  if (is([0x50, 0x4b, 0x03, 0x04]) || is([0x50, 0x4b, 0x05, 0x06])) {
    if (bytes.includes('word/document.xml')) return 'a Word document';
    if (bytes.includes('xl/workbook.xml')) return 'an Excel workbook';
    if (bytes.includes('ppt/presentation.xml')) return 'a PowerPoint presentation';
    if (bytes.includes('application/vnd.oasis.opendocument')) return 'an OpenDocument file';
    return 'a ZIP archive';
  }
  if (is([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'an older Office document (Word, Excel or PowerPoint)';
  if (is([0x1f, 0x8b])) return 'a gzip archive';
  if (is([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'a 7-Zip archive';
  if (is(ascii('Rar!'))) return 'a RAR archive';
  if (is(ascii('BZh'))) return 'a bzip2 archive';
  if (is([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'an xz archive';
  if (is(ascii('ustar'), 257)) return 'a tar archive';
  if (is(ascii('MZ'))) return 'a Windows program (.exe or .dll)';
  if (is([0x7f, 0x45, 0x4c, 0x46])) return 'a program (ELF)';
  if (is([0xcf, 0xfa, 0xed, 0xfe]) || is([0xce, 0xfa, 0xed, 0xfe])) return 'a program (Mach-O)';
  if (is([0xca, 0xfe, 0xba, 0xbe])) return 'a compiled Java class or program';
  if (is([0x00, 0x61, 0x73, 0x6d])) return 'a WebAssembly module';
  if (is(ascii('SQLite format 3'))) return 'a SQLite database';
  if (is(ascii('BM'))) return 'a BMP picture';
  if (is([0x49, 0x49, 0x2a, 0x00]) || is([0x4d, 0x4d, 0x00, 0x2a])) return 'a TIFF picture';
  if (is([0x00, 0x00, 0x01, 0x00])) return 'an icon file';
  if (is(ascii('8BPS'))) return 'a Photoshop file';
  if (is(ascii('ftyp'), 4)) return 'a video, audio or HEIC picture file (MP4 family)';
  if (is(ascii('RIFF')) && is(ascii('WAVE'), 8)) return 'a WAV audio file';
  if (is(ascii('RIFF')) && is(ascii('AVI '), 8)) return 'an AVI video';
  if (is(ascii('ID3')) || is([0xff, 0xfb])) return 'an MP3 audio file';
  if (is(ascii('OggS'))) return 'an Ogg audio or video file';
  if (is(ascii('fLaC'))) return 'a FLAC audio file';
  if (is([0x1a, 0x45, 0xdf, 0xa3])) return 'a Matroska or WebM video';
  if (is(ascii('wOFF')) || is(ascii('wOF2'))) return 'a web font';
  return null;
}

// A UTF-16 byte order mark: how Notepad saves "Unicode" text.
const hasUtf16Mark = bytes => startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);

// UTF-16 text without a mark: a zero in every other byte of what is mostly ASCII.
function looksUtf16(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 8192) & ~1);
  // A few bytes are too little to call UTF-16.
  if (head.length < 16) return false;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < head.length; i += 2) {
    if (head[i] === 0) even++;
    if (head[i + 1] === 0) odd++;
  }
  const pairs = head.length / 2;
  return (odd > pairs * 0.3 && even < pairs * 0.05) || (even > pairs * 0.3 && odd < pairs * 0.05);
}

const refuseKind = (name, kind) => new Error(`"${name}" looks like ${kind}. ${CANNOT_ATTACH}`);

// The text of a file, or throws an Error with a plain message: a NUL byte in the first 8 KB, bytes that are not strict UTF-8,
// UTF-16, or more than 200 KB are all refused. Nothing is cut short, so the model never reads half a file as if it were whole.
function readText(bytes, name) {
  const utf16 = () => new Error(`"${name}" is UTF-16 text, which Plenum cannot read. ${SAVE_AS_UTF8}`);
  if (hasUtf16Mark(bytes)) throw utf16();
  if (bytes.subarray(0, 8192).includes(0)) {
    const kind = looksLike(bytes);
    if (kind) throw refuseKind(name, kind);
    throw looksUtf16(bytes) ? utf16() : refuseKind(name, 'a binary file');
  }
  let text;
  try {
    // A UTF-8 byte order mark is dropped by the decoder.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // A few signatures are plain letters ("MZ", "BM"), so one is only believed when the file also starts with a byte no text has.
    const kind = bytes.subarray(0, 8).some(b => b >= 0x80 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) ? looksLike(bytes) : null;
    if (kind) throw refuseKind(name, kind);
    throw new Error(`"${name}" is not valid UTF-8 text (it may be saved in another encoding, such as Windows-1252). ${SAVE_AS_UTF8}`);
  }
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new Error(`"${name}" is ${sizeText(bytes.length, MAX_TEXT_BYTES)}. A text file can be at most ${formatBytes(MAX_TEXT_BYTES)}, and Plenum never sends part of a file.`);
  }
  return text;
}

// ---------- the block a text file travels in ----------

// The name as the model sees it: no quotes and no control characters, so it cannot end the attribute it sits in, and no angle
// brackets, so it cannot carry a marker of its own.
const blockName = name => String(name).replace(/[<>"\u0000-\u001f\u007f]/g, '');

// <<FILE name="..." type="text" bytes="N">>, the content, <<END FILE>>. A "<<END FILE" inside the content gets a space after
// "<<", so a file cannot close its own block and go on talking as if it were the message. type is 'text' for a text file, and
// 'pdf-text' for the text Plenum read out of a PDF for a model that takes no PDF (lib/providers.mjs). Only those two are written.
export const FILE_TYPES = ['text', 'pdf-text'];
export function fileBlock(name, text, bytes, type = 'text') {
  const kind = FILE_TYPES.includes(type) ? type : 'text';
  const safe = text.replace(/<<(?=\s*END\s+FILE)/gi, '<< ');
  return `<<FILE name="${blockName(name)}" type="${kind}" bytes="${bytes}">>\n${safe}${safe.endsWith('\n') ? '' : '\n'}<<END FILE>>`;
}

// The message with its text files after it. The message itself comes first, unchanged.
export function withInline(message, inline) {
  return inline?.length ? `${message}\n\n${inline.map(file => file.block).join('\n\n')}` : message;
}

// The document blocks of a Claude user message, for a PDF (Claude through an API key only).
export const documentBlocks = documents => documents.map(doc => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.data } }));

// ---------- sorting what the page sent ----------

// Takes the files of one chat message, [{ name, data }] with data in base64, and returns
// { images, inline, documents, refused }:
//   images     each { name, mime, data }, checked by lib/images.mjs (validateImage), which has its own size rule
//   inline     each { name, size, block } for a text file, block being what goes into the prompt
//   documents  each { name, mime, size, data } for a PDF
//   refused    a plain message for each file that cannot be attached, and for a message that is over a limit
// counted (optional) is the list of pictures that came in the images field of the same message. They are counted toward the
// 10 files and 25 MB of the message, and are not read here. The count and the total are checked before anything is decoded.
// Throws only when the list is not a list.
export function sortAttachments(files, { counted = [] } = {}) {
  const out = { images: [], inline: [], documents: [], refused: [] };
  const list = files ?? [];
  if (!Array.isArray(list)) throw new Error('The attachments must be a list.');
  const already = Array.isArray(counted) ? counted : [];
  if (list.length + already.length > MAX_FILES) {
    out.refused.push(TOO_MANY);
    return out;
  }
  const estimate = [...list, ...already].reduce((sum, item) => sum + base64Bytes(dataOf(item)), 0);
  if (estimate > MAX_TOTAL_BYTES) {
    out.refused.push(`These files are ${sizeText(estimate, MAX_TOTAL_BYTES)} together. At most ${formatBytes(MAX_TOTAL_BYTES)} can go with one message.`);
    return out;
  }
  let textBytes = 0;
  for (const item of list) {
    const raw = item && typeof item === 'object' ? item : {};
    const name = plainName(raw.name, 'file');
    try {
      const data = dataOf(raw);
      if (!data) throw new Error(`"${name}" is empty.`);
      if (!BASE64.test(data)) throw new Error(`"${name}" could not be read: it was not sent as a file.`);
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length) throw new Error(`"${name}" is empty.`);
      if (sniffImage(bytes)) {
        out.images.push(validateImage({ name: raw.name, data }));
      } else if (startsWith(bytes, PDF_HEAD)) {
        if (bytes.length > MAX_PDF_BYTES) throw new Error(`"${name}" is ${sizeText(bytes.length, MAX_PDF_BYTES)}. A PDF can be at most ${formatBytes(MAX_PDF_BYTES)}.`);
        out.documents.push({ name, mime: 'application/pdf', size: bytes.length, data: bytes.toString('base64') });
      } else {
        const text = readText(bytes, name);
        textBytes += bytes.length;
        out.inline.push({ name, size: bytes.length, block: fileBlock(name, text, bytes.length) });
      }
    } catch (err) {
      out.refused.push(err.message);
    }
  }
  if (textBytes > MAX_TEXT_TOTAL) {
    out.refused.push(`The text files together are ${sizeText(textBytes, MAX_TEXT_TOTAL)}. At most ${formatBytes(MAX_TEXT_TOTAL)} of text can go with one message, and Plenum never sends part of a file.`);
    out.inline = [];
  }
  return out;
}

// What the page sent in the body of a chat message: the images field (pictures, as before) and the attachments field.
// An entry of the images field whose type does not say it is a picture is a file, and is sorted by its bytes like the
// others. The type is only a way of telling which field's rules to use: a picture is judged by its bytes in both.
// Returns { images, files }. images is returned as sent when it is not a list, so checkImages can say so.
export function splitUploads(body) {
  const extra = body?.attachments;
  if (extra !== undefined && extra !== null && !Array.isArray(extra)) throw new Error('The attachments must be a list.');
  const listed = body?.images;
  if (!Array.isArray(listed)) return { images: listed, files: extra ?? [] };
  const claimsImage = item => !item || typeof item !== 'object' || item.mime === undefined || /^image\//i.test(String(item.mime));
  return { images: listed.filter(claimsImage), files: [...listed.filter(item => !claimsImage(item)), ...(extra ?? [])] };
}

// The count and size of everything that goes with one message, including pictures and PDFs named with @path. Returns a plain
// message when it is over a limit, or null.
export function checkMessageTotals({ images = [], inline = [], documents = [] }) {
  const count = images.length + inline.length + documents.length;
  if (count > MAX_FILES) return TOO_MANY;
  const bytes = images.reduce((sum, image) => sum + base64Bytes(String(image.data ?? '')), 0)
    + inline.reduce((sum, file) => sum + file.size, 0) + documents.reduce((sum, doc) => sum + doc.size, 0);
  if (bytes > MAX_TOTAL_BYTES) return `These files are ${sizeText(bytes, MAX_TOTAL_BYTES)} together. At most ${formatBytes(MAX_TOTAL_BYTES)} can go with one message.`;
  return null;
}

// ---------- the transcript ----------

// What the transcript keeps of the files that came with a message: a name and a size, never the bytes. Pictures keep exactly
// { name, size }; a text file or a PDF adds its kind ('text' or 'pdf') so a later turn can say what came with the message.
// They all sit in one list because the page shows that list as chips under the message.
export function describeUploads(images, { inline = [], documents = [] } = {}) {
  return [
    ...images.map(image => ({ name: image.name, size: base64Bytes(String(image.data ?? '')) })),
    ...inline.map(file => ({ name: file.name, size: file.size, kind: 'text' })),
    ...documents.map(doc => ({ name: doc.name, size: doc.size, kind: 'pdf' })),
  ];
}

// A line for a later turn's history, so the model knows a file came with an earlier message and is not shown again.
export function attachmentNote(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const names = list.map(f => `${f.name} (${formatBytes(Number(f.size) || 0)})`).join(', ');
  return `[${list.length === 1 ? 'A file was' : 'Files were'} attached to this message: ${names}. ${list.length === 1 ? 'It is' : 'They are'} not shown again.]`;
}

// Anthropic's own words when it refuses a request that carried a PDF (more than 100 pages, or a request over its size limit).
export function pdfFailure(err) {
  const detail = String(err?.error?.error?.message ?? err?.message ?? '').trim();
  return new Error(`Claude could not take the PDF. Anthropic refuses a PDF over ${PDF_PAGE_LIMIT} pages, and Plenum does not count pages. Anthropic said: ${detail}`);
}

// ---------- a PDF named with @path ----------

// The first bytes of a file say whether it is a PDF. A file that cannot be read is not one.
export async function pdfTypeOf(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(PDF_HEAD.length), 0, PDF_HEAD.length, 0);
    return startsWith(buffer.subarray(0, bytesRead), PDF_HEAD);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// A PDF named with @path. It must be inside the project once links are followed, must not be in a credential folder, and
// must be a real PDF of at most 20 MB. Returns { name, mime, size, data }, or throws an Error with a plain message.
export async function loadDocumentFile(file, root) {
  const name = plainName(path.basename(String(file)), 'file.pdf');
  const refuse = why => new Error(`"${name}" was not attached: ${why}`);
  try {
    checkAccess(path.resolve(file));
  } catch (err) {
    throw refuse(err.message);
  }
  const real = await fs.realpath(file).catch(() => null);
  if (!real) throw refuse('it could not be found.');
  try {
    checkAccess(real);
  } catch (err) {
    throw refuse(err.message);
  }
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  if (!within(realRoot, real)) throw refuse('it is outside the project folder.');
  const st = await fs.stat(real).catch(() => null);
  if (!st?.isFile()) throw refuse('it is not a file.');
  if (st.size > MAX_PDF_BYTES) throw new Error(`"${name}" is ${sizeText(st.size, MAX_PDF_BYTES)}. A PDF can be at most ${formatBytes(MAX_PDF_BYTES)}.`);
  const bytes = await fs.readFile(real).catch(() => null);
  if (!bytes) throw refuse('it could not be read.');
  if (!startsWith(bytes, PDF_HEAD)) throw new Error(`"${name}" is not a PDF. Plenum goes by the file itself, not its name.`);
  return { name, mime: 'application/pdf', size: bytes.length, data: bytes.toString('base64') };
}
