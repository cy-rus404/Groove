
// ─── State ───────────────────────────────────────────────

let editorTabs = [];
function saveEditorTabs() {
  if (REPO) {
    localStorage.setItem('groove_editor_tabs_' + REPO, JSON.stringify(editorTabs));
  }
}

function renderEditorTabs() {
  const bar = $('editorTabsBar');
  if (!bar) return;
  if (editorTabs.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = editorTabs.map(f => {
    const name = f.split('/').pop();
    const isActive = f === activeFile;
    const isDirty = localStorage.getItem(`groove_draft_${REPO}_${f}`) ? 'dirty' : '';
    const div = document.createElement('div');
    div.textContent = name;
    const safeName = div.innerHTML;
    return `
      <div class="editor-tab ${isActive ? 'active' : ''} ${isDirty}" onclick="switchEditorTab('${esc(f)}')">
        <span>${safeName}</span>
        <span class="editor-tab-close" onclick="event.stopPropagation(); closeEditorTab('${esc(f)}')">✕</span>
      </div>
    `;
  }).join('');
}

function switchEditorTab(file) {
  if (activeFile === file) return;
  openEditor(file);
}

function closeEditorTab(file) {
  const idx = editorTabs.indexOf(file);
  if (idx === -1) return;
  
  if (file === activeFile && editorDirty) {
    if (!confirm('You have unsaved changes in this tab. Discard them?')) return;
    localStorage.removeItem(`groove_draft_${REPO}_${file}`);
  } else if (localStorage.getItem(`groove_draft_${REPO}_${file}`)) {
    if (!confirm(`Discard unsaved changes in ${file}?`)) return;
    localStorage.removeItem(`groove_draft_${REPO}_${file}`);
  }
  
  editorTabs.splice(idx, 1);
  saveEditorTabs();
  
  if (activeFile === file) {
    if (editorTabs.length > 0) {
      const nextFile = editorTabs[Math.min(idx, editorTabs.length - 1)];
      openEditor(nextFile);
    } else {
      activeFile = null;
      localStorage.removeItem('groove_active_file');
      if (typeof cmEditor !== 'undefined') cmEditor.setValue('');
      if ($('editorPanel')) $('editorPanel').classList.remove('open');
      if ($('editorEmpty')) $('editorEmpty').style.display = 'flex';
      renderEditorTabs();
    }
  } else {
    renderEditorTabs();
  }
}

function allowDrop(e) { e.preventDefault(); }
function dropFileToTabs(e) {
  e.preventDefault();
  const file = e.dataTransfer.getData('text/plain');
  if (file) openEditor(file);
}

function dragFile(e, file) {
  e.dataTransfer.setData('text/plain', file);
}


let REPO = '';
let activeFile = null;
let editorDirty = false;
let allDiffLines = [];   // full parsed diff
let fileRanges = {};     // file → { start, end } indices into allDiffLines
let currentTab = 'all';  // default tab in side menu: all files
let allTreeFiles = [];   // cached full file list
let currentAction = 'commit'; // 'commit' | 'push'
let commitsAheadCount = 0;

// ─── File Icons ──────────────────────────────────────────
function getFileIcon(filename) {
  if (!filename) return `<span class="file-icon file-icon-generic"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 1.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75V5.5L9.5 1.5H3.75zM8.5 2.5v3h3L8.5 2.5z"/></svg></span>`;

  const lower = filename.toLowerCase();
  const base = lower.split('/').pop();
  const ext = base.includes('.') ? base.split('.').pop() : '';

  // Special files
  if (base === 'package.json' || base === 'package-lock.json') {
    return `<span class="file-icon file-icon-npm" title="npm"><svg viewBox="0 0 16 16" fill="#cb3837"><path d="M1 3h14v10H1V3zm2 2v6h3V7h2v4h4V5H3z"/></svg></span>`;
  }
  if (base === 'cargo.toml' || base === 'cargo.lock') {
    return `<span class="file-icon file-icon-rust" title="Cargo"><svg viewBox="0 0 16 16" fill="#dea584"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3z"/></svg></span>`;
  }
  if (base.startsWith('.env')) {
    return `<span class="file-icon file-icon-env" title="Environment"><svg viewBox="0 0 16 16" fill="#e5c07b"><path d="M4 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4zm3 3h2v2H7V5zm0 4h2v2H7V9z"/></svg></span>`;
  }
  if (base.startsWith('.git') || base === '.gitignore') {
    return `<span class="file-icon file-icon-git" title="Git"><svg viewBox="0 0 16 16" fill="#f05032"><path d="M15.6 7.2l-6.8-6.8a1.5 1.5 0 0 0-2.1 0l-1.5 1.5 2.7 2.7a1.6 1.6 0 0 1 2 2l2.6 2.6a1.5 1.5 0 1 1-1.1 1.1l-2.5-2.5v4.5a1.5 1.5 0 1 1-1.5 0V7.9a1.6 1.6 0 0 1-.9-.9L4 9.6a1.5 1.5 0 1 1-1.1-1.1L9.7 1.7a1.5 1.5 0 0 1 2.1 0l3.8 3.8a1.5 1.5 0 0 1 0 2.1l-.03.03a1.5 1.5 0 0 1-2.07-.43z"/></svg></span>`;
  }
  if (base === 'dockerfile' || base.startsWith('docker-compose')) {
    return `<span class="file-icon file-icon-docker" title="Docker"><svg viewBox="0 0 16 16" fill="#388bfd"><path d="M1 8.5C1.8 4 6 4 8 5.5c2.5-2 7-1 7 4.5-1 3.5-5 4-8 4-4 0-6-2.5-6-5.5zM3 7h1.5v1.5H3V7zm2.5 0H7v1.5H5.5V7zm2.5 0h1.5v1.5H8V7zm2.5 0H12v1.5h-1.5V7z"/></svg></span>`;
  }
  if (base === 'license' || base.startsWith('license.')) {
    return `<span class="file-icon file-icon-license" title="License"><svg viewBox="0 0 16 16" fill="#d29922"><path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11zM4 5h8v1H4V5zm0 2.5h8v1H4v-1zm0 2.5h5v1H4v-1z"/></svg></span>`;
  }

  // Extensions
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return `<span class="file-icon file-icon-js" title="JavaScript"><span class="badge-icon" style="background:#f7df1e;color:#000;">JS</span></span>`;
    case 'ts':
    case 'mts':
    case 'cts':
      return `<span class="file-icon file-icon-ts" title="TypeScript"><span class="badge-icon" style="background:#3178c6;color:#fff;">TS</span></span>`;
    case 'jsx':
      return `<span class="file-icon file-icon-jsx" title="React JSX"><span class="badge-icon" style="background:#61dafb;color:#000;">JSX</span></span>`;
    case 'tsx':
      return `<span class="file-icon file-icon-tsx" title="React TSX"><span class="badge-icon" style="background:#235a97;color:#61dafb;">TSX</span></span>`;
    case 'html':
    case 'htm':
      return `<span class="file-icon file-icon-html" title="HTML"><svg viewBox="0 0 16 16" fill="#e34f26"><path d="M2.5 1.5l1 12 4.5 1.5 4.5-1.5 1-12h-11zm8.7 3.3l-.1 1.2h-5l.1 1.5h4.7l-.4 4.5-2.9 1-2.9-1-.2-2h1.3l.1 1 1.7.5 1.7-.5.2-2.1H4.6L4.2 3.8h7.2l-.2 1z"/></svg></span>`;
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return `<span class="file-icon file-icon-css" title="CSS"><svg viewBox="0 0 16 16" fill="${ext.startsWith('s') ? '#cd6799' : '#264de4'}"><path d="M2.5 1.5l1 12 4.5 1.5 4.5-1.5 1-12h-11zm8.7 3.3h-7l.2 2.3h5l-.3 3.3-2.6.9-2.6-.9-.1-1.3h-1.3l.2 2.3 3.8 1.3 3.8-1.3.6-6.6z"/></svg></span>`;
    case 'json':
    case 'json5':
    case 'jsonc':
      return `<span class="file-icon file-icon-json" title="JSON"><span class="badge-icon" style="background:#cbcb41;color:#111;">{}</span></span>`;
    case 'yaml':
    case 'yml':
    case 'toml':
      return `<span class="file-icon file-icon-yaml" title="YAML"><span class="badge-icon" style="background:#cb171e;color:#fff;">YM</span></span>`;
    case 'py':
    case 'pyw':
    case 'ipynb':
      return `<span class="file-icon file-icon-py" title="Python"><span class="badge-icon" style="background:#3572A5;color:#ffd343;">PY</span></span>`;
    case 'rs':
      return `<span class="file-icon file-icon-rust" title="Rust"><span class="badge-icon" style="background:#dea584;color:#111;">RS</span></span>`;
    case 'go':
      return `<span class="file-icon file-icon-go" title="Go"><span class="badge-icon" style="background:#00add8;color:#fff;">GO</span></span>`;
    case 'md':
    case 'markdown':
    case 'txt':
    case 'rst':
      return `<span class="file-icon file-icon-md" title="Markdown"><svg viewBox="0 0 16 16" fill="#58a6ff"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zM3 5v6h1.5V7.5L6 9.5l1.5-2V11H9V5H7.5L6 7.2 4.5 5H3zm7.5 3h1.2V5h1.6v3h1.2l-2 3-2-3z"/></svg></span>`;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return `<span class="file-icon file-icon-sh" title="Shell"><span class="badge-icon" style="background:#3fb950;color:#000;">$_</span></span>`;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return `<span class="file-icon file-icon-img" title="Image"><svg viewBox="0 0 16 16" fill="#a371f7"><path d="M1.5 2.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11zm11 1h-11v7.3l2.8-2.8a1 1 0 0 1 1.4 0l1.8 1.8 3.3-3.3a1 1 0 0 1 1.4 0l.3.3V3.5zM5 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg></span>`;
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
      return `<span class="file-icon file-icon-c" title="C/C++"><span class="badge-icon" style="background:#659ad2;color:#fff;">C++</span></span>`;
    case 'java':
    case 'kt':
    case 'class':
      return `<span class="file-icon file-icon-java" title="Java/Kotlin"><span class="badge-icon" style="background:#b07219;color:#fff;">JV</span></span>`;
    case 'php':
      return `<span class="file-icon file-icon-php" title="PHP"><span class="badge-icon" style="background:#4F5D95;color:#fff;">PHP</span></span>`;
    case 'sql':
      return `<span class="file-icon file-icon-sql" title="SQL"><span class="badge-icon" style="background:#e38c00;color:#fff;">SQL</span></span>`;
    case 'vue':
      return `<span class="file-icon file-icon-vue" title="Vue"><span class="badge-icon" style="background:#42b883;color:#fff;">VUE</span></span>`;
    case 'svelte':
      return `<span class="file-icon file-icon-svelte" title="Svelte"><span class="badge-icon" style="background:#ff3e00;color:#fff;">SVT</span></span>`;
    default:
      return `<span class="file-icon file-icon-generic" title="${esc(base)}"><svg viewBox="0 0 16 16" fill="var(--muted)"><path d="M3.75 1.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75V5.5L9.5 1.5H3.75zM8.5 2.5v3h3L8.5 2.5z"/></svg></span>`;
  }
}

