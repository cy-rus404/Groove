let currentHostStatus = {
  running: false,
  port: 9000,
  networks: { localhost: 'http://localhost:9000', lan: null, tailscale: null, all: [] }
};

let currentWorkerStatus = {
  connected: false,
  hostUrl: '',
  error: null
};

let currentActiveView = 'dashboard';
let currentSelectedNetworkUrl = '';

const $ = (id) => document.getElementById(id);

// ─── Initialization ──────────────────────────────────────
async function init() {
  // Load Settings
  try {
    const settings = await window.grooveDesktop.getSettings();
    if (settings) {
      if (typeof settings.runInBackground === 'boolean') {
        $('settingRunInBgToggle').checked = settings.runInBackground;
      }
      if (settings.serverPort) {
        $('settingPortInput').value = settings.serverPort;
      }
      if (settings.workerHostUrl) {
        $('workerHostInput').value = settings.workerHostUrl;
      }
    }
  } catch (e) {}

  try {
    const isAutostart = await window.grooveDesktop.getAutostart();
    $('settingAutostartToggle').checked = !!isAutostart;
  } catch (e) {}

  // Set Local Device Hostname in Worker Mode
  try {
    const hostname = window.location.hostname || 'Local Client';
    $('workerHostnameDisplay').textContent = `Device: ${hostname === 'localhost' ? 'Local PC' : hostname}`;
  } catch {}

  // Worker Host Input - Enter to connect
  $('workerHostInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doConnectWorker();
  });

  // Fetch initial states
  const hostStatus = await window.grooveDesktop.getServerStatus();
  updateHostUI(hostStatus);

  const workerStatus = await window.grooveDesktop.getWorkerStatus();
  updateWorkerUI(workerStatus);

  // Real-time IPC listeners
  window.grooveDesktop.onStatusChange((newStatus) => {
    updateHostUI(newStatus);
  });

  window.grooveDesktop.onWorkerStatusChange((newStatus) => {
    updateWorkerUI(newStatus);
  });
}

// ─── View Navigation ─────────────────────────────────────
function switchView(viewName) {
  currentActiveView = viewName;

  // Update Sidebar Active state
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Update Main Panels
  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.add('hidden');
  });

  const targetPanel = $(`view-${viewName}`);
  if (targetPanel) targetPanel.classList.remove('hidden');

  // Update Titlebar Header
  const titles = {
    dashboard: 'Dashboard',
    networks: 'Networks & QR',
    worker: 'Worker Mode',
    settings: 'Settings'
  };

  $('viewHeaderTitle').textContent = titles[viewName] || 'Companion';
}

// ─── Host UI Updates ─────────────────────────────────────
function updateHostUI(status) {
  currentHostStatus = status;

  const heroCard = $('heroCard');
  const heroTitle = $('heroStatusText');
  const heroSub = $('heroSubText');
  const heroUrl = $('heroPrimaryUrl');
  const dashboardOpen = $('dashboardOpenBtn');
  const dashboardToggle = $('dashboardToggleBtn');
  const headerBadge = $('viewHeaderBadge');
  const footerDesc = $('footerStatusDesc');

  const primaryUrl = getPrimaryUrl();

  if (status.running) {
    if (heroCard) heroCard.classList.remove('stopped');
    if (heroTitle) heroTitle.textContent = 'Groove Server is Live';
    if (heroSub) heroSub.textContent = `Listening on port ${status.port} across active network interfaces`;
    if (heroUrl) heroUrl.value = primaryUrl;
    if (dashboardOpen) dashboardOpen.disabled = false;
    if (dashboardToggle) {
      dashboardToggle.textContent = 'Stop Server';
      dashboardToggle.className = 'btn-hero-danger';
    }

    if ($('sidebarHostBadge')) {
      $('sidebarHostBadge').textContent = `Active :${status.port}`;
      $('sidebarHostBadge').className = 'host-status-badge';
    }
    if (footerDesc) footerDesc.textContent = 'Ready for connections';
  } else {
    if (heroCard) heroCard.classList.add('stopped');
    if (heroTitle) heroTitle.textContent = 'Groove Server Stopped';
    if (heroSub) heroSub.textContent = 'Click Start Server to resume serving projects';
    if (heroUrl) heroUrl.value = 'Offline';
    if (dashboardOpen) dashboardOpen.disabled = true;
    if (dashboardToggle) {
      dashboardToggle.textContent = 'Start Server';
      dashboardToggle.className = 'btn-hero-primary';
    }

    if ($('sidebarHostBadge')) {
      $('sidebarHostBadge').textContent = 'Stopped';
      $('sidebarHostBadge').className = 'host-status-badge stopped';
    }
    if (footerDesc) footerDesc.textContent = 'Server Offline';
  }

  if ($('settingPortInput')) $('settingPortInput').value = status.port;

  // Render network listings & QR
  renderNetworkViews(status.networks);
}

