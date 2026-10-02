const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const WebSocket = require('ws');
const QRCode = require('qrcode');

// ─── Linux sandbox compatibility ─────────────────────────
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// ─── App State ───────────────────────────────────────────
let tray = null;
let mainWindow = null;
let serverProcess = null;
let serverPort = 9000;
let isServerRunning = false;
let autoRestart = true;

// Worker state (when this companion connects to a remote Groove host)
let workerWs = null;
let workerStatus = { connected: false, hostUrl: '', error: null };
let workerReconnectTimer = null;
let workerPtySessions = new Map(); // local PTY sessions for worker mode
let workerAutoConnect = false;
let workerHostUrl = '';

// Local worker: this Electron app registers itself as a worker on the hosted server
let localWorkerWs = null;

// Settings
let runInBackground = true; // default: minimize to tray on close

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── Network Helpers ─────────────────────────────────────
function getNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const addresses = {
    localhost: `http://localhost:${serverPort}`,
    lan: null,
    tailscale: null,
    all: []
  };

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const url = `http://${iface.address}:${serverPort}`;
        if (iface.address.startsWith('100.')) {
          addresses.tailscale = url;
        } else if (!addresses.lan) {
          addresses.lan = url;
        }
        addresses.all.push({ name, address: iface.address, url });
      }
    }
  }
  return addresses;
}

function killPort(port) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /f /pid %a`, { stdio: 'ignore' });
    } else {
      execSync(`lsof -ti :${port} | xargs -r kill -9`, { stdio: 'ignore' });
    }
  } catch (e) {}
}

// ─── Host Server Management ──────────────────────────────
function startServer(port = serverPort) {
  if (serverProcess) {
    return { success: true, port: serverPort, running: true };
  }

  serverPort = port;
  autoRestart = true;
  killPort(serverPort);

  const serverScript = path.resolve(__dirname, '..', 'server.js');

  serverProcess = fork(serverScript, [], {
    env: { ...process.env, PORT: String(serverPort) },
    silent: true
  });

  isServerRunning = true;
  updateTrayMenu();

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Groove Server] ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Groove Server Error] ${data}`);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log(`[Groove Server] Exited with code ${code}, signal ${signal}`);
    serverProcess = null;
    isServerRunning = false;
    updateTrayMenu();
    notifyStatusChange();
    // Disconnect local worker when server stops
    if (localWorkerWs) { localWorkerWs.terminate(); localWorkerWs = null; }

    if (autoRestart && code !== 0 && code !== 1) {
      console.log('[Groove Server] Restarting in 2s...');
      setTimeout(() => startServer(serverPort), 2000);
    }
  });

  // Connect this Electron app as a local worker so it appears in the workers list
  setTimeout(() => connectLocalWorker(serverPort), 1500);

  notifyStatusChange();
  return { success: true, port: serverPort, running: true };
}

function stopServer() {
  autoRestart = false;
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  isServerRunning = false;
  updateTrayMenu();
  notifyStatusChange();
  return { success: true, running: false };
}

function notifyStatusChange() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-status-changed', {
      running: isServerRunning,
      port: serverPort,
      networks: getNetworkInterfaces()
    });
  }
}

// ─── Local Worker Self-Registration ─────────────────────
// Registers this Electron host as a worker on its own server so it appears
// in the terminal worker dropdown in the browser UI.
function connectLocalWorker(port) {
  if (localWorkerWs) { localWorkerWs.terminate(); localWorkerWs = null; }
  const wsUrl = `ws://127.0.0.1:${port}/worker`;
  try {
    localWorkerWs = new WebSocket(wsUrl, {
      headers: { 'x-groove-worker': '1', 'x-worker-hostname': os.hostname() + ' (host)' }
    });
  } catch { return; }

  localWorkerWs.on('message', (raw) => {
    try { handleWorkerMessage(JSON.parse(raw), localWorkerWs); } catch {}
  });

  localWorkerWs.on('ping', () => {
    if (localWorkerWs) localWorkerWs.pong();
  });

  localWorkerWs.on('close', () => {
    localWorkerWs = null;
    // Reconnect if server is still running
    if (isServerRunning) setTimeout(() => connectLocalWorker(port), 3000);
  });

  localWorkerWs.on('error', () => {
    if (localWorkerWs) { localWorkerWs.terminate(); localWorkerWs = null; }
    if (isServerRunning) setTimeout(() => connectLocalWorker(port), 3000);
  });
}

