import { readUserEnv } from './accounts.mjs';
import { API_PROVIDERS, apiProvider } from './api-providers.mjs';
import { setToken } from './auth.mjs';

// API keys for the model providers that bill per token (xAI, OpenAI, DeepSeek, Mistral, Google AI, OpenRouter) and the Anthropic API key.
// The list comes from lib/api-providers.mjs, so a provider added there is stored, listed and tested here with no other change.
// Where a key lives depends on how Plenum was started:
//  - The desktop app runs this server as a utility process. Its main process keeps the keys encrypted with the operating
//    system (desktop/keyvault.cjs) and sends them here over the channel it opened. They are held in memory only.
//  - Started with plain Node (npm start), there is no channel. Keys come from environment variables only and cannot be saved.
// A key is never logged, never written to the app's state file, never put in an environment and never sent back to the browser.

// The one-off check gives up after this long, so a stalled provider cannot hang the Accounts panel.
const TEST_TIMEOUT_MS = 15_000;
// The same limits the Anthropic key check in server.mjs uses, so every provider is held to one rule.
const MIN_LEN = 20;
const MAX_LEN = 300;
// How long to wait for the desktop app to hand over the saved keys at start, and for it to confirm one save.
const HELLO_TIMEOUT_MS = 5_000;
const SAVE_TIMEOUT_MS = 15_000;

// The Anthropic key is stored like the others but is not one of the providers listed in the Accounts panel.
const ANTHROPIC = { id: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY' };
// Every key the store accepts, by environment variable name. desktop/keyvault.cjs keeps the same list.
const NAMES = [ANTHROPIC.envVar, ...API_PROVIDERS.map(p => p.envVar)];
const ITEMS = [...API_PROVIDERS.map(p => ({ id: p.id, label: p.label, envVar: p.envVar })), ANTHROPIC];
// What the desktop app can report: keys saved in the operating system's store, kept for this session only (Linux without a
// secret service), or refused. The fourth mode, environment, is the one with no desktop app.
const MODES = ['keychain', 'session', 'unavailable'];

const NOTES = {
  environment: 'Keys are read from environment variables only, because Plenum was started with Node and not as the desktop app. Set the provider\'s variable (for example OPENAI_API_KEY) and restart Plenum. The desktop app keeps keys in the operating system\'s keychain instead.',
  keychain: 'Keys are saved encrypted by the operating system. Plenum holds them in memory only while it runs.',
  session: 'This computer has no keychain Plenum can use, so keys are kept for this session only and are forgotten when Plenum closes.',
  unavailable: 'Plenum cannot save keys on this computer because the operating system\'s encryption is not available. Keys are never saved as plain text.',
  silent: 'Plenum could not reach its desktop app to load the saved keys, so keys cannot be saved or used. Restart Plenum.',
};
// What a save adds to the message, by where the key went.
const SAVED = {
  keychain: 'It is saved encrypted by the operating system.',
  session: 'It is kept for this session only and is forgotten when Plenum closes.',
};

// Where keys come from now. Everything here is in memory; the only copy on disk is the desktop app's encrypted file.
let port = null;
let storage = { mode: 'environment', note: NOTES.environment };
const memory = new Map(); // key name -> key
const waiting = new Map(); // save request id -> { resolve, timer }
let nextId = 0;
let onKeys = null;

// Unknown provider ids are a client mistake, so they carry a 400 status for the server to report.
function provider(id) {
  const p = apiProvider(id);
  if (!p) throw Object.assign(new Error('Pick a provider from the list.'), { status: 400 });
  return p;
}

// A value that is only spaces counts as not set.
const clean = v => (typeof v === 'string' ? v.trim() : '');
const looksLikeKey = v => v.length >= MIN_LEN && v.length <= MAX_LEN && !/\s/.test(v);
// Takes a key out of a message before the message is shown or passed on.
const scrub = (text, ...secrets) => secrets.reduce((t, s) => (s ? t.split(s).join('[key]') : t), String(text));

// The channel to the desktop app, as { post(message), onMessage(handler) }. Electron gives a utility process its parent as
// process.parentPort. A launcher that starts the server with Node's own message channel can ask for it with
// MUSE_CONSOLE_KEY_CHANNEL=ipc. A plain `node server.mjs` has neither, and gets null.
export function parentChannel() {
  const parent = process.parentPort;
  if (parent) return { post: m => parent.postMessage(m), onMessage: fn => parent.on('message', e => fn(e?.data)) };
  if (process.env.MUSE_CONSOLE_KEY_CHANNEL === 'ipc' && typeof process.send === 'function') {
    return { post: m => process.send(m), onMessage: fn => process.on('message', fn) };
  }
  return null;
}

// Reads the desktop app's answer: how keys are stored, and the saved keys themselves.
function applyKeys(msg) {
  const mode = MODES.includes(msg.storage) ? msg.storage : 'unavailable';
  memory.clear();
  if (mode !== 'unavailable' && msg.keys && typeof msg.keys === 'object') {
    for (const name of NAMES) {
      const value = Object.hasOwn(msg.keys, name) ? clean(msg.keys[name]) : '';
      if (value) memory.set(name, value);
    }
  }
  const note = clean(msg.note).slice(0, 400);
  storage = { mode, note: note || NOTES[mode] };
  // The desktop app also hands over this launch's token in the same message (lib/auth.mjs). A bad value is ignored.
  if (typeof msg.token === 'string') setToken(msg.token, 'desktop');
  onKeys?.();
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'keys') return applyKeys(msg);
  // delete-key-result is the answer the desktop app's channel gives when its handler fails for a removal, so it is waited for too.
  if (msg.type === 'save-key-result' || msg.type === 'delete-key-result') {
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    clearTimeout(w.timer);
    w.resolve(msg);
  }
}

