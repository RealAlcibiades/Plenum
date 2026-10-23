// Accounts routes for the coding agents added after the first four (Cursor now; Grok Build later in this release).
//   GET  /api/accounts/cli           -> { cursor: { installed, signedIn, email } }   (lib/cursor.mjs cursorStatus, cached 20 seconds)
//   POST /api/accounts/cursor/login  -> { ok: true }   opens a terminal running `agent login` (lib/cursor.mjs cursorSignIn)
// The GET runs the Cursor CLI's status command, which reaches Cursor's service, so it waits for the terms like /api/accounts does
// (gated: true, see lib/legal.mjs). The POST always waits for the terms (every POST does, lib/routes/index.mjs).
import { cursorSignIn, cursorStatus } from '../cursor.mjs';

export const routes = [
  { method: 'GET', path: '/api/accounts/cli', handler: cliStatus, gated: true },
  { method: 'POST', path: '/api/accounts/cursor/login', handler: cursorLogin },
];

async function cliStatus({ res, json }) {
  return json(res, 200, { cursor: await cursorStatus() });
}

async function cursorLogin({ res, json }) {
  await cursorSignIn();
  return json(res, 200, { ok: true });
}
