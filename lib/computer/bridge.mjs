// The server's side of the computer-use backend. The backend (desktop/computer/index.cjs) lives in the desktop app; this module asks
// it over the shell channel (lib/shell.mjs, the same way lib/pick-folder.mjs asks for a folder): a request is { type:
// 'computer-<method>', id, ...arguments }, the reply is { type: 'computer-<method>-result', id, ...result }, every other message type
// is ignored by the channel, and a call that gets no answer in 20 seconds fails with status 504. The messages and their fields are
// written at the top of desktop/computer/index.cjs. Nothing a request carries is logged here: it can hold the text the model types.
//
//   bridge.available            true in the desktop app; false under plain node, unless PLENUM_COMPUTER_BACKEND=fake, in which case
//                               the fake backend (desktop/computer/fake.cjs) runs in this process and is bridge.fake (for tests)
//   probe()                     -> { supported, reason, platform, displays, permissions, wayland, tools, overlay }
//   windows({ all })            -> [{ id, title, exe, pid, displayId, bounds, own, minimized }]; with all: the stacking order, topmost
//                                  first, as [{ id, pid, exe, bounds }], or null where the platform cannot say
//   foreground()                -> { id, title, exe, pid, elevated, bounds, own } | null
//   capture({ scope, target, maxEdge })  -> { ok: true, png (Buffer), width, height, physical, scale } | { ok: false, reason, message }
//   zoom({ scope, target, maxEdge, frame, region })  -> { ok: true, png, width, height } | { ok: false, reason, message }: a fresh capture
//                               at the screen's own resolution, cropped to `region` (given in the pixels of `frame`, the screenshot the
//                               model last saw) and scaled down to maxEdge. The region is a share of the frame, so a window that moved a
//                               little still gives the same part of itself.
//   input(action)               -> { ok: true } | { ok: false, reason, message }
//   cursor() -> { x, y }   userInput() -> { mouse, keys }   focus(windowId) -> { ok }   isSecureField() -> true | false | null
//   release()   overlay({ show, displayId, rect, state, model, label })   requestAccess()
// A call that cannot reach the desktop throws an Error with a status (503 no desktop app, 504 no answer).
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { shellAvailable, shellRequest } from '../shell.mjs';

const require = createRequire(import.meta.url);

export const TIMEOUT_MS = 20_000;
// Typing up to 8000 characters in pieces takes longer than a look at the screen.
const INPUT_TIMEOUT_MS = 60_000;
const MAX_PIXELS = 40_000_000;

const NO_DESKTOP = 'Computer use needs the desktop app.';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The reply without the channel's own fields.
function body(reply) {
  if (!isObject(reply)) return {};
  const { type, id, ...rest } = reply;
  void type;
  void id;
  return rest;
}

// Bytes as a Buffer, whatever the channel handed over (a typed array, an ArrayBuffer, a Buffer's JSON form or base64 text).
function toBuffer(png) {
  if (Buffer.isBuffer(png)) return png;
  if (png instanceof ArrayBuffer) return Buffer.from(png);
  if (ArrayBuffer.isView(png)) return Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (isObject(png) && png.type === 'Buffer' && Array.isArray(png.data)) return Buffer.from(png.data);
  if (typeof png === 'string') return Buffer.from(png, 'base64');
  return null;
}