// Called once at start, before the server listens. With a channel it asks the desktop app for the saved keys and waits for
// them, so the first request already sees them. With null (a plain Node run) keys come from the environment only.
export function connectKeyChannel(channel, { timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  memory.clear();
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
  port = channel ?? null;
  if (!port) {
    storage = { mode: 'environment', note: NOTES.environment };
    return Promise.resolve(keyStorage());
  }
  storage = { mode: 'unavailable', note: NOTES.silent };
  port.onMessage(onMessage);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      onKeys = null;
      resolve(keyStorage());
    }, timeoutMs);
    onKeys = () => {
      clearTimeout(timer);
      onKeys = null;
      resolve(keyStorage());
    };
    port.post({ type: 'keys-hello' });
  });
}

// How keys are kept right now, in words for the Accounts panel. canSave is false when a save would be refused.
export function keyStorage() {
  return { mode: storage.mode, canSave: storage.mode === 'keychain' || storage.mode === 'session', message: storage.note };
}

// Finds a stored key by its environment variable name, and where it came from. The desktop app never has the key in an
// environment, so with a channel only the memory is read; without one only the environment is.
function lookup(envVar) {
  if (storage.mode === 'environment') {
    const fromEnv = clean(process.env[envVar]);
    return fromEnv ? { key: fromEnv, source: 'environment' } : { key: null, source: null };
  }
  const key = memory.get(envVar);
  return key ? { key, source: storage.mode === 'session' ? 'session only' : 'keychain' } : { key: null, source: null };
}

// The key kept under one of the stored names ({ key, source }), read on every call so a key saved in the app works at once.
// The Claude adapter uses this for ANTHROPIC_API_KEY.
export async function storedKey(envVar) {
  if (!NAMES.includes(envVar)) throw new Error(`${envVar} is not a key Plenum stores.`);
  return lookup(envVar);
}

// Reports whether a key is set and where it is kept: keychain, session only, environment, or null for none.
// The key itself is never returned.
export async function keyStatus(providerId) {
  const { key, source } = lookup(provider(providerId).envVar);
  return { configured: key !== null, source };
}

// Returns the key for an adapter to send, or null when none is set. Callers must not log it.
export async function keyFor(providerId) {
  return lookup(provider(providerId).envVar).key;
}

// Refuses anything that cannot be a real key before a request is sent with it.
function checkShape(key) {
  if (!looksLikeKey(key)) {
    throw Object.assign(new Error(`That does not look like an API key. Keys are ${MIN_LEN} to ${MAX_LEN} characters with no spaces.`), { status: 400 });
  }
}