// ─── Worker Mode ─────────────────────────────────────────
// PC2 companion connects to PC1's Groove server as a "worker"
// All terminal sessions routed to this worker run locally on PC2

const pty = (() => {
  try { return require('node-pty'); } catch { return null; }
})();

function connectWorker(hostUrl) {
  if (workerWs) {
    workerWs.terminate();
    workerWs = null;
  }
  clearTimeout(workerReconnectTimer);

  const wsUrl = hostUrl.replace(/^http/, 'ws') + '/worker';
  console.log(`[Worker] Connecting to ${wsUrl}`);

  workerStatus = { connected: false, hostUrl, error: null };
  notifyWorkerStatus();

  try {
    workerWs = new WebSocket(wsUrl, {
      headers: { 'x-groove-worker': '1', 'x-worker-hostname': os.hostname() }
    });
  } catch (err) {
    workerStatus = { connected: false, hostUrl, error: err.message };
    notifyWorkerStatus();
    scheduleWorkerReconnect(hostUrl);
    return;
  }

  workerWs.on('open', () => {
    console.log('[Worker] Connected to Groove host');
    workerStatus = { connected: true, hostUrl, error: null };
    notifyWorkerStatus();
    updateTrayMenu();
  });

  workerWs.on('ping', () => { if (workerWs) workerWs.pong(); });

  workerWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWorkerMessage(msg);
    } catch (e) {
      console.error('[Worker] Bad message:', e.message);
    }
  });

  workerWs.on('close', () => {
    console.log('[Worker] Disconnected from host');
    workerStatus = { connected: false, hostUrl, error: 'Disconnected' };
    notifyWorkerStatus();
    updateTrayMenu();
    // Kill all local PTY sessions
    for (const [id, session] of workerPtySessions) {
      try { session.pty.kill(); } catch {}
    }
    workerPtySessions.clear();
    if (workerAutoConnect) scheduleWorkerReconnect(hostUrl);
  });

  workerWs.on('error', (err) => {
    console.error('[Worker] Error:', err.message);
    workerStatus = { connected: false, hostUrl, error: err.message };
    notifyWorkerStatus();
  });
}

function handleWorkerMessage(msg, replyWs = workerWs) {
  if (!pty) return;

  if (msg.type === 'sync') {
    // Host is pushing project files — write them to a local temp dir
    const { projectName, files } = msg;
    const destDir = path.join(os.tmpdir(), 'groove-worker', projectName);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of files) {
        const abs = path.join(destDir, f.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(f.content, 'base64'));
      }
      console.log(`[Worker] Synced ${files.length} files to ${destDir}`);
      sendToHost({ type: 'sync-ok', projectName, destDir }, replyWs);
    } catch (err) {
      console.error('[Worker] Sync failed:', err.message);
      sendToHost({ type: 'sync-error', error: err.message }, replyWs);
    }
    return;
  }

  if (msg.type === 'spawn') {
    // Host wants to spawn a terminal session on this worker
    const { sessionId, cwd, cols, rows } = msg;
    if (workerPtySessions.has(sessionId)) return;

    const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    const shell = shellCandidates.find(s => {
      try { return fs.existsSync(s) && fs.statSync(s).isFile(); } catch { return false; }
    }) || '/bin/sh';

    const safeCwd = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 100,
        rows: rows || 30,
        cwd: safeCwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
    } catch (err) {
      sendToHost({ type: 'spawn-error', sessionId, error: err.message }, replyWs);
      return;
    }

    const session = { pty: ptyProcess, replyWs };
    workerPtySessions.set(sessionId, session);

    ptyProcess.onData(data => {
      sendToHost({ type: 'output', sessionId, data }, session.replyWs);
    });

    ptyProcess.onExit(() => {
      workerPtySessions.delete(sessionId);
      sendToHost({ type: 'exit', sessionId }, session.replyWs);
    });

    sendToHost({ type: 'spawn-ok', sessionId }, replyWs);

  } else if (msg.type === 'input') {
    const session = workerPtySessions.get(msg.sessionId);
    if (session) session.pty.write(msg.data);

  } else if (msg.type === 'resize') {
    const session = workerPtySessions.get(msg.sessionId);
    if (session) session.pty.resize(msg.cols, msg.rows);

  } else if (msg.type === 'kill') {
    const session = workerPtySessions.get(msg.sessionId);
    if (session) {
      try { session.pty.kill(); } catch {}
      workerPtySessions.delete(msg.sessionId);
    }
  }
}

