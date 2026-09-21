# Groove

A self-hosted, browser-based Git client with a built-in terminal. Run it on your Mac, then access it from any device on your [Tailscale](https://tailscale.com) network — including your phone.

![PWA](https://img.shields.io/badge/PWA-installable-blue)

## What it does

- Browse all Git repos found in your home directories (Desktop, Documents, Downloads, etc.)
- View repo status, current branch, last commit, and diffs
- Edit files directly in the browser
- Stage, commit, and push changes
- Open a full interactive terminal scoped to any repo
- Installable as a PWA on mobile and desktop

## Requirements

- [Node.js](https://nodejs.org) v18+
- [Tailscale](https://tailscale.com) installed and connected on the host machine (for remote access)
- Git configured with push access to your remotes

## Setup

```bash
git clone https://github.com/elvisthebuilder/Groove.git
cd Groove
npm install
```

### Option A: Desktop Companion App (Recommended)
Run Groove as a lightweight System Tray / Menu Bar app with instant Mobile QR Pairing and Auto-Start on boot:

```bash
npm run desktop
```
- Lives in your system tray / menu bar.
- Auto-starts the server and restarts if needed.
- Shows a scannable QR Code to pair your phone instantly.
- Toggle "Auto-start on Boot" to keep your PC always accessible.

### Option B: Headless Terminal Server
Run directly in the console:

```bash
npm start
```

The server starts on port `9000` and binds to all interfaces (`0.0.0.0`).

## Accessing it

**Locally:**
```
http://localhost:9000
```

**From another device via Tailscale:**
```
http://<tailscale-ip>:9000
```

Your Tailscale IP is printed in the terminal when the server starts. It's also shown in the app's UI. Tailscale IPs always start with `100.x.x.x`.

To find your Tailscale IP manually:
```bash
tailscale ip -4
```

## Install as a PWA

On mobile (iOS/Android) or desktop, open the app in your browser and use "Add to Home Screen" / "Install app" to get a native-like experience with no browser chrome.

## Port conflict

If port `9000` is already in use:
```bash
lsof -ti :9000 | xargs kill -9
```

## Security note

The server has no authentication. It exposes your filesystem and a live terminal. Only run it on a trusted network or behind Tailscale — do not expose it to the public internet.
