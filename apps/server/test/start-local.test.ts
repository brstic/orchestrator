/**
 * The launcher (`scripts/start-local.mjs`) and a server that is slow to come up.
 *
 * Seen on an office's server: after a deploy the server needed longer than the launcher waited. The launcher threw
 * and left — and the server it had started stayed, holding the office's ports. systemd started the launcher again,
 * whose own server could not listen, and so on, every few seconds, until someone ended the left-over by hand.
 *
 * So: a launcher that gives up ends what it started, and how long it waits is not a fixed fifteen seconds.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const skip = process.platform === 'win32' ? 'the launcher needs tmux' : false;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A copy of the launcher beside a stand-in server; the stand-in writes its pid and then behaves as `server` says. */
function office(server: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-start-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'apps/server/dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'apps/host-agent/dist'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts/start-local.mjs'), path.join(dir, 'scripts/start-local.mjs'));
  const pidFile = path.join(dir, 'server.pid');
  fs.writeFileSync(path.join(dir, 'apps/server/dist/orchestrator-server.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${server}\n`);
  fs.writeFileSync(path.join(dir, 'apps/host-agent/dist/orchestrator-agent.mjs'), 'setInterval(() => {}, 1000);\n');
  return { dir, pidFile };
}

async function launch(dir: string, env: Record<string, string>) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, 'scripts/start-local.mjs'), '--port', String(port)], { env: { ...process.env, ORCH_SERVER_HOME: path.join(dir, 'home/server'), ORCH_AGENT_HOME: path.join(dir, 'home/agent'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const began = Date.now();
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  const tookMs = Date.now() - began;
  // A server left behind still holds these pipes; let go of them, or this test would wait on it for ever.
  child.stdout.destroy();
  child.stderr.destroy();
  return { code, err, tookMs };
}

test('a launcher that gives up on a slow server ends that server, and leaves', { skip, timeout: 60_000 }, async () => {
  const { dir, pidFile } = office('setInterval(() => {}, 1000); // alive, and never answers');
  try {
    const { code, err, tookMs } = await launch(dir, { ORCH_START_WAIT_SEC: '2' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    const left = alive(pid);
    if (left) process.kill(pid, 'SIGKILL');
    assert.equal(left, false, 'the server it started must not be left behind, holding the port');
    assert.equal(code, 1);
    assert.match(err, /the server did not come up/);
    assert.ok(tookMs < 10_000, `it waits as long as it is told to, not a fixed time (took ${tookMs} ms)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a server that ends while it is being waited for is not waited for any longer', { skip, timeout: 60_000 }, async () => {
  const { dir } = office('setTimeout(() => process.exit(3), 300);');
  try {
    const { code, err, tookMs } = await launch(dir, { ORCH_START_WAIT_SEC: '40' });
    assert.equal(code, 1);
    assert.match(err, /server exited \(3\)/);
    assert.ok(tookMs < 10_000, `took ${tookMs} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Seen on the office's server (2026-11-20): the host agent fell over on an error in one tmux connection, and the
 * launcher then stopped the whole office — every client lost it for a while, three times in an hour. Now the agent
 * is started again and the office stays up.
 */
test('a host agent that falls over is started again, and the office stays up', { skip, timeout: 60_000 }, async () => {
  const port = await freePort();
  const { dir } = office(`import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
fs.mkdirSync(process.env.ORCH_SERVER_HOME, { recursive: true });
fs.writeFileSync(process.env.ORCH_SERVER_HOME + '/owner-token', 'orch_owner_test');
http.createServer((req, res) => res.end('ok')).listen(port, '127.0.0.1');`);
  // An agent that is enrolled already, and falls over the first two times it is started.
  const agentHome = path.join(dir, 'home/agent');
  fs.mkdirSync(agentHome, { recursive: true });
  fs.writeFileSync(path.join(agentHome, 'config.json'), JSON.stringify({ credential: 'c', serverUrl: `http://127.0.0.1:${port}` }));
  const starts = path.join(dir, 'agent-starts');
  fs.writeFileSync(path.join(dir, 'apps/host-agent/dist/orchestrator-agent.mjs'), `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
const n = fs.readFileSync(${JSON.stringify(starts)}, 'utf8').trim().split('\\n').length;
if (n <= 2) setTimeout(() => { throw new Error('write EPIPE (as in a tmux connection)'); }, 200);
else setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [path.join(dir, 'scripts/start-local.mjs'), '--port', String(port)], { env: { ...process.env, ORCH_SERVER_HOME: path.join(dir, 'home/server'), ORCH_AGENT_HOME: agentHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  try {
    const began = Date.now();
    while (Date.now() - began < 30_000) {
      if (fs.existsSync(starts) && fs.readFileSync(starts, 'utf8').trim().split('\n').length >= 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const pids = fs.readFileSync(starts, 'utf8').trim().split('\n').map(Number);
    assert.equal(pids.length, 3, `the agent was started again after each fall: ${err}`);
    assert.equal(child.exitCode, null, 'the launcher — the office — is still up');
    assert.ok((await fetch(`http://127.0.0.1:${port}/healthz`)).ok, 'and its server answers');
    assert.ok(alive(pids[2]!), 'the third agent runs');
    assert.match(err, /host agent exited \(1\); starting it again \(1 of 5/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
