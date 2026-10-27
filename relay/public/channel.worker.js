var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// mobile/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE2) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE2 ? l : h, isLE2);
  view.setUint32(byteOffset + 4, isLE2 ? h : l, isLE2);
}

// mobile/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
  if (h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex2 = "";
  for (let i = 0; i < bytes.length; i++) {
    hex2 += hexes[bytes[i]];
  }
  return hex2;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : void 0;
}
function hexToBytes(hex2) {
  if (typeof hex2 !== "string")
    throw new TypeError("hex string expected, got " + typeof hex2);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex2);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex2.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex2.charCodeAt(hi));
    const n2 = asciiToBase16(hex2.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex2[hi] + hex2[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// mobile/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  constructor(blockLen, outputLen, padOffset, isLE2) {
    __publicField(this, "blockLen");
    __publicField(this, "outputLen");
    __publicField(this, "canXOF", false);
    __publicField(this, "padOffset");
    __publicField(this, "isLE");
    // For partial updates less than block size
    __publicField(this, "buffer");
    __publicField(this, "view");
    __publicField(this, "finished", false);
    __publicField(this, "length", 0);
    __publicField(this, "pos", 0);
    __publicField(this, "destroyed", false);
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE2;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE: isLE2 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE2);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// mobile/node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    // Numeric initializers matter: starting the fields as `undefined` changes
    // V8's field representation and makes sha256 3x slower (measured).
    __publicField(this, "A", 0);
    __publicField(this, "B", 0);
    __publicField(this, "C", 0);
    __publicField(this, "D", 0);
    __publicField(this, "E", 0);
    __publicField(this, "F", 0);
    __publicField(this, "G", 0);
    __publicField(this, "H", 0);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// mobile/node_modules/@noble/curves/utils.js
function aarray(item, title, inner = () => {
}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0; i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
var abytes2 = (value, length, title) => abytes(value, length, title);
var anumber2 = anumber;
function aobject2(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value !== "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex2 = bytesToHex;
var hexToBytes2 = (hex2) => hexToBytes(hex2);
var isBytes2 = isBytes;
var randomBytes2 = (bytesLength) => randomBytes(bytesLength);
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function hexToNumber(hex2) {
  if (typeof hex2 !== "string")
    throw new TypeError("hex string expected, got " + typeof hex2);
  return hex2 === "" ? _0n : BigInt("0x" + hex2);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  const expectedLen = len * 2;
  const hex2 = n.toString(16);
  if (hex2.length > expectedLen)
    throw new RangeError("number is too large");
  return hexToBytes(hex2.padStart(expectedLen, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}
function isPosBig(n) {
  return typeof n === "bigint" && _0n <= n;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n)
    throw new Error("expected non-negative bigint, got " + n);
  return n === _0n ? 0 : n.toString(2).length;
}
var bitMask = (n) => {
  asafenumber(n, "n");
  return (_1n << BigInt(n)) - _1n;
};
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title);
  aobject2(fields, "fields");
  aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    const label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== void 0 : expectedType !== "function")) {
      throw new TypeError(`${label} is invalid: expected own property`);
    }
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}

