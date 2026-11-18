#!/usr/bin/env node
/**
 * Where the office stands (Settings → Surroundings), seen from two windows of one development office: the one an
 * owner chooses in, and another that is only looking (its own storage, as a browser tab on another computer has).
 * What is checked is what the scene says about itself — which place, how far the camera sees, the air, the windows
 * in the outer walls, what the graphics card was given — and that no shader of any place failed to build.
 * What a place looks like is for eyes: `docs/SURROUNDINGS.md` says how to look.
 *   node tests/ui/surroundings.mjs      (needs the UI build and Electron)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electron = path.join(root, 'apps/desktop/node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
if (!fs.existsSync(electron)) throw new Error('Electron is not installed: run pnpm electron:repair');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const PLACES = { skyline: 'Skyline', park: 'Park', island: 'Island', north: 'Northern lights', orbit: 'Orbit' };

/**
 * Over the Skyline: out of a window with a parachute, down onto the street, into a car of the traffic and away —
 * a city that goes on wherever one drives — and back to the office with the button.
 */
async function theCity(owner, other) {
  await owner.js(`window.__office.getState().openPanel(null); true`);
  // (Where the owner stood before: put back there at the end, so that what is measured after is measured from the same view.)
  const start = await owner.js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, rot: window.__orchPlayer.rot, yaw: window.__orchPlayer.yaw, pitch: window.__orchPlayer.pitch })`);
  const city = `window.__orchPlayer.city`;
  // Out of the office onto the terrace: it is floor now, all the way round to the balustrade.
  const t = await owner.js(`window.__orchPlayer.terrace`);
  check('Skyline: the terrace round the office can be walked on', !!t && t.maxX > 25, JSON.stringify(t));
  await owner.js(`window.__orchPlayer.goto = { x: ${t.maxX - 3}, z: ${(t.minZ + t.maxZ) / 2}, rot: ${Math.PI / 2} }; true`);
  await sleep(600);
  const before = await owner.js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z })`);
  await owner.hold('KeyW', true);
  await sleep(1200);
  await owner.hold('KeyW', false);
  const after = await owner.js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, near: window.__office.getState().nearby })`);
  const home = { x: after.x, z: after.z };
  const me = await owner.js(`window.__office.getState().clientId`);
  const othersSee = () => other.js(`(() => { const p = window.__office.getState().people.find((x) => x.id === ${JSON.stringify(me)}); return p ? { x: p.x, z: p.z, out: p.out ?? null } : null; })()`);
  // How the other window draws the owner right now (`Humans.tsx`): where, and with what.
  const drawnThere = `window.__orchScene.humans && window.__orchScene.humans[${JSON.stringify(me)}]`;
  check('Skyline: walking out to the balustrade, the key says "jump off the edge" — and the balustrade stops the walk', before.x < after.x && after.x <= t.maxX - 0.25 && after.near?.kind === 'edge' && after.near?.label === 'JUMP OFF THE EDGE', JSON.stringify({ before, after }));
  await owner.press('Space');
  await owner.until('the jump out', `window.__office.getState().outside.on && ${city} && ${city}.phase === 'fall'`, 4000);
  check('Skyline: over the balustrade, falling — and "Back to Office" is there at once', await owner.js(`[...document.querySelectorAll('[data-outside] button')].some((b) => b.textContent.trim() === 'Back to Office')`));
  await owner.until('the parachute', `${city}.phase === 'chute'`, 4000);
  await owner.hold('KeyW', true);
  await owner.until('the parachute open', `${city}.chute >= 1`, 3000);
  const sink = await owner.js(`(async () => { const a = ${city}.y; await new Promise((r) => setTimeout(r, 2000)); return (a - ${city}.y) / 2; })()`);
  check('Skyline: the parachute opens by itself and one comes down slowly', sink > 3 && sink < 7, `${sink.toFixed(1)} m a second`);
  await other.until('the other window drawing the owner under the parachute', `${drawnThere} && ${drawnThere}.out === 'chute' && ${drawnThere}.chute && ${drawnThere}.y < -5`, 5000).catch(() => {});
  const chuteThere = await other.js(drawnThere);
  const chuteHere = await owner.js(city);
  check('Skyline: together — the other window sees the owner out there, under their parachute, where they are', chuteThere?.out === 'chute' && chuteThere.chute && Math.hypot(chuteThere.x - chuteHere.x, chuteThere.y - chuteHere.y, chuteThere.z - chuteHere.z) < 12, JSON.stringify({ there: chuteThere, here: { x: chuteHere.x, y: chuteHere.y, z: chuteHere.z } }));
  await owner.until('the landing', `${city}.phase === 'foot'`, 60000);
  await owner.hold('KeyW', false);
  const landed = await owner.js(city);
  check('Skyline: down on the street or on a roof, on foot', landed.phase === 'foot' && landed.y < -60, JSON.stringify(landed));
  // Beside a queue that waits at a crossing (a lane of a street along z, the stretch before its stop line).
  await owner.js(`(() => { const P = 116; const k = Math.round(${city}.x / P - 0.5) + 0.5; window.__orchPlayer.cityGoto = { x: k * P + 9.6, y: -150, z: Math.round(${city}.z / P) * P - 36, phase: 'foot', rot: Math.PI }; return true; })()`);
  await owner.until('a car within reach', `${city}.near !== null && ${city}.phase === 'foot'`, 40000);
  check('Skyline: next to a car of the traffic the key says "F — drive this car"', (await owner.js(`window.__office.getState().outsideHint`)) === 'F — DRIVE THIS CAR');
  const taken = await owner.js(`${city}.near`);
  await owner.press('KeyF');
  await owner.until('at the wheel', `${city}.phase === 'car'`, 3000);
  check('Skyline: F takes that car out of the traffic', (await owner.js(`${city}.taken`)) === taken);
  const from = await owner.js(city);
  await owner.hold('KeyW', true);
  await sleep(3000);
  await owner.hold('KeyW', false);
  const went = await owner.js(city);
  const carThere = await other.js(drawnThere);
  check('Skyline: together — the other window sees the owner\'s car drive, and not the owner beside it', carThere?.out === 'car' && carThere.car && !carThere.body && Math.hypot(carThere.x - went.x, carThere.z - went.z) < 20, JSON.stringify(carThere));
  check('Skyline: it drives', Math.hypot(went.x - from.x, went.z - from.z) > 15 || went.speed > 8, `${Math.hypot(went.x - from.x, went.z - from.z).toFixed(0)} m, ${went.speed.toFixed(1)} m/s`);
  await owner.until('stopping', `Math.abs(${city}.speed) < 0.5`, 15000).catch(() => {});
  await owner.press('KeyF');
  await owner.until('out of the car', `${city}.phase === 'foot'`, 3000);
  check('Skyline: F again gets out, and the car stays where it was left', (await owner.js(`${city}.near`)) === taken);
  const near = await owner.js(`(() => { let skinned = 0; window.__orchScene.three.scene.traverse((o) => { if (o.isSkinnedMesh && o.visible) skinned++; }); return skinned; })()`);
  check('Skyline: down in the street the people near by are the office\'s own characters', near > 12, `${near} limbs of characters (four a person)`);
  // Far away the city goes on: a few kilometres off there are buildings round, and traffic.
  await owner.js(`window.__orchPlayer.cityGoto = { x: 4700, y: -150, z: -3300, phase: 'foot' }; true`);
  await sleep(1500);
  const far = await owner.js(`(() => { let boxes = 0; window.__orchScene.three.scene.traverse((o) => { if (o.isInstancedMesh && o.geometry.getAttribute('aLook') && o.count > boxes) boxes = o.count; }); const c = window.__orchScene.three.camera.position; return { boxes, x: c.x, z: c.z }; })()`);
  check('Skyline: the city has no end — kilometres away it is built up all round', far.boxes > 1500 && Math.hypot(far.x - 4700, far.z + 3300) < 40, JSON.stringify(far));
  const seen = await othersSee();
  check('Skyline: the office still has the owner where they jumped from (the room they are in, for whoever looks at a list)', !!seen && Math.hypot(seen.x - home.x, seen.z - home.z) < 1.5, JSON.stringify(seen));
  check('Skyline: … and says where they are out there, so the others draw them there', seen?.out?.phase === 'foot' && Math.hypot(seen.out.x - 4700, seen.out.z + 3300) < 5, JSON.stringify(seen?.out));
  await together(owner, other, me);
  await owner.click('[data-outside] .btn-primary');
  await owner.until('back in the office', `!window.__office.getState().outside.on && !document.querySelector('[data-outside]')`, 4000);
  await sleep(500);
  const back = await owner.js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, cam: window.__orchScene.three.camera.position.y })`);
  check('Skyline: "Back to Office" — back where one stood, and the camera with them', Math.hypot(back.x - home.x, back.z - home.z) < 0.5 && back.cam > 0, JSON.stringify(back));
  await owner.js(`window.__orchPlayer.goto = ${JSON.stringify(start)}; true`);
  await sleep(1500);
  await owner.js(`window.__office.getState().openPanel('settings', 'surroundings'); true`);
  await owner.until('the Surroundings page again', `document.querySelectorAll('[data-surroundings]').length === 6`, 8000);
}

