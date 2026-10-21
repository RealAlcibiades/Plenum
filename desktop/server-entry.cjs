'use strict';
// Entry point for the local server when the desktop app runs it as an Electron utility process (see startServer in main.cjs).
// The server is an ES module, so it is loaded with import(). A failure is printed to stderr, which the app writes to its
// log, and ends the process with a non-zero code.
import('../server.mjs').catch(err => {
  console.error(`The Plenum server could not start: ${err?.stack ?? err}`);
  process.exit(1);
});
