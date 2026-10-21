// Start Plenum with this file (node plenum.mjs): it runs the bootstrap for applied updates first, then the server.
// The bootstrap (lib/overlay/register.cjs) reads the overlay in the state folder, settles an update that did not start, and
// registers the module hook that loads the active generation's files in place of the shipped ones. `node server.mjs` still works
// and runs the shipped files with no overlay.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)('./lib/overlay/register.cjs').activate({
  appRoot: here,
  home: process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console'),
});
await import('./server.mjs');
