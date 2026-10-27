'use strict';
// The desktop side of the phones (MOBILE.json desktop and transport.pairing, identity_storage). It answers the server's phones-*
// messages (lib/shell.mjs) and holds nothing the server does not hand it.
//  - phones-store-load / phones-store-save: the server's phone registry and keys as one opaque JSON text, kept in phones.json in the
//    desktop user-data folder and encrypted with Electron safeStorage, as desktop/keyvault.cjs does for API keys. Written through a
//    temporary file and a rename, one write at a time, mode 0600 where the system has modes. A file that cannot be parsed or decrypted
//    is damaged: it is set aside the next time phone data is saved (phones.json.damaged, then -2, -3 ...). A file another program holds
//    open is locked: nothing is answered as an empty registry and nothing is written over it.
//  - phones-pair-show / phones-pair-close: the pairing window (desktop/phones-pair.html), 420 x 640, capture-protected, one at a time.
//    The main process draws the QR code as a PNG (qrcode-generator, required here and nowhere else, so this file loads without it) and
//    sends the window a payload that holds the picture and no text of the code. The window answers through phones-pair-preload.cjs;
//    main takes an answer only from that window, only in the states where it means something, and passes it to the server as
//    phones-pair-answer { offer, action }. The window checks once for screen capture that is not excluded: a magenta square at its
//    top-left corner is read from a screen grab (the check in desktop/computer/capture.cjs). If the square shows, the code is hidden
//    and only Copy link remains.
//  - phones-indicator: an OS notification on the first phone connection of each launch.
//  - phones-presence: whether the desktop window has focus, and the system idle time in seconds, for the push rules.
//  - phones-clipboard: copies the link the server gives, and clears the clipboard when its time is up if it still holds that text.
//  - phones-artifact-picture: { artifact: <id> } gives a PNG of one staged artifact for a phone that shows pictures (POST /api/artifacts/picture,
//    lib/routes/remote.mjs, which must send the id as `artifact`). A hidden,
//    in-memory window loads the artifact view with the launch token on that one request, takes the picture after the load (or at 3 s),
//    and is destroyed. Its PNG is under 2 MB.
// Nothing here logs a body, a key, a token or a link: a log line names a file or a type, and no more. Errors are fixed sentences.
// The window's copy is in phones-pair.js; its states are listed there.

const nodeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const STORE_FILE = 'phones.json';
const STORE_VERSION = 1;
// The largest registry text the store takes. A registry with dozens of phones is a few kilobytes.
const MAX_STORE_TEXT = 1024 * 1024;
const MAX_LINK = 1200;
const MAX_CLIPBOARD = 4096;
const CLEAR_MIN_MS = 5000;
const CLEAR_MAX_MS = 600000;
const CLEAR_DEFAULT_MS = 120000;
const MAX_HINTS = 6;
const SERVER_STATES = ['offer', 'confirm', 'allowed', 'denied', 'expired', 'failed3', 'no-carrier'];
// The link the pairing QR shows, the tier a phone gets if allowed, and the app a phone pairs from (the server's words).
const QR_KINDS = ['tailscale', 'lan', 'relay', 'native'];
const TIERS = ['full', 'approve', 'read'];
const DEVICE_APPS = ['pwa', 'android', 'ios', 'lan-web'];
const ANSWERS = ['allow', 'deny', 'copy', 'new-code', 'cancel', 'done'];
// States in which the offer is still open on the server, so closing the window must cancel it.
const LIVE_STATES = ['offer', 'confirm'];
const PAIR_SIZE = { width: 420, height: 640 };
const QR_PIXELS = 280;
const QR_MARGIN = 4;
const MARKER_DELAY_MS = 300;
const PAIR_PARTITION = 'plenum-pair';
const PAIR_PAGE = path.join(__dirname, '..', 'phones-pair.html');
const PAIR_PRELOAD = path.join(__dirname, '..', 'phones-pair-preload.cjs');
const REAL_BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'];
const OFFER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^\d{6}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_PREFIX = 'data:image/png;base64,';
// A picture of an artifact: its window's session lives in memory (no persist: prefix), the window is 900 x 1200 CSS pixels, the wait for
// the load is 3 seconds, the whole job is 15 seconds at most, and the PNG must be under 2 MB.
const PICTURE_PARTITION = 'plenum-artifact-picture';
const PICTURE_SIZE = { width: 900, height: 1200 };
const PICTURE_WAIT_MS = 3000;
const PICTURE_TOTAL_MS = 15000;
const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
const PICTURE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PICTURE_FAILED = 'The picture could not be made.';
const PICTURE_TOO_BIG = 'That picture is too large to send.';
const PICTURE_NEEDS_APP = 'Pictures of artifacts need the desktop app.';
const PICTURE_BUSY = 'Plenum is busy drawing pictures. Try again in a moment.';
// Picture requests accepted and not yet answered, the one being drawn included. A request that would make a fourth is refused at once.
const PICTURE_MAX_PENDING = 3;