// Throws the reason when a key cannot be saved here, so a caller can stop before it sends the key anywhere.
export function assertCanSave() {
  if (!keyStorage().canSave) throw new Error(storage.note);
}

// What a request that is never answered, or cannot be sent, says. A save and a removal each have their own words.
const SAVE_FAILED = { late: 'The desktop app did not answer in time, so the key was not saved.', unsent: 'The key could not be handed to the desktop app.' };
const REMOVE_FAILED = { late: 'The desktop app did not answer in time, so the key was not removed.', unsent: 'The removal could not be handed to the desktop app.' };

// Sends the desktop app one request and waits for its answer. Resolves { ok: false, message } if it never comes, with the words in `failed`.
function ask(message, failed = SAVE_FAILED) {
  const id = ++nextId;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, message: failed.late });
    }, SAVE_TIMEOUT_MS);
    waiting.set(id, { resolve, timer });
    try {
      port.post({ ...message, id });
    } catch {
      waiting.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, message: failed.unsent });
    }
  });
}

// Hands one key to the desktop app to encrypt and write, then keeps it in memory. Returns a sentence about where it went.
// Throws an Error with a plain message when saving is refused or fails; the message never holds the key.
export async function storeKey(envVar, key) {
  if (!NAMES.includes(envVar)) throw new Error(`${envVar} cannot be saved from here.`);
  assertCanSave();
  const reply = await ask({ type: 'save-key', name: envVar, key });
  if (!reply.ok) throw new Error(scrub(clean(reply.message) || 'The key could not be saved.', key).slice(0, 300));
  // The desktop app can change its mind about where keys go (for example the secret service went away), and says so here.
  if (MODES.includes(reply.storage)) storage = { mode: reply.storage, note: clean(reply.note) || NOTES[reply.storage] };
  memory.set(envVar, key);
  return SAVED[storage.mode] ?? '';
}

// Removes a saved key from the desktop app's store and from memory. Resolves { ok, message } and never throws. The key leaves memory
// only once the desktop app confirms it is gone, so a request that is never answered leaves the key as the app still has it.
// A plain Node run has no store to remove from: its key comes from an environment variable, so that variable is cleared by hand.
// The Anthropic key is not a listed provider, so it is named here and nowhere else (the Claude card removes it through server.mjs).
export async function forgetKey(providerId) {
  const p = providerId === ANTHROPIC.id ? ANTHROPIC : provider(providerId);
  if (storage.mode === 'environment') {
    return { ok: false, message: `The ${p.label} key comes from the ${p.envVar} environment variable, because Plenum was started without the desktop app. Clear that variable and restart Plenum to remove it.` };
  }
  const reply = await ask({ type: 'delete-key', name: p.envVar }, REMOVE_FAILED);
  if (!reply.ok) return { ok: false, message: clean(reply.message).slice(0, 300) || 'The key could not be removed.' };
  // The desktop app can change its mind about where keys go, the same as after a save.
  if (MODES.includes(reply.storage)) storage = { mode: reply.storage, note: clean(reply.note) || NOTES[reply.storage] };
  memory.delete(p.envVar);
  return { ok: true, message: `The ${p.label} key was removed. Plenum no longer uses it.` };
}

// Turns an HTTP status from the check into a plain sentence. The provider's own error text is not repeated,
// so nothing from the request can end up in the message.
function statusMessage(p, status) {
  if (status >= 200 && status < 300) return { ok: true, message: `The ${p.label} key works.` };
  if (status === 401) return { ok: false, message: `${p.label} rejected this key (401). Check that you copied the whole key.` };
  if (status === 403) return { ok: false, message: `${p.label} refused this key (403). Check the key's permissions in the provider's console.` };
  // A 429 can mean a rate limit or no credit left, and the key itself may still be fine.
  if (status === 429) return { ok: false, message: `${p.label} is limiting requests or this account has no credit left (429). The key may still be fine; check billing, then try again.` };
  if (status >= 500) return { ok: false, message: `${p.label} had a server error (${status}). Try again in a few minutes.` };
  return { ok: false, message: `${p.label} did not accept the check (HTTP ${status}).` };
}

