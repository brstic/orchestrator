// A character sheet: every hair style with every accessory, every outfit on three skin tones, the seated and
// standing poses, and the same people small — captured from a running office (a development office will do).
//
//   <electron> scripts/character-sheet.cjs <url-with-token> <out-dir> [set,set…]
//
// Sets: hair, outfits, busts, faces, poses, small (default: all of these), and flicker (a count, not pictures). The figures are stood on the open floor through
// `window.__orchScene.lineup` (see packages/office-3d/src/character/Lineup.tsx) and looked at with a held camera
// (`window.__orchScene.cam`); nothing in the office itself is changed.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [url, outDir, only] = process.argv.slice(2);
if (!url || !outDir) {
  console.error('usage: electron scripts/character-sheet.cjs <url> <out-dir> [hair,outfits,busts,faces,poses,small]');
  process.exit(2);
}
const sets = new Set((only || 'hair,outfits,busts,faces,poses,small').split(','));

/** Where the figures stand: the empty carpet at the south end of the default layout's engineering floor. */
const AT = { x: -2, z: 8.8 };

const SKINS = ['#ffdbac', '#c68642', '#8d5524'];
const HAIRS = ['#2c1b10', '#b5651d', '#0f0f0f', '#d9b380', '#6b6b6b'];
const SHIRTS = ['#4f8cff', '#ff8c5a', '#5ad67d', '#f5c542', '#8f7bff', '#e6d3a3', '#ff5d73', '#3fd0c9'];
const STYLES = ['short', 'long', 'bun', 'curly', 'bald'];
const ACCESSORIES = ['none', 'glasses', 'headphones', 'cap'];
const OUTFITS = ['polo', 'shirt', 'tee', 'sweater'];
const ANGLES = { front: 0, quarter: 0.7, side: Math.PI / 2, back: Math.PI };

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** The outfit follows from the look (see `look3d` in Character.tsx): nudge the trouser colour until it is the one wanted. */
function dressed(a, outfit) {
  if (outfit === 'suit') return a;
  const base = parseInt(a.pants.slice(1), 16);
  for (let i = 0; i < 64; i++) {
    const pants = '#' + ((base & 0xffffc0) | i).toString(16).padStart(6, '0');
    const seed = hash(`${a.skin}${a.hair}${a.shirt}${pants}${a.hairStyle}${a.accessory}`);
    if (OUTFITS[seed % OUTFITS.length] === outfit) return { ...a, pants };
  }
  return a;
}
const person = (i, over = {}) => ({ skin: SKINS[i % 3], hair: HAIRS[i % 5], hairStyle: STYLES[i % 5], shirt: SHIRTS[i % 8], pants: '#27364a', accessory: 'none', build: 1, ...over });
/** A row of figures centred on the spot, `gap` apart, all turned by `rot`. */
const row = (looks, gap, rot, extra = () => ({})) => looks.map((appearance, i) => ({ appearance, x: AT.x + (i - (looks.length - 1) / 2) * gap, z: AT.z, rot, ...extra(i) }));

const shots = [];
const cam = (dist, y, fov, lookY = y) => ({ pos: [AT.x, y, AT.z + dist], look: [AT.x, lookY, AT.z], fov });

