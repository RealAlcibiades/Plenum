'use strict';
// The window's permission guard. When the app window is made, every permission request and check in its session goes through
// desktop/permissions.cjs, which allows only clipboard writes from the app's own page. Electron approves every permission by
// default when no handler is set, so without this a page (or an artifact preview) could ask for the camera or the microphone.
// It is a hook, not a message: it sends nothing and answers no request from the server. desktop/main.cjs is not edited for it.
const { permissionDecision } = require('../permissions.cjs');

// The address of the app window's page. Only that origin may use a permission, so a page in another window of the same session
// (or a frame of one) is judged against the app and not against itself.
function appUrlOf(shell) {
  try {
    return shell.win()?.webContents?.getURL() ?? '';
  } catch {
    return '';
  }
}

module.exports = {
  name: 'artifacts-permissions',
  hooks: {
    // Called with (shell, win) right after the window is made, before the app page loads.
    windowCreated(shell, win) {
      const session = win?.webContents?.session;
      if (!session) return;
      session.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const from = details?.requestingUrl || webContents?.getURL?.() || '';
        callback(permissionDecision(permission, from, appUrlOf(shell)));
      });
      session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
        permissionDecision(permission, details?.requestingUrl || requestingOrigin || '', appUrlOf(shell)));
    },
  },
};
