// Hands the page the server address and owner token, and one thing it may ask for: the system's folder dialog.
const { contextBridge, ipcRenderer } = require('electron');

// The office's address, the person's credential for it and the TV's storage: asked of the app, which answers only
// the office's own page (they used to be on this process's command line, where other users of the computer could read them).
const boot = (() => {
  try {
    return ipcRenderer.sendSync('orch:boot') || {};
  } catch {
    return {};
  }
})();

contextBridge.exposeInMainWorld(
  'orchestrator',
  Object.freeze({
    serverUrl: String(boot.serverUrl || ''),
    token: String(boot.token || ''),
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
    /**
     * Servers of this person's own in an office someone else runs: the app reaches them over SSH with the keys on this
     * computer. Adding and removing ask the person in a dialog of the app's own first.
     */
    servers: Object.freeze({
      list: () => ipcRenderer.invoke('orch:servers'),
      add: (input) => ipcRenderer.invoke('orch:servers-add', input),
      reconnect: (id) => ipcRenderer.invoke('orch:servers-reconnect', id),
      setRoots: (id, roots) => ipcRenderer.invoke('orch:servers-roots', id, roots),
      browse: (id, dir) => ipcRenderer.invoke('orch:servers-browse', id, dir),
      remove: (id) => ipcRenderer.invoke('orch:servers-remove', id),
      onChange: (cb) => {
        const fn = () => cb();
        ipcRenderer.on('orch:servers-changed', fn);
        return () => ipcRenderer.removeListener('orch:servers-changed', fn);
      },
    }),
    /** The office TV (an embedded browser): its page state and picture, and forgetting what it stored. */
    tv: Object.freeze({
      partition: String(boot.tvPartition || 'persist:orch-tv'),
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
