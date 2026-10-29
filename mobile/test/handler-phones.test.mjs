// The desktop phones handler (desktop/handlers/phones.cjs) and its pairing window (desktop/phones-pair.html, -preload.cjs, .js, .css),
// tested through the desktop's own handler loader with a fake safeStorage, a fake Electron and a fake shell. No window is shown, no
// notification is sent and no clipboard is touched: every Electron object here is a stand-in. The rendering of each window state is
// checked in a hidden Electron harness (see the mob-06 notes), not here.
// Run from a copy of the project (desktop/ and mobile/test/): node --test mobile/test/handler-phones.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..', '..', 'desktop');
const require = createRequire(import.meta.url);
const { loadHandlers, handleMessage } = require(path.join(desktop, 'handler-loader.cjs'));
const phonesFile = path.join(desktop, 'handlers', 'phones.cjs');
const { createPhones, createStore, pngDataUrl, drawQr, crc32, STORE_FILE, PAIR_PAGE, PAIR_PRELOAD } = require(phonesFile);

// Where the tests keep their folders: under the sealed scratch folder when the runner names one, else the system temp folder.
const BASE = process.env.MOB06_SCRATCH || os.tmpdir();
let counter = 0;
function freshFolder(label) {
  const dir = path.join(BASE, `mob06-${label}-${process.pid}-${Date.now()}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The secret text of a test. It must never reach a log, an error or a file in the clear.
const REGISTRY_MARKER = 'REGISTRY-SECRET-MARKER-5c1e';
const LINK_MARKER = 'SECRET-PSK-MARKER-7f3a';
const LINK = `http://192.168.1.5:49200/p/ABCDEFGH#pair=${LINK_MARKER}`;
const REGISTRY = JSON.stringify({ version: 1, devices: [{ id: 'd1', name: 'Will\'s iPhone', key: REGISTRY_MARKER }] });

// ---------- stand-ins ----------

function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  const safe = {
    available,
    backend,
    isAsyncEncryptionAvailable: async () => safe.available,
    getSelectedStorageBackend: () => safe.backend,
    encryptStringAsync: async value => Buffer.from(`enc1:${value}`, 'utf8'),
    decryptStringAsync: async buffer => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc1:')) throw new Error('cannot decrypt');
      return { result: text.slice(5), shouldReEncrypt: false };
    },
  };
  return safe;
}

class FakeWebContents {
  constructor() {
    this.sent = [];
    this.listeners = {};
  }
  on(name, fn) {
    (this.listeners[name] ??= []).push(fn);
    return this;
  }
  emit(name, ...args) {
    for (const fn of this.listeners[name] ?? []) fn(...args);
  }
  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
  setWindowOpenHandler(fn) {
    this.openHandler = fn;
  }
  get last() {
    return this.sent.at(-1)?.payload;
  }
}

class FakeWindow {
  static all = [];
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.calls = { show: 0, showInactive: 0, focus: 0, close: 0, menu: undefined, protection: undefined };
    this.listeners = {};
    this.destroyed = false;
    this.loaded = null;
    this.bounds = { x: 100, y: 120, width: 420, height: 640 };
    FakeWindow.all.push(this);
  }
  on(name, fn) {
    (this.listeners[name] ??= []).push(fn);
    return this;
  }
  once(name, fn) {
    return this.on(name, fn);
  }
  emit(name, ...args) {
    for (const fn of this.listeners[name] ?? []) fn(...args);
  }
  loadFile(file) {
    this.loaded = file;
    return Promise.resolve();
  }
  setMenu(menu) {
    this.calls.menu = menu;
  }
  setContentProtection(value) {
    this.calls.protection = value;
  }
  show() {
    this.calls.show++;
  }
  showInactive() {
    this.calls.showInactive++;
  }
  focus() {
    this.calls.focus++;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return this.focusedNow === true;
  }
  getContentBounds() {
    return { ...this.bounds };
  }
  setContentSize(width, height) {
    this.calls.contentSize = [width, height];
  }
  getContentSize() {
    return this.calls.contentSize ?? [420, 640];
  }
  close() {
    if (this.destroyed) return;
    this.calls.close++;
    this.destroyed = true;
    this.emit('closed');
  }
}

function fakeElectron({ safeStorage = fakeSafeStorage(), idle = 42, focused = false } = {}) {
  const ipc = {
    listeners: {},
    on(channel, fn) {
      (this.listeners[channel] ??= []).push(fn);
    },
    emit(channel, ...args) {
      for (const fn of this.listeners[channel] ?? []) fn(...args);
    },
  };
  const clipboard = {
    text: '',
    writes: 0,
    writeText(value) {
      this.text = value;
      this.writes++;
    },
    readText() {
      return this.text;
    },
    clear() {
      this.text = '';
    },
  };
  const partitions = [];
  const session = {
    fromPartition(name) {
      const ses = { name, webRequest: {} };
      partitions.push(ses);
      ses.setPermissionRequestHandler = fn => {
        ses.permission = fn;
      };
      ses.setPermissionCheckHandler = fn => {
        ses.check = fn;
      };
      ses.webRequest.onBeforeRequest = (filter, fn) => {
        ses.filter = filter;
        ses.request = fn;
      };
      return ses;
    },
  };
  return {
    BrowserWindow: FakeWindow,
    ipcMain: ipc,
    clipboard,
    powerMonitor: { getSystemIdleTime: () => idle },
    safeStorage,
    session,
    partitions,
    nativeTheme: { shouldUseDarkColors: false },
    focusedNow: focused,
  };
}

function fakeShell(userData, extra = {}) {
  const logs = [];
  const tells = [];
  const notes = [];
  let showed = 0;
  class Notification {
    static supported = true;
    static isSupported() {
      return Notification.supported;
    }
    constructor(options) {
      this.record = { ...options, clicks: 0, shown: false };
      notes.push(this.record);
    }
    on(name, fn) {
      if (name === 'click') this.record.onClick = fn;
      return this;
    }
    show() {
      this.record.shown = true;
    }
  }
  return {
    userData,
    log: line => logs.push(String(line)),
    tell: message => tells.push(message),
    showWindow: () => {
      showed++;
    },
    win: () => null,
    Notification,
    logs,
    tells,
    notes,
    get shows() {
      return showed;
    },
    ...extra,
  };
}

// A deterministic fake of the qrcode-generator object: 21 modules, a stripe pattern.
const fakeQr = {
  getModuleCount: () => 21,
  isDark: (r, c) => (r * 7 + c * 3) % 5 === 0,
};

