#!/usr/bin/env node
/**
 * Multiplayer in the real desktop app: the start screen ("my office" or "join someone's"),
 * joining with an invitation (the certificate named in it, and no other), and two people
 * seeing and hearing each other in one office.
 *
 * Everything runs on this machine in throwaway folders and on spare ports: a host office
 * (development office, scripted workers), a guest's app, the host owner's app, and a third
 * app that opens an office of its own.
 *   node tests/ui/guest-app.mjs      (needs the UI build, Electron and openssl)
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-guest-'));
const apps = [];
const office = spawn(process.execPath, [path.join(root, 'scripts/dev-office.ts'), '--port', String(await freePort())], { stdio: ['ignore', 'pipe', 'ignore'], cwd: root });

/** Start the desktop app with its own data folder and a DevTools port; returns helpers to drive its windows. */
// Whatever an app does with "this computer" in someone's office happens in a tmux server and folders of the test's own,
// with the scripted worker: never the person's sessions, never the real CLI.
const tmuxSocket = `orch-guestapp-${process.pid}`;
let sandbox = {};
let offices = null;

async function launch(name, env = {}, script = path.join(root, 'apps/desktop/electron/main.cjs')) {
  const debugPort = await freePort();
  const child = spawn(electron, [script, `--remote-debugging-port=${debugPort}`], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ORCH_USER_DATA: path.join(tmp, name), ORCH_NO_KEYCHAIN: '1', ORCH_HIDDEN: '1', ORCH_NO_CLOSE_CONFIRM: '1', ...sandbox, ORCH_SERVER_HOME: path.join(tmp, `${name}-server`), ORCH_AGENT_HOME: path.join(tmp, `${name}-agent`), ...env },
  });
  apps.push(child);
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
    const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;
    const until = async (label, expr, ms = 30000) => {
      const end = Date.now() + ms;
      for (;;) {
        if (await js(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(250);
      }
    };
    // A window that was never shown may never answer this: give up rather than wait for ever.
    const shot = async (file) => {
      const res = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(8000)]);
      if (res?.result?.data) fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    };
    const errors = [];
    void send('Runtime.enable');
    const prev = ws.onmessage;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 300));
      prev(ev);
    };
    return { js, until, shot, errors, close: () => ws.close() };
  };
  /** The window whose address matches, once it exists. */
  const page = async (match, ms = 40000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = (await targets().catch(() => [])).find((x) => x.type === 'page' && match.test(x.url));
      if (t) return attach(t);
      if (Date.now() > end) throw new Error(`${name}: no window matching ${match}`);
      await sleep(300);
    }
  };
  return { child, page, targets };
}

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
  const host = new URL(info.url);
  // A short path: the agent's unix socket lives under it, and macOS limits such paths to about a hundred bytes.
  offices = fs.mkdtempSync('/tmp/orch-ga-');
  sandbox = { ORCH_OFFICES_HOME: offices, ORCH_TMUX_SOCKET: tmuxSocket, ORCH_CLAUDE_BIN: path.join(info.base, 'fake-claude'), ORCH_ALLOW_ROOT: fs.realpathSync(tmp) };
  const ownerToken = host.searchParams.get('token');
  const api = async (method, p, body) => {
    const r = await fetch(`${host.origin}/api${p}`, { method, headers: { authorization: `Bearer ${ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (r.status >= 400) throw new Error(`${method} ${p}: ${JSON.stringify(j)}`);
    return j;
  };
  // The host opens the office to guests and invites Mila as a visitor.
  const doorPort = await freePort();
  await api('POST', '/sharing', { open: true, port: doorPort, address: `https://127.0.0.1:${doorPort}` });
  const { invite } = await api('POST', '/guests', { name: 'Mila', role: 'visitor' });
  // What the office has for graphics is only where a new computer starts from.
  await api('PATCH', '/settings', { quality: 'medium' });
  const decoded = JSON.parse(Buffer.from(invite.split('.')[1], 'base64url').toString());
  // The same invitation pointing at a certificate that is not this office's.
  const tampered = `orch-invite-v1.${Buffer.from(JSON.stringify({ ...decoded, f: decoded.f.replace(/^../, decoded.f.startsWith('00') ? '11' : '00') })).toString('base64url')}`;

  // ── the guest's app: a start screen first ──
  const guest = await launch('guest', { ORCH_PORT: String(await freePort()) });
  const start = await guest.page(/connect\.html/);
  await start.until('the start screen', `document.getElementById('open-own') && document.getElementById('join')`);
  check('the app starts with a choice: my office, or join someone’s', /Which office/.test(await start.js(`document.body.textContent`)) && !(await start.js(`document.getElementById('open-own').disabled`)));
  const tryInvite = async (code) => {
    await start.js(`(() => { document.getElementById('invite').value = ${JSON.stringify(code)}; document.getElementById('join').click(); })()`);
    await start.until('an answer', `document.getElementById('join-error').style.display === 'block'`, 30000);
    const text = await start.js(`document.getElementById('join-error').textContent`);
    await start.js(`(() => { document.getElementById('join-error').style.display = 'none'; })()`);
    return text;
  };
  check('something that is not an invitation is refused with an explanation', /does not look like an invitation/.test(await tryInvite('hello')));
  const wrongCert = await tryInvite(tampered);
  check('an invitation that names a different certificate is refused before anything is sent', /is not the one this invitation was made for/.test(wrongCert), wrongCert.slice(0, 90));
  // With only an address: the app knocks — but never at a door whose certificate this computer has no reason to trust.
  await start.js(`(() => { const i = document.getElementById('invite'); i.value = '127.0.0.1:${doorPort}'; i.dispatchEvent(new Event('input')); })()`);
  const asksName = await start.js(`!document.getElementById('knock-who').hidden && document.getElementById('join').textContent`);
  await start.js(`(() => { document.getElementById('knock-name').value = 'Mallory'; document.getElementById('join').click(); })()`);
  await start.until('an answer', `document.getElementById('join-error').style.display === 'block'`, 30000);
  const untrusted = await start.js(`document.getElementById('join-error').textContent`);
  check('an address instead of an invitation: the app asks for a name and knocks — but not at a door with a certificate it cannot trust', asksName === 'Ask to come in' && /no certificate this computer trusts/.test(untrusted) && (await api('GET', '/knocks')).length === 0, untrusted.slice(0, 80));
  await start.js(`(() => { document.getElementById('join-error').style.display = 'none'; const i = document.getElementById('invite'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await start.js(`(() => { document.getElementById('invite').value = ${JSON.stringify(invite)}; document.getElementById('join').click(); })()`);
  const guestPage = await guest.page(new RegExp(`^https://[\\d.]+:${doorPort}/`));
  await guestPage.until('the office as a guest', `window.__office && window.__office.getState().me && window.__office.getState().settings`, 40000);
  const me = await guestPage.js(`JSON.parse(JSON.stringify(window.__office.getState().me))`);
  check('the invitation opens the host’s office, as the invited person with their role', me.kind === 'guest' && me.role === 'visitor' && me.name === 'Mila', JSON.stringify(me));
  check('the guest sees the host’s employees', (await guestPage.js(`Object.keys(window.__office.getState().employees).length`)) >= 8);
  const refused = await guestPage.js(`fetch('/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + window.orchestrator.token }, body: JSON.stringify({ name: 'Intruder' }) }).then(async (r) => r.status + ' ' + (await r.json()).error)`);
  check('what a visitor may not do is refused by the office itself', /^403 You are visiting this office/.test(refused), refused);

  // ── the visitor's own settings: kept on their computer, changed without asking the office for anything ──
  const prefsFile = path.join(tmp, 'guest', 'prefs.json');
  const readPrefs = () => JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  await guestPage.until('the preferences of this computer', `window.__orchPrefs.getState().ready && document.querySelector('.hud')`);
  await sleep(500);
  check('on a computer with no preferences yet, the office’s graphics setting is where it starts, and that is written down here', (await guestPage.js(`window.__orchPrefs.getState().prefs.quality`)) === 'medium' && fs.existsSync(prefsFile) && readPrefs().quality === 'medium', fs.existsSync(prefsFile) ? `prefs.json: ${readPrefs().quality}` : 'no prefs.json');
  const errorsBefore = guestPage.errors.length;
  await guestPage.js(`(() => { window.__bad = []; const f = window.fetch; window.fetch = async (...a) => { const r = await f(...a); if (!r.ok) window.__bad.push(r.status + ' ' + (a[0] && a[0].url || a[0])); return r; }; })()`);
  const button = (text, scope = 'document') => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  await guestPage.js(`[...document.querySelectorAll('button')].find((b) => /Menu/.test(b.textContent)).click()`);
  await guestPage.until('the menu', `${button('Settings', `document.querySelector('.dock')`)}`, 5000);
  await guestPage.js(`${button('Settings', `document.querySelector('.dock')`)}.click()`);
  await guestPage.until('the Settings window', `document.querySelector('.win') && /Saved on this computer/.test(document.querySelector('.win').textContent)`, 15000);
  const win = `document.querySelector('.win')`;
  const groups = await guestPage.js(`[...${win}.querySelectorAll('nav .section-title')].map((e) => e.textContent).join(' | ')`);
  check('a visitor opens Settings from the menu and lands on what is theirs: “This computer”, next to “The office”', groups === 'This computer | The office' && (await guestPage.js(`!!${win}.querySelector('[data-settings-scope=mine]')`)), groups);
  await guestPage.js(`[...${win}.querySelectorAll('label.pc-choice')].find((l) => l.textContent.trim().startsWith('Low')).querySelector('input').click()`);
  await guestPage.until('the chosen quality', `window.__orchPrefs.getState().prefs.quality === 'low'`, 8000);
  await guestPage.js(`${button('Controls', win)}.click()`);
  await guestPage.until('the key bindings', `${win}.querySelector('.pc-keyrow .pc-key')`, 8000);
  await guestPage.js(`${button('Foreman', win)}.click()`);
  await guestPage.until('the office’s settings, read-only', `${win}.querySelector('[data-settings-scope=office-readonly]')`, 8000);
  const locked = await guestPage.js(`(() => { const all = [...${win}.querySelectorAll('.split-main input, .split-main button')]; return all.length + ' controls, ' + all.filter((e) => e.matches(':disabled')).length + ' disabled; ' + ${win}.querySelector('[data-settings-scope=office-readonly]').textContent.trim(); })()`);
  const lockedN = /^(\d+) controls, (\d+) disabled/.exec(locked);
  check('the office’s own settings are shown to a visitor read-only, with one line saying why', !!lockedN && Number(lockedN[1]) > 0 && lockedN[1] === lockedN[2] && /only its owners can change them/.test(locked) && !(await guestPage.js(`!!${button('Audit log', win)}`)), locked.slice(0, 150));
  await sleep(1500);
  const officeQuality = (await api('GET', '/state')).settings.quality;
  check('the visitor’s graphics choice is stored on their computer, in a file only they can read; the office’s setting did not change', readPrefs().quality === 'low' && (fs.statSync(prefsFile).mode & 0o777) === 0o600 && officeQuality === 'medium', `prefs.json: ${readPrefs().quality}; the office: ${officeQuality}`);
  const bad = await guestPage.js(`JSON.stringify(window.__bad)`);
  check('none of it made a request the office refused, and the page reported no error', bad === '[]' && guestPage.errors.length === errorsBefore, `${bad} ${guestPage.errors.slice(errorsBefore).join(' | ').slice(0, 200)}`);
  await guestPage.js(`window.__office.getState().openPanel(null)`);

  // ── the host's own window: the two see and hear each other ──
  const owner = await launch('owner', { ORCH_SERVER_URL: host.origin, ORCH_TOKEN: ownerToken });
  const ownerPage = await owner.page(new RegExp(`^${host.origin.replace(/[.]/g, '\\.')}/`));
  await ownerPage.until('the owner’s office', `window.__office && window.__office.getState().me`);
  await guestPage.js(`window.__orchPlayer.goto = { x: 3, z: 2, rot: 1 }; true`);
  await ownerPage.until('the guest in the owner’s office', `window.__office.getState().people.some((p) => p.name === 'Mila' && Math.abs(p.x - 3) < 1.5)`, 20000);
  await ownerPage.until('the guest’s character in the 3D office', `[...document.querySelectorAll('.human-name')].some((e) => e.textContent === 'Mila')`, 15000).catch(async (e) => {
    console.log('  debug:', await ownerPage.js(`JSON.stringify({ clientId: window.__office.getState().clientId, people: window.__office.getState().people.map((p) => [p.id.slice(0, 6), p.name]), tags: document.querySelectorAll('.human-tag').length, employeeTags: document.querySelectorAll('.tag').length, hasHumanHtml: document.body.innerHTML.includes('human-'), milaLeaves: [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent === 'Mila').map((e) => e.className + '<' + (e.parentElement && e.parentElement.className)), htmlRoots: [...document.querySelector('canvas').parentElement.children].length, canvas: !!document.querySelector('canvas'), errs: (window.__errs || []).slice(0, 3), mode: window.__office.getState().cameraMode })`));
    console.log('  errors:', JSON.stringify(ownerPage.errors.slice(0, 4)));
    await ownerPage.shot(path.join(os.tmpdir(), 'orch-guest-owner-debug.png'));
    throw e;
  });
  check('the owner sees the guest walking around their office, by name', true, await ownerPage.js(`JSON.stringify(window.__office.getState().people.filter((p) => p.name === 'Mila').map((p) => [p.role, Math.round(p.x), Math.round(p.z)]))`));
  await guestPage.until('the owner in the guest’s view', `window.__office.getState().people.some((p) => p.role === 'owner') && [...document.querySelectorAll('.human-role')].some((e) => e.textContent === 'owner')`, 20000);
  check('the guest sees the owner', true);
  await ownerPage.js(`window.__office.getState().say('Welcome to the office')`);
  await guestPage.until('what the owner said', `window.__office.getState().chat.some((c) => c.text === 'Welcome to the office' && c.role === 'owner')`, 10000);
  await guestPage.until('the speech bubble', `[...document.querySelectorAll('.human-says')].some((e) => e.textContent === 'Welcome to the office')`, 8000);
  check('what one says, the other hears — as a bubble over their head', true);
  // The same line: over the speaker's own head in their own window, and in the chat box at the bottom left of both.
  const ownBubble = await ownerPage.until('the owner’s own bubble', `[...document.querySelectorAll('.self-says .human-says')].some((e) => e.textContent === 'Welcome to the office')`, 8000).then(() => true, () => false);
  check('the one who speaks sees the bubble over their own character', ownBubble);
  const lineOf = (page) => page.js(`[...document.querySelectorAll('.chatbox.awake .chat-line')].map((e) => e.textContent).find((t) => /Welcome to the office/.test(t)) || ''`);
  const [ownLine, guestLine] = [await lineOf(ownerPage), await lineOf(guestPage)];
  check('what was said is in the chat box of both, with the time and who said it', /^\[\d\d:\d\d\] \[.+\] says: Welcome to the office$/.test(ownLine) && ownLine === guestLine, `${ownLine} | ${guestLine}`);
  await ownerPage.js(`document.activeElement && document.activeElement.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }))`);
  const typed = await ownerPage.until('the chat line', `!!document.querySelector('.chatbox-form input')`, 5000).then(() => true, () => false);
  check('Enter opens the chat line, also for the owner', typed);
  await ownerPage.js(`document.querySelector('.chatbox-form input')?.blur()`);
  // The whip: everyone sees who swung and at whom.
  const victim = await ownerPage.js(`(() => { const e = Object.values(window.__office.getState().employees).find((x) => !x.archived); window.__office.getState().whip(e.id); return e.id + '|' + e.name; })()`);
  const [victimId, victimName] = victim.split('|');
  const seen = await guestPage.until('the crack of the whip', `Object.keys(window.__office.getState().peopleWhips).length === 1 && window.__office.getState().whips[${JSON.stringify(victimId)}] > 0`, 8000).then(() => true, () => false);
  const emote = await guestPage.js(`[...document.querySelectorAll('.chat-line.chat-emote')].map((e) => e.textContent).pop() || ''`);
  check('a crack of the whip is seen by the others, and is in the chat', seen && emote.endsWith(`cracks the whip at ${victimName}.`), emote);
  if (process.env.ORCH_SHOT_DIR) {
    await ownerPage.js(`window.__office.getState().say('Second line, to see the bubble')`);
    await new Promise((r) => setTimeout(r, 900));
    await ownerPage.shot(path.join(process.env.ORCH_SHOT_DIR, 'chat-owner.png'));
    await guestPage.shot(path.join(process.env.ORCH_SHOT_DIR, 'chat-guest.png'));
  }
  // ── knocking: someone with only the office's address ──
  // From the desktop app (here the office's own certificate is named to the app, as a real office's name would be trusted).
  const knocker = await launch('knocker', { ORCH_PORT: String(await freePort()), ORCH_KNOCK_PIN: decoded.f, ORCH_NO_PERSONAL_HOST: '1' });
  const kStart = await knocker.page(/connect\.html/);
  await kStart.until('the start screen', `document.getElementById('join')`);
  await kStart.js(`(() => { const i = document.getElementById('invite'); i.value = 'https://127.0.0.1:${doorPort}/'; i.dispatchEvent(new Event('input')); document.getElementById('knock-name').value = 'Petar'; document.getElementById('join').click(); })()`);
  await kStart.until('waiting at the door', `!document.getElementById('knock-wait').hidden && /^\\d{4}$/.test(document.getElementById('knock-code').textContent)`, 20000);
  const kCode = await kStart.js(`document.getElementById('knock-code').textContent`);
  await ownerPage.until('the door bell', `[...document.querySelectorAll('.doorbell-card')].some((c) => /Petar is at the door/.test(c.textContent))`, 10000);
  const bell = await ownerPage.js(`(() => { const c = document.querySelector('.doorbell-card'); return c.querySelector('.doorbell-code').textContent + ' | ' + [...c.querySelectorAll('button')].map((b) => b.textContent.trim()).join(',') + ' | ' + /with the Orchestrator app/.test(c.textContent); })()`);
  check('a knock from the app rings inside: the owner sees who, the same code, and chooses as what', bell === `${kCode} | Visitor,Colleague,Owner,Not now | true`, bell);
  check('a visitor inside is not asked', (await guestPage.js(`document.querySelectorAll('.doorbell-card').length + window.__office.getState().knocks.length`)) === 0);
  await ownerPage.js(`[...document.querySelectorAll('.doorbell-card button')].find((b) => b.textContent.trim() === 'Colleague').click()`);
  const petar = await knocker.page(new RegExp(`^https://[\\d.]+:${doorPort}/`));
  await petar.until('the office', `window.__office && window.__office.getState().ready && window.__office.getState().me`, 40000);
  const petarMe = await petar.js(`JSON.stringify([window.__office.getState().me.name, window.__office.getState().me.role])`);
  const petarSaved = JSON.parse(fs.readFileSync(path.join(tmp, 'knocker', 'joined.json'), 'utf8'));
  check('let in as a colleague, the app walks into the office and keeps the invitation it was given', petarMe === '["Petar","colleague"]' && petarSaved.length === 1 && petarSaved[0].guest === 'Petar' && petarSaved[0].addresses[0] === `https://127.0.0.1:${doorPort}`, `${petarMe} saved: ${petarSaved.map((j) => `${j.guest}/${j.role}`)}`);
  await ownerPage.until('the bell quiet', `document.querySelectorAll('.doorbell-card').length === 0`, 8000);
  // From a browser: the office's address shows a place to knock; whoever is let in can only look.
  const plain = path.join(tmp, 'plain-browser.cjs');
  fs.writeFileSync(plain, `const { app, BrowserWindow } = require('electron');\napp.commandLine.appendSwitch('ignore-certificate-errors');\napp.setPath('userData', ${JSON.stringify(path.join(tmp, 'plain-browser'))});\napp.whenReady().then(() => new BrowserWindow({ show: false, width: 1280, height: 820, webPreferences: { backgroundThrottling: false } }).loadURL(${JSON.stringify(`https://127.0.0.1:${doorPort}/`)}));\napp.on('window-all-closed', () => app.quit());\n`);
  const browser = await launch('browser', {}, plain);
  const tab = await browser.page(new RegExp(`^https://127\\.0\\.0\\.1:${doorPort}/`));
  await tab.until('the place to knock', `document.querySelector('.knock-card input')`, 30000);
  const doorText = await tab.js(`document.querySelector('.knock-card').textContent`);
  check('in a browser the office’s address is a door to knock on: its name, and what you will be able to do', doorText.includes(info.company ?? 'Northwind Labs') && /look around/.test(doorText) && !(await tab.js(`!!window.__office?.getState().ready`)), doorText.slice(0, 70));
  await tab.js(`(() => { const i = document.querySelector('.knock-card input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Zora'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await tab.js(`[...document.querySelectorAll('.knock-card button')].find((b) => /Ask to come in/.test(b.textContent)).click()`);
  await tab.until('the code', `document.querySelector('.knock-code')`, 10000);
  const tabCode = await tab.js(`document.querySelector('.knock-code').textContent.trim()`);
  await ownerPage.until('the door bell', `[...document.querySelectorAll('.doorbell-card')].some((c) => /Zora is at the door/.test(c.textContent))`, 10000);
  const bell2 = await ownerPage.js(`(() => { const c = document.querySelector('.doorbell-card'); return c.querySelector('.doorbell-code').textContent + ' | ' + [...c.querySelectorAll('button')].map((b) => b.textContent.trim()).join(',') + ' | ' + /from a browser/.test(c.textContent); })()`);
  check('a knock from a browser: the same code inside, and the only way in is to look around', bell2 === `${tabCode} | Let in to look around,Not now | true`, bell2);
  if (process.env.ORCH_SHOT_DIR) {
    await tab.shot(path.join(process.env.ORCH_SHOT_DIR, 'knock-browser.png'));
    await ownerPage.shot(path.join(process.env.ORCH_SHOT_DIR, 'knock-bell.png'));
    await kStart.shot(path.join(process.env.ORCH_SHOT_DIR, 'knock-app.png')).catch(() => undefined);
  }
  await ownerPage.js(`[...document.querySelectorAll('.doorbell-card button')].find((b) => /Let in to look around/.test(b.textContent)).click()`);
  await tab.until('the office', `window.__office && window.__office.getState().ready && window.__office.getState().me && document.querySelector('canvas')`, 40000);
  const zora = await tab.js(`JSON.stringify([window.__office.getState().me.name, window.__office.getState().me.role, Object.keys(window.__office.getState().employees).length > 0])`);
  const zoraTries = await tab.js(`fetch('/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('orch.token') }, body: JSON.stringify({ name: 'Intruder' }) }).then((r) => r.status)`);
  check('let in, the browser shows the office — read-only: the office refuses any change', zora === '["Zora","visitor",true]' && zoraTries === 403, `${zora} · POST → ${zoraTries}`);
  if (process.env.ORCH_SHOT_DIR) await tab.shot(path.join(process.env.ORCH_SHOT_DIR, 'knock-browser-in.png'));
  tab.close();
  petar.close();
  browser.child.kill();
  knocker.child.kill();
  // Those two were only here for this: their access is taken away again.
  for (const g of (await api('GET', '/sharing')).guests) if (['Petar', 'Zora'].includes(g.name) && !g.revokedAt) await api('DELETE', `/guests/${g.id}`);
  // The owner takes the access away: the guest's window loses the office at once.
  const guests = (await api('GET', '/sharing')).guests;
  await api('DELETE', `/guests/${guests.find((g) => g.name === 'Mila').id}`);
  await ownerPage.until('the guest gone', `!window.__office.getState().people.some((p) => p.name === 'Mila')`, 15000);
  check('revoking the guest removes them from the office at once', true);
  guestPage.close();
  ownerPage.close();
  owner.child.kill('SIGTERM');
  guest.child.kill('SIGTERM');

  // ── "my office": a third app opens an office of its own, on its own port and folders ──
  const ownPort = await freePort();
  const mine = await launch('mine', { ORCH_PORT: String(ownPort) });
  const mineStart = await mine.page(/connect\.html/);
  await mineStart.until('the start screen', `document.getElementById('open-own')`);
  await mineStart.js(`document.getElementById('open-own').click()`);
  const minePage = await mine.page(new RegExp(`^http://127\\.0\\.0\\.1:${ownPort}/`), 90000);
  await minePage.until('an office of one’s own', `window.__office && window.__office.getState().me && window.__office.getState().me.kind === 'owner' && Object.values(window.__office.getState().hosts).some((h) => h.status === 'online')`, 60000);
  check('“Open my office” starts the person’s own office on this computer, as its owner', true, `on port ${ownPort}`);
  check('the start screen is gone once an office is open', !(await mine.targets()).some((t) => t.type === 'page' && /connect\.html/.test(t.url)));
  minePage.close();
  mine.child.kill('SIGTERM');

  // ── the guest's app again: the office they joined is remembered ──
  const { invite: second } = await api('POST', '/guests', { name: 'Mila', role: 'colleague' });
  const again = await launch('guest2', { ORCH_PORT: String(await freePort()) });
  const againStart = await again.page(/connect\.html/);
  await againStart.until('the start screen', `document.getElementById('join')`);
  await againStart.js(`(() => { document.getElementById('invite').value = ${JSON.stringify(second)}; document.getElementById('join').click(); })()`);
  const p2 = await again.page(new RegExp(`^https://[\\d.]+:${doorPort}/`));
  await p2.until('the office', `window.__office && window.__office.getState().me`);
  await p2.until('this computer’s preferences', `window.__orchPrefs.getState().ready`);
  await sleep(600);

  // ── a colleague brings their own computer: it becomes a machine of the office, theirs alone, with a room ──
  await p2.until('this computer in the office', `(() => { const s = window.__office.getState(); return s.myHost.state === 'online' && Object.values(s.hosts).some((h) => h.memberId === s.me.id && h.status === 'online'); })()`, 40000).catch(async (e) => {
    throw new Error(`${e.message}: ${await p2.js(`JSON.stringify(window.__office.getState().myHost)`)}`);
  });
  const mineHost = await p2.js(`(() => { const s = window.__office.getState(); const h = Object.values(s.hosts).find((x) => x.memberId === s.me.id && x.status === 'online'); return { id: h.id, name: h.name, memberName: h.memberName, local: h.local, same: h.id === s.myHost.hostId }; })()`);
  check('joining as a colleague brings this computer into the office as their own machine', mineHost.memberName === 'Mila' && mineHost.local === false && mineHost.same, JSON.stringify(mineHost));
  check('the agent reached the office through the relay on this computer, with the pinned certificate', (await api('GET', '/state')).hosts.some((h) => h.id === mineHost.id && h.status === 'online' && h.info));
  // "My room" is in the menu; a folder on this computer becomes an employee who lives here.
  await p2.js(`window.__office.getState().openPanel('myroom')`);
  await p2.until('the room panel', `[...document.querySelectorAll('.win')].some((w) => /My room/.test(w.textContent) && /this computer is in the office/.test(w.textContent))`, 15000);
  const folder = path.join(tmp, 'milas-project');
  fs.mkdirSync(folder, { recursive: true });
  const call = (method, route, body) => p2.js(`fetch(${JSON.stringify('/api' + route)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + window.orchestrator.token }, body: ${body ? `JSON.stringify(${JSON.stringify(body)})` : 'undefined'} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  const hired = await call('POST', '/employees', { name: 'Nina', roleKey: 'backend', hostId: mineHost.id, workingDir: fs.realpathSync(folder), autonomy: 'autonomous' });
  check('an employee hired on it sits in the member’s room, not at a desk of the shared office', hired.status === 200 && hired.body.deskId === null, JSON.stringify(hired.body).slice(0, 160));
  await p2.until('Nina in the room panel', `[...document.querySelectorAll('.win .my-room-row')].some((r) => /Nina/.test(r.textContent))`, 10000);
  await call('POST', `/employees/${hired.body.id}/start`, {});
  await call('POST', `/employees/${hired.body.id}/message`, { body: 'Leave a note. @@fake: write here.txt on-milas-computer; say done@@' });
  const end = Date.now() + 40000;
  while (!fs.existsSync(path.join(folder, 'here.txt')) && Date.now() < end) await sleep(300);
  const wrote = fs.existsSync(path.join(folder, 'here.txt')) && fs.readFileSync(path.join(folder, 'here.txt'), 'utf8').trim() === 'on-milas-computer';
  let why = '';
  if (!wrote) {
    const st = await api('GET', '/state');
    const { execFileSync } = await import('node:child_process');
    let pane = '';
    try { pane = execFileSync('tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-J', '-S', '-25', '-t', st.sessions.find((x) => x.employeeId === hired.body.id)?.tmuxPane ?? ''], { encoding: 'utf8' }); } catch (e) { pane = String(e.message).slice(0, 200); }
    why = JSON.stringify({ session: st.sessions.filter((x) => x.employeeId === hired.body.id).map((x) => [x.status, x.activity, x.cwd]), messages: st.messages.filter((m) => m.toEmployeeId === hired.body.id).map((m) => m.delivery) }) + '\n' + pane;
  }
  check('her session runs on this computer, in this folder, and talks to the office through the relay', wrote, why);
  const room = await p2.until('the room in the 3D office', `(window.__orchScene.memberRooms || []).some((r) => r.hostId === ${JSON.stringify(mineHost.id)})`, 15000).then(() => p2.js(`JSON.stringify(window.__orchScene.memberRooms.map((r) => [r.memberName, r.desks]))`), (e) => `MISSING: ${e.message}`);
  check('the member’s room is attached to the office while they are in it', !/^MISSING/.test(room), room);
  // Hiring asks where first: the shared office on the server, or her own room — and then for the folder and the seat.
  await p2.js(`window.__office.getState().openPanel('team', 'hire')`);
  await p2.until('the two places', `document.querySelectorAll('.win .hire-place').length === 2`, 10000);
  const asked = await p2.js(`JSON.stringify([...document.querySelectorAll('.win .hire-place')].map((b) => [b.dataset.place, b.getAttribute('aria-checked')]))`);
  const formBefore = await p2.js(`!!document.querySelector('.win form')`);
  check('hiring first asks where: the shared office or my room, with nothing chosen for me', asked === '[["shared","false"],["mine","false"]]' && !formBefore, asked);
  await p2.js(`document.querySelector('.win .hire-place[data-place="mine"]').click()`);
  await p2.until('the form for my room', `document.querySelector('.win form') && /on your computer/.test(document.querySelector('.win').textContent) && document.querySelectorAll('.win .desk-seat').length >= 4`, 10000);
  const folder2 = path.join(tmp, 'milas-second');
  fs.mkdirSync(folder2, { recursive: true });
  const seatWanted = `m:${mineHost.id}:4`;
  await p2.js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; const w = document.querySelector('.win'); set(w.querySelector('input[placeholder="e.g. Alex"]'), 'Olga'); set(w.querySelector('input.mono.grow'), ${JSON.stringify(fs.realpathSync(folder2))}); w.querySelector('.desk-seat[data-desk="${seatWanted}"]').click(); })()`);
  await p2.until('the seat chosen', `document.querySelector('.win .desk-seat.on')?.dataset.desk === ${JSON.stringify(seatWanted)}`, 5000);
  await p2.js(`[...document.querySelectorAll('.win form button[type=submit]')].find((b) => b.textContent.trim() === 'Hire').click()`);
  await p2.until('Olga hired', `Object.values(window.__office.getState().employees).some((e) => e.name === 'Olga')`, 15000);
  const olga = await p2.js(`(() => { const e = Object.values(window.__office.getState().employees).find((e) => e.name === 'Olga'); return { hostId: e.hostId, deskId: e.deskId, dir: e.workingDir }; })()`);
  await p2.until('Olga at her seat in the room', `window.__orchScene.memberRooms.some((r) => r.desks.includes(${JSON.stringify(seatWanted)}))`, 10000);
  check('the hire lands on my computer, in the folder given, at the seat picked in my room', olga.hostId === mineHost.id && olga.deskId === seatWanted && olga.dir === fs.realpathSync(folder2), JSON.stringify(olga));
  await p2.js(`window.__office.getState().openPanel('myroom')`);

  // Her Claude account has a clock in her own room; the office's own accounts hang in the CEO room.
  await p2.until('her clock', `(window.__orchScene.memberClocks || {})[${JSON.stringify(mineHost.id)}]?.length === 1`, 20000).then(
    async () => check('the member’s own Claude account has its usage clock in their room, not in the CEO room', (await p2.js(`!(window.__orchScene.clocks || []).some((c) => /Mila/.test(c.name))`)) === true, await p2.js(`JSON.stringify([window.__orchScene.memberClocks, (window.__orchScene.clocks || []).map((c) => c.name)])`)),
    (e) => check('the member’s own Claude account has its usage clock in their room', false, e.message),
  );
  // Arranging the room: a name of its own, more desks and open floor — saved by the office, drawn at once.
  await p2.until('the room editor', `[...document.querySelectorAll('.win .room-editor')].length === 1`, 10000);
  const before = await p2.js(`JSON.stringify(window.__orchScene.memberRooms.map((r) => [r.desks.length, r.w, r.d]))`);
  await p2.js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; const ed = document.querySelector('.win .room-editor'); set(ed.querySelector('input[aria-label="Name on the door"]'), 'Mila Lab'); set(ed.querySelector('input[aria-label="Desks"]'), '6'); set(ed.querySelector('input[aria-label="Open floor"]'), '4'); })()`);
  await p2.until('the office has it', `(() => { const s = window.__office.getState(); const h = Object.values(s.hosts).find((x) => x.memberId === s.me.id); return h.room && h.room.title === 'Mila Lab' && h.room.desks === 6 && h.room.extraDepth === 4; })()`, 10000);
  await p2.until('the room redrawn', `window.__orchScene.memberRooms.some((r) => r.desks.length === 6)`, 10000);
  const after = await p2.js(`JSON.stringify(window.__orchScene.memberRooms.map((r) => [r.desks.length, r.w, r.d]))`);
  check('the member arranges their room from “My room”: its name, desks and size change for everyone', (await api('GET', '/state')).hosts.find((h) => h.id === mineHost.id).room.title === 'Mila Lab' && before !== after, `${before} → ${after}`);
  await p2.shot(path.join(tmp, 'member-room.png'));
  p2.close();
  again.child.kill('SIGTERM');
  // Leaving takes the computer out of the office; the session stays in tmux on it.
  {
    const end2 = Date.now() + 20000;
    let st;
    do {
      await sleep(400);
      st = await api('GET', '/state');
    } while (st.hosts.find((h) => h.memberName === 'Mila' && h.memberId)?.status === 'online' && Date.now() < end2);
    const h2 = st.hosts.find((h) => h.memberName === 'Mila' && h.memberId);
    check('when the member leaves, their computer is offline in the office — and no alarm is raised', h2?.status === 'offline' && !st.notifications.some((n) => n.kind === 'host_disconnected' && n.hostId === h2.id), h2?.status);
    const { execFileSync } = await import('node:child_process');
    const left = execFileSync('tmux', ['-L', tmuxSocket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
    check('her session keeps running in tmux on her computer', /nina/i.test(left), left);
  }
  // The office changes its own graphics setting afterwards: a computer that already has preferences keeps them.
  await api('PATCH', '/settings', { quality: 'low' });
  await sleep(1500);
  const third = await launch('guest2', { ORCH_PORT: String(await freePort()) });
  const thirdStart = await third.page(/connect\.html/);
  await thirdStart.until('the remembered office', `document.querySelector('#joined .joined')`, 15000);
  const remembered = await thirdStart.js(`document.querySelector('#joined .joined').textContent`);
  await thirdStart.js(`document.querySelector('#joined .joined button').click()`);
  const p3 = await third.page(new RegExp(`^https://[\\d.]+:${doorPort}/`));
  await p3.until('the office again', `window.__office && window.__office.getState().me && window.__office.getState().me.role === 'colleague'`);
  check('an office joined before is offered on the start screen and opens with one click', /as Mila · colleague/.test(remembered), remembered.replace(/\s+/g, ' ').slice(0, 80));
  const stored = fs.readFileSync(path.join(tmp, 'guest2', 'joined.json'), 'utf8');
  check('the invitation is kept in a file only this person can read', (fs.statSync(path.join(tmp, 'guest2', 'joined.json')).mode & 0o777) === 0o600 && JSON.parse(stored).length === 1);
  await p3.until('this computer’s preferences', `window.__orchPrefs.getState().ready`);
  check('preferences are read back when the app is opened again; what the office has by then is ignored', (await p3.js(`window.__orchPrefs.getState().prefs.quality`)) === 'medium' && JSON.parse(fs.readFileSync(path.join(tmp, 'guest2', 'prefs.json'), 'utf8')).quality === 'medium', `this computer: ${await p3.js(`window.__orchPrefs.getState().prefs.quality`)}; the office: ${(await api('GET', '/state')).settings.quality}`);
  p3.close();
  third.child.kill('SIGTERM');
  await sleep(1500);

  // ── "open at start": the office on a server is where the app goes by itself ──
  const fourth = await launch('guest2', { ORCH_PORT: String(await freePort()) });
  const fourthStart = await fourth.page(/connect\.html/);
  await fourthStart.until('the remembered office', `document.querySelector('#joined .joined .at-start input')`, 15000);
  await fourthStart.js(`document.querySelector('#joined .joined .at-start input').click()`);
  await fourthStart.until('ticked', `document.querySelector('#joined .joined .at-start input').checked`, 5000);
  check('a saved office can be marked to open at start', JSON.parse(fs.readFileSync(path.join(tmp, 'guest2', 'joined.json'), 'utf8'))[0].atStart === true);
  fourthStart.close();
  fourth.child.kill('SIGTERM');
  await sleep(1500);
  const fifth = await launch('guest2', { ORCH_PORT: String(await freePort()) });
  const p5 = await fifth.page(new RegExp(`^https://[\\d.]+:${doorPort}/`), 40000).catch((e) => null);
  if (p5) await p5.until('the office', `window.__office && window.__office.getState().me && window.__office.getState().me.role === 'colleague'`, 30000);
  check('started again, the app walks straight into that office — no start screen, nothing to click', !!p5 && !(await fifth.targets()).some((t) => t.type === 'page' && /connect\.html/.test(t.url)));
  p5?.close();
  exit = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${e.message}`);
} finally {
  for (const a of apps) a.kill('SIGTERM');
  office.kill('SIGTERM');
  await sleep(800);
  // The tmux server this test made for "the member's computer" (its own socket; nobody else's sessions are on it).
  try {
    (await import('node:child_process')).execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* it never started */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (offices) fs.rmSync(offices, { recursive: true, force: true });
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exit);
