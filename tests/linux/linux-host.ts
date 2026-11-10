/**
 * A real Linux host (Docker container: Debian, Node 22, tmux 3.3) joins an
 * office whose server runs on this machine over TLS. Started by run.sh.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullState, ServerToClient } from '@orchestrator/contracts';
import { b64decode } from '@orchestrator/contracts';
import { startServer } from '../../apps/server/src/server.ts';

const tmp = process.argv[2]!;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok]);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const port = await freePort();
const publicUrl = `https://host.docker.internal:${port}`;
const server = await startServer({ dataDir: path.join(tmp, 'server'), host: '0.0.0.0', port, tls: { certFile: path.join(tmp, 'cert.pem'), keyFile: path.join(tmp, 'key.pem') }, publicUrl, quiet: true });
const local = `https://localhost:${port}`;
const api = async <T = any>(method: string, p: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${local}/api${p}`, { method, headers: { authorization: `Bearer ${server.ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${JSON.stringify(j)}`);
  return j as T;
};
const state = () => api<FullState>('GET', '/state');
async function until<T>(label: string, fn: (s: FullState) => T | undefined | null | false, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn(await state());
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(300);
  }
}

const name = `orch-linux-${process.pid}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
// The server runs inside this process, so anything in the container that talks to the server
// must not block this process's event loop while it waits.
const dockerAsync = (...args: string[]) =>
  new Promise<string>((resolve, reject) => execFile('docker', args, { encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(stdout))));
let failed: Error | null = null;
try {
  // Plain HTTP against the TLS port must not work, and a non-loopback bind without TLS is refused outright.
  await startServer({ dataDir: path.join(tmp, 'refused'), host: '0.0.0.0', port: await freePort(), quiet: true }).then(
    async (s) => {
      await s.close();
      check('the server refuses a non-loopback address without TLS', false);
    },
    (e) => check('the server refuses a non-loopback address without TLS', /without TLS/.test(e.message)),
  );

  const { token } = await api('POST', '/hosts/enroll-token', { label: 'linux-box' });
  const entry = [
    'set -e',
    'mkdir -p ~/work/svc ~/work/shared ~/work/sdk && cd ~/work/svc',
    'for d in ~/work/svc ~/work/shared ~/work/sdk; do cd $d && git init -q -b main && echo "# $(basename $d)" > README.md && printf \'{"name":"x","scripts":{"test":"node check.js"}}\' > package.json && echo "console.log(\\"all checks passed on \\" + process.platform)" > check.js && git add -A && git -c user.name=dev -c user.email=dev@example.test commit -qm init; done',
    'printf \'#!/bin/sh\\nexec node /orch/tests/fixtures/fake-claude.mjs "$@"\\n\' > ~/fake-claude && chmod +x ~/fake-claude',
    `node /orch/apps/host-agent/dist/orchestrator-agent.mjs login --server ${publicUrl} --token ${token} --name linux-box --allow-root /home/dev/work`,
    // Point the agent at the scripted worker (there is no Claude login inside this container).
    'node -e \'const fs=require("fs"),p=process.env.HOME+"/.orchestrator/agent/config.json",c=JSON.parse(fs.readFileSync(p));c.claudeBin=process.env.HOME+"/fake-claude";c.sdkPath="/orch/tests/fixtures/fake-agent-sdk";fs.writeFileSync(p,JSON.stringify(c,null,2))\'',
    'exec node /orch/apps/host-agent/dist/orchestrator-agent.mjs connect',
  ].join('\n');
  const container = spawn('docker', ['run', '--rm', '--name', name, '-v', `${root}:/orch:ro`, '-v', `${path.join(tmp, 'cert.pem')}:/cert.pem:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/cert.pem', 'orchestrator-linux-host', 'bash', '-c', entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  let containerLog = '';
  container.stdout.on('data', (d) => (containerLog += d));
  container.stderr.on('data', (d) => (containerLog += d));

  const host = await until('linux host online', (s) => s.hosts.find((h) => h.name === 'linux-box' && h.status === 'online' && h.resources), 60000).catch((e) => {
    console.log(containerLog.slice(-1500));
    throw e;
  });
  check('a Linux machine enrolled over TLS and came online', host.info?.platform === 'linux', `${host.info?.platform}/${host.info?.arch}, agent ${host.info?.agentVersion}, tmux ${host.info?.tmuxVersion}, node in container ${docker('exec', name, 'node', '-v').trim()}`);
  check('its resources are measured on Linux (/proc)', typeof host.resources?.memUsedBytes === 'number' && host.resources.memUsedBytes > 0 && typeof host.resources.loadAvg1 === 'number', `mem ${Math.round((host.resources!.memUsedBytes ?? 0) / 1e6)} MB of ${Math.round((host.resources!.memTotalBytes ?? 0) / 1e6)} MB, load ${host.resources?.loadAvg1}`);

  // The cubicle model on Linux: hire into a folder, talk, do a verified task in place.
  const lin = await api('POST', '/employees', { name: 'Lin', roleKey: 'backend', hostId: host.id, workingDir: '/home/dev/work/svc', autonomy: 'standard', verifyCommand: 'npm test --silent' });
  const session = await api('POST', `/employees/${lin.id}/start`, {});
  await until('session ready', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false));
  check('a worker runs in tmux on the Linux machine', /orch-lin-/.test(docker('exec', name, 'tmux', 'list-sessions', '-F', '#{session_name}')), docker('exec', name, 'tmux', 'list-sessions', '-F', '#{session_name}').trim());
  const task = await api('POST', '/tasks', { projectId: lin.projectId, title: 'Linux change', assigneeId: lin.id, description: '@@fake: write linux.txt made-on-linux; commit linux change; ask Which kernel?; complete linux change done@@' });
  const q = await until('question over TLS MCP', (s) => s.questions.find((x) => x.employeeId === lin.id && x.status === 'open' && x.channel === 'mcp_tool'));
  check('the worker reached the MCP endpoint over TLS and asked the boss', q.text === 'Which kernel?');
  await api('POST', `/questions/${q.id}/answer`, { answer: 'Any LTS' });
  const done = await until('task done', (s) => s.tasks.find((t) => t.id === task.id && t.status === 'DONE'));
  check('the task was verified by running the command on the Linux machine', done.evidence.verification?.provenance === 'measured' && /all checks passed on linux/.test(done.evidence.verification.outputTail), done.evidence.verification?.outputTail.trim());
  check('the commit is in the folder on the Linux machine', /linux change/.test(docker('exec', name, 'git', '-C', '/home/dev/work/svc', 'log', '--oneline', '-1')));

  // The SDK-managed runtime on Linux, started from the bundled agent (the SDK here is the scripted stand-in).
  check('the Linux machine reports the SDK-managed runtime', !!host.info?.runtimes?.includes('managed_sdk'), JSON.stringify(host.info?.runtimes));
  const sdk = await api('POST', '/employees', { name: 'Sid', roleKey: 'backend', hostId: host.id, workingDir: '/home/dev/work/sdk', autonomy: 'standard', executionMode: 'managed_sdk' });
  const sdkSession = await api('POST', `/employees/${sdk.id}/start`, {});
  await until('sdk worker ready', (s) => s.sessions.find((x) => x.id === sdkSession.id && x.inTurn === false));
  const sdkMsg = await api('POST', `/employees/${sdk.id}/message`, { body: 'Leave a note. @@fake: write note.txt from-the-sdk-runtime; say note-left-on-linux@@' });
  const sdkDelivered = await until('sdk delivery', (s) => s.messages.find((m) => m.id === sdkMsg.id && m.delivery.status === 'confirmed'));
  await until('sdk turn finished', (s) => s.sessions.find((x) => x.id === sdkSession.id && x.inTurn === false));
  check(
    'an SDK-managed worker runs on Linux from the bundled agent: structured delivery, real file written',
    sdkSession.mode === 'managed_sdk' && sdkDelivered.delivery.via === 'sdk' && docker('exec', name, 'cat', '/home/dev/work/sdk/note.txt').trim() === 'from-the-sdk-runtime' && /managed-run/.test(docker('exec', name, 'tmux', 'display-message', '-p', '-t', sdkSession.tmuxPane, '#{pane_start_command}')),
    `mode ${sdkSession.mode}, delivered via ${sdkDelivered.delivery.via}`,
  );

  // Shared project with isolated worktrees on Linux.
  const shared = await api('POST', '/projects', { name: 'Shared on Linux', repoPath: '/home/dev/work/shared', hostId: host.id, verifyCommand: 'npm test --silent' });
  const pat = await api('POST', '/employees', { name: 'Pat', roleKey: 'frontend', hostId: host.id, projectId: shared.id, autonomy: 'standard' });
  const t2 = await api('POST', '/tasks', { projectId: shared.id, title: 'Worktree change', assigneeId: pat.id, description: '@@fake: write wt.txt in-a-worktree; commit worktree change; complete worktree change done@@' });
  const done2 = await until('worktree task done', (s) => s.tasks.find((t) => t.id === t2.id && t.status === 'DONE'));
  check('worktree isolation and merge work on Linux', done2.evidence.merge?.ok === true && docker('exec', name, 'git', '-C', '/home/dev/work/shared', 'show', 'orchestrator/integration:wt.txt').trim() === 'in-a-worktree', `${done2.worktree} → ${done2.evidence.merge?.into}`);

  // Observe and take control of a terminal that lives on the Linux machine.
  const ws = new WebSocket(`wss://localhost:${port}/ws/client?token=${server.ownerToken}`);
  let term = '';
  let snap = -1;
  let control = '';
  const pending: Array<{ seq: number; text: string }> = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as ServerToClient;
    if (m.t === 'term.snapshot') {
      term = Buffer.from(b64decode(m.snapshot.data)).toString('utf8');
      snap = m.snapshot.seq;
      for (const p of pending) if (p.seq > snap) term += p.text;
    } else if (m.t === 'term.output') {
      const text = Buffer.from(b64decode(m.data)).toString('utf8');
      pending.push({ seq: m.seq, text });
      if (snap >= 0 && m.seq > snap) term += text;
    } else if (m.t === 'control' && m.sessionId === session.id) control = `${m.control}${m.you ? ':you' : ''}`;
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: 'term.open', sessionId: session.id }));
  const waitTerm = async (re: RegExp, label: string) => {
    const end = Date.now() + 20000;
    while (!re.test(term)) {
      if (Date.now() > end) throw new Error(`timed out waiting for terminal: ${label}`);
      await sleep(150);
    }
  };
  await waitTerm(/FAKE CLAUDE/, 'snapshot from the Linux pane');
  check('the terminal on the Linux machine is readable from the office (tmux 3.3 control mode)', /The boss answered: Any LTS/.test(term), `${term.length} bytes`);
  ws.send(JSON.stringify({ t: 'control.acquire', sessionId: session.id }));
  while (control !== 'HUMAN_CONTROLLED:you') await sleep(100);
  ws.send(JSON.stringify({ t: 'term.input', sessionId: session.id, data: '@@fake: say typed-from-the-mac-ünïcödé@@\r' }));
  await waitTerm(/typed-from-the-mac-ünïcödé/, 'echo of typed input');
  check('taking control types into the Linux session, UTF-8 intact', /typed-from-the-mac-ünïcödé/.test(docker('exec', name, 'tmux', '-u', 'capture-pane', '-p', '-t', session.tmuxPane, '-S', '-30')), 'the container has no UTF-8 locale; the agent forces UTF-8 with tmux -u');
  ws.send(JSON.stringify({ t: 'control.release', sessionId: session.id }));
  ws.close();

  // The CLI on the Linux machine.
  const agentBin = ['exec', name, 'node', '/orch/apps/host-agent/dist/orchestrator-agent.mjs'];
  const status = await dockerAsync(...agentBin, 'status');
  check('`orchestrator-agent status` works on Linux', /connected/.test(status) && /Lin/.test(status) && /Pat/.test(status), status.split('\n')[1]?.trim());
  const unit = docker(...agentBin, 'service', 'install');
  check('`orchestrator-agent service install` writes a systemd user unit', /orchestrator-agent\.service/.test(unit) && /ExecStart=.*orchestrator-agent\.mjs connect/.test(docker('exec', name, 'cat', '/home/dev/.config/systemd/user/orchestrator-agent.service')));
  const installer = await (await fetch(`${local}/install-agent.sh`)).text();
  const installLog = await dockerAsync('exec', name, 'bash', '-c', `cat > /tmp/install.sh <<'EOS'\n${installer}\nEOS\nCURL_CA_BUNDLE=/cert.pem ORCH_INSTALL_DIR=/home/dev/bin sh /tmp/install.sh 2>&1`);
  check('the one-line installer served by the server installs a working agent on Linux', docker('exec', name, '/home/dev/bin/orchestrator-agent', 'version').trim() === '0.1.0', installLog.trim().split('\n').find((l) => /Installed/.test(l)) ?? installLog.trim().split('\n').pop());

  // The machine goes away: its sessions are no longer shown as running.
  docker('kill', name);
  await until('host offline', (s) => s.hosts.find((h) => h.id === host.id && h.status === 'offline'));
  const after = await state();
  check('when the machine disappears its employees are shown honestly', after.sessions.filter((x) => x.hostId === host.id).every((x) => x.status === 'host_offline' && x.activity === 'unknown'));
} catch (e) {
  failed = e as Error;
  console.log(`✖ ${failed.message}`);
} finally {
  try {
    docker('rm', '-f', name);
  } catch {
    /* already gone */
  }
  await server.close().catch(() => undefined);
}
const bad = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ` — aborted: ${failed.message}` : ''}`);
process.exit(failed || bad.length ? 1 : 0);
