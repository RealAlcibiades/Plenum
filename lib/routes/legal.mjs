// The legal routes: what the agreement screen and the Legal page read, the accept and decline buttons, and "Open Chromium licences".
// The rules are in lib/legal.mjs and the screens are public/ext-legal.js. The server answers every other POST with 403 until the
// terms are accepted (termsGate), and these four are the ones it lets through: accept, decline, open-file, and (in
// lib/routes/store-health.mjs) the store notice's acknowledgement.
//
//   GET  /api/legal            -> { terms: { version, effective, contact }, changes, accepted, hashes: { eula, privacy }, desktop, required }
//                                 changes: the lines of every version newer than the accepted one, { '2': [line, ...] } (all of them when
//                                 nothing is accepted yet); accepted: the stored record or null; desktop: true under the desktop app.
//   GET  /api/legal/doc?name=  -> { name, title, text } for eula | privacy | third-party | open-source; 400 'Unknown document.' otherwise.
//   POST /api/legal/accept     { version, eula, privacy } -> { ok: true, accepted }. The version and both hashes must be the ones GET
//                                 /api/legal gave; any other answers 409 'The terms changed while this screen was open. Read the new version.'
//   POST /api/legal/decline    -> { ok: true }, then the process ends with code 76 after 300 ms. The desktop app reads 76 as "quit"
//                                 (desktop/handlers/legal.cjs); under plain Node the server simply stops.
//   POST /api/legal/open-file  { name: 'chromium' | 'electron' | 'license' | 'notices' } -> { ok: true }. The desktop app opens a fixed
//                                 file beside the app; no path comes from the page. 409 under plain Node, 404 when the file is missing.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../overlay.mjs';
import { shellAvailable, shellRequest } from '../shell.mjs';
import { OPEN_FILES, TERMS, acceptTerms, changesAfter, docHashes, readDoc, termsAccepted } from '../legal.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// What happens after a decline. A test replaces exit; nothing else does.
export const hooks = { exit: code => process.exit(code), exitAfterMs: 300 };

let appVersion;
// The version in package.json, read once. Empty when it cannot be read.
async function packageVersion() {
  if (appVersion === undefined) {
    try {
      appVersion = String(JSON.parse(await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8')).version ?? '');
    } catch {
      appVersion = '';
    }
  }
  return appVersion;
}

export const routes = [
  { method: 'GET', path: '/api/legal', handler: stateRoute },
  { method: 'GET', path: '/api/legal/doc', handler: docRoute },
  { method: 'POST', path: '/api/legal/accept', handler: acceptRoute },
  { method: 'POST', path: '/api/legal/decline', handler: declineRoute },
  { method: 'POST', path: '/api/legal/open-file', handler: openFileRoute },
];

async function stateRoute({ res, json, httpError, store }) {
  if (TERMS.broken) throw httpError(500, 'The license agreement is missing from this installation, so Plenum cannot be used. Install Plenum again.');
  const st = store.get();
  return json(res, 200, {
    terms: { version: TERMS.version, effective: TERMS.effective, contact: TERMS.contact },
    changes: changesAfter(st),
    accepted: st.legal?.accepted ?? null,
    hashes: docHashes(),
    desktop: shellAvailable(),
    required: !termsAccepted(st),
  });
}

async function docRoute({ res, url, json }) {
  return json(res, 200, await readDoc(url.searchParams.get('name')));
}

async function acceptRoute({ req, res, json, readBody, httpError, store }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send the version and the two hashes the screen showed.');
  const st = store.get();
  // A second click, or a second window, after the terms were accepted at this version with these texts is not a new agreement.
  const current = st.legal?.accepted;
  if (termsAccepted(st) && current?.version === body.version && current.eula === body.eula && current.privacy === body.privacy) {
    return json(res, 200, { ok: true, accepted: current });
  }
  const before = st.legal;
  const accepted = acceptTerms(st, { version: body.version, eula: body.eula, privacy: body.privacy, appVersion: await packageVersion(), now: Date.now() });
  try {
    await store.saveOrFail();
  } catch (err) {
    // A record the file does not hold would let Plenum run now and ask again after the next start. Keep the screen up instead.
    if (before === undefined) delete st.legal;
    else st.legal = before;
    throw err;
  }
  return json(res, 200, { ok: true, accepted });
}

async function declineRoute({ req, res, json, readBody }) {
  await readBody(req);
  json(res, 200, { ok: true });
  // The answer goes out first; the process ends a moment later, with the code the desktop app reads as "quit".
  setTimeout(() => hooks.exit(76), hooks.exitAfterMs).unref?.();
}

async function openFileRoute({ req, res, json, readBody, httpError }) {
  const body = await readBody(req);
  if (!isObject(body) || typeof body.name !== 'string' || !OPEN_FILES.includes(body.name)) {
    throw httpError(400, 'Unknown file. Choose chromium, electron, license or notices.');
  }
  if (!shellAvailable()) throw httpError(409, 'Open it from node_modules/electron/dist/.');
  let reply;
  try {
    reply = await shellRequest('open-legal-file', { name: body.name }, { timeoutMs: 10_000 });
  } catch (err) {
    throw httpError(err?.status ?? 500, err?.message ?? 'The desktop app could not open the file.');
  }
  if (reply?.ok !== true) throw httpError(404, typeof reply?.message === 'string' && reply.message ? reply.message : 'That file was not found next to Plenum.');
  return json(res, 200, { ok: true });
}
