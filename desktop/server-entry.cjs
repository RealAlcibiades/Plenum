'use strict';
// Entry point for the local server when the desktop app runs it as an Electron utility process (see startServer in main.cjs).
// The bootstrap for applied updates runs first (lib/overlay/register.cjs): it reads the overlay in the state folder, settles an
// update that did not start, and registers the module hook that loads the active generation's files. The server is an ES module,
// so it is loaded with import() after that. A failure is printed to stderr, which the app writes to its log, and ends the process
// with a non-zero code; when an applied update has not started cleanly yet, the app then starts the server once more (main.cjs)
// and the bootstrap goes back to the generation before it.
const os = require('node:os');
const path = require('node:path');
const { activate } = require('../lib/overlay/register.cjs');

activate({
  appRoot: path.resolve(__dirname, '..'),
  home: process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console'),
});

import('../server.mjs').catch(err => {
  console.error(`The Plenum server could not start: ${err?.stack ?? err}`);
  process.exit(1);
});
