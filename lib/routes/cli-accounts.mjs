// Accounts routes for the coding agents added after the first four (Cursor and Grok Build).
//   GET  /api/accounts/cli           -> { cursor: { installed, signedIn, email }, grok: { installed, signedIn, email } }
//                                       (cursor: lib/cursor.mjs cursorStatus, cached 20 seconds; grok: lib/grok.mjs grokStatus, local files only)
//   POST /api/accounts/cursor/login  -> { ok: true }   opens a terminal running `agent login` (lib/cursor.mjs cursorSignIn)
//   POST /api/accounts/grok/login    -> { ok: true }   opens a terminal running `grok login` (lib/grok.mjs grokSignIn)
//   POST /api/accounts/antigravity/login -> { ok: true } opens a terminal running `agy acp --login` (lib/antigravity.mjs)
// The GET also reports antigravity: { installed, signedIn, email, tier }, after reading the account's models when that read is stale
// (a handshake that sends no prompt, at most 4 s here; lib/antigravity.mjs refreshAntigravityModels).
// The GET runs the Cursor CLI's status command, which reaches Cursor's service, so it waits for the terms like /api/accounts does
// (gated: true, see lib/legal.mjs). The POST always waits for the terms (every POST does, lib/routes/index.mjs).
import { cursorSignIn, cursorStatus } from '../cursor.mjs';
import { grokSignIn, grokStatus } from '../grok.mjs';
import { agyCommand, antigravityModelsWithin, antigravitySignIn, antigravityStatus } from '../antigravity.mjs';

export const routes = [
  { method: 'GET', path: '/api/accounts/cli', handler: cliStatus, gated: true },
  { method: 'POST', path: '/api/accounts/cursor/login', handler: cursorLogin },
  { method: 'POST', path: '/api/accounts/grok/login', handler: grokLogin },
  { method: 'POST', path: '/api/accounts/antigravity/login', handler: antigravityLogin },
];

async function cliStatus({ res, json }) {
  const [cursor, grok, antigravity] = await Promise.all([cursorStatus(), grokStatus(), readAntigravity()]);
  return json(res, 200, { cursor, grok, antigravity });
}

async function readAntigravity() {
  if (await agyCommand()) await antigravityModelsWithin(4000);
  return antigravityStatus();
}

async function antigravityLogin({ res, json }) {
  await antigravitySignIn();
  return json(res, 200, { ok: true });
}

async function cursorLogin({ res, json }) {
  await cursorSignIn();
  return json(res, 200, { ok: true });
}

async function grokLogin({ res, json }) {
  await grokSignIn();
  return json(res, 200, { ok: true });
}
