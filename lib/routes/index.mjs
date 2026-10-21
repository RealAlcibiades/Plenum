// Route modules. Each file in this folder (except this one) exports `routes`: an array of { method, path, handler }.
// The files are found by reading the folder, so a new route module needs no edit here. They load in file-name order.
// The server calls handler({ req, res, url, json, readBody, httpError, store, projectById,
// streamForProject, publicState, approvalRequester, running, relaySeats }) before its own switch,
// and the handler answers the response itself (return json(...) or stream with streamForProject).
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort();

const ALL = [];
for (const file of files) {
  // Top-level await: server.mjs imports this module statically, so the server waits until every route module has loaded.
  const mod = await import('./' + file);
  ALL.push(...(mod.routes ?? []));
}

export function findExtRoute(method, pathname) {
  return ALL.find(r => r.method === method && r.path === pathname) ?? null;
}
