#!/usr/bin/env node
/**
 * Runs the packages built by `pnpm package` the way a user would, in throwaway
 * state directories:  pnpm package:smoke [--shot <png>]
 *
 *   1. unpacks release/orchestrator-<version>.tar.gz somewhere else and starts
 *      bin/orchestrator: the server must come up, serve the office UI, and the
 *      bundled host agent must enroll and report this machine;
 *   2. (macOS) launches release/Orchestrator.app, which must start its own backend
 *      and render the office (a screenshot is taken and the app quits).
 *
 * Nothing touches ~/.orchestrator, and no Claude session is started.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --out <dir>: check a build made with `package.mjs --out <dir>` instead of release/.
const releaseDir = process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : path.join(root, 'release');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const argv = process.argv.slice(2);
const shot = argv.includes('--shot') ? path.resolve(argv[argv.indexOf('--shot') + 1]) : null;
// Short path: unix socket paths are limited to ~104 bytes.
const tmp = fs.mkdtempSync('/tmp/orch-pkg-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const stop = async (child) => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
};

try {
  // ───────────── 1. portable tarball ─────────────
  const tarball = path.join(releaseDir, `orchestrator-${version}.tar.gz`);
  if (!fs.existsSync(tarball)) throw new Error(`${tarball} not found — run: pnpm package`);
  execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
  const home = path.join(tmp, `orchestrator-${version}`);
  check('tarball unpacks to a self-contained directory', fs.existsSync(path.join(home, 'bin/orchestrator')) && !fs.existsSync(path.join(home, 'node_modules')), fs.readdirSync(home).join(' '));
  const env = { ...process.env, ORCH_SERVER_HOME: path.join(tmp, 's1'), ORCH_AGENT_HOME: path.join(tmp, 'a1') };
  const port = await freePort();
  const child = spawn(path.join(home, 'bin/orchestrator'), ['--json', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const ready = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const j = JSON.parse(line);
        if (j.url && j.token) resolve(j);
      } catch {
        /* not the ready line */
      }
    });
    child.on('exit', () => resolve(null));
    setTimeout(() => resolve(null), 40000);
  });
  check('bin/orchestrator starts the bundled server and agent', !!ready, ready ? ready.url : stderr.trim().slice(-300));
  if (ready) {
    const auth = { authorization: `Bearer ${ready.token}` };
    const page = await (await fetch(`${ready.url}/`)).text();
    check('the server serves the built office UI', /<div id="root"/.test(page) && /assets\/index-/.test(page));
    let host = null;
    for (let i = 0; i < 80 && !host; i++) {
      const state = await (await fetch(`${ready.url}/api/state`, { headers: auth })).json();
      host = state.hosts.find((h) => h.status === 'online' && h.info?.runtimes) ?? null;
      if (!host) await sleep(250);
    }
    check('the bundled host agent enrolled and reports this machine', !!host, host ? `${host.name}: Claude Code ${host.info.claudeVersion ?? 'not found'}, tmux ${host.info.tmuxVersion ?? 'not found'}, runtimes ${host.info.runtimes.join('+')}` : 'no online host');
    check('unauthenticated API access is refused', (await fetch(`${ready.url}/api/state`)).status === 401);
    const dl = await fetch(`${ready.url}/downloads/orchestrator-agent.mjs`);
    check('the server offers the agent bundle to other machines', dl.ok && (await dl.text()).length > 50_000);
    const out = (bin, ...a) => execFileSync(path.join(home, 'bin', bin), a, { env, encoding: 'utf8' }).trim();
    check('bin/orchestrator-agent runs standalone', /^\d+\.\d+\.\d+/.test(out('orchestrator-agent', 'version')), `version ${out('orchestrator-agent', 'version')}; ${out('orchestrator-agent', 'sdk', 'status').split('\n')[0]}`);
    check('bin/orchestrator-server runs standalone', /--database/.test(out('orchestrator-server', '--help')));

    // The desktop app as a pure client of that office (what a Windows machine, or any second computer, does).
    const clientApp = path.join(releaseDir, 'Orchestrator.app', 'Contents/MacOS/Electron');
    if (process.platform === 'darwin' && fs.existsSync(clientApp)) {
      const userData = path.join(tmp, 'client-data');
      const resultFile = path.join(tmp, 'connect.log');
      const launch = (extra, png) =>
        new Promise((resolve) => {
          const p = spawn(clientApp, [], { env: { ...process.env, ORCH_REMOTE_ONLY: '1', ORCH_NO_KEYCHAIN: '1', ORCH_USER_DATA: userData, ORCH_SMOKE_SCREENSHOT: png, ORCH_SMOKE_WAIT_MS: '7000', ...extra }, stdio: 'ignore' });
          const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
          p.on('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
      const first = path.join(tmp, 'connect-1.png');
      await launch({ ORCH_SMOKE_CONNECT: JSON.stringify({ url: ready.url, token: ready.token, badToken: 'orch_owner_not-the-real-one' }), ORCH_SMOKE_RESULT: resultFile }, first);
      const lines = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '';
      check('connect screen: it refuses to send the token to another machine without TLS', /plain http to another machine: .*https:\/\//.test(lines), (/plain http to another machine: (.*)/.exec(lines)?.[1] ?? 'no result').slice(0, 110));
      check('connect screen: a wrong owner token is refused with the reason', /wrong token: .*did not accept/.test(lines), (/wrong token: (.*)/.exec(lines)?.[1] ?? 'no result').slice(0, 110));
      check('connect screen: the right address and token open that office', fs.existsSync(first) && fs.statSync(first).size > 30_000, fs.existsSync(first) ? `office rendered (${(fs.statSync(first).size / 1024).toFixed(0)} KB)` : 'no office window');
      // Tests never touch the real keychain (ORCH_NO_KEYCHAIN): the token then lives in a file only the owner can read.
      const savedFile = path.join(userData, 'connection.json');
      const saved = fs.existsSync(savedFile) ? fs.readFileSync(savedFile, 'utf8') : '';
      check('the connection is saved in a file only the owner can read', saved.includes(ready.url) && (fs.statSync(savedFile).mode & 0o777) === 0o600, saved ? `mode ${(fs.statSync(savedFile).mode & 0o777).toString(8)}` : 'not saved');
      const second = path.join(tmp, 'connect-2.png');
      await launch({}, second);
      check('the next launch opens the saved office directly', fs.existsSync(second) && fs.statSync(second).size > 30_000);
      if (shot && fs.existsSync(first)) fs.copyFileSync(first, shot.replace(/\.png$/, '-remote.png'));
    }
  }
  await stop(child);

  // ───────────── 2. macOS desktop app ─────────────
  const app = path.join(releaseDir, 'Orchestrator.app');
  if (process.platform === 'darwin' && fs.existsSync(app)) {
    const png = path.join(tmp, 'app.png');
    const appPort = await freePort();
    const electron = spawn(path.join(app, 'Contents/MacOS/Electron'), [], {
      env: { ...process.env, ORCH_SERVER_HOME: path.join(tmp, 's2'), ORCH_AGENT_HOME: path.join(tmp, 'a2'), ORCH_PORT: String(appPort), ORCH_SMOKE_SCREENSHOT: png, ORCH_SMOKE_WAIT_MS: '8000' },
      stdio: 'ignore',
    });
    const code = await new Promise((resolve) => {
      electron.on('exit', resolve);
      setTimeout(() => resolve('timeout'), 90000);
    });
    if (code === 'timeout') await stop(electron);
    const ok = fs.existsSync(png) && fs.statSync(png).size > 30_000;
    check('Orchestrator.app starts its own backend and renders the office', ok, ok ? `screenshot ${(fs.statSync(png).size / 1024).toFixed(0)} KB, exit ${code}` : `no screenshot (exit ${code})`);
    check('the app runs entirely from inside its bundle', fs.existsSync(path.join(app, 'Contents/Resources/app/apps/server/dist/orchestrator-server.mjs')) && fs.existsSync(path.join(tmp, 's2', 'owner-token')));
    if (ok && shot) {
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      fs.copyFileSync(png, shot);
      console.log(`  screenshot saved to ${shot}`);
    }
    await sleep(1500);
  } else console.log('- desktop app check skipped (macOS only, after `pnpm package`)');
} catch (e) {
  check(`smoke test aborted: ${e.message}`, false);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} package checks passed`);
process.exit(failed ? 1 : 0);