function getFolderIcon() {
  return `<span class="folder-icon"><svg viewBox="0 0 16 16" fill="#e2b340"><path d="M1.75 2.5A.75.75 0 0 0 1 3.25v9.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75v-7.5a.75.75 0 0 0-.75-.75H7.72l-1.6-1.6a.75.75 0 0 0-.53-.22H1.75z"/></svg></span>`;
}

// ─── Utilities ───────────────────────────────────────────
const $ = id => document.getElementById(id);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif', 'tiff', 'tif']);
function isImageFile(filename) {
  if (!filename) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return IMAGE_EXTS.has(ext);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showToast(msg, type = 'success') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast ' + type; }, 3000);
}

// ─── Repo scanning ───────────────────────────────────────
let currentBrowsePath = '';

async function loadRepos(search = '', dir = '') {
  try {
    let url = '/api/repos';
    if (search) url += `?search=${encodeURIComponent(search)}`;
    if (dir) url += (url.includes('?') ? '&' : '?') + `dir=${encodeURIComponent(dir)}`;

    const res = await fetch(url);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    const repos = d.repos;

    $('reposLabel').textContent = repos.length
      ? `${repos.length} project${repos.length !== 1 ? 's' : ''} found`
      : 'no projects found';

    if (!repos.length) {
      $('projectList').innerHTML = '<div style="padding:10px 0;color:var(--muted);font-size:12px">nothing found in this location…</div>';
      return;
    }

    $('projectList').innerHTML = repos.map(p => {
      const parts = p.split('/');
      const name = parts[parts.length - 1];
      const dirPath = parts.slice(0, -1).join('/') + '/';
      return `
        <div class="project-item" onclick="selectProject('${p.replace(/'/g, "\\'")}')">
          <span class="proj-sigil">▶</span>
          <span class="proj-name">${esc(name)}</span>
          <span class="proj-path">${esc(dirPath)}</span>
          <span class="proj-arrow">↵</span>
        </div>`;
    }).join('');
  } catch (e) {
    $('reposLabel').textContent = 'scan failed';
    $('projectList').innerHTML = '';
  }
}

async function searchRepos() {
  const q = $('repoSearchInput').value.trim();
  $('projectList').innerHTML = '<div class="loading-row"><span class="spinner"></span> searching...</div>';
  await loadRepos(q);
}