function renderNetworkViews(networks) {
  const dashList = $('dashboardUrlsList');
  const fullList = $('fullUrlsList');
  const select = $('fullNetworkSelect');

  dashList.innerHTML = '';
  fullList.innerHTML = '';
  select.innerHTML = '';

  const available = [];

  if (networks.tailscale) {
    available.push({ type: 'tailscale', name: 'Tailscale VPN', url: networks.tailscale, desc: 'Encrypted mesh access from any linked machine' });
  }
  if (networks.lan) {
    available.push({ type: 'wifi', name: 'Wi-Fi / LAN', url: networks.lan, desc: 'Local network access on the same router/AP' });
  }
  available.push({ type: 'local', name: 'Localhost', url: networks.localhost, desc: 'Local loopback interface only' });

  // 1. Render Dashboard Quick URLs
  available.forEach(item => {
    const row = document.createElement('div');
    row.className = 'url-row';
    row.innerHTML = `
      <div class="url-left">
        <span class="tag-badge ${item.type}">${item.type}</span>
        <span class="url-text-display" title="${item.url}">${item.url}</span>
      </div>
      <button class="copy-mini-btn" onclick="copyUrlText('${item.url}')">copy</button>
    `;
    dashList.appendChild(row);
  });

  // 2. Render Full Networks View
  available.forEach(item => {
    const card = document.createElement('div');
    card.className = 'url-row';
    card.style.padding = '8px 10px';
    card.innerHTML = `
      <div class="url-left" style="gap:10px;">
        <span class="tag-badge ${item.type}">${item.type}</span>
        <div style="display:flex;flex-direction:column;overflow:hidden;">
          <span class="url-text-display" style="font-weight:600;" title="${item.url}">${item.url}</span>
          <span style="font-size:10px;color:var(--muted);">${item.desc}</span>
        </div>
      </div>
      <button class="copy-mini-btn" style="padding:4px 8px;" onclick="copyUrlText('${item.url}')">Copy</button>
    `;
    fullList.appendChild(card);

    // Dropdown Option for QR
    const opt = document.createElement('option');
    opt.value = item.url;
    opt.textContent = `${item.name} — ${item.url}`;
    select.appendChild(opt);
  });

  // Default Selected URL for QR
  const defaultUrl = available[0] ? available[0].url : networks.localhost;
  currentSelectedNetworkUrl = defaultUrl;
  select.value = defaultUrl;
  updateQRCodes(defaultUrl);
}

async function updateQRCodes(url) {
  const dashImg = $('dashboardQrImg');
  const dashLoad = $('dashboardQrLoading');
  const fullImg = $('fullQrImg');
  const fullLoad = $('fullQrLoading');

  if (!url) {
    if (dashImg) dashImg.style.display = 'none';
    if (fullImg) fullImg.style.display = 'none';
    return;
  }

  if (dashLoad) dashLoad.style.display = 'flex';
  if (fullLoad) fullLoad.style.display = 'flex';
  if (dashImg) dashImg.style.display = 'none';
  if (fullImg) fullImg.style.display = 'none';

  try {
    const dataUrl = await window.grooveDesktop.generateQR(url);
    if (dataUrl) {
      if (dashImg) { dashImg.src = dataUrl; dashImg.style.display = 'block'; }
      if (fullImg) { fullImg.src = dataUrl; fullImg.style.display = 'block'; }
      if (dashLoad) dashLoad.style.display = 'none';
      if (fullLoad) fullLoad.style.display = 'none';
    }
  } catch (e) {
    if (dashLoad) dashLoad.innerHTML = '<span style="font-size:9px;color:var(--red);">Failed</span>';
    if (fullLoad) fullLoad.innerHTML = '<span style="font-size:9px;color:var(--red);">Failed</span>';
  }
}