// A stand-in for the capture check that reads a fixed answer, counting its calls.
function fixedSampler(answer) {
  const sampler = async () => {
    sampler.calls++;
    return answer;
  };
  sampler.calls = 0;
  return sampler;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function handlerWith({ electron, ...rest } = {}) {
  const fe = electron ?? fakeElectron();
  const phones = createPhones({ electron: fe, platform: 'win32', hidden: true, markerDelayMs: 0, sampleMarker: fixedSampler(false), ...rest });
  return { phones, fe };
}

function offerMessage(over = {}) {
  return {
    type: 'phones-pair-show',
    id: 'show-1',
    state: 'offer',
    offer: 'OFFER-ID-000001',
    link: LINK,
    name: 'Home PC',
    hints: [{ label: 'Same network (192.168.1.5)', on: true }, { label: 'Your relay (off)', on: false }],
    expiresInS: 120,
    ...over,
  };
}

function confirmMessage(over = {}) {
  return {
    type: 'phones-pair-show',
    id: 'show-2',
    state: 'confirm',
    offer: 'OFFER-ID-000001',
    code: '482913',
    device: { name: 'Will\'s iPhone', platform: 'iPhone', carrier: 'this network' },
    ...over,
  };
}

// Decodes a PNG data URL made by pngDataUrl: checks the signature and every chunk's CRC, returns the size and a bit reader (1 = white).
function decodePng(dataUrl) {
  const prefix = 'data:image/png;base64,';
  assert.ok(dataUrl.startsWith(prefix), 'a PNG data URL');
  const buffer = Buffer.from(dataUrl.slice(prefix.length), 'base64');
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const chunks = {};
  let pos = 8;
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.subarray(pos + 4, pos + 8).toString('latin1');
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    const crc = buffer.readUInt32BE(pos + 8 + length);
    assert.equal(crc, zlib.crc32(buffer.subarray(pos + 4, pos + 8 + length)), `CRC of ${type}`);
    chunks[type] = data;
    pos += 12 + length;
  }
  const width = chunks.IHDR.readUInt32BE(0);
  const height = chunks.IHDR.readUInt32BE(4);
  assert.equal(chunks.IHDR[8], 1, 'one bit per pixel');
  assert.equal(chunks.IHDR[9], 0, 'greyscale');
  const raw = zlib.inflateSync(chunks.IDAT);
  const stride = Math.ceil(width / 8);
  assert.equal(raw.length, (stride + 1) * height, 'one filter byte and the packed row, per row');
  for (let y = 0; y < height; y++) assert.equal(raw[y * (stride + 1)], 0, 'no filter');
  return {
    width,
    height,
    bit: (x, y) => (raw[y * (stride + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1,
  };
}

// ---------- tests ----------

describe('the handler through the desktop loader', () => {
  test('loads with the other handlers, registers every phones message and both hooks, and logs nothing about phones', () => {
    const logs = [];
    const fe = fakeElectron();
    const registry = loadHandlers({
      dir: path.join(desktop, 'handlers'),
      log: line => logs.push(line),
      load: file => {
        const mod = require(file);
        if (path.basename(file) === 'phones.cjs') mod.setElectron(fe);
        return mod;
      },
    });
    for (const type of ['phones-store-load', 'phones-store-save', 'phones-pair-show', 'phones-pair-close', 'phones-indicator', 'phones-presence', 'phones-clipboard', 'phones-artifact-picture']) {
      assert.ok(registry.messages.has(type), type);
    }
    const hooks = registry.hooks.filter(h => h.file === 'phones.cjs').map(h => h.hook).sort();
    assert.deepEqual(hooks, ['beforeQuit', 'serverExited']);
    assert.deepEqual(logs.filter(line => /phone/i.test(line)), []);
  });

  test('a store save and load go through handleMessage and come back as results', async () => {
    const folder = freshFolder('loader');
    const fe = fakeElectron();
    const registry = loadHandlers({
      dir: path.join(desktop, 'handlers'),
      log: () => {},
      load: file => {
        const mod = require(file);
        if (path.basename(file) === 'phones.cjs') mod.setElectron(fe);
        return mod;
      },
    });
    const replies = [];
    const post = reply => replies.push(reply);
    const shell = fakeShell(folder);
    await handleMessage(registry, { type: 'phones-store-save', id: 'a1', text: REGISTRY }, shell, { post });
    await handleMessage(registry, { type: 'phones-store-load', id: 'a2' }, shell, { post });
    assert.deepEqual(replies[0], { type: 'phones-store-save-result', id: 'a1', ok: true, storage: 'keychain' });
    assert.equal(replies[1].type, 'phones-store-load-result');
    assert.equal(replies[1].text, REGISTRY);
    assert.equal(replies[1].ok, true);
  });

  test('without the desktop app the store refuses and nothing is written', async () => {
    const folder = freshFolder('plain');
    // A fresh instance with no Electron object: require("electron") in plain Node is a path, with no safeStorage.
    const fresh = path.join(desktop, 'handlers', 'phones.cjs');
    delete require.cache[require.resolve(fresh)];
    const plain = require(fresh);
    const reply = await plain.messages['phones-store-load']({ type: 'phones-store-load' }, fakeShell(folder));
    assert.equal(reply.ok, false);
    assert.equal(reply.storage, 'unavailable');
    assert.equal(fs.existsSync(path.join(folder, STORE_FILE)), false);
    const pairing = await plain.messages['phones-pair-show'](offerMessage(), fakeShell(folder));
    assert.equal(pairing.ok, false);
  });
});

describe('the encrypted store', () => {
  test('a registry round trip is encrypted on disk and reads back as it was saved', async () => {
    const folder = freshFolder('roundtrip');
    const store = createStore({ file: path.join(folder, STORE_FILE), getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs });
    assert.deepEqual(await store.load(), { ok: true, storage: 'keychain', text: '', damaged: false });
    assert.equal((await store.save(REGISTRY)).ok, true);
    const onDisk = fs.readFileSync(path.join(folder, STORE_FILE), 'utf8');
    assert.equal(onDisk.includes(REGISTRY_MARKER), false, 'the registry is not stored in the clear');
    assert.equal(JSON.parse(onDisk).version, 1);
    const back = await store.load();
    assert.equal(back.ok, true);
    assert.equal(back.text, REGISTRY);
    assert.equal(back.damaged, false);
  });

  test('the file is written with mode 0600 where the system has modes', async t => {
    if (process.platform === 'win32') {
      t.skip('Windows has no file modes');
      return;
    }
    const folder = freshFolder('mode');
    const store = createStore({ file: path.join(folder, STORE_FILE), getSafeStorage: () => fakeSafeStorage(), platform: 'linux', fs });
    await store.save(REGISTRY);
    assert.equal(fs.statSync(path.join(folder, STORE_FILE)).mode & 0o777, 0o600);
  });

  test('a damaged file is set aside on the next save, not on load', async () => {
    const folder = freshFolder('damaged');
    const file = path.join(folder, STORE_FILE);
    fs.writeFileSync(file, '{ not json');
    const store = createStore({ file, getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs });
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.damaged, true);
    assert.equal(loaded.text, '');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'load changes nothing');
    assert.equal((await store.save(REGISTRY)).ok, true);
    assert.equal(fs.readFileSync(path.join(folder, `${STORE_FILE}.damaged`), 'utf8'), '{ not json');
    assert.equal((await store.load()).text, REGISTRY);
  });

  test('a second damaged file is set aside as -2 and the first is never written over', async () => {
    const folder = freshFolder('damaged2');
    const file = path.join(folder, STORE_FILE);
    fs.writeFileSync(`${file}.damaged`, 'older copy');
    fs.writeFileSync(file, 'broken');
    const store = createStore({ file, getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs });
    await store.save(REGISTRY);
    assert.equal(fs.readFileSync(`${file}.damaged`, 'utf8'), 'older copy');
    assert.equal(fs.readFileSync(`${file}.damaged-2`, 'utf8'), 'broken');
  });

  test('a file that does not decrypt is damaged too', async () => {
    const folder = freshFolder('nodecrypt');
    const file = path.join(folder, STORE_FILE);
    fs.writeFileSync(file, JSON.stringify({ version: 1, data: Buffer.from('plainly wrong').toString('base64') }));
    const store = createStore({ file, getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs });
    const loaded = await store.load();
    assert.equal(loaded.damaged, true);
    assert.equal(loaded.text, '');
  });

  test('a locked file is refused on load and on save, and nothing is written over it', async () => {
    const folder = freshFolder('locked');
    const file = path.join(folder, STORE_FILE);
    fs.writeFileSync(file, JSON.stringify({ version: 1, data: Buffer.from('enc1:x').toString('base64') }));
    let writes = 0;
    const lockedFs = {
      readFileSync: () => {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      },
      writeFileSync: (...args) => {
        writes++;
        return fs.writeFileSync(...args);
      },
      renameSync: (...args) => {
        writes++;
        return fs.renameSync(...args);
      },
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      unlinkSync: fs.unlinkSync,
    };
    const store = createStore({ file, getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs: lockedFs });
    const loaded = await store.load();
    assert.equal(loaded.ok, false);
    assert.equal(loaded.storage, 'locked');
    assert.equal(loaded.text, undefined);
    const saved = await store.save(REGISTRY);
    assert.equal(saved.ok, false);
    assert.equal(saved.storage, 'locked');
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(file, 'utf8').includes('"version":1'), true, 'the file is untouched');
  });

  test('with no safeStorage, or a Linux basic backend, nothing is saved and nothing is answered as empty', async () => {
    const folder = freshFolder('unavailable');
    const file = path.join(folder, STORE_FILE);
    const none = createStore({ file, getSafeStorage: () => fakeSafeStorage({ available: false }), platform: 'win32', fs });
    assert.equal((await none.load()).storage, 'unavailable');
    assert.equal((await none.save(REGISTRY)).ok, false);
    const basic = createStore({ file, getSafeStorage: () => fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux', fs });
    assert.equal((await basic.save(REGISTRY)).storage, 'unavailable');
    const undefinedSafe = createStore({ file, getSafeStorage: () => undefined, platform: 'darwin', fs });
    assert.equal((await undefinedSafe.load()).ok, false);
    assert.equal(fs.existsSync(file), false);
  });

  test('text that is not a JSON object, or is too large, is refused and not written', async () => {
    const folder = freshFolder('badtext');
    const file = path.join(folder, STORE_FILE);
    const store = createStore({ file, getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs });
    assert.equal((await store.save('[1, 2]')).ok, false);
    assert.equal((await store.save('not json')).ok, false);
    assert.equal((await store.save('')).ok, false);
    assert.equal((await store.save(`{"x":"${'a'.repeat(1024 * 1024)}"}`)).ok, false);
    assert.equal((await store.save(undefined)).ok, false);
    assert.equal(fs.existsSync(file), false);
  });

  test('saves run one at a time: the last save wins and no temporary file is left', async () => {
    const folder = freshFolder('serial');
    const file = path.join(folder, STORE_FILE);
    const store = createStore({ file, getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs });
    const texts = [1, 2, 3, 4, 5].map(n => JSON.stringify({ version: 1, n }));
    const results = await Promise.all(texts.map(text => store.save(text)));
    assert.ok(results.every(r => r.ok));
    assert.equal((await store.load()).text, texts.at(-1));
    assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith('.tmp')), []);
  });

  test('the log names a set-aside file and never its contents', async () => {
    const folder = freshFolder('logs');
    const file = path.join(folder, STORE_FILE);
    fs.writeFileSync(file, `broken ${REGISTRY_MARKER}`);
    const logs = [];
    const store = createStore({ file, getSafeStorage: () => fakeSafeStorage(), platform: 'win32', fs, log: line => logs.push(line) });
    await store.save(REGISTRY);
    assert.deepEqual(logs, [`phones file set aside as ${STORE_FILE}.damaged`]);
    assert.equal(logs.join('').includes(REGISTRY_MARKER), false);
  });
});

