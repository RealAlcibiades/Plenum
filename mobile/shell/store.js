// The phone's store (mob-10, wave 104). Two back ends behind one key-value shape:
//   web:    IndexedDB (database 'plenum-shell', object store 'kv'). Values are structured-cloned.
//   native: @aparajita/capacitor-secure-storage (Keychain or Android Keystore-wrapped), reached through
//           Capacitor.Plugins.SecureStorage, which the native build registers. Values are stored as JSON strings.
// Keys: 'computers' (array of records), 'ctr:<computerId>' (the handshake counter, raised only), 'meta:<name>' (lock settings).
//
// A computer record: { id, name, desktopPub (b64url 32 bytes), myPriv (b64url 32 bytes, or a PIN wrap { v, iv, ct } on the PWA when a
// PIN is set), carriers, lastCarrier, lastSeen, pairedAt, counter, pushKey, stopKey (b64url 32 bytes, the Stop key: never PIN-wrapped),
// myDeviceId (64 hex, this phone's own id on that computer) }. The record keeps the keys this phone holds for that
// computer, and only the keys: publicComputer() is the view any screen or log may use.
//
// The counter lives under its own key so a failed pairing leaves nothing half made, and it only ever rises (raiseCounter), so a
// replay of a stored counter can never happen from this side.

export const STORE_DB = 'plenum-shell';
export const STORE_OBJECT = 'kv';
export const SECURE_PREFIX = 'plenum.';

// ----- back ends -----

// IndexedDB behind the same get/put/delete/keys shape. `indexedDB` is the factory (window.indexedDB, or a fake in the Node suites).
export function createIdbKv({ indexedDB: factory, name = STORE_DB } = {}) {
  if (!factory || typeof factory.open !== 'function') throw new TypeError('createIdbKv needs an IndexedDB factory');
  let opening = null;
  const database = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = factory.open(name, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_OBJECT)) db.createObjectStore(STORE_OBJECT);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
  const run = async (mode, fn) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      // A write waits for the disk (strict), so a Stop key or a PIN record is not lost to a browser that reports the write too early.
      const tx = db.transaction(STORE_OBJECT, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      const os = tx.objectStore(STORE_OBJECT);
      let result;
      const req = fn(os);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  };
  return {
    kind: 'web',
    get: async key => {
      const value = await run('readonly', os => os.get(key));
      return value === undefined ? undefined : value;
    },
    put: (key, value) => run('readwrite', os => os.put(value, key)).then(() => undefined),
    delete: key => run('readwrite', os => os.delete(key)).then(() => undefined),
    keys: async () => {
      const list = await run('readonly', os => os.getAllKeys());
      return Array.from(list ?? []).map(String);
    },
  };
}

// The native secure storage behind the same shape. `plugin` is Capacitor.Plugins.SecureStorage (setItem, getItem, removeItem, keys).
export function createSecureKv({ plugin, prefix = SECURE_PREFIX } = {}) {
  if (!plugin || typeof plugin.setItem !== 'function') throw new TypeError('createSecureKv needs the SecureStorage plugin');
  return {
    kind: 'native',
    get: async key => {
      const answer = await plugin.getItem({ key: prefix + key });
      const text = answer?.value;
      return text === null || text === undefined ? undefined : JSON.parse(String(text));
    },
    put: async (key, value) => {
      await plugin.setItem({ key: prefix + key, value: JSON.stringify(value) });
    },
    delete: async key => {
      await plugin.removeItem({ key: prefix + key });
    },
    keys: async () => {
      const answer = await plugin.keys();
      return (answer?.keys ?? []).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    },
  };
}

// ----- the store -----

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The view a screen, a log or the debug console may show: no key material, no wrapped key, no push key.
export function publicComputer(record) {
  if (!isObject(record)) return null;
  return {
    id: record.id,
    name: record.name ?? '',
    carriers: Array.isArray(record.carriers) ? record.carriers.map(c => ({ kind: c.kind })) : [],
    lastCarrier: record.lastCarrier ?? null,
    lastSeen: record.lastSeen ?? null,
    pairedAt: record.pairedAt ?? null,
    counter: Number.isSafeInteger(record.counter) ? record.counter : 0,
    // Whether this phone holds the computer's Stop key and its own id there (C5): Stop can then be sent without unlocking.
    stopReady: typeof record.stopKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.stopKey) && /^[0-9a-f]{64}$/.test(String(record.myDeviceId ?? '')),
  };
}

