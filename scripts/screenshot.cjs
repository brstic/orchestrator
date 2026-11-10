// Renders the office UI in a hidden Electron window and saves screenshots.
//   electron scripts/screenshot.cjs <url> <out-dir> [steps.json]
// A step is { name, wait, js? }: run `js` in the page (the store is at window.__office), wait, capture.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [url, outDir, stepsFile] = process.argv.slice(2);
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [{ name: 'office', wait: 6000 }];
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { backgroundThrottling: false } });
  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) logs.push(message);
  });
  await win.loadURL(url);
  fs.mkdirSync(outDir, { recursive: true });
  for (const step of steps) {
    if (step.js) await win.webContents.executeJavaScript(step.js).catch((e) => logs.push(`step ${step.name}: ${e.message}`));
    await new Promise((r) => setTimeout(r, step.wait ?? 1500));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${step.name}.png`), img.toPNG());
  }
  if (logs.length) console.log('PAGE ERRORS:\n' + [...new Set(logs)].slice(0, 20).join('\n'));
  app.quit();
});