async function browseDir(path) {
  currentBrowsePath = path;
  $('backDirBtn').style.display = path === '/' ? 'none' : 'block';
  $('repoSearchInput').value = '';
  $('projectList').innerHTML = '<div class="loading-row"><span class="spinner"></span> browsing...</div>';

  try {
    const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error);

    const items = d.items;
    $('reposLabel').textContent = `browsing: ${path}`;

    if (!items.length) {
      $('projectList').innerHTML = '<div style="padding:10px 0;color:var(--muted);font-size:12px">folder is empty</div>';
      return;
    }

    $('projectList').innerHTML = items.map(item => {
      const isDir = item.isDirectory;
      return `
        <div class="project-item" onclick="${isDir ? `browseDir('${item.path.replace(/'/g, "\\'")}')` : `selectProject('${item.path.replace(/'/g, "\\'")}')`}">
          <span class="proj-sigil">${isDir ? '📁' : '📄'}</span>
          <span class="proj-name">${esc(item.name)}</span>
          <span class="proj-path">${isDir ? 'folder' : 'file'}</span>
          <span class="proj-arrow">${isDir ? '→' : '↵'}</span>
        </div>`;
    }).join('');
  } catch (e) {
    $('reposLabel').textContent = 'browse failed';
    $('projectList').innerHTML = '';
  }
}

function goBackDir() {
  if (!currentBrowsePath) return;
  const parts = currentBrowsePath.split('/');
  parts.pop();
  const parent = parts.join('/') || '/';
  browseDir(parent);
}

function selectProject(p) {
  $('repoPathInput').value = p;
  connectRepo();
}

function showConnect() {
  $('connectScreen').style.display = 'flex';
  $('mainLayout').style.display = 'none';
  $('repoMeta').style.display = 'none';
  $('topbarSep').style.display = 'none';
  if ($('topbarTermBtn')) $('topbarTermBtn').style.display = 'none';
  currentBrowsePath = '';
  $('backDirBtn').style.display = 'none';
  localStorage.removeItem('groove_repo');
  loadRepos();
}

async function connectRepo() {
  const p = $('repoPathInput').value.trim();
  if (!p) return;

  const prevRepo = localStorage.getItem('groove_repo');
  const isSwitchingProject = prevRepo && prevRepo !== p;

  REPO = p;
  localStorage.setItem('groove_repo', p);
  $('connectScreen').style.display = 'none';
  $('mainLayout').style.display = 'flex';
  $('repoMeta').style.display = 'flex';
  $('topbarSep').style.display = '';
  if ($('topbarTermBtn')) $('topbarTermBtn').style.display = 'inline-flex';
  $('repoMeta').innerHTML = '<span class="spinner"></span>';
  $('fileList').innerHTML = '<div class="loading-row"><span class="spinner"></span> loading...</div>';
  if ($('settingRepoPath')) {
    $('settingRepoPath').textContent = p;
    $('settingRepoPath').title = p;
  }
  $('termPanel').classList.add('hidden');

  allTreeFiles = [];

  // Restore editor tabs for this repo
  try {
    const tabs = JSON.parse(localStorage.getItem('groove_editor_tabs_' + REPO) || '[]');
    editorTabs = Array.isArray(tabs) ? tabs : [];
  } catch (e) {
    editorTabs = [];
  }

  // Restore active file
  let fileToRestore = isSwitchingProject ? null : localStorage.getItem('groove_active_file');
  if (!fileToRestore && editorTabs.length > 0) {
    fileToRestore = editorTabs[editorTabs.length - 1];
  }
  activeFile = fileToRestore || null;

  if (isSwitchingProject) {
    localStorage.removeItem('groove_active_file');
  }

  const hasFile = !!fileToRestore || editorTabs.length > 0;
  if ($('editorPanel')) {
    if (!hasFile) $('editorPanel').classList.remove('open');
  }
  if (!hasFile) {
    if ($('editorEmpty')) $('editorEmpty').style.display = 'flex';
    if ($('editorToolbar')) { $('editorToolbar').classList.add('hidden'); $('editorToolbar').style.display = 'none'; }
    if ($('editorCM')) $('editorCM').style.display = 'none';
    if ($('editorImagePreview')) $('editorImagePreview').style.display = 'none';
    if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
  }

  initMobile();
  const savedTab = localStorage.getItem('groove_active_tab') || 'all';
  switchTab(savedTab);
  await Promise.all([loadRepoInfo(), loadStatus()]);

  renderEditorTabs();

  // Restore previously opened file
  if (fileToRestore) {
    openEditor(fileToRestore);
  }

  // Restore mobile tab if on mobile
  const savedMobileTab = localStorage.getItem('groove_mobile_tab');
  if (isMobile() && savedMobileTab) {
    mobileTab(savedMobileTab);
  }

  // If switching projects, close previous terminal sessions
  if (isSwitchingProject && typeof termSessions !== 'undefined') {
    [...termSessions].forEach(s => closeTerm(s.id));
  }

  // Restore terminal panel if it was open
  if (!isMobile()) {
    const termOpen = localStorage.getItem('groove_term_open') === '1';
    toggleTerm(termOpen);
  }
}

// ─── Repo info (topbar) ──────────────────────────────────
async function loadRepoInfo() {
  try {
    const res = await fetch('/api/repo-info?repoPath=' + encodeURIComponent(REPO));
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    $('repoMeta').innerHTML = `
      <a href="${d.remote === 'Local Folder' ? '#' : esc(d.remote)}" target="${d.remote === 'Local Folder' ? '_self' : '_blank'}" class="repo-name">${esc(d.repoName)}</a>
      <div class="branch-tag">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        ${esc(d.branch)}
      </div>
      ${d.lastCommit.subject ? `<div class="commit-preview" title="${esc(d.lastCommit.subject)}">${esc(d.lastCommit.subject)} · ${esc(d.lastCommit.time)}</div>` : ''}
    `;
  } catch (e) {
    $('repoMeta').innerHTML = `<span style="color:var(--red);font-size:12px">${esc(e.message)}</span>`;
  }
}

// ─── Git status & diff ───────────────────────────────────
function parseStatus(s) {
  if (!s) return [];
  return s.split('\n').filter(Boolean).map(line => {
    // git status --short can output:
    //   "X  filename"  (1 status char + space + filename)  e.g. "M adroiterp/..."
    //   "XY filename"  (2 status chars + space + filename) e.g. " M adroiterp/..."
    //   "?? filename"  (untracked)
    // Split on the FIRST space that is followed by a non-space (the filename start)
    const m = line.match(/^([ A-Z?!]+?) (.+)$/);
    if (!m) return null;
    const xy = m[1];
    const x = xy[0], y = xy[1] || ' ';
    const code = x !== ' ' ? x : y !== ' ' ? y : '?';
    let file = m[2];
    // Git quotes filenames with special chars
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    // Renamed: "old -> new" — take the new name
    if (file.includes(' -> ')) {
      file = file.split(' -> ').pop();
      if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    }
    return { code, file };
  }).filter(Boolean);
}

function parseDiff(raw) {
  if (!raw) return [];
  const lines = [];
  let oldL = 0, newL = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      lines.push({ type: 'file-header', text: line });
    } else if (line.startsWith('@@ ')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldL = +m[1]; newL = +m[2]; }
      lines.push({ type: 'meta', text: line, o: '', n: '' });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.push({ type: 'add', text: line, o: '', n: newL++ });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lines.push({ type: 'remove', text: line, o: oldL++, n: '' });
    } else if (!line.startsWith('---') && !line.startsWith('+++') &&
               !line.startsWith('index ') && !line.startsWith('new file') &&
               !line.startsWith('deleted file') && !line.startsWith('Binary')) {
      lines.push({ type: 'neutral', text: line, o: oldL++, n: newL++ });
    }
  }
  return lines;
}

function buildFileRanges(diffLines) {
  const ranges = {};
  let current = null;
  let start = 0;
  for (let i = 0; i < diffLines.length; i++) {
    const l = diffLines[i];
    if (l.type === 'file-header') {
      if (current !== null) ranges[current].end = i - 1;
      // extract filename from "diff --git a/foo b/foo"
      const m = l.text.match(/diff --git a\/.+ b\/(.+)/);
      current = m ? m[1] : null;
      start = i;
      if (current) ranges[current] = { start, end: diffLines.length - 1 };
    }
  }
  return ranges;
}

function renderStatusFiles(files) {
  if (currentTab !== 'changes') return;

  if (!files.length) {
    $('fileList').innerHTML = `
      <div class="empty-state" style="padding:30px 14px">
        <div class="empty-icon" style="font-size:20px">✓</div>
        <div class="empty-title">clean</div>
        <div class="empty-sub">nothing to commit</div>
      </div>`;
    $('selectAllRow').style.display = 'none';
    updateCommitBar();
    return;
  }

  $('selectAllRow').style.display = '';
  // Preserve checked checkboxes
  const checkedFiles = new Set([...document.querySelectorAll('.file-chk:checked')].map(c => c.dataset.file));

  const statusClass = c => ({ M:'s-M', A:'s-A', D:'s-D', R:'s-R' }[c] || 's-Q');

  $('fileList').innerHTML = files.map(f => `
    <div class="file-entry${activeFile === f.file ? ' active' : ''}" data-file="${esc(f.file)}" onclick="selectFile(this)">
      <input type="checkbox" class="file-chk" data-file="${esc(f.file)}"
        onclick="event.stopPropagation()" onchange="updateCommitBar()" ${checkedFiles.has(f.file) ? 'checked' : ''}/>
      <span class="file-status ${statusClass(f.code)}">${f.code}</span>
      ${getFileIcon(f.file)}
      <span class="file-entry-name" title="${esc(f.file)}">${esc(f.file)}</span>
      <span class="file-edit-hint">diff</span>
    </div>`).join('');

  updateCommitBar();
}

async function loadStatus() {
  const cacheKey = `groove_status_${REPO}`;
  let hasCache = false;
  try {
    const cachedStr = localStorage.getItem(cacheKey);
    if (cachedStr) {
      const d = JSON.parse(cachedStr);
      const files = parseStatus(d.status);
      allDiffLines = parseDiff(d.diff);
      fileRanges = buildFileRanges(allDiffLines);
      commitsAheadCount = d.commitsAhead || 0;
      $('fileCount').textContent = files.length;
      renderStatusFiles(files);
      if (currentTab !== 'changes') updateCommitBar();
      hasCache = true;
    }
  } catch (e) {}

  if (!hasCache && currentTab === 'changes') {
    $('fileList').innerHTML = '<div class="loading-row"><span class="spinner"></span> checking changes...</div>';
  }

  try {
    const res = await fetch('/api/status?repoPath=' + encodeURIComponent(REPO));
    const d = await res.json();
    if (d.error) throw new Error(d.error);

    const newStr = JSON.stringify(d);
    const oldStr = localStorage.getItem(cacheKey);
    
    if (newStr !== oldStr) {
      localStorage.setItem(cacheKey, newStr);
      const files = parseStatus(d.status);
      allDiffLines = parseDiff(d.diff);
      fileRanges = buildFileRanges(allDiffLines);
      commitsAheadCount = d.commitsAhead || 0;

      $('fileCount').textContent = files.length;
      renderStatusFiles(files);
      if (currentTab !== 'changes') updateCommitBar();

      // If active diff is open, re-render diff content
      if (currentTab === 'changes' && activeFile) {
        const range = fileRanges[activeFile];
        if (range) renderDiff(allDiffLines.slice(range.start, range.end + 1), activeFile);
        else renderDiff([], activeFile);
      }
    }
  } catch (e) {
    if (!hasCache && currentTab === 'changes') {
      $('fileList').innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px">${esc(e.message)}</div>`;
    }
  }
}

function setAction(mode) {
  currentAction = mode;
  if ($('chipCommit')) $('chipCommit').classList.toggle('active', mode === 'commit');
  if ($('chipPush')) $('chipPush').classList.toggle('active', mode === 'push');
  updateCommitBar();
  if (mode === 'commit') {
    const input = $('commitMsg');
    if (input) input.focus();
  }
}

function updateCommitBar() {
  const checked = document.querySelectorAll('.file-chk:checked');
  const all = document.querySelectorAll('.file-chk');
  const btn = $('pushBtn');
  const msgInput = $('commitMsg');
  const ps1 = $('actionPs1');
  const pushCountEl = $('pushCount');

  if (pushCountEl) {
    if (commitsAheadCount > 0) {
      pushCountEl.style.display = 'inline-block';
      pushCountEl.textContent = commitsAheadCount;
    } else {
      pushCountEl.style.display = 'none';
    }
  }

  if (currentAction === 'commit') {
    if (msgInput) msgInput.disabled = false;
    if (ps1) ps1.textContent = '$';
    if (btn) btn.textContent = '✓ commit';

    if (all.length === 0) {
      if (msgInput) msgInput.placeholder = 'nothing to commit (clean)';
      if (btn) {
        btn.disabled = true;
        btn.classList.remove('ready');
      }
    } else if (checked.length === 0) {
      if (msgInput) msgInput.placeholder = 'select files to commit...';
      if (btn) {
        btn.disabled = true;
        btn.classList.remove('ready');
      }
    } else {
      if (msgInput) msgInput.placeholder = `commit message (${checked.length} file${checked.length > 1 ? 's' : ''})...`;
      if (btn) {
        btn.disabled = false;
        btn.classList.add('ready');
      }
    }
  } else if (currentAction === 'push') {
    if (msgInput) msgInput.disabled = true;
    if (ps1) ps1.textContent = '↑';
    if (btn) btn.textContent = '↑ push';

    if (commitsAheadCount > 0) {
      if (msgInput) msgInput.placeholder = `${commitsAheadCount} commit${commitsAheadCount > 1 ? 's' : ''} ready to push`;
      if (btn) {
        btn.disabled = false;
        btn.classList.add('ready');
      }
    } else {
      if (msgInput) msgInput.placeholder = 'nothing to push (up to date)';
      if (btn) {
        btn.disabled = true;
        btn.classList.remove('ready');
      }
    }
  }

  // Sync select-all checkbox state
  const selectAllChk = $('selectAllChk');
  if (selectAllChk) {
    selectAllChk.indeterminate = checked.length > 0 && checked.length < all.length;
    selectAllChk.checked = all.length > 0 && checked.length === all.length;
  }
}

function toggleSelectAll(checked) {
  document.querySelectorAll('.file-chk').forEach(chk => { chk.checked = checked; });
  updateCommitBar();
}

// ─── Diff rendering ──────────────────────────────────────
function closeDiff() {
  const panel = $('centerPanel');
  panel.classList.remove('open');
  panel.style.width = '';
  panel.style.flex = '';
  $('diffPanel').style.display = '';
  activeFile = null;
  document.querySelectorAll('.file-entry').forEach(e => e.classList.remove('active'));
  if ($('diffCmdText')) $('diffCmdText').textContent = 'git diff HEAD';
  if ($('diffFileLabel')) $('diffFileLabel').textContent = '';
  if ($('diffContent')) {
    $('diffContent').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">▓</div>
        <div class="empty-title">no diff</div>
        <div class="empty-sub">select a file to see its diff</div>
      </div>`;
  }
  if (isMobile()) {
    mobileTab('files');
  }
}

function renderDiff(lines, label) {
  const panel = $('centerPanel');
  panel.classList.add('open');
  panel.style.width = '';
  panel.style.flex = '';
  if ($('diffCmdText')) $('diffCmdText').textContent = label === 'all changes' ? 'git diff HEAD' : 'git diff HEAD —';
  if ($('diffFileLabel')) {
    $('diffFileLabel').innerHTML = label === 'all changes' ? '' : `${getFileIcon(label)} <span>${esc(label)}</span>`;
  }

  if (isImageFile(label)) {
    const rawUrl = `/api/file-raw?repoPath=${encodeURIComponent(REPO)}&file=${encodeURIComponent(label)}&t=${Date.now()}`;
    $('diffContent').innerHTML = `
      <div class="image-preview-container">
        <div class="image-preview-card">
          <div class="image-checkerboard-wrap">
            <img class="image-preview-element" src="${rawUrl}" alt="Image preview" />
          </div>
          <div class="image-preview-meta">
            <span>image file</span>
          </div>
        </div>
      </div>`;
    return;
  }

  if (!lines.length) {
    $('diffContent').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">▒</div>
        <div class="empty-title">no diff for this file</div>
        <div class="empty-sub">file may be untracked or binary</div>
      </div>`;
    return;
  }

  const filtered = lines.filter(l => l.type !== 'file-header');

  $('diffContent').innerHTML = filtered.map(l => `
    <div class="diff-line ${l.type}">
      <div class="diff-ln">${l.o !== '' ? l.o : ''}</div>
      <div class="diff-ln">${l.n !== '' ? l.n : ''}</div>
      <div class="diff-sign">${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : l.type === 'meta' ? '↕' : ''}</div>
      <div class="diff-text">${esc(l.text)}</div>
    </div>`).join('');
}

// ─── File selection ──────────────────────────────────────
function selectFile(el) {
  const file = el.dataset.file;
  if (!file) return;

  // Update active highlight
  document.querySelectorAll('.file-entry').forEach(e => e.classList.remove('active'));
  el.classList.add('active');

  activeFile = file;

  if (currentTab === 'changes') {
    // Changes tab: show diff only
    const range = fileRanges[file];
    if (range) {
      renderDiff(allDiffLines.slice(range.start, range.end + 1), file);
    } else {
      renderDiff([], file);
    }
    if (isMobile()) mobileTab('diff');
  } else {
    // All files tab: open editor
    openEditor(file);
  }
}

// ─── Markdown Parser Configuration ───────────────────────
if (typeof marked !== 'undefined') {
  // marked v9+ dropped the `highlight` option — use the Renderer instead
  const renderer = new marked.Renderer();
  const origCode = renderer.code.bind(renderer);
  renderer.code = function(token) {
    // token is an object with .text, .lang in marked v9+
    const code = token && typeof token === 'object' ? token.text : token;
    const lang = token && typeof token === 'object' ? (token.lang || '') : (arguments[1] || '');
    if (typeof hljs !== 'undefined') {
      const validLang = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      try {
        const highlighted = hljs.highlight(code, { language: validLang }).value;
        const escapedLang = lang ? lang.replace(/"/g, '&quot;') : '';
        return `<pre><code class="hljs language-${escapedLang}">${highlighted}</code></pre>`;
      } catch (e) {}
    }
    // fallback
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<pre><code class="hljs">${escaped}</code></pre>`;
  };
  marked.setOptions({ breaks: true, gfm: true });
  marked.use({ renderer });
}

// ─── Editor (CodeMirror) ─────────────────────────────────
let cmEditor = null;
let cleanGeneration = null;

CodeMirror.modeURL = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/%N/%N.min.js';

function getMode(filename) {
  const info = CodeMirror.findModeByFileName(filename);
  return info ? info.mode : 'null';
}

let statusTimer = null;

function setEditorCleanState(showSavedIndicator = false) {
  editorDirty = false;
  const saveBtn = $('editorSaveBtn');
  const statusEl = $('editorStatus');

  if (showSavedIndicator) {
    if (statusEl) {
      statusEl.textContent = 'saved';
      statusEl.className = 'editor-status saved';
      statusEl.style.display = 'inline-block';
      statusEl.style.opacity = '1';
    }
    if (saveBtn) {
      saveBtn.style.display = 'inline-flex';
      saveBtn.classList.add('faded');
      saveBtn.disabled = true;
    }
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (!editorDirty && statusEl) {
        statusEl.style.opacity = '0';
        setTimeout(() => {
          if (!editorDirty && statusEl) {
            statusEl.textContent = '';
            statusEl.style.display = 'none';
          }
        }, 300);
      }
    }, 2500);
  } else {
    clearTimeout(statusTimer);
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'editor-status';
      statusEl.style.display = 'none';
      statusEl.style.opacity = '1';
    }
    if (saveBtn) {
      saveBtn.style.display = 'none';
      saveBtn.classList.remove('faded');
      saveBtn.disabled = false;
    }
  }
}

function setEditorDirtyState() {
  if (typeof renderEditorTabs === "function") renderEditorTabs();
  editorDirty = true;
  clearTimeout(statusTimer);
  const saveBtn = $('editorSaveBtn');
  const statusEl = $('editorStatus');
  if (statusEl) {
    statusEl.textContent = 'unsaved';
    statusEl.className = 'editor-status unsaved';
    statusEl.style.display = 'inline-block';
    statusEl.style.opacity = '1';
  }
  if (saveBtn) {
    saveBtn.style.display = 'inline-flex';
    saveBtn.classList.remove('faded');
    saveBtn.disabled = false;
  }
}

function initCM() {
  if (cmEditor) return;
  const tabSize = $('settingTabSize') ? parseInt($('settingTabSize').value, 10) : 2;
  const wordWrap = $('settingWordWrap') ? $('settingWordWrap').checked : true;
  const fontSize = $('settingFontSize') ? $('settingFontSize').value : '13';

  cmEditor = CodeMirror($('editorCM'), {
    value: '',
    theme: 'tomorrow-night-eighties',
    lineNumbers: true,
    lineWrapping: wordWrap,
    tabSize: tabSize,
    indentUnit: tabSize,
    indentWithTabs: false,
    autofocus: false,
    extraKeys: {
      'Ctrl-S': () => saveFile(),
      'Cmd-S':  () => saveFile(),
      Tab: cm => cm.replaceSelection(' '.repeat(tabSize)),
    },
  });

  const wrapper = cmEditor.getWrapperElement();
  if (wrapper) wrapper.style.fontSize = fontSize + 'px';

  cmEditor.on('change', () => {
    // cleanGeneration is null while we are in the middle of loading a file
    // (between setValue('') and the explicit setEditorCleanState/setEditorDirtyState
    // call at the end of openEditor). Ignore those internal setValue events entirely.
    if (cleanGeneration === null) return;

    const isClean = cmEditor.isClean(cleanGeneration);
    if (isClean) {
      setEditorCleanState(false);
      if (activeFile && REPO) {
        localStorage.removeItem(`groove_draft_${REPO}_${activeFile}`);
      }
    } else {
      setEditorDirtyState();
      if (activeFile && REPO) {
        localStorage.setItem(`groove_draft_${REPO}_${activeFile}`, cmEditor.getValue());
      }
    }
  });
}

function goToFilesTab() {
  if (isMobile()) {
    mobileTab('files');
  }
  switchTab('all');
}

// ─── Settings Modal ──────────────────────────────────────
function toggleSettings() {
  const modal = $('settingsModal');
  if (!modal) return;
  const isHidden = modal.style.display === 'none' || !modal.style.display;
  modal.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) {
    if ($('settingRepoPath')) {
      $('settingRepoPath').textContent = REPO || 'None';
      $('settingRepoPath').title = REPO || 'None';
    }
  }
}

function applySettings() {
  const fontSize = $('settingFontSize') ? $('settingFontSize').value : '13';
  const tabSize = $('settingTabSize') ? parseInt($('settingTabSize').value, 10) : 2;
  const wordWrap = $('settingWordWrap') ? $('settingWordWrap').checked : true;

  if (cmEditor) {
    cmEditor.setOption('tabSize', tabSize);
    cmEditor.setOption('indentUnit', tabSize);
    cmEditor.setOption('lineWrapping', wordWrap);
    const cmWrapper = cmEditor.getWrapperElement();
    if (cmWrapper) cmWrapper.style.fontSize = fontSize + 'px';
    cmEditor.refresh();
  }
  try {
    localStorage.setItem('groove_settings', JSON.stringify({ fontSize, tabSize, wordWrap }));
  } catch (e) {}
}

function loadSavedSettings() {
  try {
    const saved = localStorage.getItem('groove_settings');
    if (saved) {
      const s = JSON.parse(saved);
      if (s.fontSize && $('settingFontSize')) $('settingFontSize').value = s.fontSize;
      if (s.tabSize && $('settingTabSize')) $('settingTabSize').value = s.tabSize;
      if (s.wordWrap !== undefined && $('settingWordWrap')) $('settingWordWrap').checked = s.wordWrap;
    }
  } catch (e) {}
}

// ─── Logo / Scaffolding Navigation ───────────────────────
async function goHome() {
  // If already at scaffolding/connect screen, do nothing
  if ($('connectScreen') && $('connectScreen').style.display !== 'none') return;

  if (editorDirty) {
    const choice = confirm('You have unsaved changes.\n\nClick OK to save and return to the scaffolding screen,\nor Cancel to ignore changes and return.');
    if (choice) {
      await saveFile();
    }
  } else {
    const sure = confirm('Are you sure you want to go back to the scaffolding screen?');
    if (!sure) return;
  }

  if (activeFile && REPO) {
    localStorage.removeItem(`groove_draft_${REPO}_${activeFile}`);
  }
  localStorage.removeItem('groove_active_file');
  localStorage.removeItem('groove_repo');
  editorDirty = false;
  activeFile = null;
  REPO = '';
  if (typeof closeEditor === 'function') closeEditor(true);
  if (typeof closeDiff === 'function') closeDiff();
  showConnect();
}

// ─── Markdown Codeblocks & Preview ───────────────────────
let mdPreviewMode = false;

function isMdFile(file) {
  return /\.(md|markdown)$/i.test(file || '');
}

function getCollapsedCodeblocks() {
  if (!REPO || !activeFile) return new Set();
  try {
    const raw = localStorage.getItem(`groove_md_cb_${REPO}_${activeFile}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (e) {
    return new Set();
  }
}

function saveCollapsedCodeblocks(cbSet) {
  if (!REPO || !activeFile) return;
  try {
    localStorage.setItem(`groove_md_cb_${REPO}_${activeFile}`, JSON.stringify([...cbSet]));
  } catch (e) {}
}

function renderMarkdownPreview(raw) {
  const preview = $('editorMdPreview');
  if (!preview) return;
  if (typeof marked !== 'undefined') {
    preview.innerHTML = marked.parse(raw);
  } else {
    preview.innerHTML = `<pre><code>${esc(raw)}</code></pre>`;
  }
  enhanceMarkdownCodeblocks(preview);
}

function enhanceMarkdownCodeblocks(container) {
  if (!container) return;
  // Only target fenced code blocks (pre > code), not bare <pre> tags
  const fencedPres = [...container.querySelectorAll('pre')].filter(
    pre => pre.querySelector('code') !== null
  );

  const collapsedSet = getCollapsedCodeblocks();

  fencedPres.forEach((pre, idx) => {
    if (pre.parentElement && pre.parentElement.classList.contains('md-codeblock-wrapper')) {
      return;
    }

    const cbId = `cb-${idx}`;
    const isCollapsed = collapsedSet.has(cbId);

    const wrapper = document.createElement('div');
    wrapper.className = 'md-codeblock-wrapper' + (isCollapsed ? ' is-collapsed' : '');
    wrapper.dataset.cbId = cbId;

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // Only show the collapse arrow if the block is tall enough to need it
    // We measure after insertion so the browser has laid it out
    requestAnimationFrame(() => {
      const MIN_HEIGHT = 180; // px — shorter blocks don't need collapsing
      if (pre.scrollHeight > MIN_HEIGHT) {
        const arrow = document.createElement('button');
        arrow.className = 'md-cb-corner-arrow';
        arrow.title = isCollapsed ? 'Expand' : 'Collapse';
        arrow.innerHTML = isCollapsed
          ? `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`
          : `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>`;
        arrow.onclick = (e) => {
          e.stopPropagation();
          toggleCodeblockCollapse(cbId, e);
        };
        wrapper.appendChild(arrow);
      }
    });
  });
}


function copyCodeblock(btn, event) {
  if (event) event.stopPropagation();
  const wrapper = btn.closest('.md-codeblock-wrapper');
  if (!wrapper) return;
  const code = wrapper.querySelector('pre code') || wrapper.querySelector('pre');
  if (!code) return;
  const text = code.innerText || code.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> <span>copied!</span>`;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> <span>copy</span>`;
    }, 2000);
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

function toggleCodeblockCollapse(cbId, event) {
  if (event) event.stopPropagation();
  const wrapper = document.querySelector(`.md-codeblock-wrapper[data-cb-id="${cbId}"]`);
  if (!wrapper) return;
  const isNowCollapsed = !wrapper.classList.contains('is-collapsed');
  wrapper.classList.toggle('is-collapsed', isNowCollapsed);

  const btn = wrapper.querySelector('.md-cb-corner-arrow');
  if (btn) {
    btn.title = isNowCollapsed ? 'Expand' : 'Collapse';
    btn.innerHTML = isNowCollapsed
      ? `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`
      : `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>`;
  }

  const collapsedSet = getCollapsedCodeblocks();
  if (isNowCollapsed) {
    collapsedSet.add(cbId);
  } else {
    collapsedSet.delete(cbId);
  }
  saveCollapsedCodeblocks(collapsedSet);
}

function toggleCodeblocksDropdown(event) {
  if (event) event.stopPropagation();
  const menu = $('editorMdCodeblocksMenu');
  if (!menu) return;
  const isShown = menu.style.display !== 'none';
  menu.style.display = isShown ? 'none' : 'flex';
}

document.addEventListener('click', e => {
  const menu = $('editorMdCodeblocksMenu');
  if (menu && menu.style.display !== 'none' && !e.target.closest('#editorMdCodeblocksDropdown')) {
    menu.style.display = 'none';
  }
});

function setAllCodeblocksCollapsed(collapse) {
  const menu = $('editorMdCodeblocksMenu');
  if (menu) menu.style.display = 'none';

  const wrappers = document.querySelectorAll('.md-codeblock-wrapper');
  const collapsedSet = new Set();

  wrappers.forEach(wrapper => {
    const cbId = wrapper.dataset.cbId;
    wrapper.classList.toggle('is-collapsed', collapse);
    const arrow = wrapper.querySelector('.md-cb-collapse-arrow');
    if (arrow) arrow.textContent = collapse ? '▶' : '▼';
    const hint = wrapper.querySelector('.md-cb-hint');
    if (hint) hint.textContent = collapse ? '(collapsed — click to expand)' : '';
    const toggleBtnSpan = wrapper.querySelector('.md-cb-toggle-btn span');
    if (toggleBtnSpan) toggleBtnSpan.textContent = collapse ? 'expand' : 'collapse';
    const toggleBtn = wrapper.querySelector('.md-cb-toggle-btn');
    if (toggleBtn) toggleBtn.title = collapse ? 'Expand code block' : 'Collapse code block';

    if (collapse && cbId) {
      collapsedSet.add(cbId);
    }
  });

  saveCollapsedCodeblocks(collapsedSet);
  showToast(collapse ? 'Collapsed all codeblocks' : 'Expanded all codeblocks');
}

function toggleMdPreview() {
  mdPreviewMode = !mdPreviewMode;
  try {
    localStorage.setItem('groove_md_preview', mdPreviewMode ? '1' : '0');
  } catch (e) {}
  const btn = $('editorMdToggleBtn');
  if (btn) {
    btn.classList.toggle('active', mdPreviewMode);
    btn.title = mdPreviewMode ? 'Switch to raw markdown editor' : 'Toggle markdown preview';
  }

  if (mdPreviewMode) {
    if ($('editorCM')) $('editorCM').style.display = 'none';
    const preview = $('editorMdPreview');
    if (preview) {
      preview.style.display = 'flex';
      const raw = cmEditor ? cmEditor.getValue() : '';
      renderMarkdownPreview(raw);
    }
  } else {
    if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
    if ($('editorMdCodeblocksDropdown')) $('editorMdCodeblocksDropdown').style.display = 'none';
    if ($('editorMdCodeblocksMenu')) $('editorMdCodeblocksMenu').style.display = 'none';
    if ($('editorCM')) $('editorCM').style.display = 'block';
    if (cmEditor) setTimeout(() => cmEditor.refresh(), 30);
  }
}

async function openEditor(file) {
  const panel = $('editorPanel');
  if ($('editorEmpty')) $('editorEmpty').style.display = 'none';
  if ($('editorToolbar')) {
    $('editorToolbar').classList.remove('hidden');
    $('editorToolbar').style.display = 'flex';
  }

  $('editorFilename').innerHTML = `${getFileIcon(file)} <span>${esc(file)}</span>`;
  panel.classList.add('open');
  panel.style.width = '';
  panel.style.flex = '';
  activeFile = file;
  if (!editorTabs.includes(file)) {
    editorTabs.push(file);
    saveEditorTabs();
  }
  if (typeof renderEditorTabs === 'function') renderEditorTabs();
  try {
    localStorage.setItem('groove_active_file', file);
  } catch (e) {}

  // Markdown toggle visibility
  const isMarkdown = isMdFile(file);
  const mdBtn = $('editorMdToggleBtn');
  if (mdBtn) {
    mdBtn.style.display = isMarkdown ? 'inline-flex' : 'none';
  }

  if (isImageFile(file)) {
    if ($('editorCM')) $('editorCM').style.display = 'none';
    if ($('editorSaveBtn')) $('editorSaveBtn').style.display = 'none';
    if ($('editorMdToggleBtn')) $('editorMdToggleBtn').style.display = 'none';
    if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
    if ($('editorMdCodeblocksDropdown')) $('editorMdCodeblocksDropdown').style.display = 'none';
    $('editorStatus').textContent = 'preview';
    $('editorStatus').className = 'editor-status';

    const imgContainer = $('editorImagePreview');
    const imgEl = $('imagePreviewImg');
    const metaDim = $('imageMetaDimensions');
    const metaSize = $('imageMetaSize');

    if (imgContainer) imgContainer.style.display = 'flex';

    const rawUrl = `/api/file-raw?repoPath=${encodeURIComponent(REPO)}&file=${encodeURIComponent(file)}&t=${Date.now()}`;
    imgEl.src = rawUrl;
    metaDim.textContent = 'loading...';
    metaSize.textContent = '';

    imgEl.onload = () => {
      metaDim.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight} px`;
      fetch(rawUrl, { method: 'HEAD' }).then(r => {
        const len = r.headers.get('content-length');
        if (len) metaSize.textContent = formatBytes(parseInt(len, 10));
      }).catch(() => {});
    };

    imgEl.onerror = () => {
      metaDim.textContent = 'failed to load image';
      metaSize.textContent = '';
    };

    if (isMobile()) mobileTab('editor');
    return;
  }

  // Regular text/code file
  if ($('editorImagePreview')) $('editorImagePreview').style.display = 'none';
  if ($('editorCM')) $('editorCM').style.display = 'block';

  initCM();
  $('editorStatus').textContent = 'loading...';
  $('editorStatus').className = 'editor-status';
  $('editorStatus').style.display = 'inline-block';
  $('editorStatus').style.opacity = '1';
  if ($('editorSaveBtn')) $('editorSaveBtn').style.display = 'none';
  cleanGeneration = null;
  cmEditor.setValue('');
  editorDirty = false;

  // Set syntax mode from filename
  const mode = getMode(file);
  CodeMirror.autoLoadMode(cmEditor, mode);
  cmEditor.setOption('mode', mode);

  const cacheKey = `groove_file_${REPO}_${file}`;
  const draftKey = `groove_draft_${REPO}_${file}`;

  // ── Step 1: Show cached content immediately so editor feels instant ──
  const cachedContent = localStorage.getItem(cacheKey);
  const savedDraft = localStorage.getItem(draftKey);

  if (cachedContent !== null) {
    const displayContent = (savedDraft !== null && savedDraft !== cachedContent && savedDraft !== '') ? savedDraft : cachedContent;
    cmEditor.setValue(displayContent);
    cmEditor.clearHistory();
    cleanGeneration = cmEditor.changeGeneration();

    if (savedDraft !== null && savedDraft !== cachedContent && savedDraft !== '') {
      setEditorDirtyState();
    } else {
      setEditorCleanState(false);
    }

    // Restore markdown preview state
    const savedMdPref = localStorage.getItem('groove_md_preview') === '1';
    if (isMarkdown && savedMdPref) {
      mdPreviewMode = true;
      if (mdBtn) { mdBtn.classList.add('active'); mdBtn.title = 'Switch to raw markdown editor'; }
      if ($('editorCM')) $('editorCM').style.display = 'none';
      const preview = $('editorMdPreview');
      if (preview) { preview.style.display = 'flex'; renderMarkdownPreview(cmEditor.getValue()); }
    } else {
      mdPreviewMode = false;
      if (mdBtn) { mdBtn.classList.remove('active'); mdBtn.title = 'Toggle markdown preview'; }
      if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
      if ($('editorCM')) $('editorCM').style.display = 'block';
    }
    if (isMobile()) mobileTab('editor');
    setTimeout(() => cmEditor.refresh(), 50);
  }

  // ── Step 2: Fetch fresh content in the background ──
  try {
    const res = await fetch(`/api/file-read?repoPath=${encodeURIComponent(REPO)}&file=${encodeURIComponent(file)}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error);

    const serverContent = d.content;

    // Update cache
    localStorage.setItem(cacheKey, serverContent);

    // Only update the editor if there's no unsaved draft AND content actually changed
    if (!editorDirty && serverContent !== cachedContent) {
      const isPhantomDraft = savedDraft === '' && serverContent !== '';
      if (savedDraft !== null && savedDraft !== serverContent && !isPhantomDraft) {
        cmEditor.setValue(savedDraft);
        setEditorDirtyState();
      } else {
        if (isPhantomDraft) localStorage.removeItem(draftKey);
        cmEditor.setValue(serverContent);
        cmEditor.clearHistory();
        cleanGeneration = cmEditor.changeGeneration();
        setEditorCleanState(false);
        // Re-render markdown if in preview mode
        if (isMarkdown && mdPreviewMode) {
          renderMarkdownPreview(serverContent);
        }
      }
    } else if (cachedContent === null) {
      // First time loading this file — no cache was available
      const isPhantomDraft = savedDraft === '' && serverContent !== '';
      if (savedDraft !== null && savedDraft !== serverContent && !isPhantomDraft) {
        cmEditor.setValue(savedDraft);
        setEditorDirtyState();
      } else {
        if (isPhantomDraft) localStorage.removeItem(draftKey);
        cmEditor.setValue(serverContent);
        cmEditor.clearHistory();
        cleanGeneration = cmEditor.changeGeneration();
        setEditorCleanState(false);
      }

      const savedMdPref = localStorage.getItem('groove_md_preview') === '1';
      if (isMarkdown && savedMdPref) {
        mdPreviewMode = true;
        if (mdBtn) { mdBtn.classList.add('active'); mdBtn.title = 'Switch to raw markdown editor'; }
        if ($('editorCM')) $('editorCM').style.display = 'none';
        const preview = $('editorMdPreview');
        if (preview) { preview.style.display = 'flex'; renderMarkdownPreview(cmEditor.getValue()); }
      } else {
        mdPreviewMode = false;
        if (mdBtn) { mdBtn.classList.remove('active'); mdBtn.title = 'Toggle markdown preview'; }
        if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
        if ($('editorCM')) $('editorCM').style.display = 'block';
      }
      if (isMobile()) mobileTab('editor');
      setTimeout(() => cmEditor.refresh(), 50);
    }
  } catch (e) {
    if (cachedContent === null) {
      cmEditor.setValue(`# error loading file\n# ${e.message}`);
      $('editorStatus').textContent = 'error';
      $('editorStatus').className = 'editor-status error';
      $('editorStatus').style.display = 'inline-block';
      if ($('editorSaveBtn')) $('editorSaveBtn').style.display = 'none';
    }
    // If cache was available, silently keep showing cached content
  }
}

function closeEditor(force) {
  if (activeFile) {
    closeEditorTab(activeFile);
    return;
  }
  const panel = $('editorPanel');
  panel.classList.remove('open');
  panel.style.width = '';
  panel.style.flex = '';
  localStorage.removeItem('groove_active_file');
  activeFile = null;
  setEditorCleanState(false);
  mdPreviewMode = false;
  document.querySelectorAll('.file-entry').forEach(e => e.classList.remove('active'));
  if ($('editorEmpty')) $('editorEmpty').style.display = 'flex';
  if ($('editorToolbar')) {
    $('editorToolbar').classList.add('hidden');
    $('editorToolbar').style.display = 'none';
  }
  if ($('editorCM')) $('editorCM').style.display = 'none';
  if ($('editorImagePreview')) $('editorImagePreview').style.display = 'none';
  if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
  if ($('editorMdToggleBtn')) $('editorMdToggleBtn').style.display = 'none';
  if ($('editorMdCodeblocksDropdown')) $('editorMdCodeblocksDropdown').style.display = 'none';
  if ($('editorMdCodeblocksMenu')) $('editorMdCodeblocksMenu').style.display = 'none';
  if (isMobile()) {
    mobileTab('files');
  }
}

async function saveFile() {
  if (!activeFile || !cmEditor) return;
  const content = cmEditor.getValue();
  const statusEl = $('editorStatus');
  if (statusEl) {
    statusEl.textContent = 'saving...';
    statusEl.className = 'editor-status';
    statusEl.style.display = 'inline-block';
    statusEl.style.opacity = '1';
  }
  try {
    const res = await fetch('/api/file-write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: REPO, file: activeFile, content })
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    cleanGeneration = cmEditor.changeGeneration();
    if (REPO && activeFile) {
      localStorage.removeItem(`groove_draft_${REPO}_${activeFile}`);
    }
    setEditorCleanState(true);
    showToast(`saved ${activeFile}`);
    await loadStatus();
    const entry = document.querySelector(`.file-entry[data-file="${CSS.escape(activeFile)}"]`);
    if (entry) entry.classList.add('active');
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = 'save failed';
      statusEl.className = 'editor-status error';
      statusEl.style.display = 'inline-block';
    }
    showToast(e.message, 'error');
  }
}

// ─── Push ────────────────────────────────────────────────
// ─── Tab switching ───────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  try {
    localStorage.setItem('groove_active_tab', tab);
  } catch (e) {}
  $('tabChanges').classList.toggle('active', tab === 'changes');
  $('tabAll').classList.toggle('active', tab === 'all');
  $('treeSearch').style.display = tab === 'all' ? 'block' : 'none';
  $('selectAllRow').style.display = tab === 'all' ? 'none' : '';
  if ($('actionChipsWrapper')) $('actionChipsWrapper').style.display = tab === 'all' ? 'none' : '';
  if ($('commitBar')) $('commitBar').style.display = tab === 'all' ? 'none' : '';
  if (tab === 'all') {
    if (allTreeFiles.length) {
      renderTree(allTreeFiles);
    } else {
      loadFileTree();
    }
  } else {
    loadStatus();
  }
}