// Sends one cheap request, GET {baseUrl}/models (or the provider's own checkPath), to check a key. Returns { ok, message }.
export async function testKey(providerId, key) {
  const p = provider(providerId);
  const value = clean(key);
  if (!value) return { ok: false, message: `No key was given for ${p.label}.` };
  let res;
  try {
    res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}${p.checkPath ?? '/models'}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${value}`, accept: 'application/json' },
      // A redirect is refused rather than followed, so the key is never sent on to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, message: `${p.label} did not answer within ${TEST_TIMEOUT_MS / 1000} seconds. Check the connection and try again.` };
    }
    if (/redirect/i.test(String(err?.cause?.message ?? ''))) {
      return { ok: false, message: `${p.label} tried to redirect the check, so it was stopped. The key was not sent on.` };
    }
    return { ok: false, message: `${p.label} could not be reached. Check the internet connection and try again.` };
  }
  // Only the status is needed, so the body is dropped without being read.
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to clean up if the body is already closed.
  }
  return statusMessage(p, res.status);
}

// Checks a key with the provider and saves it through the desktop app. Throws an Error with a plain message when the key is
// not plausible, keys cannot be saved here, the provider refuses it, or the save fails.
export async function saveKey(providerId, key) {
  const p = provider(providerId);
  const value = typeof key === 'string' ? key.trim() : '';
  checkShape(value);
  // A save that would be refused stops here, before the key is sent to the provider.
  assertCanSave();
  const check = await testKey(p.id, value);
  if (!check.ok) throw new Error(check.message);
  // Only a key the provider has accepted is written, so a typo never replaces a working key.
  const where = await storeKey(p.envVar, value);
  return { ok: true, message: `${check.message} ${where}`.trim(), storage: storage.mode };
}

// Keys already in the Windows user environment, which older versions saved there. They are offered for import, never copied
// unless the person asks. Each entry is { id, label, envVar }; the keys themselves are not returned. Only Windows has such
// a place, and only a key not already saved is offered. platform is for tests.
export async function importable({ platform = process.platform } = {}) {
  if (platform !== 'win32' || !keyStorage().canSave) return [];
  const offered = await Promise.all(ITEMS.map(async item => {
    if (memory.has(item.envVar)) return null;
    let value = '';
    try {
      value = clean(await readUserEnv(item.envVar));
    } catch {
      // A value that cannot be read is not offered.
    }
    return looksLikeKey(value) ? item : null;
  }));
  return offered.filter(Boolean);
}

// Copies the chosen keys (by id; all the offered ones when ids is null) into the desktop app's store. The copies in the
// Windows user environment are left alone. Returns one { id, label, imported, message } per key asked for.
// Nothing is offered without the desktop app or off Windows, so the message says why instead of claiming the environment
// was checked. With no ids named, every provider is reported that way, so the caller has a reason to show.
export async function importKeys(ids = null, { platform = process.platform } = {}) {
  const offer = await importable({ platform });
  const reason = !keyStorage().canSave ? `Importing keys needs the Plenum desktop app. ${keyStorage().message}`
    : platform !== 'win32' ? 'Keys are only copied in on Windows.'
      : null;
  const wanted = ids === null ? (reason ? ITEMS.map(o => o.id) : offer.map(o => o.id)) : [...new Set(ids)];
  const results = [];
  for (const id of wanted) {
    const item = offer.find(o => o.id === id);
    if (!item) {
      const known = ITEMS.find(o => o.id === id);
      results.push({ id, label: known?.label ?? String(id).slice(0, 40), imported: false, message: reason ?? 'There is no key for this provider in the Windows user environment to import.' });
      continue;
    }
    try {
      const where = await storeKey(item.envVar, clean(await readUserEnv(item.envVar)));
      results.push({ id, label: item.label, imported: true, message: `The ${item.label} key was copied. ${where}`.trim() });
    } catch (err) {
      results.push({ id, label: item.label, imported: false, message: String(err?.message ?? 'The key could not be copied.') });
    }
  }
  return results;
}
