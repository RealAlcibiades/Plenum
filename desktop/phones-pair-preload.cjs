'use strict';
// The pairing window's only bridge to the desktop (desktop/handlers/phones.cjs). It exposes exactly two functions on window.plenumPair:
//  - onOffer(callback): the callback gets each payload the desktop sends (the state, the picture and the words to show);
//  - answer(action): sends one action to the desktop: allow, deny, copy, new-code, cancel or done. The desktop checks the action again.
// Nothing else from Electron or Node reaches the page. The window is sandboxed, so this file may use only the 'electron' module.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plenumPair', {
  onOffer: callback => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('phones-pair:offer', (_event, offer) => callback(offer));
  },
  answer: action => {
    if (typeof action === 'string') ipcRenderer.send('phones-pair:answer', action);
  },
});
