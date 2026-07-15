const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startHost: () => ipcRenderer.invoke('start-host'),
  stopHost: () => ipcRenderer.invoke('stop-host'),
  getLocalIps: () => ipcRenderer.invoke('get-local-ips'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  setShareSource: (id) => ipcRenderer.invoke('set-share-source', id),
  setWindowSize: (w, h) => ipcRenderer.invoke('set-window-size', w, h),
  sendSignal: (msg) => ipcRenderer.send('signal-out', msg),
  onSignal: (cb) => ipcRenderer.on('signal-in', (e, msg) => cb(msg)),
  onPeerConnected: (cb) => ipcRenderer.on('peer-connected', () => cb()),
  onPeerDisconnected: (cb) => ipcRenderer.on('peer-disconnected', () => cb()),
  onTestMode: (cb) => ipcRenderer.on('test-mode', (e, mode) => cb(mode)),
});