// ---------- PNG: read any ordinary 8-bit PNG, crop, scale, write ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// 8-bit greyscale, RGB, grey+alpha or RGBA PNGs without interlace, with every row filter. -> { width, height, rgba }.
export function decodePng(bytes) {
  const buf = toBuffer(bytes);
  if (!buf || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG.');
  let pos = 8;
  let width = 0;
  let height = 0;
  let type = -1;
  const parts = [];
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (data.length !== length) throw new Error('The PNG is cut short.');
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || !Object.hasOwn(CHANNELS, type) || data[12] !== 0) throw new Error('Only 8-bit PNGs without interlace are read here.');
    } else if (name === 'IDAT') {
      parts.push(data);
    } else if (name === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!(width > 0) || !(height > 0) || width * height > MAX_PIXELS || parts.length === 0) throw new Error('The PNG cannot be read.');
  const bpp = CHANNELS[type];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(parts));
  if (raw.length < (stride + 1) * height) throw new Error('The PNG pixel data is cut short.');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = y > 0 ? dst - stride : -1;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = up >= 0 ? px[up + i] : 0;
      const c = up >= 0 && i >= bpp ? px[up + i - bpp] : 0;
      let v = raw[src + i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error('The PNG has an unknown row filter.');
      }
      px[dst + i] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const s = i * bpp;
    if (type === 6) {
      rgba[o] = px[s]; rgba[o + 1] = px[s + 1]; rgba[o + 2] = px[s + 2]; rgba[o + 3] = px[s + 3];
    } else if (type === 2) {
      rgba[o] = px[s]; rgba[o + 1] = px[s + 1]; rgba[o + 2] = px[s + 2]; rgba[o + 3] = 255;
    } else if (type === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s]; rgba[o + 3] = 255;
    } else {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s]; rgba[o + 3] = px[s + 1];
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng({ width, height, rgba }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// The part of an image from x0,y0 (inclusive) to x1,y1 (exclusive), scaled down to the given size by averaging the pixels each new
// pixel covers, which keeps small text readable. A crop that is already small enough is not enlarged.
export function cropScale(image, x0, y0, x1, y1, outWidth, outHeight) {
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let oy = 0; oy < outHeight; oy++) {
    const sy0 = y0 + Math.floor((oy * ch) / outHeight);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((oy + 1) * ch) / outHeight));
    for (let ox = 0; ox < outWidth; ox++) {
      const sx0 = x0 + Math.floor((ox * cw) / outWidth);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((ox + 1) * cw) / outWidth));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * image.width + sx) * 4;
          r += image.rgba[i]; g += image.rgba[i + 1]; b += image.rgba[i + 2]; a += image.rgba[i + 3];
          n += 1;
        }
      }
      const o = (oy * outWidth + ox) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return { width: outWidth, height: outHeight, rgba: out };
}

// ---------- the bridge ----------

const kebab = text => text.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
let nextId = 0;