// ----- the Stop cards -----

// A second copy of what Stop without unlocking needs, one card per computer: { id, name, myDeviceId, stopKey, carriers, lastCarrier,
// counter }. It lives in Web Storage (localStorage), apart from the store, so a store that cannot be read (a damaged entry, a Keystore or
// IndexedDB failure) still leaves the lock screen a Stop (MOBILE.json floor: Stop from the phone always works). The Stop key is the one key
// kept outside secure storage: all it can do is stop runs and deny the cards they wait on (lib/remote/stop-only.mjs), and a script that runs
// in the shell could press Stop through the app anyway. myPriv, the psk and the push key never go here. `storage` is a Web Storage object.
export const STOP_CARDS_KEY = 'plenum.stop-cards';
const STOP_KEY = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID = /^[0-9a-f]{64}$/;

function cardOf(record, counter = 0) {
  if (!isObject(record) || typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.stopKey !== 'string' || !STOP_KEY.test(record.stopKey) || !DEVICE_ID.test(String(record.myDeviceId ?? ''))) return null;
  const carriers = Array.isArray(record.carriers)
    ? record.carriers.filter(isObject).map(c => ({ kind: String(c.kind ?? ''), urls: Array.isArray(c.urls) ? c.urls.filter(u => typeof u === 'string') : [] }))
    : [];
  return {
    id: record.id,
    name: String(record.name ?? ''),
    myDeviceId: record.myDeviceId,
    stopKey: record.stopKey,
    carriers,
    lastCarrier: typeof record.lastCarrier === 'string' ? record.lastCarrier : null,
    counter: Math.max(Number.isSafeInteger(record.counter) ? record.counter : 0, counter),
  };
}

