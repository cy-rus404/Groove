const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const pty = require("node-pty");

const app = express();
const PORT = 9000;

app.use(express.json());

// Allow cross-origin requests (needed when accessing via Tailscale IP or any non-localhost origin)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function run(cmd, cwd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

function validateRepo(repoPath) {
  if (!repoPath) throw new Error("No repo path provided");
  if (!fs.existsSync(repoPath)) throw new Error("Path does not exist");
}

function isGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, '.git'));
}

function getFilesRecursive(dir, base = dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (let file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file === 'node_modules' || file === '.git') continue;
      results = results.concat(getFilesRecursive(fullPath, base));
    } else {
      results.push(path.relative(base, fullPath));
    }
  }
  return results;
}


app.get("/api/tailscale-ip", (req, res) => {
  const interfaces = os.networkInterfaces();
  let tailscaleIP = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && iface.address.startsWith("100.")) {
        tailscaleIP = iface.address;
      }
    }
  }
  res.json({ ip: tailscaleIP });
});

app.get("/api/repo-info", async (req, res) => {
  const { repoPath } = req.query;
  try {
    validateRepo(repoPath);
    if (!isGitRepo(repoPath)) {
      return res.json({
        remote: "Local Folder",
        repoName: path.basename(repoPath),
        branch: "N/A",
        lastCommit: { subject: "Local Filesystem", author: "User", time: "N/A" }
      });
    }
    const [remote, branch, lastCommit] = await Promise.all([
      run("git remote get-url origin", repoPath),
      run("git rev-parse --abbrev-ref HEAD", repoPath),
      run("git log -1 --pretty=format:'%s|%an|%ar'", repoPath),
    ]);
    const [subject, author, time] = lastCommit.split("|");
    const githubUrl = remote.replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
    const repoName = remote.replace(/.*[\/:]/, "").replace(".git", "");
    res.json({ remote: githubUrl, repoName, branch, lastCommit: { subject, author, time } });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/repos", async (req, res) => {
  try {
    const { spawn } = require("child_process");
    const readline = require("readline");
    const home = os.homedir();

    const { search, dir } = req.query;
    const baseDir = dir || home;

    let searchDirs = [
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.join(home, 'projects'),
      path.join(home, 'src'),
      path.join(home, 'dev')
    ].filter(fs.existsSync);

    if (dir) {
      searchDirs = [baseDir];
    }

    if (!searchDirs.length) return res.json({ repos: [] });

    let args;
    if (search) {
      // Search for folders matching name, max 3 levels deep
      args = [...searchDirs, '-maxdepth', '3', '-type', 'd', '-iname', `*${search}*`];
    } else {
      // Existing behavior: find .git folders (but we can expand this)
      args = [...searchDirs, '-maxdepth', '3', '-name', '.git', '-type', 'd', '-prune'];
    }

    const child = spawn('find', args, { stdio: ['ignore', 'pipe', 'ignore'] });

    const repos = [];
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on('line', line => {
      if (line && repos.length < 100) {
        repos.push(line.replace(/\/\.git$/, ''));
      }
    });

    child.on('close', () => {
      res.json({ repos });
    });

    child.on('error', (e) => {
      res.status(500).json({ error: e.message });
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.get("/api/status", async (req, res) => {
  const { repoPath } = req.query;
  try {
    validateRepo(repoPath);
    if (!isGitRepo(repoPath)) {
      return res.json({ status: "", diff: "", commitsAhead: 0 });
    }
    const [status, diff] = await Promise.all([
      run("git status --short", repoPath),
      run("git diff HEAD", repoPath),
    ]);
    let commitsAhead = 0;
    try {
      const ahead = await run("git rev-list @{u}..HEAD --count", repoPath);
      commitsAhead = parseInt(ahead.trim(), 10) || 0;
    } catch (_) {
      try {
        const branch = (await run("git branch --show-current", repoPath)).trim();
        const ahead = await run(`git rev-list origin/${branch}..HEAD --count`, repoPath);
        commitsAhead = parseInt(ahead.trim(), 10) || 0;
      } catch (__) {
        commitsAhead = 0;
      }
    }
    res.json({ status, diff, commitsAhead });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/commit", async (req, res) => {
  const { message, repoPath, files } = req.body;
  try {
    validateRepo(repoPath);
    if (!isGitRepo(repoPath)) {
      return res.status(400).json({ error: "Commit is only available for Git repositories." });
    }
    if (!message) return res.status(400).json({ error: "Commit message required" });
    if (Array.isArray(files) && files.length > 0) {
      const quoted = files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');
      await run(`git add -- ${quoted}`, repoPath);
    } else {
      await run("git add .", repoPath);
    }
    const output = await run(`git commit -m "${message.replace(/"/g, '\\"')}"`, repoPath);
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/push", async (req, res) => {
  const { repoPath } = req.body;
  try {
    validateRepo(repoPath);
    if (!isGitRepo(repoPath)) {
      return res.status(400).json({ error: "Push is only available for Git repositories." });
    }
    const pushOut = await run("git push", repoPath);
    res.json({ success: true, output: pushOut });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/file-tree", async (req, res) => {
  const { repoPath } = req.query;
  try {
    validateRepo(repoPath);
    let files;
    if (isGitRepo(repoPath)) {
      const output = await run("git ls-files", repoPath);
      files = output.split('\n').filter(Boolean);
    } else {
      files = getFilesRecursive(repoPath);
    }
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.get("/api/file-read", async (req, res) => {
  const { repoPath, file } = req.query;
  console.log(`[file-read] repoPath=${repoPath} file=${JSON.stringify(file)}`);
  try {
    validateRepo(repoPath);
    if (!file) return res.status(400).json({ error: "No file specified" });
    const abs = path.resolve(repoPath, file);
    // Prevent path traversal outside the repo
    if (!abs.startsWith(path.resolve(repoPath))) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ error: `File not found: ${abs}` });
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Cannot edit a directory (submodule?)" });
    }
    if (stat.size > 2 * 1024 * 1024) {
      return res.status(400).json({ error: "File too large to edit (>2MB)" });
    }
    const content = fs.readFileSync(abs, "utf8");
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/file-raw", (req, res) => {
  const { repoPath, file } = req.query;
  try {
    validateRepo(repoPath);
    if (!file) return res.status(400).send("No file specified");
    const abs = path.resolve(repoPath, file);
    // Prevent path traversal outside the repo
    if (!abs.startsWith(path.resolve(repoPath))) {
      return res.status(403).send("Access denied");
    }
    if (!fs.existsSync(abs)) return res.status(404).send("File not found");
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return res.status(400).send("Cannot serve directory");
    }
    res.sendFile(abs);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.post("/api/file-write", async (req, res) => {
  const { repoPath, file, content } = req.body;
  try {
    validateRepo(repoPath);
    if (!file) return res.status(400).json({ error: "No file specified" });
    if (content === undefined) return res.status(400).json({ error: "No content provided" });
    const abs = path.resolve(repoPath, file);
    // Prevent path traversal outside the repo
    if (!abs.startsWith(path.resolve(repoPath))) {
      return res.status(403).json({ error: "Access denied" });
    }
    fs.writeFileSync(abs, content, "utf8");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/browse", async (req, res) => {
  const { path: browsePath } = req.query;
  try {
    const targetPath = browsePath ? path.resolve(browsePath) : os.homedir();
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: "Path not found" });

    const items = fs.readdirSync(targetPath).map(item => {
      const fullPath = path.join(targetPath, item);
      const stat = fs.statSync(fullPath);
      return {
        name: item,
        path: fullPath,
        isDirectory: stat.isDirectory()
      };
    });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/terminal" });

// Global map to persist terminal sessions across browser refreshes
const ptySessions = new Map();

wss.on("connection", (ws, req) => {
  const params = new URL(req.url, "http://localhost").searchParams;
  const repoPath = params.get("repoPath") || os.homedir();
  const cwd = fs.existsSync(repoPath) ? repoPath : os.homedir();
  const sessionId = params.get("sessionId");

  if (!sessionId) {
    ws.close();
    return;
  }

  let session = ptySessions.get(sessionId);

  if (!session) {
    // Pick a shell — check candidates in order
    const shellCandidates = [
      process.env.SHELL,
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ].filter(Boolean);

    const shell = shellCandidates.find(s => {
      try { return fs.existsSync(s) && fs.statSync(s).isFile(); } catch { return false; }
    }) || "/bin/sh";

    console.log(`[term] new session ${sessionId} shell=${shell} cwd=${cwd}`);

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (err) {
      console.error("[term] spawn failed:", err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
        ws.close();
      }
      return;
    }

    session = {
      pty: ptyProcess,
      log: [], // Store recent output to replay on refresh
      ws: null,
      lastHasChildren: null,
      interval: null
    };
    ptySessions.set(sessionId, session);

    ptyProcess.onData(data => {
      // Keep only last ~200 chunks to prevent memory bloat, but enough to restore screen
      session.log.push(data);
      if (session.log.length > 200) session.log.shift();
      
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(data);
      }
    });

    session.interval = setInterval(() => {
      try {
        const stdout = require('child_process').execSync(`pgrep -P ${ptyProcess.pid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const hasChildren = stdout.length > 0;
        if (hasChildren !== session.lastHasChildren) {
          session.lastHasChildren = hasChildren;
          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(`GROOVE_CTRL_MSG:{"type":"processStatus","hasChildren":${hasChildren}}`);
          }
        }
      } catch (e) {
        if (session.lastHasChildren !== false) {
          session.lastHasChildren = false;
          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(`GROOVE_CTRL_MSG:{"type":"processStatus","hasChildren":false}`);
          }
        }
      }
    }, 1000);

    ptyProcess.onExit(() => {
      clearInterval(session.interval);
      ptySessions.delete(sessionId);
      if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.close();
    });
  } else {
    console.log(`[term] reconnected session ${sessionId}`);
  }

  // Bind the current websocket to the session
  session.ws = ws;

  // Replay history to restore screen
  if (session.log.length > 0) {
    ws.send(session.log.join(''));
  }
  
  // Send current process status
  if (session.lastHasChildren !== null) {
    ws.send(`GROOVE_CTRL_MSG:{"type":"processStatus","hasChildren":${session.lastHasChildren}}`);
  }

  ws.on("message", msg => {
    try {
      const d = JSON.parse(msg);
      if (d.type === "input")  session.pty.write(d.data);
      if (d.type === "resize") session.pty.resize(d.cols, d.rows);
      if (d.type === "close") {
        clearInterval(session.interval);
        try { session.pty.kill(); } catch {}
        ptySessions.delete(sessionId);
      }
    } catch {
      session.pty.write(msg);
    }
  });

  ws.on("close", () => {
    // Only detach the ws, don't kill the PTY so it survives refresh
    if (session.ws === ws) {
      session.ws = null;
    }
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use.\nRun: lsof -ti :${PORT} | xargs kill -9\n`);
    process.exit(1);
  } else throw e;
});

server.listen(PORT, "0.0.0.0", () => {
  const interfaces = os.networkInterfaces();
  let tailscaleIP = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && iface.address.startsWith("100.")) tailscaleIP = iface.address;
    }
  }
  console.log(`Groove running at http://localhost:${PORT}`);
  if (tailscaleIP) console.log(`Groove on Tailscale: http://${tailscaleIP}:${PORT}`);
});