// Builds a bridge on one way of reaching the backend:
//  - request(type, payload) -> reply: the shell channel (shellRequest), or any function that answers the same messages;
//  - backend: an object with handle(message) (the fake backend in-process), called with the same messages;
//  - neither: a bridge that is not available.
// `fake` is exposed as bridge.fake for tests that need to change the world the fake backend shows.
export function createBridge({ request = null, backend = null, fake = null, timeoutMs = TIMEOUT_MS } = {}) {
  const available = Boolean(request || backend);

  async function call(method, payload = {}, { timeout = timeoutMs } = {}) {
    if (!available) throw Object.assign(new Error(NO_DESKTOP), { status: 503 });
    const type = `computer-${kebab(method)}`;
    if (backend) {
      const reply = await backend.handle({ ...payload, type, id: `b${++nextId}` });
      return body(reply);
    }
    try {
      return body(await request(type, payload, { timeoutMs: timeout }));
    } catch (err) {
      if (err?.status === 504) throw Object.assign(new Error('The desktop app did not answer.'), { status: 504 });
      throw err;
    }
  }

  const bridge = {
    available,
    fake,
    probe: () => call('probe'),
    async windows({ all = false } = {}) {
      const reply = await call('windows', { all: all === true });
      return Array.isArray(reply.windows) ? reply.windows : all ? null : [];
    },
    async foreground() {
      const reply = await call('foreground');
      return isObject(reply.foreground) ? reply.foreground : null;
    },
    async capture({ scope = 'display', target = null, maxEdge = 1280 } = {}) {
      const reply = await call('capture', { scope, target, maxEdge });
      if (reply.ok === false) return { ok: false, reason: reply.reason ?? 'failed', message: String(reply.message ?? 'The capture failed.') };
      const png = toBuffer(reply.png);
      if (!png || png.length === 0) return { ok: false, reason: 'failed', message: 'The capture came back empty.' };
      return { ok: true, png, width: reply.width, height: reply.height, physical: reply.physical, scale: reply.scale };
    },
    async zoom({ scope = 'display', target = null, maxEdge = 1280, frame, region } = {}) {
      const fail = message => ({ ok: false, reason: 'failed', message });
      if (!frame || !(frame.width > 0) || !(frame.height > 0) || !Array.isArray(region) || region.length !== 4) return fail('The zoom needs a screenshot and a region.');
      const physical = frame.physical ?? { width: frame.width, height: frame.height };
      const edge = Math.min(4000, Math.max(frame.width, frame.height, Math.round(Math.max(physical.width, physical.height))));
      const cap = await bridge.capture({ scope, target, maxEdge: edge });
      if (cap.ok === false) return cap;
      let image;
      try {
        image = decodePng(cap.png);
      } catch {
        return fail('The zoom could not be made.');
      }
      const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const x0 = clampTo(Math.floor((region[0] / frame.width) * image.width), 0, image.width - 1);
      const y0 = clampTo(Math.floor((region[1] / frame.height) * image.height), 0, image.height - 1);
      const x1 = clampTo(Math.ceil((region[2] / frame.width) * image.width), x0 + 1, image.width);
      const y1 = clampTo(Math.ceil((region[3] / frame.height) * image.height), y0 + 1, image.height);
      const cw = x1 - x0;
      const ch = y1 - y0;
      const long = Math.max(cw, ch);
      const k = long > maxEdge ? maxEdge / long : 1;
      const out = cropScale(image, x0, y0, x1, y1, Math.max(1, Math.round(cw * k)), Math.max(1, Math.round(ch * k)));
      return { ok: true, png: encodePng(out), width: out.width, height: out.height };
    },
    async input(action) {
      const reply = await call('input', { action }, { timeout: INPUT_TIMEOUT_MS });
      return reply.ok === true ? { ok: true } : { ok: false, reason: reply.reason ?? 'blocked', message: String(reply.message ?? 'The input could not be sent.') };
    },
    async cursor() {
      const reply = await call('cursor');
      return { x: Number.isFinite(reply.x) ? reply.x : 0, y: Number.isFinite(reply.y) ? reply.y : 0 };
    },
    async userInput() {
      const reply = await call('userInput');
      return { mouse: reply.mouse === true, keys: reply.keys === true };
    },
    async focus(windowId) {
      const reply = await call('focus', { windowId });
      return reply.ok === true ? { ok: true } : { ok: false, message: String(reply.message ?? 'The window could not be brought to the front.') };
    },
    async isSecureField() {
      const reply = await call('isSecureField');
      return reply.secure === true ? true : reply.secure === false ? false : null;
    },
    async release() {
      const reply = await call('release');
      return { ok: reply.ok !== false };
    },
    async overlay(options = {}) {
      return call('overlay', {
        show: options.show === true,
        displayId: options.displayId ?? null,
        rect: options.rect ?? null,
        state: options.state === 'paused' ? 'paused' : 'running',
        model: typeof options.model === 'string' ? options.model : '',
        label: typeof options.label === 'string' ? options.label : '',
      });
    },
    async requestAccess() {
      return call('requestAccess');
    },
  };
  return bridge;
}

// The bridge the server uses: the desktop app's when there is a channel, the in-process fake when PLENUM_COMPUTER_BACKEND=fake, and
// otherwise one that says computer use needs the desktop app.
function defaultBridge() {
  if (shellAvailable()) return createBridge({ request: (type, payload, options) => shellRequest(type, payload, options) });
  if (process.env.PLENUM_COMPUTER_BACKEND === 'fake') {
    const { createComputerBackend } = require('../../desktop/computer/index.cjs');
    const backend = createComputerBackend({ fake: true });
    return createBridge({ backend, fake: backend });
  }
  return createBridge({});
}

export const bridge = defaultBridge();