describe('the QR code picture', () => {
  test('pngDataUrl writes a valid greyscale PNG whose pixels are the matrix (dark modules black, a quiet zone around)', () => {
    const url = pngDataUrl(fakeQr);
    const png = decodePng(url);
    const n = 21;
    const cell = png.width / (n + 8);
    assert.equal(Number.isInteger(cell), true);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = (c + 4) * cell + Math.floor(cell / 2);
        const y = (r + 4) * cell + Math.floor(cell / 2);
        assert.equal(png.bit(x, y) === 0, fakeQr.isDark(r, c), `module ${r},${c}`);
      }
    }
    // The quiet zone is white.
    assert.equal(png.bit(0, 0), 1);
    assert.equal(png.bit(png.width - 1, png.height - 1), 1);
  });

  test('a real qrcode-generator code decodes back to its own matrix', async t => {
    let qrcode;
    try {
      qrcode = require('qrcode-generator');
    } catch {
      t.skip('qrcode-generator is not installed in this copy');
      return;
    }
    const url = drawQr(LINK, () => qrcode);
    const qr = qrcode(0, 'M');
    qr.addData(LINK);
    qr.make();
    const png = decodePng(url);
    const n = qr.getModuleCount();
    const cell = png.width / (n + 8);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        assert.equal(png.bit((c + 4) * cell + Math.floor(cell / 2), (r + 4) * cell + Math.floor(cell / 2)) === 0, qr.isDark(r, c));
      }
    }
  });

  test('the CRC helper matches zlib', () => {
    const data = Buffer.from('plenum');
    assert.equal(crc32(data), zlib.crc32(data));
  });

  test('without qrcode-generator the offer is answered as needing a newer build, with no picture', async () => {
    const { phones, fe } = handlerWith({ loadQr: () => undefined });
    const reply = await phones.messages['phones-pair-show'](offerMessage(), fakeShell(freshFolder('nobuild')));
    assert.equal(reply.ok, true);
    const win = FakeWindow.all.at(-1);
    win.webContents.emit('did-finish-load');
    assert.equal(win.webContents.last.state, 'needs-build');
    assert.equal(win.webContents.last.qrPng, '');
    assert.equal(fe.partitions.length, 1);
  });
});

