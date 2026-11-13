/**
 * The app's icons, made from the logo the repository shows (docs/assets/logo.svg) — so that the app in the Dock, the
 * taskbar and the window looks like the project on GitHub.
 *
 *   apps/desktop/node_modules/.bin/electron scripts/make-icons.cjs        (or: pnpm icons)
 *
 * Writes apps/desktop/electron/icons/:
 *   icon.icns  macOS — the tile on Apple's grid: 824 of 1024 with a soft shadow under it, as macOS icons are drawn
 *   icon.ico   Windows — 16 to 256 px, the tile filling the square as Windows icons do
 *   icon.png   512 px, for the window itself on Linux and Windows and the Dock while running from the repository
 *
 * Run with Electron because its Chromium draws the SVG exactly as a browser does, at every size, from the vector —
 * nothing to install. `iconutil` (macOS) packs the .icns; the .ico is packed here (PNG entries, Windows Vista on).
 * The results are committed: packaging and running only read them. Run this again when the logo changes.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'docs/assets/logo.svg'), 'utf8');
const out = path.join(root, 'apps/desktop/electron/icons');

/** In the page: the logo drawn onto a canvas of `size`, in one of two layouts. Returns PNG bytes as base64. */
function draw(size, layout) {
  return `(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (${JSON.stringify(layout)} === 'mac') {
      // Apple's grid: the body of an icon is 824 of 1024, centred, with a soft shadow below it. The logo's tile is 464
      // of its 512 (from 24 to 488), so the logo is drawn to put that tile on the grid.
      const k = ${size} / 1024, scale = (824 * k) / 464, at = 100 * k - 24 * scale;
      g.shadowColor = 'rgba(0, 0, 0, 0.28)';
      g.shadowBlur = 28 * k;
      g.shadowOffsetY = 12 * k;
      g.drawImage(img, at, at, 512 * scale, 512 * scale);
    } else {
      g.drawImage(img, 0, 0, ${size}, ${size});
    }
    return c.toDataURL('image/png').split(',')[1];
  })()`;
}

/** An .ico of PNG entries: header, one 16-byte entry per image, then the images. */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  const png = async (size, layout) => Buffer.from(await win.webContents.executeJavaScript(draw(size, layout)), 'base64');
  fs.mkdirSync(out, { recursive: true });

  // macOS
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-icons-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const base of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${base}x${base}.png`), await png(base, 'mac'));
    fs.writeFileSync(path.join(set, `icon_${base}x${base}@2x.png`), await png(base * 2, 'mac'));
  }
  if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]);
  else console.log('icon.icns is made on macOS only (iconutil); left as it is');
  fs.rmSync(path.dirname(set), { recursive: true, force: true });

  // Windows
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const images = [];
  for (const size of sizes) images.push({ size, data: await png(size, 'square') });
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(images));

  // The window, and the Dock while running from the repository
  fs.writeFileSync(path.join(out, 'icon.png'), await png(512, 'square'));
  fs.writeFileSync(path.join(out, 'icon-mac.png'), await png(1024, 'mac'));

  for (const f of fs.readdirSync(out).sort()) console.log(`${path.relative(root, path.join(out, f))}  ${fs.statSync(path.join(out, f)).size} bytes`);
  app.exit(0);
});