const UNAVAILABLE_NOTES = {
  win32: 'Plenum cannot keep phone keys because Windows encryption is not available to this app. Phone keys are never saved as plain text.',
  darwin: 'Plenum cannot keep phone keys because the macOS Keychain is not available. Unlock the login keychain and restart Plenum. Phone keys are never saved as plain text.',
  linux: 'Plenum cannot keep phone keys because no Linux secret service (GNOME Keyring or KDE Wallet) is available. Install and unlock one, then restart Plenum. Phone keys are never saved as plain text.',
};
const LOCKED = 'The phones file is open in another program, so it cannot be read or changed. Close that program and try again.';
const DAMAGED = 'The saved phones file could not be read, so it is set aside the next time phone data is saved.';
const BAD_TEXT = 'That phone data cannot be saved.';
const SAVE_FAILED = 'The phone data could not be saved.';
const NO_WINDOW = 'Pairing needs the Plenum desktop app.';
const NEEDS_BUILD = 'Pairing needs a newer build of Plenum. Update Plenum, then try again.';

// Text from the server or a phone that fits on one line of a window or a notification: control characters out, spaces collapsed, clipped.
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A whole number between min and max, or the fallback when the value is not a number.
function whole(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function unavailableNote(platform) {
  return UNAVAILABLE_NOTES[platform] ?? UNAVAILABLE_NOTES.linux;
}

// The Electron error for "pairing needs a build that has the QR module". The window says so; nothing else fails.
function needsBuild() {
  return Object.assign(new Error(NEEDS_BUILD), { code: 'NEEDS_BUILD' });
}

// ---------- the QR code as a PNG (1 bit, grey), drawn from qrcode-generator's matrix ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, tail]);
}

