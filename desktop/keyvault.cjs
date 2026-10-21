'use strict';
// The key vault of the desktop app. It runs in the Electron main process only. API keys are encrypted with the operating system
// (Electron safeStorage: Windows data protection, the macOS Keychain, or the Linux secret service) and written to one file in the
// app's user-data folder, as base64 ciphertext. The server never reads that file: main decrypts the keys and sends them to the
// server over its channel, and the server holds them in memory only (lib/keys.mjs).
// A key is never logged and never put in an error message.
const nodeFs = require('node:fs');
const path = require('node:path');

// Every key the app stores, by environment variable name. lib/keys.mjs builds the same list from lib/api-providers.mjs.
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY'];
// The same limits lib/keys.mjs holds every key to.
const MIN_LEN = 20;
const MAX_LEN = 300;
// On Linux these are the password managers safeStorage can use. basic_text, which is also what an unrecognised desktop gets,
// only hides the key behind a password built into Chromium, so it counts as no keychain at all.
const REAL_BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'];

const looksLikeKey = v => typeof v === 'string' && v.length >= MIN_LEN && v.length <= MAX_LEN && !/\s/.test(v);
const scrub = (text, secret) => (secret ? String(text).split(secret).join('[key]') : String(text));

// Returns a copy of an environment without any key the app stores. Windows ignores case in names, so this does too.
function stripKeys(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (!KEY_NAMES.includes(name.toUpperCase())) out[name] = value;
  }
  return out;
}

const KEYCHAIN_NOTES = {
  win32: 'Keys are encrypted with your Windows account and kept in memory only while Plenum runs.',
  darwin: 'Keys are saved in the macOS Keychain and kept in memory only while Plenum runs.',
  linux: 'Keys are saved in the Linux secret service (GNOME Keyring or KDE Wallet) and kept in memory only while Plenum runs.',
};
const UNAVAILABLE_NOTES = {
  win32: 'Plenum cannot save keys because Windows encryption is not available to this app. Keys are never saved as plain text.',
  darwin: 'Plenum cannot save keys because the macOS Keychain is not available. Unlock the login keychain and restart Plenum. Keys are never saved as plain text.',
  linux: 'Plenum cannot save keys because no Linux secret service (GNOME Keyring or KDE Wallet) is available. Install and unlock one, then restart Plenum. Keys are never saved as plain text.',
};
const LOCKED_MESSAGE = 'The key store is locked by another program. Close it and try again.';
const SESSION_NOTE ='This Linux computer has no secret service (GNOME Keyring or KDE Wallet) that Plenum can use, only a plain-text fallback, so keys are kept for this session only and are forgotten when Plenum closes. Install and unlock a secret service to keep keys between sessions.';

