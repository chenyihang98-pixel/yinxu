'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// A deliberately small, typed bridge; no raw IPC, filesystem, or credentials access.
contextBridge.exposeInMainWorld('museDesktop', Object.freeze({
  getSettings: () => ipcRenderer.invoke('muse:get-settings'),
  saveApiKey: key => ipcRenderer.invoke('muse:save-api-key', key),
  deleteApiKey: () => ipcRenderer.invoke('muse:delete-api-key'),
  saveProviderCredentials: (provider, credentials) => ipcRenderer.invoke('muse:save-provider', provider, credentials),
  deleteProviderCredentials: provider => ipcRenderer.invoke('muse:delete-provider', provider),
  generateMusic: input => ipcRenderer.invoke('muse:generate-music', input),
  cancelGeneration: () => ipcRenderer.invoke('muse:cancel-generation'),
  saveAudio: input => ipcRenderer.invoke('muse:save-audio', input),
  openExternal: url => ipcRenderer.invoke('muse:open-external', url),
}));
