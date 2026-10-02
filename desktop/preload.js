const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grooveDesktop', {
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  startServer: (port) => ipcRenderer.invoke('start-server', port),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  restartServer: (port) => ipcRenderer.invoke('restart-server', port),
  getNetworkInfo: () => ipcRenderer.invoke('get-network-info'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enable) => ipcRenderer.invoke('set-autostart', enable),
  openBrowser: (url) => ipcRenderer.invoke('open-browser', url),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  generateQR: (text) => ipcRenderer.invoke('generate-qr', text),
  onStatusChange: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('server-status-changed', handler);
    return () => ipcRenderer.removeListener('server-status-changed', handler);
  }
});
