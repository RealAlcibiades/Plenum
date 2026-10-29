var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: !0, configurable: !0, writable: !0, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key != "symbol" ? key + "" : key, value), __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj)), __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value), __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value), __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// mobile/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0, fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE2) {
  let h = fromNumH(n), l = fromNumL(n);
  view.setUint32(byteOffset, isLE2 ? l : h, isLE2), view.setUint32(byteOffset + 4, isLE2 ? h : l, isLE2);
}

// mobile/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n != "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  length !== void 0 && anumber(length, "length");
  let bytes = isBytes(value), ofLen = length !== void 0 ? ` of length ${length}` : "", got = bytes ? `length=${value.length}` : `type=${typeof value}`, message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  throw bytes ? new RangeError(message) : new TypeError(message);
}
function ahash(h) {
  if (typeof h != "function" || typeof h.create != "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  if (anumber(h.outputLen), anumber(h.blockLen), h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label) => {
  if (value === null || typeof value != "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
}, aopts = (value, label) => {
  aobject(value, label);
  let proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = !0) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  let min = instance.outputLen;
  if (!(out.length >= min))
    throw new RangeError('"output" expected length >= ' + min);
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++)
    arrays[i].fill(0);
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @ts-ignore */ typeof Uint8Array.from([]).toHex == "function" && typeof Uint8Array.fromHex == "function", hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  if (abytes(bytes), hasHexBuiltin)
    return bytes.toHex();
  let hex2 = "";
  for (let i = 0; i < bytes.length; i++)
    hex2 += hexes[bytes[i]];
  return hex2;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - 55 : ch >= 97 && ch <= 102 ? ch - 87 : void 0;
}
function hexToBytes(hex2) {
  if (typeof hex2 != "string")
    throw new TypeError("hex string expected, got " + typeof hex2);
  if (hasHexBuiltin)
    try {
      return Uint8Array.fromHex(hex2);
    } catch (error) {
      throw error instanceof SyntaxError ? new RangeError(error.message) : error;
    }
  let hl = hex2.length, al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  let array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    let n1 = asciiToBase16(hex2.charCodeAt(hi)), n2 = asciiToBase16(hex2.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      let char = hex2[hi] + hex2[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function checkOpts(defaults, opts, title = "opts") {
  return aopts(defaults, "defaults"), opts !== void 0 && aopts(opts, title), Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons != "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  let hashC = (msg, opts) => hashCons(opts).update(msg).digest(), tmp = hashCons(void 0);
  return hashC.outputLen = tmp.outputLen, hashC.blockLen = tmp.blockLen, hashC.canXOF = tmp.canXOF, hashC.create = (opts) => hashCons(opts), Object.assign(hashC, info), Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  let cr = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues != "function")
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
    __publicField(this, "canXOF", !1);
    __publicField(this, "padOffset");
    __publicField(this, "isLE");
    // For partial updates less than block size
    __publicField(this, "buffer");
    __publicField(this, "view");
    __publicField(this, "finished", !1);
    __publicField(this, "length", 0);
    __publicField(this, "pos", 0);
    __publicField(this, "destroyed", !1);
    this.blockLen = blockLen, this.outputLen = outputLen, this.padOffset = padOffset, this.isLE = isLE2, this.buffer = new Uint8Array(blockLen), this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this), abytes(data);
    let { view, buffer, blockLen } = this, len = data.length, processed = !1;
    for (let pos = 0; pos < len; ) {
      let take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        let dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = !0;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos), this.pos += take, pos += take, this.pos === blockLen && (this.process(view, 0), this.pos = 0, processed = !0);
    }
    return this.length += data.length, processed && this.roundClean(), this;
  }
  digestInto(out) {
    aexists(this), aoutput(out, this), this.finished = !0;
    let { buffer, view, blockLen, isLE: isLE2 } = this, { pos } = this;
    buffer[pos++] = 128, buffer.fill(0, pos), this.padOffset > blockLen - pos && (this.process(view, 0), buffer.fill(0)), setU64FromNum(view, blockLen - 8, this.length * 8, isLE2), this.process(view, 0), this.roundClean();
    let oview = out === buffer ? view : createView(out), len = this.outputLen, outLen = len / 4, state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    let { buffer, outputLen } = this;
    this.digestInto(buffer);
    let res = buffer.slice(0, outputLen);
    return this.destroy(), res;
  }
  _cloneIntoMeta(to) {
    let { buffer, length, finished, destroyed, pos } = this;
    return to.destroyed = destroyed, to.finished = finished, to.length = length, to.pos = pos, pos && to.buffer.set(buffer), to;
  }
  clone() {
    return this._cloneInto();
  }
}, SHA256_IV = /* @__PURE__ */ Uint32Array.from([
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
]), SHA256_W = /* @__PURE__ */ new Uint32Array(64), SHA2_32B = class extends HashMD {
  constructor(outputLen, IV) {
    super(64, outputLen, 8, !1);
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
    this.A = IV[0] | 0, this.B = IV[1] | 0, this.C = IV[2] | 0, this.D = IV[3] | 0, this.E = IV[4] | 0, this.F = IV[5] | 0, this.G = IV[6] | 0, this.H = IV[7] | 0;
  }
  get() {
    let { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0, this.B = B | 0, this.C = C | 0, this.D = D | 0, this.E = E | 0, this.F = F | 0, this.G = G | 0, this.H = H | 0;
  }
  _cloneInto(to) {
    return (to ||= new this.constructor()).set(...this.get()), this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, !1);
    for (let i = 16; i < 64; i++) {
      let W15 = SHA256_W[i - 15], W2 = SHA256_W[i - 2], s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3, s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      let sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25), T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0, T2 = (rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22)) + Maj(A, B, C) | 0;
      H = G, G = F, F = E, E = D + T1 | 0, D = C, C = B, B = A, A = T1 + T2 | 0;
    }
    A = A + this.A | 0, B = B + this.B | 0, C = C + this.C | 0, D = D + this.D | 0, E = E + this.E | 0, F = F + this.F | 0, G = G + this.G | 0, H = H + this.H | 0, this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = !0, this.set(0, 0, 0, 0, 0, 0, 0, 0), clean(this.buffer);
  }
}, _SHA256 = class extends SHA2_32B {
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
var abytes2 = (value, length, title) => abytes(value, length, title), anumber2 = anumber;
function aobject2(value, title = "object") {
  if (value === null || typeof value != "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value != "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex2 = bytesToHex;
var hexToBytes2 = (hex2) => hexToBytes(hex2), isBytes2 = isBytes, randomBytes2 = (bytesLength) => randomBytes(bytesLength), _0n = /* @__PURE__ */ BigInt(0), _1n = /* @__PURE__ */ BigInt(1), atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value != "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n == "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value != "number") {
    let prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    let prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function hexToNumber(hex2) {
  if (typeof hex2 != "string")
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
  if (anumber(len), len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  let expectedLen = len * 2, hex2 = n.toString(16);
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
  return typeof n == "bigint" && _0n <= n;
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
var bitMask = (n) => (asafenumber(n, "n"), (_1n << BigInt(n)) - _1n);
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title), aobject2(fields, "fields"), aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    let label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`, val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== void 0 : expectedType !== "function"))
      throw new TypeError(`${label} is invalid: expected own property`);
    if (isOpt && val === void 0)
      return;
    let current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
  }
  let iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, !1), iter(optFields, !0);
}

// mobile/node_modules/@noble/curves/abstract/modular.js
var _0n2 = /* @__PURE__ */ BigInt(0), _1n2 = /* @__PURE__ */ BigInt(1), _2n = /* @__PURE__ */ BigInt(2), _3n = /* @__PURE__ */ BigInt(3), _4n = /* @__PURE__ */ BigInt(4), _5n = /* @__PURE__ */ BigInt(5), _7n = /* @__PURE__ */ BigInt(7), _8n = /* @__PURE__ */ BigInt(8), _9n = /* @__PURE__ */ BigInt(9), _15n = /* @__PURE__ */ BigInt(15), _16n = /* @__PURE__ */ BigInt(16), POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  let result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power != "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return _1n2;
  if (power === _1n2)
    return num;
  let d = num % modulo;
  if (d < _0n2 && (d += modulo), power < POW_WINDOWED_MIN) {
    let p2 = _1n2;
    for (; power > _0n2; )
      power & _1n2 && (p2 = p2 * d % modulo), d = d * d % modulo, power >>= _1n2;
    return p2;
  }
  let digits = [];
  for (; power > _0n2; )
    digits.push(Number(power & _15n)), power >>= _4n;
  let table = new Array(16);
  table[0] = _1n2, table[1] = d;
  for (let i = 2; i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2; w >= 0; w--) {
    p = p * p % modulo, p = p * p % modulo, p = p * p % modulo, p = p * p % modulo;
    let digit = digits[w];
    digit !== 0 && (p = p * table[digit] % modulo);
  }
  return p;
}
function pow2(x, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow2: expected modulus > 1, got " + modulo);
  if (power < _0n2)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  for (; power-- > _0n2; )
    res *= res, res %= modulo;
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n2)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo), b = modulo, x = _0n2, u = _1n2;
  for (; a !== _0n2; ) {
    let q = b / a, r = b - a * q, m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  if (b !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  let F = Fp;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n2) === _0n2)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp, n) {
  let F = Fp, p1div4 = (F.ORDER + _1n2) / _4n, root = F.pow(n, p1div4);
  return assertIsSquare(F, root, n), root;
}
function sqrt5mod8(Fp, n) {
  let F = Fp, p5div8 = (F.ORDER - _5n) / _8n, n2 = F.mul(n, _2n), v = F.pow(n2, p5div8), nv = F.mul(n, v), i = F.mul(F.mul(nv, _2n), v), root = F.mul(nv, F.sub(i, F.ONE));
  return assertIsSquare(F, root, n), root;
}
function sqrt9mod16(P) {
  let Fp_ = Field(P), tn = tonelliShanks(P), c1 = tn(Fp_, Fp_.neg(Fp_.ONE)), c2 = tn(Fp_, c1), c3 = tn(Fp_, Fp_.neg(c1)), c4 = (P + _7n) / _16n;
  return ((Fp, n) => {
    let F = Fp, tv1 = F.pow(n, c4), tv2 = F.mul(tv1, c1), tv3 = F.mul(tv1, c2), tv4 = F.mul(tv1, c3), e1 = F.eql(F.sqr(tv2), n), e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1), tv2 = F.cmov(tv4, tv3, e2);
    let e3 = F.eql(F.sqr(tv2), n), root = F.cmov(tv1, tv2, e3);
    return assertIsSquare(F, root, n), root;
  });
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P, "tonelliShanks");
  let Q = P - _1n2, S = 0;
  for (; Q % _2n === _0n2; )
    Q /= _2n, S++;
  let Z = _2n, _Fp = Field(P);
  for (; FpLegendre(_Fp, Z) === 1; )
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q), Q1div2 = (Q + _1n2) / _2n;
  return function(Fp, n) {
    let F = Fp;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S, c = F.mul(F.ONE, cc), t = F.pow(n, Q), R = F.pow(n, Q1div2);
    for (; !F.eql(t, F.ONE); ) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1, t_tmp = F.sqr(t);
      for (; !F.eql(t_tmp, F.ONE); )
        if (i++, t_tmp = F.sqr(t_tmp), i === M)
          throw new Error("Cannot find square root");
      let exponent = _1n2 << BigInt(M - i - 1), b = F.pow(c, exponent);
      M = i, c = F.sqr(b), t = F.mul(t, c), R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  return aoddModulus(P, "Fp.sqrt"), P % _4n === _3n ? sqrt3mod4 : P % _8n === _5n ? sqrt5mod8 : P % _16n === _9n ? sqrt9mod16(P) : tonelliShanks(P);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2, FIELD_FIELDS = [
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
  if (aobject2(field, "field"), typeof field.ORDER != "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES"), asafenumber(field.BITS, "BITS");
  for (let name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp, nums, passZero = !1) {
  validateField(Fp), aarray(nums, "nums"), abool(passZero, "passZero");
  let F = Fp, inverted = new Array(nums.length).fill(passZero ? F.ZERO : void 0), multipliedAcc = nums.reduce((acc, num, i) => F.is0(num) ? acc : (inverted[i] = acc, F.mul(acc, num)), F.ONE), invertedAcc = F.inv(multipliedAcc);
  return nums.reduceRight((acc, num, i) => F.is0(num) ? acc : (inverted[i] = F.mul(acc, inverted[i]), F.mul(acc, num)), invertedAcc), inverted;
}
function FpLegendre(Fp, n) {
  validateField(Fp);
  let F = Fp;
  aoddModulus(F.ORDER, "FpLegendre");
  let p1mod2 = (F.ORDER - _1n2) / _2n, powered = F.pow(n, p1mod2), yes = F.eql(powered, F.ONE), zero = F.eql(powered, F.ZERO), no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0 && anumber2(nBitLength), n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== void 0 && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  let bits = bitLen(n);
  if (nBitLength !== void 0 && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  let _nBitLength = nBitLength !== void 0 ? nBitLength : bits, nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = /* @__PURE__ */ new WeakMap(), _Field = class {
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
    let _nbitLength;
    this.isLE = !1, opts != null && typeof opts == "object" && (typeof opts.BITS == "number" && (_nbitLength = opts.BITS), typeof opts.sqrt == "function" && Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: !0 }), typeof opts.isLE == "boolean" && (this.isLE = opts.isLE), opts.allowedLengths && (this._lengths = Object.freeze(opts.allowedLengths.slice())), typeof opts.modFromBytes == "boolean" && (this._mod = opts.modFromBytes));
    let { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER, this.BITS = nBitLength, this.BYTES = nByteLength, Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num != "bigint")
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
    return sqrt || FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER)), sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = !1) {
    abytes2(bytes);
    let { _lengths: allowedLengths, BYTES, isLE: isLE2, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES)
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      let padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE2 ? 0 : padded.length - bytes.length), bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes && (scalar = mod(scalar, ORDER)), !skipValidation && !this.isValid(scalar))
      throw new Error("invalid field element: outside of range 0..ORDER");
    return scalar;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(lst) {
    return FpInvertBatch(this, lst, !0);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(a, b, condition) {
    return abool(condition, "condition"), condition ? b : a;
  }
};
function Field(ORDER, opts = {}) {
  return Object.freeze(_Field.prototype), new _Field(ORDER, opts);
}

// mobile/node_modules/@noble/curves/abstract/curve.js
var _0n3 = /* @__PURE__ */ BigInt(0), _1n3 = /* @__PURE__ */ BigInt(1), _4n2 = /* @__PURE__ */ BigInt(4), BLIND_BYTES = 16, BLIND_BITS = 128, FW_WINDOW = 5, TABLE_BYTES_MAX = 2 ** 31;
function validatePointCons(Point) {
  let pc = Point;
  if (typeof pc != "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point);
  afunction(pc.fromAffine, "Point.fromAffine"), afunction(pc.fromBytes, "Point.fromBytes"), afunction(pc.fromHex, "Point.fromHex"), aobject2(pc.BASE, "Point.BASE"), aobject2(pc.ZERO, "Point.ZERO"), validateField(pc.Fp), validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c), validateMSMPoints(points, c);
  let invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits, min = 1) {
  if (!Number.isSafeInteger(W) || W < min || W > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W);
}
function validateTableBytes(numPoints, fpBytes) {
  let bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes4, length) {
  if (randomBytes4 !== void 0) {
    afunction(randomBytes4, "randomBytes");
    try {
      let probe = randomBytes4(length);
      if (!isBytes2(probe) || probe.length !== length)
        return;
    } catch {
      return;
    }
    return randomBytes4;
  }
}
function validateMSMPoints(points, c) {
  aarray(points, "points"), points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!(maxScalar === void 0 ? field.isValid(s) : isPosBig(s) && s < maxScalar))
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getWindowSize(P) {
  return pointWindowSizes.get(P) || 1;
}
function oddMultiples(p, size) {
  let dbl = p.double(), t = [p];
  for (let j = 1; j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W) {
  let size = 2 ** W, half = size / 2, mask = BigInt(size - 1), d = [];
  for (; n > _0n3; ) {
    let w = 0;
    n & _1n3 && (w = Number(n & mask), w >= half && (w -= size), n -= BigInt(w)), d.push(w), n >>= _1n3;
  }
  return d;
}
function signedWindowDigits(n, W, windows) {
  let size = 2 ** W, half = size / 2, mask = BigInt(size - 1), shiftBy = BigInt(W), d = [];
  for (let w = 0; w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy, v > half && (v -= size, n += _1n3), d.push(v);
  }
  if (n !== _0n3)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (let d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1; bit >= 0; bit--) {
    bit !== max - 1 && (acc = acc.double());
    for (let i = 0; i < digits.length; i++) {
      let w = digits[i][bit];
      if (w) {
        let item = tables[i][Math.abs(w) - 1 >> 1];
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
    validatePointCons(Point), this.randomBytes = probeRandomBytes(randomBytes4, BLIND_BYTES), this.Point = Point, this.BASE = Point.BASE, this.ZERO = Point.ZERO, this.bits = Point.Fn.BITS;
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
    let windows = Math.ceil(bits / W) + 1, half = 2 ** (W - 1), comp = [], base = point;
    for (let w = 0; w < windows; w++) {
      let acc = base;
      for (let i = 0; i < half; i++)
        comp.push(acc), acc = acc.add(base);
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
    let { W, windows, comp } = precomputes, half = 2 ** (W - 1), digits = signedWindowDigits(n, W, windows), p = this.ZERO, f = this.BASE;
    for (let w = 0; w < windows; w++) {
      let digit = digits[w], start = w * half, idx = Math.abs(digit) - 1, sel = comp[start];
      for (let i = 1; i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      let neg = sel.negate();
      digit === 0 ? f = f.add(comp[start]) : p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  // Cache key is point identity plus (W, bits); at most two entries exist per point (public-width
  // `Fn.BITS` and blinded `Fn.BITS + BLIND_BITS`). Callers must not reuse the same point with
  // incompatible `transform(...)` layouts and expect a separate cache entry.
  getWnafPrecomputes(W, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point), comp = entries?.find((entry) => entry.W === W && entry.bits === bits);
    return comp || (comp = this.buildWnafTable(point, W, bits), typeof transform == "function" && (comp = { ...comp, comp: transform(comp.comp) }), entries || (entries = [], this.wnafPrecomputes.set(point, entries)), entries.push(comp)), comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  // Shared prologue of the constant-time entry points. Rejects scalar 0: in key/signature-style
  // callers a zero scalar means broken upstream plumbing, and concrete Points already reject it.
  // Uses inRange instead of Fn.isValidNot0: validateField() only certifies the arithmetic subset.
  validateMulInput(point, scalar) {
    if (this.assertPoint(point), !inRange(scalar, _1n3, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  // Constant-time dispatch shared by mulCT / mulCTBlinded. Un-precomputed points (W===1, e.g.
  // ECDH peer keys) skip building a throwaway cached table in favor of a small fixed-window
  // multiply. `n` must be < 2^bits.
  runCT(point, n, bits, transform) {
    let W = getWindowSize(point);
    return W === 1 ? this.fixedWindowCT(point, n, bits) : this.wnafCachedCT(this.getWnafPrecomputes(W, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    return this.validateMulInput(point, scalar), this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    if (this.validateMulInput(point, scalar), this.randomBytes === void 0)
      throw new Error("randomBytes is required for scalar blinding");
    let bits = this.Point.Fn.BITS + BLIND_BITS, blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes2(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    let n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
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
    let W = FW_WINDOW, size = 1 << W, mask = bitMask(W), table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1; i < size; i++)
      table[i] = table[i - 1].add(point);
    let windows = Math.ceil(bits / W), acc = this.ZERO;
    for (let window = windows - 1; window >= 0; window--) {
      if (window !== windows - 1)
        for (let d = 0; d < W; d++)
          acc = acc.double();
      let digit = Number(n >> BigInt(window * W) & mask), sel = table[0];
      for (let i = 1; i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    return this.randomBytes === void 0 ? !1 : cofactor === _1n3 ? !0 : point !== this.BASE ? !1 : (this.baseCanBeBlinded === void 0 && (this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0()), this.baseCanBeBlinded);
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    if (this.assertPoint(point), !isPosBig(scalar))
      throw new Error("invalid scalar");
    let W = getWindowSize(point);
    if (W === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], !0);
    let precomputes = this.getWnafPrecomputes(W, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  // Remembers the window size used for precomputed wNAF multiplication of the given point
  // and drops any previously built tables. Usually only the base point is precomputed.
  // W=1 resets the point to the un-precomputed (table-less) paths.
  // W is additionally capped so tables stay under ~2 GiB ({@link TABLE_BYTES_MAX}).
  setWindowSize(point, W) {
    this.assertPoint(point), validateW(W, this.bits);
    let windows = Math.ceil((this.bits + BLIND_BITS) / W) + 1;
    validateTableBytes(windows * 2 ** (W - 1), this.Point.Fp.BYTES), pointWindowSizes.set(point, W), this.wnafPrecomputes.delete(point);
  }
  // True when a window size is set: tables themselves are built lazily on first multiply.
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
};
function mulAddUnsafe(c, points, scalars, allowOversized = !1) {
  if (validatePointCons(c), validateMSMPoints(points, c), abool(allowOversized, "allowOversized"), validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : void 0), points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  let tables = points.map((p) => oddMultiples(p, 4)), digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE2) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    return validateField(field), field;
  } else
    return Field(order, { isLE: isLE2 });
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === void 0 && (FpFnLE = type === "edwards"), !CURVE || typeof CURVE != "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (let p of ["p", "n", "h"]) {
    let val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  let Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE), Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE), params = ["Gx", "Gy", "a", type === "weierstrass" ? "b" : "d"];
  for (let p of params)
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  return CURVE = Object.freeze(Object.assign({}, CURVE)), { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function(seed) {
    let secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}

// mobile/node_modules/@noble/curves/abstract/edwards.js
var _0n4 = /* @__PURE__ */ BigInt(0), _1n4 = /* @__PURE__ */ BigInt(1), _2n2 = /* @__PURE__ */ BigInt(2), _4n3 = /* @__PURE__ */ BigInt(4), _8n2 = /* @__PURE__ */ BigInt(8);
function isEdValidXY(Fp, CURVE, x, y) {
  let x2 = Fp.sqr(x), y2 = Fp.sqr(y), left = Fp.add(Fp.mul(CURVE.a, x2), y2), right = Fp.add(Fp.ONE, Fp.mul(CURVE.d, Fp.mul(x2, y2)));
  return Fp.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  validateObject(extraOpts, {}, {}, "extraOpts");
  let opts = extraOpts, validated = createCurveFields("edwards", params, opts, opts.FpFnLE), { Fp, Fn } = validated, CURVE = validated.CURVE, { h: cofactor } = CURVE;
  if (FpLegendre(Fp, CURVE.a) !== 1)
    throw new Error("edwards: CURVE.a must be a square in Fp for complete addition formulas");
  if (FpLegendre(Fp, CURVE.d) !== -1)
    throw new Error("edwards: CURVE.d must be a non-square in Fp for complete addition formulas");
  validateObject(opts, {}, { uvRatio: "function", randomBytes: "function" });
  let randomBytes4 = opts.randomBytes === void 0 ? randomBytes2 : opts.randomBytes, MASK = _2n2 << BigInt(Fp.BYTES * 8) - _1n4;
  function isOdd(n) {
    if (!Fp.isOdd)
      throw new Error("Field does not have .isOdd()");
    return Fp.isOdd(n);
  }
  let uvRatio2 = opts.uvRatio === void 0 ? (u, v) => {
    try {
      return { isValid: !0, value: Fp.sqrt(Fp.div(u, v)) };
    } catch {
      return { isValid: !1, value: _0n4 };
    }
  } : opts.uvRatio;
  if (!isEdValidXY(Fp, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  let mulA = Fp.eql(CURVE.a, Fp.neg(Fp.ONE)) ? (x) => Fp.neg(x) : Fp.eql(CURVE.a, Fp.ONE) ? (x) => x : (x) => Fp.mul(CURVE.a, x);
  function acoord(title, n, banZero = !1) {
    let min = banZero ? _1n4 : _0n4;
    return aInRange("coordinate " + title, n, min, MASK), n;
  }
  function aedpoint(other) {
    if (!(other instanceof Point))
      throw new Error("EdwardsPoint expected");
  }
  let _Point = class _Point {
    constructor(X, Y, Z, T) {
      __publicField(this, "X");
      __publicField(this, "Y");
      __publicField(this, "Z");
      __publicField(this, "T");
      this.X = acoord("x", X), this.Y = acoord("y", Y), this.Z = acoord("z", Z, !0), this.T = acoord("t", T), Object.freeze(this);
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
      let { x, y } = p || {};
      return acoord("x", x), acoord("y", y), new _Point(x, y, Fp.ONE, Fp.mul(x, y));
    }
    // Uses algo from RFC8032 5.1.3.
    static fromBytes(bytes, zip215 = !1) {
      let len = Fp.BYTES, { a, d } = CURVE;
      bytes = copyBytes(abytes2(bytes, len, "point")), abool(zip215, "zip215");
      let normed = copyBytes(bytes), lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & -129;
      let y = bytesToNumberLE(normed), max = zip215 ? MASK : Fp.ORDER;
      aInRange("point.y", y, _0n4, max);
      let y2 = Fp.sqr(y), u = Fp.sub(y2, Fp.ONE), v = Fp.sub(Fp.mulN(d, y2), a), { isValid, value: x } = uvRatio2(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      let isXOdd = isOdd(x), isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && Fp.is0(x) && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      return isLastByteOdd !== isXOdd && (x = Fp.neg(x)), _Point.fromAffine({ x, y });
    }
    static fromHex(hex2, zip215 = !1) {
      return _Point.fromBytes(hexToBytes2(hex2), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 6, isLazy = !0) {
      return wnaf.setWindowSize(this, windowSize), isLazy || this.multiply(_2n2), this;
    }
    // Useful in fromAffine() - not for fromBytes(), which always created valid points.
    assertValidity() {
      let p = this, { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      let { X, Y, Z, T } = p, X2 = Fp.sqr(X), Y2 = Fp.sqr(Y), Z2 = Fp.sqr(Z), Z4 = Fp.sqr(Z2), aX2 = Fp.mul(X2, a), left = Fp.mul(Fp.add(aX2, Y2), Z2), right = Fp.add(Z4, Fp.mul(d, Fp.mul(X2, Y2)));
      if (!Fp.eql(left, right))
        throw new Error("bad point: equation left != right (1)");
      let XY = Fp.mul(X, Y), ZT = Fp.mul(Z, T);
      if (!Fp.eql(XY, ZT))
        throw new Error("bad point: equation left != right (2)");
    }
    // Compare one point to another.
    equals(other) {
      aedpoint(other);
      let { X: X1, Y: Y1, Z: Z1 } = this, { X: X2, Y: Y2, Z: Z2 } = other, X1Z2 = Fp.mul(X1, Z2), X2Z1 = Fp.mul(X2, Z1), Y1Z2 = Fp.mul(Y1, Z2), Y2Z1 = Fp.mul(Y2, Z1);
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
      let { X: X1, Y: Y1, Z: Z1 } = this, A = Fp.sqr(X1), B = Fp.sqr(Y1), C = Fp.mul(Fp.sqr(Z1), _2n2), D = mulA(A), x1y1 = Fp.addN(X1, Y1), E = Fp.sub(Fp.subN(Fp.sqr(x1y1), A), B), G = Fp.addN(D, B), F = Fp.subN(G, C), H = Fp.subN(D, B), X3 = Fp.mul(E, F), Y3 = Fp.mul(G, H), T3 = Fp.mul(E, H), Z3 = Fp.mul(F, G);
      return new _Point(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aedpoint(other);
      let { d } = CURVE, { X: X1, Y: Y1, Z: Z1, T: T1 } = this, { X: X2, Y: Y2, Z: Z2, T: T2 } = other, A = Fp.mul(X1, X2), B = Fp.mul(Y1, Y2), C = Fp.mul(Fp.mulN(T1, d), T2), D = Fp.mul(Z1, Z2), E = Fp.sub(Fp.subN(Fp.mulN(Fp.addN(X1, Y1), Fp.addN(X2, Y2)), A), B), F = Fp.subN(D, C), G = Fp.addN(D, C), H = Fp.sub(B, mulA(A)), X3 = Fp.mul(E, F), Y3 = Fp.mul(G, H), T3 = Fp.mul(E, H), Z3 = Fp.mul(F, G);
      return new _Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      return aedpoint(other), this.add(other.negate());
    }
    // Constant-time multiplication.
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
      let { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize);
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
      return scalar === _0n4 ? _Point.ZERO : this.is0() || scalar === _1n4 ? this : wnaf.mulUnsafe(this, scalar, normalize);
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
      let p = this, iz = invertedZ;
      if (iz != null && typeof iz != "bigint")
        throw new TypeError('"invertedZ" expected bigint, got type=' + typeof iz);
      let { X, Y, Z } = p, is0 = p.is0();
      iz == null && (iz = is0 ? Fp.create(_8n2) : Fp.inv(Z));
      let x = Fp.mul(X, iz), y = Fp.mul(Y, iz), zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ONE };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    clearCofactor() {
      return cofactor === _1n4 ? this : cofactor === _2n2 ? this.double() : cofactor === _4n3 ? this.double().double() : cofactor === _8n2 ? this.double().double().double() : this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      let { x, y } = this.toAffine(), bytes = Fp.toBytes(y);
      return bytes[bytes.length - 1] |= isOdd(x) ? 128 : 0, bytes;
    }
    toHex() {
      return bytesToHex2(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  };
  __publicField(_Point, "BASE", new _Point(CURVE.Gx, CURVE.Gy, Fp.ONE, Fp.mul(CURVE.Gx, CURVE.Gy))), __publicField(_Point, "ZERO", new _Point(Fp.ZERO, Fp.ONE, Fp.ONE, Fp.ZERO)), __publicField(_Point, "Fp", Fp), __publicField(_Point, "Fn", Fn);
  let Point = _Point, normalize = (points) => normalizeZ(Point, points), wnaf = new ScalarMultiplier(Point, randomBytes4);
  return wnaf.bits >= 6 && Point.BASE.precompute(6), Object.freeze(Point.prototype), Object.freeze(Point), Point;
}

// mobile/node_modules/@noble/curves/abstract/montgomery.js
var _0n5 = /* @__PURE__ */ BigInt(0), _1n5 = /* @__PURE__ */ BigInt(1), _2n3 = /* @__PURE__ */ BigInt(2);
function cmask(P, swap) {
  return P + swap - (swap >> _1n5 << _1n5);
}
function cswap(P) {
  let offset = BigInt(6) * P;
  return (mask, x_2, x_3) => {
    let sum = x_2 + x_3, a = ((offset + x_3 - x_2) * mask + x_2) % P;
    return { x_2: a, x_3: sum - a };
  };
}
function validateOpts(curve) {
  return validateObject(curve, {
    P: "bigint",
    type: "string",
    adjustScalarBytes: "function",
    powPminus2: "function"
  }, {
    randomBytes: "function",
    scalarMultBase: "function"
  }), Object.freeze({ ...curve });
}
function montgomery(curveDef) {
  let CURVE = validateOpts(curveDef), { P, type, adjustScalarBytes: adjustScalarBytes2, powPminus2, randomBytes: rand } = CURVE, mulBaseHook = CURVE.scalarMultBase, is25519 = type === "x25519";
  if (!is25519 && type !== "x448")
    throw new Error("invalid type");
  let randomBytes_ = rand === void 0 ? randomBytes2 : rand, montgomeryBits = is25519 ? 255 : 448, swap = cswap(P), fieldLen = is25519 ? 32 : 56, Gu = BigInt(is25519 ? 9 : 5), a24 = BigInt(is25519 ? 121665 : 39081), minScalar = is25519 ? _2n3 ** BigInt(254) : _2n3 ** BigInt(447), maxAdded = is25519 ? BigInt(8) * (_2n3 ** BigInt(251) - _1n5) : BigInt(4) * (_2n3 ** BigInt(445) - _1n5), maxScalar = minScalar + maxAdded + _1n5, modP = (n) => mod(n, P), GuBytes = encodeU(Gu);
  function encodeU(u) {
    return numberToBytesLE(modP(u), fieldLen);
  }
  function decodeU(u) {
    let _u = copyBytes(abytes2(u, fieldLen, "uCoordinate"));
    return is25519 && (_u[31] &= 127), modP(bytesToNumberLE(_u));
  }
  function decodeScalar(scalar) {
    return bytesToNumberLE(adjustScalarBytes2(copyBytes(abytes2(scalar, fieldLen, "scalar"))));
  }
  let lowOrderU = new Set(is25519 ? [
    _0n5,
    _1n5,
    P - _1n5,
    BigInt("325606250916557431795983626356110631294008115727848805560023387167927233504"),
    BigInt("39382357235489614581723060781553021112529911719440698176882885853963445705823")
  ] : [_0n5, _1n5, P - _1n5]);
  function scalarMult(scalar, u) {
    let pointU = decodeU(u);
    if (lowOrderU.has(pointU))
      throw new Error("invalid private or public key received");
    let pu = montgomeryLadder(pointU, decodeScalar(scalar));
    if (pu === _0n5)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  function scalarMultBase(scalar) {
    if (mulBaseHook === void 0)
      return scalarMult(scalar, GuBytes);
    let k = decodeScalar(scalar);
    aInRange("scalar", k, minScalar, maxScalar);
    let pu = modP(mulBaseHook(k));
    if (pu === _0n5)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  let getPublicKey = scalarMultBase, getSharedSecret = scalarMult;
  function montgomeryLadder(u, scalar) {
    aInRange("u", u, _0n5, P), aInRange("scalar", scalar, minScalar, maxScalar);
    let k = scalar, x_1 = u, x_2 = _1n5, z_2 = _0n5, x_3 = u, z_3 = _1n5, kx = k ^ k >> _1n5;
    for (let t = BigInt(montgomeryBits - 1); t >= _0n5; t--) {
      let mask2 = cmask(P, kx >> t);
      ({ x_2, x_3 } = swap(mask2, x_2, x_3)), { x_2: z_2, x_3: z_3 } = swap(mask2, z_2, z_3);
      let A = x_2 + z_2, AA = modP(A * A), B = x_2 - z_2, BB = modP(B * B), E = AA - BB, C = x_3 + z_3, D = x_3 - z_3, DA = modP(D * A), CB = modP(C * B), dacb = DA + CB, da_cb = DA - CB;
      x_3 = modP(dacb * dacb), z_3 = modP(x_1 * modP(da_cb * da_cb)), x_2 = modP(AA * BB), z_2 = modP(E * (AA + modP(a24 * E)));
    }
    let mask = cmask(P, k);
    ({ x_2, x_3 } = swap(mask, x_2, x_3)), { x_2: z_2, x_3: z_3 } = swap(mask, z_2, z_3);
    let z2 = powPminus2(z_2);
    return modP(x_2 * z2);
  }
  let lengths = {
    secretKey: fieldLen,
    publicKey: fieldLen,
    seed: fieldLen
  }, randomSecretKey = (seed) => (seed = seed === void 0 ? randomBytes_(fieldLen) : seed, abytes2(seed, lengths.seed, "seed"), seed), utils = { randomSecretKey };
  return Object.freeze(lengths), Object.freeze(utils), Object.freeze({
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
var _0n6 = /* @__PURE__ */ BigInt(0), _1n6 = /* @__PURE__ */ BigInt(1), _2n4 = /* @__PURE__ */ BigInt(2), _3n2 = /* @__PURE__ */ BigInt(3), _5n2 = /* @__PURE__ */ BigInt(5), _8n3 = /* @__PURE__ */ BigInt(8), ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed"), ed25519_CURVE = {
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
};
function ed25519_pow_2_252_3(x) {
  let _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80), P = ed25519_CURVE_p, b2 = x * x % P * x % P, b4 = pow2(b2, _2n4, P) * b2 % P, b5 = pow2(b4, _1n6, P) * x % P, b10 = pow2(b5, _5n2, P) * b5 % P, b20 = pow2(b10, _10n, P) * b10 % P, b40 = pow2(b20, _20n, P) * b20 % P, b80 = pow2(b40, _40n, P) * b40 % P, b160 = pow2(b80, _80n, P) * b80 % P, b240 = pow2(b160, _80n, P) * b80 % P, b250 = pow2(b240, _10n, P) * b10 % P;
  return { pow_p_5_8: pow2(b250, _2n4, P) * x % P, b2 };
}
function adjustScalarBytes(bytes) {
  return bytes[0] &= 248, bytes[31] &= 127, bytes[31] |= 64, bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  let P = ed25519_CURVE_p, v3 = mod(v * v * v, P), v7 = mod(v3 * v3 * v, P), pow3 = ed25519_pow_2_252_3(u * v7).pow_p_5_8, x = mod(u * v3 * pow3, P), vx2 = mod(v * x * x, P), root1 = x, root2 = mod(x * ED25519_SQRT_M1, P), useRoot1 = vx2 === u, useRoot2 = vx2 === mod(-u, P), noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  return useRoot1 && (x = root1), (useRoot2 || noRoot) && (x = root2), isNegativeLE(x, P) && (x = mod(-x, P)), { isValid: useRoot1 || useRoot2, value: x };
}
var ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE, { uvRatio });
var x25519 = /* @__PURE__ */ (() => {
  let P = ed25519_CURVE_p, powPminus2 = (x) => {
    let { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
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
      let kn = mod(k, ed25519_Point.Fn.ORDER);
      if (kn === _0n6)
        return _0n6;
      let p = ed25519_Point.BASE.multiply(kn);
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
  if (typeof value != "boolean")
    throw new TypeError(atitle3(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function anumber3(n, title = "") {
  if (typeof n != "number")
    throw new TypeError(atitle3(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle3(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes3(value, length, title = "") {
  if (isBytes3(value) && (length === void 0 || value.length === length))
    return value;
  length !== void 0 && anumber3(length, "length");
  let bytes = isBytes3(value), ofLen = length !== void 0 ? ` of length ${length}` : "", got = bytes ? `length=${value.length}` : `type=${typeof value}`, message = atitle3(title) + "expected Uint8Array" + ofLen + ", got " + got;
  throw bytes ? new RangeError(message) : new TypeError(message);
}
var aobject3 = (value, label) => {
  if (value === null || typeof value != "object" || Array.isArray(value))
    throw new TypeError(label === "object" ? "expected valid options object" : `"${label}" expected object, got type=${typeof value}`);
};
function aexists2(instance, checkFinished = !0) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput2(out, instance) {
  abytes3(out, void 0, "output");
  let min = instance.outputLen;
  if (!(out.length >= min))
    throw new RangeError('"output" expected length >= ' + min);
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean2(...arrays) {
  for (let i = 0; i < arrays.length; i++)
    arrays[i].fill(0);
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68;
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++)
    arr[i] = byteSwap(arr[i]);
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
function overlapBytes(a, b) {
  return !a.byteLength || !b.byteLength ? !1 : a.buffer === b.buffer && // best we can do, may fail with an obscure Proxy
  a.byteOffset < b.byteOffset + b.byteLength && // a starts before b end
  b.byteOffset < a.byteOffset + a.byteLength;
}
function complexOverlapBytes(input, output) {
  if (overlapBytes(input, output) && input.byteOffset < output.byteOffset)
    throw new Error("complex overlap of input and output is not supported");
}
function checkOpts2(defaults, opts) {
  return aobject3(defaults, "defaults"), aobject3(opts, "opts"), Object.assign(defaults, opts);
}
function equalBytes(a, b) {
  if (a = abytes3(a), b = abytes3(b), a.length !== b.length)
    return !1;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function wrapMacConstructor(keyLen, macCons, fromMsg) {
  let mac = macCons, getArgs = fromMsg || (() => []), macC = (msg, key) => mac(key, ...getArgs(msg)).update(msg).digest(), tmp = mac(new Uint8Array(keyLen), ...getArgs(new Uint8Array(0)));
  return macC.outputLen = tmp.outputLen, macC.blockLen = tmp.blockLen, macC.create = (key, ...args) => mac(key, ...args), macC;
}
var wrapCipher = /* @__NO_SIDE_EFFECTS__ */ (params, constructor) => {
  function wrappedCipher(key, ...args) {
    if (abytes3(key, void 0, "key"), params.nonceLength !== void 0) {
      let nonce = args[0];
      abytes3(nonce, params.varSizeNonce ? void 0 : params.nonceLength, "nonce");
    }
    let tagl = params.tagLength, aadStart = params.nonceLength !== void 0 ? 1 : 0;
    if (!params.withAAD) {
      for (let i = aadStart; i < args.length; i++)
        if (isBytes3(args[i]))
          throw new Error("AAD not supported");
    }
    params.withAAD && args[aadStart] !== void 0 && abytes3(args[aadStart], void 0, "AAD");
    let cipher = constructor(key, ...args), checkOutput = (fnLength, output) => {
      if (output !== void 0) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes3(output, void 0, "output");
      }
    }, called = !1;
    return {
      encrypt(data, output) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        return called = !0, abytes3(data, void 0, "data"), checkOutput(cipher.encrypt.length, output), cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        if (abytes3(data, void 0, "data"), tagl && data.length < tagl)
          throw new Error('"ciphertext" expected length >= tagLength=' + tagl);
        return checkOutput(cipher.decrypt.length, output), cipher.decrypt(data, output);
      }
    };
  }
  return Object.assign(wrappedCipher, params), wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = !0) {
  if (out === void 0)
    return new Uint8Array(expectedLength);
  if (abytes3(out, expectedLength, "output"), onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function u64Lengths(dataLength, aadLength, isLE2) {
  anumber3(dataLength), anumber3(aadLength), abool2(isLE2);
  let num = new Uint8Array(16), view = createView2(num);
  return view.setBigUint64(0, BigInt(aadLength), isLE2), view.setBigUint64(8, BigInt(dataLength), isLE2), num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes2(bytes) {
  return Uint8Array.from(abytes3(bytes));
}

// mobile/node_modules/@noble/ciphers/_arx.js
var encodeStr = (str) => Uint8Array.from(str.split(""), (c) => c.charCodeAt(0)), sigma16_32 = swap32IfBE(u32(encodeStr("expand 16-byte k"))), sigma32_32 = swap32IfBE(u32(encodeStr("expand 32-byte k")));
function rotl(a, b) {
  return a << b | a >>> 32 - b;
}
var BLOCK_LEN = 64, BLOCK_LEN32 = 16, MAX_COUNTER = 2 ** 32 - 1, U32_EMPTY = /* @__PURE__ */ Uint32Array.of();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
  let len = data.length, block = new Uint8Array(BLOCK_LEN), b32 = u32(block), isAligned = isLE && isAligned32(data) && isAligned32(output), d32 = isAligned ? u32(data) : U32_EMPTY, o32 = isAligned ? u32(output) : U32_EMPTY;
  if (!isLE) {
    for (let pos = 0; pos < len; counter++) {
      if (core(sigma, key, nonce, b32, counter, rounds), swap32IfBE(b32), counter >= MAX_COUNTER)
        throw new Error("arx: counter overflow");
      let take = Math.min(BLOCK_LEN, len - pos);
      for (let j = 0, posj; j < take; j++)
        posj = pos + j, output[posj] = data[posj] ^ block[j];
      pos += take;
    }
    return;
  }
  for (let pos = 0; pos < len; counter++) {
    if (core(sigma, key, nonce, b32, counter, rounds), counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    let take = Math.min(BLOCK_LEN, len - pos);
    if (isAligned && take === BLOCK_LEN) {
      let pos32 = pos / 4;
      if (pos % 4 !== 0)
        throw new Error("arx: invalid block position");
      for (let j = 0, posj; j < BLOCK_LEN32; j++)
        posj = pos32 + j, o32[posj] = d32[posj] ^ b32[j];
      pos += BLOCK_LEN;
      continue;
    }
    for (let j = 0, posj; j < take; j++)
      posj = pos + j, output[posj] = data[posj] ^ block[j];
    pos += take;
  }
}
function createCipher(core, opts) {
  let { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts2({ allowShortKeys: !1, counterLength: 8, counterRight: !1, rounds: 20 }, opts);
  if (typeof core != "function")
    throw new Error("core must be a function");
  return anumber3(counterLength), anumber3(rounds), abool2(counterRight), abool2(allowShortKeys), (key, nonce, data, output, counter = 0) => {
    abytes3(key, void 0, "key"), abytes3(nonce, void 0, "nonce"), abytes3(data, void 0, "data");
    let len = data.length, hasOutput = output !== void 0;
    if (output = getOutput(len, output, !1), hasOutput && complexOverlapBytes(data, output), anumber3(counter), counter < 0 || counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    let toClean = [], l = key.length, k, sigma;
    if (l === 32)
      toClean.push(k = copyBytes2(key)), sigma = sigma32_32;
    else if (l === 16 && allowShortKeys)
      k = new Uint8Array(32), k.set(key), k.set(key, 16), sigma = sigma16_32, toClean.push(k);
    else
      throw abytes3(key, 32, "arx key"), new Error("invalid key size");
    (!isLE || !isAligned32(nonce)) && toClean.push(nonce = copyBytes2(nonce));
    let k32 = u32(k);
    if (extendNonceFn) {
      if (nonce.length !== 24)
        throw new Error("arx: extended nonce must be 24 bytes");
      let n16 = nonce.subarray(0, 16);
      if (isLE)
        extendNonceFn(sigma, k32, u32(n16), k32);
      else {
        let sigmaRaw = swap32IfBE(Uint32Array.from(sigma));
        extendNonceFn(sigmaRaw, k32, u32(n16), k32), clean2(sigmaRaw), swap32IfBE(k32);
      }
      nonce = nonce.subarray(16);
    } else isLE || swap32IfBE(k32);
    let nonceNcLen = 16 - counterLength;
    if (nonceNcLen !== nonce.length)
      throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
    if (nonceNcLen !== 12) {
      let nc = new Uint8Array(12);
      nc.set(nonce, counterRight ? 0 : 12 - nonce.length), nonce = nc, toClean.push(nonce);
    }
    let n32 = swap32IfBE(u32(nonce));
    try {
      return runCipher(core, sigma, k32, n32, data, output, counter, rounds), output;
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
    __publicField(this, "finished", !1);
    __publicField(this, "destroyed", !1);
    key = copyBytes2(abytes3(key, 32, "key"));
    let t0 = u8to16(key, 0), t1 = u8to16(key, 2), t2 = u8to16(key, 4), t3 = u8to16(key, 6), t4 = u8to16(key, 8), t5 = u8to16(key, 10), t6 = u8to16(key, 12), t7 = u8to16(key, 14);
    this.r[0] = t0 & 8191, this.r[1] = (t0 >>> 13 | t1 << 3) & 8191, this.r[2] = (t1 >>> 10 | t2 << 6) & 7939, this.r[3] = (t2 >>> 7 | t3 << 9) & 8191, this.r[4] = (t3 >>> 4 | t4 << 12) & 255, this.r[5] = t4 >>> 1 & 8190, this.r[6] = (t4 >>> 14 | t5 << 2) & 8191, this.r[7] = (t5 >>> 11 | t6 << 5) & 8065, this.r[8] = (t6 >>> 8 | t7 << 8) & 8191, this.r[9] = t7 >>> 5 & 127;
    for (let i = 0; i < 8; i++)
      this.pad[i] = u8to16(key, 16 + 2 * i);
  }
  process(data, offset, isLast = !1) {
    let hibit = isLast ? 0 : 2048, { h, r } = this, r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3], r4 = r[4], r5 = r[5], r6 = r[6], r7 = r[7], r8 = r[8], r9 = r[9], t0 = u8to16(data, offset + 0), t1 = u8to16(data, offset + 2), t2 = u8to16(data, offset + 4), t3 = u8to16(data, offset + 6), t4 = u8to16(data, offset + 8), t5 = u8to16(data, offset + 10), t6 = u8to16(data, offset + 12), t7 = u8to16(data, offset + 14), h0 = h[0] + (t0 & 8191), h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191), h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191), h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191), h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191), h5 = h[5] + (t4 >>> 1 & 8191), h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191), h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191), h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191), h9 = h[9] + (t7 >>> 5 | hibit), c = 0, d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13, d0 &= 8191, d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1), c += d0 >>> 13, d0 &= 8191;
    let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13, d1 &= 8191, d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2), c += d1 >>> 13, d1 &= 8191;
    let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13, d2 &= 8191, d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3), c += d2 >>> 13, d2 &= 8191;
    let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13, d3 &= 8191, d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4), c += d3 >>> 13, d3 &= 8191;
    let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13, d4 &= 8191, d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5), c += d4 >>> 13, d4 &= 8191;
    let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13, d5 &= 8191, d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6), c += d5 >>> 13, d5 &= 8191;
    let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13, d6 &= 8191, d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7), c += d6 >>> 13, d6 &= 8191;
    let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13, d7 &= 8191, d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8), c += d7 >>> 13, d7 &= 8191;
    let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13, d8 &= 8191, d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9), c += d8 >>> 13, d8 &= 8191;
    let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13, d9 &= 8191, d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0, c += d9 >>> 13, d9 &= 8191, c = (c << 2) + c | 0, c = c + d0 | 0, d0 = c & 8191, c = c >>> 13, d1 += c, h[0] = d0, h[1] = d1, h[2] = d2, h[3] = d3, h[4] = d4, h[5] = d5, h[6] = d6, h[7] = d7, h[8] = d8, h[9] = d9;
  }
  finalize() {
    let { h, pad } = this, g = new Uint16Array(10), c = h[1] >>> 13;
    h[1] &= 8191;
    for (let i = 2; i < 10; i++)
      h[i] += c, c = h[i] >>> 13, h[i] &= 8191;
    h[0] += c * 5, c = h[0] >>> 13, h[0] &= 8191, h[1] += c, c = h[1] >>> 13, h[1] &= 8191, h[2] += c, g[0] = h[0] + 5, c = g[0] >>> 13, g[0] &= 8191;
    for (let i = 1; i < 10; i++)
      g[i] = h[i] + c, c = g[i] >>> 13, g[i] &= 8191;
    g[9] -= 8192;
    let mask = (c ^ 1) - 1;
    for (let i = 0; i < 10; i++)
      g[i] &= mask;
    mask = ~mask;
    for (let i = 0; i < 10; i++)
      h[i] = h[i] & mask | g[i];
    h[0] = (h[0] | h[1] << 13) & 65535, h[1] = (h[1] >>> 3 | h[2] << 10) & 65535, h[2] = (h[2] >>> 6 | h[3] << 7) & 65535, h[3] = (h[3] >>> 9 | h[4] << 4) & 65535, h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535, h[5] = (h[6] >>> 2 | h[7] << 11) & 65535, h[6] = (h[7] >>> 5 | h[8] << 8) & 65535, h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
    let f = h[0] + pad[0];
    h[0] = f & 65535;
    for (let i = 1; i < 8; i++)
      f = (h[i] + pad[i] | 0) + (f >>> 16) | 0, h[i] = f & 65535;
    clean2(g);
  }
  update(data) {
    aexists2(this), abytes3(data), data = copyBytes2(data);
    let { buffer, blockLen } = this, len = data.length;
    for (let pos = 0; pos < len; ) {
      let take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos), this.pos += take, pos += take, this.pos === blockLen && (this.process(buffer, 0, !1), this.pos = 0);
    }
    return this;
  }
  destroy() {
    this.destroyed = !0, clean2(this.h, this.r, this.buffer, this.pad);
  }
  digestInto(out) {
    aexists2(this), aoutput2(out, this), this.finished = !0;
    let { buffer, h } = this, { pos } = this;
    if (pos) {
      for (buffer[pos++] = 1; pos < 16; pos++)
        buffer[pos] = 0;
      this.process(buffer, 0, !0);
    }
    this.finalize();
    let opos = 0;
    for (let i = 0; i < 8; i++)
      out[opos++] = h[i] >>> 0, out[opos++] = h[i] >>> 8;
  }
  digest() {
    let { buffer, outputLen } = this;
    this.digestInto(buffer);
    let res = buffer.slice(0, outputLen);
    return this.destroy(), res;
  }
}, poly1305 = /* @__PURE__ */ wrapMacConstructor(32, (key) => new Poly1305(key));

// mobile/node_modules/@noble/ciphers/chacha.js
function chachaCore(s, k, n, out, cnt, rounds = 20) {
  let y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2], x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
  for (let r = 0; r < rounds; r += 2)
    x00 = x00 + x04 | 0, x12 = rotl(x12 ^ x00, 16), x08 = x08 + x12 | 0, x04 = rotl(x04 ^ x08, 12), x00 = x00 + x04 | 0, x12 = rotl(x12 ^ x00, 8), x08 = x08 + x12 | 0, x04 = rotl(x04 ^ x08, 7), x01 = x01 + x05 | 0, x13 = rotl(x13 ^ x01, 16), x09 = x09 + x13 | 0, x05 = rotl(x05 ^ x09, 12), x01 = x01 + x05 | 0, x13 = rotl(x13 ^ x01, 8), x09 = x09 + x13 | 0, x05 = rotl(x05 ^ x09, 7), x02 = x02 + x06 | 0, x14 = rotl(x14 ^ x02, 16), x10 = x10 + x14 | 0, x06 = rotl(x06 ^ x10, 12), x02 = x02 + x06 | 0, x14 = rotl(x14 ^ x02, 8), x10 = x10 + x14 | 0, x06 = rotl(x06 ^ x10, 7), x03 = x03 + x07 | 0, x15 = rotl(x15 ^ x03, 16), x11 = x11 + x15 | 0, x07 = rotl(x07 ^ x11, 12), x03 = x03 + x07 | 0, x15 = rotl(x15 ^ x03, 8), x11 = x11 + x15 | 0, x07 = rotl(x07 ^ x11, 7), x00 = x00 + x05 | 0, x15 = rotl(x15 ^ x00, 16), x10 = x10 + x15 | 0, x05 = rotl(x05 ^ x10, 12), x00 = x00 + x05 | 0, x15 = rotl(x15 ^ x00, 8), x10 = x10 + x15 | 0, x05 = rotl(x05 ^ x10, 7), x01 = x01 + x06 | 0, x12 = rotl(x12 ^ x01, 16), x11 = x11 + x12 | 0, x06 = rotl(x06 ^ x11, 12), x01 = x01 + x06 | 0, x12 = rotl(x12 ^ x01, 8), x11 = x11 + x12 | 0, x06 = rotl(x06 ^ x11, 7), x02 = x02 + x07 | 0, x13 = rotl(x13 ^ x02, 16), x08 = x08 + x13 | 0, x07 = rotl(x07 ^ x08, 12), x02 = x02 + x07 | 0, x13 = rotl(x13 ^ x02, 8), x08 = x08 + x13 | 0, x07 = rotl(x07 ^ x08, 7), x03 = x03 + x04 | 0, x14 = rotl(x14 ^ x03, 16), x09 = x09 + x14 | 0, x04 = rotl(x04 ^ x09, 12), x03 = x03 + x04 | 0, x14 = rotl(x14 ^ x03, 8), x09 = x09 + x14 | 0, x04 = rotl(x04 ^ x09, 7);
  let oi = 0;
  out[oi++] = y00 + x00 | 0, out[oi++] = y01 + x01 | 0, out[oi++] = y02 + x02 | 0, out[oi++] = y03 + x03 | 0, out[oi++] = y04 + x04 | 0, out[oi++] = y05 + x05 | 0, out[oi++] = y06 + x06 | 0, out[oi++] = y07 + x07 | 0, out[oi++] = y08 + x08 | 0, out[oi++] = y09 + x09 | 0, out[oi++] = y10 + x10 | 0, out[oi++] = y11 + x11 | 0, out[oi++] = y12 + x12 | 0, out[oi++] = y13 + x13 | 0, out[oi++] = y14 + x14 | 0, out[oi++] = y15 + x15 | 0;
}
var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: !1,
  counterLength: 4,
  allowShortKeys: !1
});
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16), updatePadded = (h, msg) => {
  h.update(msg);
  let leftover = msg.length % 16;
  leftover && h.update(ZEROS16.subarray(leftover));
}, ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, ciphertext, AAD) {
  AAD !== void 0 && abytes3(AAD, void 0, "AAD");
  let authKey = fn(key, nonce, ZEROS32), lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, !0), h = poly1305.create(authKey);
  AAD && updatePadded(h, AAD), updatePadded(h, ciphertext), h.update(lengths);
  let res = h.digest();
  return clean2(authKey, lengths), res;
}
var _poly1305_aead = (xorStream) => (key, nonce, AAD) => ({
  encrypt(plaintext, output) {
    let plength = plaintext.length;
    output = getOutput(plength + 16, output, !1), output.set(plaintext);
    let oPlain = output.subarray(0, -16);
    xorStream(key, nonce, oPlain, oPlain, 1);
    let tag = computeTag(xorStream, key, nonce, oPlain, AAD);
    return output.set(tag, plength), clean2(tag), output;
  },
  decrypt(ciphertext, output) {
    output = getOutput(ciphertext.length - 16, output, !1);
    let data = ciphertext.subarray(0, -16), passedTag = ciphertext.subarray(-16), tag = computeTag(xorStream, key, nonce, data, AAD);
    if (!equalBytes(passedTag, tag))
      throw clean2(tag), new Error("invalid tag");
    return output.set(ciphertext.subarray(0, -16)), xorStream(key, nonce, output, output, 1), clean2(tag), output;
  }
}), chacha20poly1305 = /* @__PURE__ */ wrapCipher(
  { blockSize: 64, nonceLength: 12, tagLength: 16, withAAD: !0 },
  /* @__PURE__ */ _poly1305_aead(chacha20)
);

// mobile/node_modules/@noble/hashes/hmac.js
var _HMAC = class {
  constructor(hash, key) {
    __publicField(this, "oHash");
    __publicField(this, "iHash");
    __publicField(this, "blockLen");
    __publicField(this, "outputLen");
    __publicField(this, "canXOF", !1);
    __publicField(this, "finished", !1);
    __publicField(this, "destroyed", !1);
    if (ahash(hash), abytes(key, void 0, "key"), this.iHash = hash.create(), typeof this.iHash.update != "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen, this.outputLen = this.iHash.outputLen;
    let blockLen = this.blockLen, pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad), this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 106;
    this.oHash.update(pad), clean(pad);
  }
  update(buf) {
    return aexists(this), this.iHash.update(buf), this;
  }
  digestInto(out) {
    aexists(this), aoutput(out, this), this.finished = !0;
    let buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf), this.oHash.update(buf), this.oHash.digestInto(buf), this.destroy();
  }
  digest() {
    let out = new Uint8Array(this.oHash.outputLen);
    return this.digestInto(out), out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    let { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    return to = to, to.finished = finished, to.destroyed = destroyed, to.blockLen = blockLen, to.outputLen = outputLen, to.canXOF = canXOF, to.oHash = oHash._cloneInto(to.oHash), to.iHash = iHash._cloneInto(to.iHash), to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = !0, this.oHash.destroy(), this.iHash.destroy();
  }
}, hmac = /* @__PURE__ */ (() => {
  let hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
  return hmac_.create = (hash, key) => new _HMAC(hash, key), hmac_;
})();

// mobile/node_modules/@noble/hashes/hkdf.js
var HKDF_COUNTER = /* @__PURE__ */ Uint8Array.of(0), EMPTY_BUFFER = /* @__PURE__ */ Uint8Array.of();
function expand(hash, prk, info, length = 32, _recycled) {
  ahash(hash), anumber(length, "length"), abytes(prk, void 0, "prk");
  let olen = hash.outputLen;
  if (prk.length < olen)
    throw new Error('"prk" must be at least HashLen octets');
  if (length > 255 * olen)
    throw new Error("Length must be <= 255*HashLen");
  let blocks = Math.ceil(length / olen);
  if (info === void 0 ? info = EMPTY_BUFFER : abytes(info, void 0, "info"), !blocks)
    return _recycled && clean(prk), new Uint8Array();
  let okm = _recycled && blocks === 1 ? prk : new Uint8Array(blocks * olen), { iHash, oHash } = hmac.create(hash, prk), T = _recycled ? prk : new Uint8Array(olen), worker = blocks > 1 ? _recycled?.iHash || hash.create() : void 0;
  for (let counter = 0; counter < blocks - 1; counter++) {
    HKDF_COUNTER[0] = counter + 1;
    let iWork = iHash._cloneInto(worker);
    counter && iWork.update(T), iWork.update(info).update(HKDF_COUNTER).digestInto(T), oHash._cloneInto(worker).update(T).digestInto(T), okm.set(T, olen * counter);
  }
  if (HKDF_COUNTER[0] = blocks, blocks > 1 && iHash.update(T), iHash.update(info).update(HKDF_COUNTER).digestInto(T), oHash.update(T).digestInto(T), okm.set(T, olen * (blocks - 1)), iHash.destroy(), oHash.destroy(), worker?.destroy(), T !== okm && clean(T), clean(HKDF_COUNTER), length === okm.length)
    return okm;
  let res = okm.slice(0, length);
  return clean(okm), res;
}
var hkdf = (hash, ikm, salt, info, length) => {
  ahash(hash), salt === void 0 && (salt = new Uint8Array(hash.outputLen));
  let HMAC = hmac.create(hash, salt).update(ikm);
  return expand(hash, HMAC.digest(), info, length, HMAC);
};

// lib/remote/noise.mjs
var MAX_NOISE_MESSAGE = 65535, MAX_PLAINTEXT = 65519, KEY_LEN = 32, TAG_LEN = 16, MAC_LEN = 16, COOKIE_TYPE = 127;
var CARRIERS = Object.freeze(["lan", "tailscale", "relay"]), DHLEN = 32, HASHLEN = 32, MAX_NONCE = 0xffffffffffffffffn, EMPTY = new Uint8Array(0), utf8 = new TextEncoder(), ERROR_MESSAGES = Object.freeze({
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
}), NoiseError = class extends Error {
  /** @param {keyof typeof ERROR_MESSAGES} code */
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.ARG), this.name = "NoiseError", this.code = ERROR_MESSAGES[code] ? code : "ARG";
  }
}, fail = (code) => new NoiseError(code);
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
  for (let p of parts) n += p.length;
  let out = new Uint8Array(n), o = 0;
  for (let p of parts)
    out.set(p, o), o += p.length;
  return out;
}
function wipe(...arrays) {
  for (let a of arrays) a && typeof a.fill == "function" && a.fill(0);
}
var HEX = "0123456789abcdef";
function bytesToHex3(bytes) {
  if (!isBytes4(bytes)) throw fail("ARG");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}
function hexToBytes3(hex2) {
  if (typeof hex2 != "string" || hex2.length % 2 || /[^0-9a-fA-F]/.test(hex2)) throw fail("ARG");
  let out = new Uint8Array(hex2.length / 2);
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
  if (random == null) return defaultRandom;
  if (typeof random != "function") throw fail("ARG");
  return random;
}
function freshKey(random) {
  let k = random(KEY_LEN);
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
  let sk = freshKey(pickRandom(random));
  return { privateKey: sk, publicKey: publicOf(sk) };
}
function deviceId(publicKey) {
  return bytesToHex3(sha256(key32(publicKey)));
}
function noiseHkdf(chainingKey, inputKeyMaterial, n) {
  let temp = hmac(sha256, chainingKey, inputKeyMaterial), o1 = hmac(sha256, temp, Uint8Array.of(1)), o2 = hmac(sha256, temp, concat(o1, Uint8Array.of(2))), o3 = null;
  return n === 3 && (o3 = hmac(sha256, temp, concat(o2, Uint8Array.of(3)))), wipe(temp), n === 3 ? [o1, o2, o3] : [o1, o2];
}
function nonceBytes(n) {
  let out = new Uint8Array(12);
  return new DataView(out.buffer).setBigUint64(4, n, !0), out;
}
var _k, _n, _wiped, CipherState = class {
  /** @param {Uint8Array|null} [key] 32-byte key, or nothing for the empty (pass-through) state. The key is copied. */
  constructor(key = null) {
    __privateAdd(this, _k, null);
    __privateAdd(this, _n, 0n);
    __privateAdd(this, _wiped, !1);
    key != null && __privateSet(this, _k, key32(key));
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
    if (typeof n == "bigint") v = n;
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
    return __privateSet(this, _n, __privateGet(this, _n) + 1n), out;
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
    return __privateSet(this, _n, __privateGet(this, _n) + 1n), out;
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
    __privateGet(this, _k) && wipe(__privateGet(this, _k)), __privateSet(this, _k, null), __privateSet(this, _wiped, !0);
  }
};
_k = new WeakMap(), _n = new WeakMap(), _wiped = new WeakMap();
var _SymmetricState_instances, setKey_fn, SymmetricState = class {
  constructor(protocolName) {
    __privateAdd(this, _SymmetricState_instances);
    __publicField(this, "ck");
    __publicField(this, "h");
    __publicField(this, "cs");
    let name = utf8.encode(protocolName);
    name.length <= HASHLEN ? (this.h = new Uint8Array(HASHLEN), this.h.set(name)) : this.h = sha256(name), this.ck = new Uint8Array(this.h), this.cs = new CipherState();
  }
  hasKey() {
    return this.cs.hasKey();
  }
  mixKey(inputKeyMaterial) {
    let [ck, k] = noiseHkdf(this.ck, inputKeyMaterial, 2);
    wipe(this.ck), this.ck = ck, __privateMethod(this, _SymmetricState_instances, setKey_fn).call(this, k);
  }
  mixHash(data) {
    this.h = sha256(concat(this.h, data));
  }
  mixKeyAndHash(inputKeyMaterial) {
    let [ck, tempH, k] = noiseHkdf(this.ck, inputKeyMaterial, 3);
    wipe(this.ck), this.ck = ck, this.mixHash(tempH), wipe(tempH), __privateMethod(this, _SymmetricState_instances, setKey_fn).call(this, k);
  }
  encryptAndHash(plaintext) {
    let ct = this.cs.encryptWithAd(this.h, plaintext);
    return this.mixHash(ct), ct;
  }
  decryptAndHash(ciphertext) {
    let pt = this.cs.decryptWithAd(this.h, ciphertext);
    return this.mixHash(ciphertext), pt;
  }
  /** Split(): returns [c1, c2] and clears the chaining key and the handshake cipher. */
  split() {
    let [k1, k2] = noiseHkdf(this.ck, EMPTY, 2), c1 = new CipherState(k1), c2 = new CipherState(k2);
    return wipe(k1, k2), this.wipe(), [c1, c2];
  }
  /** Clears ck and the handshake cipher (h is not secret and is kept for the handshake hash). */
  wipe() {
    wipe(this.ck), this.cs.wipe();
  }
};
_SymmetricState_instances = new WeakSet(), setKey_fn = function(k) {
  this.cs.wipe(), this.cs = new CipherState(k), wipe(k);
};
var PATTERNS = Object.freeze({
  IK: Object.freeze({ name: "IK", psk: !1, messages: Object.freeze([["e", "es", "s", "ss"], ["e", "ee", "se"]]) }),
  IKpsk2: Object.freeze({ name: "IKpsk2", psk: !0, messages: Object.freeze([["e", "es", "s", "ss"], ["e", "ee", "se", "psk"]]) })
}), _pattern, _initiator, _random, _ss, _s, _sPub, _e, _rs, _re, _psk, _index, _dead, _done, _HandshakeState_instances, minLength_fn, guard_fn, dhToken_fn, clearKeys_fn, HandshakeState = class {
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
    __privateAdd(this, _dead, !1);
    __privateAdd(this, _done, !1);
    __publicField(this, "protocolName");
    __privateSet(this, _pattern, pattern), __privateSet(this, _initiator, initiator), __privateSet(this, _random, pickRandom(random)), this.protocolName = "Noise_" + pattern.name + "_25519_ChaChaPoly_SHA256";
    let prologueBytes = copyBytes3(pro);
    __privateSet(this, _s, key32(staticPrivate));
    try {
      __privateSet(this, _sPub, publicOf(__privateGet(this, _s))), pattern.psk && __privateSet(this, _psk, key32(psk)), initiator && __privateSet(this, _rs, key32(remoteStaticPublic)), __privateSet(this, _ss, new SymmetricState(this.protocolName)), __privateGet(this, _ss).mixHash(prologueBytes), __privateGet(this, _ss).mixHash(initiator ? __privateGet(this, _rs) : __privateGet(this, _sPub));
    } catch (err) {
      throw this.wipe(), err;
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
    __privateMethod(this, _HandshakeState_instances, guard_fn).call(this, !0);
    let body = copyBytes3(payload);
    if (__privateMethod(this, _HandshakeState_instances, minLength_fn).call(this, __privateGet(this, _index)) + body.length > MAX_NOISE_MESSAGE) throw fail("TOO_BIG");
    try {
      let parts = [];
      for (let token of __privateGet(this, _pattern).messages[__privateGet(this, _index)])
        if (token === "e") {
          __privateSet(this, _e, freshKey(__privateGet(this, _random)));
          let ePub = publicOf(__privateGet(this, _e));
          parts.push(ePub), __privateGet(this, _ss).mixHash(ePub), __privateGet(this, _pattern).psk && __privateGet(this, _ss).mixKey(ePub);
        } else token === "s" ? parts.push(__privateGet(this, _ss).encryptAndHash(__privateGet(this, _sPub))) : token === "psk" ? __privateGet(this, _ss).mixKeyAndHash(__privateGet(this, _psk)) : __privateMethod(this, _HandshakeState_instances, dhToken_fn).call(this, token);
      return parts.push(__privateGet(this, _ss).encryptAndHash(body)), __privateSet(this, _index, __privateGet(this, _index) + 1), concat(...parts);
    } catch (err) {
      throw this.wipe(), err instanceof NoiseError && (err.code === "TOO_BIG" || err.code === "RANDOM") ? err : fail("HANDSHAKE");
    }
  }
  readMessage(message) {
    if (__privateMethod(this, _HandshakeState_instances, guard_fn).call(this, !1), !isBytes4(message)) throw fail("ARG");
    try {
      if (message.length > MAX_NOISE_MESSAGE || message.length < __privateMethod(this, _HandshakeState_instances, minLength_fn).call(this, __privateGet(this, _index))) throw fail("HANDSHAKE");
      let off = 0;
      for (let token of __privateGet(this, _pattern).messages[__privateGet(this, _index)])
        if (token === "e")
          __privateSet(this, _re, message.slice(off, off + DHLEN)), off += DHLEN, __privateGet(this, _ss).mixHash(__privateGet(this, _re)), __privateGet(this, _pattern).psk && __privateGet(this, _ss).mixKey(__privateGet(this, _re));
        else if (token === "s") {
          let len = DHLEN + (__privateGet(this, _ss).hasKey() ? TAG_LEN : 0);
          __privateSet(this, _rs, __privateGet(this, _ss).decryptAndHash(message.slice(off, off + len))), off += len;
        } else token === "psk" ? __privateGet(this, _ss).mixKeyAndHash(__privateGet(this, _psk)) : __privateMethod(this, _HandshakeState_instances, dhToken_fn).call(this, token);
      let payload = __privateGet(this, _ss).decryptAndHash(message.slice(off));
      return __privateSet(this, _index, __privateGet(this, _index) + 1), payload;
    } catch {
      throw this.wipe(), fail("HANDSHAKE");
    }
  }
  finish() {
    if (__privateGet(this, _dead) || __privateGet(this, _done)) throw fail("DEAD");
    if (__privateGet(this, _index) !== __privateGet(this, _pattern).messages.length) throw fail("STATE");
    let [c1, c2] = __privateGet(this, _ss).split(), handshakeHash = new Uint8Array(__privateGet(this, _ss).h), remoteStatic = new Uint8Array(__privateGet(this, _rs)), send = __privateGet(this, _initiator) ? c1 : c2, recv = __privateGet(this, _initiator) ? c2 : c1;
    return __privateSet(this, _done, !0), __privateMethod(this, _HandshakeState_instances, clearKeys_fn).call(this), Object.freeze({
      send,
      recv,
      handshakeHash,
      remoteStatic,
      protocol: this.protocolName,
      wipe() {
        send.wipe(), recv.wipe(), wipe(handshakeHash);
      }
    });
  }
  /** Marks the handshake unusable and overwrites its secrets. Safe to call at any time and more than once. */
  wipe() {
    __privateSet(this, _dead, !0), __privateMethod(this, _HandshakeState_instances, clearKeys_fn).call(this), __privateGet(this, _ss) && __privateGet(this, _ss).wipe();
  }
};
_pattern = new WeakMap(), _initiator = new WeakMap(), _random = new WeakMap(), _ss = new WeakMap(), _s = new WeakMap(), _sPub = new WeakMap(), _e = new WeakMap(), _rs = new WeakMap(), _re = new WeakMap(), _psk = new WeakMap(), _index = new WeakMap(), _dead = new WeakMap(), _done = new WeakMap(), _HandshakeState_instances = new WeakSet(), /** Exact byte length of message `index` with an empty payload (tokens only plus the payload tag), from the pattern alone. */
minLength_fn = function(index) {
  let n = 0, keyed = __privateGet(this, _ss).hasKey();
  for (let t of __privateGet(this, _pattern).messages[index])
    t === "e" ? (n += DHLEN, __privateGet(this, _pattern).psk && (keyed = !0)) : t === "s" ? n += DHLEN + (keyed ? TAG_LEN : 0) : keyed = !0;
  return n + (keyed ? TAG_LEN : 0);
}, guard_fn = function(write) {
  if (__privateGet(this, _dead) || __privateGet(this, _done)) throw fail("DEAD");
  if (__privateGet(this, _index) >= __privateGet(this, _pattern).messages.length || (__privateGet(this, _initiator) ? __privateGet(this, _index) % 2 === 0 : __privateGet(this, _index) % 2 === 1) !== write) throw fail("STATE");
}, dhToken_fn = function(token) {
  let [a, b] = token, local = __privateGet(this, _initiator) ? a === "e" ? __privateGet(this, _e) : __privateGet(this, _s) : b === "e" ? __privateGet(this, _e) : __privateGet(this, _s), remote = __privateGet(this, _initiator) ? b === "e" ? __privateGet(this, _re) : __privateGet(this, _rs) : a === "e" ? __privateGet(this, _re) : __privateGet(this, _rs), shared = dh(local, remote);
  __privateGet(this, _ss).mixKey(shared), wipe(shared);
}, clearKeys_fn = function() {
  wipe(__privateGet(this, _s), __privateGet(this, _e), __privateGet(this, _psk)), __privateSet(this, _e, null);
};
function handshakeInitiator(options) {
  if (!options || typeof options != "object") throw fail("ARG");
  let pattern = options.psk === void 0 || options.psk === null ? PATTERNS.IK : PATTERNS.IKpsk2, hs = new HandshakeState({ ...options, pattern, initiator: !0 });
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
  if (offerId == null ? id = new Uint8Array(16) : typeof offerId == "string" ? id = hexToBytes3(offerId) : id = copyBytes3(offerId), id.length !== 16) throw fail("ARG");
  return concat(utf8.encode("plenum-remote/1"), Uint8Array.of(0), utf8.encode(carrier), Uint8Array.of(0), id);
}
var SAS_INFO = utf8.encode("plenum-sas"), PUSH_INFO = utf8.encode("plenum-push"), STOP_INFO = utf8.encode("plenum-stop"), MAC1_LABEL = utf8.encode("plenum-mac1");
function checkedHash(h) {
  if (!isBytes4(h) || h.length !== HASHLEN) throw fail("ARG");
  return h;
}
function sas(handshakeHash) {
  let o = hkdf(sha256, checkedHash(handshakeHash), EMPTY, SAS_INFO, 4), n = ((o[0] << 24 | o[1] << 16 | o[2] << 8 | o[3]) >>> 0) % 1e6;
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
  if (cookie == null) return new Uint8Array(MAC_LEN);
  if (!isBytes4(cookie) || cookie.length !== MAC_LEN) throw fail("ARG");
  return hmac(sha256, cookie, copyBytes3(bodyAndMac1)).slice(0, MAC_LEN);
}
function sealMessage1(desktopPublic, body, cookie) {
  let b = copyBytes3(body);
  if (b.length > MAX_NOISE_MESSAGE) throw fail("TOO_BIG");
  let mac1 = computeMac1(desktopPublic, b), withMac1 = concat(b, mac1);
  return concat(withMac1, computeMac2(cookie, withMac1));
}
function parseCookieReply(bytes) {
  return !isBytes4(bytes) || bytes.length !== 1 + MAC_LEN || bytes[0] !== COOKIE_TYPE ? null : bytes.slice(1);
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
}), FLAG = Object.freeze({ FIN: 1, PRIORITY: 2, COMPRESSED: 4 }), HEADER_BYTES = 6;
var MAX_PLAINTEXT2 = 65519, CHUNK = 32768, BUFFER_CAP = 262144, COALESCE_MS = 30, COALESCE_BELOW = 1024, MAX_STREAMS = 32;
var PING_INTERVAL_MS = 25e3, PING_MISSES_TO_CLOSE = 2, POLL_MS = 10, WIRE_BUDGET_BYTES_PER_SECOND = 1536 * 1024, WIRE_BUDGET_BURST_BYTES = 128 * 1024, NOISE_TAG_BYTES = 16, { HELLO, REQ, BODY, RES, DATA, CANCEL, STOP, STOP_ACK, PING, PONG, EVENT, CLOSE, COOKIE } = TYPE, NAMES = new Map(Object.entries(TYPE).map(([name, code]) => [code, name])), PRIORITY_TYPES = /* @__PURE__ */ new Set([STOP, STOP_ACK, CANCEL, PING, PONG]), CONTROL_TYPES = /* @__PURE__ */ new Set([HELLO, STOP, STOP_ACK, PING, PONG, EVENT, CLOSE, COOKIE]), STREAM_TYPES = /* @__PURE__ */ new Set([REQ, BODY, RES, DATA, CANCEL]), JSON_TYPES = /* @__PURE__ */ new Set([HELLO, REQ, RES, STOP, STOP_ACK, EVENT, CLOSE]), FROM_PHONE = /* @__PURE__ */ new Set([REQ, BODY, STOP]), FROM_DESKTOP = /* @__PURE__ */ new Set([HELLO, RES, DATA, STOP_ACK, EVENT]), KNOWN_FLAGS = FLAG.FIN | FLAG.PRIORITY, EMPTY2 = new Uint8Array(0), utf8Encoder = new TextEncoder(), utf8Decoder = new TextDecoder("utf-8", { fatal: !0 }), FrameError = class extends Error {
  constructor(code, message) {
    super(message), this.name = "FrameError", this.code = code;
  }
}, hex = (n) => `0x${n.toString(16).padStart(2, "0")}`;
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let tag = Object.prototype.toString.call(input);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return new Uint8Array(input);
  throw new TypeError("a frame must be bytes");
}
function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return !1;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return !1;
  return !0;
}
function concatBytes3(parts, total) {
  let out = new Uint8Array(total), at = 0;
  for (let part of parts)
    out.set(part, at), at += part.byteLength;
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
  if (value === null || typeof value != "object" || Array.isArray(value)) throw new FrameError("json", "payload is not a JSON object");
  return value;
}
function jsonBytes(value) {
  if (value === null || typeof value != "object" || Array.isArray(value)) throw new FrameError("json", "JSON payload must be an object");
  return utf8Encoder.encode(JSON.stringify(value));
}
function encodeFrame(type, stream = 0, flags = 0, payload) {
  let body = payload == null ? EMPTY2 : toBytes(payload);
  checkShape(type, stream, flags, body.byteLength);
  let out = new Uint8Array(HEADER_BYTES + body.byteLength);
  return out[0] = type, new DataView(out.buffer).setUint32(1, stream, !1), out[5] = flags | (PRIORITY_TYPES.has(type) ? FLAG.PRIORITY : 0), out.set(body, HEADER_BYTES), out;
}
function encodeJsonFrame(type, stream, flags, value) {
  if (!JSON_TYPES.has(type)) throw new FrameError("type", `${NAMES.get(type) ?? hex(type)} does not carry JSON`);
  return encodeFrame(type, stream, flags, jsonBytes(value));
}
function decodeFrame(input) {
  let bytes = toBytes(input);
  if (bytes.byteLength < HEADER_BYTES) throw new FrameError("short", "frame is shorter than its header");
  let type = bytes[0], stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, !1), flags = bytes[5], payload = bytes.subarray(HEADER_BYTES);
  checkShape(type, stream, flags, payload.byteLength);
  let value = JSON_TYPES.has(type) ? parseObject(payload) : void 0;
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
  let bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}
var StreamTable = class {
  constructor({ localBit, max = MAX_STREAMS }) {
    this.localBit = localBit ? 1 : 0, this.max = max, this.entries = /* @__PURE__ */ new Map(), this.nextLocal = this.localBit ? 1 : 2, this.lastRemote = 0;
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
    let id = this.nextLocal;
    return this.nextLocal += 2, this.entries.set(id, { id, opener: "local", localFin: !1, remoteFin: !1, aborted: !1 }), this.entries.get(id);
  }
  // Admits a stream the other side opened. It must carry the other side's parity and a larger id than any before it.
  admitRemote(id) {
    if (this.isLocal(id)) throw new FrameError("parity", `stream ${id} has this side's parity`);
    if (id <= this.lastRemote) throw new FrameError("order", `stream ${id} is not a new stream`);
    if (this.entries.size >= this.max) throw new FrameError("cap", `more than ${this.max} open streams`);
    return this.lastRemote = id, this.entries.set(id, { id, opener: "remote", localFin: !1, remoteFin: !1, aborted: !1 }), this.entries.get(id);
  }
  delete(id) {
    this.entries.delete(id);
  }
  // True for an id this table once held and has retired. A frame for such an id crossed a CANCEL or a last FIN.
  isStale(id) {
    return this.isLocal(id) ? id < this.nextLocal : id <= this.lastRemote;
  }
}, _FrameSession_instances, dispatch_fn, onOpen_fn, onStreamFrame_fn, onCancel_fn, onPong_fn, onPeerClose_fn, protocol_fn, sendClose_fn, shutdown_fn, stopLiveness_fn, tick_fn, buffered_fn, write_fn, sendPriority_fn, enqueue_fn, admitWire_fn, pump_fn, schedulePoll_fn, writable_fn, sendStreamBytes_fn, chunk_fn, flushCoalesce_fn, dropStream_fn, abort_fn, release_fn, FrameSession = class {
  constructor(options = {}) {
    __privateAdd(this, _FrameSession_instances);
    let { role } = options;
    if (role !== "phone" && role !== "desktop") throw new TypeError("role must be 'phone' or 'desktop'");
    if (!options.transport || typeof options.transport.send != "function" || typeof options.transport.close != "function")
      throw new TypeError("transport needs send(bytes) and close(code, reason)");
    this.role = role, this.transport = options.transport, this.bufferedFn = typeof options.bufferedAmount == "function" ? options.bufferedAmount : null, this.clock = options.clock ?? systemClock(), this.handlers = options.handlers ?? {}, this.coalesceMs = options.coalesceMs ?? COALESCE_MS, this.pollMs = options.pollMs ?? POLL_MS, this.nonce = options.nonce ?? randomNonce, this.streams = new StreamTable({ localBit: role === "phone" ? 1 : 0, max: options.maxStreams ?? MAX_STREAMS }), this.lanes = /* @__PURE__ */ new Map(), this.ready = [], this.coalesce = /* @__PURE__ */ new Map(), this.pollTimer = null, this.live = { intervalMs: 0, limit: 0, outstanding: null, misses: 0, timer: null };
    let rate = Number(options.wireBytesPerSecond ?? 1 / 0), burst = Number(options.wireBurstBytes ?? WIRE_BUDGET_BURST_BYTES);
    this.budget = { rate: rate > 0 ? rate : 1 / 0, burst, tokens: burst, last: this.clock.now() }, this.closed = !1, this.closeReason = null, this.counts = { written: 0, dropped: 0 };
  }
  get isClosed() {
    return this.closed;
  }
  get openStreams() {
    return this.streams.size;
  }
  // True while a PING has been sent and its PONG has not come back (the phone's probe of a session that may have died silently).
  get pingOutstanding() {
    return this.live.outstanding !== null;
  }
  // Takes one transport message in. Returns false once the session is closed.
  receive(input) {
    if (this.closed) return !1;
    let frame;
    try {
      frame = decodeFrame(input);
    } catch (err) {
      return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, err.message), !1;
    }
    return __privateMethod(this, _FrameSession_instances, dispatch_fn).call(this, frame), !this.closed;
  }
  // Phone: opens a stream with a REQ frame. Returns the stream id, or null at the stream cap or when closed.
  // { fin: true } marks a request without a body, so the REQ carries the FIN.
  request(value, { fin = !1 } = {}) {
    if (this.role !== "phone") throw new TypeError("only the phone opens streams (REQ)");
    if (this.closed) return null;
    let payload = jsonBytes(value), entry = this.streams.allocate();
    return entry ? (fin && (entry.localFin = !0), __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, entry.id, REQ, fin ? FLAG.FIN : 0, payload), __privateMethod(this, _FrameSession_instances, release_fn).call(this, entry.id), entry.id) : null;
  }
  // Desktop: answers a stream the phone opened, with a RES frame.
  respond(id, value, { fin = !1 } = {}) {
    if (this.role !== "desktop") throw new TypeError("only the desktop answers (RES)");
    let entry = __privateMethod(this, _FrameSession_instances, writable_fn).call(this, id);
    if (!entry) return !1;
    let payload = jsonBytes(value);
    return fin && (entry.localFin = !0), __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, id, RES, fin ? FLAG.FIN : 0, payload), __privateMethod(this, _FrameSession_instances, release_fn).call(this, id), !0;
  }
  // Phone: request body bytes, cut into BODY frames of at most CHUNK bytes. { fin: true } ends the body.
  body(id, bytes, { fin = !1 } = {}) {
    if (this.role !== "phone") throw new TypeError("only the phone sends BODY");
    return __privateMethod(this, _FrameSession_instances, sendStreamBytes_fn).call(this, BODY, id, bytes, fin);
  }
  // Desktop: response bytes, cut into DATA frames. Small chunks are coalesced for up to COALESCE_MS.
  data(id, bytes, { fin = !1 } = {}) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends DATA");
    let entry = __privateMethod(this, _FrameSession_instances, writable_fn).call(this, id);
    if (!entry) return !1;
    let view = toBytes(bytes);
    if (fin && (entry.localFin = !0), view.byteLength === 0 && !fin) return !0;
    if (view.byteLength >= COALESCE_BELOW)
      __privateMethod(this, _FrameSession_instances, flushCoalesce_fn).call(this, id), __privateMethod(this, _FrameSession_instances, chunk_fn).call(this, DATA, id, view, fin);
    else {
      let pending = this.coalesce.get(id);
      pending || (pending = { parts: [], bytes: 0, fin: !1, timer: null }, this.coalesce.set(id, pending)), pending.parts.push(view.slice()), pending.bytes += view.byteLength, pending.fin = pending.fin || fin, pending.fin || pending.bytes >= COALESCE_BELOW ? __privateMethod(this, _FrameSession_instances, flushCoalesce_fn).call(this, id) : pending.timer === null && (pending.timer = this.clock.setTimeout(() => __privateMethod(this, _FrameSession_instances, flushCoalesce_fn).call(this, id), this.coalesceMs));
    }
    return __privateMethod(this, _FrameSession_instances, release_fn).call(this, id), !0;
  }
  // Either side: aborts a stream. Queued frames of the stream are dropped, a CANCEL goes out at once, and the abort
  // hook runs once. Returns false when the stream is not open here.
  cancel(id) {
    return this.closed ? !1 : __privateMethod(this, _FrameSession_instances, abort_fn).call(this, id, "local");
  }
  // Desktop: HELLO on stream 0, paced like other non-priority frames.
  hello(value) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends HELLO");
    return this.closed ? !1 : (__privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, 0, HELLO, 0, jsonBytes(value)), !0);
  }
  // Desktop: EVENT on stream 0, paced like other non-priority frames.
  event(value) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends EVENT");
    return this.closed ? !1 : (__privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, 0, EVENT, 0, jsonBytes(value)), !0);
  }
  // Phone: STOP on the priority lane.
  stop(value) {
    if (this.role !== "phone") throw new TypeError("only the phone sends STOP");
    return this.closed ? !1 : __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, STOP, 0, jsonBytes(value));
  }
  // Desktop: STOP_ACK on the priority lane.
  stopAck(value) {
    if (this.role !== "desktop") throw new TypeError("only the desktop sends STOP_ACK");
    return this.closed ? !1 : __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, STOP_ACK, 0, jsonBytes(value));
  }
  // PING on the priority lane. The nonce is remembered until its PONG arrives.
  ping() {
    if (this.closed) return !1;
    let nonce = this.nonce();
    return this.live.outstanding = nonce, __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, PING, 0, nonce);
  }
  startLiveness({ intervalMs = PING_INTERVAL_MS, misses = PING_MISSES_TO_CLOSE } = {}) {
    return this.closed ? !1 : (__privateMethod(this, _FrameSession_instances, stopLiveness_fn).call(this), this.live.intervalMs = intervalMs, this.live.limit = misses, this.live.misses = 0, this.live.outstanding = null, this.live.timer = this.clock.setInterval(() => __privateMethod(this, _FrameSession_instances, tick_fn).call(this), intervalMs), __privateMethod(this, _FrameSession_instances, tick_fn).call(this, !0), !0);
  }
  stopLiveness() {
    __privateMethod(this, _FrameSession_instances, stopLiveness_fn).call(this);
  }
  // Sends CLOSE { reason } on the control stream, then closes the transport. Queued frames are dropped.
  close(reason = "normal") {
    this.closed || (__privateMethod(this, _FrameSession_instances, sendClose_fn).call(this, String(reason)), __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, String(reason)));
  }
};
_FrameSession_instances = new WeakSet(), dispatch_fn = function({ type, stream, flags, payload, value }) {
  if (this.role === "phone" && FROM_PHONE.has(type) || this.role === "desktop" && FROM_DESKTOP.has(type))
    return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `${NAMES.get(type)} is not sent to the ${this.role}`);
  let fin = (flags & FLAG.FIN) !== 0;
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
}, onOpen_fn = function(stream, value, fin) {
  let entry;
  try {
    entry = this.streams.admitRemote(stream);
  } catch (err) {
    return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, err.message);
  }
  fin && (entry.remoteFin = !0), this.handlers.req?.(stream, value, fin), __privateMethod(this, _FrameSession_instances, release_fn).call(this, stream);
}, onStreamFrame_fn = function(type, stream, payload, fin, value) {
  let entry = this.streams.get(stream);
  if (!entry)
    return this.streams.isStale(stream) ? void 0 : __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `${NAMES.get(type)} on stream ${stream} that was never opened`);
  if (entry.remoteFin) return __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `${NAMES.get(type)} after FIN on stream ${stream}`);
  fin && (entry.remoteFin = !0), type === BODY ? this.handlers.body?.(stream, payload, fin) : type === DATA ? this.handlers.data?.(stream, payload, fin) : this.handlers.res?.(stream, value, fin), __privateMethod(this, _FrameSession_instances, release_fn).call(this, stream);
}, onCancel_fn = function(stream) {
  if (!this.streams.get(stream))
    return this.streams.isStale(stream) ? void 0 : __privateMethod(this, _FrameSession_instances, protocol_fn).call(this, `CANCEL on stream ${stream} that was never opened`);
  __privateMethod(this, _FrameSession_instances, abort_fn).call(this, stream, "remote");
}, onPong_fn = function(payload) {
  let outstanding = this.live.outstanding;
  outstanding && bytesEqual(outstanding, payload) && (this.live.outstanding = null, this.live.misses = 0);
}, onPeerClose_fn = function(value) {
  this.handlers.close?.(value);
  let reason = typeof value?.reason == "string" ? value.reason.slice(0, 64) : "peer";
  __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, reason);
}, protocol_fn = function(message) {
  this.closed || (this.handlers.protocolError?.(message), __privateMethod(this, _FrameSession_instances, sendClose_fn).call(this, "protocol"), __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, "protocol"));
}, sendClose_fn = function(reason) {
  try {
    this.transport.send(encodeJsonFrame(CLOSE, 0, 0, { reason }));
  } catch {
  }
}, shutdown_fn = function(reason) {
  if (!this.closed) {
    this.closed = !0, this.closeReason = reason, this.pollTimer !== null && (this.clock.clearTimeout(this.pollTimer), this.pollTimer = null);
    for (let pending of this.coalesce.values())
      pending.timer !== null && this.clock.clearTimeout(pending.timer);
    this.coalesce.clear(), __privateMethod(this, _FrameSession_instances, stopLiveness_fn).call(this), this.lanes.clear(), this.ready = [];
    try {
      this.transport.close(reason === "protocol" ? 1002 : 1e3, reason);
    } catch {
    }
    this.handlers.closed?.(reason);
  }
}, stopLiveness_fn = function() {
  this.live.timer !== null && (this.clock.clearInterval(this.live.timer), this.live.timer = null);
}, tick_fn = function(first = !1) {
  if (!this.closed) {
    if (!first && this.live.outstanding !== null && (this.live.misses += 1, this.live.misses >= this.live.limit)) {
      __privateMethod(this, _FrameSession_instances, sendClose_fn).call(this, "timeout"), __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, "timeout");
      return;
    }
    this.ping();
  }
}, buffered_fn = function() {
  return this.bufferedFn ? Number(this.bufferedFn()) || 0 : Number(this.transport.bufferedAmount) || 0;
}, write_fn = function(type, stream, flags, payload) {
  let bytes = encodeFrame(type, stream, flags, payload);
  try {
    this.transport.send(bytes);
  } catch {
    return __privateMethod(this, _FrameSession_instances, shutdown_fn).call(this, "transport"), !1;
  }
  return this.counts.written += 1, !0;
}, sendPriority_fn = function(type, stream, payload) {
  return this.closed ? !1 : __privateMethod(this, _FrameSession_instances, write_fn).call(this, type, stream, 0, payload);
}, enqueue_fn = function(stream, type, flags, payload) {
  checkShape(type, stream, flags, payload.byteLength);
  let lane = this.lanes.get(stream);
  lane || (lane = { id: stream, frames: [], head: 0 }, this.lanes.set(stream, lane)), lane.frames.push({ type, flags, payload }), this.ready.includes(lane) || this.ready.push(lane), __privateMethod(this, _FrameSession_instances, pump_fn).call(this);
}, // Takes the wire bytes of one non-priority frame from the budget. False while the budget is spent; it refills with the clock.
admitWire_fn = function(payloadBytes) {
  let b = this.budget;
  if (!Number.isFinite(b.rate)) return !0;
  let now = this.clock.now();
  b.tokens = Math.min(b.burst, b.tokens + Math.max(0, now - b.last) * b.rate / 1e3), b.last = now;
  let cost = HEADER_BYTES + payloadBytes + NOISE_TAG_BYTES;
  return b.tokens < cost ? !1 : (b.tokens -= cost, !0);
}, // Writes queued frames round robin while the socket's buffer is under the cap and the wire budget has room. When either is not, retries on a timer.
pump_fn = function() {
  for (; !this.closed && this.ready.length > 0; ) {
    if (__privateMethod(this, _FrameSession_instances, buffered_fn).call(this) >= BUFFER_CAP) {
      __privateMethod(this, _FrameSession_instances, schedulePoll_fn).call(this);
      return;
    }
    let head = this.ready[0];
    if (!__privateMethod(this, _FrameSession_instances, admitWire_fn).call(this, head.frames[head.head].payload.byteLength)) {
      __privateMethod(this, _FrameSession_instances, schedulePoll_fn).call(this);
      return;
    }
    let lane = this.ready.shift(), frame = lane.frames[lane.head];
    lane.frames[lane.head] = void 0, lane.head += 1, lane.head < lane.frames.length ? this.ready.push(lane) : (lane.frames = [], lane.head = 0, this.lanes.get(lane.id) === lane && this.lanes.delete(lane.id)), __privateMethod(this, _FrameSession_instances, write_fn).call(this, frame.type, lane.id, frame.flags, frame.payload);
  }
}, schedulePoll_fn = function() {
  this.pollTimer === null && (this.pollTimer = this.clock.setTimeout(() => {
    this.pollTimer = null, __privateMethod(this, _FrameSession_instances, pump_fn).call(this);
  }, this.pollMs));
}, writable_fn = function(id) {
  if (this.closed) return null;
  let entry = this.streams.get(id);
  return !entry || entry.localFin || entry.aborted ? null : entry;
}, sendStreamBytes_fn = function(type, id, bytes, fin) {
  let entry = __privateMethod(this, _FrameSession_instances, writable_fn).call(this, id);
  if (!entry) return !1;
  let data = toBytes(bytes);
  return fin && (entry.localFin = !0), __privateMethod(this, _FrameSession_instances, chunk_fn).call(this, type, id, data, fin), __privateMethod(this, _FrameSession_instances, release_fn).call(this, id), !0;
}, chunk_fn = function(type, id, data, fin) {
  if (data.byteLength === 0) {
    __privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, id, type, fin ? FLAG.FIN : 0, EMPTY2);
    return;
  }
  for (let offset = 0; offset < data.byteLength; offset += CHUNK) {
    let end = Math.min(offset + CHUNK, data.byteLength), last = end === data.byteLength;
    if (__privateMethod(this, _FrameSession_instances, enqueue_fn).call(this, id, type, fin && last ? FLAG.FIN : 0, data.subarray(offset, end)), this.closed) return;
  }
}, flushCoalesce_fn = function(id) {
  let pending = this.coalesce.get(id);
  pending && (this.coalesce.delete(id), pending.timer !== null && this.clock.clearTimeout(pending.timer), __privateMethod(this, _FrameSession_instances, chunk_fn).call(this, DATA, id, concatBytes3(pending.parts, pending.bytes), pending.fin));
}, dropStream_fn = function(id) {
  let lane = this.lanes.get(id);
  lane && (this.counts.dropped += lane.frames.length - lane.head, this.lanes.delete(id), this.ready = this.ready.filter((item) => item !== lane));
  let pending = this.coalesce.get(id);
  pending && (pending.timer !== null && this.clock.clearTimeout(pending.timer), this.coalesce.delete(id));
}, abort_fn = function(id, origin) {
  let entry = this.streams.get(id);
  return !entry || entry.aborted ? !1 : (entry.aborted = !0, __privateMethod(this, _FrameSession_instances, dropStream_fn).call(this, id), this.streams.delete(id), origin === "local" && __privateMethod(this, _FrameSession_instances, sendPriority_fn).call(this, CANCEL, id, EMPTY2), this.handlers.abort?.(id, origin), !0);
}, release_fn = function(id) {
  let entry = this.streams.get(id);
  entry && entry.localFin && entry.remoteFin && this.streams.delete(id);
};

