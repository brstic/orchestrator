// Hands the page the server address and owner token, and one thing it may ask for: the system's folder dialog.
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : '';
};

contextBridge.exposeInMainWorld(
  'orchestrator',
  Object.freeze({
    serverUrl: arg('orch-server'),
    token: arg('orch-token'),
    platform: process.platform,
    /** The system's folder dialog; resolves to the chosen path, or null when cancelled. */
    pickFolder: () => ipcRenderer.invoke('orch:pick-folder'),
    pickFolders: () => ipcRenderer.invoke('orch:pick-folders'),
    /** This computer's own preferences (graphics, keys, extras): one file for every office opened from here. */
    prefs: Object.freeze({
      get: () => ipcRenderer.invoke('orch:prefs-get'),
      set: (prefs) => ipcRenderer.invoke('orch:prefs-set', prefs),
    }),
    /** This computer's own host in an office someone else runs: { state: none|starting|online|unavailable|stopped, reason, hostId }. */
    myHost: Object.freeze({
      get: () => ipcRenderer.invoke('orch:my-host'),
      onState: (cb) => {
        const fn = (_e, state) => cb(state);
        ipcRenderer.on('orch:my-host-state', fn);
        return () => ipcRenderer.removeListener('orch:my-host-state', fn);
      },
    }),
    /** The office TV (an embedded browser): its page state and picture, and forgetting what it stored. */
    tv: Object.freeze({
      partition: 'persist:orch-tv',
      onState: (cb) => {
        const fn = (_e, state) => cb(state);
        ipcRenderer.on('orch:tv-state', fn);
        return () => ipcRenderer.removeListener('orch:tv-state', fn);
      },
      onFrame: (cb) => {
        const fn = (_e, jpegBase64) => cb(jpegBase64);
        ipcRenderer.on('orch:tv-frame', fn);
        return () => ipcRenderer.removeListener('orch:tv-frame', fn);
      },
      forget: () => ipcRenderer.invoke('orch:tv-forget'),
    }),
  }),
);
