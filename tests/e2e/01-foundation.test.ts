/**
 * Phase 1 acceptance: start a worker session, connect it to Orchestrator,
 * observe its terminal, take control, send input, release control, and
 * reconnect — without the process ever being replaced.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, sleep, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;

before(async () => {
  h = await createHarness();
  boss = await h.client();
});
after(async () => {
  await h.cleanup();
});

test('host is enrolled, online and reports measured resources', async () => {
  const host = await waitFor(async () => (await h.state()).hosts.find((x) => x.id === h.hostId && x.status === 'online' && x.resources), { label: 'host resources' });
  assert.equal(host.name, 'test-host');
  assert.equal(typeof host.resources!.memTotalBytes, 'number');
});

test('unauthenticated access is refused everywhere', async () => {
  assert.equal((await fetch(`${h.url}/api/state`)).status, 401);
  assert.equal((await fetch(`${h.url}/api/state`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  const mcp = await fetch(`${h.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(mcp.status, 401);
  // A websocket without the owner token is closed immediately.
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}/ws/client?token=wrong`);
  const code = await new Promise<number>((resolve) => (ws.onclose = (ev) => resolve(ev.code)));
  assert.equal(code, 4003);
  // An agent with a bogus credential is rejected.
  const agent = new WebSocket(`${h.url.replace('http', 'ws')}/ws/agent`);
  const rejected = await new Promise<string>((resolve) => {
    agent.onopen = () => agent.send(JSON.stringify({ t: 'hello', protocol: 1, hostId: h.hostId, credential: 'forged', info: {} }));
    agent.onmessage = (ev) => resolve(JSON.parse(String(ev.data)).t);
  });
  assert.equal(rejected, 'rejected');
});

let employeeId = '';
let sessionId = '';
let pid = 0;

test('an employee gets a real tmux session with a running worker process', async () => {
  const repo = h.makeRepo('alpha');
  const emp = await h.employee('Alex', 'backend', { workingDir: repo });
  employeeId = emp.id;
  assert.ok(emp.deskId, 'employee was given a desk');
  const session = await h.api('POST', `/employees/${emp.id}/start`, {});
  sessionId = session.id;
  assert.equal(session.status, 'running');
  assert.match(session.tmuxSession, /^orch-alex-/);
  // The worker reports itself through a real SessionStart hook.
  const idle = await waitFor(async () => {
    const s = await h.session(emp.id);
    return s?.activity === 'idle' ? s : null;
  }, { label: 'SessionStart → idle' });
  assert.ok(idle.claudeSessionId);
  assert.equal(idle.capabilities.hooks, true);
  assert.equal(idle.capabilities.mcp, true);
  pid = idle.pid!;
  assert.ok(pid > 0);
  assert.match(h.tmux('list-sessions', '-F', '#{session_name}'), /orch-alex-/);
});

test('observing shows the live terminal and never sends keystrokes', async () => {
  boss.send({ t: 'term.open', sessionId });
  await waitFor(() => /FAKE CLAUDE/.test(boss.terminal(sessionId)), { label: 'snapshot with banner' });
  await waitFor(() => boss.control.get(sessionId)?.control === 'HUMAN_OBSERVING', { label: 'observing state' });
  const before = boss.terminal(sessionId);
  boss.send({ t: 'term.input', sessionId, data: 'this must not arrive\r' });
  await sleep(500);
  assert.equal(boss.terminal(sessionId), before, 'observer input was dropped');
  assert.doesNotMatch(h.tmux('capture-pane', '-p', '-t', (await h.session(employeeId))!.tmuxPane!), /this must not arrive/);
});

test('taking control is exclusive and types into the same session', async () => {
  const second = await h.client();
  second.send({ t: 'term.open', sessionId });
  await waitFor(() => second.terminals.has(sessionId), { label: 'second viewer snapshot' });

  boss.send({ t: 'control.acquire', sessionId });
  await waitFor(() => boss.control.get(sessionId)?.control === 'HUMAN_CONTROLLED' && boss.control.get(sessionId)?.you, { label: 'control acquired' });
  assert.equal((await h.session(employeeId))!.control, 'HUMAN_CONTROLLED');

  // Only one controller at a time.
  second.send({ t: 'control.acquire', sessionId });
  await waitFor(() => second.errors.some((e) => /another operator/.test(e)), { label: 'second controller refused' });
  second.send({ t: 'term.input', sessionId, data: 'intruder\r' });

  boss.send({ t: 'term.input', sessionId, data: '@@fake: say hello-from-the-boss@@\r' });
  await waitFor(() => /hello-from-the-boss/.test(boss.terminal(sessionId)), { label: 'typed input echoed by the worker' });
  // The second viewer sees the same stream, read-only.
  await waitFor(() => /hello-from-the-boss/.test(second.terminal(sessionId)), { label: 'second viewer stream' });
  assert.doesNotMatch(boss.terminal(sessionId), /intruder/);

  boss.send({ t: 'control.release', sessionId });
  await waitFor(() => boss.control.get(sessionId)?.control === 'HUMAN_OBSERVING', { label: 'control released' });
  const s = await h.session(employeeId);
  assert.equal(s!.pid, pid, 'same process after takeover');
  second.close();

  const events = (await h.state()).events.map((e) => e.type);
  assert.ok(events.includes('terminal.control_acquired'));
  assert.ok(events.includes('terminal.control_released'));
  const audit = await h.api('GET', '/audit');
  assert.ok(audit.some((a: any) => a.action === 'terminal.control_acquired' && a.target === sessionId));
});

test('the agent can restart and reattach without replacing the process', async () => {
  boss.send({ t: 'term.close', sessionId });
  await h.stopAgent();
  await waitFor(async () => (await h.session(employeeId))?.status === 'host_offline', { label: 'host offline state' });
  const offline = await h.session(employeeId);
  assert.equal(offline!.control, 'DISCONNECTED');
  assert.equal(offline!.activity, 'unknown', 'no activity is claimed while the host cannot be seen');
  // The tmux session kept running the whole time.
  assert.match(h.tmux('list-panes', '-a', '-F', '#{pane_pid} #{pane_dead}'), new RegExp(`${pid} 0`));

  await h.startAgent();
  const back = await waitFor(async () => {
    const s = await h.session(employeeId);
    return s?.status === 'running' ? s : null;
  }, { label: 'session visible again' });
  assert.equal(back.id, sessionId, 'same session record');
  assert.equal(back.pid, pid, 'same process');

  boss.send({ t: 'term.open', sessionId });
  await waitFor(() => (boss.terminals.get(sessionId)?.snapshots ?? 0) >= 2 && /hello-from-the-boss/.test(boss.terminal(sessionId)), { label: 'fresh snapshot contains earlier output' });
  boss.send({ t: 'control.acquire', sessionId });
  await waitFor(() => boss.control.get(sessionId)?.you === true, { label: 'control after reconnect' });
  boss.send({ t: 'term.input', sessionId, data: '@@fake: say still-the-same-session@@\r' });
  await waitFor(() => /still-the-same-session/.test(boss.terminal(sessionId)), { label: 'input after reconnect' });
  boss.send({ t: 'control.release', sessionId });
  boss.send({ t: 'term.close', sessionId });
});

test('monitor frames are pushed for in-world screens', async () => {
  const frame = await waitFor(() => boss.messages.find((m) => m.t === 'term.screen' && m.sessionId === sessionId && m.screen.lines.join('\n').includes('still-the-same-session')), { label: 'monitor frame' });
  assert.equal(frame.t, 'term.screen');
});

test('an existing tmux session can be attached non-destructively', async () => {
  h.tmux('new-session', '-d', '-s', 'legacy-work', '-x', '100', '-y', '30', 'cat');
  const legacyPid = h.tmux('list-panes', '-t', 'legacy-work', '-F', '#{pane_pid}').trim();

  // By default a host only lets the office attach panes that run Claude Code: anything else
  // (this one runs `cat`; it could be a shell) must be attached from the machine itself.
  h.agentCfg.remoteAttach = 'claude';
  assert.ok(!(await h.api('GET', `/hosts/${h.hostId}/discover`)).panes.some((p: any) => p.tmuxSession === 'legacy-work'), 'not even listed');
  const refused = await h.apiRaw('POST', '/sessions/attach', { hostId: h.hostId, tmuxSession: 'legacy-work' });
  assert.equal(refused.status, 502);
  assert.match(refused.body.error, /not running Claude Code/);
  h.agentCfg.remoteAttach = 'none';
  assert.match((await h.apiRaw('POST', '/sessions/attach', { hostId: h.hostId, tmuxSession: 'legacy-work' })).body.error, /does not allow the office to attach/);
  h.agentCfg.remoteAttach = 'any';

  const discovered = await h.api('GET', `/hosts/${h.hostId}/discover`);
  assert.ok(discovered.panes.some((p: any) => p.tmuxSession === 'legacy-work' && !p.connectedAs));
  const sam = await h.employee('Sam', 'frontend');
  const session = await h.api('POST', '/sessions/attach', { hostId: h.hostId, tmuxSession: 'legacy-work', employeeId: sam.id });
  assert.equal(session.origin, 'attached');
  assert.equal(session.employeeId, sam.id);
  assert.equal(session.capabilities.hooks, false);
  assert.equal(session.activity, 'unknown', 'no hooks → activity is honestly unknown');
  assert.equal(h.tmux('list-panes', '-t', 'legacy-work', '-F', '#{pane_pid}').trim(), legacyPid, 'attach did not restart the process');

  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => boss.terminals.has(session.id), { label: 'attached snapshot' });
  boss.send({ t: 'control.acquire', sessionId: session.id });
  await waitFor(() => boss.control.get(session.id)?.you === true, { label: 'control of attached session' });
  boss.send({ t: 'term.input', sessionId: session.id, data: 'typed into legacy\r' });
  await waitFor(() => /typed into legacy/.test(boss.terminal(session.id)), { label: 'echo from attached session' });
  boss.send({ t: 'term.close', sessionId: session.id });

  // Stopping an attached employee only detaches; the tmux session survives.
  await h.api('POST', `/employees/${sam.id}/stop`, {});
  assert.equal(h.tmux('list-panes', '-t', 'legacy-work', '-F', '#{pane_pid}').trim(), legacyPid);
  h.tmux('kill-session', '-t', 'legacy-work');
});

test('a crashed worker is reported offline and resumes the same conversation', async () => {
  const before = (await h.session(employeeId))!;
  h.tmux('send-keys', '-t', before.tmuxPane!, '/exit', 'Enter');
  const dead = await waitFor(async () => {
    const s = await h.session(employeeId);
    return s?.status === 'exited' ? s : null;
  }, { label: 'exit detected' });
  assert.equal(dead.activity, 'offline');
  const state = await h.state();
  assert.ok(state.notifications.some((n) => n.kind === 'session_lost' && n.employeeId === employeeId));
  assert.ok(state.employees.find((e) => e.id === employeeId), 'the employee still exists without a session');

  const resumed = await h.api('POST', `/employees/${employeeId}/start`, {});
  assert.equal(resumed.id, before.id, 'same session record');
  assert.equal(resumed.tmuxSession, before.tmuxSession, 'same tmux session');
  assert.equal(resumed.claudeSessionId, before.claudeSessionId, 'same Claude conversation id');
  await waitFor(async () => (await h.state()).events.some((e) => e.type === 'session.resumed' && e.sessionId === before.id), { label: 'resume hook' });
  boss.send({ t: 'term.open', sessionId: before.id });
  await waitFor(() => /\(resumed\)/.test(boss.terminal(before.id)), { label: 'resumed banner' });
  boss.send({ t: 'term.close', sessionId: before.id });
});

test('owner changes to settings are written to the audit log', async () => {
  const before = (await h.api('GET', '/audit')).filter((a: any) => a.action === 'settings.changed').length;
  await h.api('PATCH', '/settings', { workersInheritMcp: true });
  // Saving the same value again is not a change.
  await h.api('PATCH', '/settings', { workersInheritMcp: true });
  await h.api('PATCH', '/settings', { workersInheritMcp: false, companyName: 'Audit Co' });
  const entries = (await h.api('GET', '/audit')).filter((a: any) => a.action === 'settings.changed');
  assert.equal(entries.length - before, 2);
  const details = entries.map((a: any) => a.detail);
  assert.ok(details.some((d: any) => d.changed.includes('workersInheritMcp') && d.workersInheritMcp === true), 'turning connector inheritance on is recorded with its value');
  assert.ok(details.some((d: any) => d.changed.includes('companyName') && d.changed.includes('workersInheritMcp') && d.workersInheritMcp === false));
});
