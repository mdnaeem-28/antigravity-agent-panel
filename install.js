#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execSync } = require('child_process');

const daemonPath = path.join(__dirname, 'daemon.js');
const home = os.homedir();
const PORT = 4747;

console.log('🚀 Installing Antigravity Native Agent Panel...');

function stopExistingDaemon() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/stop',
        method: 'POST',
        timeout: 1500,
      },
      () => {
        setTimeout(resolve, 600);
      }
    );
    req.on('error', () => {
      // If server wasn't running or didn't answer, try OS process cleanup
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
      setTimeout(resolve, 300);
    });
    req.end();
  });
}

async function run() {
  // 1. Stop any old instance so port 4747 is free
  await stopExistingDaemon();

  // 2. Register OS-specific auto-start on login
  if (process.platform === 'win32') {
    const startupDir = path.join(
      process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup'
    );
    const vbsPath = path.join(startupDir, 'AntigravityAgentPanel.vbs');
    const escapedDaemon = daemonPath.replace(/"/g, '""');
    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run "node.exe ""${escapedDaemon}""", 0, False`,
      '',
    ].join('\r\n');
    fs.mkdirSync(startupDir, { recursive: true });
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    console.log('✔ Registered Windows Startup launcher:', vbsPath);
  } else if (process.platform === 'darwin') {
    const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
    const plistPath = path.join(launchAgentsDir, 'com.antigravity.agent-panel.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.antigravity.agent-panel</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${daemonPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.writeFileSync(plistPath, plist, 'utf8');
    console.log('✔ Registered macOS LaunchAgent:', plistPath);
  } else {
    const autostartDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart');
    const desktopPath = path.join(autostartDir, 'antigravity-agent-panel.desktop');
    const desktop = `[Desktop Entry]
Type=Application
Name=Antigravity Agent Panel
Exec=${process.execPath} "${daemonPath}"
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(desktopPath, desktop, 'utf8');
    console.log('✔ Registered Linux Autostart entry:', desktopPath);
  }

  // 3. Spawn daemon in background
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // 4. Verify daemon started
  setTimeout(() => {
    http.get(`http://127.0.0.1:${PORT}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('✔ Antigravity Agent Panel daemon is active (http://127.0.0.1:4747).');
        console.log('✔ Pinned natively inside Google Antigravity directly above the prompt box!');
      });
    }).on('error', () => {
      console.log('✔ Daemon launched. It will attach automatically whenever Google Antigravity is open.');
    });
  }, 1000);
}

run();
