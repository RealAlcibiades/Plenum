// GET /api/models/info: what the model picker shows for each catalog model (price, context window, tools) and whether each
// provider can answer now. Read-only. It says whether a key is saved, and never returns a key. Nothing here calls a provider.
import { API_PROVIDERS } from '../api-providers.mjs';
import { keyStatus } from '../keys.mjs';
import { infoFor, readinessFrom } from '../model-info.mjs';
import { CATALOG, providerStatus } from '../providers.mjs';

export const routes = [
  { method: 'GET', path: '/api/models/info', handler: infoRoute },
];

async function infoRoute({ res, json }) {
  const [status, keys] = await Promise.all([
    providerStatus(),
    Promise.all(API_PROVIDERS.map(async p => ({ id: p.id, ...(await keyStatus(p.id)) }))),
  ]);
  const models = Object.fromEntries(CATALOG.map(c => {
    const ref = `${c.provider}:${c.id}`;
    return [ref, infoFor(ref)];
  }));
  return json(res, 200, { models, readiness: readinessFrom(status, keys) });
}