describe('the pairing window', () => {
  test('is 420 by 640, capture-protected, menu-less, sandboxed, with its own partition and its own preload and page', async () => {
    FakeWindow.all.length = 0;
    const { phones, fe } = handlerWith();
    await phones.messages['phones-pair-show'](offerMessage(), fakeShell(freshFolder('window')));
    const win = FakeWindow.all[0];
    assert.equal(win.options.width, 420);
    assert.equal(win.options.height, 640);
    assert.equal(win.options.useContentSize, true);
    assert.equal(win.calls.protection, true);
    assert.deepEqual(win.calls.contentSize, [420, 640]);
    assert.equal(win.calls.menu, null);
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.contextIsolation, true);
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.devTools, false);
    assert.equal(win.options.webPreferences.partition, 'plenum-pair');
    assert.equal(win.options.webPreferences.preload, PAIR_PRELOAD);
    assert.equal(win.loaded, PAIR_PAGE);
    assert.equal(path.basename(PAIR_PAGE), 'phones-pair.html');
    assert.equal(fe.partitions[0].name, 'plenum-pair');
    assert.equal(win.options.opacity, 0, 'hidden only because this is a test');
    assert.equal(win.options.focusable, false);
    win.emit('ready-to-show');
    assert.equal(win.calls.showInactive, 1);
  });

  test('the payload is the picture and words, and no text of the link reaches the window', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith();
    await phones.messages['phones-pair-show'](offerMessage(), fakeShell(freshFolder('payload')));
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    const payload = win.webContents.last;
    assert.equal(payload.state, 'offer');
    assert.ok(payload.qrPng.startsWith('data:image/png;base64,'));
    assert.equal(payload.name, 'Home PC');
    assert.equal(payload.expiresInS, 120);
    assert.equal(payload.hints.length, 2);
    assert.equal(JSON.stringify(payload).includes(LINK_MARKER), false, 'the pairing secret stays out of the payload');
    assert.equal(JSON.stringify(payload).includes('OFFER-ID-000001'), false, 'the offer id stays out of the payload');
    assert.equal(win.webContents.sent[0].channel, 'phones-pair:offer');
  });

  test('readOffer passes tried, left, qrKind, tier and device.app to the window, and drops unknown values', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith();
    const shell = fakeShell(freshFolder('fields'));
    await phones.messages['phones-pair-show'](offerMessage({ tried: true, left: true, qrKind: 'lan', tier: 'approve' }), shell);
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    let payload = win.webContents.last;
    assert.equal(payload.tried, true);
    assert.equal(payload.left, true);
    assert.equal(payload.qrKind, 'lan');
    assert.equal(payload.tier, 'approve');
    await phones.messages['phones-pair-show'](confirmMessage({ tried: true, tier: 'read', device: { name: 'Will\'s iPhone', platform: 'iPhone', carrier: 'lan', app: 'lan-web' } }), shell);
    payload = win.webContents.last;
    assert.equal(payload.tried, true);
    assert.equal(payload.tier, 'read');
    assert.equal(payload.device.app, 'lan-web');
    await phones.messages['phones-pair-show'](confirmMessage({ tried: 'yes', left: 1, qrKind: 'carrier-pigeon', tier: 'owner', device: { name: 'Will\'s iPhone', platform: 'iPhone', carrier: 'lan', app: 'desktop' } }), shell);
    payload = win.webContents.last;
    assert.equal(payload.tried, false, 'tried must be true, not any truthy value');
    assert.equal(payload.left, false, 'left must be true, not any truthy value');
    assert.equal(payload.qrKind, 'native', 'an unknown qrKind is native');
    assert.equal(payload.tier, 'full', 'an unknown tier is Full control');
    assert.equal(payload.device.app, '', 'an unknown device app is empty');
    assert.equal(FakeWindow.all.length, 1, 'one window serves the three messages');
  });

  test('a link that is missing, too long, or a pairing without an id is refused before a window is made', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith();
    const shell = fakeShell(freshFolder('refuse'));
    assert.equal((await phones.messages['phones-pair-show'](offerMessage({ link: '' }), shell)).ok, false);
    assert.equal((await phones.messages['phones-pair-show'](offerMessage({ link: 'x'.repeat(5000) }), shell)).ok, false);
    assert.equal((await phones.messages['phones-pair-show'](offerMessage({ offer: 'bad id!' }), shell)).ok, false);
    assert.equal((await phones.messages['phones-pair-show'](offerMessage({ state: 'other' }), shell)).ok, false);
    assert.equal((await phones.messages['phones-pair-show'](confirmMessage({ code: '12' }), shell)).ok, false);
    assert.equal(FakeWindow.all.length, 0);
  });

  test('a confirm state carries the six digits and the phone, and Deny is first in the window', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith();
    await phones.messages['phones-pair-show'](confirmMessage(), fakeShell(freshFolder('confirm')));
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    const payload = win.webContents.last;
    assert.equal(payload.state, 'confirm');
    assert.equal(payload.code, '482913');
    assert.equal(payload.device.name, 'Will\'s iPhone');
    assert.equal(payload.device.platform, 'iPhone');
    assert.equal(payload.second, false);
  });

  test('each state the server can send is passed to the window as it is', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith();
    const shell = fakeShell(freshFolder('states'));
    const win = () => FakeWindow.all[0];
    await phones.messages['phones-pair-show'](offerMessage(), shell);
    win().webContents.emit('did-finish-load');
    for (const state of ['no-carrier', 'allowed', 'denied', 'expired', 'failed3']) {
      const reply = await phones.messages['phones-pair-show']({ type: 'phones-pair-show', state, name: 'Home PC', device: { name: 'Will\'s iPhone' } }, shell);
      assert.equal(reply.ok, true, state);
      assert.equal(win().webContents.last.state, state);
      assert.equal(win().webContents.last.qrPng, '', `${state} has no picture`);
    }
    assert.equal(FakeWindow.all.length, 1, 'one window serves every state');
  });

  test('the window is shown on its first state, and brought forward on each later one', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith();
    const shell = fakeShell(freshFolder('reveal'));
    await phones.messages['phones-pair-show'](offerMessage(), shell);
    const win = FakeWindow.all[0];
    win.emit('ready-to-show');
    assert.equal(win.calls.showInactive, 1);
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    assert.equal(win.calls.showInactive, 2);
  });
});

