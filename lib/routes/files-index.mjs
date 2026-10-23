// The @ picker's file list (pro-09, lib/file-index.mjs). GET /api/files/index?project=ID&thread=&refresh=1 answers
//   { files: [{ p, dir?: true, secret?: true, space? : true }], truncated, source: 'git' | 'walk', at }
// for the folder of the thread (the project's folder until threads have their own, see lib/scope.mjs). Reading changes nothing. refresh=1
// rebuilds the list at most once every two seconds; the page asks for it when a run ends. Nothing here reaches the network or a model,
// so the route is not gated by the terms.
import { promises as fs } from 'node:fs';
import { indexFor } from '../file-index.mjs';
import { scopeFor } from '../scope.mjs';

export const routes = [
  { method: 'GET', path: '/api/files/index', handler: indexRoute },
];

// The project's folder must still be there; a missing one is reported as such (the same words as the other folder routes).
async function indexRoute({ res, url, json, projectById, store, httpError }) {
  const project = projectById(url.searchParams.get('project'));
  const thread = url.searchParams.get('thread') || undefined;
  const scope = scopeFor(store, project, thread);
  const info = await fs.stat(scope.root).catch(() => null);
  if (!info?.isDirectory()) throw httpError(400, `The project folder is missing: ${scope.root}. Put it back, or remove the project.`);
  const refresh = url.searchParams.get('refresh') === '1';
  let listed;
  try {
    listed = await indexFor(scope.root, { refresh });
  } catch (err) {
    console.error('File index:', err.message);
    throw httpError(500, 'Plenum could not list the files of this project. Try again.');
  }
  return json(res, 200, listed);
}
