// The legal gate: the terms a person agrees to before Plenum can reach any AI provider, and the check that holds every provider
// route shut until they have. The texts are in legal/ (EULA.md, PRIVACY.md, THIRD-PARTY-SERVICES.md, terms.json); scripts/build-legal.mjs
// keeps terms.json honest (a text edit either raises the version, so people accept again, or updates the hash). The page side is
// public/ext-legal.js, the routes are lib/routes/legal.mjs, and this file cannot be changed by an applied update (lib/updates.mjs
// LEGAL_BLOCKED).
//
// What is stored: st.legal = { accepted: { version, at, app, eula, privacy }, history: [accepted, ...] } in state.json (at most 20 history
// entries). `eula` and `privacy` are the sha256 of the two texts as they were on the screen when the person agreed. termsAccepted counts
// a record only when its version is the current one AND both hashes equal the sha256 that legal/terms.json gives for the current texts,
// so a text that changed after the agreement brings the screen back, and a record with no hashes (from before this check) is not an
// acceptance. No key, token or text is stored. The record is local only: Plenum has no server, so it proves the flow, not who clicked.
//
// The gate (termsGate) is a pure function of the request and the state, so server.mjs can call it before any route runs and a test can
// call it with a fake state. It fails closed: when legal/terms.json cannot be read, nothing counts as accepted and the accept route
// answers 500, so a broken install never lets a provider be reached without the agreement.
//
// Exports: TERMS, DOCS, DOC_TITLES, OPEN_FILES, OPEN_POSTS, GATED_GETS, TERMS_REQUIRED, loadTerms, docHashes, readDoc, termsAccepted,
// acceptTerms, termsGate, legalSummary, changesAfter. Every function that reads the terms takes them as an optional last argument
// (default TERMS), so a test can try version 2 without a second copy of the app.
import { createHash } from 'node:crypto';
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './overlay.mjs';

// Documents come from this fixed map, so no request path is ever joined onto the disk. The first three are in legal/, the last is the
// generated list of open-source licences at the top of the install folder.
export const DOCS = Object.freeze({
  eula: 'legal/EULA.md',
  privacy: 'legal/PRIVACY.md',
  'third-party': 'legal/THIRD-PARTY-SERVICES.md',
  'open-source': 'THIRD-PARTY-NOTICES.txt',
});
export const DOC_TITLES = Object.freeze({
  eula: 'License Agreement',
  privacy: 'Privacy Notice',
  'third-party': 'Third-party services',
  'open-source': 'Open-source licences',
});
// The files the Legal page can ask the desktop app to open (desktop/handlers/legal.cjs maps each to a fixed file beside the app).
export const OPEN_FILES = Object.freeze(['chromium', 'electron', 'license', 'notices']);
// The only requests answered before the terms are accepted: these POSTs. Every other POST (and any other method that is not a read)
// waits, so a route module added later cannot slip past the gate.
export const OPEN_POSTS = Object.freeze(['/api/legal/accept', '/api/legal/decline', '/api/legal/open-file', '/api/store/health/ack']);
// Reads that reach a provider or run a provider CLI, so they wait too. /api/usage and /api/accounts run provider CLIs, /api/openrouter/models
// and the finder call other companies' servers, and /api/quota starts the Codex app server. GET /api/state and /api/status stay open:
// the page needs the catalog to draw itself (providerStatus runs the CLI's own local `auth status`, which is a check of the CLI's state
// and not a provider run). A route module marks its own GET with `gated: true` (lib/routes/index.mjs allRoutes lists the flag).
export const GATED_GETS = Object.freeze(['/api/usage', '/api/openrouter/models', '/api/accounts', '/api/quota', '/api/finder', '/api/finder/endpoints']);

export const TERMS_REQUIRED = 'Accept the Plenum License Agreement first. It opens when Plenum starts.';
const BROKEN = 'The license agreement is missing from this installation, so Plenum cannot be used. Install Plenum again.';
const HISTORY_MAX = 20;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Two hashes are the same only when the stored one is a sha256 in hex and equals the expected one (a missing value is never the same).
const sameHash = (stored, expected) => typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored) && stored === expected;
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

// Reads legal/terms.json from the install folder. Never throws: a file that is missing or not valid gives { broken: true } and
// version 0, which termsAccepted treats as "nothing can be accepted".
export function loadTerms(root = APP_ROOT) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'legal', 'terms.json'), 'utf8'));
    if (!isObject(raw) || !Number.isInteger(raw.version) || raw.version < 1) throw new Error('version must be a whole number from 1');
    const changes = {};
    for (const [key, lines] of Object.entries(isObject(raw.changes) ? raw.changes : {})) {
      if (/^[1-9]\d*$/.test(key) && Array.isArray(lines)) changes[key] = lines.filter(l => typeof l === 'string');
    }
    return Object.freeze({
      version: raw.version,
      effective: String(raw.effective ?? ''),
      contact: String(raw.contact ?? ''),
      sha256: Object.freeze(isObject(raw.sha256) ? { ...raw.sha256 } : {}),
      changes: Object.freeze(changes),
      broken: false,
      root,
    });
  } catch (err) {
    return Object.freeze({ version: 0, effective: '', contact: '', sha256: Object.freeze({}), changes: Object.freeze({}), broken: true, error: String(err?.message ?? err), root });
  }
}