describe('the answers from the window', () => {
  // Shows an offer, loads the page, and returns the window and the shell that the answers go to.
  async function openOffer(name, over = {}) {
    FakeWindow.all.length = 0;
    const { phones, fe } = handlerWith();
    const shell = fakeShell(freshFolder(name));
    await phones.messages['phones-pair-show'](offerMessage(over), shell);
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    return { phones, fe, shell, win };
  }
  const answer = (fe, win, action, sender = win.webContents) => fe.ipcMain.emit('phones-pair:answer', { sender }, action);

  test('Allow reaches the server once, and only in the confirm state', async () => {
    const { fe, shell, win, phones } = await openOffer('allow');
    answer(fe, win, 'allow');
    assert.deepEqual(shell.tells, [], 'an offer is not allowed');
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    answer(fe, win, 'allow');
    answer(fe, win, 'allow');
    assert.deepEqual(shell.tells, [{ type: 'phones-pair-answer', offer: 'OFFER-ID-000001', action: 'allow' }]);
  });

  test('Deny reaches the server in the confirm state', async () => {
    const { fe, shell, win, phones } = await openOffer('deny');
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    answer(fe, win, 'deny');
    assert.deepEqual(shell.tells, [{ type: 'phones-pair-answer', offer: 'OFFER-ID-000001', action: 'deny' }]);
  });

  test('an answer from anything but the pairing window is ignored', async () => {
    const { fe, shell, win, phones } = await openOffer('sender');
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    answer(fe, win, 'allow', { other: true });
    assert.deepEqual(shell.tells, []);
  });

  test('an action that is not on the list is ignored', async () => {
    const { fe, shell, win, phones } = await openOffer('unknown');
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    answer(fe, win, 'allow-everything');
    answer(fe, win, undefined);
    assert.deepEqual(shell.tells, []);
  });

  test('Copy link asks the server for the link only while the code is an offer', async () => {
    const { fe, shell, win, phones } = await openOffer('copy');
    answer(fe, win, 'copy');
    assert.deepEqual(shell.tells, [{ type: 'phones-pair-answer', offer: 'OFFER-ID-000001', action: 'copy' }]);
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    answer(fe, win, 'copy');
    assert.equal(shell.tells.length, 1);
  });

  test('the link is copied, marked as copied in the window, and cleared when its time is up if it is still there', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { phones, fe, shell, win } = await openOffer('clipboard');
    const reply = await phones.messages['phones-clipboard']({ type: 'phones-clipboard', text: LINK, clearAfterMs: 5000 }, shell);
    assert.equal(reply.ok, true);
    assert.equal(fe.clipboard.text, LINK);
    assert.equal(win.webContents.last.copied, true);
    t.mock.timers.tick(4999);
    assert.equal(fe.clipboard.text, LINK);
    t.mock.timers.tick(1);
    assert.equal(fe.clipboard.text, '', 'cleared when the time is up');
  });

  test('a later copy by the person is not cleared', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { phones, fe, shell } = await openOffer('clipboard2');
    await phones.messages['phones-clipboard']({ type: 'phones-clipboard', text: LINK, clearAfterMs: 5000 }, shell);
    fe.clipboard.text = 'something the person copied';
    t.mock.timers.tick(6000);
    assert.equal(fe.clipboard.text, 'something the person copied');
  });

  test('clipboard text that is missing or over the cap is refused', async () => {
    const { phones, shell } = handlerWith();
    assert.equal((await phones.messages['phones-clipboard']({ type: 'phones-clipboard', text: '' }, shell)).ok, false);
    assert.equal((await phones.messages['phones-clipboard']({ type: 'phones-clipboard', text: 'x'.repeat(5000) }, shell)).ok, false);
  });

  test('Cancel cancels a live offer on the server and closes the window', async () => {
    const { fe, shell, win } = await openOffer('cancel');
    answer(fe, win, 'cancel');
    assert.deepEqual(shell.tells, [{ type: 'phones-pair-answer', offer: 'OFFER-ID-000001', action: 'cancel' }]);
    assert.equal(win.destroyed, true);
  });

  test('the person closing the window cancels a live confirm', async () => {
    const { shell, win, phones } = await openOffer('xclose');
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    win.close();
    assert.deepEqual(shell.tells, [{ type: 'phones-pair-answer', offer: 'OFFER-ID-000001', action: 'cancel' }]);
  });

  test('the window closing after a final state, or on the server closing it, sends nothing', async () => {
    const { phones, shell, win } = await openOffer('final');
    await phones.messages['phones-pair-show']({ type: 'phones-pair-show', state: 'allowed', device: { name: 'Will\'s iPhone' } }, shell);
    win.close();
    assert.deepEqual(shell.tells, []);
    const again = await openOffer('serverclose');
    await again.phones.messages['phones-pair-close']({ type: 'phones-pair-close', id: 'c' }, again.shell);
    assert.equal(again.win.destroyed, true);
    assert.deepEqual(again.shell.tells, []);
  });

  test('the done answer closes the window without telling the server', async () => {
    const { fe, shell, win } = await openOffer('done');
    answer(fe, win, 'done');
    assert.equal(win.destroyed, true);
    assert.deepEqual(shell.tells, []);
  });

  test('quitting and the server exiting both close the pairing window', async () => {
    const { phones, shell, win } = await openOffer('quit');
    phones.hooks.beforeQuit(shell);
    assert.equal(win.destroyed, true);
    const other = await openOffer('exit');
    other.phones.hooks.serverExited(other.shell);
    assert.equal(other.win.destroyed, true);
  });
});