// ─── Full file tree ──────────────────────────────────────
async function loadFileTree() {
  const cacheKey = `groove_tree_${REPO}`;
  let hasCache = false;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      allTreeFiles = JSON.parse(cached);
      renderTree(allTreeFiles);
      hasCache = true;
    }
  } catch (e) {}
  
  if (!hasCache) {
    $('fileList').innerHTML = '<div class="loading-row"><span class="spinner"></span> loading files...</div>';
  }

  try {
    const res = await fetch('/api/file-tree?repoPath=' + encodeURIComponent(REPO));
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    
    const newCacheStr = JSON.stringify(d.files);
    const oldCacheStr = localStorage.getItem(cacheKey);
    if (newCacheStr !== oldCacheStr) {
      allTreeFiles = d.files;
      localStorage.setItem(cacheKey, newCacheStr);
      if (currentTab === 'all') {
        const input = $('treeSearchInput');
        const q = input ? input.value.trim().toLowerCase() : '';
        renderTree(q ? allTreeFiles.filter(f => f.toLowerCase().includes(q)) : allTreeFiles);
      }
    }
    
    // Wire up search if it hasn't been done
    const input = $('treeSearchInput');
    if (input && !input.oninput) {
      input.oninput = () => {
        const q = input.value.trim().toLowerCase();
        renderTree(q ? allTreeFiles.filter(f => f.toLowerCase().includes(q)) : allTreeFiles);
      };
    }
  } catch (e) {
    if (!hasCache && currentTab === 'all') {
      $('fileList').innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px">${esc(e.message)}</div>`;
    }
  }
}

