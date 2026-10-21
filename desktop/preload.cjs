'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only thing the app page can reach from here. token() asks the main process for this launch's token; the main process
// answers only the app's own window at the app's own address, and gives '' to any other page (see 'plenum:token' in main.cjs).
contextBridge.exposeInMainWorld('plenumShell', { desktop: true, token: () => ipcRenderer.invoke('plenum:token') });
