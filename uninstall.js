#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');

const home = os.homedir();
const PORT = 4747;

console.log('🛑 Uninstalling Antigravity Native Agent Panel...');

// 1. Remove OS-specific startup entries
if (process.platform === 'win32') {
  const vbsPath = path.join(
    process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'AntigravityAgentPanel.vbs'
  );
  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath);
    console.log('✔ Removed Windows Startup launcher:', vbsPath);
  }
} else if (process.platform === 'darwin') {
  const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.antigravity.agent-panel.plist');
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    console.log('✔ Removed macOS LaunchAgent:', plistPath);
  }
} else {
  const desktopPath = path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'autostart',
    'antigravity-agent-panel.desktop'
  );
  if (fs.existsSync(desktopPath)) {
    fs.unlinkSync(desktopPath);
    console.log('✔ Removed Linux Autostart entry:', desktopPath);
  }
}

// 2. Remove DOM panel from open Antigravity windows if running
const portFile = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort')
  : process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Antigravity', 'DevToolsActivePort');

if (fs.existsSync(portFile)) {
  try {
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0], 10);
    if (port > 0) {
      http.get(`http://127.0.0.1:${port}/json`, { timeout: 1000 }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const targets = JSON.parse(body);
            for (const t of targets) {
              if (t.type === 'page' && t.webSocketDebuggerUrl) {
                const ws = new WebSocket(t.webSocketDebuggerUrl);
                ws.onopen = () => {
                  ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                      expression: `(() => {
                        const p = document.getElementById('ag-native-agent-panel');
                        if (p) p.remove();
                        const s = document.getElementById('ag-native-panel-style');
                        if (s) s.remove();
                      })()`,
                    },
                  }));
                  setTimeout(() => ws.close(), 150);
                };
              }
            }
          } catch {}
        });
      }).on('error', () => {});
    }
  } catch {}
}

// 3. Stop background daemon
const stopReq = http.request(
  {
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/stop',
    method: 'POST',
    timeout: 1000,
  },
  () => {
    console.log('✔ Background daemon stopped.');
  }
);
stopReq.on('error', () => {
  try {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      );
    } else {
      execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore', shell: true });
    }
  } catch {}
});
stopReq.end();

console.log('✔ Uninstall complete.');
