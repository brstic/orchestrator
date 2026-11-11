#!/usr/bin/env node
/**
 * One command for a local office:  pnpm start
 *
 * Starts the Orchestrator server and a host agent for this machine, enrolling
 * the agent automatically the first time. Nothing leaves localhost.
 *
 *   --port <n>     server port (default 4600)
 *   --open         open the office in your browser
 *   --json         print one JSON line {url, token} when ready (used by the desktop app)
 *   --root <dir>   directory the agent may work in (repeatable; default: your home directory)
 *
 * As an office other people connect to (see docs/INSTALL.md, "An office on a server"):
 *   --door [port]      open the office to its members on the network (TLS; default port 4610) and keep it open
 *   --address <url>    the address members reach it at, e.g. https://office.example.com:4610 (written into invitations)
 * Then invite people from this machine with:  pnpm office invite <name> --role owner|colleague|visitor
 *
 * Ctrl-C stops the server and the agent. Employees' tmux sessions keep running
 * and are picked up again on the next start.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const values = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const port = Number(value('--port', process.env.ORCH_PORT ?? 4600));
const json = flag('--json');
const say = (msg) => !json && console.log(msg);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Orchestrator needs Node.js 22.18 or newer (found ${process.versions.node}).`);
  process.exit(1);
}
for (const [bin, why] of [['tmux', 'employees run inside tmux sessions'], ['git', 'employees work in git worktrees']]) {
  if (spawnSync(bin, [bin === 'tmux' ? '-V' : '--version'], { stdio: 'ignore' }).status !== 0) {
    console.error(`"${bin}" was not found on PATH (${why}). Install it and try again.`);
    process.exit(1);
  }
}
if (spawnSync('claude', ['--version'], { stdio: 'ignore' }).status !== 0) say('warning: the "claude" CLI was not found on PATH; employees cannot start until Claude Code is installed.');

const serverHome = process.env.ORCH_SERVER_HOME ?? path.join(os.homedir(), '.orchestrator', 'server');
const agentHome = process.env.ORCH_AGENT_HOME ?? path.join(os.homedir(), '.orchestrator', 'agent');
const url = `http://127.0.0.1:${port}`;
const serverEntry = [path.join(root, 'apps/server/dist/orchestrator-server.mjs'), path.join(root, 'apps/server/src/main.ts')].find((p) => fs.existsSync(p));
const agentEntry = [path.join(root, 'apps/host-agent/dist/orchestrator-agent.mjs'), path.join(root, 'apps/host-agent/src/cli.ts')].find((p) => fs.existsSync(p));
const children = [];
let stopping = false;

function run(entry, argv, opts = {}) {
  // Node 22 still labels its built-in SQLite as experimental; that notice is not news to anyone running this.
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...argv], { cwd: os.homedir(), stdio: ['ignore', json ? 'ignore' : 'inherit', 'inherit'], env: { ...process.env, ORCH_SERVER_HOME: serverHome, ORCH_AGENT_HOME: agentHome }, ...opts });
  children.push(child);
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the server did not come up on ${url}`);
}

function agentConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentHome, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function enrollAgent(token) {
  const res = await fetch(`${url}/api/hosts/enroll-token`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'local', ttlMinutes: 10 }) });
  if (!res.ok) throw new Error(`could not create an enrollment token (${res.status})`);
  const { token: enroll } = await res.json();
  const roots = values('--root');
  const login = spawnSync(process.execPath, [agentEntry, 'login', '--server', url, '--token', enroll, ...roots.flatMap((r) => ['--allow-root', path.resolve(r)])], { stdio: json ? 'ignore' : 'inherit', env: { ...process.env, ORCH_AGENT_HOME: agentHome } });
  if (login.status !== 0) throw new Error('enrolling the local host agent failed');
}

function startAgent(token, retried = false) {
  const started = Date.now();
  const agent = run(agentEntry, ['connect', ...(json ? ['--quiet'] : [])]);
  agent.on('exit', async (code) => {
    if (stopping) return;
    // Exit code 2 = the server does not know this host (fresh database). Enroll again, once.
    if (code === 2 && !retried && Date.now() - started < 15000) {
      say('The server does not recognise this host; enrolling it again…');
      await enrollAgent(token).catch((e) => console.error(e.message));
      startAgent(token, true);
    } else {
      console.error(`host agent exited (${code}).`);
      shutdown(1);
    }
  });
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  // Leave only when the server and the agent have really ended (the server closes its database last), so that
  // whoever starts the office again — systemd, right after a deploy — does not find the old one still holding it.
  // Not for ever: after ten seconds this process goes regardless.
  const alive = () => children.filter((c) => c.exitCode === null && c.signalCode === null);
  const began = Date.now();
  const wait = setInterval(() => {
    if (alive().length && Date.now() - began < 10_000) return;
    clearInterval(wait);
    process.exit(code);
  }, 100);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const server = run(serverEntry, ['--port', String(port), ...(json ? ['--quiet'] : [])]);
server.on('exit', (code) => {
  if (!stopping) {
    console.error(`server exited (${code}).`);
    shutdown(1);
  }
});
await waitForServer();
const token = fs.readFileSync(path.join(serverHome, 'owner-token'), 'utf8').trim();
const cfg = agentConfig();
if (!cfg?.credential || cfg.serverUrl !== url) await enrollAgent(token);
startAgent(token);

// An office on a server: the door to its members is opened here, once; the server reopens it by itself after a restart.
let door = null;
if (flag('--door') || flag('--address')) {
  const given = value('--door', '');
  const wanted = { open: true, ...(/^\d+$/.test(given ?? '') ? { port: Number(given) } : {}), ...(flag('--address') ? { address: value('--address', '') } : {}) };
  const res = await fetch(`${url}/api/sharing`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(wanted) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.door?.open) {
    console.error(`The door could not be opened: ${body.error ?? body.door?.error ?? res.status}`);
    shutdown(1);
  } else door = body;
}

const officeUrl = `${url}/?token=${token}`;
if (json) console.log(JSON.stringify({ url, token, ...(door ? { door: door.door } : {}) }));
else {
  say('');
  say('  ORCHESTRATOR is running.');
  // On a server the output goes to a log; the office's own token does not belong there.
  say(door ? `  The office itself answers on ${url} (this machine only); its owner token is in ${path.join(serverHome, 'owner-token')}` : `  Open your office:  ${officeUrl}`);
  if (!fs.existsSync(path.join(root, 'apps/desktop/dist/index.html'))) say('  (The office UI has not been built yet — run: pnpm build:ui)');
  if (door) {
    say(`  Open to its members at:  ${[door.wanted.address, ...door.door.addresses].filter(Boolean).join('   ')}`);
    say('  Invite someone:  pnpm office invite <name> --role owner|colleague|visitor');
  }
  say('  Ctrl-C stops the server and agent; tmux sessions keep running.');
  say('');
}
if (flag('--open')) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [officeUrl], { stdio: 'ignore', detached: true }).unref();