if (sets.has('hair')) {
  for (const accessory of ACCESSORIES) {
    for (const [angle, rot] of Object.entries(ANGLES)) {
      shots.push({ name: `hair-${accessory}-${angle}`, size: [2100, 620], cam: cam(3.4, 1.64, 11), lineup: row(STYLES.map((hairStyle, i) => person(i, { hairStyle, accessory })), 0.44, rot) });
    }
  }
}
if (sets.has('outfits')) {
  SKINS.forEach((skin, s) => {
    const looks = [...OUTFITS, 'suit'].map((outfit, i) => dressed(person(i + s * 2, { skin, shirt: outfit === 'suit' ? ['#2b3c66', '#3a3f4a', '#4a3b33'][s] : SHIRTS[(i + s * 3) % 8], pants: outfit === 'suit' ? ['#2b3c66', '#3a3f4a', '#4a3b33'][s] : ['#27364a', '#4a4238', '#3b3f5c'][(i + s) % 3], hairStyle: STYLES[(i + s) % 5], build: [0.92, 1, 1.08, 0.96, 1.03][i] }), outfit));
    for (const [angle, rot] of Object.entries(ANGLES)) {
      shots.push({ name: `outfit-${s + 1}-${angle}`, size: [1500, 940], cam: cam(5.6, 1.0, 24), lineup: row(looks, 0.7, rot, (i) => ({ level: i === 4 ? 9 : 1 })) });
    }
  });
}
if (sets.has('busts')) {
  // Collars, shoulders and sleeves, close.
  const looks = [...OUTFITS, 'suit'].map((outfit, i) => dressed(person(i, { shirt: outfit === 'suit' ? '#2b3c66' : SHIRTS[i], pants: outfit === 'suit' ? '#2b3c66' : '#27364a', hairStyle: ['short', 'bun', 'bald', 'short', 'short'][i] }), outfit));
  for (const [angle, rot] of Object.entries(ANGLES)) {
    shots.push({ name: `busts-${angle}`, size: [2100, 760], cam: cam(4.6, 1.38, 13.5, 1.36), lineup: row(looks, 0.56, rot, (i) => ({ level: i === 4 ? 9 : 1 })) });
  }
}
if (sets.has('faces')) {
  for (const [angle, rot] of [['front', 0], ['quarter', 0.7], ['side', Math.PI / 2]]) {
    shots.push({ name: `faces-${angle}`, size: [1800, 760], cam: cam(2.2, 1.66, 12), lineup: row([0, 1, 2].map((i) => person(i, { hairStyle: ['short', 'long', 'bald'][i], accessory: 'none' })), 0.42, rot) });
  }
}
if (sets.has('poses')) {
  const poses = ['typing', 'reading', 'thinking', 'raiseHand', 'talking', 'offline', 'stand', 'doze'];
  for (const [angle, rot] of [['front', 0], ['side', Math.PI / 2], ['back', Math.PI]]) {
    shots.push({
      name: `poses-${angle}`,
      size: [2000, 800],
      cam: cam(5.9, 0.95, 21),
      lineup: row(poses.map((_p, i) => dressed(person(i + 1, { hairStyle: STYLES[i % 5] }), [...OUTFITS, 'suit'][i % 5])), 0.85, rot, (i) => ({ pose: poses[i], level: i % 5 === 4 ? 9 : 1, offline: poses[i] === 'offline' || poses[i] === 'doze' })),
    });
  }
}
if (sets.has('small')) {
  // As the everyday overhead camera sees people: 60–90 pixels tall.
  const looks = Array.from({ length: 10 }, (_v, i) => dressed(person(i, { accessory: ACCESSORIES[i % 4] }), [...OUTFITS, 'suit'][i % 5]));
  shots.push({ name: 'small-front', size: [1500, 940], png: true, cam: { pos: [AT.x + 1, 7.5, AT.z + 9], look: [AT.x, 0.9, AT.z], fov: 50 }, lineup: row(looks, 0.9, 0, (i) => ({ level: i % 5 === 4 ? 9 : 1 })) });
  shots.push({ name: 'small-back', size: [1500, 940], png: true, cam: { pos: [AT.x + 1, 7.5, AT.z + 9], look: [AT.x, 0.9, AT.z], fov: 50 }, lineup: row(looks, 0.9, Math.PI, (i) => ({ level: i % 5 === 4 ? 9 : 1 })) });
}
if (sets.has('flicker')) {
  // Not pictures but a count: pixels that change and change back between frames while nothing but the figures'
  // own slow movement (breathing, a blink) changes — layers fighting for the same depth, fine detail shimmering.
  // Each view is counted once without the figures (what the office behind them does by itself) and once with them.
  const looks = Array.from({ length: 10 }, (_v, i) => dressed(person(i, { accessory: ACCESSORIES[i % 4] }), [...OUTFITS, 'suit'][i % 5]));
  const ten = row(looks, 0.9, 0, (i) => ({ level: i % 5 === 4 ? 9 : 1 }));
  const views = {
    close: cam(2.2, 1.66, 12),
    mid: cam(5.6, 1.0, 24),
    overhead: { pos: [AT.x + 1, 7.5, AT.z + 9], look: [AT.x, 0.9, AT.z], fov: 50 },
    far: { pos: [AT.x + 3, 13, AT.z + 26], look: [AT.x, 0.9, AT.z], fov: 50 },
  };
  for (const [name, c] of Object.entries(views)) {
    const lineup = name === 'close' ? row(looks.slice(0, 5), 0.44, 0) : name === 'mid' ? row(looks.slice(0, 5), 0.7, 0, (i) => ({ level: i === 4 ? 9 : 1 })) : ten;
    shots.push({ name: `flicker-${name}-empty`, size: [1500, 940], cam: c, lineup: null, frames: 14, wait: 1500 });
    shots.push({ name: `flicker-${name}`, size: [1500, 940], cam: c, lineup, frames: 14, wait: 2500 });
    // And held still: what is left is not their movement.
    shots.push({ name: `flicker-${name}-still`, size: [1500, 940], cam: c, lineup: lineup.map((e) => ({ ...e, still: true })), frames: 14, wait: 2500 });
  }
}

