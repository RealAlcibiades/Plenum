// API key routes for the per-token model providers. A key arrives only in a POST body and is never sent back:
// responses carry the status, where the key is kept and a plain message.
import { API_PROVIDERS, apiProvider } from '../api-providers.mjs';
import { importKeys, importable, keyFor, keyStatus, keyStorage, saveKey, testKey } from '../keys.mjs';

export const routes = [
  { method: 'GET', path: '/api/keys', handler: listKeys },
  { method: 'POST', path: '/api/keys', handler: saveKeyRoute },
  { method: 'POST', path: '/api/keys/test', handler: testKeyRoute },
  { method: 'POST', path: '/api/keys/import', handler: importKeysRoute },
];

// storage says how keys are kept (keychain, session only, unavailable or environment) and whether a save would be refused.
// importable lists keys found in the Windows user environment that the person can choose to copy in; it is never done unasked.
async function listKeys({ res, json }) {
  const [providers, offer] = await Promise.all([
    Promise.all(API_PROVIDERS.map(async p => {
      const { configured, source } = await keyStatus(p.id);
      return { id: p.id, label: p.label, configured, source, envVar: p.envVar, keyUrl: p.keyUrl, docsUrl: p.docsUrl };
    })),
    importable(),
  ]);
  return json(res, 200, { providers, storage: keyStorage(), importable: offer });
}

// Reads the provider from a request body. A body that is not an object (for example the JSON value null) counts as empty.
function pickProvider(body, httpError) {
  const p = apiProvider(body?.provider);
  if (!p) throw httpError(400, 'Pick a provider from the list.');
  return p;
}

async function saveKeyRoute({ req, res, readBody, httpError, json }) {
  const body = (await readBody(req)) ?? {};
  const p = pickProvider(body, httpError);
  const key = typeof body.key === 'string' ? body.key : '';
  try {
    const result = await saveKey(p.id, key);
    return json(res, 200, { ok: true, saved: true, message: result.message, storage: result.storage });
  } catch (err) {
    // Bad input is a 400. A key the provider refused, a refused save, or a save that failed, is an outcome the panel shows.
    if (err?.status === 400) throw err;
    return json(res, 200, { ok: false, saved: false, message: String(err?.message ?? 'The key could not be saved.') });
  }
}

async function testKeyRoute({ req, res, readBody, httpError, json }) {
  const body = (await readBody(req)) ?? {};
  const p = pickProvider(body, httpError);
  // The saved key is the one the adapters would use, so the check tests that same key.
  const key = await keyFor(p.id);
  if (!key) return json(res, 200, { ok: false, message: `No key is saved for ${p.label} yet.` });
  return json(res, 200, await testKey(p.id, key));
}

// Copies keys from the Windows user environment into the key store, for the providers the person picked (all offered ones when
// none are named). It is the only way those keys are read for saving; nothing is imported at start.
async function importKeysRoute({ req, res, readBody, httpError, json }) {
  const body = (await readBody(req)) ?? {};
  if (body.providers !== undefined && !Array.isArray(body.providers)) throw httpError(400, 'Send the providers to import as a list.');
  const ids = body.providers === undefined ? null : body.providers.filter(id => typeof id === 'string');
  const results = await importKeys(ids);
  const imported = results.filter(r => r.imported).length;
  const message = imported > 0
    ? `${imported === 1 ? 'One key was' : `${imported} keys were`} copied. The copies in the Windows user environment were left in place; remove them in Windows settings (environment variables for your account) when you no longer want them there.`
    : results[0]?.message ?? 'There was nothing to import.';
  return json(res, 200, { ok: imported > 0, imported, message, results });
}
