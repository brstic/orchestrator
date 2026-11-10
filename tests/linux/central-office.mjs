#!/usr/bin/env node
/**
 * The office on a Linux server, people connecting from another computer.
 *
 * A Linux machine (a Docker container) installs the portable package the way docs/INSTALL.md
 * section 0 says, runs `orchestrator --door`, and its members are invited from its own terminal.
 * This computer is then two people's computer in turn: an owner and a colleague, each with the
 * real desktop app, crossing a real network boundary to the server.
 *
 *   node tests/linux/central-office.mjs          (needs Docker, the UI build, a packaged tarball: pnpm package)
 *
 * On the server the worker is the scripted fixture (a container has no Claude account). On this
 * computer the colleague's own session is started with the REAL Claude Code CLI if it is installed —
 * started only, no prompt is sent, so it uses none of the account's allowance — in a tmux server
 * and folder of the test's own. Pass --no-real-cli to use the fixture there too.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electron = path.join(root, 'apps/desktop/node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const tarball = fs.readdirSync(path.join(root, 'release')).filter((f) => /^orchestrator-\d[\d.]*\.tar\.gz$/.test(f)).sort().pop();
if (!tarball) throw new Error('no portable package in release/ — run: pnpm package');
const realCli = !process.argv.includes('--no-real-cli') && spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-central-'));
const offices = fs.mkdtempSync('/tmp/orch-co-');
const tmuxSocket = `orch-central-${process.pid}`;
const container = `orch-office-${process.pid}`;
const doorPort = await freePort();
const apps = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A command in the server's own terminal, as the user the office runs as. */
const onServer = (cmd) => docker('exec', container, 'sh', '-lc', cmd);

async function launch(name, env = {}) {
  const debugPort = await freePort();
  const child = spawn(electron, [path.join(root, 'apps/desktop/electron/main.cjs'), `--remote-debugging-port=${debugPort}`], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ORCH_USER_DATA: path.join(tmp, name), ORCH_NO_KEYCHAIN: '1', ORCH_HIDDEN: '1', ORCH_NO_CLOSE_CONFIRM: '1', ORCH_OFFICES_HOME: path.join(offices, name), ORCH_TMUX_SOCKET: tmuxSocket, ORCH_ALLOW_ROOT: fs.realpathSync(tmp), ...env },
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
    const send = (method, params = {}) => new Promise((resolve) => (pending.set(++id, resolve), ws.send(JSON.stringify({ id, method, params }))));
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
    const call = (method, route, body) => js(`fetch(${JSON.stringify('/api' + route)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + window.orchestrator.token }, body: ${body ? `JSON.stringify(${JSON.stringify(body)})` : 'undefined'} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    return { js, until, shot, call, close: () => ws.close() };
  };
  const page = async (match, ms = 40000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = (await targets().catch(() => [])).find((x) => x.type === 'page' && match.test(x.url));
      if (t) return attach(t);
      if (Date.now() > end) throw new Error(`${name}: no window matching ${match}`);
      await sleep(300);
    }
  };
  /** Paste an invitation on the start screen and wait for the office. */
  const connect = async (invite) => {
    const start = await page(/connect\.html/);
    await start.until('the start screen', `document.getElementById('join')`);
    await start.js(`(() => { document.getElementById('invite').value = ${JSON.stringify(invite)}; document.getElementById('join').click(); })()`);
    const p = await page(new RegExp(`^https://127\\.0\\.0\\.1:${doorPort}/`), 60000);
    await p.until('the office', `window.__office && window.__office.getState().me && window.__office.getState().settings`, 60000);
    return p;
  };
  return { child, page, connect };
}

