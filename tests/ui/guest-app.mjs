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

async function launch(name, env = {}) {
  const debugPort = await freePort();
  const child = spawn(electron, [path.join(root, 'apps/desktop/electron/main.cjs'), `--remote-debugging-port=${debugPort}`], {
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
    const shot = async (file) => fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
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