// A PNG data URL of a qrcode-generator object (after make()): dark modules black on white, a 4-module quiet zone, about QR_PIXELS wide.
function pngDataUrl(qr) {
  const n = qr.getModuleCount();
  const cell = Math.max(2, Math.floor(QR_PIXELS / (n + 2 * QR_MARGIN)));
  const size = (n + 2 * QR_MARGIN) * cell;
  const stride = Math.ceil(size / 8);
  const rows = Buffer.alloc((stride + 1) * size, 0xff);
  for (let y = 0; y < size; y++) {
    const start = y * (stride + 1);
    rows[start] = 0; // filter type: none
    const r = Math.floor(y / cell) - QR_MARGIN;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / cell) - QR_MARGIN;
      if (r >= 0 && r < n && c >= 0 && c < n && qr.isDark(r, c)) rows[start + 1 + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// The QR code for one link, as a PNG data URL. Throws needsBuild() when qrcode-generator is not installed (until track B adds it).
function drawQr(link, loadQr) {
  const qrcode = loadQr();
  if (typeof qrcode !== 'function') throw needsBuild();
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  return pngDataUrl(qr);
}

// ---------- the encrypted store (phones.json) ----------

// A store for one file. getSafeStorage returns Electron's safeStorage (or undefined when there is none); io is the file system.
// Every read and write runs one at a time. load() -> { ok, storage, text, damaged, message }; save(text) -> { ok, storage, message }.
function createStore({ file, getSafeStorage, platform, fs: io, log }) {
  let queue = Promise.resolve();
  const serial = task => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  // The safeStorage to use right now, or null when the system cannot keep anything it can read back. On Linux a basic backend that
  // Chromium supplies itself counts as none, as it does for keys.
  async function available() {
    const safe = getSafeStorage();
    let ok = false;
    try {
      ok = (await safe?.isAsyncEncryptionAvailable?.()) === true;
    } catch {
      ok = false;
    }
    if (ok && platform === 'linux') {
      let backend = 'unknown';
      try {
        backend = safe.getSelectedStorageBackend();
      } catch {
        backend = 'unknown';
      }
      ok = REAL_BACKENDS.includes(backend);
    }
    return ok ? safe : null;
  }

  // The file as it is now: missing, locked (it cannot be read: another program has it, or the system refuses), damaged, or ok with the data.
  function readRaw() {
    let contents;
    try {
      contents = io.readFileSync(file, 'utf8');
    } catch (err) {
      return { state: err?.code === 'ENOENT' ? 'missing' : 'locked' };
    }
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return { state: 'damaged' };
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || typeof parsed.data !== 'string') return { state: 'damaged' };
    return { state: 'ok', data: parsed.data };
  }

  // The name a damaged file is set aside under. A copy already there is never written over.
  function setAsideName() {
    let aside = `${file}.damaged`;
    for (let n = 2; io.existsSync(aside); n++) aside = `${file}.damaged-${n}`;
    return aside;
  }

  // Writes the file through a temporary file and a rename, so a crash cannot leave half a file.
  function writeRaw(data) {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      io.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, data }), { mode: 0o600 });
      io.renameSync(tmp, file);
    } catch (err) {
      try {
        io.unlinkSync(tmp);
      } catch {
        // No temporary file was left behind.
      }
      throw err;
    }
  }

  async function decrypt(safe, data) {
    const { result, shouldReEncrypt } = await safe.decryptStringAsync(Buffer.from(data, 'base64'));
    if (typeof result !== 'string' || !isJsonObject(result)) return null;
    return { text: result, shouldReEncrypt: shouldReEncrypt === true };
  }

  const damagedAnswer = () => ({ ok: true, storage: 'keychain', text: '', damaged: true, message: DAMAGED });

  async function load() {
    const safe = await available();
    if (!safe) return { ok: false, storage: 'unavailable', message: unavailableNote(platform) };
    const raw = readRaw();
    if (raw.state === 'missing') return { ok: true, storage: 'keychain', text: '', damaged: false };
    if (raw.state === 'locked') return { ok: false, storage: 'locked', message: LOCKED };
    if (raw.state === 'damaged') return damagedAnswer();
    let got = null;
    try {
      got = await decrypt(safe, raw.data);
    } catch {
      got = null;
    }
    if (!got) return damagedAnswer();
    // The system rotated its key: the same text is encrypted again with the new one. A failure changes nothing.
    if (got.shouldReEncrypt) {
      try {
        writeRaw(Buffer.from(await safe.encryptStringAsync(got.text)).toString('base64'));
      } catch {
        // The old ciphertext still reads; it is tried again at the next start.
      }
    }
    return { ok: true, storage: 'keychain', text: got.text, damaged: false };
  }

  async function save(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STORE_TEXT || !isJsonObject(value)) {
      return { ok: false, message: BAD_TEXT };
    }
    const safe = await available();
    if (!safe) return { ok: false, storage: 'unavailable', message: unavailableNote(platform) };
    let encrypted;
    try {
      encrypted = await safe.encryptStringAsync(value);
    } catch {
      return { ok: false, message: SAVE_FAILED };
    }
    const raw = readRaw();
    if (raw.state === 'locked') return { ok: false, storage: 'locked', message: LOCKED };
    if (raw.state === 'damaged') {
      try {
        const aside = setAsideName();
        io.renameSync(file, aside);
        if (log) log(`phones file set aside as ${path.basename(aside)}`);
      } catch {
        // If it cannot be set aside, the new file replaces it.
      }
    }
    try {
      writeRaw(Buffer.from(encrypted).toString('base64'));
    } catch {
      return { ok: false, message: SAVE_FAILED };
    }
    return { ok: true, storage: 'keychain' };
  }

  return {
    file,
    load: () => serial(load),
    save: value => serial(() => save(value)),
  };
}

// ---------- the handler ----------

// Reads the server's pairing message. Returns the fields the window needs, or { error } with a sentence for the server.
function readOffer(message) {
  const state = message.state;
  if (!SERVER_STATES.includes(state)) return { error: 'That pairing state is not known.' };
  const offer = {
    state,
    offer: typeof message.offer === 'string' && OFFER_ID.test(message.offer) ? message.offer : '',
    name: cleanText(message.name, 60),
    hints: Array.isArray(message.hints)
      ? message.hints.slice(0, MAX_HINTS).map(hint => ({ label: cleanText(hint?.label, 120), on: hint?.on === true })).filter(hint => hint.label)
      : [],
    expiresInS: whole(message.expiresInS, 0, 600, 0),
    code: typeof message.code === 'string' && CODE.test(message.code) ? message.code : '',
    device: message.device && typeof message.device === 'object'
      ? {
        name: cleanText(message.device.name, 60),
        platform: cleanText(message.device.platform, 30),
        carrier: cleanText(message.device.carrier, 40),
        app: DEVICE_APPS.includes(message.device.app) ? message.device.app : '',
      }
      : null,
    second: message.second === true,
    tried: message.tried === true,
    left: message.left === true,
    qrKind: QR_KINDS.includes(message.qrKind) ? message.qrKind : 'native',
    tier: TIERS.includes(message.tier) ? message.tier : 'full',
    link: typeof message.link === 'string' && message.link.length > 0 && message.link.length <= MAX_LINK ? message.link : '',
  };
  if ((state === 'offer' || state === 'confirm') && !offer.offer) return { error: 'The pairing code has no id.' };
  if (state === 'offer' && !offer.link) return { error: 'The pairing code has no link.' };
  if (state === 'confirm' && !offer.code) return { error: 'The pairing check code is missing.' };
  return offer;
}