// lib/remote/stop-only.mjs
var STOP_ONLY_TYPE = 126, STOP_ACK_TYPE = 125, STOP_ONLY_VERSION = 1, STOP_ONLY_LEN = 90, STOP_ACK_LEN = 66, PAD_INFO = new TextEncoder().encode("plenum-stop-ack"), COUNT_KEYS = ["cancelled", "drivesStopped", "agentsStopped", "cardsDenied"], HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/;
function hexToBytes4(hex2) {
  let out = new Uint8Array(hex2.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex2.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function key322(k) {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new TypeError("stop key length");
  return k;
}
function equal(a, b) {
  if (a.length !== b.length) return !1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function idBytes(stopId) {
  let b = typeof stopId == "string" ? HEX32.test(stopId) ? hexToBytes4(stopId) : null : stopId;
  if (!(b instanceof Uint8Array) || b.length !== 16) throw new TypeError("stop id");
  return b;
}
function padFor(stopKey2, idB) {
  let msg = new Uint8Array(PAD_INFO.length + 16);
  return msg.set(PAD_INFO), msg.set(idB, PAD_INFO.length), hmac(sha256, stopKey2, msg).subarray(0, 16);
}
function encodeStopOnly({ stopKey: stopKey2, deviceId: deviceId2, counter, stopId }) {
  if (key322(stopKey2), !HEX64.test(String(deviceId2))) throw new TypeError("device id");
  if (!Number.isSafeInteger(counter) || counter < 1) throw new TypeError("counter");
  let out = new Uint8Array(STOP_ONLY_LEN);
  out[0] = STOP_ONLY_TYPE, out[1] = STOP_ONLY_VERSION, out.set(hexToBytes4(deviceId2), 2);
  let view = new DataView(out.buffer);
  return view.setUint32(34, Math.floor(counter / 2 ** 32)), view.setUint32(38, counter >>> 0), out.set(idBytes(stopId), 42), out.set(hmac(sha256, stopKey2, out.subarray(0, 58)), 58), out;
}
function decodeStopAck(stopKey2, bytes, stopId) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== STOP_ACK_LEN || bytes[0] !== STOP_ACK_TYPE || bytes[1] !== STOP_ONLY_VERSION || !(stopKey2 instanceof Uint8Array) || stopKey2.length !== 32) return null;
  let idB = idBytes(stopId);
  if (!equal(bytes.subarray(2, 18), idB) || !equal(hmac(sha256, stopKey2, bytes.subarray(0, 34)), bytes.subarray(34, 66))) return null;
  let plain = bytes.slice(18, 34), pad = padFor(stopKey2, idB);
  for (let i = 0; i < 16; i++) plain[i] ^= pad[i];
  let view = new DataView(plain.buffer), out = {};
  return COUNT_KEYS.forEach((k, i) => {
    out[k] = view.getUint32(i * 4);
  }), out;
}

// mobile/shell/carriers.js
var CARRIER_KINDS = Object.freeze(["lan", "tailscale", "relay"]), MAX_URLS_PER_KIND = 4, MAX_URL_LENGTH = 512;
function ipv4Of(hostname) {
  let m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  let parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}
function isLoopback(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return !0;
  let v4 = ipv4Of(hostname);
  return v4 !== null && v4[0] === 127;
}
function isPrivateV4([a, b]) {
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127;
}
function isPrivateV6(hostname) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return !1;
  let first = hostname.slice(1, -1).split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return !1;
  let value = parseInt(first, 16);
  return value >= 64512 && value <= 65023 || value >= 65152 && value <= 65215;
}
function carrierUrlOk(kind, url) {
  if (!CARRIER_KINDS.includes(kind) || typeof url != "string" || url.length > MAX_URL_LENGTH) return !1;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return !1;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:" || parsed.username || parsed.password) return !1;
  let host = parsed.hostname;
  if (isLoopback(host)) return !0;
  if (kind === "relay") return parsed.protocol === "wss:";
  if (kind === "tailscale") return parsed.protocol === "wss:" && host.endsWith(".ts.net");
  let v4 = ipv4Of(host);
  return v4 ? isPrivateV4(v4) : isPrivateV6(host) || host.endsWith(".local");
}
function usableCarriers(carriers) {
  let out = [], seen = /* @__PURE__ */ new Set();
  for (let entry of Array.isArray(carriers) ? carriers : []) {
    if (!entry || typeof entry != "object" || !CARRIER_KINDS.includes(entry.kind) || seen.has(entry.kind)) continue;
    seen.add(entry.kind);
    let urls = (Array.isArray(entry.urls) ? entry.urls : entry.url ? [entry.url] : []).filter((url) => carrierUrlOk(entry.kind, url)).slice(0, MAX_URLS_PER_KIND);
    urls.length && out.push({ kind: entry.kind, urls });
  }
  return out;
}

