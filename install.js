#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const daemonPath = path.join(__dirname, 'daemon.js');
const home = os.homedir();

console.log('Installing Antigravity Native Agent Panel...');

// 1. Register OS-specific auto-start on login
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

// 2. Spawn daemon in the background immediately
const child = spawn(process.execPath, [daemonPath], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

console.log('✔ Antigravity Agent Panel daemon started in the background (http://127.0.0.1:4747).');
console.log('✔ Open Google Antigravity — the panel is now pinned directly above the chat input box!');
