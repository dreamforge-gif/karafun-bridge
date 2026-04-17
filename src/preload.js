'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // --- Queue Manager ---
  getSongs: () => ipcRenderer.invoke('get-songs'),
  addSong: (id) => ipcRenderer.invoke('add-song', id),
  skipSong: (id) => ipcRenderer.invoke('skip-song', id),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // --- Settings ---
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getCommunities: () => ipcRenderer.invoke('get-communities'),
  getSettings: () => ipcRenderer.invoke('get-settings'),

  // --- Push events from main → renderer ---
  onSongsUpdated: (cb) => ipcRenderer.on('songs-updated', (_event, data) => cb(data)),
  onStatusUpdated: (cb) => ipcRenderer.on('status-updated', (_event, data) => cb(data)),

  // Cleanup helpers (call in beforeunload)
  removeSongsListener: () => ipcRenderer.removeAllListeners('songs-updated'),
  removeStatusListener: () => ipcRenderer.removeAllListeners('status-updated'),
});
