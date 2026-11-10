/**
 * Three machines, three operating systems, one office.
 *
 *   this Mac (macOS)            — runs the server (TLS) and its own host agent
 *   a Debian machine            — container, its own kernel namespace and network address
 *   an Ubuntu 24.04 machine     — container; the userland of a default WSL2 install
 *
 * The two Linux machines reach the server only over the network, through TLS,
 * with their own enrollment tokens. Checked here: simultaneous work on all
 * three, a request and a meeting that cross machines, terminals from all
 * three in one client, a real network partition and recovery, and revocation.
 *
 * Started by run-multi.sh. Workers are the scripted test fixture.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullState, ServerToClient } from '@orchestrator/contracts';
import { b64decode } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../../apps/host-agent/src/config.ts';
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
// This machine's real network address: the Linux machines and this machine's own workers all use it.
const publicUrl = `https://${process.env.ORCH_TEST_ADDR}:${port}`;
const local = `https://localhost:${port}`;
const server = await startServer({ dataDir: path.join(tmp, 'server'), host: '0.0.0.0', port, tls: { certFile: path.join(tmp, 'cert.pem'), keyFile: path.join(tmp, 'key.pem') }, publicUrl, quiet: true, timings: { askBossWaitMs: 6000, meetingRoundMs: 20000 } as any });
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
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
const dockerAsync = (...args: string[]) =>
  new Promise<string>((resolve, reject) => execFile('docker', args, { encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(stdout))));

const containers: string[] = [];
const logs: Record<string, string> = {};
async function linuxMachine(hostName: string, image: string): Promise<string> {
  const { token } = await api('POST', '/hosts/enroll-token', { label: hostName });
  const entry = [
    'set -e',
    'mkdir -p ~/work/app && cd ~/work/app',
    'git init -q -b main && echo "# app" > README.md && git add -A && git -c user.name=dev -c user.email=dev@example.test commit -qm init',
    'printf \'#!/bin/sh\\nexec node /orch/tests/fixtures/fake-claude.mjs "$@"\\n\' > ~/fake-claude && chmod +x ~/fake-claude',
    `node /orch/apps/host-agent/dist/orchestrator-agent.mjs login --server ${publicUrl} --token ${token} --name ${hostName} --allow-root /home/dev/work`,
    'node -e \'const fs=require("fs"),p=process.env.HOME+"/.orchestrator/agent/config.json",c=JSON.parse(fs.readFileSync(p));c.claudeBin=process.env.HOME+"/fake-claude";c.sdkPath="/orch/tests/fixtures/fake-agent-sdk";fs.writeFileSync(p,JSON.stringify(c,null,2))\'',
    // Keep the machine up after the agent stops, so what it left behind can be inspected.
    'node /orch/apps/host-agent/dist/orchestrator-agent.mjs connect || echo "agent exited with status $?"',
    'sleep 900',
  ].join('\n');
  const name = `orch-mm-${hostName}-${process.pid}`;
  containers.push(name);
  logs[name] = '';
  const c = spawn('docker', ['run', '--rm', '--name', name, '--hostname', hostName, '-v', `${root}:/orch:ro`, '-v', `${path.join(tmp, 'cert.pem')}:/cert.pem:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/cert.pem', image, 'bash', '-c', entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (d) => (logs[name] += d));
  c.stderr.on('data', (d) => (logs[name] += d));
  return name;
}

// The Mac's own agent: a normal host agent talking to the same TLS server.
const macRoot = fs.realpathSync(fs.mkdtempSync('/tmp/orch-mm-'));
const macSock = `orch-mm-${process.pid}`;
const wrapper = path.join(macRoot, 'fake-claude');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'tests/fixtures/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });
const macCfg = { ...defaultConfig(), serverUrl: local, name: 'the-mac', allowedRoots: [macRoot], tmuxSocketName: macSock, claudeBin: wrapper, approvalWaitSeconds: 20 };
let macAgent: HostAgent | null = null;

let failed: Error | null = null;
try {
  const macInfo = await (new HostAgent(macCfg, path.join(macRoot, 'agent'), () => undefined) as any).collectInfo();
  const en = await enroll(local, server.localEnrollToken(), 'the-mac', macInfo);
  Object.assign(macCfg, { hostId: en.hostId, credential: en.credential });
  saveConfig(macCfg, path.join(macRoot, 'agent'));
  macAgent = new HostAgent(macCfg, path.join(macRoot, 'agent'), () => undefined);
  await macAgent.start();
  const debian = await linuxMachine('debian-box', 'orchestrator-linux-host');
  const ubuntu = await linuxMachine('ubuntu-box', 'orchestrator-ubuntu-host');

  const hosts = await until('three machines online', (s) => {
    const on = s.hosts.filter((h) => h.status === 'online' && h.resources && h.info?.runtimes);
    return on.length === 3 ? on : null;
  }, 90000).catch((e) => {
    console.log(Object.entries(logs).map(([n, l]) => `--- ${n}\n${l.slice(-800)}`).join('\n'));
    throw e;
  });
  const H = (n: string) => hosts.find((h) => h.name === n)!;
  const osId = (c: string) => /^ID=(.*)$/m.exec(docker('exec', c, 'cat', '/etc/os-release'))?.[1] ?? '?';
  const osVersion = (c: string) => /^VERSION_ID="?([^"\n]*)/m.exec(docker('exec', c, 'cat', '/etc/os-release'))?.[1] ?? '?';
  check(
    'three machines on three operating systems are in one office',
    H('the-mac').info!.platform === 'darwin' && H('debian-box').info!.platform === 'linux' && H('ubuntu-box').info!.platform === 'linux' && osId(debian) === 'debian' && osId(ubuntu) === 'ubuntu',
    `macOS (tmux ${H('the-mac').info!.tmuxVersion}) · Debian ${osVersion(debian)} (tmux ${H('debian-box').info!.tmuxVersion}) · Ubuntu ${osVersion(ubuntu)} (tmux ${H('ubuntu-box').info!.tmuxVersion})`,
  );
  const addr = (c: string) => docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', c).trim();
  check('the Linux machines have their own network addresses and reach the server only over TLS', addr(debian) !== addr(ubuntu) && addr(debian) !== '' && /^https:/.test(publicUrl), `debian ${addr(debian)}, ubuntu ${addr(ubuntu)}, server at this machine's LAN address over https`);
  check('each machine reports its own measured resources', hosts.every((h) => typeof h.resources!.memTotalBytes === 'number') && H('the-mac').resources!.memTotalBytes !== H('debian-box').resources!.memTotalBytes, hosts.map((h) => `${h.name}: ${Math.round((h.resources!.memTotalBytes ?? 0) / 1e9)} GB`).join(', '));

  // One employee per machine, each living in a folder on their own machine.
  const macFolder = path.join(macRoot, 'app');
  fs.mkdirSync(macFolder);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: macFolder, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.test', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.test' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(macFolder, 'README.md'), '# app\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const verify = 'uname -s; grep ^ID= /etc/os-release 2>/dev/null || sw_vers -productName';
  const mia = await api('POST', '/employees', { name: 'Mia', roleKey: 'backend', hostId: H('the-mac').id, workingDir: macFolder, autonomy: 'standard', verifyCommand: verify });
  const dev = await api('POST', '/employees', { name: 'Dev', roleKey: 'frontend', hostId: H('debian-box').id, workingDir: '/home/dev/work/app', autonomy: 'standard', verifyCommand: verify });
  const uma = await api('POST', '/employees', { name: 'Uma', roleKey: 'qa', hostId: H('ubuntu-box').id, workingDir: '/home/dev/work/app', autonomy: 'standard', verifyCommand: verify });
  const people = [mia, dev, uma];
  const tasks = await Promise.all(people.map((e) => api('POST', '/tasks', { projectId: e.projectId, title: `Change by ${e.name}`, assigneeId: e.id, description: `@@fake: write ${e.name.toLowerCase()}.txt made-by-${e.name.toLowerCase()}; commit change by ${e.name}; complete done@@` })));
  const done = await until('all three tasks done', (s) => {
    const mine = tasks.map((t) => s.tasks.find((x) => x.id === t.id)!);
    return mine.every((t) => t.status === 'DONE') ? mine : null;
  }, 60000);
  const tail = (i: number) => done[i]!.evidence.verification?.outputTail ?? '';
  check('all three worked at the same time, each verified by a command run on their own machine', /Darwin/.test(tail(0)) && /ID=debian/.test(tail(1)) && /ID=ubuntu/.test(tail(2)) && done.every((t) => t.evidence.verification?.provenance === 'measured'), done.map((t, i) => tail(i).trim().replace(/\s+/g, ' ')).join(' | '));
  check(
    'the commits are in the folders on the three machines',
    /change by Mia/.test(git('log', '--oneline', '-1')) && /change by Dev/.test(docker('exec', debian, 'git', '-C', '/home/dev/work/app', 'log', '--oneline', '-1')) && /change by Uma/.test(docker('exec', ubuntu, 'git', '-C', '/home/dev/work/app', 'log', '--oneline', '-1')),
  );
  const sessions = (await state()).sessions;
  const S = (e: any) => sessions.find((x) => x.employeeId === e.id && x.status === 'running')!;
  for (const e of people) await until(`${e.name} idle`, (s) => s.sessions.find((x) => x.employeeId === e.id && x.inTurn === false));

  // A request from the Mac to the Ubuntu machine, routed and answered through the office.
  await api('POST', `/employees/${mia.id}/message`, { body: '@@fake: mcp request_collaboration {"to":"Uma","summary":"Which port does the staging service use?","detail":"Needed for the client config."}@@' });
  const collab = await until('cross-machine request answered', (s) => s.collabs.find((c) => c.fromEmployeeId === mia.id && c.status !== 'open'), 40000);
  check('an employee on the Mac asked a colleague on the Ubuntu machine and got their answer', collab.toEmployeeId === uma.id && !!collab.response, `${collab.status}: ${String(collab.response).slice(0, 80)}`);

  // A meeting whose participants sit on three different machines.
  for (const e of people) await until(`${e.name} idle`, (s) => s.sessions.find((x) => x.employeeId === e.id && x.inTurn === false));
  const meeting = await api('POST', '/meetings', { topic: 'Where should the shared config live?', participantIds: people.map((e) => e.id), context: 'Decide once for all three services.' });
  const concluded = await until('meeting concluded', (s) => s.meetings.find((m) => m.id === meeting.id && m.status === 'concluded'), 90000);
  const round = (r: string) => new Set(concluded.contributions.filter((c: any) => c.round === r).map((c: any) => c.employeeId));
  check('a meeting ran across the three machines: every participant contributed from their own session', round('proposal').size === 3 && round('response').size === 3 && round('synthesis').size === 1 && !!concluded.decisionDoc, `${concluded.contributions.length} contributions, decision recorded`);

  // One client watches terminals on all three machines at once, and takes the keyboard on Ubuntu.
  const ws = new WebSocket(`wss://localhost:${port}/ws/client?token=${server.ownerToken}`);
  const terms = new Map<string, { text: string; snap: number; pending: Array<{ seq: number; text: string }> }>();
  const T = (id: string) => terms.get(id) ?? terms.set(id, { text: '', snap: -1, pending: [] }).get(id)!;
  let control = '';
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as ServerToClient;
    if (m.t === 'term.snapshot') {
      const t = T(m.snapshot.sessionId);
      t.text = Buffer.from(b64decode(m.snapshot.data)).toString('utf8');
      t.snap = m.snapshot.seq;
      for (const p of t.pending) if (p.seq > t.snap) t.text += p.text;
    } else if (m.t === 'term.output') {
      const t = T(m.sessionId);
      const text = Buffer.from(b64decode(m.data)).toString('utf8');
      t.pending.push({ seq: m.seq, text });
      if (t.snap >= 0 && m.seq > t.snap) t.text += text;
    } else if (m.t === 'control' && m.sessionId === S(uma).id) control = `${m.control}${m.you ? ':you' : ''}`;
  };
  await new Promise((r) => (ws.onopen = r));
  for (const e of people) ws.send(JSON.stringify({ t: 'term.open', sessionId: S(e).id }));
  const waitTerm = async (id: string, re: RegExp, label: string) => {
    const end = Date.now() + 20000;
    while (!re.test(T(id).text)) {
      if (Date.now() > end) throw new Error(`timed out waiting for terminal: ${label}`);
      await sleep(150);
    }
  };
  for (const e of people) await waitTerm(S(e).id, /FAKE CLAUDE/, `${e.name}'s terminal`);
  check('one client streams live terminals from all three machines at once', people.every((e) => /FAKE CLAUDE/.test(T(S(e).id).text)), people.map((e) => `${e.name}: ${T(S(e).id).text.length} bytes`).join(', '));
  ws.send(JSON.stringify({ t: 'control.acquire', sessionId: S(uma).id }));
  while (control !== 'HUMAN_CONTROLLED:you') await sleep(100);
  ws.send(JSON.stringify({ t: 'term.input', sessionId: S(uma).id, data: '@@fake: say typed-across-the-network-ñ@@\r' }));
  await waitTerm(S(uma).id, /typed-across-the-network-ñ/, 'typed input echoed from Ubuntu');
  check('taking control types into the session on the Ubuntu machine', /typed-across-the-network-ñ/.test(docker('exec', ubuntu, 'tmux', '-u', 'capture-pane', '-p', '-t', S(uma).tmuxPane!, '-S', '-30')));
  ws.send(JSON.stringify({ t: 'control.release', sessionId: S(uma).id }));
  ws.close();

  // An SDK-managed worker on the Ubuntu machine (scripted SDK), next to the interactive one.
  docker('exec', ubuntu, 'bash', '-c', 'mkdir -p ~/work/sdk && cd ~/work/sdk && git init -q -b main && echo "# sdk" > README.md && git add -A && git -c user.name=dev -c user.email=dev@example.test commit -qm init');
  const sid = await api('POST', '/employees', { name: 'Sid', roleKey: 'backend', hostId: H('ubuntu-box').id, workingDir: '/home/dev/work/sdk', autonomy: 'standard', executionMode: 'managed_sdk' });
  const sidSession = await api('POST', `/employees/${sid.id}/start`, {});
  await until('sdk worker ready', (s) => s.sessions.find((x) => x.id === sidSession.id && x.inTurn === false));
  const sidMsg = await api('POST', `/employees/${sid.id}/message`, { body: '@@fake: write note.txt from-ubuntu; say noted@@' });
  const sidDelivered = await until('sdk delivery', (s) => s.messages.find((m) => m.id === sidMsg.id && m.delivery.status === 'confirmed'));
  await until('sdk turn finished', (s) => s.sessions.find((x) => x.id === sidSession.id && x.inTurn === false));
  check('an SDK-managed worker runs on the Ubuntu machine', sidSession.mode === 'managed_sdk' && sidDelivered.delivery.via === 'sdk' && docker('exec', ubuntu, 'cat', '/home/dev/work/sdk/note.txt').trim() === 'from-ubuntu');

  // A real network partition: the Ubuntu machine drops off the network without closing anything.
  const umaBefore = (await state()).sessions.find((x) => x.id === S(uma).id)!;
  const network = docker('inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', ubuntu).trim();
  docker('network', 'disconnect', network, ubuntu);
  const cutAt = Date.now();
  await until('partition noticed', (s) => s.hosts.find((h) => h.name === 'ubuntu-box' && h.status === 'offline'), 120000);
  const during = await state();
  check(
    'a silent network partition is detected; only that machine is affected',
    during.sessions.filter((x) => x.hostId === H('ubuntu-box').id && x.endedAt === null).every((x) => x.status === 'host_offline' && x.activity === 'unknown') && during.sessions.find((x) => x.id === S(mia).id)!.status === 'running' && during.sessions.find((x) => x.id === S(dev).id)!.status === 'running',
    `noticed after ${Math.round((Date.now() - cutAt) / 1000)}s (no connection close was ever sent)`,
  );
  const queued = await api('POST', '/tasks', { projectId: uma.projectId, title: 'Queued during the partition', assigneeId: uma.id, description: '@@fake: write later.txt after-the-partition; commit later; complete later@@' });
  const meanwhile = await api('POST', '/tasks', { projectId: dev.projectId, title: 'Debian keeps working', assigneeId: dev.id, description: '@@fake: write meanwhile.txt ok; commit meanwhile; complete meanwhile@@' });
  await until('debian task done during the partition', (s) => s.tasks.find((t) => t.id === meanwhile.id && t.status === 'DONE'), 40000);
  check('work for the unreachable machine waits while the others keep working', (await state()).tasks.find((t) => t.id === queued.id)!.status === 'READY');
  docker('network', 'connect', network, ubuntu);
  const backAt = Date.now();
  const umaAfter = await until('ubuntu back', (s) => s.sessions.find((x) => x.id === umaBefore.id && x.status === 'running'), 120000);
  check('after the network returns the machine reconnects with the same sessions', umaAfter.pid === umaBefore.pid && umaAfter.tmuxSession === umaBefore.tmuxSession, `back ${Math.round((Date.now() - backAt) / 1000)}s after the link returned, pid ${umaAfter.pid}`);
  await until('queued task done', (s) => s.tasks.find((t) => t.id === queued.id && t.status === 'DONE'), 60000);
  check('the work that waited ran once the machine was reachable again', docker('exec', ubuntu, 'cat', '/home/dev/work/app/later.txt').trim() === 'after-the-partition');

  // Revoking one machine cuts it off at once; the others carry on.
  const oldCredential = JSON.parse(docker('exec', debian, 'cat', '/home/dev/.orchestrator/agent/config.json')).credential as string;
  await api('POST', `/hosts/${H('debian-box').id}/revoke`, {});
  await until('debian revoked', (s) => s.hosts.find((h) => h.name === 'debian-box' && h.status === 'revoked'));
  for (let i = 0; i < 60 && !/agent exited with status/.test(logs[debian]!); i++) await sleep(250);
  // Its real credential, presented again from elsewhere, is refused too.
  const replay = await new Promise<any>((resolve) => {
    const again = new WebSocket(`wss://localhost:${port}/ws/agent`);
    again.onopen = () => again.send(JSON.stringify({ t: 'hello', protocol: 1, hostId: H('debian-box').id, credential: oldCredential, info: { hostname: 'debian-box' } }));
    again.onmessage = (ev) => {
      resolve(JSON.parse(String(ev.data)));
      again.close();
    };
    again.onclose = () => resolve({ t: 'closed' });
  });
  check(
    'a revoked machine is cut off at once and its credential no longer works',
    /server rejected this host/.test(logs[debian]!) && /agent exited with status/.test(logs[debian]!) && replay.t === 'rejected',
    `agent: "${/server rejected this host: (.*)/.exec(logs[debian]!)?.[1] ?? '?'}"; replayed credential: ${replay.t}${replay.reason ? ` (${replay.reason})` : ''}`,
  );
  check('its tmux sessions were left alone', /orch-dev-/.test(docker('exec', debian, 'tmux', 'list-sessions', '-F', '#{session_name}')));
  const last = await api('POST', '/tasks', { projectId: mia.projectId, title: 'Still working', assigneeId: mia.id, description: '@@fake: write still.txt ok; commit still; complete still@@' });
  await until('mac task done', (s) => s.tasks.find((t) => t.id === last.id && t.status === 'DONE'), 40000);
  check('the remaining machines keep working', (await state()).hosts.filter((h) => h.status === 'online').length === 2);
} catch (e) {
  failed = e as Error;
  console.log(`✖ ${failed.message}`);
  try {
    const s = await state();
    for (const t of s.tasks) console.log(`task ${t.key} "${t.title}" ${t.status} delivery=${t.delivery.status} blocked=${t.blockedReason ?? ''} verify=${JSON.stringify(t.evidence.verification?.outputTail ?? null)}`);
    for (const x of s.sessions) console.log(`session ${x.tmuxSession} on ${s.hosts.find((h) => h.id === x.hostId)?.name}: ${x.status} / ${x.activity} / inTurn=${x.inTurn} / ${x.activityDetail}`);
    for (const q of s.questions.filter((q) => q.status === 'open')) console.log(`open question ${q.kind}: ${q.text.slice(0, 120)}`);
  } catch {
    /* server gone */
  }
  console.log(Object.entries(logs).map(([n, l]) => `--- ${n}\n${l.slice(-600)}`).join('\n'));
} finally {
  for (const c of containers) {
    try {
      docker('rm', '-f', c);
    } catch {
      /* already gone */
    }
  }
  await macAgent?.stop().catch(() => undefined);
  try {
    execFileSync('tmux', ['-L', macSock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await server.close().catch(() => undefined);
  fs.rmSync(macRoot, { recursive: true, force: true });
  fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, macSock), { force: true });
}
const bad = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ` — aborted: ${failed.message}` : ''}`);
process.exit(failed || bad.length ? 1 : 0);
