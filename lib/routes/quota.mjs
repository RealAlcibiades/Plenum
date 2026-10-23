// Plan use (lib/quota.mjs). Owned by the plan-meter feature. Reading changes nothing and sends no model request; a refresh can,
// and the limits in lib/quota.mjs say how often.
//   GET  /api/quota                          -> { providers: { codex, muse, anthropic, gemini }, at }
//   POST /api/quota/refresh { provider, reason }  reason: 'user' | 'limit-error' -> one entry
//     (400 'Unknown provider.' or 'Unknown reason.' for anything else)
// The server checks the Plenum token on every /api/ request before a route runs; requireToken checks it here as well.
import { requireToken } from '../auth.mjs';
import { QUOTA_PROVIDERS, REFRESH_REASONS, readQuota, refreshQuota } from '../quota.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  {
    method: 'GET',
    path: '/api/quota',
    // Codex's reading comes from its app server, which reaches OpenAI, so the read waits for the License Agreement (lib/legal.mjs).
    gated: true,
    handler: async ({ req, res, json, httpError }) => {
      requireToken(req, httpError);
      return json(res, 200, await readQuota());
    },
  },
  {
    method: 'POST',
    path: '/api/quota/refresh',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      // readBody gives back whatever the JSON was, so a bare null, a string or a list is refused before any field is read.
      const body = await readBody(req);
      if (!isObject(body) || !QUOTA_PROVIDERS.includes(body.provider)) throw httpError(400, 'Unknown provider.');
      if (!REFRESH_REASONS.includes(body.reason)) throw httpError(400, 'Unknown reason.');
      const entry = await refreshQuota(body.provider, body.reason);
      return json(res, 200, entry);
    },
  },
];