// safeStorage is Electron's. file is where the encrypted keys go. platform and fs can be replaced so the Mac and Linux rules and
// the file handling can be tested on any machine.
function createKeyVault({ safeStorage, file, platform = process.platform, fs = nodeFs }) {
  // Keys kept for this session only (Linux without a secret service). Main keeps them so a restarted server gets them again.
  const session = new Map();
  let queue = Promise.resolve();

  // Decides where keys can be kept right now: the operating system's store, this session only, or nowhere.
  async function storageMode() {
    let available = false;
    try {
      available = (await safeStorage.isAsyncEncryptionAvailable()) === true;
    } catch {
      available = false;
    }
    if (!available) return { storage: 'unavailable', note: UNAVAILABLE_NOTES[platform] ?? UNAVAILABLE_NOTES.linux };
    if (platform === 'linux') {
      let backend = 'unknown';
      try {
        backend = safeStorage.getSelectedStorageBackend();
      } catch {
        // An unreadable backend is treated as one that is not trusted.
      }
      if (!REAL_BACKENDS.includes(backend)) return { storage: 'session', note: SESSION_NOTE };
    }
    return { storage: 'keychain', note: KEYCHAIN_NOTES[platform] ?? KEYCHAIN_NOTES.linux };
  }

  // The file as saved: { keys: { NAME: base64 }, damaged, locked }. A missing file is empty. One that is there but cannot be
  // parsed is empty too, marked damaged, and is set aside before the next save writes a new one. One that cannot be read for
  // any other reason (another program has it open, or the system refuses access) is empty, marked locked, and is left alone:
  // it may hold keys that are fine, so no save writes over it until it can be read.
  function readRaw() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { keys: {}, damaged: false, locked: err?.code !== 'ENOENT' };
    }
    try {
      const parsed = JSON.parse(text);
      const keys = {};
      for (const name of KEY_NAMES) {
        if (parsed && typeof parsed.keys === 'object' && parsed.keys !== null && typeof parsed.keys[name] === 'string') keys[name] = parsed.keys[name];
      }
      return { keys, damaged: false, locked: false };
    } catch {
      return { keys: {}, damaged: true, locked: false };
    }
  }

  // Writes the file through a temporary file and a rename, so a crash cannot leave half a file. Only the owner can read it.
  function writeRaw(keys) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Runs one change to the file at a time, so two saves close together cannot overwrite each other.
  function serial(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  // Returns { storage, note, keys } for the server's first request: how keys are kept, and the keys themselves.
  async function load() {
    const mode = await storageMode();
    const keys = {};
    let note = mode.note;
    if (mode.storage === 'session') {
      for (const [name, value] of session) keys[name] = value;
    } else if (mode.storage === 'keychain') {
      const raw = readRaw();
      let skipped = 0;
      const stale = [];
      for (const name of KEY_NAMES) {
        if (typeof raw.keys[name] !== 'string') continue;
        try {
          const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(raw.keys[name], 'base64'));
          if (looksLikeKey(result)) keys[name] = result;
          else skipped++;
          if (shouldReEncrypt && looksLikeKey(result)) stale.push(name);
        } catch {
          skipped++;
        }
      }
      if (skipped > 0) note += ` ${skipped === 1 ? 'One saved key' : `${skipped} saved keys`} could not be unlocked with this account and was skipped.`;
      // The operating system rotated its key, so the keys are encrypted again with the new one. A failure here changes nothing.
      if (stale.length > 0) {
        await serial(async () => {
          try {
            const current = readRaw();
            // A file that cannot be read now is not rewritten from what is left of it.
            if (current.locked || current.damaged) throw new Error('The key store cannot be read.');
            for (const name of stale) current.keys[name] = Buffer.from(await safeStorage.encryptStringAsync(keys[name])).toString('base64');
            writeRaw(current.keys);
          } catch {
            // The old ciphertext still works; it is tried again at the next start.
          }
        });
      }
    }
    return { storage: mode.storage, note, keys };
  }

  async function saveNow(name, value) {
    try {
      if (!KEY_NAMES.includes(name)) return { ok: false, message: 'That key name cannot be saved.' };
      if (!looksLikeKey(value)) return { ok: false, message: 'That does not look like an API key.' };
      const mode = await storageMode();
      if (mode.storage === 'unavailable') return { ok: false, storage: 'unavailable', note: mode.note, message: mode.note };
      if (mode.storage === 'session') {
        session.set(name, value);
        return { ok: true, storage: 'session', note: mode.note };
      }
      const encrypted = await safeStorage.encryptStringAsync(value);
      const raw = readRaw();
      // The file is there but cannot be read right now, so the keys already in it are unknown. Writing would lose them.
      if (raw.locked) return { ok: false, message: LOCKED_MESSAGE };
      if (raw.damaged) {
        try {
          fs.renameSync(file, `${file}.damaged`);
        } catch {
          // If it cannot be set aside, the new file replaces it.
        }
      }
      raw.keys[name] = Buffer.from(encrypted).toString('base64');
      writeRaw(raw.keys);
      return { ok: true, storage: 'keychain', note: mode.note };
    } catch (err) {
      return { ok: false, message: `The key could not be saved: ${scrub(err?.message ?? err, value).slice(0, 200)}` };
    }
  }

  // Saves one key. Resolves { ok, storage, note } or { ok: false, message }; it does not throw.
  function save(name, value) {
    return serial(() => saveNow(name, value));
  }

  return { load, save };
}

module.exports = { KEY_NAMES, createKeyVault, stripKeys };
