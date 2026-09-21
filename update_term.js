const fs = require('fs');
let content = fs.readFileSync('public/js/app.js', 'utf8');

const termStart = content.indexOf('// ─── Terminal ────────────────────────────────────────────');
const termEnd = content.indexOf('// ─── Boot ────────────────────────────────────────────────');

if (termStart === -1 || termEnd === -1) {
  console.error("Could not find terminal section markers");
  process.exit(1);
}

const newTermCode = `// ─── Terminal ────────────────────────────────────────────
let termSessions = [];
let activeTermId = null;
let termCounter = 0;
let tailscaleIP = null;

// Fetch Tailscale IP once on load
fetch('/api/tailscale-ip').then(r => r.json()).then(d => { tailscaleIP = d.ip; }).catch(() => {});

// Detect dev server URLs in terminal output
function checkTermOutputForDevServer(str) {
  if (!str) return;
  const match = str.match(/(http:\\/\\/localhost:\\d+)/);
  if (match) {
    let url = match[1];
    if (tailscaleIP) {
      url = url.replace('localhost', tailscaleIP);
    }
    showToast(\`<a href="\${url}" target="_blank" style="color:white;text-decoration:underline;">Dev server running at \${url}</a>\`);
  }
}

function getActiveSession() {
  return termSessions.find(s => s.id === activeTermId);
}

function updateTermUI() {
  const session = getActiveSession();
  const btn = $('termKillBtn');
  if (btn) {
    const isRunning = session ? session.processRunning : false;
    btn.disabled = !isRunning;
    btn.style.opacity = isRunning ? '1' : '0.5';
    btn.style.cursor = isRunning ? 'pointer' : 'not-allowed';
  }
}

function renderTermTabs() {
  const tabs = $('termTabs');
  if (!tabs) return;
  tabs.innerHTML = termSessions.map((s, i) => \`
    <div class="panel-tab \${s.id === activeTermId ? 'active' : ''}" style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:0 8px;" onclick="switchTerm(\${s.id})">
      <span>term \${i + 1}</span>
      <span style="font-size:10px;opacity:0.6;" onclick="event.stopPropagation(); closeTerm(\${s.id})" title="Close">✕</span>
    </div>
  \`).join('');
}

function switchTerm(id) {
  activeTermId = id;
  termSessions.forEach(s => {
    if (s.container) {
      if (s.id === id) {
        s.container.style.display = 'block';
        if (s.fitAddon) setTimeout(() => s.fitAddon.fit(), 50);
        if (s.term) s.term.focus();
      } else {
        s.container.style.display = 'none';
      }
    }
  });
  renderTermTabs();
  updateTermUI();
}

function addTerm() {
  const id = ++termCounter;
  const session = { id, ready: false, processRunning: false, term: null, socket: null, fitAddon: null, container: null };
  termSessions.push(session);
  
  const container = document.createElement('div');
  container.className = 'term-instance';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.padding = '4px';
  container.style.boxSizing = 'border-box';
  $('termContainers').appendChild(container);
  session.container = container;
  
  try {
    const initialFontSize = isMobile() ? (window.innerWidth < 380 ? 10 : 11) : 13;
    const t = new Terminal({
      theme: {
        background: '#0d0d0d', foreground: '#e2e2e2', cursor: '#3fb950',
        black: '#0d0d0d', red: '#f85149', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#e2e2e2',
        brightBlack: '#555', brightGreen: '#56d364', brightBlue: '#79c0ff',
        brightRed: '#ff7b72', brightYellow: '#e3b341', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
      },
      fontFamily: "'JetBrains Mono', monospace", fontSize: initialFontSize,
      cursorBlink: true, cursorStyle: 'block', disableStdin: false
    });
    const fit = new FitAddon.FitAddon();
    t.loadAddon(fit);
    t.open(container);
    
    session.term = t;
    session.fitAddon = fit;
    
    t.onData(data => {
      if (session.socket && session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify({ type: 'input', data }));
      }
    });
    
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = \`\${proto}://\${location.host}/terminal?repoPath=\${encodeURIComponent(REPO || '')}\`;
    const ws = new WebSocket(url);
    session.socket = ws;
    
    ws.onopen = () => {
      fit.fit();
      t.write('\\r\\n\\x1b[32m# groove terminal\\x1b[0m\\r\\n');
      session.ready = true;
      updateTermUI();
    };
    
    ws.onmessage = e => {
      if (typeof e.data === 'string' && e.data.startsWith('GROOVE_CTRL_MSG:')) {
        try {
          const msg = JSON.parse(e.data.substring(16));
          if (msg.type === 'processStatus') {
            session.processRunning = msg.hasChildren;
            if (activeTermId === id) updateTermUI();
          }
        } catch (err) {}
        return;
      }
      t.write(e.data);
      checkTermOutputForDevServer(e.data);
    };
    
    ws.onclose = () => {
      t.write('\\r\\n\\x1b[33m[disconnected]\\x1b[0m\\r\\n');
      session.ready = false;
      session.processRunning = false;
      if (activeTermId === id) updateTermUI();
    };
    
    ws.onerror = () => {
      t.write('\\r\\n\\x1b[31m[connection error]\\x1b[0m\\r\\n');
    };
  } catch (err) {
    console.error('Failed to init terminal:', err);
  }
  
  switchTerm(id);
}

function closeTerm(id) {
  const idx = termSessions.findIndex(s => s.id === id);
  if (idx === -1) return;
  const session = termSessions[idx];
  
  if (session.socket) {
    session.socket.onclose = null; // prevent disconnected message
    session.socket.close();
  }
  if (session.term) session.term.dispose();
  if (session.container && session.container.parentNode) {
    session.container.parentNode.removeChild(session.container);
  }
  
  termSessions.splice(idx, 1);
  
  if (termSessions.length === 0) {
    // No more tabs, close the panel
    if (!isMobile()) toggleTerm(false);
  } else if (activeTermId === id) {
    // Switch to adjacent tab
    const nextTab = termSessions[Math.min(idx, termSessions.length - 1)];
    switchTerm(nextTab.id);
  } else {
    renderTermTabs();
  }
}

function initTerm() {
  if (termSessions.length === 0) {
    addTerm();
  }
}

function fitTerm() {
  termSessions.forEach(s => {
    if (s.fitAddon && s.container.style.display !== 'none') {
      try { s.fitAddon.fit(); } catch (e) {}
    }
  });
}

function sendResize() {
  termSessions.forEach(s => {
    if (s.socket && s.socket.readyState === WebSocket.OPEN && s.term) {
      s.socket.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
    }
  });
}

function clearTerm() {
  const s = getActiveSession();
  if (!s) return;
  if (s.socket && s.socket.readyState === WebSocket.OPEN) {
    s.socket.send(JSON.stringify({ type: 'input', data: '\\x0C' }));
  } else if (s.term) {
    s.term.clear();
  }
  if (s.term) s.term.focus();
}

function killTerm() {
  const s = getActiveSession();
  if (!s) return;
  if (s.socket && s.socket.readyState === WebSocket.OPEN) {
    s.socket.send(JSON.stringify({ type: 'input', data: '\\x03' }));
  }
}

function toggleTerm(forceState) {
  if (isMobile()) {
    mobileTab('files');
    return;
  }
  const panel = $('termPanel');
  let nowHidden;
  if (forceState !== undefined) {
    nowHidden = !forceState;
    panel.classList.toggle('hidden', nowHidden);
  } else {
    nowHidden = panel.classList.toggle('hidden');
  }
  if ($('termToggleBtn')) $('termToggleBtn').style.color = nowHidden ? '' : 'var(--green)';
  localStorage.setItem('groove_term_open', nowHidden ? '0' : '1');
  if (!nowHidden) {
    initTerm();
    setTimeout(fitTerm, 50);
    setTimeout(fitTerm, 180);
  }
}

`;

const updatedContent = content.substring(0, termStart) + newTermCode + content.substring(termEnd);
fs.writeFileSync('public/js/app.js', updatedContent);
console.log("Updated app.js successfully!");