// Read once, when the server starts.
export const TERMS = loadTerms();

// The sha256 of the agreement and the privacy notice as they are on disk now (the bytes, the same way scripts/build-legal.mjs hashes
// them). Throws 500 when either is missing.
export function docHashes(terms = TERMS) {
  try {
    return {
      eula: sha256(fs.readFileSync(path.join(terms.root, DOCS.eula))),
      privacy: sha256(fs.readFileSync(path.join(terms.root, DOCS.privacy))),
    };
  } catch {
    throw httpError(500, BROKEN);
  }
}

// One document as { name, title, text } with LF line ends. 400 for a name that is not in DOCS, 404 for a document that is not in
// this installation (the open-source list is generated and may not have been built).
export async function readDoc(name, terms = TERMS) {
  if (typeof name !== 'string' || !Object.hasOwn(DOCS, name)) throw httpError(400, 'Unknown document.');
  let text;
  try {
    text = await fsp.readFile(path.join(terms.root, DOCS[name]), 'utf8');
  } catch {
    throw httpError(404, 'This document is not in this installation.');
  }
  return { name, title: DOC_TITLES[name], text: text.replace(/\r\n/g, '\n') };
}

// Whether the person has accepted this version or a later one, to the texts as legal/terms.json has them now. The record must hold the
// sha256 of the License Agreement and of the Privacy Notice that terms.json gives. A state with no record, a record of an older version,
// a record with missing or different hashes, and a broken terms file all answer false.
export function termsAccepted(st, terms = TERMS) {
  if (terms.broken) return false;
  const accepted = st?.legal?.accepted;
  if (!(Number(accepted?.version) >= terms.version)) return false;
  return sameHash(accepted.eula, terms.sha256?.['EULA.md']) && sameHash(accepted.privacy, terms.sha256?.['PRIVACY.md']);
}

// Records the agreement. The version and both hashes must be the ones the person saw, so a text changed under an open screen is
// refused with 409 and the page reads the new one. Sets st.legal and returns the record; the caller saves the state.
// The hashes the person saw come from the texts on disk, but termsAccepted compares a record with legal/terms.json. When the two differ (a
// text edited without `npm run legal`) a record written here would never count and the agreement screen would come back after every Accept,
// so this refuses with the broken-install 500 instead and says on the console how to put it right.
export function acceptTerms(st, { version, eula, privacy, appVersion = '', now = Date.now() } = {}, terms = TERMS) {
  if (terms.broken) throw httpError(500, BROKEN);
  const hashes = docHashes(terms);
  if (!sameHash(terms.sha256?.['EULA.md'], hashes.eula) || !sameHash(terms.sha256?.['PRIVACY.md'], hashes.privacy)) {
    console.error('legal/terms.json does not match legal/EULA.md and legal/PRIVACY.md, so the agreement cannot be recorded. Run: npm run legal');
    throw httpError(500, BROKEN);
  }
  if (version !== terms.version || eula !== hashes.eula || privacy !== hashes.privacy) {
    throw httpError(409, 'The terms changed while this screen was open. Read the new version.');
  }
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const accepted = { version, at, app: String(appVersion ?? ''), eula, privacy };
  st.legal = { accepted, history: [...(Array.isArray(st.legal?.history) ? st.legal.history : []), accepted].slice(-HISTORY_MAX) };
  return accepted;
}

// null when the request may go on; otherwise the Error to throw (status 403, terms: true, which the server sends as { error, terms: true }
// and the page turns into the agreement screen). `route` is the route module entry for the request, or null.
export function termsGate({ method, pathname, route = null, st }, terms = TERMS) {
  if (termsAccepted(st, terms)) return null;
  const m = String(method ?? '').toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  const blocked = read ? (GATED_GETS.includes(pathname) || route?.gated === true) : !(m === 'POST' && OPEN_POSTS.includes(pathname));
  return blocked ? httpError(403, TERMS_REQUIRED, { terms: true }) : null;
}

// The part of the state the page and the desktop app read (publicState.legal).
export function legalSummary(st, terms = TERMS) {
  return {
    version: terms.version,
    accepted: st?.legal?.accepted?.version ?? null,
    acceptedAt: st?.legal?.accepted?.at ?? null,
    required: !termsAccepted(st, terms),
  };
}

// The changes lines of every version newer than the one accepted, as { '2': [...], '3': [...] } in the shape terms.json keeps them.
// With nothing accepted, that is every version.
export function changesAfter(st, terms = TERMS) {
  const seen = Number(st?.legal?.accepted?.version) || 0;
  return Object.fromEntries(Object.entries(terms.changes).filter(([version]) => Number(version) > seen).sort((a, b) => Number(a[0]) - Number(b[0])));
}
