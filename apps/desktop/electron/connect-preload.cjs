// The start screen can ask the main process to open an office — the person's own, or one they were invited to — and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  'orchConnect',
  Object.freeze({
    context: () => ipcRenderer.invoke('orch:connect-context'),
    connect: (target) => ipcRenderer.invoke('orch:connect', { url: String(target?.url ?? ''), token: String(target?.token ?? '') }),
    startLocal: () => ipcRenderer.invoke('orch:start-local'),
    openOwn: () => ipcRenderer.invoke('orch:open-own'),
    join: (invite) => ipcRenderer.invoke('orch:join', { invite: String(invite ?? '') }),
    joinSaved: (id) => ipcRenderer.invoke('orch:join-saved', { id: String(id ?? '') }),
    joinedAtStart: (id, on) => ipcRenderer.invoke('orch:joined-at-start', { id: String(id ?? ''), on: on === true }),
    forgetJoined: (id) => ipcRenderer.invoke('orch:forget-joined', { id: String(id ?? '') }),
  }),
);
