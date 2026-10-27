'use strict';
// The harness preload (mob-18). It runs in the harness window only, before any page script. It does two things the phone build
// needs before the native shell exists:
//   1. sets data-surface="phone" on <html> for the phone surface (the desktop surface gets no marker, as the real app has none);
//   2. exposes window.plenumShell as the desktop preload does ({ desktop: true, token() }), so the UI never reads web storage.
// The token is read through ipcMain (electron-main.cjs): it is handed to the server origin only, never to a Bridge page.
const { contextBridge, ipcRenderer } = require('electron');

let config = { surface: '' };
try {
  config = ipcRenderer.sendSync('harness:config') || config;
} catch {
  // No harness behind this window: the page loads as a plain page.
}

const mark = () => {
  const html = document.documentElement;
  if (!html) return false;
  if (config.surface) html.dataset.surface = config.surface;
  return true;
};
// The root element may not exist yet while the preload runs: set the marker the moment it appears, before the page's scripts.
if (!mark()) {
  const observer = new MutationObserver(() => {
    if (mark()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

contextBridge.exposeInMainWorld('plenumShell', {
  desktop: true,
  token: () => ipcRenderer.invoke('harness:token'),
});
