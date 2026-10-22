'use strict';
// The desktop side of the legal gate (lib/legal.mjs, lib/routes/legal.mjs).
//  - open-legal-file: the Legal page's "Open Chromium licences" and "Open Electron licence" buttons (and the licence and notices files).
//    The server sends a name; this maps it to a fixed file beside the app and opens it with the system's viewer. A path never comes from
//    the page or the server. The reply is { ok: true } or { ok: false, message }; the path is not sent back and not logged.
//  - serverExited: the server ends with code 76 when the person declines the agreement (POST /api/legal/decline). That means "quit", so
//    the app quits here, before main.cjs reads the exit as a crash ("Plenum stopped") or as a restart. app.quit() runs before-quit, which
//    sets main.cjs's quitting flag, and main.cjs checks that flag right after the hooks.
// Exports (besides what the loader reads): QUIT_EXIT_CODE, FILES, searchDirs, findFile, so tests can try them without Electron.

const fs = require('node:fs');
const path = require('node:path');

const QUIT_EXIT_CODE = 76;

// The files a name can mean, in the order they are tried inside each folder. A packaged app has LICENSE.electron.txt (electron-builder
// renames Electron's LICENSE); `electron .` from a checkout has Electron's own LICENSE beside electron.exe.
const FILES = Object.freeze({
  chromium: ['LICENSES.chromium.html'],
  electron: ['LICENSE.electron.txt', 'LICENSE'],
  license: ['LICENSE.txt'],
  notices: ['THIRD-PARTY-NOTICES.txt'],
});

// The folders a file is looked for in, most likely first: beside the executable (Windows and Linux), the places inside a macOS bundle
// (Contents, Resources and the Electron framework's resources), then the app folder, where LICENSE.txt and THIRD-PARTY-NOTICES.txt are
// also copied by the build and where they sit in a checkout.
function searchDirs({ execPath, appPath, platform = process.platform } = {}) {
  const dirs = [];
  if (typeof execPath === 'string' && execPath) {
    const exeDir = path.dirname(execPath);
    dirs.push(exeDir);
    if (platform === 'darwin') {
      const contents = path.resolve(exeDir, '..');
      dirs.push(contents, path.join(contents, 'Resources'));
      dirs.push(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Resources'));
      dirs.push(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'));
    }
  }
  if (typeof appPath === 'string' && appPath) dirs.push(appPath);
  return dirs;
}

// The first existing file for a name, or null. `exists` is for tests.
function findFile(name, dirs, exists = file => fs.existsSync(file)) {
  if (typeof name !== 'string' || !Object.hasOwn(FILES, name)) return null;
  for (const dir of dirs) {
    for (const file of FILES[name]) {
      const full = path.join(dir, file);
      if (exists(full)) return full;
    }
  }
  return null;
}

module.exports = {
  name: 'legal',
  QUIT_EXIT_CODE,
  FILES,
  searchDirs,
  findFile,
  messages: {
    // -> { type: 'open-legal-file-result', id, ok, message? }
    'open-legal-file': async (message, shell) => {
      const file = findFile(message.name, searchDirs({ execPath: process.execPath, appPath: shell.app?.getAppPath?.() }));
      if (!file) return { ok: false, message: 'That file was not found next to Plenum.' };
      const failure = await shell.shell.openPath(file);
      return failure ? { ok: false, message: 'The file could not be opened.' } : { ok: true };
    },
  },
  hooks: {
    serverExited(shell, code) {
      if (code === QUIT_EXIT_CODE) shell.app.quit();
    },
  },
};
