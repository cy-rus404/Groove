let currentStatus = {
  running: false,
  port: 9000,
  networks: { localhost: 'http://localhost:9000', lan: null, tailscale: null, all: [] }
};

const $ = (id) => document.getElementById(id);

async function init() {
  // Load autostart setting
  try {
    const isAutostart = await window.grooveDesktop.getAutostart();
    $('autostartToggle').checked = !!isAutostart;
  } catch (e) {}

  // Load server status
  const status = await window.grooveDesktop.getServerStatus();
  updateUI(status);

  // Listen for realtime changes
  window.grooveDesktop.onStatusChange((newStatus) => {
    updateUI(newStatus);
  });

  // Setup Event Listeners
  $('autostartToggle').addEventListener('change', async (e) => {
    await window.grooveDesktop.setAutostart(e.target.checked);
    showToast(e.target.checked ? 'Autostart enabled' : 'Autostart disabled');
  });

  $('savePortBtn').addEventListener('click', async () => {
    const port = parseInt($('portInput').value, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      showToast('Invalid port (1024 - 65535)', true);
      return;
    }
    showToast(`Restarting on port ${port}...`);
    await window.grooveDesktop.restartServer(port);
  });

  $('toggleServerBtn').addEventListener('click', async () => {
    if (currentStatus.running) {
      await window.grooveDesktop.stopServer();
    } else {
      const port = parseInt($('portInput').value, 10) || 9000;
      await window.grooveDesktop.startServer(port);
    }
  });

  $('openBrowserBtn').addEventListener('click', () => {
    const url = getPrimaryUrl();
    if (url) window.grooveDesktop.openBrowser(url);
  });

  $('networkSelect').addEventListener('change', (e) => {
    updateQRCode(e.target.value);
  });
}

function updateUI(status) {
  currentStatus = status;

  // Update Status Badge
  const badge = $('statusBadge');
  const text = $('statusText');
  const toggleBtn = $('toggleServerBtn');
  const openBtn = $('openBrowserBtn');

  if (status.running) {
    badge.className = 'status-badge active';
    text.textContent = `Port ${status.port}`;
    toggleBtn.textContent = 'Stop Server';
    toggleBtn.style.color = 'var(--red)';
    openBtn.disabled = false;
    openBtn.style.opacity = '1';
  } else {
    badge.className = 'status-badge stopped';
    text.textContent = 'Stopped';
    toggleBtn.textContent = 'Start Server';
    toggleBtn.style.color = 'var(--green-bright)';
    openBtn.disabled = true;
    openBtn.style.opacity = '0.5';
  }

  $('portInput').value = status.port;

  // Render Network URLs
  renderNetworks(status.networks);
}

function renderNetworks(networks) {
  const list = $('urlsList');
  const select = $('networkSelect');

  list.innerHTML = '';
  select.innerHTML = '';

  const available = [];

  if (networks.tailscale) {
    available.push({ type: 'tailscale', name: 'Tailscale VPN', url: networks.tailscale });
  }
  if (networks.lan) {
    available.push({ type: 'wifi', name: 'Local Wi-Fi / LAN', url: networks.lan });
  }
  available.push({ type: 'local', name: 'Localhost', url: networks.localhost });

  available.forEach((item, index) => {
    // List item
    const div = document.createElement('div');
    div.className = 'url-item';
    div.innerHTML = `
      <div class="url-label-group">
        <span class="url-tag ${item.type}">${item.type}</span>
        <span class="url-text" title="${item.url}">${item.url}</span>
      </div>
      <button class="url-copy-btn" onclick="copyUrl('${item.url}')">copy</button>
    `;
    list.appendChild(div);

    // Dropdown option for QR
    const opt = document.createElement('option');
    opt.value = item.url;
    opt.textContent = `${item.name} (${item.url})`;
    select.appendChild(opt);
  });

  // Update QR Code with the best available network (prefer Tailscale/LAN over localhost for mobile)
  const defaultUrl = available[0] ? available[0].url : networks.localhost;
  select.value = defaultUrl;
  updateQRCode(defaultUrl);
}

async function updateQRCode(url) {
  const qrImg = $('qrImage');
  const qrLoading = $('qrLoading');

  if (!url) {
    qrImg.style.display = 'none';
    qrLoading.style.display = 'block';
    qrLoading.textContent = 'No network';
    return;
  }

  qrLoading.style.display = 'block';
  qrLoading.textContent = 'Generating...';
  qrImg.style.display = 'none';

  try {
    const dataUrl = await window.grooveDesktop.generateQR(url);
    if (dataUrl) {
      qrImg.src = dataUrl;
      qrImg.style.display = 'block';
      qrLoading.style.display = 'none';
    }
  } catch (e) {
    qrLoading.textContent = 'Failed';
  }
}

function getPrimaryUrl() {
  return currentStatus.networks.tailscale || currentStatus.networks.lan || currentStatus.networks.localhost;
}

function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast(`Copied: ${url}`);
  }).catch(() => {
    showToast('Failed to copy', true);
  });
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.style.background = isError ? 'var(--red)' : '#1f6feb';
  t.classList.remove('hidden');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('hidden');
  }, 2200);
}

window.addEventListener('DOMContentLoaded', init);
