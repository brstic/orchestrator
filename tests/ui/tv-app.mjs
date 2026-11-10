#!/usr/bin/env node
/**
 * The office TV in the real desktop app: the app's own main process (not the UI test's plain
 * window) is started against a development office and driven over the DevTools protocol. The TV
 * browses a page served on this machine, so no internet is needed.
 *   node tests/ui/tv-app.mjs      (needs the UI build and Electron)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// A small "web site" for the TV.
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/second') ? '<title>Second Page</title><body style="background:#123;color:#fff"><h1>Second</h1>' : '<title>Test Channel</title><body style="background:#b00;color:#fff"><h1>On air</h1><a id="next" href="/second">next</a><a id="popup" href="/second" target="_blank">popup</a>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tv-'));
const office = spawn(process.execPath, [path.join(root, 'scripts/dev-office.ts'), '--port', String(4700 + Math.floor(Math.random() * 200))], { stdio: ['ignore', 'pipe', 'ignore'], cwd: root });
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
  const debugPort = 9300 + Math.floor(Math.random() * 300);
  app = spawn(electron, [path.join(root, 'apps/desktop/electron/main.cjs'), `--remote-debugging-port=${debugPort}`], {
    stdio: process.env.ORCH_DEBUG_TV ? 'inherit' : 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ORCH_SERVER_URL: u.origin, ORCH_TOKEN: u.searchParams.get('token'), ORCH_USER_DATA: path.join(tmp, 'userdata'), ORCH_NO_KEYCHAIN: '1', ORCH_HIDDEN: '1' },
  });
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
    return {
      // `gesture`: run it as if the person clicked (browsers only open new windows for real clicks).
      js: async (expression, gesture = false) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture })).result?.result?.value,
      // A real mouse click at the middle of an element.
      click: async (selector) => {
        const r = (await send('Runtime.evaluate', { expression: `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`, returnByValue: true })).result.result.value;
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      },
      close: () => ws.close(),
    };
  };
  let pageTarget;
  for (let i = 0; i < 80 && !pageTarget; i++) {
    await sleep(500);
    pageTarget = (await targets().catch(() => [])).find((t) => t.type === 'page' && t.url.startsWith(u.origin));
  }
  if (!pageTarget) throw new Error('the office window did not open');
  const page = await attach(pageTarget);
  const until = async (label, expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await page.js(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await sleep(250);
    }
  };
  const tv = (expr) => page.js(`(() => { const tv = window.__office.getState().tv; return ${expr}; })()`);
  await until('the office', `window.__office && window.__office.getState().settings`);
  check('the desktop app gives the page a TV bridge', await page.js(`!!(window.orchestrator && window.orchestrator.tv && window.orchestrator.tv.partition === 'persist:orch-tv')`));

  await page.js(`window.__frames = 0; window.orchestrator.tv.onFrame(() => window.__frames++); window.__office.getState().tvOpen(${JSON.stringify(siteUrl + '/')})`);
  await until('the page on the TV', `window.__office.getState().tv.page && window.__office.getState().tv.page.title === 'Test Channel'`);
  check('the TV is a real browser: it loaded the page and reports its title and address', (await tv('tv.page.url')) === `${siteUrl}/`, await tv('tv.page.title'));
  await until('a picture', `window.__frames >= 2`, 15000);
  check('its picture reaches the office about once a second (for the screen on the wall)', true, `${await page.js('window.__frames')} frames so far`);

  const guestTarget = (await targets()).find((t) => t.type === 'webview');
  const guest = await attach(guestTarget);
  const inside = await guest.js(`({ node: typeof require !== 'undefined' || typeof process !== 'undefined', bridge: typeof window.orchestrator, electron: /Electron/.test(navigator.userAgent) })`);
  check('the page on the TV has no Node, no office bridge, and looks like an ordinary browser', inside.node === false && inside.bridge === 'undefined' && inside.electron === false, JSON.stringify(inside));
  const reach = await guest.js(`fetch(${JSON.stringify(u.origin + '/healthz')}, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`);
  check("a page on the TV cannot reach the office's own server", reach === 'blocked', reach);
  const camera = await guest.js(`navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => 'refused: ' + e.name)`);
  check('camera access is refused', /^refused/.test(camera), camera);
  // A link that wants a new window opens in the TV itself.
  await guest.click('#popup');
  await until('the popup target in the same TV', `window.__office.getState().tv.page.title === 'Second Page'`);
  await sleep(2500);
  check('the page stays where its own link led (the TV does not pull it back)', (await tv('tv.page.title')) === 'Second Page');
  check('a link that wants a new window opens in the TV, not in a window of its own', (await targets()).filter((t) => t.type === 'page').length === 1);
  guest.close();
  const file = await page.js(`(async () => { const wv = document.querySelector('webview.tv-web'); try { await wv.loadURL('file:///etc/hosts'); } catch { /* refused */ } await new Promise((r) => setTimeout(r, 1200)); return wv.getURL(); })()`);
  check('a file address is never shown on the TV', !/^file:/.test(file), file);

  // Put away, it keeps running; switched off, it is gone.
  await page.js(`window.__office.getState().openPanel(null)`);
  await sleep(1500);
  const frames = await page.js('window.__frames');
  await sleep(2500);
  check('put away, the TV keeps running (it still sends its picture) and the top bar says it is on', (await page.js('window.__frames')) > frames && /TV · /.test(await page.js(`(document.querySelector('.radio-mini') || {}).textContent || ''`)) && (await page.js(`!!document.querySelector('webview.tv-web')`)));
  await page.js(`window.__office.getState().tvOff()`);
  await sleep(800);
  check('switched off, the browser is closed', (await page.js(`!document.querySelector('webview.tv-web') && !window.__office.getState().tv.on`)) && !(await targets()).some((t) => t.type === 'webview'));
  // Only the TV's own partition may be used for an embedded browser.
  const rogue = await page.js(`new Promise((resolve) => { const wv = document.createElement('webview'); wv.setAttribute('src', ${JSON.stringify(siteUrl + '/')}); wv.setAttribute('partition', 'persist:other'); wv.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px'; document.body.appendChild(wv); let ok = false; wv.addEventListener('dom-ready', () => (ok = true)); setTimeout(() => { wv.remove(); resolve(ok); }, 2500); })`);
  check('an embedded browser outside the TV partition is refused', rogue === false);
  page.close();
  exit = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${e.message}`);
} finally {
  app?.kill('SIGTERM');
  office.kill('SIGTERM');
  site.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exit);
