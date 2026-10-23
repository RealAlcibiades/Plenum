// The tool check for API providers (grok-05, lib/tool-verify.mjs).
//   GET  /api/keys/verify-tools   -> { checks: { <provider>: { ok, model, at, reason } } }   the stored results, no key in them
//   POST /api/keys/verify-tools   body { provider }   runs the check once for that provider and answers
//        { provider, ok, model, at, reason, toolsVerified }. 400 for a provider that is not an API provider, one whose tools are
//        already on (nothing to check), one with no saved key, or one with no model listed; 409 while a check of it is running.
//   POST /api/keys/verify-tools   body { provider, forget: true }   removes the stored check, so the provider's tools go back off
//        (its flag still turns them on): { provider, cleared, toolsVerified }. 409 while a check of it is running.
// The body carries a provider id only. The key is read from the key store on the server and is never sent back.
import { apiProvider } from '../api-providers.mjs';
import { CATALOG } from '../providers.mjs';
import { keyFor } from '../keys.mjs';
import { forgetTools, toolCheckRunning, toolChecks, toolsOn, verifyTools } from '../tool-verify.mjs';

export const routes = [
  { method: 'GET', path: '/api/keys/verify-tools', handler: listChecks },
  { method: 'POST', path: '/api/keys/verify-tools', handler: runCheck },
];

async function listChecks({ res, json }) {
  return json(res, 200, { checks: toolChecks() });
}

async function runCheck({ req, res, readBody, httpError, json }) {
  const body = (await readBody(req)) ?? {};
  const p = apiProvider(typeof body.provider === 'string' ? body.provider : '');
  if (!p) throw httpError(400, 'Pick a provider from the list.');
  if (body.forget === true) return forgetCheck(p, res, httpError, json);
  if (p.toolsVerified === true) throw httpError(400, `${p.label} already has its tools on, so there is nothing to check.`);
  if (!(await keyFor(p.id))) throw httpError(400, `Save a key for ${p.label} in Accounts first.`);
  const model = CATALOG.find(c => c.provider === p.id)?.id ?? null;
  if (!model) throw httpError(400, `Plenum has no model listed for ${p.label}, so there is nothing to check.`);
  if (toolCheckRunning(p.id)) throw httpError(409, `A check for ${p.label} is already running.`);
  const rec = await verifyTools(p.id, { model });
  return json(res, 200, { provider: p.id, ...rec, toolsVerified: toolsOn(p.id) });
}

// The forget: the stored check is removed. A check of the same provider that is running is refused first, so its result cannot be
// written back after the forget. The per-model switches are not touched (lib/tool-trust.mjs).
async function forgetCheck(p, res, httpError, json) {
  if (toolCheckRunning(p.id)) throw httpError(409, `A check for ${p.label} is already running.`);
  const cleared = await forgetTools(p.id);
  return json(res, 200, { provider: p.id, cleared, toolsVerified: toolsOn(p.id) });
}
