// A fake IndexedDB factory for the shell-core suites (mob-10). It implements the calls store.js makes: open(name, version) with
// onupgradeneeded / onsuccess / onerror / onblocked, db.objectStoreNames, db.createObjectStore, db.transaction(store, mode) with
// oncomplete / onerror / onabort, objectStore.get / put / delete / getAllKeys. Requests complete on a later microtask, as real
// IndexedDB does, and a transaction completes after its requests. Nothing is written to disk.

export function createFakeIndexedDB({ failWrites = false } = {}) {
  const databases = new Map(); // name -> { version, stores: Map(name -> Map(key -> value)) }
  const factory = {
    databases,
    failWrites,
    open(name, version = 1) {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        let entry = databases.get(name);
        const upgrading = !entry || entry.version < version;
        if (!entry) {
          entry = { version, stores: new Map() };
          databases.set(name, entry);
        }
        entry.version = Math.max(entry.version, version);
        const db = makeDatabase(entry);
        req.result = db;
        if (upgrading) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };

  function makeDatabase(entry) {
    return {
      get objectStoreNames() {
        return { contains: name => entry.stores.has(name) };
      },
      createObjectStore(name) {
        if (!entry.stores.has(name)) entry.stores.set(name, new Map());
        return {};
      },
      transaction(name, mode) {
        if (!entry.stores.has(name)) throw new Error(`no object store ${name}`);
        const data = entry.stores.get(name);
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null, pending: 0, failed: false };
        const finish = () => {
          queueMicrotask(() => {
            if (!tx.failed) tx.oncomplete?.({ target: tx });
          });
        };
        tx.objectStore = () => ({
          get(key) { return request(() => data.get(key)); },
          put(value, key) {
            return request(() => {
              if (factory.failWrites) throw new Error('quota exceeded (fake)');
              data.set(key, structuredClone(value));
              return key;
            });
          },
          delete(key) { return request(() => { data.delete(key); return undefined; }); },
          getAllKeys() { return request(() => [...data.keys()]); },
        });
        const request = work => {
          const req = { result: undefined, error: null, onsuccess: null, onerror: null };
          tx.pending += 1;
          queueMicrotask(() => {
            try {
              req.result = work();
              req.onsuccess?.({ target: req });
            } catch (err) {
              req.error = err;
              tx.failed = true;
              tx.error = err;
              req.onerror?.({ target: req });
              tx.onerror?.({ target: tx });
            }
            tx.pending -= 1;
            if (tx.pending === 0) finish();
          });
          return req;
        };
        if (mode === 'readonly' && !tx.error) {
          // a read-only transaction with no request still completes
          queueMicrotask(() => { if (tx.pending === 0) finish(); });
        }
        return tx;
      },
    };
  }
  return factory;
}
