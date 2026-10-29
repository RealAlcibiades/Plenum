'use strict';
// A small PNG encoder and decoder, and a tiny RGBA canvas, for the fake computer backend (fake.cjs), the smoke test (smoke.cjs) and
// their tests. Pure Node: no Electron, no native code. The real backend gets its PNG bytes from Electron's nativeImage.
//  - encodePng({ width, height, rgba }) -> Buffer: 8-bit RGBA (colour type 6), filter 0 on every row, one IDAT chunk made with
//    zlib.deflateSync, and a CRC32 on every chunk.
//  - decodePng(buffer) -> { width, height, rgba }: reads any ordinary 8-bit PNG without interlace (greyscale, RGB, grey+alpha or
//    RGBA, every row filter, one or more IDAT chunks), which covers what nativeImage.toPNG() writes, and checks every CRC.
//    Palette, other bit depths and interlace are refused with an Error.
//  - createCanvas(width, height, fill) and fillRect / drawText / resizeCanvas / cropCanvas: just enough drawing for a fake screen.
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 16384;
// Bytes per pixel for each 8-bit colour type: greyscale, RGB, grey+alpha, RGBA.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// The CRC32 of the bytes (the PNG kind: the one zlib and gzip use).
function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// One chunk: length, type, data, and the CRC of the type and the data.
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function checkSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new RangeError(`A PNG needs a width and height between 1 and ${MAX_SIDE}.`);
  }
}

function encodePng({ width, height, rgba }) {
  checkSize(width, height);
  if (!rgba || rgba.length !== width * height * 4) throw new RangeError('The pixel data does not match the size.');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

function decodePng(bytes) {
  const buf = Buffer.from(bytes.buffer ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG.');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colour = -1;
  let ended = false;
  const parts = [];
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (data.length !== length || pos + 12 + length > buf.length) throw new Error('The PNG is cut short.');
    if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== buf.readUInt32BE(pos + 8 + length)) throw new Error(`The ${type} chunk fails its CRC.`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colour = data[9];
      if (data[8] !== 8 || !Object.hasOwn(CHANNELS, colour) || data[12] !== 0) throw new Error('Only 8-bit PNGs without palette or interlace are read here.');
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    pos += 12 + length;
  }
  if (!ended || parts.length === 0) throw new Error('The PNG is cut short.');
  checkSize(width, height);
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const bpp = CHANNELS[colour];
  const stride = width * bpp;
  if (raw.length !== (stride + 1) * height) throw new Error('The PNG pixel data has the wrong length.');
  const px = unfilter(raw, stride, height, bpp);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const s = i * bpp;
    if (colour === 6) {
      rgba[o] = px[s]; rgba[o + 1] = px[s + 1]; rgba[o + 2] = px[s + 2]; rgba[o + 3] = px[s + 3];
    } else if (colour === 2) {
      rgba[o] = px[s]; rgba[o + 1] = px[s + 1]; rgba[o + 2] = px[s + 2]; rgba[o + 3] = 255;
    } else if (colour === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s]; rgba[o + 3] = px[s + 1];
    } else {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s]; rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

// Undoes the row filters (0 none, 1 sub, 2 up, 3 average, 4 Paeth) and returns the bare pixel bytes, stride bytes per row.
function unfilter(raw, stride, height, bpp) {
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
  return px;
}

// ---------- canvas ----------

function createCanvas(width, height, fill = [0, 0, 0, 255]) {
  checkSize(width, height);
  const rgba = new Uint8Array(width * height * 4);
  const canvas = { width, height, rgba };
  fillRect(canvas, 0, 0, width, height, fill);
  return canvas;
}

// Fills a rectangle (clipped to the canvas) with an [r, g, b, a] colour.
function fillRect(canvas, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(canvas.width, Math.round(x + w));
  const y1 = Math.min(canvas.height, Math.round(y + h));
  for (let row = y0; row < y1; row++) {
    for (let col = x0; col < x1; col++) {
      const i = (row * canvas.width + col) * 4;
      canvas.rgba[i] = color[0];
      canvas.rgba[i + 1] = color[1];
      canvas.rgba[i + 2] = color[2];
      canvas.rgba[i + 3] = color[3] ?? 255;
    }
  }
}

// A 5x7 bitmap font: digits, upper-case letters and a few marks. Lower case draws as upper case; any other character draws as a box.
const GLYPHS = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  _: ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};
const BOX = ['11111', '10001', '10001', '10001', '10001', '10001', '11111'];

// The width in pixels drawText gives a string at a scale.
function textWidth(text, scale = 1) {
  return Math.max(0, String(text).length * 6 * scale - scale);
}

function drawText(canvas, x, y, text, color, scale = 1) {
  let cx = Math.round(x);
  for (const ch of String(text)) {
    const glyph = GLYPHS[ch.toUpperCase()] ?? BOX;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === '1') fillRect(canvas, cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
}

// A copy of a rectangle of the canvas (clipped to it).
function cropCanvas(canvas, x, y, w, h) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(canvas.width, Math.round(x + w));
  const y1 = Math.min(canvas.height, Math.round(y + h));
  const out = createCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0), [0, 0, 0, 255]);
  for (let row = y0; row < y1; row++) {
    out.rgba.set(canvas.rgba.subarray((row * canvas.width + x0) * 4, (row * canvas.width + x1) * 4), (row - y0) * out.width * 4);
  }
  return out;
}

// A copy at another size, by nearest neighbour (flat colours stay flat, which is what the tests look at).
function resizeCanvas(canvas, width, height) {
  if (width === canvas.width && height === canvas.height) return canvas;
  const out = createCanvas(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(canvas.height - 1, Math.floor(((y + 0.5) * canvas.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(canvas.width - 1, Math.floor(((x + 0.5) * canvas.width) / width));
      const from = (sy * canvas.width + sx) * 4;
      out.rgba.set(canvas.rgba.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return out;
}

function pixelAt(canvas, x, y) {
  const i = (y * canvas.width + x) * 4;
  return [canvas.rgba[i], canvas.rgba[i + 1], canvas.rgba[i + 2], canvas.rgba[i + 3]];
}

module.exports = { encodePng, decodePng, crc32, createCanvas, fillRect, drawText, textWidth, cropCanvas, resizeCanvas, pixelAt, SIGNATURE };
