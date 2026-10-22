'use strict';
// The stop key for a model that drives the screen or the browser (lib/drive.mjs). The server asks for the key while a drive that
// wants it is live: { type: 'drive-hotkey', on: true, accelerator } registers it, and { on: false } lets it go. Pressing the key sends
// the server { type: 'drive-stop' }, which stops every drive. The accelerator comes from the server and is checked here against the
// same pattern the server uses. Nothing else is registered, and the key's one callback sends one fixed message.
// 'drive-show' brings Plenum's window forward (the bar's "Show Plenum" while an approval card waits). Nothing here logs.
// The key is released when the server exits and when the app quits, so a stopped run never leaves a shortcut behind.

const ACCELERATOR = /^((Ctrl|Alt|Shift|Super)\+){1,3}(Escape|F[1-9]|F1[0-2]|[A-Z])$/;

// The accelerator this handler registered, or null.
let held = null;
// The Electron globalShortcut module, found on first use: null when this process has none (plain Node, or a test).
let shortcuts;

function globalShortcut() {
  if (shortcuts !== undefined) return shortcuts;
  try {
    const gs = require('electron').globalShortcut;
    shortcuts = gs && typeof gs.register === 'function' ? gs : null;
  } catch {
    shortcuts = null;
  }
  return shortcuts;
}

// Lets go of the key this handler holds, if any.
function release() {
  if (held && shortcuts) {
    try {
      shortcuts.unregister(held);
    } catch {
      // The shortcut is already gone.
    }
  }
  held = null;
}

module.exports = {
  name: 'drive',
  messages: {
    // -> { type: 'drive-hotkey-result', id, ok, accelerator, reason }. Only a registered key answers ok true.
    'drive-hotkey': async (message, shell) => {
      const gs = globalShortcut();
      if (message.on !== true) {
        release();
        return { ok: true, accelerator: '', reason: '' };
      }
      if (!gs) return { ok: false, accelerator: '', reason: 'This desktop app cannot register shortcuts.' };
      const accelerator = message.accelerator;
      if (typeof accelerator !== 'string' || !ACCELERATOR.test(accelerator)) {
        return { ok: false, accelerator: '', reason: 'The stop key is not a valid shortcut.' };
      }
      release();
      let ok = false;
      try {
        ok = gs.register(accelerator, () => shell.tell({ type: 'drive-stop' })) === true;
      } catch {
        ok = false;
      }
      if (ok) held = accelerator;
      return { ok, accelerator, reason: ok ? '' : 'The desktop refused the key (another program may own it).' };
    },
    // No reply. Brings the window forward, and nothing else.
    'drive-show': (message, shell) => {
      shell.showWindow();
      return undefined;
    },
  },
  hooks: {
    serverExited() {
      release();
    },
    beforeQuit() {
      release();
    },
  },
  // For the handler's tests: the shortcut module to use instead of Electron's (null for none).
  setShortcuts(gs) {
    shortcuts = gs;
    held = null;
  },
};
