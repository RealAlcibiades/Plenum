// GET /api/ext-modules: the names of the extra panels in public/ (files ext-*.js, without the extension).
// public/ext.js loads every name this lists, so a panel added to the folder needs no edit there.
// The folder is read on each request, shipped files and the active applied update's files together (lib/overlay.mjs). Only names
// that match NAME are sent, so a file name never reaches the page unchecked.
import { listFiles } from '../overlay.mjs';

const NAME = /^ext-[a-z0-9-]{1,40}$/;

export const routes = [
  { method: 'GET', path: '/api/ext-modules', handler: listRoute },
];

async function listRoute({ res, json }) {
  return json(res, 200, { modules: panelNames() });
}

// The sorted names of the ext-*.js files in public/, without the extension. 'ext' itself is never listed.
function panelNames() {
  return listFiles('public', name => name.endsWith('.js'))
    .map(name => name.slice(0, -3))
    .filter(name => name !== 'ext' && NAME.test(name))
    .sort();
}