function sendToHost(msg, ws = workerWs) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function disconnectWorker() {
  clearTimeout(workerReconnectTimer);
  workerAutoConnect = false;
  if (workerWs) {
    workerWs.terminate();
    workerWs = null;
  }
  for (const [id, session] of workerPtySessions) {
    try { session.pty.kill(); } catch {}
  }
  workerPtySessions.clear();
  workerStatus = { connected: false, hostUrl: workerStatus.hostUrl, error: null };
  notifyWorkerStatus();
  updateTrayMenu();
}

function scheduleWorkerReconnect(hostUrl) {
  clearTimeout(workerReconnectTimer);
  workerReconnectTimer = setTimeout(() => {
    if (workerAutoConnect) connectWorker(hostUrl);
  }, 5000);
}

function notifyWorkerStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worker-status-changed', workerStatus);
  }
}

// ─── Tray ────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', isServerRunning ? 'tray-active.png' : 'tray-inactive.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('Groove — Code Anywhere Companion');
  tray.on('click', () => toggleWindow());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const networks = getNetworkInterfaces();
  const primaryUrl = networks.tailscale || networks.lan || networks.localhost;

  const workerLabel = workerStatus.connected
    ? `🔗 Worker: Connected to ${workerStatus.hostUrl}`
    : (workerAutoConnect ? '🔄 Worker: Reconnecting...' : '⬡ Worker: Disconnected');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isServerRunning
        ? `🟢 Groove Host Active  (Port ${serverPort})`
        : '🔴 Groove Host Stopped',
      enabled: false
    },
    { label: workerLabel, enabled: false },
    { type: 'separator' },
    {
      label: '🖥 Show Companion',
      click: () => showWindow()
    },
    {
      label: '🌐 Open in Browser',
      enabled: isServerRunning,
      click: () => shell.openExternal(primaryUrl)
    },
    { type: 'separator' },
    {
      label: isServerRunning ? '⏹ Stop Host Server' : '▶ Start Host Server',
      click: () => (isServerRunning ? stopServer() : startServer(serverPort))
    },
    {
      label: '🔄 Restart Host Server',
      enabled: isServerRunning,
      click: () => { stopServer(); setTimeout(() => startServer(serverPort), 500); }
    },
    { type: 'separator' },
    {
      label: '✕ Quit Groove',
      click: () => {
        autoRestart = false;
        if (serverProcess) serverProcess.kill();
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Update tray icon based on state
  try {
    const iconName = isServerRunning ? 'tray-active.png' : 'tray-inactive.png';
    const newIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
    if (!newIcon.isEmpty()) tray.setImage(newIcon);
  } catch {}
}

// ─── Window Management ───────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 570,
    minWidth: 800,
    minHeight: 520,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    showWindow();
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      if (runInBackground) {
        // Minimize to tray instead of closing
        e.preventDefault();
        mainWindow.hide();
        if (tray && !mainWindow._trayHinted) {
          mainWindow._trayHinted = true;
          tray.setToolTip('Groove is running in the background. Click tray icon to reopen.');
        }
      }
    }
  });
}

function getWindowPosition() {
  if (!mainWindow) return null;

  const trayBounds = tray ? tray.getBounds() : null;
  // If tray bounds are invalid or zero (common on Linux desktop environments)
  if (!trayBounds || (trayBounds.x === 0 && trayBounds.y === 0 && trayBounds.width === 0)) {
    return null; // Signals center()
  }

  const windowBounds = mainWindow.getBounds();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  // Flip above tray if not enough room below
  if (y + windowBounds.height > screenHeight) {
    y = trayBounds.y - windowBounds.height - 4;
  }
  if (x + windowBounds.width > screenWidth) x = screenWidth - windowBounds.width - 12;
  if (x < 12) x = 12;
  if (y < 12) y = 12;

  return { x, y };
}