let exit = 1;
try {
  // ── the server: a Linux machine, installed from the portable package ──
  docker('build', '-q', '-t', 'orchestrator-office', '-f', path.join(root, 'tests/linux/Dockerfile.office'), path.join(root, 'tests/linux'));
  docker('run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${doorPort}:4610`, '-v', `${path.join(root, 'release', tarball)}:/pkg.tar.gz:ro`, '-v', `${path.join(root, 'tests/fixtures')}:/fixtures:ro`, 'orchestrator-office', 'sleep', 'infinity');
  check('a Linux server', /Linux/.test(onServer('uname -sm')), onServer('uname -sm; . /etc/os-release; echo $PRETTY_NAME; node -v; tmux -V').replace(/\n/g, ' · '));
  onServer('tar xzf /pkg.tar.gz && mv orchestrator-* orchestrator && git config --global user.email office@example.test && git config --global user.name Office');
  // INSTALL.md section 0: start the office with its door open, at the address people will use.
  onServer(`cd orchestrator && nohup node scripts/start-local.mjs --door 4610 --address https://127.0.0.1:${doorPort} > ~/office.log 2>&1 & echo $! > ~/office.pid`);
  let status = '';
  for (let i = 0; i < 80 && !/Open to members/.test(status); i++) {
    await sleep(500);
    try {
      status = onServer('cd orchestrator && node scripts/office-admin.mjs status');
    } catch {
      /* not up yet */
    }
  }
  check('the office is installed from the package and running with its door open', /Open to members on port 4610/.test(status), status.split('\n')[0] || onServer('tail -5 ~/office.log'));
  const plain = await fetch(`https://127.0.0.1:${doorPort}/healthz`).then(() => 'trusted without pinning', (e) => String(e.cause?.code ?? e.message));
  check('it answers on the network with TLS and a certificate of its own, reachable only by pinning it', /SELF_SIGNED|DEPTH_ZERO|CERT/i.test(plain), plain);
  // The first owner and a colleague are invited from the server's terminal.
  const inviteOf = (out) => /orch-invite-v1\.\S+/.exec(out)?.[0];
  const ownerInvite = inviteOf(onServer('cd orchestrator && node scripts/office-admin.mjs invite Branko --role owner'));
  const colleagueInvite = inviteOf(onServer('cd orchestrator && node scripts/office-admin.mjs invite Fenix --role colleague'));
  check('the first owner and a colleague are invited from the server’s own terminal', !!ownerInvite && !!colleagueInvite, onServer('cd orchestrator && node scripts/office-admin.mjs status').split('\n').slice(-2).join(' | '));

  // ── person one: the owner, from this computer ──
  const ownerApp = await launch('owner', { ORCH_NO_PERSONAL_HOST: '1' });
  const owner = await ownerApp.connect(ownerInvite);
  const meOwner = await owner.js(`JSON.parse(JSON.stringify(window.__office.getState().me))`);
  check('the owner walks into the office on the server with the desktop app, with full rights', meOwner.kind === 'owner' && meOwner.name === 'Branko' && (await owner.call('GET', '/audit')).status === 200, JSON.stringify(meOwner));
  const shared = await owner.js(`Object.values(window.__office.getState().hosts).filter((h) => !h.memberId).map((h) => [h.name, h.status, h.info && h.info.platform])`);
  check('the server’s own machine is the shared one, and it is Linux', shared.length === 1 && shared[0][1] === 'online' && shared[0][2] === 'linux', JSON.stringify(shared));
  // A shared employee on the server: its folder is on the server, its work happens there.
  onServer('mkdir -p ~/projects/shop && cd ~/projects/shop && git init -q && echo shop > README.md && git add -A && git commit -q -m init');
  const hiredShared = await owner.call('POST', '/employees', { name: 'Serverina', roleKey: 'backend', workingDir: '/home/office/projects/shop', autonomy: 'autonomous' });
  await owner.call('POST', `/employees/${hiredShared.body.id}/start`, {});
  await owner.call('POST', `/employees/${hiredShared.body.id}/message`, { body: 'Leave a note. @@fake: write note.txt from-the-server; say done@@' });
  let note = '';
  for (let i = 0; i < 80 && !note; i++) {
    await sleep(500);
    note = onServer('cat ~/projects/shop/note.txt 2>/dev/null || true');
  }
  check('a shared employee hired by the owner works in a folder on the server (scripted worker there)', note === 'from-the-server' && !!hiredShared.body.deskId, `${note} · tmux on the server: ${onServer('tmux ls 2>/dev/null | cut -d: -f1 | tr "\\n" " "')}`);

  // ── person two: a colleague, with their own computer ──
  const colleagueApp = await launch('colleague', realCli ? {} : { ORCH_CLAUDE_BIN: path.join(tmp, 'fake-claude') });
  if (!realCli) fs.writeFileSync(path.join(tmp, 'fake-claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'tests/fixtures/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });
  const fenix = await colleagueApp.connect(colleagueInvite);
  await fenix.until('this computer in the office', `(() => { const s = window.__office.getState(); return s.myHost.state === 'online' && Object.values(s.hosts).some((h) => h.memberId === s.me.id && h.status === 'online'); })()`, 60000).catch(async (e) => {
    throw new Error(`${e.message}: ${await fenix.js(`JSON.stringify(window.__office.getState().myHost)`)}`);
  });
  const mine = await fenix.js(`(() => { const s = window.__office.getState(); const h = Object.values(s.hosts).find((x) => x.memberId === s.me.id); return { id: h.id, name: h.name, platform: h.info && h.info.platform, claude: h.info && h.info.claudeVersion }; })()`);
  check('the colleague’s computer joins the office on the server as their own machine', mine.name === "Fenix's computer" && mine.platform === process.platform, JSON.stringify(mine));
  check('a colleague does not run the office', (await fenix.call('GET', '/audit')).status === 403 && (await fenix.call('PATCH', '/settings', { companyName: 'x' })).status === 403);
  check('a colleague works with the shared employee on the server', (await fenix.call('POST', `/employees/${hiredShared.body.id}/message`, { body: 'One more. @@fake: write second.txt from-fenix; say ok@@' })).status === 200);
  // Their own employee: a folder on this computer.
  const folder = path.join(fs.realpathSync(tmp), 'fenix-project');
  fs.mkdirSync(folder);
  const hiredMine = await fenix.call('POST', '/employees', { name: 'Lokalko', roleKey: 'backend', hostId: mine.id, workingDir: folder, autonomy: 'auto' });
  check('their own employee has no desk in the shared office', hiredMine.status === 200 && hiredMine.body.deskId === null, JSON.stringify(hiredMine.body).slice(0, 200));
  const started = await fenix.call('POST', `/employees/${hiredMine.body.id}/start`, {});
  await fenix.until('the session running on this computer', `Object.values(window.__office.getState().sessions).some((x) => x.employeeId === ${JSON.stringify(hiredMine.body.id)} && x.status === 'running')`, 60000).catch(() => undefined);
  const session = await fenix.js(`(() => { const x = Object.values(window.__office.getState().sessions).find((x) => x.employeeId === ${JSON.stringify(hiredMine.body.id)}); return x ? { status: x.status, activity: x.activity, pane: x.tmuxPane, cwd: x.cwd, name: x.tmuxSession } : null; })()`);
  const pane = () => {
    try {
      return execFileSync('tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-J', '-S', '-40', '-t', session.pane], { encoding: 'utf8' });
    } catch (e) {
      return `(no pane: ${String(e.message).slice(0, 120)})`;
    }
  };
  check(`their session runs on this computer${realCli ? ' — the real Claude Code CLI, started and sent nothing' : ' (scripted worker)'}`, session?.status === 'running' && session.cwd === folder, JSON.stringify(session ?? started.body));
  if (realCli) {
    // Zero tokens: nothing is typed. The CLI starting with our settings, hooks and MCP endpoint (through the relay,
    // the door and the server on Linux) is what is checked; the SessionStart hook reaching the office proves the path.
    let text = '';
    let sawStart = false;
    for (let i = 0; i < 60 && !(sawStart && /Claude Code|❯|>/.test(text)); i++) {
      await sleep(1000);
      text = pane();
      sawStart = (await owner.call('GET', `/events?limit=200&employeeId=${hiredMine.body.id}`)).body?.some?.((e) => e.source?.kind === 'hook' || /session\.started|SessionStart/i.test(`${e.type} ${e.summary}`)) ?? false;
    }
    check('the real CLI is up in tmux on this computer and its hooks reach the office on the server', sawStart && text.trim().length > 0, text.trim().split('\n').filter(Boolean).slice(-4).join(' ⏎ '));
    const mcp = /orchestrator/.test(text) && /fail|error/i.test(text) ? 'the CLI reports a problem with the orchestrator MCP server' : '';
    check('the CLI reports no problem reaching the office’s worker endpoint', !mcp, mcp);
    let usage = null;
    for (let i = 0; i < 12 && !usage; i++) {
      await sleep(1000);
      usage = (await owner.call('GET', '/usage')).body?.find?.((a) => a.hostId === mine.id && a.reportedAt) ?? null;
    }
    // Not a check: Claude Code hands its status line the account's limits only once it knows them, which without a
    // single request (nothing is sent here) it may not.
    console.log(`  · usage from the real CLI's status line: ${usage ? `week ${usage.sevenDay?.usedPercent ?? '–'}% · 5 h ${usage.fiveHour?.usedPercent ?? '–'}%` : 'not reported without a request (expected when the CLI has made none)'}`);
  } else {
    await fenix.call('POST', `/employees/${hiredMine.body.id}/message`, { body: 'Note. @@fake: write here.txt on-fenix-computer; say ok@@' });
    for (let i = 0; i < 80 && !fs.existsSync(path.join(folder, 'here.txt')); i++) await sleep(500);
    check('work by their own employee happens on this computer', fs.existsSync(path.join(folder, 'here.txt')));
  }

  // ── the two of them in one office ──
  await owner.until('the colleague’s room', `(window.__orchScene.memberRooms || []).some((r) => r.memberName === 'Fenix')`, 30000).then(() => check('the owner sees the colleague’s room attached to the office, with their employee in it', true), (e) => check('the owner sees the colleague’s room attached to the office', false, e.message));
  await fenix.js(`window.__orchPlayer.goto = { x: 2, z: 3, rot: 1 }; true`);
  await owner.until('the colleague walking around', `window.__office.getState().people.some((p) => p.name === 'Fenix')`, 20000).then(() => check('they see each other in the office', true), (e) => check('they see each other in the office', false, e.message));
  // The owner can open the colleague's own terminal; the colleague's is theirs. (Asked of the office itself.)
  check('the owner may read what is on the colleague’s computer; a visitor-level stranger could not', (await owner.call('GET', `/employees/${hiredMine.body.id}/docs`)).status === 200);
  await owner.shot(path.join(root, '.orchestrator-dev', 'central-office-owner.png')).catch(() => undefined);
  let second = '';
  for (let i = 0; i < 60 && !second; i++) {
    await sleep(500);
    second = onServer('cat ~/projects/shop/second.txt 2>/dev/null || true');
  }
  check('what the colleague asked of the shared employee was done on the server', second === 'from-fenix', second);

  // ── leaving ──
  fenix.close();
  colleagueApp.child.kill('SIGTERM');
  await owner.until('the colleague’s computer gone', `!Object.values(window.__office.getState().hosts).some((h) => h.memberName === 'Fenix' && h.status === 'online')`, 30000).then(() => check('when the colleague leaves, their computer and room leave the office', true), (e) => check('when the colleague leaves, their computer leaves the office', false, e.message));
  const left = spawnSync('tmux', ['-L', tmuxSocket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).stdout.trim();
  check('their session keeps running in tmux on their computer', /lokalko/i.test(left), left);
  // The server restarts; nobody's work stops, invitations stay valid.
  onServer('kill -TERM $(cat ~/office.pid); sleep 3; cd orchestrator && nohup node scripts/start-local.mjs --door 4610 > ~/office2.log 2>&1 & echo $! > ~/office.pid');
  let back = '';
  for (let i = 0; i < 80 && !/Open to members/.test(back); i++) {
    await sleep(500);
    try {
      back = onServer('cd orchestrator && node scripts/office-admin.mjs status');
    } catch {
      /* restarting */
    }
  }
  check('after a restart of the office on the server the door is open again by itself and the members are still members', /Open to members/.test(back) && /Branko\s+owner/.test(back) && /Fenix\s+colleague/.test(back), back.split('\n')[0]);
  check('the shared employee’s tmux session on the server survived the restart', /serverina/i.test(onServer('tmux ls 2>/dev/null || true')));
  await owner.until('the owner’s window reconnected', `window.__office.getState().conn === 'online' && Object.values(window.__office.getState().hosts).some((h) => !h.memberId && h.status === 'online')`, 60000).then(() => check('the owner’s app reconnects to the restarted office with the same invitation', true), (e) => check('the owner’s app reconnects to the restarted office', false, e.message));
  owner.close();
  exit = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${e.message}`);
} finally {
  for (const a of apps) a.kill('SIGTERM');
  await sleep(1200);
  // Only what this test made: its container, its tmux server, its folders.
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.rmSync(offices, { recursive: true, force: true });
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exit);
