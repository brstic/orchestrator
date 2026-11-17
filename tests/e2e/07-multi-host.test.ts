/**
 * Several machines, one office. Hosts dial out to the server; where a session
 * runs must not change how the owner works with it, and one host must never be
 * able to speak for another.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;
let linux: Awaited<ReturnType<Harness['addHost']>>;
let vps: Awaited<ReturnType<Harness['addHost']>>;
const ids: Record<string, string> = {};

const done = (id: string, label: string) =>
  waitFor(async () => {
    const t = await h.getTask(id);
    return t.status === 'DONE' ? t : null;
  }, { label, timeout: 25000 });

function repoIn(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  h.git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  h.git(dir, 'add', '-A');
  h.git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

before(async () => {
  h = await createHarness();
  boss = await h.client();
  linux = await h.addHost('linux-workstation');
  vps = await h.addHost('vps');
});
after(async () => {
  await h.cleanup();
});

test('three machines are enrolled and report measured resources independently', async () => {
  const hosts = await waitFor(async () => {
    const list = (await h.state()).hosts.filter((x) => x.status === 'online' && x.resources);
    return list.length === 3 ? list : null;
  }, { label: 'three hosts online with resources' });
  assert.deepEqual(hosts.map((x) => x.name).sort(), ['linux-workstation', 'test-host', 'vps']);
  assert.equal(new Set(hosts.map((x) => x.id)).size, 3);
});

test('an enrollment token works exactly once', async () => {
  const { token } = await h.api('POST', '/hosts/enroll-token', { label: 'once' });
  const hello = (extra: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
      const ws = new WebSocket(`${h.url.replace('http', 'ws')}/ws/agent`);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, enrollmentToken: token, enrollOnly: true, name: 'dup', info: { hostname: 'dup' }, ...extra }));
      ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
    });
  assert.equal((await hello({})).t, 'welcome');
  const second = await hello({});
  assert.equal(second.t, 'rejected');
  assert.match(second.reason, /invalid|expired|already used/);
});

test('employees on different machines work side by side in the same office', async () => {
  const local = h.makeRepo('mac-project');
  const onLinux = repoIn(linux.root, 'linux-project');
  const onVps = repoIn(vps.root, 'vps-project');
  ids.Alex = (await h.api('POST', '/employees', { name: 'Alex', roleKey: 'backend', hostId: h.hostId, workingDir: local, autonomy: 'standard' })).id;
  ids.Lin = (await h.api('POST', '/employees', { name: 'Lin', roleKey: 'backend', hostId: linux.hostId, workingDir: onLinux, autonomy: 'standard' })).id;
  ids.Vera = (await h.api('POST', '/employees', { name: 'Vera', roleKey: 'frontend', hostId: vps.hostId, workingDir: onVps, autonomy: 'standard' })).id;
  const state = await h.state();
  const emp = (id: string) => state.employees.find((e) => e.id === id)!;
  const tasks = await Promise.all(
    [['Alex', 'mac'], ['Lin', 'linux'], ['Vera', 'vps']].map(([name, tag]) => h.task({ projectId: emp(ids[name!]!).projectId, title: `Work on ${tag}`, assigneeId: ids[name!], description: `@@fake: write ${tag}.txt made-on-${tag}; commit ${tag}; complete ${tag} done@@` })),
  );
  for (const t of tasks) await done(t.id, t.title);
  // Each session really ran on its own machine's tmux server, in its own machine's folder.
  assert.match(h.tmux('list-sessions', '-F', '#{session_name}'), /orch-alex-/);
  assert.match(linux.tmux('list-sessions', '-F', '#{session_name}'), /orch-lin-/);
  assert.match(vps.tmux('list-sessions', '-F', '#{session_name}'), /orch-vera-/);
  assert.doesNotMatch(h.tmux('list-sessions', '-F', '#{session_name}'), /orch-lin-|orch-vera-/);
  assert.equal(fs.readFileSync(path.join(onLinux, 'linux.txt'), 'utf8').trim(), 'made-on-linux');
  assert.equal(fs.readFileSync(path.join(onVps, 'vps.txt'), 'utf8').trim(), 'made-on-vps');
  const sessions = (await h.state()).sessions;
  assert.equal(sessions.find((s) => s.employeeId === ids.Lin)!.hostId, linux.hostId);
  assert.equal(sessions.find((s) => s.employeeId === ids.Vera)!.hostId, vps.hostId);
});

test('the owner observes and takes over a session on another machine exactly the same way', async () => {
  const session = (await h.session(ids.Vera!))!;
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => /FAKE CLAUDE/.test(boss.terminal(session.id)), { label: 'remote terminal snapshot' });
  boss.send({ t: 'control.acquire', sessionId: session.id });
  await waitFor(() => boss.control.get(session.id)?.you === true, { label: 'control on remote host' });
  boss.send({ t: 'term.input', sessionId: session.id, data: '@@fake: say typed-on-the-vps@@\r' });
  await waitFor(() => /typed-on-the-vps/.test(boss.terminal(session.id)), { label: 'remote echo' });
  assert.match(vps.tmux('capture-pane', '-p', '-t', session.tmuxPane!), /typed-on-the-vps/);
  boss.send({ t: 'control.release', sessionId: session.id });
  boss.send({ t: 'term.close', sessionId: session.id });
});

test('a machine refuses work outside the folders it was told to allow', async () => {
  // The Mac's project folder is not under the VPS's allowed root.
  const res = await h.apiRaw('POST', '/employees', { name: 'Stray', roleKey: 'backend', hostId: vps.hostId, workingDir: path.join(h.tmp, 'mac-project') });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /outside this host's allowed roots/);
});

test('one host cannot speak for another host\'s sessions', async () => {
  const alexSession = (await h.session(ids.Alex!))!;
  // A second connection using the VPS's real credential pretends to own Alex's session.
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}/ws/agent`);
  await new Promise<void>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, hostId: vps.hostId, credential: vps.cfg.credential, info: { hostname: 'vps' } }));
    ws.onmessage = (ev) => JSON.parse(String(ev.data)).t === 'welcome' && resolve();
  });
  const forged = { sessionId: alexSession.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'hijack', tmuxPane: '%9', cwd: '/tmp', repoRoot: null, branch: null, pid: 1, alive: false, command: 'x', cols: 80, rows: 24, claudeSessionId: null, capabilities: alexSession.capabilities, permissionMode: null, model: null, startedAt: new Date().toISOString(), exitReason: 'forged' };
  ws.send(JSON.stringify({ t: 'session', session: forged }));
  ws.send(JSON.stringify({ t: 'session.gone', sessionId: alexSession.id, reason: 'forged' }));
  ws.send(JSON.stringify({ t: 'term.output', sessionId: alexSession.id, seq: 9e15, data: Buffer.from('FORGED OUTPUT').toString('base64') }));
  ws.send(JSON.stringify({ t: 'hook', event: { id: 'forged-hook', ts: new Date().toISOString(), hostSeq: 1, sessionId: alexSession.id, tmuxPane: '%0', payload: { hook_event_name: 'SessionEnd', reason: 'other' } } }));
  ws.send(JSON.stringify({ t: 'usage', sessionId: alexSession.id, usage: { inputTokens: 999999, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 1, measuredAt: new Date().toISOString() } }));
  await sleep(500);
  ws.close();
  const after = (await h.session(ids.Alex!))!;
  assert.equal(after.status, 'running');
  assert.equal(after.tmuxSession, alexSession.tmuxSession);
  assert.equal(after.hostId, h.hostId);
  assert.notEqual(after.usage?.inputTokens, 999999);
  assert.ok(!(await h.state()).events.some((e) => e.sessionId === alexSession.id && e.type === 'session.stopped'), 'the forged hook was ignored');
  // The real VPS agent reconnects after being displaced by the impostor connection.
  await waitFor(() => vps.agent.isConnected, { label: 'vps agent reconnected', timeout: 20000 });
});

test('losing one machine only affects its own employees; it comes back with the same sessions', async () => {
  const lin = (await h.session(ids.Lin!))!;
  await linux.stop();
  await waitFor(async () => (await h.session(ids.Lin!))?.status === 'host_offline', { label: 'linux sessions marked offline' });
  const state = await h.state();
  assert.equal(state.hosts.find((x) => x.id === linux.hostId)!.status, 'offline');
  assert.equal(state.sessions.find((s) => s.employeeId === ids.Alex)!.status, 'running');
  assert.equal(state.sessions.find((s) => s.employeeId === ids.Vera)!.status, 'running');
  // The alarm, once it has been away for longer than a dropped connection would be.
  await waitFor(async () => (await h.state()).notifications.some((n) => n.kind === 'host_disconnected' && n.hostId === linux.hostId && !n.resolvedAt), { label: 'the alarm for the machine that stays away' });
  // Work for the offline machine waits instead of failing or moving elsewhere.
  const emp = state.employees.find((e) => e.id === ids.Lin)!;
  const queued = await h.task({ projectId: emp.projectId, title: 'While offline', assigneeId: ids.Lin, description: '@@fake: write later.txt ok; commit later; complete later@@' });
  await sleep(600);
  assert.equal((await h.getTask(queued.id)).status, 'READY');
  // The tmux session on that machine never stopped.
  assert.match(linux.tmux('list-panes', '-a', '-F', '#{pane_pid} #{pane_dead}'), new RegExp(`${lin.pid} 0`));

  const { HostAgent } = await import('../../apps/host-agent/src/agent.ts');
  const again = new HostAgent(linux.cfg, path.join(h.tmp, 'agent-linux-workstation'), () => undefined);
  await again.start();
  linux.stop = async () => {
    await again.stop().catch(() => undefined);
  };
  await waitFor(async () => (await h.session(ids.Lin!))?.status === 'running', { label: 'linux session back', timeout: 20000 });
  assert.equal((await h.session(ids.Lin!))!.pid, lin.pid);
  await done(queued.id, 'queued work ran once the machine returned');
  await again.stop();
});

test('revoking one machine cuts it off and leaves the others working', async () => {
  await h.api('POST', `/hosts/${vps.hostId}/revoke`, {});
  await waitFor(() => !vps.agent.isConnected, { label: 'vps cut off' });
  const state = await h.state();
  assert.equal(state.hosts.find((x) => x.id === vps.hostId)!.status, 'revoked');
  assert.equal(state.hosts.find((x) => x.id === h.hostId)!.status, 'online');
  assert.equal(state.sessions.find((s) => s.employeeId === ids.Alex)!.status, 'running');
  const emp = state.employees.find((e) => e.id === ids.Alex)!;
  const t = await h.task({ projectId: emp.projectId, title: 'Still working', assigneeId: ids.Alex, description: '@@fake: write still.txt ok; commit still; complete still@@' });
  await done(t.id, 'the remaining machine keeps working');
});
