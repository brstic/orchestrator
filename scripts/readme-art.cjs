// The README's banner and framed pictures, made from real pictures of the office:
//
//   <electron> scripts/readme-art.cjs <shots-dir> [out-dir = docs/assets]
//
// <shots-dir> holds what `scripts/readme-shots.cjs` took (and, for the pictures of windows, the screenshots of a run
// of the UI suite: `node tests/ui/run.mjs --out <dir>`). Each picture here is a page — the screenshot, a frame, a
// caption — drawn by the browser and saved as a PNG. Nothing in a screenshot is retouched: what is added is around it.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const [shotsDir, outArg] = process.argv.slice(2);
if (!shotsDir) {
  console.error('usage: electron scripts/readme-art.cjs <shots-dir> [out-dir]');
  process.exit(2);
}
const root = path.join(__dirname, '..');
const outDir = path.resolve(outArg || path.join(root, 'docs/assets'));
const shot = (name) => pathToFileURL(path.join(path.resolve(shotsDir), name)).href;
const LOGO = fs.readFileSync(path.join(root, 'docs/assets/logo.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');

const FONT = `"Avenir Next Condensed", "Futura", "Arial Narrow", Impact, sans-serif`;
const BASE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0d1a; font-family: ${FONT}; color: #fff; }
  .loud { font-weight: 800; font-style: italic; text-transform: uppercase; letter-spacing: 0.01em; line-height: 0.92; }
  .logo svg { width: 100%; height: 100%; display: block; }
`;

/** The banner: the office behind, the name in front. */
function banner(o) {
  return `<style>${BASE}
    body { width: 1600px; height: 600px; position: relative; }
    .bg { position: absolute; inset: 0; background: url("${shot(o.image)}") ${o.at || '62% 46%'} / ${o.zoom || '118%'} no-repeat; }
    .fade { position: absolute; inset: 0; background:
      linear-gradient(100deg, #0b0d1a 0%, rgba(11,13,26,0.97) 30%, rgba(18,16,48,0.72) 47%, rgba(18,16,48,0.08) 68%, rgba(11,13,26,0) 100%),
      linear-gradient(0deg, rgba(11,13,26,0.75) 0%, rgba(11,13,26,0) 34%); }
    .stripes { position: absolute; left: -80px; top: -60px; width: 760px; height: 760px; opacity: 0.5;
      background: repeating-linear-gradient(115deg, rgba(139,92,246,0.16) 0 22px, transparent 22px 64px); mask-image: linear-gradient(90deg, #000 30%, transparent 92%); }
    .dots { position: absolute; right: 0; bottom: 0; width: 620px; height: 240px; opacity: 0.55;
      background: radial-gradient(circle, rgba(255,255,255,0.5) 1.6px, transparent 2.2px) 0 0 / 16px 16px; mask-image: linear-gradient(315deg, #000 0%, transparent 62%); }
    .logo { position: absolute; left: 70px; top: 84px; width: 148px; height: 148px; filter: drop-shadow(0 14px 0 rgba(0,0,0,0.45)) drop-shadow(0 0 44px rgba(99,102,241,0.75)); transform: rotate(-6deg); }
    h1 { position: absolute; left: 66px; top: 244px; margin: 0; font-size: 136px; }
    h1 span { display: block; background: linear-gradient(92deg, #ffffff 0%, #dcd6ff 34%, #7cc4ff 68%, #37e8d2 100%); -webkit-background-clip: text; color: transparent;
      filter: drop-shadow(5px 6px 0 #5b3df0) drop-shadow(10px 12px 0 rgba(0,0,0,0.55)); padding-right: 30px; }
    .tag { position: absolute; left: 74px; top: 392px; font: 600 34px/1.1 ${FONT}; letter-spacing: 0.02em; color: #ffd166; text-shadow: 0 3px 0 rgba(0,0,0,0.6); }
    .what { position: absolute; left: 74px; top: 444px; width: 640px; font: 500 23px/1.3 ${FONT}; color: #c9d2ee; }
    .chips { position: absolute; left: 74px; top: 526px; display: flex; gap: 10px; }
    .chips b { font: 700 15px/1 ${FONT}; letter-spacing: 0.14em; text-transform: uppercase; padding: 9px 13px 8px; border: 2px solid rgba(255,255,255,0.75); border-radius: 6px; background: rgba(11,13,26,0.55); }
    .burst { position: absolute; right: 64px; top: 46px; width: 210px; height: 210px; display: grid; place-items: center; text-align: center; transform: rotate(11deg);
      background: #ffd166; color: #1b1338; clip-path: polygon(50% 0%, 61% 13%, 77% 6%, 80% 23%, 96% 25%, 90% 41%, 100% 54%, 87% 63%, 91% 80%, 74% 80%, 67% 96%, 52% 87%, 38% 98%, 31% 82%, 14% 84%, 16% 67%, 1% 59%, 12% 46%, 3% 31%, 19% 27%, 21% 10%, 37% 15%);
      filter: drop-shadow(8px 9px 0 rgba(0,0,0,0.5)); }
    .burst div { font-size: 31px; padding: 0 30px; }
    .burst small { display: block; font: 700 14px/1.1 ${FONT}; letter-spacing: 0.12em; font-style: normal; margin-top: 6px; }
    .scan { position: absolute; inset: 0; background: repeating-linear-gradient(0deg, rgba(255,255,255,0.028) 0 1px, transparent 1px 4px); pointer-events: none; }
    .edge { position: absolute; inset: 0; box-shadow: inset 0 0 0 4px rgba(255,255,255,0.07), inset 0 -8px 0 #5b3df0; }
  </style>
  <div class="bg"></div><div class="fade"></div><div class="stripes"></div><div class="dots"></div>
  <div class="logo">${LOGO}</div>
  <h1 class="loud"><span>Orchestrator</span></h1>
  <div class="tag">Your code. Your company. Your world.</div>
  <div class="what">A 3D office where real Claude Code sessions sit at desks and work as your employees.</div>
  <div class="chips"><b>Real Claude Code</b><b>Real tmux</b><b>Real git</b><b>Zero NPCs</b></div>
  <div class="burst loud"><div>Now hiring<small>AGENTS ONLY</small></div></div>
  <div class="scan"></div><div class="edge"></div>`;
}

/** A framed picture with a caption, the way a game shows itself off. */
function card(o) {
  const [c1, c2, ink] = o.colors;
  return `<style>${BASE}
    body { width: 1400px; height: 900px; position: relative; background: linear-gradient(135deg, ${c1} 0%, ${c2} 100%); }
    .rays { position: absolute; inset: -40%; background: repeating-conic-gradient(from ${o.spin || 0}deg at 50% 50%, rgba(255,255,255,0.09) 0 7deg, transparent 7deg 15deg); }
    .dots { position: absolute; inset: 0; background: radial-gradient(circle, rgba(0,0,0,0.22) 2px, transparent 2.6px) 0 0 / 18px 18px; mask-image: linear-gradient(${o.dots || 200}deg, #000 0%, transparent 55%); }
    .frame { position: absolute; left: 96px; top: 150px; width: 1208px; height: 664px; transform: rotate(${o.tilt}deg); background: #0b0d1a;
      border: 10px solid #fff; border-radius: 18px; box-shadow: 16px 18px 0 ${ink}, 16px 18px 0 6px rgba(0,0,0,0.35); overflow: hidden; }
    .frame img { width: 100%; height: 100%; object-fit: cover; object-position: ${o.at || '50% 50%'}; display: block; }
    .title { position: absolute; left: 54px; top: 34px; transform: rotate(${-o.tilt * 1.6 - 2}deg); transform-origin: left center; }
    .title div { display: inline-block; font-size: ${o.size || 84}px; padding: 12px 34px 8px 26px; background: ${ink}; color: #fff; box-shadow: 9px 9px 0 rgba(0,0,0,0.55); clip-path: polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%); }
    .sub { position: absolute; left: 72px; bottom: 26px; right: 330px; font: 600 27px/1.22 ${FONT}; color: #fff; text-shadow: 0 3px 0 rgba(0,0,0,0.45); }
    .burst { position: absolute; right: 44px; bottom: 30px; width: 236px; height: 236px; display: grid; place-items: center; text-align: center; transform: rotate(${o.tilt * -5}deg);
      background: #ffd166; color: #1b1338; clip-path: polygon(50% 0%, 61% 13%, 77% 6%, 80% 23%, 96% 25%, 90% 41%, 100% 54%, 87% 63%, 91% 80%, 74% 80%, 67% 96%, 52% 87%, 38% 98%, 31% 82%, 14% 84%, 16% 67%, 1% 59%, 12% 46%, 3% 31%, 19% 27%, 21% 10%, 37% 15%);
      filter: drop-shadow(8px 9px 0 rgba(0,0,0,0.5)); }
    .burst div { font-size: ${o.stickerSize || 36}px; padding: 0 34px; }
    .burst small { display: block; font: 700 14px/1.1 ${FONT}; letter-spacing: 0.1em; font-style: normal; margin-top: 6px; }
    .mark { position: absolute; right: 40px; top: 30px; display: flex; align-items: center; gap: 12px; font: 800 22px/1 ${FONT}; letter-spacing: 0.2em; opacity: 0.95; text-shadow: 0 2px 0 rgba(0,0,0,0.4); }
    .mark .logo { width: 46px; height: 46px; filter: drop-shadow(3px 4px 0 rgba(0,0,0,0.4)); }
  </style>
  <div class="rays"></div><div class="dots"></div>
  <div class="frame"><img src="${shot(o.image)}"></div>
  <div class="title loud"><div>${o.title}</div></div>
  <div class="sub">${o.sub}</div>
  <div class="burst loud"><div>${o.sticker}${o.stickerSub ? `<small>${o.stickerSub}</small>` : ''}</div></div>
  <div class="mark"><div class="logo">${LOGO}</div>ORCHESTRATOR</div>`;
}

/** Every picture of a folder on one page, small: for choosing. */
function sheet(files) {
  return `<style>${BASE} body { width: 1600px; padding: 10px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; height: auto; overflow: visible; }
    figure { margin: 0; } img { width: 100%; display: block; } figcaption { font: 600 15px/1.4 Menlo, monospace; color: #cbd5f5; }</style>
    ${files.map((f) => `<figure><img src="${shot(f)}"><figcaption>${f}</figcaption></figure>`).join('')}`;
}

const PURPLE = ['#6d3df5', '#2a1a78', '#ff3d8b'];
const TEAL = ['#0fb5a6', '#0b3f6b', '#ff7a1a'];
const ORANGE = ['#ff8a3d', '#b3204f', '#3b2bd9'];
const BLUE = ['#3b82f6', '#1e1b6e', '#16c79a'];
const PINK = ['#f0479b', '#5b1a8a', '#2563eb'];
const GREEN = ['#22b573', '#0c4a55', '#f43f5e'];

// What each picture shows is what the office does; the words around it are the README's own.
const ASSETS = JSON.parse(process.env.README_ART || 'null') || [];

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'readme-art-'));
  const render = async (name, width, height, html) => {
    const win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, webPreferences: { backgroundThrottling: false, webSecurity: false } });
    const file = path.join(tmp, `${name}.html`);
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8">${html}`);
    await win.loadFile(file);
    await win.webContents.executeJavaScript(`Promise.all([...document.images].map((i) => i.decode().catch(() => undefined))).then(() => document.fonts.ready).then(() => true)`);
    await new Promise((r) => setTimeout(r, 400));
    if (!height) {
      const h = await win.webContents.executeJavaScript(`document.documentElement.scrollHeight`);
      win.setContentSize(width, Math.min(h, 8000));
      await new Promise((r) => setTimeout(r, 300));
    }
    fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    win.destroy();
    console.log(`${name}.png`);
  };
  const palettes = { PURPLE, TEAL, ORANGE, BLUE, PINK, GREEN };
  try {
    if (process.env.README_SHEET) {
      const files = fs.readdirSync(shotsDir).filter((f) => /\.(png|jpg)$/.test(f) && (process.env.README_SHEET === '1' || new RegExp(process.env.README_SHEET).test(f))).sort();
      await render('contact-sheet', 1600, 0, sheet(files));
    }
    for (const a of ASSETS) {
      if (a.kind === 'banner') await render(a.name, 1600, 600, banner(a));
      else await render(a.name, 1400, 900, card({ ...a, colors: palettes[a.palette] || PURPLE }));
    }
  } catch (e) {
    console.error(String(e && e.stack));
    process.exitCode = 1;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
});