function onNetworkSelectChange(url) {
  currentSelectedNetworkUrl = url;
  updateQRCodes(url);
}

// ─── Worker UI Updates ───────────────────────────────────
function updateWorkerUI(status) {
  currentWorkerStatus = status;

  const card = $('workerHeroCard');
  const title = $('workerHeroStatus');
  const connectBtn = $('btnConnectWorker');
  const disconnectBtn = $('btnDisconnectWorker');
  const input = $('workerHostInput');

  if (status.connected) {
    card.classList.add('connected');
    title.textContent = `Connected: ${status.hostUrl}`;
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
    input.disabled = true;
  } else if (status.error) {
    card.classList.remove('connected');
    title.textContent = `Error: ${status.error}`;
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    input.disabled = false;
  } else {
    card.classList.remove('connected');
    title.textContent = 'Worker: Standby';
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    input.disabled = false;
  }
}

async function doConnectWorker() {
  const url = $('workerHostInput').value.trim();
  if (!url) {
    showToast('Please enter a valid Groove Host URL', true);
    return;
  }
  showToast(`Connecting to ${url}...`);
  $('workerHeroStatus').textContent = 'Connecting...';
  await window.grooveDesktop.connectWorker(url);
}

async function doDisconnectWorker() {
  showToast('Worker disconnected');
  await window.grooveDesktop.disconnectWorker();
}

// ─── Actions & Settings ──────────────────────────────────
function getPrimaryUrl() {
  return currentHostStatus.networks.tailscale || currentHostStatus.networks.lan || currentHostStatus.networks.localhost;
}

function openPrimaryInBrowser() {
  const url = getPrimaryUrl();
  if (url) window.grooveDesktop.openBrowser(url);
}

function copyPrimaryUrl() {
  const url = getPrimaryUrl();
  if (url) copyUrlText(url);
}

async function toggleServerAction() {
  if (currentHostStatus.running) {
    await window.grooveDesktop.stopServer();
    showToast('Groove server stopped');
  } else {
    const port = parseInt($('settingPortInput').value, 10) || 9000;
    await window.grooveDesktop.startServer(port);
    showToast(`Groove server started on port ${port}`);
  }
}

async function savePortSetting() {
  const port = parseInt($('settingPortInput').value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    showToast('Invalid port number (1024 - 65535)', true);
    return;
  }
  showToast(`Restarting on port ${port}...`);
  await window.grooveDesktop.restartServer(port);
}

async function toggleRunInBg(enable) {
  await window.grooveDesktop.setRunInBackground(enable);
  showToast(enable ? 'Enabled: Minimizes to system tray on close' : 'Disabled: Closes on exit');
}

async function toggleAutostart(enable) {
  await window.grooveDesktop.setAutostart(enable);
  showToast(enable ? 'Autostart on boot enabled' : 'Autostart on boot disabled');
}

function minimizeWindow() {
  window.grooveDesktop.hideWindow();
}

function closeAppWindow() {
  window.grooveDesktop.closeWindow();
}

function copyUrlText(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Copied: ${text}`);
  }).catch(() => {
    showToast('Failed to copy', true);
  });
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isError ? 'toast error' : 'toast';
  t.classList.remove('hidden');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('hidden');
  }, 2400);
}

// Expose globals for inline DOM handlers
window.switchView = switchView;
window.openPrimaryInBrowser = openPrimaryInBrowser;
window.copyPrimaryUrl = copyPrimaryUrl;
window.copyUrlText = copyUrlText;
window.toggleServerAction = toggleServerAction;
window.onNetworkSelectChange = onNetworkSelectChange;
window.doConnectWorker = doConnectWorker;
window.doDisconnectWorker = doDisconnectWorker;
window.savePortSetting = savePortSetting;
window.toggleRunInBg = toggleRunInBg;
window.toggleAutostart = toggleAutostart;
window.minimizeWindow = minimizeWindow;
window.closeAppWindow = closeAppWindow;

window.addEventListener('DOMContentLoaded', init);