/**
 * Two out in the city: the other window goes out too, goes to the owner with the button, gets into the owner's car
 * beside them, rides along, and is put out when the owner gets out. Then it goes back in.
 */
async function together(owner, other, me) {
  const city = `window.__orchPlayer.city`;
  await other.js(`window.__office.getState().openPanel(null); window.__office.getState().goOutside(); true`);
  await other.until('the other window out of the office', `window.__office.getState().outside.on && ${city}`, 5000);
  await other.until('the "Go to" button for the owner', `document.querySelector('[data-outside] [data-go-to]')`, 5000);
  await owner.until('the owner\'s window offering to go to the other', `document.querySelector('[data-outside] [data-go-to]')`, 5000);
  await other.click('[data-outside] [data-go-to]');
  await other.until('beside the owner', `${city}.phase === 'foot' && Math.hypot(${city}.x - 4700, ${city}.z + 3300) < 6`, 5000).catch(() => {});
  const there = await other.js(city);
  check('Skyline: together — "Go to …" puts one on foot beside somebody else out there', there?.phase === 'foot' && Math.hypot(there.x - 4700, there.z + 3300) < 6, JSON.stringify(there));
  // The owner takes a car of a queue; the other goes to them and gets in beside them.
  await owner.js(`(() => { const P = 116; window.__orchPlayer.cityGoto = { x: 40.5 * P + 9.6, y: -150, z: -28 * P - 36, phase: 'foot', rot: Math.PI }; return true; })()`);
  await owner.until('a car within the owner\'s reach', `${city}.near !== null && ${city}.phase === 'foot'`, 40000);
  await owner.press('KeyF');
  await owner.until('the owner at the wheel', `${city}.phase === 'car'`, 3000);
  await other.until('the owner\'s car drawn in the other window', `window.__orchScene.humans[${JSON.stringify(me)}].car`, 5000);
  await sleep(500);
  await other.click('[data-outside] [data-go-to]');
  await other.until('next to the owner\'s car', `${city}.nearDriver === ${JSON.stringify(me)}`, 5000).catch(() => {});
  const hint = await other.js(`window.__office.getState().outsideHint`);
  check('Skyline: together — next to somebody\'s car the key says "F — ride with …"', /^F — RIDE WITH /.test(hint ?? ''), hint);
  await other.press('KeyF');
  await other.until('riding', `${city}.ride === ${JSON.stringify(me)}`, 3000).catch(() => {});
  const from = await other.js(city);
  await owner.hold('KeyW', true);
  await sleep(3000);
  await owner.hold('KeyW', false);
  const rode = await other.js(`({ me: ${city}, car: window.__orchScene.humans[${JSON.stringify(me)}] })`);
  check('Skyline: together — riding along: the seat beside the driver goes where the car goes', rode.me.ride === me && Math.hypot(rode.me.x - from.x, rode.me.z - from.z) > 10 && Math.hypot(rode.me.x - rode.car.x, rode.me.z - rode.car.z) < 1, JSON.stringify({ from: { x: from.x, z: from.z }, now: { x: rode.me.x, z: rode.me.z }, car: { x: rode.car.x, z: rode.car.z } }));
  const passenger = await owner.until('the passenger seen in the owner\'s window', `window.__orchScene.humans && Object.values(window.__orchScene.humans).some((h) => h.out === 'ride' && !h.body)`, 3000).then(() => true, () => false);
  check('Skyline: together — the driver\'s window has the passenger in the car (only their name shows)', passenger);
  await owner.until('the owner stopping', `Math.abs(${city}.speed) < 0.5`, 15000).catch(() => {});
  await owner.press('KeyF');
  await other.until('the passenger out when the driver gets out', `${city}.phase === 'foot' && !${city}.ride`, 4000).catch(() => {});
  check('Skyline: together — when the driver gets out, so does the one beside them', await other.js(`${city}.phase === 'foot' && !${city}.ride`));
  await other.click('[data-outside] .btn-primary');
  await other.until('the other window back in the office', `!window.__office.getState().outside.on`, 4000);
  await owner.until('nobody else out there', `!document.querySelector('[data-outside] [data-go-to]')`, 4000).catch(() => {});
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-surroundings-'));
const office = spawn(process.execPath, [path.join(root, 'scripts/dev-office.ts'), '--port', String(4900 + Math.floor(Math.random() * 200))], { stdio: ['ignore', 'pipe', 'ignore'], cwd: root });
let app = null;
let exit = 1;
try {
  const info = await new Promise((resolve, reject) => {
    readline.createInterface({ input: office.stdout }).on('line', (line) => {
      try {
        const j = JSON.parse(line);
        if (j.url) resolve(j);
      } catch {
        /* not the ready line */
      }
    });
    setTimeout(() => reject(new Error('the development office did not start')), 90000);
  });
  const u = new URL(info.url);
  const token = u.searchParams.get('token');
  const api = async (method, p, body) => {
    const r = await fetch(`${u.origin}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const debugPort = 9600 + Math.floor(Math.random() * 300);
  // Two windows with storage of their own (the same helper the hi-fi's test uses).
  app = spawn(electron, [path.join(root, 'tests/ui/radio-windows.cjs'), `--remote-debugging-port=${debugPort}`, info.url, path.join(tmp, 'userdata')], { stdio: process.env.ORCH_DEBUG_UI ? 'inherit' : 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const targets = async () => (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const attach = async (t) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) pending.get(m.id)(m);
    };
    const send = (method, params = {}) => new Promise((resolve) => pending.set(++id, resolve) && ws.send(JSON.stringify({ id, method, params })));
    const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const until = async (label, expr, ms = 30000) => {
      const end = Date.now() + ms;
      for (;;) {
        if (await js(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(150);
      }
    };
    return {
      js,
      until,
      click: async (selector) => {
        const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        if (!r) throw new Error(`nothing to click: ${selector}`);
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      },
      // Every complaint of the renderer from here on is kept: a shader that did not build says so there.
      listen: () => js(`window.__errs = []; for (const k of ['error', 'warn']) { const o = console[k].bind(console); console[k] = (...a) => { const t = a.map((x) => (typeof x === 'string' ? x : (x && x.message) || '')).join(' '); if (/THREE|WebGL|shader|GLSL/i.test(t)) window.__errs.push(t.slice(0, 240)); o(...a); }; } true`),
      // What the scene says about itself.
      scene: () =>
        js(`(() => { const p = window.__orchScene; const t = p.three; return { ...p.surroundings, windows: p.outerWindows, sky: t.scene.children.some((c) => c.renderOrder === 900), camFar: t.camera.far, background: '#' + t.scene.background.getHexString(), calls: (window.__orchPerf || {}).calls, fps: (window.__orchPerf || {}).fps, age: Date.now() - ((window.__orchPerf || {}).at || 0), geometries: t.gl.info.memory.geometries, textures: t.gl.info.memory.textures }; })()`),
      /** A real key press (down, held for `ms`, up). */
      press: async (code, ms = 90) => {
        const key = code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code.replace(/Left|Right/, '');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key });
        await sleep(ms);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key });
      },
      hold: (code, down) => {
        const key = code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code.replace(/Left|Right/, '');
        return send('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', code, key });
      },
      close: () => ws.close(),
    };
  };
  const pages = {};
  for (let i = 0; i < 120 && !(pages.app && pages.tab); i++) {
    await sleep(500);
    for (const t of (await targets().catch(() => [])).filter((x) => x.type === 'page' && x.url.startsWith(u.origin))) {
      if (Object.values(pages).some((p) => p.id === t.id)) continue;
      const page = await attach(t);
      const tag = await page.js('window.__tag');
      if (tag === 'app' || tag === 'tab') pages[tag] = Object.assign(page, { id: t.id });
      else page.close();
    }
  }
  if (!pages.app || !pages.tab) throw new Error('the two office windows did not open');
  const { app: owner, tab: other } = pages;
  const ready = `window.__office && window.__office.getState().ready && window.__orchPrefs.getState().ready && window.__orchScene && window.__orchScene.three && window.__orchScene.surroundings && window.__orchPerf`;
  for (const [name, p] of Object.entries(pages)) {
    await p.until(`the office in the ${name} window`, ready, 90000);
    await p.listen();
  }

  // ── as it always was ──
  const plain = await owner.scene();
  const plainOther = await other.scene();
  check('an office nobody has moved stands by itself: the dark all round, no windows in the outer walls, nothing drawn for a sky', plain.kind === 'studio' && plain.camFar === 260 && plain.fog === '#0d1118' && plain.windows === 0 && !plain.sky && plainOther.kind === 'studio', JSON.stringify(plain));
  check('the office has not chosen anything', (await api('GET', '/state')).body.settings.surroundings === undefined);

  // ── Settings → Surroundings ──
  await owner.js(`window.__office.getState().openPanel('settings', 'surroundings'); true`);
  await owner.until('the Surroundings page of Settings', `document.querySelectorAll('[data-settings-section="surroundings"] [data-surroundings]').length === 6`, 8000);
  const cards = await owner.js(`[...document.querySelectorAll('[data-surroundings]')].map((c) => ({ id: c.dataset.surroundings, on: c.classList.contains('pc-choice-on'), name: c.querySelector('.strong').textContent, about: c.querySelector('.muted').textContent.length, picture: getComputedStyle(c.querySelector('.pc-place-picture')).backgroundImage !== 'none' }))`);
  check('six places to choose from, each with a name, a line about it and a picture; "By itself" is the one chosen', cards.length === 6 && cards.every((c) => c.name && c.about > 20 && c.picture) && cards.filter((c) => c.on).map((c) => c.id).join() === 'studio' && cards.map((c) => c.id).join() === 'studio,skyline,park,island,north,orbit', cards.map((c) => `${c.id}${c.on ? '*' : ''}`).join(' '));
  check('it is listed under "The office", and says whose it is', await owner.js(`/The office · Surroundings/.test(document.querySelector('.win').textContent) && /everybody in it sees the same place/.test(document.querySelector('.win').textContent)`));

  // ── each place in turn, chosen with a real click ──
  let most = plain.calls;
  for (const [id, name] of Object.entries(PLACES)) {
    await owner.click(`[data-surroundings="${id}"] input`);
    await owner.until(`${name} in the window it was chosen in`, `window.__orchScene.surroundings.kind === '${id}'`, 15000);
    await other.until(`${name} in the other window`, `window.__orchScene.surroundings.kind === '${id}'`, 15000);
    // A few seconds of it being drawn, so that every shader of the place has been built and used.
    await sleep(2600);
    const [a, b] = [await owner.scene(), await other.scene()];
    const stored = (await api('GET', '/state')).body.settings.surroundings;
    check(`${name}: chosen in one window, the office stands there in both, and the office itself has it`, a.kind === id && b.kind === id && stored === id && (await owner.js(`document.querySelector('[data-surroundings="${id}"]').classList.contains('pc-choice-on') && document.querySelectorAll('.pc-choice-on[data-surroundings]').length === 1`)), `${a.kind} / ${b.kind} / ${stored}`);
    check(`${name}: a sky, air of its own, a camera that sees to the horizon, and windows in the outer walls`, a.sky && b.sky && a.camFar > 1000 && a.far === a.camFar && a.fog !== plain.fog && a.background === a.fog && a.windows >= 6 && b.windows === a.windows, JSON.stringify({ far: a.camFar, fog: a.fog, windows: a.windows }));
    check(`${name}: drawn at a steady rate, for not much more than the office costs by itself`, a.age < 4000 && a.fps > 20 && a.calls - plain.calls < 220 && a.calls > plain.calls, `${a.fps} fps, ${a.calls} draw calls (the plain office: ${plain.calls})`);
    most = Math.max(most, a.calls);
    const errs = [...(await owner.js(`window.__errs`)), ...(await other.js(`window.__errs`))];
    check(`${name}: nothing it is drawn with failed to build`, errs.length === 0, errs.slice(0, 3).join(' | '));
    if (id === 'skyline') await theCity(owner, other);
  }

  // ── the place is the office's, not a window's ──
  await other.js(`location.reload(); true`);
  await sleep(1500);
  await other.until('the other window after loading again', ready, 60000);
  await other.listen();
  await other.until('the place after loading again', `window.__orchScene.surroundings.kind === 'orbit'`, 15000);
  check('a window that is opened afresh is given the place by the office (nothing about it is kept on the computer)', (await other.scene()).kind === 'orbit' && (await other.js(`!JSON.stringify(window.__orchPrefs.getState().prefs).includes('urroundings') && !Object.keys(localStorage).some((k) => (localStorage.getItem(k) || '').includes('orbit'))`)));

  // ── graphics quality is each computer's own: on Low a place is thinner, and still there ──
  await other.js(`window.__orchPrefs.setState({ prefs: { ...window.__orchPrefs.getState().prefs, quality: 'low' } }); true`);
  await api('PATCH', '/settings', { surroundings: 'park' });
  await other.until('the park on Low', `window.__orchScene.surroundings.kind === 'park'`, 15000);
  await owner.until('the park', `window.__orchScene.surroundings.kind === 'park'`, 15000);
  await sleep(2600);
  const [full, thin] = [await owner.scene(), await other.scene()];
  check('on the Low setting the same place is drawn with less in it', thin.kind === 'park' && thin.sky && thin.windows === full.windows && thin.geometries <= full.geometries, `${thin.geometries} shapes on Low, ${full.geometries} otherwise`);

  // ── and back: the plain office is a choice like any other, and nothing of a place is left behind ──
  await owner.click(`[data-surroundings="studio"] input`);
  for (const p of [owner, other]) await p.until('the plain office again', `window.__orchScene.surroundings.kind === 'studio' && !window.__orchScene.three.scene.children.some((c) => c.renderOrder === 900)`, 15000);
  await sleep(1500);
  const back = await owner.scene();
  check('"By itself" again: the dark, the solid walls and the short view, as before', back.kind === 'studio' && back.camFar === 260 && back.fog === '#0d1118' && back.background === '#0d1118' && back.windows === 0 && !back.sky, JSON.stringify(back));
  // Moved once more and back: the office holds no more than it did the first time it came back. (The office is alive —
  // people sit down and get up — so the two counts are taken a few seconds apart, not from the start of the test.)
  for (const id of ['island', 'studio']) {
    await api('PATCH', '/settings', { surroundings: id });
    await owner.until(`${id} once more`, `window.__orchScene.surroundings.kind === '${id}'`, 15000);
    await sleep(1500);
  }
  const again = await owner.scene();
  check('everything a place was made of is let go of when the office leaves it', Math.abs(again.geometries - back.geometries) <= 3 && Math.abs(again.textures - back.textures) <= 2, `shapes ${back.geometries} → ${again.geometries}, pictures ${back.textures} → ${again.textures}`);
  const errs = [...(await owner.js(`window.__errs`)), ...(await other.js(`window.__errs`))];
  check('the renderer complained about nothing from the first place to the last', errs.length === 0, errs.slice(0, 3).join(' | '));
  const toasts = await owner.js(`window.__office.getState().toasts.filter((t) => t.kind === 'error').map((t) => t.text)`);
  check('and no error was shown to the person choosing', toasts.length === 0, toasts.join(' | '));
  console.log(`  (most draw calls with a place: ${most}; the plain office: ${plain.calls})`);
  owner.close();
  other.close();
  exit = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${e.message}`);
} finally {
  app?.kill('SIGTERM');
  office.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exit);
