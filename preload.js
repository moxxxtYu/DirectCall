const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  setShareSource: (id) => ipcRenderer.invoke('set-share-source', id),
  setWindowSize: (w, h) => ipcRenderer.invoke('set-window-size', w, h),
  testPutCode: (code) => ipcRenderer.invoke('test-put-code', code),
  testGetCode: () => ipcRenderer.invoke('test-get-code'),
  onTestMode: (cb) => ipcRenderer.on('test-mode', (e, mode) => cb(mode)),
});