function getOpenFolders() {
  if (!REPO) return new Set();
  try {
    const raw = localStorage.getItem(`groove_open_folders_${REPO}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (e) {
    return new Set();
  }
}

function saveOpenFolders(folderSet) {
  if (!REPO) return;
  try {
    localStorage.setItem(`groove_open_folders_${REPO}`, JSON.stringify([...folderSet]));
  } catch (e) {}
}

function renderTree(files) {
  if (!files.length) {
    $('fileList').innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">no files match</div>';
    return;
  }

  // Ensure parent directories of activeFile are open
  const openFolders = getOpenFolders();
  if (activeFile) {
    const parts = activeFile.split('/');
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      openFolders.add(cur);
    }
    saveOpenFolders(openFolders);
  }

  // Build a folder tree structure
  const tree = {};
  for (const f of files) {
    const parts = f.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = null; // null = file leaf
  }

  function renderNode(node, prefix, depth) {
    let html = '';
    const entries = Object.entries(node).sort(([a, av], [b, bv]) => {
      // dirs first, then files
      const aDir = av !== null, bDir = bv !== null;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    for (const [name, child] of entries) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (child === null) {
        // file
        html += `
          <div class="file-entry tree-file${activeFile === fullPath ? ' active' : ''}" data-file="${esc(fullPath)}" draggable="true" ondragstart="dragFile(event, '${esc(fullPath)}')" onclick="selectFile(this)" style="padding-left:${12 + depth * 14}px">
            ${getFileIcon(name)}
            <span class="file-entry-name" title="${esc(fullPath)}">${esc(name)}</span>
            <span class="file-edit-hint">edit</span>
          </div>`;
      } else {
        // folder — collapsible
        const isOpen = openFolders.has(fullPath);
        const folderId = 'fold-' + CSS.escape(fullPath);
        html += `
          <div class="tree-folder" onclick="toggleFolder('${esc(fullPath)}')" style="padding-left:${12 + depth * 14}px">
            <span class="folder-arrow" id="arr-${folderId}">${isOpen ? '▼' : '▶'}</span>
            ${getFolderIcon()}
            <span style="color:var(--muted2)">${esc(name)}</span>
          </div>
          <div class="tree-children" id="${folderId}" style="display:${isOpen ? 'block' : 'none'}">
            ${renderNode(child, fullPath, depth + 1)}
          </div>`;
      }
    }
    return html;
  }

  $('fileList').innerHTML = renderNode(tree, '', 0);
}

function toggleFolder(path) {
  const folderId = 'fold-' + CSS.escape(path);
  const el = document.getElementById(folderId);
  const arr = document.getElementById('arr-' + folderId);
  if (!el) return;
  const isNowOpen = el.style.display === 'none';
  el.style.display = isNowOpen ? 'block' : 'none';
  if (arr) arr.textContent = isNowOpen ? '▼' : '▶';

  const openFolders = getOpenFolders();
  if (isNowOpen) {
    openFolders.add(path);
  } else {
    openFolders.delete(path);
  }
  saveOpenFolders(openFolders);
}

async function executeAction() {
  if (currentAction === 'commit') {
    await doCommit();
  } else if (currentAction === 'push') {
    await doPush();
  }
}

async function doCommit() {
  const msg = $('commitMsg').value.trim();
  if (!msg) { showToast('enter a commit message', 'error'); $('commitMsg').focus(); return; }

  const checkedFiles = [...document.querySelectorAll('.file-chk:checked')].map(c => c.dataset.file);
  if (!checkedFiles.length) { showToast('select at least one file to commit', 'error'); return; }

  const btn = $('pushBtn');
  btn.disabled = true;
  btn.classList.remove('ready');
  btn.innerHTML = '<span class="spinner"></span> committing...';

  try {
    const res = await fetch('/api/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, repoPath: REPO, files: checkedFiles })
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    $('commitMsg').value = '';
    showToast('committed ✓');
    closeDiff();
    closeEditor();
    if (currentTab === 'changes') {
      $('fileList').innerHTML = '<div class="loading-row"><span class="spinner"></span> refreshing...</div>';
      await Promise.all([loadRepoInfo(), loadStatus()]);
    } else {
      await Promise.all([loadRepoInfo(), loadStatus(), loadFileTree()]);
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    updateCommitBar();
  }
}

async function doPush() {
  const btn = $('pushBtn');
  btn.disabled = true;
  btn.classList.remove('ready');
  btn.innerHTML = '<span class="spinner"></span> pushing...';

  try {
    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: REPO })
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    showToast('pushed ✓');
    if (currentTab === 'changes') {
      $('fileList').innerHTML = '<div class="loading-row"><span class="spinner"></span> refreshing...</div>';
    }
    await Promise.all([loadRepoInfo(), loadStatus()]);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    updateCommitBar();
  }
}

// ─── Mobile nav ──────────────────────────────────────────
const isMobile = () => window.innerWidth <= 640;

let currentMobileTab = 'files';

function mobileTab(tab) {
  if (!isMobile()) return;
  currentMobileTab = tab;
  try {
    localStorage.setItem('groove_mobile_tab', tab);
  } catch (e) {}

  // Reset all nav buttons
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
  const btnMap = { files: 'mnFiles', editor: 'mnEditor', term: 'mnTerm' };
  const activeBtn = $(btnMap[tab]);
  if (activeBtn) activeBtn.classList.add('active');

  // Hide all panels
  ['filePanel', 'centerPanel', 'editorPanel', 'termPanel'].forEach(id => {
    $(id).classList.remove('mobile-active');
  });

  if (tab === 'files') {
    $('filePanel').classList.add('mobile-active');

  } else if (tab === 'diff') {
    $('centerPanel').classList.add('mobile-active');
    $('diffPanel').style.display = 'flex';

  } else if (tab === 'editor') {
    $('editorPanel').classList.add('mobile-active');
    if (!activeFile) {
      if ($('editorEmpty')) $('editorEmpty').style.display = 'flex';
      if ($('editorToolbar')) {
        $('editorToolbar').classList.add('hidden');
        $('editorToolbar').style.display = 'none';
      }
      if ($('editorCM')) $('editorCM').style.display = 'none';
      if ($('editorImagePreview')) $('editorImagePreview').style.display = 'none';
    } else {
      if ($('editorEmpty')) $('editorEmpty').style.display = 'none';
      if ($('editorToolbar')) {
        $('editorToolbar').classList.remove('hidden');
        $('editorToolbar').style.display = 'flex';
      }
      if (isImageFile(activeFile)) {
        if ($('editorCM')) $('editorCM').style.display = 'none';
        if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
        if ($('editorImagePreview')) $('editorImagePreview').style.display = 'flex';
      } else if (mdPreviewMode) {
        // Markdown preview is active — show the preview div, hide the CodeMirror editor
        if ($('editorImagePreview')) $('editorImagePreview').style.display = 'none';
        if ($('editorCM')) $('editorCM').style.display = 'none';
        const preview = $('editorMdPreview');
        if (preview) {
          preview.style.display = 'flex';
          // Re-render in case content changed since last render
          if (cmEditor) {
            renderMarkdownPreview(cmEditor.getValue());
          }
        }
      } else {
        if ($('editorImagePreview')) $('editorImagePreview').style.display = 'none';
        if ($('editorMdPreview')) $('editorMdPreview').style.display = 'none';
        if ($('editorCM')) $('editorCM').style.display = 'block';
        if (cmEditor) setTimeout(() => cmEditor.refresh(), 50);
      }
    }

  } else if (tab === 'term') {
    $('termPanel').classList.remove('hidden');
    $('termPanel').classList.add('mobile-active');
    // Init terminal on first open, reconnect if repo changed
    if (termSessions.length === 0) {
      initTerm();
    } else {
      setTimeout(fitTerm, 50);
      setTimeout(fitTerm, 180);
    }
  }
}

function initMobile() {
  if (!isMobile()) return;
  const savedMobileTab = localStorage.getItem('groove_mobile_tab') || 'files';
  mobileTab(savedMobileTab);
}

// When a file is selected on mobile, auto-switch to diff tab
const _origSelectFile = window.selectFile;

// ─── Terminal ────────────────────────────────────────────
let termSessions = [];
let activeTermId = null;
let termCounter = 0;
let tailscaleIP = null;

// Fetch Tailscale IP once on load
fetch('/api/tailscale-ip').then(r => r.json()).then(d => { tailscaleIP = d.ip; }).catch(() => {});

// Detect dev server URLs in terminal output
function checkTermOutputForDevServer(str) {
  if (!str) return;
  const match = str.match(/(http:\/\/localhost:\d+)/);
  if (match) {
    let url = match[1];
    if (tailscaleIP) {
      url = url.replace('localhost', tailscaleIP);
    }
    showToast(`<a href="${url}" target="_blank" style="color:white;text-decoration:underline;">Dev server running at ${url}</a>`);
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
  tabs.innerHTML = termSessions.map((s, i) => `
    <div class="panel-tab ${s.id === activeTermId ? 'active' : ''}" onclick="switchTerm(${s.id})">
      <span>term ${i + 1}</span>
      <span class="term-tab-close" onclick="event.stopPropagation(); closeTerm(${s.id})" title="Close tab">✕</span>
    </div>
  `).join('');
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

function saveTermSessions() {
  if (REPO) {
    const sessionIds = termSessions.map(s => s.sessionId);
    localStorage.setItem('groove_term_sessions_' + REPO, JSON.stringify(sessionIds));
  }
}

function addTerm(existingSessionId = null) {
  const id = ++termCounter;
  const sessionId = existingSessionId || 'term_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const session = { id, sessionId, ready: false, processRunning: false, term: null, socket: null, fitAddon: null, container: null };
  termSessions.push(session);
  saveTermSessions();
  
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
    const url = `${proto}://${location.host}/terminal?repoPath=${encodeURIComponent(REPO || '')}&sessionId=${sessionId}`;
    const ws = new WebSocket(url);
    session.socket = ws;
    
    ws.onopen = () => {
      fit.fit();
      if (!existingSessionId) {
        t.write('\r\n\x1b[32m# groove terminal\x1b[0m\r\n');
      } else {
        t.write('\r\n\x1b[34m# groove terminal (restored)\x1b[0m\r\n');
      }
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
      t.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
      session.ready = false;
      session.processRunning = false;
      if (activeTermId === id) updateTermUI();
    };
    
    ws.onerror = () => {
      t.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
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
  
  if (session.socket && session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify({ type: 'close' }));
    session.socket.onclose = null;
    session.socket.close();
  }
  if (session.term) session.term.dispose();
  if (session.container && session.container.parentNode) {
    session.container.parentNode.removeChild(session.container);
  }
  
  termSessions.splice(idx, 1);
  saveTermSessions();
  
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
    if (REPO) {
      try {
        const saved = JSON.parse(localStorage.getItem('groove_term_sessions_' + REPO) || '[]');
        if (saved.length > 0) {
          saved.forEach(sid => addTerm(sid));
          return;
        }
      } catch(e) {}
    }
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
    s.socket.send(JSON.stringify({ type: 'input', data: '\x0C' }));
  } else if (s.term) {
    s.term.clear();
  }
  if (s.term) s.term.focus();
}

function killTerm() {
  const s = getActiveSession();
  if (!s) return;
  if (s.socket && s.socket.readyState === WebSocket.OPEN) {
    s.socket.send(JSON.stringify({ type: 'input', data: '\x03' }));
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

// ─── Boot ────────────────────────────────────────────────
function initResizers() {
  const workspace = $('workspaceArea');
  if (!workspace) return;

  // Resizer 1: Between FilePanel and CenterPanel
  const resizer1 = document.createElement('div');
  resizer1.className = 'resizer';
  $('filePanel').after(resizer1);

  // Resizer 2: Between CenterPanel and EditorPanel
  const resizer2 = document.createElement('div');
  resizer2.className = 'resizer';
  $('centerPanel').after(resizer2);

  // Resizer 3: Vertical between WorkspaceArea and TermPanel
  const resizerTerm = document.createElement('div');
  resizerTerm.className = 'resizer-h';
  $('workspaceArea').after(resizerTerm);

  let isResizing = null;

  document.addEventListener('mousedown', e => {
    if (e.target.classList.contains('resizer')) {
      isResizing = e.target;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else if (e.target.classList.contains('resizer-h')) {
      isResizing = e.target;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    }
  });

  document.addEventListener('mousemove', e => {
    if (!isResizing) return;

    if (isResizing === resizer1) {
      const width = e.clientX - $('mainLayout').getBoundingClientRect().left;
      if (width > 180 && width < 600) {
        $('filePanel').style.width = width + 'px';
      }
    } else if (isResizing === resizer2) {
      const isDiffOpen = $('centerPanel').classList.contains('open');
      const isEditorOpen = $('editorPanel').classList.contains('open');
      if (isDiffOpen && isEditorOpen) {
        const availableWidth = $('workspaceArea').clientWidth - $('filePanel').offsetWidth;
        const centerLeft = $('centerPanel').getBoundingClientRect().left;
        const centerWidth = e.clientX - centerLeft;
        if (centerWidth > 150 && centerWidth < availableWidth - 150) {
          $('centerPanel').style.flex = 'none';
          $('centerPanel').style.width = centerWidth + 'px';
          $('editorPanel').style.flex = '1';
          $('editorPanel').style.width = '';
        }
      }
    } else if (isResizing === resizerTerm) {
      const contentArea = $('contentArea');
      const maxH = contentArea ? contentArea.clientHeight : (window.innerHeight - 44);
      let height = window.innerHeight - e.clientY;
      if (height > maxH) height = maxH;
      if (height >= 36) {
        $('termPanel').style.height = height + 'px';
        fitTerm();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    isResizing = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadSavedSettings();
  const savedRepo = localStorage.getItem('groove_repo');
  if (savedRepo) {
    $('repoPathInput').value = savedRepo;
    connectRepo();
  } else {
    loadRepos();
  }
  if ($('repoSearchInput')) $('repoSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchRepos(); });
  if ($('repoPathInput')) $('repoPathInput').addEventListener('keydown', e => { if (e.key === 'Enter') connectRepo(); });
  if ($('commitMsg')) $('commitMsg').addEventListener('keydown', e => { if (e.key === 'Enter') executeAction(); });
  initMobile();
  window.addEventListener('resize', initMobile);

  initResizers();
});



    
  


    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  

