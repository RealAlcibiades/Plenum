import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAccess } from './guard.mjs';
import { providerTakesImages } from './capabilities.mjs';

// Images that go with a chat message: PNG, JPEG, GIF and WebP, at most 5 MB each and 4 to a message. The kind of a
// file is told by its first bytes, never by its name or by the type a page claims, so a text file named .png is refused.
// An image arrives three ways: dropped or pasted into the composer (the page sends { name, mime, data } in the chat
// body), or named with @path in the message (lib/files.mjs calls loadImageFile). All of them end up as { name, mime,
// data } with data in base64, and they live only for the one request: the transcript keeps a name and a size.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_REFUSAL = 'This model cannot take images in Plenum. The attach chip shows which models can.';

// True when some model of the provider takes images (lib/capabilities.mjs has the table). A model of that provider that cannot
// is refused in lib/providers.mjs with its own reason, before any request is made. Muse Code, DeepSeek, Cursor and the echo model
// have no model that takes images, so they are refused here before anything is decoded.
export const takesImages = provider => providerTakesImages(provider);

// File names that look like an image. This never decides what a file is; it only lets a mention such as @../shot.png
// outside the project be refused out loud instead of skipped.
export const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

const EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_NAME = 80;
const TOO_MANY = `At most ${MAX_IMAGES} images can go with one message.`;
// A base64 string for a file of the largest size, with room for padding. Longer text is refused before it is decoded.
const MAX_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
export const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const ascii = text => [...text].map(c => c.charCodeAt(0));
const startsWith = (bytes, signature, at = 0) => bytes.length >= at + signature.length && signature.every((v, i) => bytes[at + i] === v);

// 'image/png', 'image/jpeg', 'image/gif', 'image/webp', or null when the bytes are not one of those.
export function sniffImage(bytes) {
  if (!bytes) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

// The file name as the person sees it: no folders, no control characters, and not longer than a chip can hold. Other files
// (lib/attachments.mjs) are named the same way, each with a plain name of its own when none is given.
export function plainName(name, fallback) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const text = base || fallback;
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text;
}

const cleanName = (name, mime) => plainName(name, `image.${EXTENSION[mime] ?? 'png'}`);

export function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const notImage = name => new Error(`"${name}" is not a PNG, JPEG, GIF or WebP image. Plenum goes by the file itself, not its name.`);
const tooBig = (name, bytes) => new Error(`"${name}" is ${formatBytes(bytes)}. Images can be at most ${formatBytes(MAX_IMAGE_BYTES)}.`);

// Checks one image the page sent (dropped or pasted). Returns { name, mime, data } with the type taken from the bytes and
// the data in canonical base64, or throws an Error with a plain message. The type the page claims is ignored.
export function validateImage(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const name = cleanName(raw.name);
  const data = typeof raw.data === 'string' ? raw.data : '';
  if (!data) throw new Error(`"${name}" is empty.`);
  if (data.length > MAX_BASE64) throw tooBig(name, Math.floor(data.length * 3 / 4));
  if (!BASE64.test(data)) throw notImage(name);
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new Error(`"${name}" is empty.`);
  if (bytes.length > MAX_IMAGE_BYTES) throw tooBig(name, bytes.length);
  const mime = sniffImage(bytes);
  if (!mime) throw notImage(name);
  return { name: cleanName(raw.name, mime), mime, data: bytes.toString('base64') };
}

// The same test as insideRoot in lib/files.mjs, on real paths. It is repeated here because files.mjs imports this file.
// lib/attachments.mjs uses it too, for a PDF named with @path.
export function within(realRoot, real) {
  const rel = path.relative(realRoot, real);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

// The first bytes of a file say whether it is an image: its type, or null. A file that cannot be read is not one.
export async function imageTypeOf(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    return sniffImage(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// An image named with @path. It must be inside the project once links are followed, must not be in a credential
// folder, and must be a real image of at most 5 MB. Returns { name, mime, data }, or throws an Error with a plain message.
export async function loadImageFile(file, root) {
  const name = cleanName(path.basename(String(file)));
  const refuse = why => new Error(`"${name}" was not attached: ${why}`);
  // The credential check runs on the path as written and again on where it really leads, so a link cannot hide it.
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
  if (st.size > MAX_IMAGE_BYTES) throw tooBig(name, st.size);
  const bytes = await fs.readFile(real).catch(() => null);
  if (!bytes) throw refuse('it could not be read.');
  const mime = sniffImage(bytes);
  if (!mime) throw notImage(name);
  return { name, mime, data: bytes.toString('base64') };
}

// The images for one chat message: those the page sent, each checked, and those @path mentions already loaded. The count
// is checked before anything is decoded, so a fifth image is refused without being read.
export function checkImages({ sent = [], named = [] } = {}) {
  const list = sent ?? [];
  if (!Array.isArray(list)) throw new Error('The images must be a list.');
  if (list.length + named.length > MAX_IMAGES) throw new Error(TOO_MANY);
  return [...list.map(validateImage), ...named];
}

export const imageLimitMessage = () => TOO_MANY;

// Bytes in a canonical base64 string, worked out without decoding it.
export function imageSize(image) {
  const data = String(image?.data ?? '');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length / 4) * 3 - padding);
}

// What the transcript keeps of an image: its name and size, never the bytes.
export const describeImages = images => images.map(image => ({ name: image.name, size: imageSize(image) }));

// A line for a later turn's history, so the model knows a picture came with an earlier message and is not shown again.
export function imageNote(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const names = list.map(i => `${i.name} (${formatBytes(Number(i.size) || 0)})`).join(', ');
  return `[${list.length === 1 ? 'An image was' : 'Images were'} attached to this message: ${names}. ${list.length === 1 ? 'It is' : 'They are'} not shown again.]`;
}

// The image blocks of a Claude user message (the API and the CLI's stream-json input take the same shape).
export const imageBlocks = images => images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }));

// Writes the images to a folder of their own under the system temp folder, for a CLI that takes image files (Codex -i).
// Never inside the project. Returns { files, cleanup }; cleanup removes the folder and is safe to call twice.
export async function stageImages(images) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plenum-images-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const files = [];
    for (const [i, image] of images.entries()) {
      // The file is named by its type, not by the name the person gave it, so that name never reaches a command line.
      const file = path.join(dir, `image-${i + 1}.${EXTENSION[image.mime] ?? 'png'}`);
      await fs.writeFile(file, Buffer.from(image.data, 'base64'), { mode: 0o600 });
      files.push(file);
    }
    return { dir, files, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
