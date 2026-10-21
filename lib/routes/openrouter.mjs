// OpenRouter: the model list and the key check. See lib/routes/index.mjs.
// GET /api/openrouter/models answers { ok, models, message?, cached? } with the models as { id, name, contextLength }.
// POST /api/openrouter/check answers { ok, message }. Neither takes a key from the request: the saved key is used, and no
// answer carries it. Both ask for X-Muse-Console, so a page from another site cannot make Plenum call OpenRouter.
import { checkKey, listModels } from '../openrouter.mjs';

export const routes = [
  { method: 'GET', path: '/api/openrouter/models', handler: modelsRoute },
  { method: 'POST', path: '/api/openrouter/check', handler: checkRoute },
];

// The server already refuses a POST without the header before any route runs. A GET is not checked there, so it is checked
// here for both, the way the checkpoints restore route does.
function requireHeader(req, httpError) {
  if (req.headers['x-muse-console'] !== '1') throw httpError(403, 'Missing X-Muse-Console header.');
}

async function modelsRoute({ req, res, json, httpError }) {
  requireHeader(req, httpError);
  return json(res, 200, await listModels());
}

async function checkRoute({ req, res, json, httpError }) {
  requireHeader(req, httpError);
  return json(res, 200, await checkKey());
}
