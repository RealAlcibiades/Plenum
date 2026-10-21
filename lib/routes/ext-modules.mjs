// GET /api/ext-modules: the names of the extra panels in public/ (files ext-*.js, without the extension).
// public/ext.js loads every name this lists, so a panel added to the folder needs no edit there.
// The folder is read on each request. Only names that match NAME are sent, so a file name never reaches the page unchecked.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../updates.mjs';

const NAME = /^ext-[a-z0-9-]{1,40}$/;

export const routes = [
  { method: 'GET', path: '/api/ext-modules', handler: listRoute },
];

async function listRoute({ res, json }) {
  const modules = await panelNames(path.join(APP_ROOT, 'public'));
  return json(res, 200, { modules });
}

// The sorted names of the ext-*.js files in dir, without the extension. 'ext' itself is never listed.
async function panelNames(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => e.name.slice(0, -3))
    .filter(name => name !== 'ext' && NAME.test(name))
    .sort();
}
