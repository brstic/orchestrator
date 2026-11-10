#!/usr/bin/env node
/**
 * The hi-fi plays for the whole office, seen from two windows of one development office: one that may start
 * sound by itself (like the desktop app's office window) and one that wants a click first (like a browser tab).
 * A station on this machine (silence) stands in for internet radio, and both windows are muted at the system
 * level: what is checked is what each window's player does, not what a person hears.
 *   node tests/ui/radio-app.mjs      (needs the UI build and Electron)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

// A local "radio station": three minutes of silence.
const wav = (() => {
  const rate = 8000;
  const n = rate * 180;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  return b;
})();
const station = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length }).end(wav));
await new Promise((r) => station.listen(0, '127.0.0.1', r));
const FM = { id: 'test-fm', name: 'Test FM', url: `http://127.0.0.1:${station.address().port}/stream.wav`, nowPlayingUrl: null, page: null };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-radio-'));
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
  await api('PATCH', '/settings', { radio: { stations: [FM] } });

  const debugPort = 9600 + Math.floor(Math.random() * 300);
  app = spawn(electron, [path.join(root, 'tests/ui/radio-windows.cjs'), `--remote-debugging-port=${debugPort}`, info.url, path.join(tmp, 'userdata')], { stdio: process.env.ORCH_DEBUG_RADIO ? 'inherit' : 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
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
    // Never as a gesture: a script must not count as the click the browser waits for.
    const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false })).result?.result?.value;
    const until = async (label, expr, ms = 30000) => {
      const end = Date.now() + ms;
      for (;;) {
        if (await js(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(200);
      }
    };
    return {
      js,
      until,
      // A real mouse click at the middle of an element.
      click: async (selector) => {
        const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        if (!r) throw new Error(`nothing to click: ${selector}`);
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      },
      radio: () => js(`({ ...window.__orchRadio(), status: window.__office.getState().radio.status, on: window.__office.getState().hifi ? window.__office.getState().hifi.station.name : null, by: window.__office.getState().hifi ? window.__office.getState().hifi.by.name : null })`),
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
  const { app: appWin, tab } = pages;
  for (const [name, p] of Object.entries(pages)) await p.until(`the office in the ${name} window`, `window.__office && window.__office.getState().ready && window.__orchPrefs.getState().ready && window.__orchPlayer && window.__orchPlayer.spots && window.__orchPlayer.spots.length`, 90000);
  // Every error toast and every "cannot play" state from here on is remembered: there should be none.
  for (const p of [appWin, tab]) await p.js(`window.__bad = []; window.__office.subscribe((s) => { for (const t of s.toasts) if (t.kind === 'error' && !window.__bad.includes(t.text)) window.__bad.push(t.text); if (s.radio.status === 'error' && !window.__bad.includes(s.radio.error)) window.__bad.push(s.radio.error); }); true`);
  check('to begin with the hi-fi is off in both windows', (await appWin.radio()).on === null && (await tab.radio()).on === null && (await appWin.radio()).loaded === null);

  // Switched on from outside both windows: neither has been clicked in.
  const played = await api('POST', '/radio/play', { stationId: FM.id });
  check('the office switches the station on', played.status === 200 && played.body.radio.station.id === FM.id);
  await appWin.until('the app window playing', `window.__office.getState().radio.status === 'playing'`, 20000);
  const a1 = await appWin.radio();
  check('a window that may start sound plays it by itself, with no click', a1.status === 'playing' && a1.on === 'Test FM' && !a1.paused && a1.loaded !== null, JSON.stringify(a1));
  await tab.until('the tab told about the station', `window.__office.getState().hifi && window.__office.getState().radio.status !== 'loading'`, 20000);
  const b1 = await tab.radio();
  const notice = await tab.js(`(document.querySelector('.radio-notice') || {}).textContent || ''`);
  check('a window that wants a click first is told what is on and does not play yet', b1.on === 'Test FM' && b1.status === 'blocked' && b1.paused, JSON.stringify(b1));
  check('it shows one calm notice, not an error', /The hi-fi is playing: ♪ Test FM — click to listen/.test(notice) && (await tab.js(`document.querySelectorAll('.radio-notice').length === 1 && !document.querySelector('.toast-error') && !/cannot play/.test(document.body.textContent)`)), notice);
  check('the hi-fi pill in the top bar is there in both windows', (await appWin.js(`!!document.querySelector('.radio-mini')`)) && (await tab.js(`!!document.querySelector('.radio-mini')`)));

  await tab.click('.radio-notice-listen');
  await tab.until('the tab playing after the click', `window.__office.getState().radio.status === 'playing'`, 20000);
  const b2 = await tab.radio();
  check('the click on the notice starts it, and the notice is gone', b2.status === 'playing' && !b2.paused && (await tab.js(`!document.querySelector('.radio-notice')`)), JSON.stringify(b2));

  // Loudness is each listener's own: by where their character stands, and by their own volume.
  const spots = await appWin.js(`window.__orchPlayer.spots`);
  const hifi = spots.find((s) => s.kind === 'hifi');
  const far = spots.filter((s) => s.kind !== 'hifi').sort((p, q) => Math.hypot(q.x - hifi.x, q.z - hifi.z) - Math.hypot(p.x - hifi.x, p.z - hifi.z))[0];
  await appWin.js(`window.__orchPlayer.goto = { x: ${hifi.x}, z: ${hifi.z}, rot: 0 }; true`);
  await tab.js(`window.__orchPlayer.goto = { x: ${far.x}, z: ${far.z}, rot: 0 }; true`);
  await appWin.until('full loudness at the hi-fi', `(() => { const r = window.__orchRadio(); return r.loudness === 1 && Math.abs(r.volume - r.wanted) < 0.005; })()`, 10000);
  await tab.until('quiet at the far end', `(() => { const r = window.__orchRadio(); return r.loudness < 0.6 && Math.abs(r.volume - r.wanted) < 0.005; })()`, 10000);
  const [near, away] = [await appWin.radio(), await tab.radio()];
  const myVolume = await appWin.js(`window.__orchPrefs.getState().prefs.radioVolume`);
  check('next to the hi-fi it is as loud as my own volume', Math.abs(near.volume - myVolume) < 0.01, `volume ${near.volume.toFixed(2)} of my ${myVolume}`);
  check('far from the hi-fi the same station is quieter, and still there', away.volume < near.volume * 0.6 && away.volume >= myVolume * 0.14 - 0.005 && !away.paused, `${Math.hypot(far.x - hifi.x, far.z - hifi.z).toFixed(0)} m away (${far.kind}): ${(away.loudness * 100).toFixed(0)}% → volume ${away.volume.toFixed(3)}`);
  // Walking back, the volume comes up without a jump: sampled while it eases.
  await tab.js(`window.__levels = []; window.__sampler = setInterval(() => window.__levels.push(window.__orchRadio().volume), 25); window.__orchPlayer.goto = { x: ${hifi.x}, z: ${hifi.z}, rot: 0 }; true`);
  await tab.until('full loudness after walking back', `(() => { const r = window.__orchRadio(); return r.loudness === 1 && Math.abs(r.volume - r.wanted) < 0.005; })()`, 10000);
  const levels = await tab.js(`clearInterval(window.__sampler); window.__levels`);
  const biggest = levels.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - levels[i])), 0);
  const whole = levels.at(-1) - levels[0];
  check('a sudden change of place is eased, never one step', levels.length > 5 && biggest < whole * 0.45 && biggest < 0.2, `${levels.length} samples from ${levels[0].toFixed(2)} to ${levels.at(-1).toFixed(2)}, biggest step ${biggest.toFixed(3)}`);

  // Mute is one computer's: the other keeps hearing it, and the office's hi-fi stays on.
  await tab.click('.radio-mini button[aria-label="Mute the hi-fi on this computer"]');
  await tab.until('the tab muted', `window.__orchPrefs.getState().prefs.radioMuted === true && window.__orchRadio().loaded === null`, 8000);
  await sleep(600);
  const [a3, b3] = [await appWin.radio(), await tab.radio()];
  check('muting one window silences only its own copy', b3.loaded === null && b3.on === 'Test FM' && a3.status === 'playing' && !a3.paused && a3.on === 'Test FM', `${JSON.stringify(b3)} / ${JSON.stringify(a3)}`);
  check('the muted window still shows the hi-fi as on (pill, and the 3D hi-fi is driven by the office\'s state)', await tab.js(`!!document.querySelector('.radio-mini') && !!window.__office.getState().hifi && !!document.querySelector('.radio-mini button[aria-label="Unmute the hi-fi on this computer"]')`));
  await tab.click('.radio-mini button[aria-label="Unmute the hi-fi on this computer"]');
  await tab.until('the tab playing again', `window.__office.getState().radio.status === 'playing'`, 20000);
  check('unmuted, it tunes in again', !(await tab.radio()).paused);

  // The Hi-fi window says who and what; then the stop button in the top bar stops it for everyone.
  await appWin.js(`window.__office.getState().openPanel('radio'); true`);
  await appWin.until('the Hi-fi window', `!!document.querySelector('.win .radio-now')`, 8000);
  const text = await appWin.js(`document.querySelector('.win').textContent`);
  check('the Hi-fi window says it plays for everyone, who switched it on, and whose the volume is', /everyone who is in it hears what is on/.test(text) && /Switched on by you/.test(text) && /My volume/.test(text) && /quieter you hear it/.test(text) && /Stop for everyone/.test(text), text.slice(0, 160));
  await appWin.js(`window.__office.getState().openPanel(null); true`);
  await appWin.click('.radio-mini button[aria-label="Stop the hi-fi for everyone"]');
  for (const p of [appWin, tab]) await p.until('the hi-fi off', `!window.__office.getState().hifi && window.__orchRadio().loaded === null && !document.querySelector('.radio-mini')`, 8000);
  check('stopped in one window, it is off in both', (await api('GET', '/radio')).body.radio === null && (await tab.radio()).status === 'idle' && (await appWin.radio()).status === 'idle');

  // Once the person has clicked in the page, the next station starts by itself there too.
  await api('POST', '/radio/play', { stationId: FM.id });
  await tab.until('the tab playing the next time', `window.__office.getState().radio.status === 'playing'`, 20000);
  check('after that first click, the next time the hi-fi is switched on the window plays without asking', (await tab.js(`!document.querySelector('.radio-notice')`)) && !(await tab.radio()).paused);
  await api('POST', '/radio/stop', {});
  const errs = [...(await appWin.js(`window.__bad`)), ...(await tab.js(`window.__bad`))];
  check('nothing was reported as an error along the way, in either window', errs.length === 0, errs.join(' | '));
  appWin.close();
  tab.close();
  exit = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${e.message}`);
} finally {
  app?.kill('SIGTERM');
  office.kill('SIGTERM');
  station.close();
  // The app is still writing its profile while it shuts down.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exit);