describe('the capture check', () => {
  test('a square that shows hides the code from then on, and only Copy link remains', async () => {
    FakeWindow.all.length = 0;
    const sampler = fixedSampler(true);
    const { phones } = handlerWith({ sampleMarker: sampler });
    const shell = fakeShell(freshFolder('capture'));
    await phones.messages['phones-pair-show'](offerMessage(), shell);
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    await sleep(10);
    assert.equal(sampler.calls, 1);
    assert.equal(win.webContents.last.captureVisible, true);
    assert.equal(win.webContents.last.qrPng, '');
  });

  test('a square that does not show leaves the code up', async () => {
    FakeWindow.all.length = 0;
    const sampler = fixedSampler(false);
    const { phones } = handlerWith({ sampleMarker: sampler });
    await phones.messages['phones-pair-show'](offerMessage(), fakeShell(freshFolder('protected')));
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    await sleep(10);
    assert.equal(win.webContents.last.captureVisible, false);
    assert.ok(win.webContents.last.qrPng.startsWith('data:image/png'));
  });

  test('a check that cannot read the square is not decisive, so the code stays up', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith({ sampleMarker: async () => null });
    await phones.messages['phones-pair-show'](offerMessage(), fakeShell(freshFolder('unknown-check')));
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    await sleep(10);
    assert.equal(win.webContents.last.captureVisible, false);
  });

  test('the check runs once per window, not once per code', async () => {
    FakeWindow.all.length = 0;
    const sampler = fixedSampler(false);
    const { phones } = handlerWith({ sampleMarker: sampler });
    const shell = fakeShell(freshFolder('once'));
    await phones.messages['phones-pair-show'](offerMessage(), shell);
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    await sleep(5);
    await phones.messages['phones-pair-show'](offerMessage({ id: 'show-9', offer: 'OFFER-ID-000002' }), shell);
    await sleep(5);
    assert.equal(sampler.calls, 1);
  });

  test('a check that throws is treated as not decisive', async () => {
    FakeWindow.all.length = 0;
    const { phones } = handlerWith({ sampleMarker: async () => { throw new Error('no grab'); } });
    await phones.messages['phones-pair-show'](offerMessage(), fakeShell(freshFolder('throws')));
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    await sleep(10);
    assert.equal(win.webContents.last.captureVisible, false);
  });

  test('on macOS no screen grab is made unless screen recording is granted, and the code stays up', async () => {
    const cases = [
      { label: 'denied', systemPreferences: { getMediaAccessStatus: () => 'denied' }, grabs: 0 },
      { label: 'not determined', systemPreferences: { getMediaAccessStatus: () => 'not-determined' }, grabs: 0 },
      { label: 'no status to read', systemPreferences: {}, grabs: 0 },
      { label: 'granted', systemPreferences: { getMediaAccessStatus: () => 'granted' }, grabs: 1 },
    ];
    for (const c of cases) {
      FakeWindow.all.length = 0;
      const fe = fakeElectron();
      let grabs = 0;
      fe.systemPreferences = c.systemPreferences;
      fe.screen = { getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 }) };
      fe.desktopCapturer = { getSources: async () => { grabs++; return []; } };
      const phones = createPhones({ electron: fe, platform: 'darwin', hidden: true, markerDelayMs: 0 });
      await phones.messages['phones-pair-show'](offerMessage(), fakeShell(freshFolder('darwin-capture')));
      const win = FakeWindow.all[0];
      win.webContents.emit('did-finish-load');
      await sleep(10);
      assert.equal(grabs, c.grabs, `${c.label}: screen grabs`);
      assert.equal(win.webContents.last.captureVisible, false, `${c.label}: the check is not decisive`);
      assert.ok(win.webContents.last.qrPng.startsWith('data:image/png'), `${c.label}: the code stays up`);
    }
  });

  test('on Linux the code is never shown and no grab is made, and Copy link still reaches the server (B-112)', async () => {
    FakeWindow.all.length = 0;
    const sampler = fixedSampler(false);
    const { phones, fe } = handlerWith({ sampleMarker: sampler, platform: 'linux' });
    const shell = fakeShell(freshFolder('linux-capture'));
    await phones.messages['phones-pair-show'](offerMessage(), shell);
    const win = FakeWindow.all[0];
    win.webContents.emit('did-finish-load');
    await sleep(10);
    assert.equal(sampler.calls, 0, 'no screen grab, which on Wayland would open the screen-share picker');
    assert.equal(win.webContents.last.captureVisible, true);
    assert.equal(win.webContents.last.qrPng, '', 'the code is not drawn on Linux');
    fe.ipcMain.emit('phones-pair:answer', { sender: win.webContents }, 'copy');
    assert.deepEqual(shell.tells, [{ type: 'phones-pair-answer', offer: 'OFFER-ID-000001', action: 'copy' }]);
  });
});