export function createStopCards({ storage } = {}) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  const read = () => {
    try {
      const list = JSON.parse(storage.getItem(STOP_CARDS_KEY) ?? '[]');
      return Array.isArray(list) ? list.map(c => cardOf(c)).filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  const write = list => storage.setItem(STOP_CARDS_KEY, JSON.stringify(list));
  return {
    read,
    get: id => read().find(c => c.id === id) ?? null,
    counterOf: id => read().find(c => c.id === id)?.counter ?? 0,
    // Writes a card for each record that holds a Stop key, and drops the cards of computers that are gone. A card's counter never falls.
    sync(records) {
      const before = new Map(read().map(c => [c.id, c.counter]));
      const next = (Array.isArray(records) ? records : []).map(r => cardOf(r, before.get(r?.id) ?? 0)).filter(Boolean);
      if (next.length) write(next);
      else storage.removeItem(STOP_CARDS_KEY);
    },
    // The counter rule of the store (raiseCounter), on the card alone: used when the store cannot be read.
    raise(id, minimum) {
      const list = read();
      const card = list.find(c => c.id === id);
      if (!card) throw new Error('no Stop card for this computer');
      const next = Math.max(card.counter, Number(minimum) - 1) + 1;
      if (!Number.isSafeInteger(next)) throw new RangeError('counter out of range');
      card.counter = next;
      write(list);
      return next;
    },
    // Keeps a card's counter at least `value` (each counter the store raises is noted here too).
    note(id, value) {
      const list = read();
      const card = list.find(c => c.id === id);
      if (!card || card.counter >= value) return;
      card.counter = value;
      write(list);
    },
  };
}

export function createStore({ kv, stopCards = null } = {}) {
  if (!kv || typeof kv.get !== 'function') throw new TypeError('createStore needs a key-value back end');
  // The Stop cards follow every write of the computers. A card that cannot be written never fails the store's own write.
  const syncCards = list => {
    try { stopCards?.sync(list); } catch { /* the store's write stands; the next write tries again */ }
  };
  // Every read-modify-write runs one after another, so two writers cannot lose each other's change.
  let chain = Promise.resolve();
  const serial = fn => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const readComputers = async () => {
    const list = await kv.get('computers');
    return Array.isArray(list) ? list.filter(isObject) : [];
  };
  const readCounter = async id => {
    const value = await kv.get(`ctr:${id}`);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };

  const store = {
    kind: kv.kind,

    // Every record, keys included. Only the unlock path and the connect path may use these.
    list: () => serial(readComputers),
    get: id => serial(async () => (await readComputers()).find(c => c.id === id) ?? null),
    publicList: () => serial(async () => (await readComputers()).map(publicComputer)),

    put: record => serial(async () => {
      if (!isObject(record) || typeof record.id !== 'string' || !record.id) throw new TypeError('a computer record needs an id');
      const all = await readComputers();
      const next = all.some(c => c.id === record.id)
        ? all.map(c => (c.id === record.id ? record : c))
        : [...all, record];
      await kv.put('computers', next);
      syncCards(next);
      return record;
    }),

    // Merges fields into a record. Keys in `fields` replace the record's value; a null value removes the field.
    patchComputer: (id, fields) => serial(async () => {
      const all = await readComputers();
      const found = all.find(c => c.id === id);
      if (!found) return null;
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (v === null) delete found[k];
        else found[k] = v;
      }
      await kv.put('computers', all);
      syncCards(all);
      return publicComputer(found);
    }),

    remove: id => serial(async () => {
      const all = await readComputers();
      const left = all.filter(c => c.id !== id);
      await kv.put('computers', left);
      syncCards(left);
      return true;
    }),

    counter: id => serial(() => readCounter(id)),

    // Stores a counter of at least `minimum`, never lower than what is stored, and returns the value stored. The handshake only
    // goes out with a value this returns (channel.js answerCounter).
    // The Stop card's counter counts too: a Stop sent from the card while the store could not be read raised it there, and the next
    // handshake must go above it. When the store cannot be read at all, the card alone keeps the rule (a Stop without unlocking).
    raiseCounter: (id, minimum) => serial(async () => {
      let current;
      try {
        current = await readCounter(id);
      } catch (err) {
        if (!stopCards?.get(id)) throw err;
        return stopCards.raise(id, minimum);
      }
      current = Math.max(current, stopCards?.counterOf(id) ?? 0);
      const next = Math.max(current, Number(minimum) - 1) + 1;
      if (!Number.isSafeInteger(next)) throw new RangeError('counter out of range');
      await kv.put(`ctr:${id}`, next);
      try { stopCards?.note(id, next); } catch { /* the store holds the counter; the card catches up at the next write */ }
      // The record's copy of the counter is for show; `ctr:<id>` is the one the rule reads, so a damaged record does not fail the raise.
      try {
        const all = await readComputers();
        const found = all.find(c => c.id === id);
        if (found) {
          found.counter = next;
          await kv.put('computers', all);
        }
      } catch {
        // The counter is stored under its own key.
      }
      return next;
    }),

    // The Stop cards (null without Web Storage), for the lock screen when the store cannot be read, and a sync from the store's records
    // (at launch, so a phone paired before the cards existed gets them).
    stopCards,
    syncStopCards: () => serial(async () => syncCards(await readComputers())),

    meta: {
      get: name => serial(() => kv.get(`meta:${name}`)),
      put: (name, value) => serial(() => kv.put(`meta:${name}`, value)),
      remove: name => serial(() => kv.delete(`meta:${name}`)),
    },

    // Used by the Node suites and the debug console: what the store holds under which keys (names only).
    keys: () => serial(() => kv.keys()),
  };
  return store;
}

// The store a page gets: native when the Capacitor SecureStorage plugin is there, IndexedDB otherwise.
// localStorage, when given, holds the Stop cards (createStopCards).
export function createPlatformStore({ secureStorage = null, indexedDB = null, localStorage = null } = {}) {
  let stopCards = null;
  try { stopCards = createStopCards({ storage: localStorage }); } catch { stopCards = null; }
  if (secureStorage) return createStore({ kv: createSecureKv({ plugin: secureStorage }), stopCards });
  if (indexedDB) return createStore({ kv: createIdbKv({ indexedDB }), stopCards });
  throw new Error('no storage: neither secure storage nor IndexedDB is available');
}
