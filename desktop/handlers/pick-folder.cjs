'use strict';
// The server's "Browse…" (lib/pick-folder.mjs sends pick-folder). Opens the folder dialog and answers with the folder, or null when
// it is cancelled or cannot open. The window is shown first, in case it is in the tray. A request that arrives while a dialog is
// open gets busy: true, so the server refuses it instead of reading it as a cancelled dialog. The path is not logged.
let folderPickOpen = false;

module.exports = {
  name: 'pick-folder',
  messages: {
    // -> { type: 'pick-folder-result', id, path } or, while a dialog is open, { type, id, path: null, busy: true }.
    'pick-folder': async (message, shell) => {
      if (typeof message.id !== 'string') return undefined;
      if (folderPickOpen) return { path: null, busy: true };
      folderPickOpen = true;
      let folder = null;
      try {
        shell.showWindow();
        const options = { properties: ['openDirectory'], title: 'Choose a project folder' };
        const win = shell.win();
        const r = win ? await shell.dialog.showOpenDialog(win, options) : await shell.dialog.showOpenDialog(options);
        folder = r.canceled || !r.filePaths?.length ? null : r.filePaths[0];
      } catch {
        folder = null;
      } finally {
        folderPickOpen = false;
      }
      return { path: folder };
    },
  },
};