describe('the other messages', () => {
  test('phones-indicator notifies on the first connection of a launch, and not again', () => {
    const { phones } = handlerWith();
    const shell = fakeShell(freshFolder('indicator'));
    assert.deepEqual(phones.messages['phones-indicator']({ type: 'phones-indicator', connected: [] }, shell), { ok: true });
    assert.equal(shell.notes.length, 0);
    phones.messages['phones-indicator']({ type: 'phones-indicator', connected: ['Will\'s iPhone'] }, shell);
    phones.messages['phones-indicator']({ type: 'phones-indicator', connected: ['Will\'s iPhone', 'Pixel'] }, shell);
    assert.equal(shell.notes.length, 1);
    assert.equal(shell.notes[0].title, 'Phone connected: Will\'s iPhone');
    assert.match(shell.notes[0].body, /^Plenum on /);
    assert.equal(shell.notes[0].shown, true);
  });

  test('phones-indicator says nothing where notifications are not supported', () => {
    const { phones } = handlerWith();
    const shell = fakeShell(freshFolder('nonote'));
    shell.Notification.supported = false;
    phones.messages['phones-indicator']({ type: 'phones-indicator', connected: ['Will\'s iPhone'] }, shell);
    assert.equal(shell.notes.length, 0);
    shell.Notification.supported = true;
  });

  test('phones-indicator clicks show the window', () => {
    const { phones } = handlerWith();
    const shell = fakeShell(freshFolder('click'));
    phones.messages['phones-indicator']({ type: 'phones-indicator', connected: ['Pixel'] }, shell);
    shell.notes[0].onClick();
    assert.equal(shell.shows, 1);
  });

  test('phones-presence reports the desktop window focus and the system idle time', () => {
    const focused = fakeElectron({ idle: 42, focused: true });
    const { phones } = handlerWith({ electron: focused });
    const shell = fakeShell(freshFolder('presence'), { win: () => ({ isFocused: () => true }) });
    assert.deepEqual(phones.messages['phones-presence']({ type: 'phones-presence' }, shell), { ok: true, focused: true, idleS: 42 });
    const away = fakeShell(freshFolder('presence2'), { win: () => ({ isFocused: () => false }) });
    assert.equal(phones.messages['phones-presence']({ type: 'phones-presence' }, away).focused, false);
    const none = fakeShell(freshFolder('presence3'));
    assert.equal(phones.messages['phones-presence']({ type: 'phones-presence' }, none).focused, false);
  });

  test('phones-artifact-picture answers ok false until wave 103', () => {
    const { phones } = handlerWith();
    const reply = phones.messages['phones-artifact-picture']({ type: 'phones-artifact-picture', id: 'a' }, fakeShell(freshFolder('pic')));
    assert.equal(reply.ok, false);
  });

  test('a picture request is refused at once when three are already pending, and the next one is drawn once they are done', async () => {
    const made = [];
    // A page that never finishes loading: each picture runs to its total time (40 ms here) and fails.
    class StuckWindow {
      constructor(options) {
        this.options = options;
        this.destroyed = false;
        this.webContents = { setWindowOpenHandler() {}, on() {}, once() {} };
        made.push(this);
      }
      setIgnoreMouseEvents() {}
      showInactive() {}
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
      }
      loadURL() {
        return new Promise(() => {});
      }
    }
    const pictureElectron = {
      BrowserWindow: StuckWindow,
      session: {
        fromPartition: () => ({
          webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {}, onCompleted() {} },
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
        }),
      },
    };
    const phones = createPhones({ electron: pictureElectron, platform: 'win32', hidden: true, pictureWaitMs: 5000, pictureTotalMs: 40 });
    const shell = fakeShell(freshFolder('busy'), { port: 49999, token: 'a'.repeat(64) });
    const ask = () => phones.messages['phones-artifact-picture']({ type: 'phones-artifact-picture', artifact: 'ARTIFACT-ID-01' }, shell);
    const failed = { ok: false, message: 'The picture could not be made.' };
    const busy = { ok: false, message: 'Plenum is busy drawing pictures. Try again in a moment.' };
    const replies = await Promise.all([ask(), ask(), ask(), ask()]);
    assert.deepEqual(replies.slice(0, 3), [failed, failed, failed], 'the first three are drawn');
    assert.deepEqual(replies[3], busy, 'the fourth is refused');
    assert.equal(made.length, 3, 'the refused request made no window');
    assert.deepEqual(await ask(), failed, 'once the queue is clear, a new request is drawn again');
    assert.equal(made.length, 4);
  });

  test('phones-pair-close with no window does nothing and answers ok', () => {
    const { phones } = handlerWith();
    assert.deepEqual(phones.messages['phones-pair-close']({ type: 'phones-pair-close' }, fakeShell(freshFolder('closeless'))), { ok: true });
  });
});

describe('the window files', () => {
  const page = fs.readFileSync(PAIR_PAGE, 'utf8');
  const script = fs.readFileSync(path.join(desktop, 'phones-pair.js'), 'utf8');
  const style = fs.readFileSync(path.join(desktop, 'phones-pair.css'), 'utf8');

  test('the page has no inline script, no inline style and no style or event attribute', () => {
    assert.deepEqual([...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].map(m => m[0]), []);
    assert.equal(/<style[\s>]/i.test(page), false);
    assert.equal(/\sstyle\s*=/i.test(page), false);
    assert.equal(/\son[a-z]+\s*=/i.test(page), false);
    assert.equal(/<link[^>]*rel="stylesheet"[^>]*href="phones-pair\.css"/i.test(page), true);
    assert.equal(/<script[^>]*src="phones-pair\.js"/i.test(page), true);
  });

  test('the page policy allows its own script and style files only, and no inline code', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i.exec(page)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.equal(/unsafe|'inline'|https?:|\*/.test(csp), false);
    assert.match(csp, /connect-src 'none'/);
  });

  test('the script builds every element with textContent and never with HTML', () => {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(\'style\'', 'style.cssText']) {
      assert.equal(script.includes(bad), false, bad);
    }
    assert.match(script, /textContent/);
  });

  test('the stylesheet makes no request out and draws the capture square in its one colour', () => {
    assert.equal(/url\(|@import|https?:/i.test(style), false);
    assert.match(style, /\.marker\s*\{[^}]*background:\s*#ff00ff/);
  });

  test('the preload exposes exactly onOffer and answer', () => {
    const exposed = {};
    const sent = [];
    const listeners = [];
    const fakeRequire = name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
        ipcRenderer: {
          on: (channel, fn) => listeners.push({ channel, fn }),
          send: (channel, value) => sent.push({ channel, value }),
        },
      };
    };
    const source = fs.readFileSync(PAIR_PRELOAD, 'utf8');
    new Function('require', 'module', 'exports', source)(fakeRequire, { exports: {} }, {});
    assert.deepEqual(Object.keys(exposed), ['plenumPair']);
    assert.deepEqual(Object.keys(exposed.plenumPair).sort(), ['answer', 'onOffer']);
    let got = null;
    exposed.plenumPair.onOffer((...args) => {
      got = args;
    });
    assert.equal(listeners[0].channel, 'phones-pair:offer');
    listeners[0].fn({ sender: 'ipc-event' }, { state: 'offer' });
    assert.deepEqual(got, [{ state: 'offer' }], 'the callback gets the payload only, not the event');
    exposed.plenumPair.answer('allow');
    exposed.plenumPair.answer({ not: 'a string' });
    assert.deepEqual(sent, [{ channel: 'phones-pair:answer', value: 'allow' }]);
  });
});

