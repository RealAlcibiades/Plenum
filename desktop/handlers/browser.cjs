'use strict';
// The Browser pane's requests from the server (lib/browser-bridge.mjs sends them over the shell channel, lib/shell.mjs). Every message
// type in MESSAGE_TYPES (browser-open, browser-navigate, browser-tabs, browser-bounds, ...) goes to one browser (desktop/browser.cjs),
// which answers an object { ok, ... }; the loader posts it as `${type}-result` with the request's id. The messages and the events the
// browser sends on its own are written at the top of desktop/browser.cjs. Nothing in a message is logged: an address is the person's.
//
//  - The browser is made on the first request, not at start-up, so the app starts at the same speed with the pane unused.
//  - The page views sit above the app's page, so they are taken off the window whenever the window closes, the app page loads a new
//    page (a reload), or the server starts or ends: a view must never stay over a page that did not ask for it.
//  - Who is driving (a person or the model) is told by the server (browser-driving); a server that starts or ends is not driving.
//  - The download setting is read from the app state file when a download starts (browser.blockDownloads); the rest of the state file
//    is not read. The server writes it (lib/routes/browser.mjs). No key, token or cookie passes through here.
//  - desktop/main.cjs is not edited for this: the loader finds this file by its name.
const fs = require('node:fs');
const { createBrowser, MESSAGE_TYPES } = require('../browser.cjs');

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The browser for a shell and its window. `shell.stateFile()` is the app state file the server writes.
function defaultFactory(shell, win) {
  return createBrowser({
    win,
    tell: message => shell.tell(message),
    log: line => shell.log?.(line),
    readSettings: () => {
      try {
        const st = JSON.parse(fs.readFileSync(shell.stateFile(), 'utf8'));
        return isObject(st?.browser) ? { blockDownloads: st.browser.blockDownloads === true } : {};
      } catch {
        return {};
      }
    },
    downloadsDir: () => shell.app.getPath('downloads'),
    tempDir: () => shell.app.getPath('temp'),
  });
}

function createHandler({ factory = defaultFactory } = {}) {
  let browser = null;

  const get = shell => {
    if (browser) return browser;
    const win = shell.win?.();
    if (!win) return null;
    browser = factory(shell, win);
    return browser;
  };

  const messages = {};
  for (const type of MESSAGE_TYPES) {
    messages[type] = async (message, shell) => {
      if (typeof message.id !== 'string') return undefined;
      const b = get(shell);
      if (!b) return { ok: false, message: 'The window is not ready.' };
      return b.handle(message);
    };
  }

  // A server that starts or ends is not the one that was driving, and a page view must not outlive the page that placed it.
  const letGo = () => {
    if (!browser) return;
    browser.hide();
    browser.handle({ type: 'browser-driving', agentDriving: false }).catch(() => {});
  };

  return {
    name: 'browser',
    messages,
    hooks: {
      windowCreated: (shell, win) => {
        win.on('close', () => browser?.hide());
        win.on('closed', () => {
          browser?.destroy();
          browser = null;
        });
        // The app page loads again (a reload, or a new page after an update): the old placeholder is gone, so the views go too.
        win.webContents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
          const main = typeof isMainFrame === 'boolean' ? isMainFrame : details?.isMainFrame === true;
          const inPlace = typeof isInPlace === 'boolean' ? isInPlace : details?.isSameDocument === true;
          if (main && !inPlace) browser?.hide();
        });
        win.webContents.on('render-process-gone', () => browser?.hide());
      },
      serverStarted: () => letGo(),
      serverExited: () => letGo(),
      beforeQuit: () => {
        browser?.destroy();
        browser = null;
      },
    },
    // For the tests.
    _browser: () => browser,
    _reset: () => {
      browser = null;
    },
  };
}

module.exports = { ...createHandler(), createHandler, defaultFactory, MESSAGE_TYPES };