// The default check for screen capture that is not excluded: the window's magenta square at its top-left corner, read from a grab of
// its display. True when the square shows, false when it does not, null when no grab could be made (the check is then not decisive).
// On macOS the first grab asks for screen recording, so no grab is made unless the system says that access is granted.
function defaultSampleMarker(electron, platform = process.platform) {
  return async win => {
    const api = electron();
    if (platform === 'darwin' && api?.systemPreferences?.getMediaAccessStatus?.('screen') !== 'granted') return null;
    const bounds = win.getContentBounds();
    const display = api.screen.getDisplayMatching(bounds);
    const scale = display.scaleFactor || 1;
    const physical = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
    const sources = await api.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical, fetchWindowIcons: false });
    const list = Array.isArray(sources) ? sources : [];
    const source = list.find(s => String(s.display_id) === String(display.id)) ?? list[0];
    const image = source?.thumbnail;
    if (!image || image.isEmpty()) return null;
    const size = image.getSize();
    const k = size.width / physical.width;
    // The square is 6 CSS pixels wide; its middle is 3 of them in.
    const x = Math.floor(((bounds.x - display.bounds.x) * scale + 3 * scale) * k);
    const y = Math.floor(((bounds.y - display.bounds.y) * scale + 3 * scale) * k);
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
    const bitmap = image.crop({ x, y, width: 1, height: 1 }).toBitmap();
    // BGRA, as capture.cjs reads it: magenta is red and blue high, green low.
    return bitmap[2] > 200 && bitmap[1] < 70 && bitmap[0] > 200;
  };
}