// mobile/shell/channel.worker.js
var PROTOCOL = "1.0", DELAYS_MS = Object.freeze([1e3, 2e3, 4e3, 8e3]), RETRY_CAP_MS = 1e4, OFFLINE_ROUNDS = 3, CONNECT_TIMEOUT_MS = 6e3, HANDSHAKE_TIMEOUT_MS = 6e3, COUNTER_TIMEOUT_MS = 1e4, STOP_WINDOW_MS = 6e4, STOP_RESEND_MS = 8e3, RENEW_AFTER_MS = 36e5, RENEW_AFTER_MESSAGES = 1048576, RENEW_CHECK_MS = 6e4, RENEW_DRAIN_MS = 6e4, NOT_KNOWN_ROUNDS = 3, NOT_KNOWN_RETRY_MS = 6e4, PING_INTERVAL_MS2 = 25e3, PING_MISSES = 2, PROBE_MS = 3e3, DEFAULT_CAPS = Object.freeze(["ui-from-desktop", "artifacts-iframe", "push-none", "share", "save"]), CARRIERS2 = Object.freeze(["lan", "tailscale", "relay"]), STOP_ONLY_WAIT_MS = 6e3, MAX_SOCKET_MESSAGE = 65599, PAGE_HEADERS = Object.freeze(["accept", "content-type", "x-plenum-client-id"]), SHELL_HEADERS = Object.freeze([...PAGE_HEADERS, "x-plenum-notify-line"]), SHELL_BRIDGE_PATHS = Object.freeze(["/_bridge/log", "/_bridge/ui-manifest"]), TERMINAL = Object.freeze(["revoked", "update-app", "update-desktop", "closed"]), utf82 = new TextEncoder(), utf8Decode = new TextDecoder();
function b64uToBytes(text) {
  let s = String(text).replace(/-/g, "+").replace(/_/g, "/"), bin = atob(s + "=".repeat((4 - s.length % 4) % 4)), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = "";
  for (let b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function defaultRandom2(n) {
  let out = new Uint8Array(n);
  return globalThis.crypto.getRandomValues(out), out;
}
function asKey(value) {
  let bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : null;
  if (!bytes || bytes.byteLength !== 32) throw new TypeError("key length");
  return new Uint8Array(bytes);
}
var CLOSE_CODE_FAILURES = Object.freeze({ 4001: "host-offline", 4400: "replay", 4401: "unknown", 4429: "rate" }), CODED_FAILURES = Object.freeze(["host-offline", "unknown", "replay", "rate"]);
function closeCodeError(err, sock) {
  let name = CLOSE_CODE_FAILURES[sock.closed?.code];
  if (!name) return err;
  let coded = new Error("closed");
  return coded.code = name, coded;
}
function failureName(err) {
  if (CODED_FAILURES.includes(err?.code)) return err.code;
  if (err instanceof NoiseError) return "handshake";
  let text = String(err?.message ?? err ?? "");
  return /timeout|timed out/i.test(text) ? "timeout" : /closed|close/i.test(text) ? "closed" : /counter/i.test(text) ? "counter" : "error";
}
function openSocket(WebSocketImpl, url, { clock, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = !1, openTimer = null, ws = null, closeInfo = null, handler = null, onCloseFn = null, waiter = null, queue = [], fail2 = (err) => {
      settled || (settled = !0, clock.clearTimeout(openTimer), reject(err));
    }, sock = {
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
        for (handler = fn; handler && queue.length; ) handler(queue.shift());
      },
      set onClose(fn) {
        onCloseFn = fn, closeInfo && fn(closeInfo);
      },
      next(ms = HANDSHAKE_TIMEOUT_MS) {
        return queue.length ? Promise.resolve(queue.shift()) : closeInfo ? Promise.reject(new Error("closed")) : new Promise((res, rej) => {
          let t = clock.setTimeout(() => {
            waiter = null, rej(new Error("timeout"));
          }, ms);
          waiter = {
            resolve: (value) => {
              clock.clearTimeout(t), res(value);
            },
            reject: (err) => {
              clock.clearTimeout(t), rej(err);
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
    ws.binaryType = "arraybuffer", openTimer = clock.setTimeout(() => {
      fail2(new Error("connect timeout"));
      try {
        ws.close();
      } catch {
      }
    }, timeoutMs), ws.addEventListener("open", () => {
      settled || (settled = !0, clock.clearTimeout(openTimer), resolve(sock));
    }), ws.addEventListener("message", (event) => {
      if ((event.data?.byteLength ?? 0) > MAX_SOCKET_MESSAGE) {
        try {
          ws.close(1009, "too-big");
        } catch {
        }
        return;
      }
      let bytes = new Uint8Array(event.data);
      if (handler) handler(bytes);
      else if (waiter) {
        let w = waiter;
        waiter = null, w.resolve(bytes);
      } else queue.push(bytes);
    }), ws.addEventListener("close", (event) => {
      if (closeInfo = { code: event.code, reason: event.reason ?? "" }, settled || fail2(new Error("closed before open")), waiter) {
        let w = waiter;
        waiter = null, w.reject(new Error("closed"));
      }
      onCloseFn?.(closeInfo);
    }), ws.addEventListener("error", () => {
    });
  });
}
function requestPolicy(msg) {
  let scope = msg?.scope === "shell" ? "shell" : "page", path = String(msg?.path || "/"), pathname;
  try {
    if (!path.startsWith("/") || path.includes("\\")) return null;
    let probe = new URL(path, "https://x");
    if (probe.origin !== "https://x") return null;
    let rawPath = decodeURIComponent(path.split(/[?#]/, 1)[0]);
    if (rawPath.includes("\\") || rawPath.split("/").includes("..")) return null;
    pathname = decodeURIComponent(probe.pathname);
  } catch {
    return null;
  }
  if (pathname.toLowerCase().startsWith("/_bridge/") && !(scope === "shell" && SHELL_BRIDGE_PATHS.includes(pathname))) return null;
  let allowed = scope === "shell" ? SHELL_HEADERS : PAGE_HEADERS, headers = {};
  if (msg?.headers && typeof msg.headers == "object")
    for (let [key, value] of Object.entries(msg.headers)) {
      let name = String(key).toLowerCase();
      allowed.includes(name) && (headers[name] = String(value));
    }
  return { path, headers };
}
function createChannelCore(options = {}) {
  let post = options.post;
  if (typeof post != "function") throw new TypeError("createChannelCore needs post(message, transfer)");
  let WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket, clock = options.clock ?? systemClock(), random = options.random ?? defaultRandom2, computer = null, phase = "idle", session = null, desktopName = "", lastSeen = null, since = clock.now(), failedRounds = 0, retryTimer = null, nextRetryAt = null, attempting = !1, renewTimer = null, lastFailure = null, closedByPage = !1, pairing = null, ridSeq = 0, rids = /* @__PURE__ */ new Map(), pendingStops = /* @__PURE__ */ new Map(), draining = /* @__PURE__ */ new Set(), unknownRounds = 0, transition = (next) => {
    next !== phase && (phase = next, since = clock.now());
  }, snapshot = () => ({
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
  }), emitState = () => post({ op: "state", state: snapshot() });
  function counterRequest(id, minimum) {
    return new Promise((resolve, reject) => {
      let rid = ++ridSeq, timer = clock.setTimeout(() => {
        rids.delete(rid), reject(new Error("counter not saved"));
      }, COUNTER_TIMEOUT_MS);
      rids.set(rid, {
        resolve: (value) => {
          clock.clearTimeout(timer), resolve(value);
        },
        reject: (err) => {
          clock.clearTimeout(timer), reject(err);
        }
      }), post({ op: "counter", rid, id, minimum });
    });
  }
  async function raiseCounter(id, current) {
    let answer = await counterRequest(id, current + 1);
    if (!answer || answer.ok !== !0 || !Number.isSafeInteger(answer.counter) || answer.counter <= current)
      throw new Error("counter not saved");
    return answer.counter;
  }
  async function handshake(kind, url, opts) {
    let sock = await openSocket(WebSocketImpl, url, { clock });
    try {
      let payload = await opts.payloadFor(), hs = handshakeInitiator({
        staticPrivate: opts.myPriv,
        remoteStaticPublic: opts.remotePub,
        prologue: prologue(kind, opts.offer ?? null),
        ...opts.psk ? { psk: opts.psk } : {}
      }), body = hs.writeMessage1(utf82.encode(JSON.stringify(payload)));
      sock.send(sealMessage1(opts.remotePub, body));
      let reply = await sock.next(HANDSHAKE_TIMEOUT_MS), cookie = parseCookieReply(reply);
      cookie && (sock.send(sealMessage1(opts.remotePub, body, cookie)), reply = await sock.next(HANDSHAKE_TIMEOUT_MS));
      let message2 = hs.readMessage2(reply), cs = hs.finish();
      return { sock, cs, message2 };
    } catch (err) {
      throw sock.close(1e3, "handshake"), closeCodeError(err, sock);
    }
  }
  function makeSession({ sock, cs, kind, url }) {
    let s = {
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
      closed: !1,
      retired: !1,
      drainTimer: null,
      probe: null,
      hello: null
    };
    return s.frames = new FrameSession({
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
      // The relay closes a phone that sends more than 2 MiB in one second, so a session over the relay paces its non-priority frames under that
      // (B-123). LAN and Tailscale carry no such limit.
      wireBytesPerSecond: kind === "relay" ? WIRE_BUDGET_BYTES_PER_SECOND : 1 / 0,
      handlers: {
        hello: (value) => onSessionHello(s, value),
        res: (id, value, fin) => onRes(s, id, value, fin),
        data: (id, bytes, fin) => onData(s, id, bytes, fin),
        event: (value) => onEvent(s, value),
        stopAck: (value) => onStopAck(value),
        close: (value) => onPeerClose(s, value),
        abort: (id) => endStream(s, id, null, !0),
        closed: (reason) => onSessionClosed(s, reason)
      }
    }), sock.onMessage = (bytes) => {
      let plain;
      try {
        plain = cs.recv.decrypt(bytes);
      } catch {
        s.frames.close("protocol");
        return;
      }
      s.messages += 1, s.frames.receive(plain);
    }, sock.onClose = (info) => {
      s.frames.isClosed || s.frames.close(info?.code === 4001 ? "host-offline" : "transport");
    }, s;
  }
  function onRes(s, id, value, fin) {
    let sid = s.sidOf.get(id);
    sid !== void 0 && (post({ op: "res", sid, status: Number(value?.status) || 0, headers: value?.headers ?? {} }), fin && endStream(s, id, null, !1));
  }
  function onData(s, id, bytes, fin) {
    let sid = s.sidOf.get(id);
    if (sid !== void 0) {
      if (bytes && bytes.byteLength) {
        let copy = new Uint8Array(bytes);
        post({ op: "data", sid, bytes: copy.buffer }, [copy.buffer]);
      }
      fin && endStream(s, id, null, !1);
    }
  }
  function endStream(s, id, error, cancelled) {
    let sid = s.sidOf.get(id);
    sid !== void 0 && (s.sidOf.delete(id), s.streamOf.delete(sid), post({ op: "end", sid, error, cancelled }), draining.has(s) && s.sidOf.size === 0 && drainOld(s));
  }
  function startRequest(msg) {
    let sid = msg.sid, policy = requestPolicy(msg);
    if (!policy) {
      post({ op: "end", sid, error: "refused", cancelled: !1 });
      return;
    }
    let s = session;
    if (!s || phase !== "connected") {
      post({ op: "end", sid, error: "offline", cancelled: !1 });
      return;
    }
    let body = msg.body ? new Uint8Array(msg.body) : null, value = {
      method: String(msg.method || "GET").toUpperCase(),
      path: policy.path,
      headers: policy.headers,
      ...body ? { bodyLength: body.byteLength } : {}
    }, id = s.frames.request(value, { fin: !body });
    if (id === null) {
      post({ op: "end", sid, error: "busy", cancelled: !1 });
      return;
    }
    s.sidOf.set(id, sid), s.streamOf.set(sid, id), body && s.frames.body(id, body, { fin: !0 });
  }
  function cancelRequest(sid) {
    for (let s of [session, ...draining]) {
      let id = s?.streamOf.get(sid);
      if (id !== void 0) {
        s.frames.cancel(id);
        return;
      }
    }
  }
  function onSessionHello(s, value) {
    pairing && pairing.session === s && pairing.resolve?.({ ok: !0, hello: value });
  }
  function onEvent(s, value) {
    post({ op: "event", event: value }), value && value.type === "phone" && value.kind === "revoked" && (transition("revoked"), emitState(), s.frames.close("revoked"));
  }
  function onPeerClose(s, value) {
    let reason = typeof value?.reason == "string" ? value.reason.slice(0, 64) : "peer";
    if (pairing && pairing.session === s) {
      pairing.resolve?.({ ok: !1, reason: pairing.cancelled ?? reason });
      return;
    }
    lastFailure = reason, reason === "revoked" ? transition("revoked") : reason === "update-desktop" ? transition("update-desktop") : reason === "host-offline" && transition("asleep"), emitState();
  }
  function onSessionClosed(s, reason) {
    if (!s.closed && (s.closed = !0, clock.clearTimeout(s.probe), s.probe = null, !s.retired)) {
      if (pairing && pairing.session === s) {
        pairing.resolve?.({ ok: !1, reason: pairing.cancelled ?? `closed:${reason}` });
        return;
      }
      for (let id of Array.from(s.sidOf.keys())) endStream(s, id, "lost", !1);
      if (draining.delete(s), session !== s) {
        emitState();
        return;
      }
      session = null, lastSeen = clock.now();
      for (let entry of pendingStops.values()) post({ op: "stopState", sid: entry.sid, state: "queued" });
      if (lastFailure = String(reason ?? "lost"), reason === "host-offline" && transition("asleep"), closedByPage) {
        emitState();
        return;
      }
      if (TERMINAL.includes(phase)) {
        emitState();
        return;
      }
      failedRounds = 0, scheduleRetry();
    }
  }
  function carrierCandidates(comp) {
    let out = [];
    for (let c of usableCarriers(comp.carriers))
      for (let url of c.urls) out.push({ kind: c.kind, url });
    return [...out.filter((c) => c.kind === comp.lastCarrier), ...out.filter((c) => c.kind !== comp.lastCarrier)];
  }
  function clearRetry() {
    clock.clearTimeout(retryTimer), retryTimer = null, nextRetryAt = null;
  }
  function scheduleRetry() {
    if (closedByPage || !computer || TERMINAL.includes(phase)) return;
    clearRetry();
    let slow = phase === "not-known", delay = slow ? NOT_KNOWN_RETRY_MS : DELAYS_MS[failedRounds] ?? RETRY_CAP_MS;
    nextRetryAt = clock.now() + delay, phase !== "asleep" && !slow && transition(failedRounds >= OFFLINE_ROUNDS ? "offline" : "reconnecting"), retryTimer = clock.setTimeout(() => {
      retryTimer = null, nextRetryAt = null, attempt().catch(() => {
      });
    }, delay), emitState();
  }
  async function connectSession(candidate, comp) {
    let { sock, cs, message2 } = await handshake(candidate.kind, candidate.url, {
      remotePub: comp.desktopPub,
      myPriv: comp.myPriv,
      psk: null,
      offer: null,
      payloadFor: async () => {
        let counter = await raiseCounter(comp.id, comp.counter);
        return comp.counter = counter, { v: PROTOCOL, kind: "session", counter, device: comp.device, caps: comp.caps, ...comp.hasStopKey ? {} : { wantStopKey: !0 } };
      }
    }), s = makeSession({ sock, cs, kind: candidate.kind, url: candidate.url });
    try {
      s.hello = JSON.parse(utf8Decode.decode(message2));
    } catch {
      throw sock.close(1002, "hello"), new Error("handshake: HELLO is not JSON");
    }
    return s;
  }
  async function attempt() {
    if (!(attempting || closedByPage || !computer || session || TERMINAL.includes(phase))) {
      attempting = !0;
      try {
        let candidates = carrierCandidates(computer);
        if (!candidates.length) {
          lastFailure = "no-carrier", unknownRounds = 0, failedRounds += 1, scheduleRetry();
          return;
        }
        let reasons = [];
        for (let candidate of candidates) {
          if (closedByPage || TERMINAL.includes(phase)) return;
          try {
            let s = await connectSession(candidate, computer);
            adopt(s);
            return;
          } catch (err) {
            lastFailure = failureName(err), reasons.push(lastFailure);
          }
        }
        unknownRounds = reasons.length > 0 && reasons.every((r) => r === "unknown") ? unknownRounds + 1 : 0, failedRounds += 1, unknownRounds >= NOT_KNOWN_ROUNDS ? transition("not-known") : reasons.includes("host-offline") ? transition("asleep") : (phase === "not-known" || phase === "asleep") && transition("reconnecting"), scheduleRetry();
      } finally {
        attempting = !1;
      }
    }
  }
  function adopt(s) {
    session = s, failedRounds = 0, unknownRounds = 0, nextRetryAt = null, lastFailure = null, lastSeen = clock.now(), desktopName = String(s.hello?.desktopName ?? desktopName).slice(0, 60);
    let major = s.hello?.protocol?.major;
    if (major !== 1) {
      transition(major > 1 ? "update-app" : "update-desktop"), s.frames.close(major > 1 ? "update-app" : "update-desktop"), emitState();
      return;
    }
    transition("connected"), computer.lastCarrier = s.carrier, topUpStopKey(s), learnWays(s.hello), post({ op: "hello", hello: s.hello }), post({ op: "patch", id: computer.id, patch: { lastCarrier: s.carrier, lastSeen } }), s.frames.startLiveness({ intervalMs: PING_INTERVAL_MS2, misses: PING_MISSES });
    for (let entry of pendingStops.values()) sendStop(entry);
    scheduleRenewCheck(RENEW_CHECK_MS), emitState();
  }
  function topUpStopKey(s) {
    if (s.hello?.stopKeyNew !== !0 || !computer) return;
    let k = stopKey(s.cs.handshakeHash);
    post({ op: "patch", id: computer.id, patch: { stopKey: bytesToB64u(k), myDeviceId: String(s.hello.deviceId ?? "") } }), k.fill(0), computer.hasStopKey = !0;
  }
  function learnWays(hello) {
    if (!computer || !Array.isArray(hello?.carriers)) return;
    let listed = /* @__PURE__ */ new Map();
    for (let entry of hello.carriers) {
      if (!entry || typeof entry != "object" || !CARRIERS2.includes(entry.kind)) continue;
      let urls = Array.isArray(entry.urls) ? entry.urls : entry.url ? [entry.url] : [];
      listed.set(entry.kind, [...listed.get(entry.kind) ?? [], ...urls]);
    }
    let learned = usableCarriers([...listed].map(([kind, urls]) => ({ kind, urls })));
    if (!learned.length) return;
    let held = usableCarriers(computer.carriers), merged = learned.map((l) => {
      let kept = held.find((c) => c.kind === l.kind)?.urls ?? [];
      return { kind: l.kind, urls: [...l.urls, ...kept.filter((url) => !l.urls.includes(url))].slice(0, MAX_URLS_PER_KIND) };
    }), next = held.map((c) => merged.find((l) => l.kind === c.kind) ?? c);
    for (let l of merged) next.some((c) => c.kind === l.kind) || next.push(l);
    JSON.stringify(next) !== JSON.stringify(held) && (computer.carriers = next, post({ op: "patch", id: computer.id, patch: { carriers: next } }), post({ op: "log", line: `ways: ${learned.map((l) => l.kind).join(", ")}` }));
  }
  function reconnectNow() {
    if (!(!computer || closedByPage || attempting || TERMINAL.includes(phase))) {
      if (session) {
        probeSession(session);
        return;
      }
      clearRetry(), attempt().catch(() => {
      });
    }
  }
  function probeSession(s) {
    s.probe || s.closed || s.frames.isClosed || (s.frames.ping(), s.probe = clock.setTimeout(() => {
      s.probe = null, session === s && !s.frames.isClosed && s.frames.pingOutstanding && (s.frames.close("timeout"), reconnectNow());
    }, PROBE_MS));
  }
  function scheduleRenewCheck(delay) {
    clock.clearTimeout(renewTimer), renewTimer = clock.setTimeout(() => {
      renewTimer = null, maybeRenew();
    }, delay);
  }
  function maybeRenew() {
    let s = session;
    if (!s || closedByPage || phase !== "connected") return;
    if (!(clock.now() - s.startedAt >= RENEW_AFTER_MS || s.messages >= RENEW_AFTER_MESSAGES)) {
      scheduleRenewCheck(RENEW_CHECK_MS);
      return;
    }
    renew(s);
  }
  async function renew(old) {
    let made = null;
    try {
      let { sock, cs, message2 } = await handshake(old.kind, old.url, {
        remotePub: computer.desktopPub,
        myPriv: computer.myPriv,
        psk: null,
        offer: null,
        payloadFor: async () => {
          let counter = await raiseCounter(computer.id, computer.counter);
          return computer.counter = counter, { v: PROTOCOL, kind: "session", counter, device: computer.device, caps: computer.caps, ...computer.hasStopKey ? {} : { wantStopKey: !0 } };
        }
      });
      if (made = makeSession({ sock, cs, kind: old.kind, url: old.url }), made.hello = JSON.parse(utf8Decode.decode(message2)), topUpStopKey(made), learnWays(made.hello), session !== old || closedByPage || made.hello?.protocol?.major !== 1) {
        made.retired = !0, made.frames.close("normal"), scheduleRenewCheck(RENEW_CHECK_MS);
        return;
      }
      session = made, draining.add(old), made.frames.startLiveness({ intervalMs: PING_INTERVAL_MS2, misses: PING_MISSES }), old.sidOf.size === 0 ? drainOld(old) : old.drainTimer = clock.setTimeout(() => drainOld(old), RENEW_DRAIN_MS), post({ op: "hello", hello: made.hello }), scheduleRenewCheck(RENEW_CHECK_MS), emitState();
    } catch {
      made && made !== session && (made.retired = !0, made.frames.close("normal")), scheduleRenewCheck(RENEW_CHECK_MS);
    }
  }
  function drainOld(old) {
    if (!old.retired) {
      old.retired = !0, clock.clearTimeout(old.drainTimer), old.drainTimer = null, draining.delete(old);
      for (let id of Array.from(old.sidOf.keys())) endStream(old, id, "lost", !1);
      old.frames.close("renewed");
    }
  }
  function sendStop(entry) {
    if (!session || phase !== "connected" || !pendingStops.has(entry.id)) {
      post({ op: "stopState", sid: entry.sid, state: "queued" });
      return;
    }
    let payload = { id: entry.id, ...entry.project ? { project: entry.project } : {} }, sent = session.frames.stop(payload);
    post({ op: "stopState", sid: entry.sid, state: sent ? "sent" : "queued" }), clock.clearTimeout(entry.resend), entry.resend = clock.setTimeout(() => {
      entry.resend = null, pendingStops.has(entry.id) && sendStop(entry);
    }, STOP_RESEND_MS);
  }
  function clearStop(entry) {
    pendingStops.delete(entry.id), clock.clearTimeout(entry.resend), clock.clearTimeout(entry.expire);
  }
  function startStop({ sid, project }) {
    let id = bytesToHex3(random(16)), entry = { id, sid, project: typeof project == "string" && project ? project : null, resend: null, expire: null };
    pendingStops.set(id, entry), entry.expire = clock.setTimeout(() => {
      pendingStops.has(entry.id) && (clearStop(entry), post({ op: "stopAck", sid: entry.sid, error: "unreachable" }), emitState());
    }, STOP_WINDOW_MS), sendStop(entry), reconnectNow(), emitState();
  }
  function onStopAck(value) {
    let entry = pendingStops.get(value?.id);
    if (!entry) return;
    clearStop(entry);
    let count = (key) => Number.isSafeInteger(value[key]) ? value[key] : 0;
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
    }), emitState();
  }
  async function stopLocked(msg) {
    let sid = msg.sid, c = msg.computer && typeof msg.computer == "object" ? msg.computer : {}, key;
    try {
      if (key = asKey(c.stopKey), typeof c.id != "string" || !c.id || !/^[0-9a-f]{64}$/.test(String(c.deviceId ?? ""))) throw new TypeError("record");
    } catch {
      post({ op: "stopAck", sid, error: "no-key" });
      return;
    }
    let comp = {
      id: c.id,
      carriers: Array.isArray(c.carriers) ? c.carriers : [],
      lastCarrier: typeof c.lastCarrier == "string" ? c.lastCarrier : null
    }, counter = Number.isSafeInteger(c.counter) && c.counter >= 0 ? c.counter : 0, stopId = random(16), done = !1, windowTimer = null, sleepTimer = null, wake = null, activeSock = null, finish = (detail) => {
      if (!done) {
        done = !0, clock.clearTimeout(windowTimer), clock.clearTimeout(sleepTimer);
        try {
          activeSock?.close(1e3, "stopped");
        } catch {
        }
        activeSock = null, key.fill(0), post({ op: "stopAck", sid, ...detail }), wake?.();
      }
    }, sleep = (ms) => new Promise((resolve) => {
      wake = resolve, sleepTimer = clock.setTimeout(resolve, ms);
    });
    for (windowTimer = clock.setTimeout(() => finish({ error: "unreachable" }), STOP_WINDOW_MS), post({ op: "stopState", sid, state: "sending" }); !done; ) {
      let candidates = carrierCandidates(comp), unknown = candidates.length > 0;
      for (let candidate of candidates) {
        if (done) return;
        let sock = null;
        try {
          if (counter = await raiseCounter(comp.id, counter), done) return;
          if (sock = await openSocket(WebSocketImpl, candidate.url, { clock }), activeSock = sock, done) {
            sock.close(1e3, "stopped");
            return;
          }
          sock.send(encodeStopOnly({ stopKey: key, deviceId: c.deviceId, counter, stopId }));
          let first = await sock.next(STOP_ONLY_WAIT_MS);
          if (done) return;
          let ack = decodeStopAck(key, first, stopId);
          if (sock.close(1e3, "done"), activeSock = null, ack) {
            finish({ ack: { id: bytesToHex3(stopId), ...ack } });
            return;
          }
          unknown = !1;
        } catch {
          if (sock && sock.close(1e3, "stop"), activeSock = null, done) return;
          sock?.closed?.code !== 4401 && (unknown = !1);
        }
      }
      if (done) return;
      if (unknown) {
        finish({ error: "unknown" });
        return;
      }
      post({ op: "stopState", sid, state: "queued" }), await sleep(STOP_RESEND_MS);
    }
  }
  function pairCandidates(payload, extraUrls) {
    let out = [];
    for (let url of extraUrls ?? []) url && typeof url.url == "string" && carrierUrlOk(url.kind, url.url) && out.push({ kind: url.kind, url: url.url });
    for (let c of usableCarriers(payload.carriers))
      for (let url of c.urls) out.push({ kind: c.kind, url });
    return out;
  }
  function waitPairOutcome(ms) {
    return new Promise((resolve) => {
      let timer = clock.setTimeout(() => resolve({ ok: !1, reason: "expired" }), Math.max(0, ms));
      pairing.resolve = (value) => {
        clock.clearTimeout(timer), resolve(value);
      };
    });
  }
  function finishPairing(detail) {
    let current = pairing;
    pairing = null, current?.psk?.fill(0), current?.keys?.privateKey?.fill(0), current?.session && !current.session.closed && (current.session.retired = !0, current.session.frames.close("normal")), post({ op: "pairState", ...detail });
  }
  async function startPairing(msg) {
    if (pairing || computer) {
      post({ op: "pairState", state: "failed", reason: "busy" });
      return;
    }
    let payload = msg.payload && typeof msg.payload == "object" ? msg.payload : {}, pub, psk, offer;
    try {
      if (pub = asKey(b64uToBytes(payload.pub)), psk = asKey(b64uToBytes(payload.psk)), offer = String(payload.offer ?? ""), !/^[0-9a-f]{32}$/.test(offer)) throw new TypeError("offer");
    } catch {
      post({ op: "pairState", state: "failed", reason: "bad-link" });
      return;
    }
    let keys = generateKeyPair(options.random), id = deviceId(pub), ttlMs = (Number(payload.ttl) > 0 ? Math.min(Number(payload.ttl), 600) : 120) * 1e3, deadline = clock.now() + ttlMs;
    pairing = { id, keys, psk, session: null, resolve: null, tried: [], cancelled: null, active: !0 };
    let candidates = pairCandidates(payload, msg.extraUrls);
    if (!candidates.length) {
      finishPairing({ state: "failed", tried: [], reason: "no-carrier" });
      return;
    }
    for (let candidate of candidates) {
      if (!pairing || !pairing.active) return;
      if (clock.now() >= deadline) break;
      let pairCounter = 0;
      try {
        let { sock, cs, message2 } = await handshake(candidate.kind, candidate.url, {
          remotePub: pub,
          myPriv: keys.privateKey,
          psk,
          offer,
          payloadFor: async () => (pairCounter = await raiseCounter(id, 0), { v: PROTOCOL, kind: "pair", counter: pairCounter, offer, device: msg.device ?? {}, caps: msg.caps ?? DEFAULT_CAPS })
        });
        if (!pairing) {
          sock.close();
          return;
        }
        if (JSON.parse(utf8Decode.decode(message2))?.state !== "confirm")
          throw sock.close(1002, "pairing"), new Error("pairing: no confirm");
        let s = makeSession({ sock, cs, kind: candidate.kind, url: candidate.url });
        pairing.session = s, post({ op: "pairState", state: "confirm", code: sas(cs.handshakeHash) }), s.frames.startLiveness({ intervalMs: PING_INTERVAL_MS2, misses: PING_MISSES });
        let outcome = await waitPairOutcome(deadline - clock.now());
        if (outcome.ok) {
          let name = String(outcome.hello?.desktopName ?? payload.name ?? "").slice(0, 60), record = {
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
          s.retired = !0;
          let done = pairing;
          pairing = null, post({ op: "paired", computer: record }), keys.privateKey.fill(0), psk.fill(0), s.frames.close("normal"), done.active = !1, post({ op: "pairState", state: "allowed", computerId: id });
          return;
        }
        let reason = String(outcome.reason ?? "closed"), state = /denied/.test(reason) ? "denied" : /expired/.test(reason) ? "expired" : /mismatch/.test(reason) ? "mismatch" : "failed";
        finishPairing({ state, reason: state === "failed" ? reason : void 0 });
        return;
      } catch (err) {
        if (!pairing) return;
        pairing.tried.push({ carrier: candidate.kind, reason: failureName(err) });
      }
    }
    pairing && finishPairing({ state: clock.now() >= deadline ? "expired" : "failed", tried: pairing.tried });
  }
  function cancelPairing() {
    if (pairing)
      if (pairing.cancelled = "mismatch", pairing.session && !pairing.session.closed) pairing.session.frames.close("mismatch");
      else {
        let current = pairing;
        pairing = null, current.active = !1, post({ op: "pairState", state: "mismatch" });
      }
  }
  function init(msg) {
    if (computer) return;
    let c = msg.computer && typeof msg.computer == "object" ? msg.computer : {};
    try {
      computer = {
        id: String(c.id ?? ""),
        name: String(c.name ?? ""),
        desktopPub: asKey(c.desktopPub),
        myPriv: asKey(c.myPriv),
        carriers: Array.isArray(c.carriers) ? c.carriers : [],
        lastCarrier: typeof c.lastCarrier == "string" ? c.lastCarrier : null,
        counter: Number.isSafeInteger(c.counter) && c.counter >= 0 ? c.counter : 0,
        device: msg.device && typeof msg.device == "object" ? msg.device : {},
        caps: Array.isArray(msg.caps) ? msg.caps : DEFAULT_CAPS,
        hasStopKey: msg.hasStopKey === !0
      };
    } catch {
      computer = null, transition("failed"), lastFailure = "bad-computer", emitState();
      return;
    }
    transition("connecting"), emitState(), attempt().catch(() => {
    });
  }
  function closeChannel() {
    if (closedByPage) return;
    closedByPage = !0, clearRetry(), clock.clearTimeout(renewTimer), renewTimer = null;
    for (let entry of Array.from(pendingStops.values()))
      clearStop(entry), post({ op: "stopAck", sid: entry.sid, error: "closed" });
    pairing && cancelPairing();
    for (let old of Array.from(draining)) drainOld(old);
    let s = session;
    session = null, s && !s.closed && s.frames.close("normal"), transition("closed"), computer?.myPriv?.fill(0), emitState();
  }
  function handle(msg) {
    if (!(!msg || typeof msg != "object"))
      try {
        switch (msg.op) {
          case "init":
            return init(msg);
          case "pair":
            return void startPairing(msg).catch(() => {
              pairing = null, post({ op: "pairState", state: "failed", reason: "error" });
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
            let waiter = rids.get(msg.rid);
            waiter && (rids.delete(msg.rid), waiter.resolve(msg));
            return;
          }
          case "close":
            return closeChannel();
          default:
            return;
        }
      } catch (err) {
        post({ op: "log", line: `worker: ${failureName(err)}` });
        return;
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
var inWorker = typeof WorkerGlobalScope < "u" && typeof self < "u" && self instanceof WorkerGlobalScope;
if (inWorker) {
  let core = createChannelCore({
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
  PROBE_MS,
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
