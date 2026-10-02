const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grooveDesktop', {
  // ── Host Server ──────────────────────────────────────
  getServerStatus:  ()       => ipcRenderer.invoke('get-server-status'),
  startServer:      (port)   => ipcRenderer.invoke('start-server', port),
  stopServer:       ()       => ipcRenderer.invoke('stop-server'),
  restartServer:    (port)   => ipcRenderer.invoke('restart-server', port),
  getNetworkInfo:   ()       => ipcRenderer.invoke('get-network-info'),

  // ── Worker Mode ──────────────────────────────────────
  getWorkerStatus:  ()       => ipcRenderer.invoke('get-worker-status'),
  connectWorker:    (url)    => ipcRenderer.invoke('connect-worker', url),
  disconnectWorker: ()       => ipcRenderer.invoke('disconnect-worker'),

  // ── Settings ─────────────────────────────────────────
  getSettings:          ()      => ipcRenderer.invoke('get-settings'),
  setRunInBackground:   (val)   => ipcRenderer.invoke('set-run-in-background', val),
  getAutostart:         ()      => ipcRenderer.invoke('get-autostart'),
  setAutostart:         (val)   => ipcRenderer.invoke('set-autostart', val),

  // ── Misc ─────────────────────────────────────────────
  openBrowser:  (url)  => ipcRenderer.invoke('open-browser', url),
  hideWindow:   ()     => ipcRenderer.invoke('hide-window'),
  closeWindow:  ()     => ipcRenderer.invoke('close-window'),
  generateQR:   (text) => ipcRenderer.invoke('generate-qr', text),

  // ── Event listeners ──────────────────────────────────
  onStatusChange: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('server-status-changed', handler);
    return () => ipcRenderer.removeListener('server-status-changed', handler);
  },
  onWorkerStatusChange: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('worker-status-changed', handler);
    return () => ipcRenderer.removeListener('worker-status-changed', handler);
  }
});
