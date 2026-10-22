'use strict';
// The server's computer-use requests (lib/computer/bridge.mjs sends them over the shell channel, lib/shell.mjs). Every message type
// that starts with 'computer-' goes to one backend (desktop/computer/index.cjs), which answers { type: '<type>-result', id, ...result };
// the message names and their fields are written at the top of that file. Nothing in a message is logged: a request can hold the
// text the model is typing.
//
//  - The backend is made on the first request, not at start-up, so the app starts at the same speed with computer use unused.
//    Under PLENUM_COMPUTER_BACKEND=fake it is the fake backend (desktop/computer/fake.cjs): no screen, no input, no windows.
//  - The overlay page is the app's own server's /overlay.html; its address is taken from the main window's address (always the
//    loopback server), never from a message. The overlay's windows get the per-launch token through their own session
//    (desktop/computer/overlay.cjs), so the page never holds it.
//  - Everything the backend holds (keys, buttons, overlay windows) is let go when the server restarts or exits, when the main
//    window closes, and when the app quits, so a stopped run never leaves a key down or a frame on the screen.
const { createComputerBackend } = require('../computer/index.cjs');
const { isLoopbackHttp } = require('../computer/overlay.cjs');

// The message types the server may send: <method> in kebab case. computer-secure-field is the short spelling of the same request.
const TYPES = Object.freeze([
  'computer-probe', 'computer-windows', 'computer-foreground', 'computer-capture', 'computer-input', 'computer-cursor',
  'computer-user-input', 'computer-focus', 'computer-is-secure-field', 'computer-secure-field', 'computer-release',
  'computer-overlay', 'computer-request-access',
]);

// The address the app's own server is normally at, used until the main window shows a page from it.
const FALLBACK_OVERLAY_URL = 'http://127.0.0.1:4317/overlay.html';

// The Electron modules the real backend needs, or null when this process has none (plain Node, or a test).
function electronParts() {
  try {
    const e = require('electron');
    if (!e || typeof e !== 'object' || !e.screen || !e.desktopCapturer) return null;
    return {
      screen: e.screen, desktopCapturer: e.desktopCapturer, nativeImage: e.nativeImage, BrowserWindow: e.BrowserWindow,
      session: e.session, systemPreferences: e.systemPreferences, nativeTheme: e.nativeTheme,
    };
  } catch {
    return null;
  }
}

// The overlay page's address: next to the page the main window shows, when that is the app's own server on this computer.
function overlayUrlFor(shell) {
  return () => {
    try {
      const url = new URL(shell.win?.()?.webContents?.getURL?.() ?? '');
      if (isLoopbackHttp(url.href)) return `${url.origin}/overlay.html`;
    } catch {
      // The window shows no page from the server yet.
    }
    return FALLBACK_OVERLAY_URL;
  };
}

// The backend for a shell: the real one over Electron, or the fake when the environment asks for it.
function defaultFactory(shell) {
  const electron = electronParts();
  return createComputerBackend({
    electron,
    overlayUrl: overlayUrlFor(shell),
    getToken: () => shell.token,
    theme: () => (electron?.nativeTheme?.shouldUseDarkColors === false ? 'light' : 'dark'),
  });
}

function createHandler({ factory = defaultFactory } = {}) {
  let backend = null;

  const get = shell => {
    backend ??= factory(shell);
    return backend;
  };

  // Lets go of everything the backend holds. Does nothing when no request has made a backend yet.
  async function letGo(close) {
    if (!backend) return;
    const current = backend;
    try {
      if (close) await current.close?.();
      else {
        await current.release();
        await current.overlay({ show: false });
      }
    } catch {
      // Nothing more can be done; the next request starts clean.
    }
  }

  const messages = {};
  for (const type of TYPES) {
    // The backend answers with the whole reply ({ type, id, ... }), which the loader posts as it is. If anything throws, the
    // loader's log line gets a fixed text instead of the error: the error could quote what the model was typing.
    messages[type] = async (message, shell) => {
      try {
        return await get(shell).handle(message);
      } catch {
        throw new Error('the computer-use request could not be handled');
      }
    };
  }

  return {
    name: 'computer',
    messages,
    hooks: {
      // A new window of the app: when it closes, the overlay goes with it (overlay windows alone would keep the app alive).
      windowCreated: (shell, win) => {
        win.on('closed', () => {
          letGo(true);
        });
      },
      // A server that starts or ends is not the one that was driving: nothing it had may stay held or shown.
      serverStarted: () => letGo(false),
      serverExited: () => letGo(false),
      beforeQuit: () => {
        letGo(true);
      },
    },
    // For the tests.
    _backend: () => backend,
    _reset: () => {
      backend = null;
    },
  };
}

module.exports = { ...createHandler(), createHandler, defaultFactory, overlayUrlFor, TYPES };