// mobile/node_modules/@noble/curves/abstract/modular.js
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _15n = /* @__PURE__ */ BigInt(15);
var _16n = /* @__PURE__ */ BigInt(16);
var POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power !== "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return _1n2;
  if (power === _1n2)
    return num;
  let d = num % modulo;
  if (d < _0n2)
    d += modulo;
  if (power < POW_WINDOWED_MIN) {
    let p2 = _1n2;
    while (power > _0n2) {
      if (power & _1n2)
        p2 = p2 * d % modulo;
      d = d * d % modulo;
      power >>= _1n2;
    }
    return p2;
  }
  const digits = [];
  while (power > _0n2) {
    digits.push(Number(power & _15n));
    power >>= _4n;
  }
  const table = new Array(16);
  table[0] = _1n2;
  table[1] = d;
  for (let i = 2; i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2; w >= 0; w--) {
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    const digit = digits[w];
    if (digit !== 0)
      p = p * table[digit] % modulo;
  }
  return p;
}
function pow2(x, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow2: expected modulus > 1, got " + modulo);
  if (power < _0n2)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n2)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, u = _1n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  const F = Fp;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n2) === _0n2)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp, n) {
  const F = Fp;
  const p1div4 = (F.ORDER + _1n2) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const F = Fp;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return ((Fp, n) => {
    const F = Fp;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  });
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P, "tonelliShanks");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    const F = Fp;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = F.pow(c, exponent);
      M = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  aoddModulus(P, "Fp.sqrt");
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  aobject2(field, "field");
  if (typeof field.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  validateField(Fp);
  aarray(nums, "nums");
  abool(passZero, "passZero");
  const F = Fp;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  validateField(Fp);
  const F = Fp;
  aoddModulus(F.ORDER, "FpLegendre");
  const p1mod2 = (F.ORDER - _1n2) / _2n;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber2(nBitLength);
  if (n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== void 0 && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== void 0 && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = /* @__PURE__ */ new WeakMap();
var _Field = class {
  constructor(ORDER, opts = {}) {
    __publicField(this, "ORDER");
    __publicField(this, "BITS");
    __publicField(this, "BYTES");
    __publicField(this, "isLE");
    __publicField(this, "ZERO", _0n2);
    __publicField(this, "ONE", _1n2);
    __publicField(this, "_lengths");
    __publicField(this, "_mod");
    if (ORDER <= _1n2)
      throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
    let _nbitLength = void 0;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = Object.freeze(opts.allowedLengths.slice());
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new TypeError("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  // is valid and invertible
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return pow(num, power, this.ORDER);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  // Same as above, but doesn't normalize
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    let sqrt = FIELD_SQRT.get(this);
    if (!sqrt)
      FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
    return sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes2(bytes);
    const { _lengths: allowedLengths, BYTES, isLE: isLE2, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE2 ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(lst) {
    return FpInvertBatch(this, lst, true);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(a, b, condition) {
    abool(condition, "condition");
    return condition ? b : a;
  }
};
function Field(ORDER, opts = {}) {
  Object.freeze(_Field.prototype);
  return new _Field(ORDER, opts);
}

// mobile/node_modules/@noble/curves/abstract/curve.js
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
var _4n2 = /* @__PURE__ */ BigInt(4);
var BLIND_BYTES = 16;
var BLIND_BITS = 128;
var FW_WINDOW = 5;
var TABLE_BYTES_MAX = /* @__PURE__ */ (() => 2 ** 31)();
function validatePointCons(Point) {
  const pc = Point;
  if (typeof pc !== "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point);
  afunction(pc.fromAffine, "Point.fromAffine");
  afunction(pc.fromBytes, "Point.fromBytes");
  afunction(pc.fromHex, "Point.fromHex");
  aobject2(pc.BASE, "Point.BASE");
  aobject2(pc.ZERO, "Point.ZERO");
  validateField(pc.Fp);
  validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits, min = 1) {
  if (!Number.isSafeInteger(W) || W < min || W > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W);
}
function validateTableBytes(numPoints, fpBytes) {
  const bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes4, length) {
  if (randomBytes4 === void 0)
    return void 0;
  afunction(randomBytes4, "randomBytes");
  try {
    const probe = randomBytes4(length);
    if (!isBytes2(probe) || probe.length !== length)
      return void 0;
  } catch {
    return void 0;
  }
  return randomBytes4;
}
function validateMSMPoints(points, c) {
  aarray(points, "points");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === void 0 ? field.isValid(s) : isPosBig(s) && s < maxScalar;
    if (!ok)
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getWindowSize(P) {
  return pointWindowSizes.get(P) || 1;
}
function oddMultiples(p, size) {
  const dbl = p.double();
  const t = [p];
  for (let j = 1; j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const d = [];
  while (n > _0n3) {
    let w = 0;
    if (n & _1n3) {
      w = Number(n & mask);
      if (w >= half)
        w -= size;
      n -= BigInt(w);
    }
    d.push(w);
    n >>= _1n3;
  }
  return d;
}
function signedWindowDigits(n, W, windows) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const shiftBy = BigInt(W);
  const d = [];
  for (let w = 0; w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy;
    if (v > half) {
      v -= size;
      n += _1n3;
    }
    d.push(v);
  }
  if (n !== _0n3)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (const d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1; bit >= 0; bit--) {
    if (bit !== max - 1)
      acc = acc.double();
    for (let i = 0; i < digits.length; i++) {
      const w = digits[i][bit];
      if (w) {
        const item = tables[i][Math.abs(w) - 1 >> 1];
        acc = acc.add(w < 0 ? item.negate() : item);
      }
    }
  }
  return acc;
}
var ScalarMultiplier = class {
  // Parametrized with a given Point class (not individual point)
  constructor(Point, randomBytes4) {
    __publicField(this, "Point");
    __publicField(this, "BASE");
    __publicField(this, "ZERO");
    __publicField(this, "randomBytes");
    __publicField(this, "wnafPrecomputes", /* @__PURE__ */ new WeakMap());
    __publicField(this, "baseCanBeBlinded");
    __publicField(this, "bits");
    validatePointCons(Point);
    this.randomBytes = probeRandomBytes(randomBytes4, BLIND_BYTES);
    this.Point = Point;
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.bits = Point.Fn.BITS;
  }
  /**
   * Creates a signed fixed-window wNAF precomputation table: for every window w, the
   * multiples `[1..2^(W−1)]⋅2^(w⋅W)⋅P`, flattened. All doublings are baked into the table,
   * so cached multiplication is additions-only. `windows = ceil(bits/W) + 1`: the extra
   * window absorbs the final carry of signed-digit recoding.
   * For a 256-bit curve and W=6, the table is 44⋅32 = 1408 points.
   * @param point - Point instance
   * @param W - window size
   * @param bits - scalar bitlength the table must cover
   */
  buildWnafTable(point, W, bits) {
    const windows = Math.ceil(bits / W) + 1;
    const half = 2 ** (W - 1);
    const comp = [];
    let base = point;
    for (let w = 0; w < windows; w++) {
      let acc = base;
      for (let i = 0; i < half; i++) {
        comp.push(acc);
        acc = acc.add(base);
      }
      base = comp[comp.length - 1].double();
    }
    return { W, bits, windows, comp };
  }
  /**
   * Implements ec multiplication using precomputed signed fixed-window wNAF tables.
   * Constant-time: fixed window count with one table addition per window — zero digits feed
   * the fake accumulator — and no doublings; the lookup scans the whole window slice.
   * Scalar bounds are validated by the public entry points ({@link ScalarMultiplier.mulCT},
   * {@link ScalarMultiplier.mulCTBlinded}, {@link ScalarMultiplier.mulUnsafe});
   * signedWindowDigits throws if `n` exceeds the table.
   * @returns real and fake (for const-time) points
   */
  wnafCachedCT(precomputes, n) {
    const { W, windows, comp } = precomputes;
    const half = 2 ** (W - 1);
    const digits = signedWindowDigits(n, W, windows);
    let p = this.ZERO;
    let f = this.BASE;
    for (let w = 0; w < windows; w++) {
      const digit = digits[w];
      const start = w * half;
      const idx = Math.abs(digit) - 1;
      let sel = comp[start];
      for (let i = 1; i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      const neg = sel.negate();
      if (digit === 0)
        f = f.add(comp[start]);
      else
        p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  // Cache key is point identity plus (W, bits); at most two entries exist per point (public-width
  // `Fn.BITS` and blinded `Fn.BITS + BLIND_BITS`). Callers must not reuse the same point with
  // incompatible `transform(...)` layouts and expect a separate cache entry.
  getWnafPrecomputes(W, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point);
    let comp = entries?.find((entry) => entry.W === W && entry.bits === bits);
    if (!comp) {
      comp = this.buildWnafTable(point, W, bits);
      if (typeof transform === "function")
        comp = { ...comp, comp: transform(comp.comp) };
      if (!entries) {
        entries = [];
        this.wnafPrecomputes.set(point, entries);
      }
      entries.push(comp);
    }
    return comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  // Shared prologue of the constant-time entry points. Rejects scalar 0: in key/signature-style
  // callers a zero scalar means broken upstream plumbing, and concrete Points already reject it.
  // Uses inRange instead of Fn.isValidNot0: validateField() only certifies the arithmetic subset.
  validateMulInput(point, scalar) {
    this.assertPoint(point);
    if (!inRange(scalar, _1n3, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  // Constant-time dispatch shared by mulCT / mulCTBlinded. Un-precomputed points (W===1, e.g.
  // ECDH peer keys) skip building a throwaway cached table in favor of a small fixed-window
  // multiply. `n` must be < 2^bits.
  runCT(point, n, bits, transform) {
    const W = getWindowSize(point);
    if (W === 1)
      return this.fixedWindowCT(point, n, bits);
    return this.wnafCachedCT(this.getWnafPrecomputes(W, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    return this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    if (this.randomBytes === void 0)
      throw new Error("randomBytes is required for scalar blinding");
    const bits = this.Point.Fn.BITS + BLIND_BITS;
    const blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes2(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    const n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
    return this.runCT(point, n, bits, transform);
  }
  /**
   * Constant-time multiplication `n*point` for an un-precomputed point, via a small fixed window.
   * A cached wNAF table only pays off when reused; a flat 2^FW_WINDOW table (`size-1` adds) is
   * far cheaper to build for a single use. The point-operation sequence is independent of `n`:
   * build the table, then per window exactly FW_WINDOW doublings, a data-oblivious scan over
   * every table entry, and one addition (adds the identity when the window digit is 0 — never
   * skipped).
   *
   * `n` must be `< 2^bits`. Assumes complete addition (adding the identity costs the same as any
   * add), which holds for the Weierstrass/Edwards point types used here. The table is left in
   * projective form (no normalizeZ): normalizing this small a table costs more than the
   * mixed-add savings it would buy for a single multiply.
   * @returns real point `p`; `f` duplicates it only to match {@link wnafCachedCT}'s return shape
   * (this path needs no fake accumulator — its op-count is already scalar-independent).
   */
  fixedWindowCT(point, n, bits) {
    const W = FW_WINDOW;
    const size = 1 << W;
    const mask = bitMask(W);
    const table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1; i < size; i++)
      table[i] = table[i - 1].add(point);
    const windows = Math.ceil(bits / W);
    let acc = this.ZERO;
    for (let window = windows - 1; window >= 0; window--) {
      if (window !== windows - 1)
        for (let d = 0; d < W; d++)
          acc = acc.double();
      const digit = Number(n >> BigInt(window * W) & mask);
      let sel = table[0];
      for (let i = 1; i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    if (this.randomBytes === void 0)
      return false;
    if (cofactor === _1n3)
      return true;
    if (point !== this.BASE)
      return false;
    if (this.baseCanBeBlinded === void 0)
      this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0();
    return this.baseCanBeBlinded;
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    this.assertPoint(point);
    if (!isPosBig(scalar))
      throw new Error("invalid scalar");
    const W = getWindowSize(point);
    if (W === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], true);
    const precomputes = this.getWnafPrecomputes(W, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  // Remembers the window size used for precomputed wNAF multiplication of the given point
  // and drops any previously built tables. Usually only the base point is precomputed.
  // W=1 resets the point to the un-precomputed (table-less) paths.
  // W is additionally capped so tables stay under ~2 GiB ({@link TABLE_BYTES_MAX}).
  setWindowSize(point, W) {
    this.assertPoint(point);
    validateW(W, this.bits);
    const windows = Math.ceil((this.bits + BLIND_BITS) / W) + 1;
    validateTableBytes(windows * 2 ** (W - 1), this.Point.Fp.BYTES);
    pointWindowSizes.set(point, W);
    this.wnafPrecomputes.delete(point);
  }
  // True when a window size is set: tables themselves are built lazily on first multiply.
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
};
function mulAddUnsafe(c, points, scalars, allowOversized = false) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  abool(allowOversized, "allowOversized");
  validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : void 0);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const tables = points.map((p) => oddMultiples(p, 4));
  const digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE2) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE: isLE2 });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}

// mobile/node_modules/@noble/curves/abstract/edwards.js
var _0n4 = /* @__PURE__ */ BigInt(0);
var _1n4 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _4n3 = /* @__PURE__ */ BigInt(4);
var _8n2 = /* @__PURE__ */ BigInt(8);
function isEdValidXY(Fp, CURVE, x, y) {
  const x2 = Fp.sqr(x);
  const y2 = Fp.sqr(y);
  const left = Fp.add(Fp.mul(CURVE.a, x2), y2);
  const right = Fp.add(Fp.ONE, Fp.mul(CURVE.d, Fp.mul(x2, y2)));
  return Fp.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  validateObject(extraOpts, {}, {}, "extraOpts");
  const opts = extraOpts;
  const validated = createCurveFields("edwards", params, opts, opts.FpFnLE);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  if (FpLegendre(Fp, CURVE.a) !== 1)
    throw new Error("edwards: CURVE.a must be a square in Fp for complete addition formulas");
  if (FpLegendre(Fp, CURVE.d) !== -1)
    throw new Error("edwards: CURVE.d must be a non-square in Fp for complete addition formulas");
  validateObject(opts, {}, { uvRatio: "function", randomBytes: "function" });
  const randomBytes4 = opts.randomBytes === void 0 ? randomBytes2 : opts.randomBytes;
  const MASK = _2n2 << BigInt(Fp.BYTES * 8) - _1n4;
  function isOdd(n) {
    if (!Fp.isOdd)
      throw new Error("Field does not have .isOdd()");
    return Fp.isOdd(n);
  }
  const uvRatio2 = opts.uvRatio === void 0 ? (u, v) => {
    try {
      return { isValid: true, value: Fp.sqrt(Fp.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  } : opts.uvRatio;
  if (!isEdValidXY(Fp, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const mulA = Fp.eql(CURVE.a, Fp.neg(Fp.ONE)) ? (x) => Fp.neg(x) : Fp.eql(CURVE.a, Fp.ONE) ? (x) => x : (x) => Fp.mul(CURVE.a, x);
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aedpoint(other) {
    if (!(other instanceof Point))
      throw new Error("EdwardsPoint expected");
  }
  const _Point = class _Point {
    constructor(X, Y, Z, T) {
      __publicField(this, "X");
      __publicField(this, "Y");
      __publicField(this, "Z");
      __publicField(this, "T");
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    /**
     * Create one extended Edwards point from affine coordinates.
     * Does NOT validate that the point is on-curve or torsion-free.
     * Use `.assertValidity()` on adversarial inputs.
     */
    static fromAffine(p) {
      if (p instanceof _Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new _Point(x, y, Fp.ONE, Fp.mul(x, y));
    }
    // Uses algo from RFC8032 5.1.3.
    static fromBytes(bytes, zip215 = false) {
      const len = Fp.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(abytes2(bytes, len, "point"));
      abool(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = Fp.sqr(y);
      const u = Fp.sub(y2, Fp.ONE);
      const v = Fp.sub(Fp.mulN(d, y2), a);
      let { isValid, value: x } = uvRatio2(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = isOdd(x);
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && Fp.is0(x) && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = Fp.neg(x);
      return _Point.fromAffine({ x, y });
    }
    static fromHex(hex2, zip215 = false) {
      return _Point.fromBytes(hexToBytes2(hex2), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 6, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    // Useful in fromAffine() - not for fromBytes(), which always created valid points.
    assertValidity() {
      const p = this;
      const { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = Fp.sqr(X);
      const Y2 = Fp.sqr(Y);
      const Z2 = Fp.sqr(Z);
      const Z4 = Fp.sqr(Z2);
      const aX2 = Fp.mul(X2, a);
      const left = Fp.mul(Fp.add(aX2, Y2), Z2);
      const right = Fp.add(Z4, Fp.mul(d, Fp.mul(X2, Y2)));
      if (!Fp.eql(left, right))
        throw new Error("bad point: equation left != right (1)");
      const XY = Fp.mul(X, Y);
      const ZT = Fp.mul(Z, T);
      if (!Fp.eql(XY, ZT))
        throw new Error("bad point: equation left != right (2)");
    }
    // Compare one point to another.
    equals(other) {
      aedpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = Fp.mul(X1, Z2);
      const X2Z1 = Fp.mul(X2, Z1);
      const Y1Z2 = Fp.mul(Y1, Z2);
      const Y2Z1 = Fp.mul(Y2, Z1);
      return Fp.eql(X1Z2, X2Z1) && Fp.eql(Y1Z2, Y2Z1);
    }
    is0() {
      return this.equals(_Point.ZERO);
    }
    negate() {
      return new _Point(Fp.neg(this.X), this.Y, this.Z, Fp.neg(this.T));
    }
    // Fast algo for doubling Extended Point.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
    // Cost: 4M + 4S + 1*a + 6add + 1*2.
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = Fp.sqr(X1);
      const B = Fp.sqr(Y1);
      const C = Fp.mul(Fp.sqr(Z1), _2n2);
      const D = mulA(A);
      const x1y1 = Fp.addN(X1, Y1);
      const E = Fp.sub(Fp.subN(Fp.sqr(x1y1), A), B);
      const G = Fp.addN(D, B);
      const F = Fp.subN(G, C);
      const H = Fp.subN(D, B);
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new _Point(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aedpoint(other);
      const { d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = Fp.mul(X1, X2);
      const B = Fp.mul(Y1, Y2);
      const C = Fp.mul(Fp.mulN(T1, d), T2);
      const D = Fp.mul(Z1, Z2);
      const E = Fp.sub(Fp.subN(Fp.mulN(Fp.addN(X1, Y1), Fp.addN(X2, Y2)), A), B);
      const F = Fp.subN(D, C);
      const G = Fp.addN(D, C);
      const H = Fp.sub(B, mulA(A));
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new _Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      aedpoint(other);
      return this.add(other.negate());
    }
    // Constant-time multiplication.
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize);
      return normalize([p, f])[0];
    }
    // Non-constant-time multiplication. Uses double-and-add algorithm.
    // It's faster, but should only be used when you don't care about
    // an exposed private key e.g. sig verification.
    // Keeps the same subgroup-scalar contract: 0 is allowed for public-scalar callers, but
    // n and larger values are rejected instead of being reduced mod n to the identity point.
    multiplyUnsafe(scalar) {
      if (!Fn.isValid(scalar))
        throw new RangeError("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return _Point.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.mulUnsafe(this, scalar, normalize);
    }
    // Checks if point is of small order.
    // If you add something to small order point, you will have "dirty"
    // point with torsion component.
    // Clears cofactor and checks if the result is 0.
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    // Multiplies point by curve order and checks if the result is 0.
    // Returns `false` is the point is dirty.
    isTorsionFree() {
      return wnaf.mulUnsafe(this, CURVE.n).is0();
    }
    // Converts Extended point to default (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      if (iz != null && typeof iz !== "bigint")
        throw new TypeError('"invertedZ" expected bigint, got type=' + typeof iz);
      const { X, Y, Z } = p;
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp.create(_8n2) : Fp.inv(Z);
      const x = Fp.mul(X, iz);
      const y = Fp.mul(Y, iz);
      const zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ONE };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      if (cofactor === _2n2)
        return this.double();
      if (cofactor === _4n3)
        return this.double().double();
      if (cofactor === _8n2)
        return this.double().double().double();
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp.toBytes(y);
      bytes[bytes.length - 1] |= isOdd(x) ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex2(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  };
  __publicField(_Point, "BASE", new _Point(CURVE.Gx, CURVE.Gy, Fp.ONE, Fp.mul(CURVE.Gx, CURVE.Gy)));
  __publicField(_Point, "ZERO", new _Point(Fp.ZERO, Fp.ONE, Fp.ONE, Fp.ZERO));
  __publicField(_Point, "Fp", Fp);
  __publicField(_Point, "Fn", Fn);
  let Point = _Point;
  const normalize = (points) => normalizeZ(Point, points);
  const wnaf = new ScalarMultiplier(Point, randomBytes4);
  if (wnaf.bits >= 6)
    Point.BASE.precompute(6);
  Object.freeze(Point.prototype);
  Object.freeze(Point);
  return Point;
}

// mobile/node_modules/@noble/curves/abstract/montgomery.js
var _0n5 = /* @__PURE__ */ BigInt(0);
var _1n5 = /* @__PURE__ */ BigInt(1);
var _2n3 = /* @__PURE__ */ BigInt(2);
function cmask(P, swap) {
  return P + swap - (swap >> _1n5 << _1n5);
}
function cswap(P) {
  const offset = BigInt(6) * P;
  return (mask, x_2, x_3) => {
    const sum = x_2 + x_3;
    const d = offset + x_3 - x_2;
    const a = (d * mask + x_2) % P;
    return { x_2: a, x_3: sum - a };
  };
}
function validateOpts(curve) {
  validateObject(curve, {
    P: "bigint",
    type: "string",
    adjustScalarBytes: "function",
    powPminus2: "function"
  }, {
    randomBytes: "function",
    scalarMultBase: "function"
  });
  return Object.freeze({ ...curve });
}
function montgomery(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { P, type, adjustScalarBytes: adjustScalarBytes2, powPminus2, randomBytes: rand } = CURVE;
  const mulBaseHook = CURVE.scalarMultBase;
  const is25519 = type === "x25519";
  if (!is25519 && type !== "x448")
    throw new Error("invalid type");
  const randomBytes_ = rand === void 0 ? randomBytes2 : rand;
  const montgomeryBits = is25519 ? 255 : 448;
  const swap = cswap(P);
  const fieldLen = is25519 ? 32 : 56;
  const Gu = is25519 ? BigInt(9) : BigInt(5);
  const a24 = is25519 ? BigInt(121665) : BigInt(39081);
  const minScalar = is25519 ? _2n3 ** BigInt(254) : _2n3 ** BigInt(447);
  const maxAdded = is25519 ? BigInt(8) * (_2n3 ** BigInt(251) - _1n5) : BigInt(4) * (_2n3 ** BigInt(445) - _1n5);
  const maxScalar = minScalar + maxAdded + _1n5;
  const modP = (n) => mod(n, P);
  const GuBytes = encodeU(Gu);
  function encodeU(u) {
    return numberToBytesLE(modP(u), fieldLen);
  }
  function decodeU(u) {
    const _u = copyBytes(abytes2(u, fieldLen, "uCoordinate"));
    if (is25519)
      _u[31] &= 127;
    return modP(bytesToNumberLE(_u));
  }
  function decodeScalar(scalar) {
    return bytesToNumberLE(adjustScalarBytes2(copyBytes(abytes2(scalar, fieldLen, "scalar"))));
  }
  const lowOrderU = new Set(is25519 ? [
    _0n5,
    _1n5,
    P - _1n5,
    BigInt("325606250916557431795983626356110631294008115727848805560023387167927233504"),
    BigInt("39382357235489614581723060781553021112529911719440698176882885853963445705823")
  ] : [_0n5, _1n5, P - _1n5]);
  function scalarMult(scalar, u) {
    const pointU = decodeU(u);
    if (lowOrderU.has(pointU))
      throw new Error("invalid private or public key received");
    const pu = montgomeryLadder(pointU, decodeScalar(scalar));
    if (pu === _0n5)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  function scalarMultBase(scalar) {
    if (mulBaseHook === void 0)
      return scalarMult(scalar, GuBytes);
    const k = decodeScalar(scalar);
    aInRange("scalar", k, minScalar, maxScalar);
    const pu = modP(mulBaseHook(k));
    if (pu === _0n5)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  const getPublicKey = scalarMultBase;
  const getSharedSecret = scalarMult;
  function montgomeryLadder(u, scalar) {
    aInRange("u", u, _0n5, P);
    aInRange("scalar", scalar, minScalar, maxScalar);
    const k = scalar;
    const x_1 = u;
    let x_2 = _1n5;
    let z_2 = _0n5;
    let x_3 = u;
    let z_3 = _1n5;
    const kx = k ^ k >> _1n5;
    for (let t = BigInt(montgomeryBits - 1); t >= _0n5; t--) {
      const mask2 = cmask(P, kx >> t);
      ({ x_2, x_3 } = swap(mask2, x_2, x_3));
      ({ x_2: z_2, x_3: z_3 } = swap(mask2, z_2, z_3));
      const A = x_2 + z_2;
      const AA = modP(A * A);
      const B = x_2 - z_2;
      const BB = modP(B * B);
      const E = AA - BB;
      const C = x_3 + z_3;
      const D = x_3 - z_3;
      const DA = modP(D * A);
      const CB = modP(C * B);
      const dacb = DA + CB;
      const da_cb = DA - CB;
      x_3 = modP(dacb * dacb);
      z_3 = modP(x_1 * modP(da_cb * da_cb));
      x_2 = modP(AA * BB);
      z_2 = modP(E * (AA + modP(a24 * E)));
    }
    const mask = cmask(P, k);
    ({ x_2, x_3 } = swap(mask, x_2, x_3));
    ({ x_2: z_2, x_3: z_3 } = swap(mask, z_2, z_3));
    const z2 = powPminus2(z_2);
    return modP(x_2 * z2);
  }
  const lengths = {
    secretKey: fieldLen,
    publicKey: fieldLen,
    seed: fieldLen
  };
  const randomSecretKey = (seed) => {
    seed = seed === void 0 ? randomBytes_(fieldLen) : seed;
    abytes2(seed, lengths.seed, "seed");
    return seed;
  };
  const utils = { randomSecretKey };
  Object.freeze(lengths);
  Object.freeze(utils);
  return Object.freeze({
    keygen: createKeygen(randomSecretKey, getPublicKey),
    getSharedSecret,
    getPublicKey,
    scalarMult,
    scalarMultBase,
    utils,
    GuBytes: GuBytes.slice(),
    lengths
  });
}

// mobile/node_modules/@noble/curves/ed25519.js
var _0n6 = /* @__PURE__ */ BigInt(0);
var _1n6 = /* @__PURE__ */ BigInt(1);
var _2n4 = /* @__PURE__ */ BigInt(2);
var _3n2 = /* @__PURE__ */ BigInt(3);
var _5n2 = /* @__PURE__ */ BigInt(5);
var _8n3 = /* @__PURE__ */ BigInt(8);
var ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
var ed25519_CURVE = /* @__PURE__ */ (() => ({
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
}))();
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n4, P) * b2 % P;
  const b5 = pow2(b4, _1n6, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n4, P) * x % P;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow3 = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow3, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE, { uvRatio });
var x25519 = /* @__PURE__ */ (() => {
  const P = ed25519_CURVE_p;
  const powPminus2 = (x) => {
    const { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
    return mod(pow2(pow_p_5_8, _3n2, P) * b2, P);
  };
  return montgomery({
    P,
    type: "x25519",
    powPminus2,
    adjustScalarBytes,
    // ~3x faster fixed-base: [k]B on the birationally-equivalent Edwards curve using cached
    // base tables, mapped back via u = (1+y)/(1-y) = (Z+Y)/(Z-Y) with one Fermat inversion.
    // Same construction as libsodium's crypto_scalarmult_curve25519_base.
    scalarMultBase: (k) => {
      const kn = mod(k, ed25519_Point.Fn.ORDER);
      if (kn === _0n6)
        return _0n6;
      const p = ed25519_Point.BASE.multiply(kn);
      return mod((p.Z + p.Y) * powPminus2(mod(p.Z - p.Y, P)), P);
    }
  });
})();

// mobile/node_modules/@noble/ciphers/utils.js
function isBytes3(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle3 = (title) => title ? `"${title}" ` : "";
function abool2(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle3(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function anumber3(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle3(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle3(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes3(value, length, title = "") {
  if (isBytes3(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber3(length, "length");
  const bytes = isBytes3(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle3(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject3 = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(label === "object" ? "expected valid options object" : `"${label}" expected object, got type=${typeof value}`);
};
function aexists2(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput2(out, instance) {
  abytes3(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean2(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
function overlapBytes(a, b) {
  if (!a.byteLength || !b.byteLength)
    return false;
  return a.buffer === b.buffer && // best we can do, may fail with an obscure Proxy
  a.byteOffset < b.byteOffset + b.byteLength && // a starts before b end
  b.byteOffset < a.byteOffset + a.byteLength;
}
function complexOverlapBytes(input, output) {
  if (overlapBytes(input, output) && input.byteOffset < output.byteOffset)
    throw new Error("complex overlap of input and output is not supported");
}
function checkOpts2(defaults, opts) {
  aobject3(defaults, "defaults");
  aobject3(opts, "opts");
  const merged = Object.assign(defaults, opts);
  return merged;
}
function equalBytes(a, b) {
  a = abytes3(a);
  b = abytes3(b);
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function wrapMacConstructor(keyLen, macCons, fromMsg) {
  const mac = macCons;
  const getArgs = fromMsg || (() => []);
  const macC = (msg, key) => mac(key, ...getArgs(msg)).update(msg).digest();
  const tmp = mac(new Uint8Array(keyLen), ...getArgs(new Uint8Array(0)));
  macC.outputLen = tmp.outputLen;
  macC.blockLen = tmp.blockLen;
  macC.create = (key, ...args) => mac(key, ...args);
  return macC;
}
var wrapCipher = /* @__NO_SIDE_EFFECTS__ */ (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes3(key, void 0, "key");
    if (params.nonceLength !== void 0) {
      const nonce = args[0];
      abytes3(nonce, params.varSizeNonce ? void 0 : params.nonceLength, "nonce");
    }
    const tagl = params.tagLength;
    const aadStart = params.nonceLength !== void 0 ? 1 : 0;
    if (!params.withAAD) {
      for (let i = aadStart; i < args.length; i++)
        if (isBytes3(args[i]))
          throw new Error("AAD not supported");
    }
    if (params.withAAD && args[aadStart] !== void 0)
      abytes3(args[aadStart], void 0, "AAD");
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output) => {
      if (output !== void 0) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes3(output, void 0, "output");
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        called = true;
        abytes3(data, void 0, "data");
        checkOutput(cipher.encrypt.length, output);
        return cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        abytes3(data, void 0, "data");
        if (tagl && data.length < tagl)
          throw new Error('"ciphertext" expected length >= tagLength=' + tagl);
        checkOutput(cipher.decrypt.length, output);
        return cipher.decrypt(data, output);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === void 0)
    return new Uint8Array(expectedLength);
  abytes3(out, expectedLength, "output");
  if (onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function u64Lengths(dataLength, aadLength, isLE2) {
  anumber3(dataLength);
  anumber3(aadLength);
  abool2(isLE2);
  const num = new Uint8Array(16);
  const view = createView2(num);
  view.setBigUint64(0, BigInt(aadLength), isLE2);
  view.setBigUint64(8, BigInt(dataLength), isLE2);
  return num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes2(bytes) {
  return Uint8Array.from(abytes3(bytes));
}

// mobile/node_modules/@noble/ciphers/_arx.js
var encodeStr = (str) => Uint8Array.from(str.split(""), (c) => c.charCodeAt(0));
var sigma16_32 = /* @__PURE__ */ (() => swap32IfBE(u32(encodeStr("expand 16-byte k"))))();
var sigma32_32 = /* @__PURE__ */ (() => swap32IfBE(u32(encodeStr("expand 32-byte k"))))();
function rotl(a, b) {
  return a << b | a >>> 32 - b;
}
var BLOCK_LEN = 64;
var BLOCK_LEN32 = 16;
var MAX_COUNTER = /* @__PURE__ */ (() => 2 ** 32 - 1)();
var U32_EMPTY = /* @__PURE__ */ Uint32Array.of();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
  const len = data.length;
  const block = new Uint8Array(BLOCK_LEN);
  const b32 = u32(block);
  const isAligned = isLE && isAligned32(data) && isAligned32(output);
  const d32 = isAligned ? u32(data) : U32_EMPTY;
  const o32 = isAligned ? u32(output) : U32_EMPTY;
  if (!isLE) {
    for (let pos = 0; pos < len; counter++) {
      core(sigma, key, nonce, b32, counter, rounds);
      swap32IfBE(b32);
      if (counter >= MAX_COUNTER)
        throw new Error("arx: counter overflow");
      const take = Math.min(BLOCK_LEN, len - pos);
      for (let j = 0, posj; j < take; j++) {
        posj = pos + j;
        output[posj] = data[posj] ^ block[j];
      }
      pos += take;
    }
    return;
  }
  for (let pos = 0; pos < len; counter++) {
    core(sigma, key, nonce, b32, counter, rounds);
    if (counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    const take = Math.min(BLOCK_LEN, len - pos);
    if (isAligned && take === BLOCK_LEN) {
      const pos32 = pos / 4;
      if (pos % 4 !== 0)
        throw new Error("arx: invalid block position");
      for (let j = 0, posj; j < BLOCK_LEN32; j++) {
        posj = pos32 + j;
        o32[posj] = d32[posj] ^ b32[j];
      }
      pos += BLOCK_LEN;
      continue;
    }
    for (let j = 0, posj; j < take; j++) {
      posj = pos + j;
      output[posj] = data[posj] ^ block[j];
    }
    pos += take;
  }
}
function createCipher(core, opts) {
  const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts2({ allowShortKeys: false, counterLength: 8, counterRight: false, rounds: 20 }, opts);
  if (typeof core !== "function")
    throw new Error("core must be a function");
  anumber3(counterLength);
  anumber3(rounds);
  abool2(counterRight);
  abool2(allowShortKeys);
  return (key, nonce, data, output, counter = 0) => {
    abytes3(key, void 0, "key");
    abytes3(nonce, void 0, "nonce");
    abytes3(data, void 0, "data");
    const len = data.length;
    const hasOutput = output !== void 0;
    output = getOutput(len, output, false);
    if (hasOutput)
      complexOverlapBytes(data, output);
    anumber3(counter);
    if (counter < 0 || counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    const toClean = [];
    let l = key.length;
    let k;
    let sigma;
    if (l === 32) {
      toClean.push(k = copyBytes2(key));
      sigma = sigma32_32;
    } else if (l === 16 && allowShortKeys) {
      k = new Uint8Array(32);
      k.set(key);
      k.set(key, 16);
      sigma = sigma16_32;
      toClean.push(k);
    } else {
      abytes3(key, 32, "arx key");
      throw new Error("invalid key size");
    }
    if (!isLE || !isAligned32(nonce))
      toClean.push(nonce = copyBytes2(nonce));
    let k32 = u32(k);
    if (extendNonceFn) {
      if (nonce.length !== 24)
        throw new Error("arx: extended nonce must be 24 bytes");
      const n16 = nonce.subarray(0, 16);
      if (isLE)
        extendNonceFn(sigma, k32, u32(n16), k32);
      else {
        const sigmaRaw = swap32IfBE(Uint32Array.from(sigma));
        extendNonceFn(sigmaRaw, k32, u32(n16), k32);
        clean2(sigmaRaw);
        swap32IfBE(k32);
      }
      nonce = nonce.subarray(16);
    } else if (!isLE)
      swap32IfBE(k32);
    const nonceNcLen = 16 - counterLength;
    if (nonceNcLen !== nonce.length)
      throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
    if (nonceNcLen !== 12) {
      const nc = new Uint8Array(12);
      nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
      nonce = nc;
      toClean.push(nonce);
    }
    const n32 = swap32IfBE(u32(nonce));
    try {
      runCipher(core, sigma, k32, n32, data, output, counter, rounds);
      return output;
    } finally {
      clean2(...toClean);
    }
  };
}

// mobile/node_modules/@noble/ciphers/_poly1305.js
function u8to16(a, i) {
  return a[i++] & 255 | (a[i++] & 255) << 8;
}
var Poly1305 = class {
  // Can be speed-up using BigUint64Array, at the cost of complexity
  constructor(key) {
    __publicField(this, "blockLen", 16);
    __publicField(this, "outputLen", 16);
    __publicField(this, "buffer", new Uint8Array(16));
    __publicField(this, "r", new Uint16Array(10));
    // Allocating 1 array with .subarray() here is slower than 3
    __publicField(this, "h", new Uint16Array(10));
    __publicField(this, "pad", new Uint16Array(8));
    __publicField(this, "pos", 0);
    __publicField(this, "finished", false);
    __publicField(this, "destroyed", false);
    key = copyBytes2(abytes3(key, 32, "key"));
    const t0 = u8to16(key, 0);
    const t1 = u8to16(key, 2);
    const t2 = u8to16(key, 4);
    const t3 = u8to16(key, 6);
    const t4 = u8to16(key, 8);
    const t5 = u8to16(key, 10);
    const t6 = u8to16(key, 12);
    const t7 = u8to16(key, 14);
    this.r[0] = t0 & 8191;
    this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
    this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
    this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
    this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
    this.r[5] = t4 >>> 1 & 8190;
    this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
    this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
    this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
    this.r[9] = t7 >>> 5 & 127;
    for (let i = 0; i < 8; i++)
      this.pad[i] = u8to16(key, 16 + 2 * i);
  }
  process(data, offset, isLast = false) {
    const hibit = isLast ? 0 : 1 << 11;
    const { h, r } = this;
    const r0 = r[0];
    const r1 = r[1];
    const r2 = r[2];
    const r3 = r[3];
    const r4 = r[4];
    const r5 = r[5];
    const r6 = r[6];
    const r7 = r[7];
    const r8 = r[8];
    const r9 = r[9];
    const t0 = u8to16(data, offset + 0);
    const t1 = u8to16(data, offset + 2);
    const t2 = u8to16(data, offset + 4);
    const t3 = u8to16(data, offset + 6);
    const t4 = u8to16(data, offset + 8);
    const t5 = u8to16(data, offset + 10);
    const t6 = u8to16(data, offset + 12);
    const t7 = u8to16(data, offset + 14);
    let h0 = h[0] + (t0 & 8191);
    let h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
    let h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
    let h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
    let h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
    let h5 = h[5] + (t4 >>> 1 & 8191);
    let h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
    let h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
    let h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
    let h9 = h[9] + (t7 >>> 5 | hibit);
    let c = 0;
    let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13;
    d0 &= 8191;
    d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
    c += d0 >>> 13;
    d0 &= 8191;
    let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13;
    d1 &= 8191;
    d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
    c += d1 >>> 13;
    d1 &= 8191;
    let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13;
    d2 &= 8191;
    d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
    c += d2 >>> 13;
    d2 &= 8191;
    let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13;
    d3 &= 8191;
    d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
    c += d3 >>> 13;
    d3 &= 8191;
    let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13;
    d4 &= 8191;
    d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
    c += d4 >>> 13;
    d4 &= 8191;
    let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13;
    d5 &= 8191;
    d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
    c += d5 >>> 13;
    d5 &= 8191;
    let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13;
    d6 &= 8191;
    d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
    c += d6 >>> 13;
    d6 &= 8191;
    let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13;
    d7 &= 8191;
    d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
    c += d7 >>> 13;
    d7 &= 8191;
    let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13;
    d8 &= 8191;
    d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
    c += d8 >>> 13;
    d8 &= 8191;
    let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13;
    d9 &= 8191;
    d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    c += d9 >>> 13;
    d9 &= 8191;
    c = (c << 2) + c | 0;
    c = c + d0 | 0;
    d0 = c & 8191;
    c = c >>> 13;
    d1 += c;
    h[0] = d0;
    h[1] = d1;
    h[2] = d2;
    h[3] = d3;
    h[4] = d4;
    h[5] = d5;
    h[6] = d6;
    h[7] = d7;
    h[8] = d8;
    h[9] = d9;
  }
  finalize() {
    const { h, pad } = this;
    const g = new Uint16Array(10);
    let c = h[1] >>> 13;
    h[1] &= 8191;
    for (let i = 2; i < 10; i++) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 8191;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 8191;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 8191;
    h[2] += c;
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 8191;
    for (let i = 1; i < 10; i++) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 8191;
    }
    g[9] -= 1 << 13;
    let mask = (c ^ 1) - 1;
    for (let i = 0; i < 10; i++)
      g[i] &= mask;
    mask = ~mask;
    for (let i = 0; i < 10; i++)
      h[i] = h[i] & mask | g[i];
    h[0] = (h[0] | h[1] << 13) & 65535;
    h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
    h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
    h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
    h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
    h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
    h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
    h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
    let f = h[0] + pad[0];
    h[0] = f & 65535;
    for (let i = 1; i < 8; i++) {
      f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
      h[i] = f & 65535;
    }
    clean2(g);
  }
  update(data) {
    aexists2(this);
    abytes3(data);
    data = copyBytes2(data);
    const { buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(buffer, 0, false);
        this.pos = 0;
      }
    }
    return this;
  }
  destroy() {
    this.destroyed = true;
    clean2(this.h, this.r, this.buffer, this.pad);
  }
  digestInto(out) {
    aexists2(this);
    aoutput2(out, this);
    this.finished = true;
    const { buffer, h } = this;
    let { pos } = this;
    if (pos) {
      buffer[pos++] = 1;
      for (; pos < 16; pos++)
        buffer[pos] = 0;
      this.process(buffer, 0, true);
    }
    this.finalize();
    let opos = 0;
    for (let i = 0; i < 8; i++) {
      out[opos++] = h[i] >>> 0;
      out[opos++] = h[i] >>> 8;
    }
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
};
var poly1305 = /* @__PURE__ */ wrapMacConstructor(32, (key) => new Poly1305(key));

// mobile/node_modules/@noble/ciphers/chacha.js
function chachaCore(s, k, n, out, cnt, rounds = 20) {
  let y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
  let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
  for (let r = 0; r < rounds; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = y00 + x00 | 0;
  out[oi++] = y01 + x01 | 0;
  out[oi++] = y02 + x02 | 0;
  out[oi++] = y03 + x03 | 0;
  out[oi++] = y04 + x04 | 0;
  out[oi++] = y05 + x05 | 0;
  out[oi++] = y06 + x06 | 0;
  out[oi++] = y07 + x07 | 0;
  out[oi++] = y08 + x08 | 0;
  out[oi++] = y09 + x09 | 0;
  out[oi++] = y10 + x10 | 0;
  out[oi++] = y11 + x11 | 0;
  out[oi++] = y12 + x12 | 0;
  out[oi++] = y13 + x13 | 0;
  out[oi++] = y14 + x14 | 0;
  out[oi++] = y15 + x15 | 0;
}
var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 4,
  allowShortKeys: false
});
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var updatePadded = (h, msg) => {
  h.update(msg);
  const leftover = msg.length % 16;
  if (leftover)
    h.update(ZEROS16.subarray(leftover));
};
var ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, ciphertext, AAD) {
  if (AAD !== void 0)
    abytes3(AAD, void 0, "AAD");
  const authKey = fn(key, nonce, ZEROS32);
  const lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, true);
  const h = poly1305.create(authKey);
  if (AAD)
    updatePadded(h, AAD);
  updatePadded(h, ciphertext);
  h.update(lengths);
  const res = h.digest();
  clean2(authKey, lengths);
  return res;
}
var _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
  const tagLength = 16;
  return {
    encrypt(plaintext, output) {
      const plength = plaintext.length;
      output = getOutput(plength + tagLength, output, false);
      output.set(plaintext);
      const oPlain = output.subarray(0, -tagLength);
      xorStream(key, nonce, oPlain, oPlain, 1);
      const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
      output.set(tag, plength);
      clean2(tag);
      return output;
    },
    decrypt(ciphertext, output) {
      output = getOutput(ciphertext.length - tagLength, output, false);
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = computeTag(xorStream, key, nonce, data, AAD);
      if (!equalBytes(passedTag, tag)) {
        clean2(tag);
        throw new Error("invalid tag");
      }
      output.set(ciphertext.subarray(0, -tagLength));
      xorStream(key, nonce, output, output, 1);
      clean2(tag);
      return output;
    }
  };
};
var chacha20poly1305 = /* @__PURE__ */ wrapCipher(
  { blockSize: 64, nonceLength: 12, tagLength: 16, withAAD: true },
  /* @__PURE__ */ _poly1305_aead(chacha20)
);

// mobile/node_modules/@noble/hashes/hmac.js
var _HMAC = class {
  constructor(hash, key) {
    __publicField(this, "oHash");
    __publicField(this, "iHash");
    __publicField(this, "blockLen");
    __publicField(this, "outputLen");
    __publicField(this, "canXOF", false);
    __publicField(this, "finished", false);
    __publicField(this, "destroyed", false);
    ahash(hash);
    abytes(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf);
    this.oHash.update(buf);
    this.oHash.digestInto(buf);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.canXOF = canXOF;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = /* @__PURE__ */ (() => {
  const hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
  hmac_.create = (hash, key) => new _HMAC(hash, key);
  return hmac_;
})();

// mobile/node_modules/@noble/hashes/hkdf.js
var HKDF_COUNTER = /* @__PURE__ */ Uint8Array.of(0);
var EMPTY_BUFFER = /* @__PURE__ */ Uint8Array.of();
function expand(hash, prk, info, length = 32, _recycled) {
  ahash(hash);
  anumber(length, "length");
  abytes(prk, void 0, "prk");
  const olen = hash.outputLen;
  if (prk.length < olen)
    throw new Error('"prk" must be at least HashLen octets');
  if (length > 255 * olen)
    throw new Error("Length must be <= 255*HashLen");
  const blocks = Math.ceil(length / olen);
  if (info === void 0)
    info = EMPTY_BUFFER;
  else
    abytes(info, void 0, "info");
  if (!blocks) {
    if (_recycled)
      clean(prk);
    return new Uint8Array();
  }
  const okm = _recycled && blocks === 1 ? prk : new Uint8Array(blocks * olen);
  const { iHash, oHash } = hmac.create(hash, prk);
  const T = _recycled ? prk : new Uint8Array(olen);
  const worker = blocks > 1 ? _recycled?.iHash || hash.create() : void 0;
  for (let counter = 0; counter < blocks - 1; counter++) {
    HKDF_COUNTER[0] = counter + 1;
    const iWork = iHash._cloneInto(worker);
    if (counter)
      iWork.update(T);
    iWork.update(info).update(HKDF_COUNTER).digestInto(T);
    oHash._cloneInto(worker).update(T).digestInto(T);
    okm.set(T, olen * counter);
  }
  HKDF_COUNTER[0] = blocks;
  if (blocks > 1)
    iHash.update(T);
  iHash.update(info).update(HKDF_COUNTER).digestInto(T);
  oHash.update(T).digestInto(T);
  okm.set(T, olen * (blocks - 1));
  iHash.destroy();
  oHash.destroy();
  worker?.destroy();
  if (T !== okm)
    clean(T);
  clean(HKDF_COUNTER);
  if (length === okm.length)
    return okm;
  const res = okm.slice(0, length);
  clean(okm);
  return res;
}
var hkdf = (hash, ikm, salt, info, length) => {
  ahash(hash);
  if (salt === void 0)
    salt = new Uint8Array(hash.outputLen);
  const HMAC = hmac.create(hash, salt).update(ikm);
  return expand(hash, HMAC.digest(), info, length, HMAC);
};

// lib/remote/noise.mjs
var MAX_NOISE_MESSAGE = 65535;
var MAX_PLAINTEXT = 65519;
var KEY_LEN = 32;
var TAG_LEN = 16;
var MAC_LEN = 16;
var COOKIE_TYPE = 127;
var CARRIERS = Object.freeze(["lan", "tailscale", "relay"]);
var DHLEN = 32;
var HASHLEN = 32;
var MAX_NONCE = 0xffffffffffffffffn;
var EMPTY = new Uint8Array(0);
var utf8 = new TextEncoder();
var ERROR_MESSAGES = Object.freeze({
  ARG: "An argument has the wrong type or size.",
  KEY: "A key must be exactly 32 bytes.",
  TOO_BIG: "A message may not be larger than 65535 bytes.",
  AUTH: "The message could not be authenticated.",
  NONCE: "The message counter for this key is used up.",
  WIPED: "The cipher state has been cleared.",
  STATE: "The handshake step is out of order.",
  DEAD: "The handshake has failed or finished and cannot be used again.",
  HANDSHAKE: "The handshake message could not be verified.",
  REPLAY: "The handshake counter is not higher than the last one used by this device.",
  UNKNOWN: "This device is not paired with this computer.",
  PAYLOAD: "The handshake payload is not valid.",
  CARRIER: "The carrier must be lan, tailscale or relay.",
  RANDOM: "No secure random source is available."
});
var NoiseError = class extends Error {
  /** @param {keyof typeof ERROR_MESSAGES} code */
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.ARG);
    this.name = "NoiseError";
    this.code = ERROR_MESSAGES[code] ? code : "ARG";
  }
};
var fail = (code) => new NoiseError(code);
function isBytes4(x) {
  return ArrayBuffer.isView(x) && Object.prototype.toString.call(x) === "[object Uint8Array]";
}
function copyBytes3(x, code = "ARG") {
  if (!isBytes4(x)) throw fail(code);
  return new Uint8Array(x);
}
function key32(x) {
  if (!isBytes4(x) || x.length !== KEY_LEN) throw fail("KEY");
  return new Uint8Array(x);
}
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function wipe(...arrays) {
  for (const a of arrays) if (a && typeof a.fill === "function") a.fill(0);
}
var HEX = "0123456789abcdef";
function bytesToHex3(bytes) {
  if (!isBytes4(bytes)) throw fail("ARG");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}
function hexToBytes3(hex2) {
  if (typeof hex2 !== "string" || hex2.length % 2 || /[^0-9a-fA-F]/.test(hex2)) throw fail("ARG");
  const out = new Uint8Array(hex2.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex2.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function defaultRandom(n) {
  try {
    return randomBytes(n);
  } catch {
    throw fail("RANDOM");
  }
}
function pickRandom(random) {
  if (random === void 0 || random === null) return defaultRandom;
  if (typeof random !== "function") throw fail("ARG");
  return random;
}
function freshKey(random) {
  const k = random(KEY_LEN);
  if (!isBytes4(k) || k.length !== KEY_LEN) throw fail("RANDOM");
  return k;
}
function dh(privateKey, publicKey) {
  try {
    return x25519.getSharedSecret(privateKey, publicKey);
  } catch {
    throw fail("HANDSHAKE");
  }
}
function publicOf(privateKey) {
  try {
    return x25519.getPublicKey(privateKey);
  } catch {
    throw fail("KEY");
  }
}
function generateKeyPair(random) {
  const sk = freshKey(pickRandom(random));
  return { privateKey: sk, publicKey: publicOf(sk) };
}
function deviceId(publicKey) {
  return bytesToHex3(sha256(key32(publicKey)));
}
function noiseHkdf(chainingKey, inputKeyMaterial, n) {
  const temp = hmac(sha256, chainingKey, inputKeyMaterial);
  const o1 = hmac(sha256, temp, Uint8Array.of(1));
  const o2 = hmac(sha256, temp, concat(o1, Uint8Array.of(2)));
  let o3 = null;
  if (n === 3) o3 = hmac(sha256, temp, concat(o2, Uint8Array.of(3)));
  wipe(temp);
  return n === 3 ? [o1, o2, o3] : [o1, o2];
}
function nonceBytes(n) {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}
var _k, _n, _wiped;
var CipherState = class {
  /** @param {Uint8Array|null} [key] 32-byte key, or nothing for the empty (pass-through) state. The key is copied. */
  constructor(key = null) {
    __privateAdd(this, _k, null);
    __privateAdd(this, _n, 0n);
    __privateAdd(this, _wiped, false);
    if (key !== null && key !== void 0) __privateSet(this, _k, key32(key));
  }
  hasKey() {
    return __privateGet(this, _k) !== null;
  }
  /** The next nonce as a BigInt (also the number of messages sent or received with this key so far). */
  get nonce() {
    return __privateGet(this, _n);
  }
  /** Spec SetNonce(). Accepts a safe integer or BigInt in 0 .. 2^64-1. */
  setNonce(n) {
    let v;
    if (typeof n === "bigint") v = n;
    else if (Number.isSafeInteger(n) && n >= 0) v = BigInt(n);
    else throw fail("ARG");
    if (v < 0n || v > MAX_NONCE) throw fail("ARG");
    __privateSet(this, _n, v);
  }
  /** EncryptWithAd. The size cap is checked before anything is encrypted; the nonce advances only after a successful encryption. */
  encryptWithAd(ad, plaintext) {
    if (__privateGet(this, _wiped)) throw fail("WIPED");
    if (!isBytes4(ad) || !isBytes4(plaintext)) throw fail("ARG");
    if (__privateGet(this, _k) === null) {
      if (plaintext.length > MAX_NOISE_MESSAGE) throw fail("TOO_BIG");
      return new Uint8Array(plaintext);
    }
    if (plaintext.length > MAX_PLAINTEXT) throw fail("TOO_BIG");
    if (__privateGet(this, _n) >= MAX_NONCE) throw fail("NONCE");
    let out;
    try {
      out = chacha20poly1305(__privateGet(this, _k), nonceBytes(__privateGet(this, _n)), ad).encrypt(plaintext);
    } catch {
      throw fail("AUTH");
    }
    __privateSet(this, _n, __privateGet(this, _n) + 1n);
    return out;
  }
  /** DecryptWithAd. A bad tag, a wrong or replayed message or a short input all give the same AUTH error and leave the nonce where it was. */
  decryptWithAd(ad, ciphertext) {
    if (__privateGet(this, _wiped)) throw fail("WIPED");
    if (!isBytes4(ad) || !isBytes4(ciphertext)) throw fail("ARG");
    if (ciphertext.length > MAX_NOISE_MESSAGE) throw fail("TOO_BIG");
    if (__privateGet(this, _k) === null) return new Uint8Array(ciphertext);
    if (__privateGet(this, _n) >= MAX_NONCE) throw fail("NONCE");
    if (ciphertext.length < TAG_LEN) throw fail("AUTH");
    let out;
    try {
      out = chacha20poly1305(__privateGet(this, _k), nonceBytes(__privateGet(this, _n)), ad).decrypt(ciphertext);
    } catch {
      throw fail("AUTH");
    }
    __privateSet(this, _n, __privateGet(this, _n) + 1n);
    return out;
  }
  /** Transport helper: EncryptWithAd with empty associated data. */
  encrypt(plaintext) {
    return this.encryptWithAd(EMPTY, plaintext);
  }
  /** Transport helper: DecryptWithAd with empty associated data. */
  decrypt(ciphertext) {
    return this.decryptWithAd(EMPTY, ciphertext);
  }
  /** Overwrites the key with zeros; every later call throws. */
  wipe() {
    if (__privateGet(this, _k)) wipe(__privateGet(this, _k));
    __privateSet(this, _k, null);
    __privateSet(this, _wiped, true);
  }
};
_k = new WeakMap();
_n = new WeakMap();
_wiped = new WeakMap();
var _SymmetricState_instances, setKey_fn;
var SymmetricState = class {
  constructor(protocolName) {
    __privateAdd(this, _SymmetricState_instances);
    __publicField(this, "ck");
    __publicField(this, "h");
    __publicField(this, "cs");
    const name = utf8.encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = new Uint8Array(this.h);
    this.cs = new CipherState();
  }
  hasKey() {
    return this.cs.hasKey();
  }
  mixKey(inputKeyMaterial) {
    const [ck, k] = noiseHkdf(this.ck, inputKeyMaterial, 2);
    wipe(this.ck);
    this.ck = ck;
    __privateMethod(this, _SymmetricState_instances, setKey_fn).call(this, k);
  }
  mixHash(data) {
    this.h = sha256(concat(this.h, data));
  }
  mixKeyAndHash(inputKeyMaterial) {
    const [ck, tempH, k] = noiseHkdf(this.ck, inputKeyMaterial, 3);
    wipe(this.ck);
    this.ck = ck;
    this.mixHash(tempH);
    wipe(tempH);
    __privateMethod(this, _SymmetricState_instances, setKey_fn).call(this, k);
  }
  encryptAndHash(plaintext) {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ciphertext) {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }
  /** Split(): returns [c1, c2] and clears the chaining key and the handshake cipher. */
  split() {
    const [k1, k2] = noiseHkdf(this.ck, EMPTY, 2);
    const c1 = new CipherState(k1);
    const c2 = new CipherState(k2);
    wipe(k1, k2);
    this.wipe();
    return [c1, c2];
  }
  /** Clears ck and the handshake cipher (h is not secret and is kept for the handshake hash). */
  wipe() {
    wipe(this.ck);
    this.cs.wipe();
  }
};
_SymmetricState_instances = new WeakSet();
setKey_fn = function(k) {
  this.cs.wipe();
  this.cs = new CipherState(k);
  wipe(k);
};
var PATTERNS = Object.freeze({
  IK: Object.freeze({ name: "IK", psk: false, messages: Object.freeze([["e", "es", "s", "ss"], ["e", "ee", "se"]]) }),
  IKpsk2: Object.freeze({ name: "IKpsk2", psk: true, messages: Object.freeze([["e", "es", "s", "ss"], ["e", "ee", "se", "psk"]]) })
});
var _pattern, _initiator, _random, _ss, _s, _sPub, _e, _rs, _re, _psk, _index, _dead, _done, _HandshakeState_instances, minLength_fn, guard_fn, dhToken_fn, clearKeys_fn;
var HandshakeState = class {
  constructor({ pattern, initiator, prologue: pro, staticPrivate, remoteStaticPublic, psk, random }) {
    __privateAdd(this, _HandshakeState_instances);
    __privateAdd(this, _pattern);
    __privateAdd(this, _initiator);
    __privateAdd(this, _random);
    __privateAdd(this, _ss);
    __privateAdd(this, _s);
    __privateAdd(this, _sPub);
    __privateAdd(this, _e, null);
    __privateAdd(this, _rs, null);
    __privateAdd(this, _re, null);
    __privateAdd(this, _psk, null);
    __privateAdd(this, _index, 0);
    __privateAdd(this, _dead, false);
    __privateAdd(this, _done, false);
    __publicField(this, "protocolName");
    __privateSet(this, _pattern, pattern);
    __privateSet(this, _initiator, initiator);
    __privateSet(this, _random, pickRandom(random));
    this.protocolName = "Noise_" + pattern.name + "_25519_ChaChaPoly_SHA256";
    const prologueBytes = copyBytes3(pro);
    __privateSet(this, _s, key32(staticPrivate));
    try {
      __privateSet(this, _sPub, publicOf(__privateGet(this, _s)));
      if (pattern.psk) __privateSet(this, _psk, key32(psk));
      if (initiator) __privateSet(this, _rs, key32(remoteStaticPublic));
      __privateSet(this, _ss, new SymmetricState(this.protocolName));
      __privateGet(this, _ss).mixHash(prologueBytes);
      __privateGet(this, _ss).mixHash(initiator ? __privateGet(this, _rs) : __privateGet(this, _sPub));
    } catch (err) {
      this.wipe();
      throw err;
    }
  }
  get remoteStatic() {
    return __privateGet(this, _rs) ? new Uint8Array(__privateGet(this, _rs)) : null;
  }
  get complete() {
    return __privateGet(this, _index) === __privateGet(this, _pattern).messages.length && !__privateGet(this, _dead);
  }
  get finished() {
    return __privateGet(this, _done);
  }
  writeMessage(payload) {
    __privateMethod(this, _HandshakeState_instances, guard_fn).call(this, true);
    const body = copyBytes3(payload);
    if (__privateMethod(this, _HandshakeState_instances, minLength_fn).call(this, __privateGet(this, _index)) + body.length > MAX_NOISE_MESSAGE) throw fail("TOO_BIG");
    try {
      const parts = [];
      for (const token of __privateGet(this, _pattern).messages[__privateGet(this, _index)]) {
        if (token === "e") {
          __privateSet(this, _e, freshKey(__privateGet(this, _random)));
          const ePub = publicOf(__privateGet(this, _e));
          parts.push(ePub);
          __privateGet(this, _ss).mixHash(ePub);
          if (__privateGet(this, _pattern).psk) __privateGet(this, _ss).mixKey(ePub);
        } else if (token === "s") {
          parts.push(__privateGet(this, _ss).encryptAndHash(__privateGet(this, _sPub)));
        } else if (token === "psk") {
          __privateGet(this, _ss).mixKeyAndHash(__privateGet(this, _psk));
        } else {
          __privateMethod(this, _HandshakeState_instances, dhToken_fn).call(this, token);
        }
      }
      parts.push(__privateGet(this, _ss).encryptAndHash(body));
      __privateSet(this, _index, __privateGet(this, _index) + 1);
      return concat(...parts);
    } catch (err) {
      this.wipe();
      throw err instanceof NoiseError && (err.code === "TOO_BIG" || err.code === "RANDOM") ? err : fail("HANDSHAKE");
    }
  }
  readMessage(message) {
    __privateMethod(this, _HandshakeState_instances, guard_fn).call(this, false);
    if (!isBytes4(message)) throw fail("ARG");
    try {
      if (message.length > MAX_NOISE_MESSAGE || message.length < __privateMethod(this, _HandshakeState_instances, minLength_fn).call(this, __privateGet(this, _index))) throw fail("HANDSHAKE");
      let off = 0;
      for (const token of __privateGet(this, _pattern).messages[__privateGet(this, _index)]) {
        if (token === "e") {
          __privateSet(this, _re, message.slice(off, off + DHLEN));
          off += DHLEN;
          __privateGet(this, _ss).mixHash(__privateGet(this, _re));
          if (__privateGet(this, _pattern).psk) __privateGet(this, _ss).mixKey(__privateGet(this, _re));
        } else if (token === "s") {
          const len = DHLEN + (__privateGet(this, _ss).hasKey() ? TAG_LEN : 0);
          __privateSet(this, _rs, __privateGet(this, _ss).decryptAndHash(message.slice(off, off + len)));
          off += len;
        } else if (token === "psk") {
          __privateGet(this, _ss).mixKeyAndHash(__privateGet(this, _psk));
        } else {
          __privateMethod(this, _HandshakeState_instances, dhToken_fn).call(this, token);
        }
      }
      const payload = __privateGet(this, _ss).decryptAndHash(message.slice(off));
      __privateSet(this, _index, __privateGet(this, _index) + 1);
      return payload;
    } catch {
      this.wipe();
      throw fail("HANDSHAKE");
    }
  }
  finish() {
    if (__privateGet(this, _dead) || __privateGet(this, _done)) throw fail("DEAD");
    if (__privateGet(this, _index) !== __privateGet(this, _pattern).messages.length) throw fail("STATE");
    const [c1, c2] = __privateGet(this, _ss).split();
    const handshakeHash = new Uint8Array(__privateGet(this, _ss).h);
    const remoteStatic = new Uint8Array(__privateGet(this, _rs));
    const send = __privateGet(this, _initiator) ? c1 : c2;
    const recv = __privateGet(this, _initiator) ? c2 : c1;
    __privateSet(this, _done, true);
    __privateMethod(this, _HandshakeState_instances, clearKeys_fn).call(this);
    return Object.freeze({
      send,
      recv,
      handshakeHash,
      remoteStatic,
      protocol: this.protocolName,
      wipe() {
        send.wipe();
        recv.wipe();
        wipe(handshakeHash);
      }
    });
  }
  /** Marks the handshake unusable and overwrites its secrets. Safe to call at any time and more than once. */
  wipe() {
    __privateSet(this, _dead, true);
    __privateMethod(this, _HandshakeState_instances, clearKeys_fn).call(this);
    if (__privateGet(this, _ss)) __privateGet(this, _ss).wipe();
  }
};
_pattern = new WeakMap();
_initiator = new WeakMap();
_random = new WeakMap();
_ss = new WeakMap();
_s = new WeakMap();
_sPub = new WeakMap();
_e = new WeakMap();
_rs = new WeakMap();
_re = new WeakMap();
_psk = new WeakMap();
_index = new WeakMap();
_dead = new WeakMap();
_done = new WeakMap();
_HandshakeState_instances = new WeakSet();
/** Exact byte length of message `index` with an empty payload (tokens only plus the payload tag), from the pattern alone. */
minLength_fn = function(index) {
  let n = 0;
  let keyed = __privateGet(this, _ss).hasKey();
  for (const t of __privateGet(this, _pattern).messages[index]) {
    if (t === "e") {
      n += DHLEN;
      if (__privateGet(this, _pattern).psk) keyed = true;
    } else if (t === "s") n += DHLEN + (keyed ? TAG_LEN : 0);
    else keyed = true;
  }
  return n + (keyed ? TAG_LEN : 0);
};
guard_fn = function(write) {
  if (__privateGet(this, _dead) || __privateGet(this, _done)) throw fail("DEAD");
  if (__privateGet(this, _index) >= __privateGet(this, _pattern).messages.length) throw fail("STATE");
  const myTurn = __privateGet(this, _initiator) ? __privateGet(this, _index) % 2 === 0 : __privateGet(this, _index) % 2 === 1;
  if (myTurn !== write) throw fail("STATE");
};
dhToken_fn = function(token) {
  const [a, b] = token;
  const local = __privateGet(this, _initiator) ? a === "e" ? __privateGet(this, _e) : __privateGet(this, _s) : b === "e" ? __privateGet(this, _e) : __privateGet(this, _s);
  const remote = __privateGet(this, _initiator) ? b === "e" ? __privateGet(this, _re) : __privateGet(this, _rs) : a === "e" ? __privateGet(this, _re) : __privateGet(this, _rs);
  const shared = dh(local, remote);
  __privateGet(this, _ss).mixKey(shared);
  wipe(shared);
};
clearKeys_fn = function() {
  wipe(__privateGet(this, _s), __privateGet(this, _e), __privateGet(this, _psk));
  __privateSet(this, _e, null);
};
function handshakeInitiator(options) {
  if (!options || typeof options !== "object") throw fail("ARG");
  const pattern = options.psk === void 0 || options.psk === null ? PATTERNS.IK : PATTERNS.IKpsk2;
  const hs = new HandshakeState({ ...options, pattern, initiator: true });
  return Object.freeze({
    get protocol() {
      return hs.protocolName;
    },
    get complete() {
      return hs.complete;
    },
    writeMessage1: (payload) => hs.writeMessage(payload),
    readMessage2: (message) => hs.readMessage(message),
    finish: () => hs.finish(),
    wipe: () => hs.wipe()
  });
}
function prologue(carrier, offerId) {
  if (!CARRIERS.includes(carrier)) throw fail("CARRIER");
  let id;
  if (offerId === void 0 || offerId === null) id = new Uint8Array(16);
  else if (typeof offerId === "string") id = hexToBytes3(offerId);
  else id = copyBytes3(offerId);
  if (id.length !== 16) throw fail("ARG");
  return concat(utf8.encode("plenum-remote/1"), Uint8Array.of(0), utf8.encode(carrier), Uint8Array.of(0), id);
}
var SAS_INFO = utf8.encode("plenum-sas");
var PUSH_INFO = utf8.encode("plenum-push");
var STOP_INFO = utf8.encode("plenum-stop");
var MAC1_LABEL = utf8.encode("plenum-mac1");
function checkedHash(h) {
  if (!isBytes4(h) || h.length !== HASHLEN) throw fail("ARG");
  return h;
}
function sas(handshakeHash) {
  const o = hkdf(sha256, checkedHash(handshakeHash), EMPTY, SAS_INFO, 4);
  const n = ((o[0] << 24 | o[1] << 16 | o[2] << 8 | o[3]) >>> 0) % 1e6;
  return String(n).padStart(6, "0");
}
function pushKey(handshakeHash) {
  return hkdf(sha256, checkedHash(handshakeHash), EMPTY, PUSH_INFO, 32);
}
function stopKey(handshakeHash) {
  return hkdf(sha256, checkedHash(handshakeHash), EMPTY, STOP_INFO, 32);
}
function mac1Key(desktopPublic) {
  return sha256(concat(MAC1_LABEL, key32(desktopPublic)));
}
function computeMac1(desktopPublic, body) {
  return hmac(sha256, mac1Key(desktopPublic), copyBytes3(body)).slice(0, MAC_LEN);
}
function computeMac2(cookie, bodyAndMac1) {
  if (cookie === void 0 || cookie === null) return new Uint8Array(MAC_LEN);
  if (!isBytes4(cookie) || cookie.length !== MAC_LEN) throw fail("ARG");
  return hmac(sha256, cookie, copyBytes3(bodyAndMac1)).slice(0, MAC_LEN);
}
function sealMessage1(desktopPublic, body, cookie) {
  const b = copyBytes3(body);
  if (b.length > MAX_NOISE_MESSAGE) throw fail("TOO_BIG");
  const mac1 = computeMac1(desktopPublic, b);
  const withMac1 = concat(b, mac1);
  return concat(withMac1, computeMac2(cookie, withMac1));
}
function parseCookieReply(bytes) {
  if (!isBytes4(bytes) || bytes.length !== 1 + MAC_LEN || bytes[0] !== COOKIE_TYPE) return null;
  return bytes.slice(1);
}

// lib/remote/frames.mjs
var TYPE = Object.freeze({
  HELLO: 1,
  REQ: 2,
  BODY: 3,
  RES: 4,
  DATA: 5,
  CANCEL: 6,
  STOP: 7,
  STOP_ACK: 8,
  PING: 9,
  PONG: 10,
  EVENT: 11,
  CLOSE: 12,
  COOKIE: 127
});
var FLAG = Object.freeze({ FIN: 1, PRIORITY: 2, COMPRESSED: 4 });
var HEADER_BYTES = 6;
var MAX_PLAINTEXT2 = 65519;
var CHUNK = 32768;
var BUFFER_CAP = 262144;
var COALESCE_MS = 30;
var COALESCE_BELOW = 1024;
var MAX_STREAMS = 32;
var PING_INTERVAL_MS = 25e3;
var PING_MISSES_TO_CLOSE = 2;
var POLL_MS = 10;
var { HELLO, REQ, BODY, RES, DATA, CANCEL, STOP, STOP_ACK, PING, PONG, EVENT, CLOSE, COOKIE } = TYPE;
var NAMES = new Map(Object.entries(TYPE).map(([name, code]) => [code, name]));
var PRIORITY_TYPES = /* @__PURE__ */ new Set([STOP, STOP_ACK, CANCEL, PING, PONG]);
var CONTROL_TYPES = /* @__PURE__ */ new Set([HELLO, STOP, STOP_ACK, PING, PONG, EVENT, CLOSE, COOKIE]);
var STREAM_TYPES = /* @__PURE__ */ new Set([REQ, BODY, RES, DATA, CANCEL]);
var JSON_TYPES = /* @__PURE__ */ new Set([HELLO, REQ, RES, STOP, STOP_ACK, EVENT, CLOSE]);
var FROM_PHONE = /* @__PURE__ */ new Set([REQ, BODY, STOP]);
var FROM_DESKTOP = /* @__PURE__ */ new Set([HELLO, RES, DATA, STOP_ACK, EVENT]);
var KNOWN_FLAGS = FLAG.FIN | FLAG.PRIORITY;
var EMPTY2 = new Uint8Array(0);
var utf8Encoder = new TextEncoder();
var utf8Decoder = new TextDecoder("utf-8", { fatal: true });
var FrameError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
};
var hex = (n) => `0x${n.toString(16).padStart(2, "0")}`;
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const tag = Object.prototype.toString.call(input);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return new Uint8Array(input);
  throw new TypeError("a frame must be bytes");
}
function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
function concatBytes3(parts, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
function checkShape(type, stream, flags, length) {
  if (!NAMES.has(type)) throw new FrameError("type", `unknown frame type ${hex(type)}`);
  if (!Number.isInteger(stream) || stream < 0 || stream > 4294967295) throw new FrameError("stream", "stream id out of range");
  if (flags & ~KNOWN_FLAGS) throw new FrameError("flags", `reserved flag bits ${hex(flags)} set`);
  if (CONTROL_TYPES.has(type) && stream !== 0) throw new FrameError("stream", `${NAMES.get(type)} belongs on stream 0`);
  if (STREAM_TYPES.has(type) && stream === 0) throw new FrameError("stream", `${NAMES.get(type)} needs a stream id`);
  if ((type === PING || type === PONG) && length !== 8) throw new FrameError("payload", `${NAMES.get(type)} carries an 8-byte nonce`);
  if ((type === BODY || type === DATA) && length > CHUNK) throw new FrameError("payload", `${NAMES.get(type)} payload over ${CHUNK} bytes`);
  if (HEADER_BYTES + length > MAX_PLAINTEXT2) throw new FrameError("size", "frame over max_plaintext");
}
function parseObject(bytes) {
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    throw new FrameError("json", "payload is not UTF-8 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new FrameError("json", "payload is not a JSON object");
  return value;
}
function jsonBytes(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new FrameError("json", "JSON payload must be an object");
  return utf8Encoder.encode(JSON.stringify(value));
}
function encodeFrame(type, stream = 0, flags = 0, payload) {
  const body = payload == null ? EMPTY2 : toBytes(payload);
  checkShape(type, stream, flags, body.byteLength);
  const out = new Uint8Array(HEADER_BYTES + body.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream, false);
  out[5] = flags | (PRIORITY_TYPES.has(type) ? FLAG.PRIORITY : 0);
  out.set(body, HEADER_BYTES);
  return out;
}
function encodeJsonFrame(type, stream, flags, value) {
  if (!JSON_TYPES.has(type)) throw new FrameError("type", `${NAMES.get(type) ?? hex(type)} does not carry JSON`);
  return encodeFrame(type, stream, flags, jsonBytes(value));
}
function decodeFrame(input) {
  const bytes = toBytes(input);
  if (bytes.byteLength < HEADER_BYTES) throw new FrameError("short", "frame is shorter than its header");
  const type = bytes[0];
  const stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  const flags = bytes[5];
  const payload = bytes.subarray(HEADER_BYTES);
  checkShape(type, stream, flags, payload.byteLength);
  const value = JSON_TYPES.has(type) ? parseObject(payload) : void 0;
  return { type, stream, flags, payload, value };
}
function systemClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle)
  };
}
function randomNonce() {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}
var StreamTable = class {
  constructor({ localBit, max = MAX_STREAMS }) {
    this.localBit = localBit ? 1 : 0;
    this.max = max;
    this.entries = /* @__PURE__ */ new Map();
    this.nextLocal = this.localBit ? 1 : 2;
    this.lastRemote = 0;
  }
  get size() {
    return this.entries.size;
  }
  isLocal(id) {
    return (id & 1) === this.localBit;
  }
  get(id) {
    return this.entries.get(id);
  }
  // Opens a stream on this side. Returns its entry, or null when the table already holds max open streams.
  allocate() {
    if (this.entries.size >= this.max || this.nextLocal > 4294967294) return null;
    const id = this.nextLocal;
    this.nextLocal += 2;
    this.entries.set(id, { id, opener: "local", localFin: false, remoteFin: false, aborted: false });
    return this.entries.get(id);
  }
  // Admits a stream the other side opened. It must carry the other side's parity and a larger id than any before it.
  admitRemote(id) {
    if (this.isLocal(id)) throw new FrameError("parity", `stream ${id} has this side's parity`);
    if (id <= this.lastRemote) throw new FrameError("order", `stream ${id} is not a new stream`);
    if (this.entries.size >= this.max) throw new FrameError("cap", `more than ${this.max} open streams`);
    this.lastRemote = id;
    this.entries.set(id, { id, opener: "remote", localFin: false, remoteFin: false, aborted: false });
    return this.entries.get(id);
  }
  delete(id) {
    this.entries.delete(id);
  }
  // True for an id this table once held and has retired. A frame for such an id crossed a CANCEL or a last FIN.
  isStale(id) {
    return this.isLocal(id) ? id < this.nextLocal : id <= this.lastRemote;
  }
};
var _FrameSession_instances, dispatch_fn, onOpen_fn, onStreamFrame_fn, onCancel_fn, onPong_fn, onPeerClose_fn, protocol_fn, sendClose_fn, shutdown_fn, stopLiveness_fn, tick_fn, buffered_fn, write_fn, sendPriority_fn, enqueue_fn, pump_fn, schedulePoll_fn, writable_fn, sendStreamBytes_fn, chunk_fn, flushCoalesce_fn, dropStream_fn, abort_fn, release_fn;
var FrameSession = class {
  constructor(options = {}) {
    __privateAdd(this, _FrameSession_instances);
    const { role } = options;
    if (role !== "phone" && role !== "desktop") throw new TypeError("role must be 'phone' or 'desktop'");
    if (!options.transport || typeof options.transport.send !== "function" || typeof options.transport.close !== "function") {
      throw new TypeError("transport needs send(bytes) and close(code, reason)");
    }
    this.role = role;
    this.transport = options.transport;
    this.bufferedFn = typeof options.bufferedAmount === "function" ? options.bufferedAmount : null;
    this.clock = options.clock ?? systemClock();
    this.handlers = options.handlers ?? {};
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.nonce = options.nonce ?? randomNonce;
    this.streams = new StreamTable({ localBit: role === "phone" ? 1 : 0, max: options.maxStreams ?? MAX_STREAMS });
    this.lanes = /* @__PURE__ */ new Map();
    this.ready = [];
    this.coalesce = /* @__PURE__ */ new Map();
    this.pollTimer = null;
    this.live = { intervalMs: 0, limit: 0, outstanding: null, misses: 0, timer: null };
    this.closed = false;
    this.closeReason = null;
    this.counts = { written: 0, dropped: 0 };
  }
  get isClosed() {
    return this.closed;
  }
  get openStreams() {
    return this.streams.size;
  }
  // Takes one transport message in. Returns false once the session is closed.
  receive(input) {
    if (this.closed) return false;
    let frame;
    try {
      frame = decodeFrame(input);
    } catch (err) {
      __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, err.message);
      return false;
    }
    __privateMethod(this, _FrameSession_instances, dispatch_fn).call(this, frame);
    return !this.closed;
  }
  // Phone: opens a stream with a REQ frame. Returns the stream id, or null at the stream cap or when closed.
  // { fin: true } marks a request without a body, so the REQ carries the FIN.
  request(value, { fin = false } = {}) {
    if (this.role !== "phone") throw new TypeError("only the phone opens streams (REQ)");
    if (this.closed) return null;
    const payload = jsonBytes(value);
    const entry = this.streams.allocate();
    if (!entry) return null;
    if (fin) entry.localFin = true;
    __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, entry.id, REQ, fin ? FLAG.FIN : 0, payload);
    __privateMethod(this, _FrameSession_instances, release_fn).call(this, entry.id);
    return entry.id;
  }
  // Desktop: answers a stream the phone opened, with a RES frame.
  respond(id, value, { fin = false } = {}) {
    if (this.role !== "desktop") throw new TypeError("only the desktop answers (RES)");
    const entry = __privateMethod(this, _FrameSession_instances, writable_fn).call(this, id);
    if (!entry) return false;
    const payload = jsonBytes(value);
    if (fin) entry.localFin = true;
    __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, id, RES, fin ? FLAG.FIN : 0, payload);
    __privateMethod(this, _FrameSession_instances, release_fn).call(this, id);
    return true;
  }
  // Phone: request body bytes, cut into BODY frames of at most CHUNK bytes. { fin: true } ends the body.
  body(id, bytes, { fin = false } = {}) {
    if (this.role !== "phone") throw new TypeError("only the phone sends BODY");
    return __privateMethod(this, _FrameSession_instances, sendStreamBytes_fn).call(this, BODY, id, bytes, fin);
  }
  // Desktop: response bytes, cut into DATA frames. Small chunks are coalesced for up to COALESCE_MS.
  data(id, bytes, { fin = false } = {}) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends DATA");
    const entry = __privateMethod(this, _FrameSession_instances, writable_fn).call(this, id);
    if (!entry) return false;
    const view = toBytes(bytes);
    if (fin) entry.localFin = true;
    if (view.byteLength === 0 && !fin) return true;
    if (view.byteLength >= COALESCE_BELOW) {
      __privateMethod(this, _FrameSession_instances, flushCoalesce_fn).call(this, id);
      __privateMethod(this, _FrameSession_instances, chunk_fn).call(this, DATA, id, view, fin);
    } else {
      let pending = this.coalesce.get(id);
      if (!pending) {
        pending = { parts: [], bytes: 0, fin: false, timer: null };
        this.coalesce.set(id, pending);
      }
      pending.parts.push(view.slice());
      pending.bytes += view.byteLength;
      pending.fin = pending.fin || fin;
      if (pending.fin || pending.bytes >= COALESCE_BELOW) __privateMethod(this, _FrameSession_instances, flushCoalesce_fn).call(this, id);
      else if (pending.timer === null) pending.timer = this.clock.setTimeout(() => __privateMethod(this, _FrameSession_instances, flushCoalesce_fn).call(this, id), this.coalesceMs);
    }
    __privateMethod(this, _FrameSession_instances, release_fn).call(this, id);
    return true;
  }
  // Either side: aborts a stream. Queued frames of the stream are dropped, a CANCEL goes out at once, and the abort
  // hook runs once. Returns false when the stream is not open here.
  cancel(id) {
    if (this.closed) return false;
    return __privateMethod(this, _FrameSession_instances, abort_fn).call(this, id, "local");
  }
  // Desktop: HELLO on stream 0, paced like other non-priority frames.
  hello(value) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends HELLO");
    if (this.closed) return false;
    __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, 0, HELLO, 0, jsonBytes(value));
    return true;
  }
  // Desktop: EVENT on stream 0, paced like other non-priority frames.
  event(value) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends EVENT");
    if (this.closed) return false;
    __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, 0, EVENT, 0, jsonBytes(value));
    return true;
  }
  // Phone: STOP on the priority lane.
  stop(value) {
    if (this.role !== "phone") throw new TypeError("only the phone sends STOP");
    if (this.closed) return false;
    return __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, STOP, 0, jsonBytes(value));
  }
  // Desktop: STOP_ACK on the priority lane.
  stopAck(value) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends STOP_ACK");
    if (this.closed) return false;
    return __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, STOP_ACK, 0, jsonBytes(value));
  }
  // PING on the priority lane. The nonce is remembered until its PONG arrives.
  ping() {
    if (this.closed) return false;
    const nonce = this.nonce();
    this.live.outstanding = nonce;
    return __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, PING, 0, nonce);
  }
  startLiveness({ intervalMs = PING_INTERVAL_MS, misses = PING_MISSES_TO_CLOSE } = {}) {
    if (this.closed) return false;
    __privateMethod(this, _FrameSession_instances, stopLiveness_fn).call(this);
    this.live.intervalMs = intervalMs;
    this.live.limit = misses;
    this.live.misses = 0;
    this.live.outstanding = null;
    this.live.timer = this.clock.setInterval(() => __privateMethod(this, _FrameSession_instances, tick_fn).call(this), intervalMs);
    __privateMethod(this, _FrameSession_instances, tick_fn).call(this, true);
    return true;
  }
  stopLiveness() {
    __privateMethod(this, _FrameSession_instances, stopLiveness_fn).call(this);
  }
  // Sends CLOSE { reason } on the control stream, then closes the transport. Queued frames are dropped.
  close(reason = "normal") {
    if (this.closed) return;
    __privateMethod(this, _FrameSession_instances, sendClose_fn).call(this, String(reason));
    __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, String(reason));
  }
};
_FrameSession_instances = new WeakSet();
dispatch_fn = function({ type, stream, flags, payload, value }) {
  if (this.role === "phone" && FROM_PHONE.has(type) || this.role === "desktop" && FROM_DESKTOP.has(type)) {
    return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `${NAMES.get(type)} is not sent to the ${this.role}`);
  }
  const fin = (flags & FLAG.FIN) !== 0;
  switch (type) {
    case REQ:
      return __privateMethod(this, _FrameSession_instances, onOpen_fn).call(this, stream, value, fin);
    case BODY:
    case RES:
    case DATA:
      return __privateMethod(this, _FrameSession_instances, onStreamFrame_fn).call(this, type, stream, payload, fin, value);
    case CANCEL:
      return __privateMethod(this, _FrameSession_instances, onCancel_fn).call(this, stream);
    case HELLO:
      return void this.handlers.hello?.(value);
    case EVENT:
      return void this.handlers.event?.(value);
    case STOP:
      return void this.handlers.stop?.(value);
    case STOP_ACK:
      return void this.handlers.stopAck?.(value);
    case PING:
      return void __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, PONG, 0, payload);
    case PONG:
      return __privateMethod(this, _FrameSession_instances, onPong_fn).call(this, payload);
    case CLOSE:
      return __privateMethod(this, _FrameSession_instances, onPeerClose_fn).call(this, value);
    default:
      return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `${NAMES.get(type)} is not valid inside a session`);
  }
};
onOpen_fn = function(stream, value, fin) {
  let entry;
  try {
    entry = this.streams.admitRemote(stream);
  } catch (err) {
    return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, err.message);
  }
  if (fin) entry.remoteFin = true;
  this.handlers.req?.(stream, value, fin);
  __privateMethod(this, _FrameSession_instances, release_fn).call(this, stream);
};
onStreamFrame_fn = function(type, stream, payload, fin, value) {
  const entry = this.streams.get(stream);
  if (!entry) {
    if (this.streams.isStale(stream)) return;
    return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `${NAMES.get(type)} on stream ${stream} that was never opened`);
  }
  if (entry.remoteFin) return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `${NAMES.get(type)} after FIN on stream ${stream}`);
  if (fin) entry.remoteFin = true;
  if (type === BODY) this.handlers.body?.(stream, payload, fin);
  else if (type === DATA) this.handlers.data?.(stream, payload, fin);
  else this.handlers.res?.(stream, value, fin);
  __privateMethod(this, _FrameSession_instances, release_fn).call(this, stream);
};
onCancel_fn = function(stream) {
  if (!this.streams.get(stream)) {
    if (this.streams.isStale(stream)) return;
    return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `CANCEL on stream ${stream} that was never opened`);
  }
  __privateMethod(this, _FrameSession_instances, abort_fn).call(this, stream, "remote");
};
onPong_fn = function(payload) {
  const outstanding = this.live.outstanding;
  if (outstanding && bytesEqual(outstanding, payload)) {
    this.live.outstanding = null;
    this.live.misses = 0;
  }
};
onPeerClose_fn = function(value) {
  this.handlers.close?.(value);
  const reason = typeof value?.reason === "string" ? value.reason.slice(0, 64) : "peer";
  __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, reason);
};
protocol_fn = function(message) {
  if (this.closed) return;
  this.handlers.protocolError?.(message);
  __privateMethod(this, _FrameSession_instances, sendClose_fn).call(this, "protocol");
  __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, "protocol");
};
sendClose_fn = function(reason) {
  try {
    this.transport.send(encodeJsonFrame(CLOSE, 0, 0, { reason }));
  } catch {
  }
};
shutdown_fn = function(reason) {
  if (this.closed) return;
  this.closed = true;
  this.closeReason = reason;
  if (this.pollTimer !== null) {
    this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
  for (const pending of this.coalesce.values()) {
    if (pending.timer !== null) this.clock.clearTimeout(pending.timer);
  }
  this.coalesce.clear();
  __privateMethod(this, _FrameSession_instances, stopLiveness_fn).call(this);
  this.lanes.clear();
  this.ready = [];
  try {
    this.transport.close(reason === "protocol" ? 1002 : 1e3, reason);
  } catch {
  }
  this.handlers.closed?.(reason);
};
stopLiveness_fn = function() {
  if (this.live.timer !== null) {
    this.clock.clearInterval(this.live.timer);
    this.live.timer = null;
  }
};
tick_fn = function(first = false) {
  if (this.closed) return;
  if (!first && this.live.outstanding !== null) {
    this.live.misses += 1;
    if (this.live.misses >= this.live.limit) {
      __privateMethod(this, _FrameSession_instances, sendClose_fn).call(this, "timeout");
      __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, "timeout");
      return;
    }
  }
  this.ping();
};
buffered_fn = function() {
  if (this.bufferedFn) return Number(this.bufferedFn()) || 0;
  return Number(this.transport.bufferedAmount) || 0;
};
write_fn = function(type, stream, flags, payload) {
  const bytes = encodeFrame(type, stream, flags, payload);
  try {
    this.transport.send(bytes);
  } catch {
    __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, "transport");
    return false;
  }
  this.counts.written += 1;
  return true;
};
sendPriority_fn = function(type, stream, payload) {
  if (this.closed) return false;
  return __privateMethod(this, _FrameSession_instances, write_fn).call(this, type, stream, 0, payload);
};
enqueue_fn = function(stream, type, flags, payload) {
  checkShape(type, stream, flags, payload.byteLength);
  let lane = this.lanes.get(stream);
  if (!lane) {
    lane = { id: stream, frames: [], head: 0 };
    this.lanes.set(stream, lane);
  }
  lane.frames.push({ type, flags, payload });
  if (!this.ready.includes(lane)) this.ready.push(lane);
  __privateMethod(this, _FrameSession_instances, pump_fn).call(this);
};
// Writes queued frames round robin while the socket's buffer is under the cap. When it is not, retries on a timer.
pump_fn = function() {
  while (!this.closed && this.ready.length > 0) {
    if (__privateMethod(this, _FrameSession_instances, buffered_fn).call(this) >= BUFFER_CAP) {
      __privateMethod(this, _FrameSession_instances, schedulePoll_fn).call(this);
      return;
    }
    const lane = this.ready.shift();
    const frame = lane.frames[lane.head];
    lane.frames[lane.head] = void 0;
    lane.head += 1;
    if (lane.head < lane.frames.length) {
      this.ready.push(lane);
    } else {
      lane.frames = [];
      lane.head = 0;
      if (this.lanes.get(lane.id) === lane) this.lanes.delete(lane.id);
    }
    __privateMethod(this, _FrameSession_instances, write_fn).call(this, frame.type, lane.id, frame.flags, frame.payload);
  }
};
schedulePoll_fn = function() {
  if (this.pollTimer !== null) return;
  this.pollTimer = this.clock.setTimeout(() => {
    this.pollTimer = null;
    __privateMethod(this, _FrameSession_instances, pump_fn).call(this);
  }, this.pollMs);
};
writable_fn = function(id) {
  if (this.closed) return null;
  const entry = this.streams.get(id);
  if (!entry || entry.localFin || entry.aborted) return null;
  return entry;
};
sendStreamBytes_fn = function(type, id, bytes, fin) {
  const entry = __privateMethod(this, _FrameSession_instances, writable_fn).call(this, id);
  if (!entry) return false;
  const data = toBytes(bytes);
  if (fin) entry.localFin = true;
  __privateMethod(this, _FrameSession_instances, chunk_fn).call(this, type, id, data, fin);
  __privateMethod(this, _FrameSession_instances, release_fn).call(this, id);
  return true;
};
chunk_fn = function(type, id, data, fin) {
  if (data.byteLength === 0) {
    __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, id, type, fin ? FLAG.FIN : 0, EMPTY2);
    return;
  }
  for (let offset = 0; offset < data.byteLength; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, data.byteLength);
    const last = end === data.byteLength;
    __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, id, type, fin && last ? FLAG.FIN : 0, data.subarray(offset, end));
    if (this.closed) return;
  }
};
flushCoalesce_fn = function(id) {
  const pending = this.coalesce.get(id);
  if (!pending) return;
  this.coalesce.delete(id);
  if (pending.timer !== null) this.clock.clearTimeout(pending.timer);
  __privateMethod(this, _FrameSession_instances, chunk_fn).call(this, DATA, id, concatBytes3(pending.parts, pending.bytes), pending.fin);
};
dropStream_fn = function(id) {
  const lane = this.lanes.get(id);
  if (lane) {
    this.counts.dropped += lane.frames.length - lane.head;
    this.lanes.delete(id);
    this.ready = this.ready.filter((item) => item !== lane);
  }
  const pending = this.coalesce.get(id);
  if (pending) {
    if (pending.timer !== null) this.clock.clearTimeout(pending.timer);
    this.coalesce.delete(id);
  }
};
abort_fn = function(id, origin) {
  const entry = this.streams.get(id);
  if (!entry || entry.aborted) return false;
  entry.aborted = true;
  __privateMethod(this, _FrameSession_instances, dropStream_fn).call(this, id);
  this.streams.delete(id);
  if (origin === "local") __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, CANCEL, id, EMPTY2);
  this.handlers.abort?.(id, origin);
  return true;
};
release_fn = function(id) {
  const entry = this.streams.get(id);
  if (entry && entry.localFin && entry.remoteFin) this.streams.delete(id);
};

// lib/remote/stop-only.mjs
var STOP_ONLY_TYPE = 126;
var STOP_ACK_TYPE = 125;
var STOP_ONLY_VERSION = 1;
var STOP_ONLY_LEN = 90;
var STOP_ACK_LEN = 66;
var PAD_INFO = new TextEncoder().encode("plenum-stop-ack");
var COUNT_KEYS = ["cancelled", "drivesStopped", "agentsStopped", "cardsDenied"];
var HEX64 = /^[0-9a-f]{64}$/;
var HEX32 = /^[0-9a-f]{32}$/;
function hexToBytes4(hex2) {
  const out = new Uint8Array(hex2.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex2.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function key322(k) {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new TypeError("stop key length");
  return k;
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function idBytes(stopId) {
  const b = typeof stopId === "string" ? HEX32.test(stopId) ? hexToBytes4(stopId) : null : stopId;
  if (!(b instanceof Uint8Array) || b.length !== 16) throw new TypeError("stop id");
  return b;
}
function padFor(stopKey2, idB) {
  const msg = new Uint8Array(PAD_INFO.length + 16);
  msg.set(PAD_INFO);
  msg.set(idB, PAD_INFO.length);
  return hmac(sha256, stopKey2, msg).subarray(0, 16);
}
function encodeStopOnly({ stopKey: stopKey2, deviceId: deviceId2, counter, stopId }) {
  key322(stopKey2);
  if (!HEX64.test(String(deviceId2))) throw new TypeError("device id");
  if (!Number.isSafeInteger(counter) || counter < 1) throw new TypeError("counter");
  const out = new Uint8Array(STOP_ONLY_LEN);
  out[0] = STOP_ONLY_TYPE;
  out[1] = STOP_ONLY_VERSION;
  out.set(hexToBytes4(deviceId2), 2);
  const view = new DataView(out.buffer);
  view.setUint32(34, Math.floor(counter / 2 ** 32));
  view.setUint32(38, counter >>> 0);
  out.set(idBytes(stopId), 42);
  out.set(hmac(sha256, stopKey2, out.subarray(0, 58)), 58);
  return out;
}
function decodeStopAck(stopKey2, bytes, stopId) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== STOP_ACK_LEN || bytes[0] !== STOP_ACK_TYPE || bytes[1] !== STOP_ONLY_VERSION) return null;
  if (!(stopKey2 instanceof Uint8Array) || stopKey2.length !== 32) return null;
  const idB = idBytes(stopId);
  if (!equal(bytes.subarray(2, 18), idB)) return null;
  if (!equal(hmac(sha256, stopKey2, bytes.subarray(0, 34)), bytes.subarray(34, 66))) return null;
  const plain = bytes.slice(18, 34);
  const pad = padFor(stopKey2, idB);
  for (let i = 0; i < 16; i++) plain[i] ^= pad[i];
  const view = new DataView(plain.buffer);
  const out = {};
  COUNT_KEYS.forEach((k, i) => {
    out[k] = view.getUint32(i * 4);
  });
  return out;
}

// mobile/shell/carriers.js
var CARRIER_KINDS = Object.freeze(["lan", "tailscale", "relay"]);
var MAX_URLS_PER_KIND = 4;
var MAX_URL_LENGTH = 512;
function ipv4Of(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}
function isLoopback(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const v4 = ipv4Of(hostname);
  return v4 !== null && v4[0] === 127;
}
function isPrivateV4([a, b]) {
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127;
}
function isPrivateV6(hostname) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const first = hostname.slice(1, -1).split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const value = parseInt(first, 16);
  return value >= 64512 && value <= 65023 || value >= 65152 && value <= 65215;
}
function carrierUrlOk(kind, url) {
  if (!CARRIER_KINDS.includes(kind) || typeof url !== "string" || url.length > MAX_URL_LENGTH) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname;
  if (isLoopback(host)) return true;
  if (kind === "relay") return parsed.protocol === "wss:";
  if (kind === "tailscale") return parsed.protocol === "wss:" && host.endsWith(".ts.net");
  const v4 = ipv4Of(host);
  if (v4) return isPrivateV4(v4);
  return isPrivateV6(host) || host.endsWith(".local");
}
function usableCarriers(carriers) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of Array.isArray(carriers) ? carriers : []) {
    if (!entry || typeof entry !== "object" || !CARRIER_KINDS.includes(entry.kind) || seen.has(entry.kind)) continue;
    seen.add(entry.kind);
    const listed = Array.isArray(entry.urls) ? entry.urls : entry.url ? [entry.url] : [];
    const urls = listed.filter((url) => carrierUrlOk(entry.kind, url)).slice(0, MAX_URLS_PER_KIND);
    if (urls.length) out.push({ kind: entry.kind, urls });
  }
  return out;
}

// mobile/shell/channel.worker.js
var PROTOCOL = "1.0";
var DELAYS_MS = Object.freeze([1e3, 2e3, 4e3, 8e3]);
var RETRY_CAP_MS = 1e4;
var OFFLINE_ROUNDS = 3;
var CONNECT_TIMEOUT_MS = 6e3;
var HANDSHAKE_TIMEOUT_MS = 6e3;
var COUNTER_TIMEOUT_MS = 1e4;
var STOP_WINDOW_MS = 6e4;
var STOP_RESEND_MS = 8e3;
var RENEW_AFTER_MS = 36e5;
var RENEW_AFTER_MESSAGES = 1048576;
var RENEW_CHECK_MS = 6e4;
var RENEW_DRAIN_MS = 6e4;
var NOT_KNOWN_ROUNDS = 3;
var NOT_KNOWN_RETRY_MS = 6e4;
var PING_INTERVAL_MS2 = 25e3;
var PING_MISSES = 2;
var DEFAULT_CAPS = Object.freeze(["ui-from-desktop", "artifacts-iframe", "push-none", "share", "save"]);
var CARRIERS2 = Object.freeze(["lan", "tailscale", "relay"]);
var STOP_ONLY_WAIT_MS = 6e3;
var MAX_SOCKET_MESSAGE = 65535 + 64;
var PAGE_HEADERS = Object.freeze(["accept", "content-type", "x-plenum-client-id"]);
var SHELL_HEADERS = Object.freeze([...PAGE_HEADERS, "x-plenum-notify-line"]);
var SHELL_BRIDGE_PATHS = Object.freeze(["/_bridge/log", "/_bridge/ui-manifest"]);
var TERMINAL = Object.freeze(["revoked", "update-app", "update-desktop", "closed"]);
var utf82 = new TextEncoder();
var utf8Decode = new TextDecoder();
function b64uToBytes(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function defaultRandom2(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
function asKey(value) {
  const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : null;
  if (!bytes || bytes.byteLength !== 32) throw new TypeError("key length");
  return new Uint8Array(bytes);
}
var CLOSE_CODE_FAILURES = Object.freeze({ 4400: "replay", 4401: "unknown", 4429: "rate" });
var CODED_FAILURES = Object.freeze(["unknown", "replay", "rate"]);
function closeCodeError(err, sock) {
  const name = CLOSE_CODE_FAILURES[sock.closed?.code];
  if (!name) return err;
  const coded = new Error("closed");
  coded.code = name;
  return coded;
}
function failureName(err) {
  if (CODED_FAILURES.includes(err?.code)) return err.code;
  if (err instanceof NoiseError) return "handshake";
  const text = String(err?.message ?? err ?? "");
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/closed|close/i.test(text)) return "closed";
  if (/counter/i.test(text)) return "counter";
  return "error";
}
function openSocket(WebSocketImpl, url, { clock, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let openTimer = null;
    let ws = null;
    let closeInfo = null;
    let handler = null;
    let onCloseFn = null;
    let waiter = null;
    const queue = [];
    const fail2 = (err) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(openTimer);
      reject(err);
    };
    const sock = {
      get bufferedAmount() {
        return ws?.bufferedAmount ?? 0;
      },
      get closed() {
        return closeInfo;
      },
      send(bytes) {
        ws.send(bytes);
      },
      close(code, reason) {
        try {
          ws?.close(code, reason);
        } catch {
        }
      },
      set onMessage(fn) {
        handler = fn;
        while (handler && queue.length) handler(queue.shift());
      },
      set onClose(fn) {
        onCloseFn = fn;
        if (closeInfo) fn(closeInfo);
      },
      next(ms = HANDSHAKE_TIMEOUT_MS) {
        if (queue.length) return Promise.resolve(queue.shift());
        if (closeInfo) return Promise.reject(new Error("closed"));
        return new Promise((res, rej) => {
          const t = clock.setTimeout(() => {
            waiter = null;
            rej(new Error("timeout"));
          }, ms);
          waiter = {
            resolve: (value) => {
              clock.clearTimeout(t);
              res(value);
            },
            reject: (err) => {
              clock.clearTimeout(t);
              rej(err);
            }
          };
        });
      }
    };
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      fail2(err);
      return;
    }
    ws.binaryType = "arraybuffer";
    openTimer = clock.setTimeout(() => {
      fail2(new Error("connect timeout"));
      try {
        ws.close();
      } catch {
      }
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(openTimer);
      resolve(sock);
    });
    ws.addEventListener("message", (event) => {
      const size = event.data?.byteLength ?? 0;
      if (size > MAX_SOCKET_MESSAGE) {
        try {
          ws.close(1009, "too-big");
        } catch {
        }
        return;
      }
      const bytes = new Uint8Array(event.data);
      if (handler) handler(bytes);
      else if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve(bytes);
      } else queue.push(bytes);
    });
    ws.addEventListener("close", (event) => {
      closeInfo = { code: event.code, reason: event.reason ?? "" };
      if (!settled) fail2(new Error("closed before open"));
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(new Error("closed"));
      }
      onCloseFn?.(closeInfo);
    });
    ws.addEventListener("error", () => {
    });
  });
}
function requestPolicy(msg) {
  const scope = msg?.scope === "shell" ? "shell" : "page";
  const path = String(msg?.path || "/");
  let pathname;
  try {
    if (!path.startsWith("/") || path.includes("\\")) return null;
    const probe = new URL(path, "https://x");
    if (probe.origin !== "https://x") return null;
    const rawPath = decodeURIComponent(path.split(/[?#]/, 1)[0]);
    if (rawPath.includes("\\") || rawPath.split("/").includes("..")) return null;
    pathname = decodeURIComponent(probe.pathname);
  } catch {
    return null;
  }
  if (pathname.toLowerCase().startsWith("/_bridge/") && !(scope === "shell" && SHELL_BRIDGE_PATHS.includes(pathname))) return null;
  const allowed = scope === "shell" ? SHELL_HEADERS : PAGE_HEADERS;
  const headers = {};
  if (msg?.headers && typeof msg.headers === "object") {
    for (const [key, value] of Object.entries(msg.headers)) {
      const name = String(key).toLowerCase();
      if (allowed.includes(name)) headers[name] = String(value);
    }
  }
  return { path, headers };
}
function createChannelCore(options = {}) {
  const post = options.post;
  if (typeof post !== "function") throw new TypeError("createChannelCore needs post(message, transfer)");
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const clock = options.clock ?? systemClock();
  const random = options.random ?? defaultRandom2;
  let computer = null;
  let phase = "idle";
  let session = null;
  let desktopName = "";
  let lastSeen = null;
  let since = clock.now();
  let failedRounds = 0;
  let retryTimer = null;
  let nextRetryAt = null;
  let attempting = false;
  let renewTimer = null;
  let lastFailure = null;
  let closedByPage = false;
  let pairing = null;
  let ridSeq = 0;
  const rids = /* @__PURE__ */ new Map();
  const pendingStops = /* @__PURE__ */ new Map();
  const draining = /* @__PURE__ */ new Set();
  let unknownRounds = 0;
  const transition = (next) => {
    if (next !== phase) {
      phase = next;
      since = clock.now();
    }
  };
  const snapshot = () => ({
    status: phase,
    carrier: session?.carrier ?? null,
    desktopName,
    lastSeen,
    since,
    nextRetryAt,
    failedRounds,
    failure: lastFailure,
    computerId: computer?.id ?? null,
    stopsPending: pendingStops.size
  });
  const emitState = () => post({ op: "state", state: snapshot() });
  function counterRequest(id, minimum) {
    return new Promise((resolve, reject) => {
      const rid = ++ridSeq;
      const timer = clock.setTimeout(() => {
        rids.delete(rid);
        reject(new Error("counter not saved"));
      }, COUNTER_TIMEOUT_MS);
      rids.set(rid, {
        resolve: (value) => {
          clock.clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clock.clearTimeout(timer);
          reject(err);
        }
      });
      post({ op: "counter", rid, id, minimum });
    });
  }
  async function raiseCounter(id, current) {
    const answer = await counterRequest(id, current + 1);
    if (!answer || answer.ok !== true || !Number.isSafeInteger(answer.counter) || answer.counter <= current) {
      throw new Error("counter not saved");
    }
    return answer.counter;
  }
  async function handshake(kind, url, opts) {
    const sock = await openSocket(WebSocketImpl, url, { clock });
    try {
      const payload = await opts.payloadFor();
      const hs = handshakeInitiator({
        staticPrivate: opts.myPriv,
        remoteStaticPublic: opts.remotePub,
        prologue: prologue(kind, opts.offer ?? null),
        ...opts.psk ? { psk: opts.psk } : {}
      });
      const body = hs.writeMessage1(utf82.encode(JSON.stringify(payload)));
      sock.send(sealMessage1(opts.remotePub, body));
      let reply = await sock.next(HANDSHAKE_TIMEOUT_MS);
      const cookie = parseCookieReply(reply);
      if (cookie) {
        sock.send(sealMessage1(opts.remotePub, body, cookie));
        reply = await sock.next(HANDSHAKE_TIMEOUT_MS);
      }
      const message2 = hs.readMessage2(reply);
      const cs = hs.finish();
      return { sock, cs, message2 };
    } catch (err) {
      sock.close(1e3, "handshake");
      throw closeCodeError(err, sock);
    }
  }
  function makeSession({ sock, cs, kind, url }) {
    const s = {
      kind,
      url,
      carrier: kind,
      sock,
      cs,
      frames: null,
      sidOf: /* @__PURE__ */ new Map(),
      streamOf: /* @__PURE__ */ new Map(),
      messages: 0,
      startedAt: clock.now(),
      closed: false,
      retired: false,
      drainTimer: null,
      hello: null
    };
    s.frames = new FrameSession({
      role: "phone",
      clock,
      transport: {
        send: (bytes) => {
          s.messages += 1;
          try {
            sock.send(cs.send.encrypt(bytes));
          } catch {
          }
        },
        close: (code, reason) => sock.close(code, reason)
      },
      bufferedAmount: () => sock.bufferedAmount,
      handlers: {
        hello: (value) => onSessionHello(s, value),
        res: (id, value, fin) => onRes(s, id, value, fin),
        data: (id, bytes, fin) => onData(s, id, bytes, fin),
        event: (value) => onEvent(s, value),
        stopAck: (value) => onStopAck(value),
        close: (value) => onPeerClose(s, value),
        abort: (id) => endStream(s, id, null, true),
        closed: (reason) => onSessionClosed(s, reason)
      }
    });
    sock.onMessage = (bytes) => {
      let plain;
      try {
        plain = cs.recv.decrypt(bytes);
      } catch {
        s.frames.close("protocol");
        return;
      }
      s.messages += 1;
      s.frames.receive(plain);
    };
    sock.onClose = () => {
      if (!s.frames.isClosed) s.frames.close("transport");
    };
    return s;
  }
  function onRes(s, id, value, fin) {
    const sid = s.sidOf.get(id);
    if (sid === void 0) return;
    post({ op: "res", sid, status: Number(value?.status) || 0, headers: value?.headers ?? {} });
    if (fin) endStream(s, id, null, false);
  }
  function onData(s, id, bytes, fin) {
    const sid = s.sidOf.get(id);
    if (sid === void 0) return;
    if (bytes && bytes.byteLength) {
      const copy = new Uint8Array(bytes);
      post({ op: "data", sid, bytes: copy.buffer }, [copy.buffer]);
    }
    if (fin) endStream(s, id, null, false);
  }
  function endStream(s, id, error, cancelled) {
    const sid = s.sidOf.get(id);
    if (sid === void 0) return;
    s.sidOf.delete(id);
    s.streamOf.delete(sid);
    post({ op: "end", sid, error, cancelled });
    if (draining.has(s) && s.sidOf.size === 0) drainOld(s);
  }
  function startRequest(msg) {
    const sid = msg.sid;
    const policy = requestPolicy(msg);
    if (!policy) {
      post({ op: "end", sid, error: "refused", cancelled: false });
      return;
    }
    const s = session;
    if (!s || phase !== "connected") {
      post({ op: "end", sid, error: "offline", cancelled: false });
      return;
    }
    const body = msg.body ? new Uint8Array(msg.body) : null;
    const value = {
      method: String(msg.method || "GET").toUpperCase(),
      path: policy.path,
      headers: policy.headers,
      ...body ? { bodyLength: body.byteLength } : {}
    };
    const id = s.frames.request(value, { fin: !body });
    if (id === null) {
      post({ op: "end", sid, error: "busy", cancelled: false });
      return;
    }
    s.sidOf.set(id, sid);
    s.streamOf.set(sid, id);
    if (body) s.frames.body(id, body, { fin: true });
  }
  function cancelRequest(sid) {
    for (const s of [session, ...draining]) {
      const id = s?.streamOf.get(sid);
      if (id !== void 0) {
        s.frames.cancel(id);
        return;
      }
    }
  }
  function onSessionHello(s, value) {
    if (pairing && pairing.session === s) pairing.resolve?.({ ok: true, hello: value });
  }
  function onEvent(s, value) {
    post({ op: "event", event: value });
    if (value && value.type === "phone" && value.kind === "revoked") {
      transition("revoked");
      emitState();
      s.frames.close("revoked");
    }
  }
  function onPeerClose(s, value) {
    const reason = typeof value?.reason === "string" ? value.reason.slice(0, 64) : "peer";
    if (pairing && pairing.session === s) {
      pairing.resolve?.({ ok: false, reason: pairing.cancelled ?? reason });
      return;
    }
    lastFailure = reason;
    if (reason === "revoked") transition("revoked");
    else if (reason === "update-desktop") transition("update-desktop");
    else if (reason === "host-offline") transition("asleep");
    emitState();
  }
  function onSessionClosed(s, reason) {
    if (s.closed) return;
    s.closed = true;
    if (s.retired) return;
    if (pairing && pairing.session === s) {
      pairing.resolve?.({ ok: false, reason: pairing.cancelled ?? `closed:${reason}` });
      return;
    }
    for (const id of Array.from(s.sidOf.keys())) endStream(s, id, "lost", false);
    draining.delete(s);
    if (session !== s) {
      emitState();
      return;
    }
    session = null;
    lastSeen = clock.now();
    for (const entry of pendingStops.values()) post({ op: "stopState", sid: entry.sid, state: "queued" });
    lastFailure = String(reason ?? "lost");
    if (closedByPage) {
      emitState();
      return;
    }
    if (TERMINAL.includes(phase)) {
      emitState();
      return;
    }
    failedRounds = 0;
    scheduleRetry();
  }
  function carrierCandidates(comp) {
    const out = [];
    for (const c of usableCarriers(comp.carriers)) {
      for (const url of c.urls) out.push({ kind: c.kind, url });
    }
    return [...out.filter((c) => c.kind === comp.lastCarrier), ...out.filter((c) => c.kind !== comp.lastCarrier)];
  }
  function clearRetry() {
    clock.clearTimeout(retryTimer);
    retryTimer = null;
    nextRetryAt = null;
  }
  function scheduleRetry() {
    if (closedByPage || !computer || TERMINAL.includes(phase)) return;
    clearRetry();
    const slow = phase === "not-known";
    const delay = slow ? NOT_KNOWN_RETRY_MS : DELAYS_MS[failedRounds] ?? RETRY_CAP_MS;
    nextRetryAt = clock.now() + delay;
    if (phase !== "asleep" && !slow) transition(failedRounds >= OFFLINE_ROUNDS ? "offline" : "reconnecting");
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      nextRetryAt = null;
      attempt().catch(() => {
      });
    }, delay);
    emitState();
  }
  async function connectSession(candidate, comp) {
    const { sock, cs, message2 } = await handshake(candidate.kind, candidate.url, {
      remotePub: comp.desktopPub,
      myPriv: comp.myPriv,
      psk: null,
      offer: null,
      payloadFor: async () => {
        const counter = await raiseCounter(comp.id, comp.counter);
        comp.counter = counter;
        return { v: PROTOCOL, kind: "session", counter, device: comp.device, caps: comp.caps, ...comp.hasStopKey ? {} : { wantStopKey: true } };
      }
    });
    const s = makeSession({ sock, cs, kind: candidate.kind, url: candidate.url });
    try {
      s.hello = JSON.parse(utf8Decode.decode(message2));
    } catch {
      sock.close(1002, "hello");
      throw new Error("handshake: HELLO is not JSON");
    }
    return s;
  }
  async function attempt() {
    if (attempting || closedByPage || !computer || session || TERMINAL.includes(phase)) return;
    attempting = true;
    try {
      const candidates = carrierCandidates(computer);
      if (!candidates.length) {
        lastFailure = "no-carrier";
        unknownRounds = 0;
        failedRounds += 1;
        scheduleRetry();
        return;
      }
      const reasons = [];
      for (const candidate of candidates) {
        if (closedByPage || TERMINAL.includes(phase)) return;
        try {
          const s = await connectSession(candidate, computer);
          adopt(s);
          return;
        } catch (err) {
          lastFailure = failureName(err);
          reasons.push(lastFailure);
        }
      }
      unknownRounds = reasons.length > 0 && reasons.every((r) => r === "unknown") ? unknownRounds + 1 : 0;
      failedRounds += 1;
      if (unknownRounds >= NOT_KNOWN_ROUNDS) transition("not-known");
      else if (phase === "not-known") transition("reconnecting");
      scheduleRetry();
    } finally {
      attempting = false;
    }
  }
  function adopt(s) {
    session = s;
    failedRounds = 0;
    unknownRounds = 0;
    nextRetryAt = null;
    lastFailure = null;
    lastSeen = clock.now();
    desktopName = String(s.hello?.desktopName ?? desktopName).slice(0, 60);
    const major = s.hello?.protocol?.major;
    if (major !== 1) {
      transition(major > 1 ? "update-app" : "update-desktop");
      s.frames.close(major > 1 ? "update-app" : "update-desktop");
      emitState();
      return;
    }
    transition("connected");
    computer.lastCarrier = s.carrier;
    topUpStopKey(s);
    post({ op: "hello", hello: s.hello });
    post({ op: "patch", id: computer.id, patch: { lastCarrier: s.carrier, lastSeen } });
    s.frames.startLiveness({ intervalMs: PING_INTERVAL_MS2, misses: PING_MISSES });
    for (const entry of pendingStops.values()) sendStop(entry);
    scheduleRenewCheck(RENEW_CHECK_MS);
    emitState();
  }
  function topUpStopKey(s) {
    if (s.hello?.stopKeyNew !== true || !computer) return;
    const k = stopKey(s.cs.handshakeHash);
    post({ op: "patch", id: computer.id, patch: { stopKey: bytesToB64u(k), myDeviceId: String(s.hello.deviceId ?? "") } });
    k.fill(0);
    computer.hasStopKey = true;
  }
  function reconnectNow() {
    if (!computer || closedByPage || session || attempting || TERMINAL.includes(phase)) return;
    clearRetry();
    attempt().catch(() => {
    });
  }
  function scheduleRenewCheck(delay) {
    clock.clearTimeout(renewTimer);
    renewTimer = clock.setTimeout(() => {
      renewTimer = null;
      maybeRenew();
    }, delay);
  }
  function maybeRenew() {
    const s = session;
    if (!s || closedByPage || phase !== "connected") return;
    const due = clock.now() - s.startedAt >= RENEW_AFTER_MS || s.messages >= RENEW_AFTER_MESSAGES;
    if (!due) {
      scheduleRenewCheck(RENEW_CHECK_MS);
      return;
    }
    renew(s);
  }
  async function renew(old) {
    let made = null;
    try {
      const { sock, cs, message2 } = await handshake(old.kind, old.url, {
        remotePub: computer.desktopPub,
        myPriv: computer.myPriv,
        psk: null,
        offer: null,
        payloadFor: async () => {
          const counter = await raiseCounter(computer.id, computer.counter);
          computer.counter = counter;
          return { v: PROTOCOL, kind: "session", counter, device: computer.device, caps: computer.caps, ...computer.hasStopKey ? {} : { wantStopKey: true } };
        }
      });
      made = makeSession({ sock, cs, kind: old.kind, url: old.url });
      made.hello = JSON.parse(utf8Decode.decode(message2));
      topUpStopKey(made);
      if (session !== old || closedByPage || made.hello?.protocol?.major !== 1) {
        made.retired = true;
        made.frames.close("normal");
        scheduleRenewCheck(RENEW_CHECK_MS);
        return;
      }
      session = made;
      draining.add(old);
      made.frames.startLiveness({ intervalMs: PING_INTERVAL_MS2, misses: PING_MISSES });
      if (old.sidOf.size === 0) drainOld(old);
      else old.drainTimer = clock.setTimeout(() => drainOld(old), RENEW_DRAIN_MS);
      post({ op: "hello", hello: made.hello });
      scheduleRenewCheck(RENEW_CHECK_MS);
      emitState();
    } catch {
      if (made && made !== session) {
        made.retired = true;
        made.frames.close("normal");
      }
      scheduleRenewCheck(RENEW_CHECK_MS);
    }
  }
  function drainOld(old) {
    if (old.retired) return;
    old.retired = true;
    clock.clearTimeout(old.drainTimer);
    old.drainTimer = null;
    draining.delete(old);
    for (const id of Array.from(old.sidOf.keys())) endStream(old, id, "lost", false);
    old.frames.close("renewed");
  }
  function sendStop(entry) {
    if (!session || phase !== "connected" || !pendingStops.has(entry.id)) {
      post({ op: "stopState", sid: entry.sid, state: "queued" });
      return;
    }
    const payload = { id: entry.id, ...entry.project ? { project: entry.project } : {} };
    const sent = session.frames.stop(payload);
    post({ op: "stopState", sid: entry.sid, state: sent ? "sent" : "queued" });
    clock.clearTimeout(entry.resend);
    entry.resend = clock.setTimeout(() => {
      entry.resend = null;
      if (pendingStops.has(entry.id)) sendStop(entry);
    }, STOP_RESEND_MS);
  }
  function clearStop(entry) {
    pendingStops.delete(entry.id);
    clock.clearTimeout(entry.resend);
    clock.clearTimeout(entry.expire);
  }
  function startStop({ sid, project }) {
    const id = bytesToHex3(random(16));
    const entry = { id, sid, project: typeof project === "string" && project ? project : null, resend: null, expire: null };
    pendingStops.set(id, entry);
    entry.expire = clock.setTimeout(() => {
      if (!pendingStops.has(entry.id)) return;
      clearStop(entry);
      post({ op: "stopAck", sid: entry.sid, error: "unreachable" });
      emitState();
    }, STOP_WINDOW_MS);
    sendStop(entry);
    if (!session) reconnectNow();
    emitState();
  }
  function onStopAck(value) {
    const entry = pendingStops.get(value?.id);
    if (!entry) return;
    clearStop(entry);
    const count = (key) => Number.isSafeInteger(value[key]) ? value[key] : 0;
    post({
      op: "stopAck",
      sid: entry.sid,
      ack: {
        id: entry.id,
        cancelled: count("cancelled"),
        drivesStopped: count("drivesStopped"),
        agentsStopped: count("agentsStopped"),
        cardsDenied: count("cardsDenied")
      }
    });
    emitState();
  }
  async function stopLocked(msg) {
    const sid = msg.sid;
    const c = msg.computer && typeof msg.computer === "object" ? msg.computer : {};
    let key;
    try {
      key = asKey(c.stopKey);
      if (typeof c.id !== "string" || !c.id || !/^[0-9a-f]{64}$/.test(String(c.deviceId ?? ""))) throw new TypeError("record");
    } catch {
      post({ op: "stopAck", sid, error: "no-key" });
      return;
    }
    const comp = {
      id: c.id,
      carriers: Array.isArray(c.carriers) ? c.carriers : [],
      lastCarrier: typeof c.lastCarrier === "string" ? c.lastCarrier : null
    };
    let counter = Number.isSafeInteger(c.counter) && c.counter >= 0 ? c.counter : 0;
    const stopId = random(16);
    let done = false;
    let windowTimer = null;
    let sleepTimer = null;
    let wake = null;
    let activeSock = null;
    const finish = (detail) => {
      if (done) return;
      done = true;
      clock.clearTimeout(windowTimer);
      clock.clearTimeout(sleepTimer);
      try {
        activeSock?.close(1e3, "stopped");
      } catch {
      }
      activeSock = null;
      key.fill(0);
      post({ op: "stopAck", sid, ...detail });
      wake?.();
    };
    const sleep = (ms) => new Promise((resolve) => {
      wake = resolve;
      sleepTimer = clock.setTimeout(resolve, ms);
    });
    windowTimer = clock.setTimeout(() => finish({ error: "unreachable" }), STOP_WINDOW_MS);
    post({ op: "stopState", sid, state: "sending" });
    while (!done) {
      const candidates = carrierCandidates(comp);
      let unknown = candidates.length > 0;
      for (const candidate of candidates) {
        if (done) return;
        let sock = null;
        try {
          counter = await raiseCounter(comp.id, counter);
          if (done) return;
          sock = await openSocket(WebSocketImpl, candidate.url, { clock });
          activeSock = sock;
          if (done) {
            sock.close(1e3, "stopped");
            return;
          }
          sock.send(encodeStopOnly({ stopKey: key, deviceId: c.deviceId, counter, stopId }));
          const first = await sock.next(STOP_ONLY_WAIT_MS);
          if (done) return;
          const ack = decodeStopAck(key, first, stopId);
          sock.close(1e3, "done");
          activeSock = null;
          if (ack) {
            finish({ ack: { id: bytesToHex3(stopId), ...ack } });
            return;
          }
          unknown = false;
        } catch {
          if (sock) sock.close(1e3, "stop");
          activeSock = null;
          if (done) return;
          if (sock?.closed?.code !== 4401) unknown = false;
        }
      }
      if (done) return;
      if (unknown) {
        finish({ error: "unknown" });
        return;
      }
      post({ op: "stopState", sid, state: "queued" });
      await sleep(STOP_RESEND_MS);
    }
  }
  function pairCandidates(payload, extraUrls) {
    const out = [];
    for (const url of extraUrls ?? []) if (url && typeof url.url === "string" && carrierUrlOk(url.kind, url.url)) out.push({ kind: url.kind, url: url.url });
    for (const c of usableCarriers(payload.carriers)) {
      for (const url of c.urls) out.push({ kind: c.kind, url });
    }
    return out;
  }
  function waitPairOutcome(ms) {
    return new Promise((resolve) => {
      const timer = clock.setTimeout(() => resolve({ ok: false, reason: "expired" }), Math.max(0, ms));
      pairing.resolve = (value) => {
        clock.clearTimeout(timer);
        resolve(value);
      };
    });
  }
  function finishPairing(detail) {
    const current = pairing;
    pairing = null;
    current?.psk?.fill(0);
    current?.keys?.privateKey?.fill(0);
    if (current?.session && !current.session.closed) {
      current.session.retired = true;
      current.session.frames.close("normal");
    }
    post({ op: "pairState", ...detail });
  }
  async function startPairing(msg) {
    if (pairing || computer) {
      post({ op: "pairState", state: "failed", reason: "busy" });
      return;
    }
    const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
    let pub;
    let psk;
    let offer;
    try {
      pub = asKey(b64uToBytes(payload.pub));
      psk = asKey(b64uToBytes(payload.psk));
      offer = String(payload.offer ?? "");
      if (!/^[0-9a-f]{32}$/.test(offer)) throw new TypeError("offer");
    } catch {
      post({ op: "pairState", state: "failed", reason: "bad-link" });
      return;
    }
    const keys = generateKeyPair(options.random);
    const id = deviceId(pub);
    const ttlMs = (Number(payload.ttl) > 0 ? Math.min(Number(payload.ttl), 600) : 120) * 1e3;
    const deadline = clock.now() + ttlMs;
    pairing = { id, keys, psk, session: null, resolve: null, tried: [], cancelled: null, active: true };
    const candidates = pairCandidates(payload, msg.extraUrls);
    if (!candidates.length) {
      finishPairing({ state: "failed", tried: [], reason: "no-carrier" });
      return;
    }
    for (const candidate of candidates) {
      if (!pairing || !pairing.active) return;
      if (clock.now() >= deadline) break;
      let pairCounter = 0;
      try {
        const { sock, cs, message2 } = await handshake(candidate.kind, candidate.url, {
          remotePub: pub,
          myPriv: keys.privateKey,
          psk,
          offer,
          payloadFor: async () => {
            pairCounter = await raiseCounter(id, 0);
            return { v: PROTOCOL, kind: "pair", counter: pairCounter, offer, device: msg.device ?? {}, caps: msg.caps ?? DEFAULT_CAPS };
          }
        });
        if (!pairing) {
          sock.close();
          return;
        }
        const reply = JSON.parse(utf8Decode.decode(message2));
        if (reply?.state !== "confirm") {
          sock.close(1002, "pairing");
          throw new Error("pairing: no confirm");
        }
        const s = makeSession({ sock, cs, kind: candidate.kind, url: candidate.url });
        pairing.session = s;
        post({ op: "pairState", state: "confirm", code: sas(cs.handshakeHash) });
        s.frames.startLiveness({ intervalMs: PING_INTERVAL_MS2, misses: PING_MISSES });
        const outcome = await waitPairOutcome(deadline - clock.now());
        if (outcome.ok) {
          const name = String(outcome.hello?.desktopName ?? payload.name ?? "").slice(0, 60);
          const record = {
            id,
            name,
            desktopPub: bytesToB64u(pub),
            myPriv: bytesToB64u(keys.privateKey),
            counter: pairCounter,
            carriers: usableCarriers(payload.carriers),
            lastCarrier: candidate.kind,
            lastSeen: clock.now(),
            pairedAt: clock.now(),
            pushKey: bytesToB64u(pushKey(cs.handshakeHash)),
            stopKey: bytesToB64u(stopKey(cs.handshakeHash)),
            myDeviceId: deviceId(keys.publicKey)
          };
          s.retired = true;
          const done = pairing;
          pairing = null;
          post({ op: "paired", computer: record });
          keys.privateKey.fill(0);
          psk.fill(0);
          s.frames.close("normal");
          done.active = false;
          post({ op: "pairState", state: "allowed", computerId: id });
          return;
        }
        const reason = String(outcome.reason ?? "closed");
        const state = /denied/.test(reason) ? "denied" : /expired/.test(reason) ? "expired" : /mismatch/.test(reason) ? "mismatch" : "failed";
        finishPairing({ state, reason: state === "failed" ? reason : void 0 });
        return;
      } catch (err) {
        if (!pairing) return;
        pairing.tried.push({ carrier: candidate.kind, reason: failureName(err) });
      }
    }
    if (pairing) finishPairing({ state: clock.now() >= deadline ? "expired" : "failed", tried: pairing.tried });
  }
  function cancelPairing() {
    if (!pairing) return;
    pairing.cancelled = "mismatch";
    if (pairing.session && !pairing.session.closed) pairing.session.frames.close("mismatch");
    else {
      const current = pairing;
      pairing = null;
      current.active = false;
      post({ op: "pairState", state: "mismatch" });
    }
  }
  function init(msg) {
    if (computer) return;
    const c = msg.computer && typeof msg.computer === "object" ? msg.computer : {};
    try {
      computer = {
        id: String(c.id ?? ""),
        name: String(c.name ?? ""),
        desktopPub: asKey(c.desktopPub),
        myPriv: asKey(c.myPriv),
        carriers: Array.isArray(c.carriers) ? c.carriers : [],
        lastCarrier: typeof c.lastCarrier === "string" ? c.lastCarrier : null,
        counter: Number.isSafeInteger(c.counter) && c.counter >= 0 ? c.counter : 0,
        device: msg.device && typeof msg.device === "object" ? msg.device : {},
        caps: Array.isArray(msg.caps) ? msg.caps : DEFAULT_CAPS,
        hasStopKey: msg.hasStopKey === true
      };
    } catch {
      computer = null;
      transition("failed");
      lastFailure = "bad-computer";
      emitState();
      return;
    }
    transition("connecting");
    emitState();
    attempt().catch(() => {
    });
  }
  function closeChannel() {
    if (closedByPage) return;
    closedByPage = true;
    clearRetry();
    clock.clearTimeout(renewTimer);
    renewTimer = null;
    for (const entry of Array.from(pendingStops.values())) {
      clearStop(entry);
      post({ op: "stopAck", sid: entry.sid, error: "closed" });
    }
    if (pairing) cancelPairing();
    for (const old of Array.from(draining)) drainOld(old);
    const s = session;
    session = null;
    if (s && !s.closed) s.frames.close("normal");
    transition("closed");
    computer?.myPriv?.fill(0);
    emitState();
  }
  function handle(msg) {
    if (!msg || typeof msg !== "object") return;
    try {
      switch (msg.op) {
        case "init":
          return init(msg);
        case "pair":
          return void startPairing(msg).catch(() => {
            pairing = null;
            post({ op: "pairState", state: "failed", reason: "error" });
          });
        case "request":
          return startRequest(msg);
        case "cancel":
          return cancelRequest(msg.sid);
        case "stop":
          return startStop(msg);
        case "stopLocked":
          return void stopLocked(msg).catch(() => post({ op: "stopAck", sid: msg.sid, error: "unreachable" }));
        case "reconnect":
          return reconnectNow();
        case "pairCancel":
          return cancelPairing();
        case "counterSaved": {
          const waiter = rids.get(msg.rid);
          if (waiter) {
            rids.delete(msg.rid);
            waiter.resolve(msg);
          }
          return void 0;
        }
        case "close":
          return closeChannel();
        default:
          return void 0;
      }
    } catch (err) {
      post({ op: "log", line: `worker: ${failureName(err)}` });
      return void 0;
    }
  }
  return {
    handle,
    snapshot,
    get phase() {
      return phase;
    },
    get session() {
      return session;
    }
  };
}
var inWorker = typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope;
if (inWorker) {
  const core = createChannelCore({
    post: (message, transfer = []) => self.postMessage(message, transfer),
    WebSocketImpl: globalThis.WebSocket
  });
  self.onmessage = (event) => core.handle(event.data);
}
export {
  CONNECT_TIMEOUT_MS,
  COUNTER_TIMEOUT_MS,
  DEFAULT_CAPS,
  DELAYS_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_SOCKET_MESSAGE,
  NOT_KNOWN_RETRY_MS,
  NOT_KNOWN_ROUNDS,
  OFFLINE_ROUNDS,
  PING_INTERVAL_MS2 as PING_INTERVAL_MS,
  PING_MISSES,
  PROTOCOL,
  RENEW_AFTER_MESSAGES,
  RENEW_AFTER_MS,
  RENEW_CHECK_MS,
  RENEW_DRAIN_MS,
  RETRY_CAP_MS,
  STOP_ONLY_WAIT_MS,
  STOP_RESEND_MS,
  STOP_WINDOW_MS,
  b64uToBytes,
  bytesToB64u,
  createChannelCore,
  openSocket,
  requestPolicy
};
/*! Bundled license information:

@noble/curves/utils.js:
@noble/curves/abstract/modular.js:
@noble/curves/abstract/curve.js:
@noble/curves/abstract/edwards.js:
@noble/curves/abstract/montgomery.js:
@noble/curves/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/ciphers/utils.js:
  (*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) *)
*/