// Builds the handler. Options (all optional; the desktop uses none):
//   electron: the Electron main-process API, or a stand-in in tests (default: require('electron') at the time of use);
//   platform, fs: the platform name and the file system;
//   hidden: the windows are made invisible and never take focus (the harness and tests only; the desktop never sets it);
//   loadQr: returns the qrcode-generator function (default: require it, or throw needsBuild);
//   sampleMarker: async (window) => true | false | null (default: defaultSampleMarker);
//   markerDelayMs: the wait before the marker check (default 300 ms).
function createPhones(options = {}) {
  const platform = options.platform ?? process.platform;
  const io = options.fs ?? nodeFs;
  const hidden = options.hidden === true;
  const markerDelayMs = options.markerDelayMs ?? MARKER_DELAY_MS;
  const pictureWaitMs = options.pictureWaitMs ?? PICTURE_WAIT_MS;
  const pictureTotalMs = options.pictureTotalMs ?? PICTURE_TOTAL_MS;
  let electronOverride = options.electron ?? null;
  // The Electron API of this process, or null where there is none (plain Node: the electron package is a path, or missing).
  const electron = () => {
    if (electronOverride) return electronOverride;
    try {
      return require('electron');
    } catch {
      return null;
    }
  };
  const loadQr = options.loadQr ?? (() => {
    try {
      return require('qrcode-generator');
    } catch {
      throw needsBuild();
    }
  });
  const sampleMarker = options.sampleMarker ?? defaultSampleMarker(electron, platform);

  let storeCache = null;
  // The pairing window's state, or null when there is none.
  let pair = null;
  let ipcBound = false;
  let notifiedThisLaunch = false;
  // Notifications are kept in variables so one is not collected before its click can be handled.
  let indicatorNote = null;

  function storeFor(shell, file) {
    if (!storeCache || storeCache.file !== file) {
      storeCache = createStore({
        file,
        getSafeStorage: () => electron()?.safeStorage,
        platform,
        fs: io,
        log: line => shell.log?.(line),
      });
    }
    return storeCache;
  }

  // ----- the pairing window -----

  function bindIpc(api) {
    if (ipcBound || !api.ipcMain) return;
    ipcBound = true;
    api.ipcMain.on('phones-pair:answer', onAnswer);
  }

  // Locks the window down: no new windows, no navigation, no permissions, and no request that is not the page's own file.
  function lockDown(api, win) {
    const contents = win.webContents;
    try {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-attach-webview', event => event.preventDefault());
    } catch {
      // A window without these hooks cannot navigate anyway.
    }
    try {
      const ses = api.session?.fromPartition?.(PAIR_PARTITION);
      if (!ses) return;
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      if (typeof ses.setPermissionCheckHandler === 'function') ses.setPermissionCheckHandler(() => false);
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        callback({ cancel: !String(details.url ?? '').startsWith('file:') });
      });
    } catch {
      // Without the session rules the page still has its content security policy.
    }
  }

  function reveal(p) {
    if (p.win.isDestroyed()) return;
    if (p.hidden) {
      p.win.showInactive();
    } else {
      p.win.show();
      p.win.focus();
    }
  }

  // The payload the window renders. It carries the picture and no text of the code; the window never gets the offer id.
  function pushPayload(p) {
    if (!p.loaded || p.win.isDestroyed()) return;
    p.win.webContents.send('phones-pair:offer', {
      state: p.shown || 'loading',
      seq: p.seq,
      name: p.name || 'this computer',
      hints: p.hints,
      expiresInS: p.expiresInS,
      code: p.code,
      device: p.device,
      second: p.second,
      tried: p.tried,
      left: p.left,
      qrKind: p.qrKind,
      tier: p.tier,
      qrPng: p.qrPng,
      captureVisible: p.captureVisible,
      copied: p.copied,
    });
  }

  function tellServer(p, action) {
    try {
      p.shell?.tell?.({ type: 'phones-pair-answer', offer: p.offer, action });
    } catch {
      // The server went away; its offer dies with it.
    }
  }

  // Closes the window. With cancel, a live offer is cancelled on the server first (the Cancel button); without it, the server already
  // knows the outcome (phones-pair-close, or the window's own Done).
  function closePairing(cancel) {
    const p = pair;
    if (!p) return;
    pair = null;
    if (cancel && LIVE_STATES.includes(p.serverState)) tellServer(p, 'cancel');
    if (!p.win.isDestroyed()) p.win.close();
  }

  // The window's answers. Only the pairing window may send them (event.sender), and each is taken only where it means something.
  function onAnswer(event, action) {
    const p = pair;
    if (!p || p.win.isDestroyed() || !event || event.sender !== p.win.webContents) return;
    if (typeof action !== 'string' || !ANSWERS.includes(action)) return;
    if (action === 'done') return closePairing(false);
    if (action === 'cancel') return closePairing(true);
    if (action === 'copy') {
      if (p.serverState === 'offer') tellServer(p, 'copy');
      return undefined;
    }
    if (action === 'allow' || action === 'deny') {
      // One answer per offer: the second click on Allow or Deny is ignored until the server answers.
      if (p.serverState !== 'confirm' || p.pending) return undefined;
      p.pending = action;
      tellServer(p, action);
      return undefined;
    }
    if (action === 'new-code' && ['offer', 'expired', 'failed3'].includes(p.serverState)) tellServer(p, 'new-code');
    return undefined;
  }

  // Checks once per window for capture that is not excluded. A check that reads the square as visible hides the code from then on.
  function maybeCheck(p) {
    if (p.checked || !p.loaded || p.shown !== 'offer') return;
    p.checked = true;
    const timer = setTimeout(async () => {
      let visible = null;
      try {
        visible = await sampleMarker(p.win);
      } catch {
        visible = null;
      }
      if (pair !== p || p.win.isDestroyed()) return;
      if (visible === true && !p.captureVisible) {
        p.captureVisible = true;
        p.qrPng = '';
        p.shell?.log?.('the pairing window is visible to screen capture; the code is hidden');
        pushPayload(p);
      }
    }, markerDelayMs);
    timer.unref?.();
  }

  // The window for this pairing, made on first use. Null when this process has no windows (plain Node).
  function windowFor(shell) {
    if (pair && !pair.win.isDestroyed()) {
      pair.shell = shell;
      return pair;
    }
    const api = electron();
    if (!api || typeof api.BrowserWindow !== 'function') return null;
    bindIpc(api);
    const dark = api.nativeTheme?.shouldUseDarkColors === true;
    const options = {
      width: PAIR_SIZE.width,
      height: PAIR_SIZE.height,
      useContentSize: true,
      title: 'Add a phone',
      autoHideMenuBar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: dark ? '#0a0a11' : '#f6f6fb',
      webPreferences: {
        preload: PAIR_PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        devTools: false,
        spellcheck: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        partition: PAIR_PARTITION,
      },
    };
    if (hidden) Object.assign(options, { opacity: 0, focusable: false, skipTaskbar: true });
    const win = new api.BrowserWindow(options);
    // At some display scale factors the frame rounds the content size by a pixel or two. The size is set, read back, and set again
    // with the difference taken off, for at most three passes.
    try {
      let want = { width: PAIR_SIZE.width, height: PAIR_SIZE.height };
      for (let pass = 0; pass < 3; pass++) {
        win.setContentSize(want.width, want.height);
        const got = win.getContentSize();
        if (!Array.isArray(got) || (got[0] === PAIR_SIZE.width && got[1] === PAIR_SIZE.height)) break;
        want = { width: want.width - (got[0] - PAIR_SIZE.width), height: want.height - (got[1] - PAIR_SIZE.height) };
      }
    } catch {
      // The window keeps the size it was made with.
    }
    const p = {
      win,
      shell,
      hidden,
      ready: false,
      loaded: false,
      serverState: '',
      shown: '',
      offer: '',
      name: '',
      hints: [],
      expiresInS: 0,
      code: '',
      device: null,
      second: false,
      tried: false,
      left: false,
      qrKind: 'native',
      tier: 'full',
      qrPng: '',
      captureVisible: false,
      copied: false,
      checked: false,
      pending: '',
      seq: 0,
    };
    pair = p;
    lockDown(api, win);
    try {
      win.setMenu(null);
    } catch {
      // The window has no menu bar to remove on this system.
    }
    try {
      win.setContentProtection(true);
    } catch {
      // Without protection the marker check finds the code on screen and hides it.
    }
    win.once('ready-to-show', () => {
      p.ready = true;
      reveal(p);
    });
    win.webContents.on('did-finish-load', () => {
      p.loaded = true;
      pushPayload(p);
      maybeCheck(p);
    });
    win.webContents.on('did-fail-load', (_event, _code, _text, _url, isMainFrame) => {
      if (isMainFrame === false || pair !== p) return;
      pair = null;
      if (!win.isDestroyed()) win.close();
    });
    win.on('closed', () => {
      if (pair !== p) return;
      pair = null;
      if (LIVE_STATES.includes(p.serverState)) tellServer(p, 'cancel');
    });
    win.loadFile(PAIR_PAGE).catch(() => {
      if (pair === p) closePairing(false);
    });
    return p;
  }

  // phones-pair-show: the server's pairing state. The window is made or updated; the QR is drawn here, in the main process.
  function showPairing(message, shell) {
    const offer = readOffer(message);
    if (offer.error) return { ok: false, message: offer.error };
    let shown = offer.state;
    let qrPng = '';
    if (offer.state === 'offer') {
      try {
        qrPng = drawQr(offer.link, loadQr);
      } catch (err) {
        if (err?.code !== 'NEEDS_BUILD') return { ok: false, message: 'The code could not be drawn. Try again.' };
        shown = 'needs-build';
      }
    }
    const p = windowFor(shell);
    if (!p) return { ok: false, message: NO_WINDOW };
    p.serverState = offer.state;
    p.shown = shown;
    p.offer = offer.offer;
    p.name = offer.name;
    p.hints = offer.hints;
    p.expiresInS = offer.expiresInS;
    p.code = offer.code;
    p.device = offer.device;
    p.second = offer.second;
    p.tried = offer.tried;
    p.left = offer.left;
    p.qrKind = offer.qrKind;
    p.tier = offer.tier;
    p.qrPng = shown === 'offer' && !p.captureVisible ? qrPng : '';
    p.copied = false;
    p.pending = '';
    p.seq += 1;
    if (p.ready) reveal(p);
    pushPayload(p);
    maybeCheck(p);
    return { ok: true };
  }

  // ----- the other messages -----

  function notifyConnected(shell, name) {
    const Notification = shell.Notification;
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;
    const computer = cleanText(os.hostname(), 60) || 'this computer';
    indicatorNote = new Notification({ title: `Phone connected: ${name}`, body: `Plenum on ${computer}` });
    indicatorNote.on('click', () => shell.showWindow());
    indicatorNote.show();
  }

  function indicate(message, shell) {
    const names = Array.isArray(message.connected)
      ? message.connected.map(name => cleanText(name, 60)).filter(Boolean).slice(0, 8)
      : [];
    if (names.length > 0 && !notifiedThisLaunch) {
      notifiedThisLaunch = true;
      notifyConnected(shell, names[0]);
    }
    return { ok: true };
  }

  function presence(shell) {
    const win = typeof shell.win === 'function' ? shell.win() : null;
    const focused = Boolean(win && typeof win.isFocused === 'function' && win.isFocused());
    let idleS = 0;
    try {
      idleS = whole(electron()?.powerMonitor?.getSystemIdleTime(), 0, 1e9, 0);
    } catch {
      idleS = 0;
    }
    return { ok: true, focused, idleS };
  }

  function copyLink(message) {
    const value = typeof message.text === 'string' && message.text.length > 0 && message.text.length <= MAX_CLIPBOARD ? message.text : null;
    if (!value) return { ok: false, message: 'That text cannot be copied.' };
    const clipboard = electron()?.clipboard;
    if (!clipboard) return { ok: false, message: 'Copying needs the Plenum desktop app.' };
    const ms = whole(message.clearAfterMs, CLEAR_MIN_MS, CLEAR_MAX_MS, CLEAR_DEFAULT_MS);
    clipboard.writeText(value);
    const timer = setTimeout(() => {
      try {
        // Only what this copied is cleared; a later copy by the person stays.
        if (clipboard.readText() === value) clipboard.clear();
      } catch {
        // The clipboard was not reachable; nothing else to do.
      }
    }, ms);
    timer.unref?.();
    if (pair && pair.serverState === 'offer') {
      pair.copied = true;
      pushPayload(pair);
    }
    return { ok: true };
  }

  // ----- a picture of an artifact (POST /api/artifacts/picture; MOBILE.json powers.adapters) -----

  // The picture is drawn in a window nobody sees: opacity 0, not focusable, no taskbar entry, and no mouse events, so it cannot take a
  // click from the person. It loads the staged artifact from this computer's own server through a session that lives in memory and is
  // shared with no other window. That session adds the launch token to the one loopback request for the artifact and cancels every
  // other request the page makes (the artifact's policy allows no network in the first place). One picture is drawn at a time.
  let pictureQueue = Promise.resolve();
  let picturesPending = 0;
  let pictureWindow = null;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // True only for the artifact view on this server, and for the data, blob and about addresses the page itself makes.
  function pictureAllowed(url, port) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') return true;
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) === port && parsed.pathname === '/api/artifacts/view';
  }

  // Ends the picture window and forgets what its session kept. Safe to call twice.
  function closePicture(win, session) {
    if (pictureWindow === win) pictureWindow = null;
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      // The window was already gone.
    }
    if (session) {
      Promise.resolve().then(() => session.clearStorageData?.()).catch(() => {});
      Promise.resolve().then(() => session.clearCache?.()).catch(() => {});
    }
  }

  // Draws one artifact and returns { ok, png } as a PNG data URL, or { ok: false, message }. Never throws.
  async function drawPicture(api, shell, id, { waitMs, totalMs }) {
    const port = whole(shell.port, 1, 65535, 0);
    const token = typeof shell.token === 'string' ? shell.token : '';
    if (!port || !token) return { ok: false, message: PICTURE_NEEDS_APP };
    const url = `http://127.0.0.1:${port}/api/artifacts/view?id=${encodeURIComponent(id)}`;
    let session = null;
    let win = null;
    // Set by the wait below; the session's status listener reaches it through this job's own variable.
    let onViewStatus = null;
    try {
      session = api.session?.fromPartition?.(PICTURE_PARTITION) ?? null;
      if (!session?.webRequest) return { ok: false, message: PICTURE_NEEDS_APP };
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      if (typeof session.setPermissionCheckHandler === 'function') session.setPermissionCheckHandler(() => false);
      session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        callback({ cancel: !pictureAllowed(details.url, port) });
      });
      session.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/api/artifacts/view*`] }, (details, callback) => {
        callback({ requestHeaders: { ...details.requestHeaders, 'x-plenum-token': token } });
      });
      session.webRequest.onCompleted({ urls: [`http://127.0.0.1:${port}/api/artifacts/view*`] }, details => {
        if (onViewStatus) onViewStatus(details.statusCode);
      });

      win = new api.BrowserWindow({
        width: PICTURE_SIZE.width,
        height: PICTURE_SIZE.height,
        show: false,
        opacity: 0,
        focusable: false,
        skipTaskbar: true,
        webPreferences: {
          partition: PICTURE_PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          devTools: false,
          spellcheck: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          backgroundThrottling: false,
          paintWhenInitiallyHidden: true,
        },
      });
      pictureWindow = win;
      try {
        win.setIgnoreMouseEvents(true);
      } catch {
        // Without this the window still has opacity 0; it is only a little less safe.
      }
      const contents = win.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-attach-webview', event => event.preventDefault());

      return await new Promise(resolve => {
        let settled = false;
        let captured = false;
        let waitTimer = null;
        let hardTimer = null;
        const finish = result => {
          if (settled) return;
          settled = true;
          clearTimeout(waitTimer);
          clearTimeout(hardTimer);
          resolve(result);
        };
        // An answer that is an error (an expired id, say) is not pictured: its error page is not the artifact.
        onViewStatus = status => {
          if (status >= 400) finish({ ok: false, message: PICTURE_FAILED });
        };
        // The picture is taken at the end of the load, or at waitMs when the load has not ended by then. totalMs ends the wait whatever
        // is still pending.
        const capture = async () => {
          if (captured || settled) return;
          captured = true;
          clearTimeout(waitTimer);
          try {
            // A capture made at the very end of the load can fail, because no frame has been drawn yet: it is tried again a few times.
            const shot = async () => {
              let failure = null;
              for (let attempt = 0; attempt < 4 && !win.isDestroyed(); attempt += 1) {
                await delay(attempt === 0 ? 150 : 300);
                try {
                  return await contents.capturePage();
                } catch (err) {
                  failure = err;
                }
              }
              throw failure ?? new Error('The window is gone.');
            };
            let image = await shot();
            if (image.isEmpty() && !win.isDestroyed()) {
              win.showInactive();
              await delay(300);
              image = await shot();
            }
            let png = image.isEmpty() ? null : image.toPNG();
            if (png && png.length >= PICTURE_MAX_BYTES) {
              const size = image.getSize();
              png = image.resize({ width: Math.max(1, Math.floor(size.width / 2)) }).toPNG();
            }
            if (!png) return finish({ ok: false, message: PICTURE_FAILED });
            if (png.length >= PICTURE_MAX_BYTES) return finish({ ok: false, message: PICTURE_TOO_BIG });
            return finish({ ok: true, png: `${PNG_PREFIX}${png.toString('base64')}` });
          } catch {
            return finish({ ok: false, message: PICTURE_FAILED });
          }
        };
        contents.once('did-finish-load', () => { void capture(); });
        contents.once('did-fail-load', (_event, _code, _text, _url, isMainFrame) => {
          if (isMainFrame !== false) finish({ ok: false, message: PICTURE_FAILED });
        });
        waitTimer = setTimeout(() => { void capture(); }, waitMs);
        hardTimer = setTimeout(() => finish({ ok: false, message: PICTURE_FAILED }), totalMs);
        win.showInactive();
        Promise.resolve(win.loadURL(url)).catch(() => finish({ ok: false, message: PICTURE_FAILED }));
      });
    } catch {
      return { ok: false, message: PICTURE_FAILED };
    } finally {
      closePicture(win, session);
    }
  }

  // The server's request for a picture. The reply is { ok, png } or { ok: false, message }; the queue keeps one window at a time. The artifact
  // id comes in as `artifact`: shellRequest puts its own correlation id in `id`, so a payload named id never reaches the desktop.
  // A paired phone of any tier can ask, so at most PICTURE_MAX_PENDING requests wait at once; a request beyond that is refused without a window.
  function artifactPicture(message, shell) {
    const id = typeof message?.artifact === 'string' ? message.artifact : '';
    if (!PICTURE_ID.test(id)) return { ok: false, message: 'Say which artifact.' };
    const api = electron();
    if (!api || typeof api.BrowserWindow !== 'function') return { ok: false, message: PICTURE_NEEDS_APP };
    if (picturesPending >= PICTURE_MAX_PENDING) return { ok: false, message: PICTURE_BUSY };
    picturesPending += 1;
    const run = pictureQueue
      .then(() => drawPicture(api, shell, id, { waitMs: pictureWaitMs, totalMs: pictureTotalMs }))
      .finally(() => {
        picturesPending -= 1;
      });
    pictureQueue = run.catch(() => {});
    return run;
  }

  const messages = {
    // -> phones-store-load-result: { ok, storage, text, damaged, message }. The text is the server's own registry, read back as it was saved.
    'phones-store-load': (message, shell) => storeFor(shell, path.join(String(shell.userData), STORE_FILE)).load(),
    // -> phones-store-save-result: { ok, storage, message }. The text is never echoed.
    'phones-store-save': (message, shell) => storeFor(shell, path.join(String(shell.userData), STORE_FILE)).save(message.text),
    'phones-pair-show': (message, shell) => showPairing(message, shell),
    'phones-pair-close': () => {
      closePairing(false);
      return { ok: true };
    },
    'phones-indicator': (message, shell) => indicate(message, shell),
    'phones-presence': (message, shell) => presence(shell),
    'phones-clipboard': message => copyLink(message),
    // -> phones-artifact-picture-result: { ok, png } (a PNG data URL) or { ok: false, message }. Drawn in a hidden window (see above).
    'phones-artifact-picture': (message, shell) => artifactPicture(message, shell),
  };

  const hooks = {
    // The pairing window closes with the app, and with the server (its offers die with it). A picture in progress is closed too.
    beforeQuit: () => {
      closePairing(false);
      if (pictureWindow && !pictureWindow.isDestroyed()) pictureWindow.destroy();
      pictureWindow = null;
    },
    serverExited: () => closePairing(false),
  };

  return {
    messages,
    hooks,
    // For tests and the harness: the Electron stand-in to use from now on.
    setElectron(api) {
      electronOverride = api;
    },
  };
}

const handler = createPhones();

module.exports = {
  name: 'phones',
  messages: handler.messages,
  hooks: handler.hooks,
  setElectron: handler.setElectron,
  createPhones,
  createStore,
  pngDataUrl,
  drawQr,
  crc32,
  STORE_FILE,
  PAIR_PAGE,
  PAIR_PRELOAD,
};
