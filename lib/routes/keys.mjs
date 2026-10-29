// API key routes for the per-token model providers. A key arrives only in a POST body and is never sent back:
// responses carry the status, where the key is kept and a plain message.
// POST /api/key-routes saves the route choices made in Accounts: whether Gemini uses the saved Google AI key, whether Codex uses
// the saved OpenAI key, and whether Claude runs through Claude Code or the Anthropic API key. Only these choices are saved, never a
// key. They are read by keyRoutesFrom in lib/proc.mjs, and each run takes the route it names.
import { API_PROVIDERS, apiProvider } from '../api-providers.mjs';
import { forgetKey, importKeys, importable, keyFor, keyStatus, keyStorage, saveKey, testKey } from '../keys.mjs';
import { findExecutable, keyRoutesFrom } from '../proc.mjs';
import { claudeRoute } from '../claude-cli.mjs';
import { geminiStatus } from '../gemini.mjs';
import { toolChecks, toolsOn } from '../tool-verify.mjs';

export const routes = [
  { method: 'GET', path: '/api/keys', handler: listKeys },
  { method: 'POST', path: '/api/keys', handler: saveKeyRoute },
  { method: 'POST', path: '/api/keys/test', handler: testKeyRoute },
  { method: 'POST', path: '/api/keys/import', handler: importKeysRoute },
  { method: 'POST', path: '/api/keys/remove', handler: removeKeyRoute },
  { method: 'POST', path: '/api/key-routes', handler: saveRoutes },
];

// storage says how keys are kept (keychain, session only, unavailable or environment) and whether a save would be refused.
// importable lists keys found in the Windows user environment that the person can choose to copy in; it is never done unasked.
// routes is routeStatus(): the Accounts choices and the route each coding agent takes now.
async function listKeys({ res, json, store }) {
  const [providers, offer, routes] = await Promise.all([
    Promise.all(API_PROVIDERS.map(async p => {
      const { configured, source } = await keyStatus(p.id);
      // toolsVerified is true when the project tools reach this provider: its flag, or a passed tool-call check (lib/tool-verify.mjs).
      // toolCheck is the last stored check (ok, model, at, reason), or null. No key is in either.
      return { id: p.id, label: p.label, configured, source, envVar: p.envVar, keyUrl: p.keyUrl, docsUrl: p.docsUrl, toolsVerified: toolsOn(p.id), toolCheck: toolChecks()[p.id] ?? null };
    })),
    importable(),
    routeStatus(store.get()),
  ]);
  return json(res, 200, { providers, storage: keyStorage(), importable: offer, routes });
}

// The route choices as the panel shows them. No key is in it: saved is a yes or no, and the route names what a run does now.
// gemini.route is what a Gemini run does now: 'key' only when the switch in st is on, a key is saved, and the Gemini CLI would use the key.
// geminiStatus says whether the CLI's own sign-in blocks the key (keyBlocked), so a CLI set to its own sign-in shows as sign-in.
// claude.choice is 'cli', 'api' or null (automatic); claude.route is what a run does now (claudeRoute, which also honours
// MUSE_CONSOLE_CLAUDE); cli.installed says whether the Claude Code CLI was found.
async function routeStatus(st) {
  const chosen = keyRoutesFrom(st);
  const [openaiKey, route, cli, gemini] = await Promise.all([keyFor('openai'), claudeRoute(), findExecutable('claude'), geminiStatus()]);
  return {
    gemini: {
      on: chosen.gemini,
      saved: gemini.keySaved,
      route: chosen.gemini && gemini.keySaved && !gemini.keyBlocked ? 'key' : 'sign-in',
      keyBlocked: chosen.gemini && gemini.keyBlocked,
    },
    codex: { on: chosen.codex, saved: openaiKey !== null, route: chosen.codex && openaiKey !== null ? 'key' : 'sign-in' },
    claude: { choice: chosen.claude, route, cli: { installed: !!cli } },
  };
}

// Body: any of gemini and codex as true or false, and claude as 'cli', 'api' or 'auto' (automatic). Other keys are ignored. A value
// of the wrong kind refuses the whole request, so nothing is saved from a request that is partly wrong. The answer is the new
// route status, and it is sent only after the save has reached the state file (saveOrFail), so "saved" is never shown early.
const ROUTES_REFUSAL = 'Send gemini and codex as true or false, and claude as "cli", "api" or "auto".';
async function saveRoutes({ req, res, readBody, httpError, json, store }) {
  const body = (await readBody(req)) ?? {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, ROUTES_REFUSAL);
  for (const key of ['gemini', 'codex']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') throw httpError(400, ROUTES_REFUSAL);
  }
  if (body.claude !== undefined && !['cli', 'api', 'auto'].includes(body.claude)) throw httpError(400, ROUTES_REFUSAL);
  const st = store.get();
  const current = keyRoutesFrom(st);
  const next = {
    gemini: body.gemini !== undefined ? body.gemini : current.gemini,
    codex: body.codex !== undefined ? body.codex : current.codex,
    claude: body.claude !== undefined ? (body.claude === 'auto' ? null : body.claude) : current.claude,
  };
  st.keyRoutes = next;
  await store.saveOrFail();
  return json(res, 200, { ok: true, routes: await routeStatus(store.get()) });
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

// Body: { provider }. Removes that provider's saved key from the desktop app's store and from memory. The answer says whether it was
// removed, whether a key is still set (it is kept when the desktop app does not confirm, and in a plain Node run it comes from an
// environment variable that has to be cleared by hand), and a plain message. No key is in it.
async function removeKeyRoute({ req, res, readBody, httpError, json }) {
  const body = (await readBody(req)) ?? {};
  const p = pickProvider(body, httpError);
  const result = await forgetKey(p.id);
  const { configured } = await keyStatus(p.id);
  return json(res, 200, { ok: result.ok, configured, message: result.message });
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
