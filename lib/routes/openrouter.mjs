// OpenRouter: the model list and the key check. See lib/routes/index.mjs.
// GET /api/openrouter/models answers { ok, models, message?, cached? } with the models as { id, name, contextLength }.
// POST /api/openrouter/check answers { ok, message }. Neither takes a key from the request: the saved key is used, and no
// answer carries it. Both ask for the Plenum token, so a page from another site cannot make Plenum call OpenRouter.
import { checkKey, listModels } from '../openrouter.mjs';
import { requireToken } from '../auth.mjs';

export const routes = [
  { method: 'GET', path: '/api/openrouter/models', handler: modelsRoute },
  { method: 'POST', path: '/api/openrouter/check', handler: checkRoute },
];

// The server already refuses any /api/ request without the token before a route runs. It is checked here as well, so these
// routes are safe on their own, the way the checkpoints restore route is.
function requireHeader(req, httpError) {
  requireToken(req, httpError);
}

async function modelsRoute({ req, res, json, httpError }) {
  requireHeader(req, httpError);
  return json(res, 200, await listModels());
}

async function checkRoute({ req, res, json, httpError }) {
  requireHeader(req, httpError);
  return json(res, 200, await checkKey());
}
