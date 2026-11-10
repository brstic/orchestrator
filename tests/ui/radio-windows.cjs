/**
 * Two office windows for tests/ui/radio-app.mjs, each with its own storage: one that may start sound by itself
 * (as the desktop app's office window does) and one that wants a click first (as a browser tab does).
 *   electron radio-windows.cjs --remote-debugging-port=<n> <office url> <user data folder>
 */
const { app, BrowserWindow } = require('electron');

const url = process.argv.find((a) => /^https?:\/\//.test(a));
const userData = process.argv[process.argv.length - 1];
app.setPath('userData', userData);

app.whenReady().then(async () => {
  for (const [tag, autoplayPolicy] of [
    ['app', 'no-user-gesture-required'],
    ['tab', 'document-user-activation-required'],
  ]) {
    const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { backgroundThrottling: false, partition: `radio-${tag}`, autoplayPolicy } });
    win.webContents.setAudioMuted(true); // nobody hears the test
    await win.loadURL(url);
    await win.webContents.executeJavaScript(`window.__tag = ${JSON.stringify(tag)}; true`);
  }
});
app.on('window-all-closed', () => app.quit());