/** Pixels that differ clearly from the frame before and are back to it in the frame after, averaged over the frames. */
function flicker(frames, width, mask) {
  let total = 0;
  // (Where it happens, as a picture: the first frame, dimmed, with every such pixel marked.)
  if (mask) for (let i = 0; i < mask.length; i += 4) for (let k = 0; k < 3; k++) mask[i + k] = mask[i + k] * 0.4;
  for (let t = 1; t < frames.length - 1; t++) {
    const a = frames[t - 1];
    const b = frames[t];
    const c = frames[t + 1];
    for (let i = 0; i < b.length; i += 4) {
      const d = Math.max(Math.abs(b[i] - a[i]), Math.abs(b[i + 1] - a[i + 1]), Math.abs(b[i + 2] - a[i + 2]));
      if (d < 24) continue;
      if (Math.max(Math.abs(c[i] - a[i]), Math.abs(c[i + 1] - a[i + 1]), Math.abs(c[i + 2] - a[i + 2])) < 8) {
        total++;
        if (mask) {
          mask[i] = mask[i + 2] = 255;
          mask[i + 1] = 0;
        }
      }
    }
  }
  return Math.round(total / (frames.length - 2)) + ' px/frame of ' + (frames[0].length / 4) + ' (' + width + ' wide)';
}

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 940, show: false, webPreferences: { backgroundThrottling: false } });
  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) logs.push(message);
  });
  const run = (js) => win.webContents.executeJavaScript(js, true).catch((e) => logs.push(e.message));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await win.loadURL(url);
  fs.mkdirSync(outDir, { recursive: true });
  await sleep(7000);
  // The owner's own character out of the picture, the overlays hidden.
  await run(`(document.querySelector('.hud')||{style:{}}).style.display='none'; window.__orchPlayer.goto={x:16,z:13.4,rot:Math.PI}; true`);
  let size = '';
  for (const s of shots) {
    if (s.size.join('x') !== size) {
      win.setContentSize(s.size[0], s.size[1]);
      size = s.size.join('x');
      await sleep(700);
    }
    await run(`window.__orchScene.lineup=${JSON.stringify(s.lineup)}; window.__orchScene.cam=${JSON.stringify(s.cam)}; true`);
    await sleep(s.wait ?? 1100);
    if (s.frames) {
      const frames = [];
      let size0 = null;
      for (let k = 0; k < s.frames; k++) {
        const shot = await win.webContents.capturePage();
        size0 = shot.getSize();
        frames.push(shot.toBitmap());
      }
      const mask = Buffer.from(frames[0]);
      console.log(`${s.name}: ${flicker(frames, s.size[0], mask)}`);
      fs.writeFileSync(path.join(outDir, `${s.name}.png`), nativeImage.createFromBitmap(mask, size0).toPNG());
      continue;
    }
    const img = await Promise.race([win.webContents.capturePage(), sleep(8000).then(() => null)]);
    if (img) fs.writeFileSync(path.join(outDir, `${s.name}.${s.png ? 'png' : 'jpg'}`), s.png ? img.toPNG() : img.toJPEG(92));
    else logs.push('capture timed out: ' + s.name);
  }
  const perf = await run('JSON.stringify(window.__orchPerf)');
  console.log('perf with the last sheet in view: ' + perf);
  if (logs.length) console.log('PAGE ERRORS:\n' + [...new Set(logs)].slice(0, 20).join('\n'));
  app.quit();
});
