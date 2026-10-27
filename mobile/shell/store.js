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

export function createStore({ kv } = {}) {
  if (!kv || typeof kv.get !== 'function') throw new TypeError('createStore needs a key-value back end');
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
      return publicComputer(found);
    }),

    remove: id => serial(async () => {
      const all = await readComputers();
      await kv.put('computers', all.filter(c => c.id !== id));
      return true;
    }),

    counter: id => serial(() => readCounter(id)),

    // Stores a counter of at least `minimum`, never lower than what is stored, and returns the value stored. The handshake only
    // goes out with a value this returns (channel.js answerCounter).
    raiseCounter: (id, minimum) => serial(async () => {
      const current = await readCounter(id);
      const next = Math.max(current, Number(minimum) - 1) + 1;
      if (!Number.isSafeInteger(next)) throw new RangeError('counter out of range');
      await kv.put(`ctr:${id}`, next);
      const all = await readComputers();
      const found = all.find(c => c.id === id);
      if (found) {
        found.counter = next;
        await kv.put('computers', all);
      }
      return next;
    }),

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
export function createPlatformStore({ secureStorage = null, indexedDB = null } = {}) {
  if (secureStorage) return createStore({ kv: createSecureKv({ plugin: secureStorage }) });
  if (indexedDB) return createStore({ kv: createIdbKv({ indexedDB }) });
  throw new Error('no storage: neither secure storage nor IndexedDB is available');
}
