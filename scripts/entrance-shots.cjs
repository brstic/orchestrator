// The pictures the entrance page shows (apps/desktop/src/entrance/shots/), taken from a made-up office:
//
//   node scripts/entrance-office.ts --room          # prints {"owner": …}; start it fresh, its people are busiest in their first minutes
//   <electron> scripts/entrance-shots.cjs <owner-url> apps/desktop/src/entrance/shots
//
// (<electron> is apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron on a Mac.)
//
// Every picture is the real app showing that office — its people, their tags and states, its panels. Nothing is drawn
// over them; the camera is held at fixed places through `window.__orchScene.cam` and panels are opened the way the
// page's own buttons open them. One thing in the office is changed, for the last picture: a foreman is hired (so run
// this once per office). The window is 1600 × 1000 and drawn at two device pixels to one (whatever screen this
// computer has); each picture is saved as WebP, 1800 pixels wide. `--png` also keeps the full-size PNGs beside them
// (not for the repository).
//
// What is in them is invented: the company, the people, the project. Never point this at a real office.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keepPng = process.argv.includes('--png');
/** Only the last picture (the foreman), for an office the others were already taken from. */
const foremanOnly = process.argv.includes('--foreman-only');
const [url, outDir] = args;
if (!url || !outDir) {
  console.error('usage: electron scripts/entrance-shots.cjs <owner-url> <out-dir> [--png] [--foreman-only]');
  process.exit(2);
}
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTH = 1800;

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  // A second page with nothing on it, only to turn a picture into WebP (Electron itself writes PNG and JPEG).
  const press = new BrowserWindow({ width: 200, height: 200, show: false });
  await press.loadURL('about:blank');
  win.webContents.setAudioMuted(true);
  const js = (code) =>
    win.webContents.executeJavaScript(code, true).catch((e) => {
      throw new Error(`${e.message} — in: ${code.slice(0, 120)}`);
    });
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await js(`(() => { try { return !!(${code}); } catch (e) { return false; } })()`).catch(() => false)) return;
      if (Date.now() > end) throw new Error(`timed out: ${code}`);
      await sleep(150);
    }
  };
  const office = (code) => js(`(() => { const s = window.__office.getState(); const who = (n) => Object.values(s.employees).find((e) => e.name === n); ${code}; return true; })()`);
  // Twice the pixels, asked of the page itself: a screen that is not a high-density one would otherwise decide.
  await win.loadURL('about:blank');
  const dev = win.webContents.debugger;
  dev.attach('1.3');
  const metrics = () => dev.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  const shot = async (name) => {
    const { data } = await dev.sendCommand('Page.captureScreenshot', { format: 'png' });
    const full = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
    if (full.getSize().width < 3000) throw new Error(`the picture is only ${full.getSize().width} pixels wide: the page was not drawn at twice the size`);
    if (keepPng) fs.writeFileSync(path.join(outDir, `${name}.png`), full.toPNG());
    const size = full.getSize();
    const small = full.resize({ width: WIDTH, height: Math.round((size.height * WIDTH) / size.width), quality: 'best' });
    const webp = await press.webContents.executeJavaScript(
      `new Promise((done, fail) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); done(c.toDataURL('image/webp', 0.84)); }; i.onerror = () => fail(new Error('no picture')); i.src = ${JSON.stringify(small.toDataURL())}; })`,
      true,
    );
    const bytes = Buffer.from(webp.split(',')[1], 'base64');
    fs.writeFileSync(path.join(outDir, `${name}.webp`), bytes);
    console.log(`${name}.webp  ${nativeImage.createFromBuffer(small.toPNG()).getSize().width}×${small.getSize().height}  ${(bytes.length / 1024).toFixed(0)} kB`);
  };
  const cam = (pos, look, fov) => js(`window.__orchScene.cam = ${JSON.stringify({ pos, look, fov })}; true`);
  try {
    await metrics();
    await win.loadURL(url);
    await metrics();
    await until(`window.__office && window.__office.getState().layout && window.__orchScene && document.querySelector('canvas')`);
    // The best this computer draws: these are pictures, not a working session.
    await until(`window.__orchPrefs.getState().ready`);
    await js(`window.__orchPrefs.setState((s) => ({ prefs: { ...s.prefs, quality: 'high' } })); true`);
    await sleep(5000);

    if (!foremanOnly) {
      // People at their desks, each under the tag of what their session is doing.
      await cam([-5.6, 2.9, 4.6], [-11.2, 0.9, -0.6], 40);
      await sleep(2200);
      await shot('desks');

      // Somebody's terminal, as the office shows it when you sit down there.
      await office(`s.enterWorkstation(who('Alex').id)`);
      await until(`document.querySelector('.xterm')`, 15000);
      await sleep(3500);
      await shot('terminal');
      await office(`s.leaveWorkstation(); s.selectEmployee(null)`);
      await sleep(800);

      // What waits for the owner: a question, a permission request, somebody blocked.
      await js(`[...document.querySelectorAll('button')].find((b) => /Inbox/.test(b.textContent)).click(); true`);
      await sleep(1800);
      await shot('hand');
      await office(`s.openPanel(null)`);

      // The board.
      await office(`s.openPanel('tasks')`);
      await sleep(2200);
      await shot('board');
      await office(`s.openPanel(null)`);

      // A member's room: their own computer's employees, beside the office's floor.
      const room = await js(`(() => { const r = (window.__orchScene.memberRooms || [])[0]; return r ? JSON.stringify(r) : null; })()`);
      if (room) {
        // From above its open side, so that no wall of the office stands in the way.
        const r = JSON.parse(room);
        const cx = r.x + r.w / 2;
        const cz = r.z + r.d / 2;
        await cam([cx - 1.5, 7.5, cz + 9.3], [cx, 0.6, cz], 40);
        await sleep(2500);
        await shot('room');
      } else console.log('room: this office has no member connected — start it with --room');

      // The break room.
      await cam([20.6, 3.3, 3.6], [13.2, 0.9, -2.2], 48);
      await sleep(2500);
      await shot('lounge');

      // And the office's own view from above, with who needs the owner.
      await js(`delete window.__orchScene.cam; window.__office.getState().setCameraMode('command'); true`);
      await sleep(4500);
      await shot('command');
    }

    // Last, because it changes the office: a foreman is hired, and photographed on its first round.
    await js(`window.__office.getState().setCameraMode('follow'); true`);
    const hired = await js(
      `(async () => { const s = window.__office.getState(); const p = Object.values(s.projects).find((x) => !Object.values(s.hosts).find((h) => h.id === x.hostId)?.memberId); const r = await fetch('/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('orch.token') }, body: JSON.stringify({ name: 'Mira', roleKey: 'foreman', workingDir: p.repoPath.split('/').slice(0, -1).join('/'), hostId: p.hostId }) }); return r.ok ? (await r.json()).id : null; })()`,
    );
    if (!hired) throw new Error('the foreman could not be hired (does this office have one already?)');
    await cam([-5.6, 2.9, 4.6], [-11.2, 0.9, -0.6], 40);
    // On a round its tag says what the round is about, or whom it is with (between rounds: "walking the floor").
    await until(`(() => { const t = (document.querySelector('.tag-foreman-doing')?.textContent ?? '').trim(); return t.length > 2 && !/walking the floor/.test(t); })()`, 60000).catch(() => console.log('foreman: no round started in time; photographed as it stands'));
    await sleep(900);
    // From above the desks it is at, so that whatever stands on the floor nearby is not in the way.
    const at = JSON.parse(await js(`JSON.stringify(window.__orchScene.where(${JSON.stringify(hired)}) ?? null)`));
    if (at) await cam([at.x + 3.4, 4.5, at.z + 5.0], [at.x - 0.5, 0.9, at.z - 0.7], 38);
    await sleep(700);
    await shot('foreman');
  } catch (e) {
    console.error(String(e && e.message));
    process.exitCode = 1;
  }
  app.quit();
});
