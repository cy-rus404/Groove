const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const QRCode = require('qrcode');

// Linux sandbox compatibility
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

let tray = null;
let mainWindow = null;
let serverProcess = null;
let serverPort = 9000;
let isServerRunning = false;
let autoRestart = true;

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

function startServer(port = serverPort) {
  if (serverProcess) {
    return { success: true, port: serverPort, running: true };
  }

  serverPort = port;
  autoRestart = true;
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

    if (autoRestart) {
      console.log('[Groove Server] Restarting in 2s...');
      setTimeout(() => startServer(serverPort), 2000);
    }
  });

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

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-active.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // Fallback if image not found
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Groove — Code Anywhere Companion');

  tray.on('click', () => {
    toggleWindow();
  });

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const networks = getNetworkInterfaces();
  const primaryUrl = networks.tailscale || networks.lan || networks.localhost;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isServerRunning ? `🟢 Groove Active (Port ${serverPort})` : '🔴 Groove Server Stopped',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '📱 Show Mobile Pairing & Info',
      click: () => showWindow()
    },
    {
      label: '🌐 Open in Browser',
      enabled: isServerRunning,
      click: () => shell.openExternal(primaryUrl)
    },
    { type: 'separator' },
    {
      label: isServerRunning ? '⏹️ Stop Server' : '▶️ Start Server',
      click: () => (isServerRunning ? stopServer() : startServer(serverPort))
    },
    {
      label: '🔄 Restart Server',
      enabled: isServerRunning,
      click: () => {
        stopServer();
        setTimeout(() => startServer(serverPort), 500);
      }
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
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 590,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('blur', () => {
    if (!mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function getWindowPosition() {
  const windowBounds = mainWindow.getBounds();
  const trayBounds = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };

  // Center horizontally or near tray icon
  let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  // If tray is at bottom (Windows / some Linux)
  const primaryDisplay = require('electron').screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  if (x + windowBounds.width > screenWidth) {
    x = screenWidth - windowBounds.width - 12;
  }
  if (x < 12) x = 12;

  if (y + windowBounds.height > screenHeight) {
    y = trayBounds.y - windowBounds.height - 4;
  }
  if (y < 12) y = 12;

  return { x, y };
}

function showWindow() {
  if (!mainWindow) return;
  const position = getWindowPosition();
  mainWindow.setPosition(position.x, position.y, false);
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

// ─── Linux Autostart Helpers ──────────────────────────────
const autostartDir = path.join(os.homedir(), '.config', 'autostart');
const autostartDesktopFile = path.join(autostartDir, 'groove.desktop');

function getLinuxAutostart() {
  return fs.existsSync(autostartDesktopFile);
}

function setLinuxAutostart(enable) {
  try {
    if (enable) {
      if (!fs.existsSync(autostartDir)) {
        fs.mkdirSync(autostartDir, { recursive: true });
      }
      const desktopContent = `[Desktop Entry]
Type=Application
Version=1.0
Name=Groove Companion
Comment=Groove Code Anywhere Desktop Companion
Exec="${process.execPath}" "${path.resolve(__dirname, 'main.js')}"
Icon=${path.join(__dirname, 'assets', 'icon.png')}
Terminal=false
Categories=Development;
`;
      fs.writeFileSync(autostartDesktopFile, desktopContent, 'utf8');
    } else {
      if (fs.existsSync(autostartDesktopFile)) {
        fs.unlinkSync(autostartDesktopFile);
      }
    }
    return true;
  } catch (err) {
    console.error('Failed to set Linux autostart:', err);
    return false;
  }
}

// ─── IPC Handlers ─────────────────────────────────────────
ipcMain.handle('get-server-status', () => ({
  running: isServerRunning,
  port: serverPort,
  networks: getNetworkInterfaces()
}));

ipcMain.handle('start-server', (_e, port) => startServer(port || serverPort));
ipcMain.handle('stop-server', () => stopServer());
ipcMain.handle('restart-server', (_e, port) => {
  stopServer();
  return new Promise((resolve) => {
    setTimeout(() => resolve(startServer(port || serverPort)), 600);
  });
});

ipcMain.handle('get-network-info', () => getNetworkInterfaces());

ipcMain.handle('get-autostart', () => {
  if (process.platform === 'linux') {
    return getLinuxAutostart();
  }
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});

ipcMain.handle('set-autostart', (_e, enable) => {
  if (process.platform === 'linux') {
    return setLinuxAutostart(enable);
  }
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: true
  });
  return true;
});

ipcMain.handle('open-browser', (_e, url) => {
  if (url) shell.openExternal(url);
  return true;
});

ipcMain.handle('generate-qr', async (_e, text) => {
  try {
    return await QRCode.toDataURL(text, {
      margin: 1,
      color: {
        dark: '#000000',
        light: '#ffffff'
      },
      width: 160
    });
  } catch (err) {
    console.error('QR code generation failed:', err);
    return null;
  }
});

// App Lifecycle
app.whenReady().then(() => {
  createTray();
  createWindow();
  startServer();
});

app.on('window-all-closed', (e) => {
  // Do not quit when windows close; keep running in tray
  e.preventDefault();
});

app.on('before-quit', () => {
  autoRestart = false;
  if (serverProcess) serverProcess.kill();
});
