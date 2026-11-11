#!/usr/bin/env node
/**
 * The entrance page — what a browser gets at an office's address before anybody is signed in — used for real:
 * a made-up office with its door open (`scripts/entrance-office.ts`: scripted workers, invented people), and
 * plain browser windows at the door, each with a profile of its own, driven with real clicks, keys and the wheel.
 *
 * What is checked: the page comes up with the office's name, the little office is drawn and stays glued to the page
 * while it scrolls, the door folds and opens, the keyboard reaches it first; a wrong password is refused where it
 * was typed; a member signs in with a password and is in the office as that member; a visitor knocks, is seen
 * inside with the same code, and is let in to look; an invitation link still shows its page and its code still
 * redeems; a reader who asks for less motion gets the still page; nothing was logged as an error.
 *
 *   node tests/ui/entrance.mjs      (needs the UI build — `pnpm build:ui` — Electron and openssl)
 *
 * `ORCH_SHOT_DIR=<folder>` keeps pictures of the stages.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electron = path.join(root, 'apps/desktop/node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-entrance-'));
const shots = process.env.ORCH_SHOT_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true });
const port = await freePort();
const doorPort = await freePort();
const office = spawn(process.execPath, [path.join(root, 'scripts/entrance-office.ts'), '--port', String(port), '--door', String(doorPort)], { stdio: ['ignore', 'pipe', 'ignore'], cwd: root });
let browser = null;

/** One window of the browser, driven over the DevTools protocol: scripts, and real input. */
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 300));
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
  };
  const send = (method, params = {}) => new Promise((resolve) => pending.set(++id, resolve) && ws.send(JSON.stringify({ id, method, params })));
  await send('Runtime.enable');
  // The windows are never shown; they still have to behave as the one somebody is looking at.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;
  const until = async (label, expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await js(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await sleep(200);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    const res = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(8000)]);
    if (res?.result?.data) fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(res.result.data, 'base64'));
  };
  /** A real click in the middle of what the selector (or expression) finds. */
  const click = async (find) => {
    const at = await js(`(() => { const el = ${find.startsWith('(') ? find : `document.querySelector(${JSON.stringify(find)})`}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!at) throw new Error(`nothing to click: ${find}`);
    // The pointer goes there first, as a hand would take it.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
  };
  const type = (text) => send('Input.insertText', { text });
  const key = async (name, code, vk, modifiers = 0) => {
    // (A key that types something is a `keyDown` with its text; one that does not — Tab, Backspace — is a `rawKeyDown`.)
    const text = name === 'Enter' ? '\r' : null;
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  };
  const wheel = (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  return { js, until, shot, click, type, key, wheel, move, send, errors, close: () => ws.close() };
}

let exit = 1;
try {
  const info = await new Promise((resolve, reject) => {
    readline.createInterface({ input: office.stdout }).on('line', (line) => {
      try {
        const j = JSON.parse(line);
        if (j.door) resolve(j);
      } catch {
        /* not the ready line */
      }
    });
    office.on('exit', (code) => reject(new Error(`the office stopped (${code})`)));
    setTimeout(() => reject(new Error('the office did not start')), 90000);
  });
  const bea = info.members.find((m) => m.name === 'Bea');
  const ownerToken = new URL(info.owner).searchParams.get('token');
  const api = async (method, p, body) => {
    const r = await fetch(`${new URL(info.owner).origin}/api${p}`, { method, headers: { authorization: `Bearer ${ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };

  // A plain browser: three windows at the door, each with its own storage (three different people), and one for an invitation.
  const invited = await api('POST', '/guests', { name: 'Ines', role: 'colleague' });
  const inviteLink = invited.link ? String(invited.invite) : '';
  const debugPort = await freePort();
  const urls = [`${info.door}#member`, `${info.door}#visitor`, `${info.door}#calm`];
  const script = path.join(tmp, 'browser.cjs');
  fs.writeFileSync(
    script,
    `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.setPath('userData', ${JSON.stringify(path.join(tmp, 'profile'))});
app.whenReady().then(() => { ${JSON.stringify(urls)}.forEach((url, i) => new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { backgroundThrottling: false, partition: 'person-' + i } }).loadURL(url)); });
app.on('window-all-closed', () => app.quit());
`,
  );
  browser = spawn(electron, [script, `--remote-debugging-port=${debugPort}`], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const page = async (match, ms = 40000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = (await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json()).catch(() => [])).find((x) => x.type === 'page' && x.url.endsWith(match));
      if (t) return attach(t);
      if (Date.now() > end) throw new Error(`no window at ${match}`);
      await sleep(300);
    }
  };
  const SCROLLER = `document.querySelector('.ent')`;

  // ───────────── the page ─────────────
  const member = await page('#member');
  await member.until('the door', `document.querySelector('.knock-card') && document.querySelector('.ent h1')`, 40000);
  const doorText = await member.js(`document.querySelector('.knock-card').textContent`);
  const heroText = await member.js(`document.querySelector('.ent-hero').textContent`);
  check('at the office’s address a browser gets the entrance page: the office’s name on the door and in the greeting, and what a visitor may do', doorText.includes(info.company) && heroText.includes(info.company) && /look around/.test(doorText) && !(await member.js(`!!window.__office?.getState().ready`)), `${info.company}`);
  const drawn = await member.until('the little office', `document.querySelector('.ent-staged canvas')`, 30000).then(() => true, () => false);
  check('the office’s own figures are drawn on the page', drawn, drawn ? await member.js(`(() => { const c = document.querySelector('.ent canvas'); return c.width + '×' + c.height + ' canvas'; })()`) : 'no canvas (no WebGL here?)');
  const assets = await member.js(`performance.getEntriesByType('resource').map((r) => new URL(r.name).pathname).filter((p) => !/^\\/(assets\\/[A-Za-z0-9._-]+|knock)$/.test(p))`);
  check('everything the page fetched is one the door lets a stranger have: a file directly under /assets/, or the knock', Array.isArray(assets) && assets.length === 0, JSON.stringify(assets));
  await member.shot('entrance-top');

  // The intern can be clicked, as an employee can be whipped in the office: it flinches, says so, and that is all.
  if (drawn) {
    await sleep(1200);
    const sent = await member.js(`performance.getEntriesByType('resource').length`);
    const body = await member.js(`(() => { const r = document.querySelector('.ent-tag').getBoundingClientRect(); return [r.left + r.width / 2, r.bottom + 70]; })()`);
    await member.move(body[0], body[1]);
    for (const type of ['mousePressed', 'mouseReleased']) await member.send('Input.dispatchMouseEvent', { type, x: body[0], y: body[1], button: 'left', clickCount: 1 });
    const flinched = await member.until('the flinch', `document.querySelector('.ent-tag.is-ouch')`, 3000).then(() => true, () => false);
    await sleep(1300);
    const after = await member.js(`[document.querySelector('.ent-tag').classList.contains('is-ouch'), performance.getEntriesByType('resource').length]`);
    check('a click on the intern makes it flinch and say “jao!” for a moment — and sends nothing anywhere', flinched && after[0] === false && after[1] === sent, JSON.stringify([flinched, ...after, sent]));
  }

  // The keyboard comes to the door first, before anything of the page.
  await member.key('Tab', 'Tab', 9);
  const firstStop = await member.js(`(() => { const a = document.activeElement; return [!!a.closest('.ent-rig'), a.tagName, a.textContent.trim().slice(0, 20)]; })()`);
  check('the first stop of the Tab key is in the door', firstStop[0] === true, JSON.stringify(firstStop));
  await member.js(`${SCROLLER}.focus(); true`);

  // The wheel scrolls the page itself, and the drawing lies where the window is at every stop.
  const glued = [];
  for (let i = 0; i < 7; i++) {
    await member.wheel(500, 500, 620);
    await sleep(700);
    glued.push(await member.js(`(() => { const e = ${SCROLLER}; const st = document.querySelector('.ent-stage'); const y = new DOMMatrix(getComputedStyle(st).transform).m42; const over = (st.offsetHeight - e.clientHeight) / 2; return [Math.round(e.scrollTop), Math.round(y), Math.round(e.scrollTop - over)]; })()`));
  }
  check('the wheel scrolls the page, and the drawing is laid where the window is each time', glued.at(-1)[0] > 3000 && glued.every(([, y, want]) => Math.abs(y - want) <= 1), JSON.stringify(glued));
  const folded = await member.js(`[document.querySelector('.ent-rig').classList.contains('is-folded'), !!document.querySelector('.ent-door-fold').inert, document.querySelector('.ent-tag-state').textContent]`);
  check('down the page the door is folded to its name (its fields out of the keyboard’s way), and the intern has a tag', folded[0] === true && folded[1] === true && folded[2].length > 2, JSON.stringify(folded));
  await member.shot('entrance-middle');
  await member.click('.ent-fold');
  const opened = await member.until('the door open again', `document.querySelector('.ent-rig').classList.contains('is-open') && document.activeElement.tagName === 'INPUT' && !document.querySelector('.ent-door-fold').inert`, 5000).then(() => true, () => false);
  // (It opens over a moment; a hand would wait for it too.)
  await sleep(700);
  check('one click opens it again, with the cursor in its first field', opened, await member.js(`document.querySelector('.ent-rig').className + ' · ' + document.activeElement.tagName`));

  // ───────────── a member signs in ─────────────
  await member.click(`([...document.querySelectorAll('.ent-seg button')].find((b) => b.textContent.trim() === 'Member'))`);
  await member.until('the sign-in form', `document.querySelector('.knock-card input[autocomplete="username"]') && document.querySelector('.knock-card input[type="password"][autocomplete="current-password"]') && document.querySelector('.knock-card form')`, 5000);
  await member.click('.knock-card input[autocomplete="username"]');
  await member.type('bea');
  await member.click('.knock-card input[type="password"]');
  await member.type('not the password');
  await member.key('Enter', 'Enter', 13);
  await member.until('the refusal', `document.querySelector('.knock-card [role="alert"]')`, 10000).catch(async (e) => {
    throw new Error(`${e.message} — ${await member.js(`JSON.stringify([document.querySelector('.ent-rig').className, document.querySelector('.knock-card').dataset.mode, [...document.querySelectorAll('.knock-card input')].map((i) => i.name + '=' + i.value.length), document.activeElement.tagName + '.' + document.activeElement.className, document.querySelector('.ent-go')?.disabled])`)}`);
  });
  const refusal = await member.js(`[document.querySelector('.knock-card [role="alert"]').textContent, localStorage.getItem('orch.token'), !!document.querySelector('.ent')]`);
  check('a wrong password is refused where it was typed, and nothing is kept', refusal[0].length > 5 && refusal[1] === null && refusal[2] === true, refusal[0]);
  await member.click('.knock-card input[type="password"]');
  for (let i = 0; i < 'not the password'.length; i++) await member.key('Backspace', 'Backspace', 8);
  await member.type(bea.password);
  await member.shot('entrance-sign-in');
  await member.click(`([...document.querySelectorAll('.knock-card button')].find((b) => b.textContent.trim() === 'Sign in'))`);
  await member.until('the office', `window.__office && window.__office.getState().ready && window.__office.getState().me && document.querySelector('canvas')`, 40000);
  const me = await member.js(`JSON.stringify([window.__office.getState().me.name, window.__office.getState().me.role, localStorage.getItem('orch.login-name'), !!localStorage.getItem('orch.token'), !!document.querySelector('.ent')])`);
  check('with the right one the member is in the office as themselves — name, role — and the browser remembers the name and the session', me === '["Bea","owner","bea",true,false]', me);
  await member.shot('entrance-signed-in');

  // ───────────── a visitor knocks ─────────────
  const visitor = await page('#visitor');
  await visitor.until('the door', `document.querySelector('.knock-card input')`, 40000);
  await visitor.click('.knock-card input');
  await visitor.type('Zora');
  await visitor.click(`([...document.querySelectorAll('.knock-card button')].find((b) => /Ask to come in/.test(b.textContent)))`);
  await visitor.until('the code', `document.querySelector('.knock-code')`, 10000);
  const code = await visitor.js(`document.querySelector('.knock-code').textContent.trim()`);
  await member.until('the bell inside', `[...document.querySelectorAll('.doorbell-card')].some((c) => /Zora is at the door/.test(c.textContent))`, 15000);
  const bell = await member.js(`(() => { const c = [...document.querySelectorAll('.doorbell-card')].find((x) => /Zora/.test(x.textContent)); return c.querySelector('.doorbell-code').textContent + ' | ' + [...c.querySelectorAll('button')].map((b) => b.textContent.trim()).join(','); })()`);
  check('a knock from the page is seen inside with the same code, and from a browser the only way in is to look around', bell === `${code} | Let in to look around,Not now` && /^\d{4}$/.test(code), bell);
  await visitor.shot('entrance-knocked');
  await member.click(`([...document.querySelectorAll('.doorbell-card button')].find((b) => /Let in to look around/.test(b.textContent)))`);
  await visitor.until('the office', `window.__office && window.__office.getState().ready && window.__office.getState().me`, 40000);
  const zora = await visitor.js(`JSON.stringify([window.__office.getState().me.name, window.__office.getState().me.role])`);
  check('let in, the visitor’s page becomes the office, to look at', zora === '["Zora","visitor"]', zora);

  // ───────────── an invitation ─────────────
  const linkPath = inviteLink ? new URL(inviteLink).pathname : '';
  const invitePage = linkPath ? await visitor.js(`fetch(${JSON.stringify(linkPath)}).then(async (r) => [r.status, (await r.text()).includes(${JSON.stringify(info.company)})])`) : null;
  const redeemed = linkPath ? await visitor.js(`fetch('/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: ${JSON.stringify(linkPath.split('/').pop())} }) }).then(async (r) => { const a = await r.json(); return [r.status, a.name, a.role, String(a.invite).startsWith('orch-invite-v1.')]; })`) : null;
  check('an invitation link still shows its own page at the door, and its code is exchanged once for what the app keeps', JSON.stringify(invitePage) === '[200,true]' && JSON.stringify(redeemed) === '[200,"Ines","colleague",true]', `${linkPath} → ${JSON.stringify(invitePage)} ${JSON.stringify(redeemed)}`);

  // ───────────── less motion ─────────────
  const calm = await page('#calm');
  await calm.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await calm.send('Page.reload');
  await calm.until('the still page', `document.querySelector('.ent.ent-calm .knock-card')`, 40000);
  await calm.until('its drawing', `document.querySelector('.ent-staged canvas')`, 30000).catch(() => undefined);
  await sleep(1500);
  const still = await calm.js(`(async () => { const e = ${SCROLLER}; const tag = () => document.querySelector('.ent-tag').style.transform; const lean = () => getComputedStyle(document.querySelector('.ent-rig')).transform; e.scrollTop = 0; await new Promise((r) => setTimeout(r, 400)); const a = [tag(), lean()]; await new Promise((r) => setTimeout(r, 1200)); const b = [tag(), lean()]; e.scrollTop = 1500; await new Promise((r) => setTimeout(r, 300)); const c = lean(); return [a[0] === b[0], a[1] === b[1], c, [...document.querySelectorAll('.ent-reveal')].every((x) => getComputedStyle(x).opacity === '1'), /still/.test(document.querySelector('.ent-footer').textContent)]; })()`);
  check('asked for less motion, the page is still: nobody walks, the door does not swing, nothing fades in — and it says why', still[0] === true && still[1] === true && (still[2] === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(still[2])) && still[3] === true && still[4] === true, JSON.stringify(still));
  await calm.shot('entrance-calm');

  const errors = [...member.errors, ...visitor.errors, ...calm.errors].filter((e) => !/Electron Security Warning|favicon/.test(e));
  check('nothing was logged as an error in any of the windows', errors.length === 0, errors.slice(0, 3).join(' · '));
  member.close();
  visitor.close();
  calm.close();
  exit = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${e.message}`);
} finally {
  browser?.kill('SIGTERM');
  office.kill('SIGTERM');
  await new Promise((r) => {
    office.once('exit', r);
    setTimeout(r, 12000);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exit);