function showWindow() {
  if (!mainWindow) return;
  const position = getWindowPosition();
  if (position) {
    mainWindow.setPosition(position.x, position.y, false);
  } else {
    mainWindow.center();
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// ─── Linux Autostart ─────────────────────────────────────
const autostartDir = path.join(os.homedir(), '.config', 'autostart');
const autostartFile = path.join(autostartDir, 'groove.desktop');

function getLinuxAutostart() {
  return fs.existsSync(autostartFile);
}

function setLinuxAutostart(enable) {
  try {
    if (enable) {
      if (!fs.existsSync(autostartDir)) fs.mkdirSync(autostartDir, { recursive: true });
      fs.writeFileSync(autostartFile, `[Desktop Entry]
Type=Application
Version=1.0
Name=Groove Companion
Comment=Groove Code Anywhere Desktop Companion
Exec="${process.execPath}" "${path.resolve(__dirname, 'main.js')}"
Icon=${path.join(__dirname, 'assets', 'icon.png')}
Terminal=false
Categories=Development;
`, 'utf8');
    } else {
      if (fs.existsSync(autostartFile)) fs.unlinkSync(autostartFile);
    }
    return true;
  } catch (err) {
    console.error('Failed to set autostart:', err);
    return false;
  }
}

// ─── Settings Persistence ────────────────────────────────
const settingsFile = path.join(os.homedir(), '.groove-companion-settings.json');

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    const s = JSON.parse(raw);
    if (typeof s.runInBackground === 'boolean') runInBackground = s.runInBackground;
    if (typeof s.serverPort === 'number') serverPort = s.serverPort;
    if (typeof s.workerHostUrl === 'string') workerHostUrl = s.workerHostUrl;
    if (typeof s.workerAutoConnect === 'boolean') workerAutoConnect = s.workerAutoConnect;
  } catch {}
}

function saveSettings(patch = {}) {
  try {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    const merged = { ...current, ...patch };
    fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2), 'utf8');
  } catch {}
}

// ─── IPC Handlers ────────────────────────────────────────

// Host mode
ipcMain.handle('get-server-status', () => ({
  running: isServerRunning,
  port: serverPort,
  networks: getNetworkInterfaces()
}));
ipcMain.handle('start-server', (_e, port) => startServer(port || serverPort));
ipcMain.handle('stop-server', () => stopServer());
ipcMain.handle('restart-server', (_e, port) => {
  stopServer();
  return new Promise(resolve => setTimeout(() => resolve(startServer(port || serverPort)), 600));
});
ipcMain.handle('get-network-info', () => getNetworkInterfaces());

// Worker mode
ipcMain.handle('get-worker-status', () => workerStatus);
ipcMain.handle('connect-worker', (_e, hostUrl) => {
  workerAutoConnect = true;
  workerHostUrl = hostUrl;
  saveSettings({ workerHostUrl, workerAutoConnect });
  connectWorker(hostUrl);
  return { ok: true };
});
ipcMain.handle('disconnect-worker', () => {
  disconnectWorker();
  saveSettings({ workerAutoConnect: false });
  return { ok: true };
});

// Settings
ipcMain.handle('get-settings', () => ({
  runInBackground,
  serverPort,
  workerHostUrl,
  workerAutoConnect
}));

ipcMain.handle('set-run-in-background', (_e, val) => {
  runInBackground = !!val;
  saveSettings({ runInBackground });
  return true;
});

ipcMain.handle('get-autostart', () => {
  if (process.platform === 'linux') return getLinuxAutostart();
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('set-autostart', (_e, enable) => {
  if (process.platform === 'linux') return setLinuxAutostart(enable);
  app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: true });
  return true;
});

// Misc
ipcMain.handle('open-browser', (_e, url) => { if (url) shell.openExternal(url); return true; });
ipcMain.handle('hide-window', () => mainWindow && mainWindow.hide());
ipcMain.handle('close-window', () => {
  if (mainWindow) {
    if (runInBackground) {
      mainWindow.hide();
    } else {
      mainWindow.close();
    }
  }
  return true;
});
ipcMain.handle('generate-qr', async (_e, text) => {
  try {
    return await QRCode.toDataURL(text, { margin: 1, color: { dark: '#000000', light: '#ffffff' }, width: 280 });
  } catch { return null; }
});

// ─── App Lifecycle ───────────────────────────────────────
app.whenReady().then(() => {
  loadSettings();
  createTray();
  createWindow();
  startServer(serverPort);

  // Auto-connect worker if configured
  if (workerAutoConnect && workerHostUrl) {
    setTimeout(() => connectWorker(workerHostUrl), 2000);
  }
});

app.on('window-all-closed', (e) => {
  // Never quit from window close — stay in tray
  e.preventDefault();
});

app.on('before-quit', () => {
  autoRestart = false;
  if (serverProcess) serverProcess.kill();
  if (workerWs) workerWs.terminate();
  if (localWorkerWs) localWorkerWs.terminate();
});
