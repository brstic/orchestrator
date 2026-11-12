// electron mp-host.cjs <url> : one window of the office on this computer, drivable from outside (CDP on 9444).
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', '9444');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 950, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  await win.loadURL(process.argv[2]);
  win.webContents.setZoomFactor(1);
  win.webContents.focus();
});
app.on('window-all-closed', () => app.quit());
