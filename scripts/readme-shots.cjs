// Pictures of the office for the README, taken from a running office (a development office will do):
//
//   node scripts/dev-office.ts --port 4750 --ui apps/desktop/dist      # prints {"url": …}
//   <electron> scripts/readme-shots.cjs <url-with-token> <out-dir>
//
// The camera is held at fixed places through `window.__orchScene.cam`; nothing in the office is changed. What is
// in the pictures is what the office shows: its people, their name tags and states, the top bar.
// `scripts/readme-art.cjs` then makes the banner and the framed pictures from these.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) {
  console.error('usage: electron scripts/readme-shots.cjs <url-with-token> <out-dir>');
  process.exit(2);
}
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where the camera stands and what it looks at, in the default layout. `mode`: a camera of the office itself instead. */
const SHOTS = [
  { name: 'floor', pos: [3.5, 7.2, 13.5], look: [-10, 0.6, -1.5], fov: 42 },
  { name: 'desks', pos: [-5.6, 2.9, 4.6], look: [-11.2, 0.9, -0.6], fov: 40 },
  { name: 'desks-low', pos: [-13.2, 1.9, 3.6], look: [-12.6, 1.05, -0.4], fov: 46 },
  { name: 'meeting', pos: [-2.2, 3.4, -7.4], look: [-7.2, 0.9, -11.4], fov: 46 },
  { name: 'ops', pos: [8.6, 3.0, -7.6], look: [3.4, 1.4, -13.6], fov: 48 },
  { name: 'server', pos: [11.2, 3.0, -7.4], look: [17, 1.2, -12.5], fov: 48 },
  { name: 'ceo', pos: [-13.2, 3.1, -7.4], look: [-18.2, 1.0, -12.2], fov: 46 },
  { name: 'break', pos: [20.6, 3.3, 3.6], look: [13.2, 0.9, -2.2], fov: 48 },
  { name: 'reception', pos: [21, 3.4, 14], look: [14.5, 0.8, 7.5], fov: 46 },
  { name: 'overview', pos: [27, 31, 35], look: [0, 0, -1.5], fov: 36 },
  { name: 'hall', pos: [-21, 2.4, -5.2], look: [0, 1.4, -5.4], fov: 52 },
];

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await js(`(() => { try { return !!(${code}); } catch (e) { return false; } })()`).catch(() => false)) return;
      if (Date.now() > end) throw new Error(`timed out: ${code}`);
      await sleep(150);
    }
  };
  try {
    await win.loadURL(url);
    await until(`window.__office && window.__office.getState().layout && window.__orchScene && document.querySelector('canvas')`);
    // The best this computer draws: these are pictures, not a working session.
    await until(`window.__orchPrefs.getState().ready`);
    await js(`window.__orchPrefs.setState((s) => ({ prefs: { ...s.prefs, quality: 'high' } })); true`);
    await sleep(6000);
    for (const s of SHOTS) {
      await js(`window.__orchScene.cam = ${JSON.stringify({ pos: s.pos, look: s.look, fov: s.fov })}; true`);
      await sleep(1800);
      fs.writeFileSync(path.join(outDir, `${s.name}.png`), (await win.webContents.capturePage()).toPNG());
      console.log(s.name);
    }
    // And the office's own top-down view, with its panel: what needs the owner, everyone, the machines.
    await js(`delete window.__orchScene.cam; window.__office.getState().setCameraMode('command'); true`);
    await sleep(4500);
    fs.writeFileSync(path.join(outDir, 'command.png'), (await win.webContents.capturePage()).toPNG());
    console.log('command');
  } catch (e) {
    console.error(String(e && e.message));
    process.exitCode = 1;
  }
  app.quit();
});
