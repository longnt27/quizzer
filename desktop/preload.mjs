import { contextBridge, ipcRenderer } from 'electron';

// Expose immutable, non-sensitive diagnostics only. Product operations use
// the same validated local HTTP service as the web and CLI clients.
contextBridge.exposeInMainWorld('quizzerDesktop', Object.freeze({
  platform: process.platform,
  architecture: process.arch,
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
  selectPluginDirectory: () => ipcRenderer.invoke('plugins:select-directory'),
  credentials: Object.freeze({
    status: () => ipcRenderer.invoke('credentials:status'),
    list: () => ipcRenderer.invoke('credentials:list'),
    set: (provider, value) => ipcRenderer.invoke('credentials:set', provider, value),
    delete: provider => ipcRenderer.invoke('credentials:delete', provider),
  }),
}));