// The pairing window's words, checked by running its script (desktop/phones-pair.js) in a sandbox with a stand-in document. Every element
// keeps the text it was given, so the test reads what the window would show. No browser is needed.
describe('the pairing window words for plain http, tried, left and the tier', () => {
  const windowScript = fs.readFileSync(path.join(desktop, 'phones-pair.js'), 'utf8');

  // Runs the script once. render(payload) draws a state the way the handler's payload would; texts(className) reads what is shown.
  function runWindow() {
    class Node {
      constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.className = '';
        this.children = [];
        this.dataset = {};
        this.attrs = {};
        this.own = '';
      }
      get textContent() {
        return this.own + this.children.map(child => child.textContent).join('');
      }
      set textContent(value) {
        this.own = String(value);
        this.children = [];
      }
      append(...items) {
        for (const item of items) this.children.push(typeof item === 'string' ? textNode(item) : item);
      }
      replaceChildren(...items) {
        this.children = [];
        this.own = '';
        this.append(...items);
      }
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      }
      removeAttribute(name) {
        delete this.attrs[name];
      }
      addEventListener() {}
      querySelector() {
        return null;
      }
      querySelectorAll() {
        return [];
      }
      focus() {}
    }
    const textNode = text => {
      const node = new Node('#text');
      node.own = text;
      return node;
    };
    const ids = { body: new Node('div'), actions: new Node('div'), sub: new Node('p'), pair: new Node('main') };
    let render = null;
    const sandbox = {
      window: { plenumPair: { onOffer: fn => { render = fn; }, answer() {} } },
      document: { getElementById: id => ids[id] ?? null, createElement: tag => new Node(tag) },
      setTimeout: () => 0,
      clearTimeout() {},
      setInterval: () => 0,
      clearInterval() {},
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(windowScript, sandbox);
    const everything = node => [node, ...node.children.flatMap(everything)];
    return {
      show: payload => render(payload),
      texts: className => everything(ids.body).filter(node => node.className === className).map(node => node.textContent),
    };
  }

  const base = { seq: 1, name: 'Home PC', hints: [], expiresInS: 120, code: '', second: false, qrPng: '', captureVisible: false, copied: false };

  test('the window shows the plain http line for qrKind lan, the tried and left lines, Web page (plain http) and the tier line', () => {
    const w = runWindow();
    w.show({ ...base, state: 'offer', device: null, qrKind: 'lan', tried: true, left: true, tier: 'approve' });
    assert.ok(w.texts('note').includes('The web page this code opens is sent without encryption on this network. On a network you do not trust, scan the code with the Plenum app instead.'), 'the plain http line under the scan line');
    assert.ok(w.texts('warn').includes('Another device tried to pair with this computer and was turned away. Only a phone that has this code can pair.'), 'the tried line');
    assert.ok(w.texts('warn').includes('The phone that was waiting left before you answered. Scan the code again.'), 'the left line');

    w.show({ ...base, state: 'offer', device: null, qrKind: 'tailscale', tried: false, left: false, tier: 'full' });
    assert.equal(w.texts('note').some(text => text.startsWith('The web page this code opens')), false, 'no plain http line for a Tailscale code');
    assert.equal(w.texts('warn').some(text => text.startsWith('Another device tried') || text.startsWith('The phone that was waiting')), false, 'no tried or left line when neither is set');

    const device = { name: 'Will\'s iPhone', platform: 'iPhone', carrier: 'this network', app: 'lan-web' };
    w.show({ ...base, state: 'confirm', code: '482913', device, qrKind: 'lan', tried: true, tier: 'read' });
    assert.ok(w.texts('device-kind').includes('Web page (plain http) · this network'), 'the device line says Web page (plain http)');
    assert.ok(w.texts('warn').includes('Another device tried to pair with this computer and was turned away. Only a phone that has this code can pair.'), 'the tried line in the confirm state');
    assert.ok(w.texts('note').includes('It will have Read only. You can change that under Settings › Phones. It came from a web page sent without encryption, so on a network you do not trust, set it to Approve and watch after pairing.'), 'the tier line, with the plain http addition');

    w.show({ ...base, state: 'confirm', code: '482913', device: { name: 'Will\'s iPhone', platform: 'iPhone', carrier: 'this network', app: 'pwa' }, tier: 'full' });
    assert.ok(w.texts('device-kind').includes('iPhone · this network'), 'a phone that is not a web page keeps its platform');
    assert.ok(w.texts('note').includes('It will have Full control. You can lower that any time under Settings › Phones.'), 'the Full control tier line');
    w.show({ ...base, state: 'confirm', code: '482913', device, tier: 'approve' });
    assert.ok(w.texts('note').some(text => text.startsWith('It will have Approve and watch. You can change that under Settings › Phones.')), 'the Approve and watch tier line');
  });

  test('the allowed text names Approve and watch for a non-full tier, and keeps the full text for Full control', () => {
    const w = runWindow();
    const device = { name: 'Will\'s iPhone' };
    w.show({ ...base, state: 'allowed', device, tier: 'approve' });
    assert.ok(w.texts('lede').includes('Will\'s iPhone is paired with Approve and watch. Change it any time under Settings › Phones.'), 'Approve and watch is named');
    w.show({ ...base, state: 'allowed', device, tier: 'read' });
    assert.ok(w.texts('lede').includes('Will\'s iPhone is paired with Read only. Change it any time under Settings › Phones.'), 'Read only is named');
    w.show({ ...base, state: 'allowed', device, tier: 'full' });
    assert.ok(w.texts('lede').includes('Will\'s iPhone is paired. It can now do everything this window can. Remove it any time under Settings › Phones.'), 'the full text stays for Full control');
  });
});

describe('nothing secret is logged', () => {
  test('a whole sequence of store, pairing and clipboard calls logs no text, key or link', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    FakeWindow.all.length = 0;
    const folder = freshFolder('nolog');
    const fe = fakeElectron();
    const { phones } = handlerWith({ electron: fe, sampleMarker: fixedSampler(false) });
    const shell = fakeShell(folder);
    await phones.messages['phones-store-save']({ type: 'phones-store-save', text: REGISTRY }, shell);
    fs.writeFileSync(path.join(folder, STORE_FILE), `{"damaged": "${REGISTRY_MARKER}"`);
    await phones.messages['phones-store-save']({ type: 'phones-store-save', text: REGISTRY }, shell);
    await phones.messages['phones-pair-show'](offerMessage(), shell);
    FakeWindow.all[0].webContents.emit('did-finish-load');
    await phones.messages['phones-clipboard']({ type: 'phones-clipboard', text: LINK, clearAfterMs: 5000 }, shell);
    await phones.messages['phones-pair-show'](confirmMessage(), shell);
    FakeWindow.all[0].close();
    const everything = [...shell.logs, JSON.stringify(shell.tells), JSON.stringify(shell.notes), JSON.stringify(FakeWindow.all[0].webContents.sent)].join('\n');
    assert.equal(everything.includes(REGISTRY_MARKER), false);
    assert.equal(everything.includes(LINK_MARKER), false);
    assert.equal(everything.includes('enc1:'), false, 'no ciphertext prefix in the log');
  });
});
