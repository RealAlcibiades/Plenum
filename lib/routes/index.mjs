// Route modules. Each file in this folder (except this one) exports `routes`: an array of { method, path, handler }.
// The files are found by reading the folder, so a new route module needs no edit here. They load in file-name order.
// The server calls handler({ req, res, url, json, readBody, httpError, store, projectById,
// streamForProject, publicState, approvalRequester, running, relaySeats, events }) before its own switch,
// and the handler answers the response itself (return json(...) or stream with streamForProject). events is lib/events.mjs
// (publish, publishState, tag). The server checks the Plenum token on every /api/ request before any handler runs.
// The folder is read through lib/overlay.mjs, so a route module that an applied update adds or replaces (the update's generation
// holds it, see lib/updates.mjs) is found and loaded from there; the import names the install path and the module hook answers
// with the generation's copy.
// streamForProject takes a last argument { kind } that names the run on the events channel: streamForProject(req, res,
// project, makeRun, onEvent, { kind: 'compare' }).
import { CODE_ROOT, listFiles, moduleUrl } from '../overlay.mjs';

const files = listFiles('lib/routes', name => name.endsWith('.mjs') && name !== 'index.mjs', CODE_ROOT);

const ALL = [];
for (const file of files) {
  // Top-level await: server.mjs imports this module statically, so the server waits until every route module has loaded.
  const mod = await import(moduleUrl('lib/routes/' + file, CODE_ROOT));
  ALL.push(...(mod.routes ?? []));
}

export function findExtRoute(method, pathname) {
  return ALL.find(r => r.method === method && r.path === pathname) ?? null;
}
