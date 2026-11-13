/**
 * Persistence and recovery: the office must reconstruct itself accurately
 * after restarts and disconnections, and never claim more than it knows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let repo = '';
let projectId = '';
let alexId = '';
let danaId = '';

before(async () => {
  h = await createHarness({ approvalWaitSeconds: 30, timings: { hookRejoinGraceMs: 1000 } });
  // A hook waits two seconds for an agent that is not there (45 in a real office).
  h.agentCfg.hookRetrySeconds = 2;
  repo = h.makeRepo('ledger');
  projectId = (await h.project('Ledger', repo, { verifyCommand: 'npm test --silent' })).id;
  alexId = (await h.employee('Alex', 'backend', { projectId, autonomy: 'standard' })).id;
  danaId = (await h.employee('Dana', 'devops', { projectId })).id; // on Standard: a command outside the routine list asks
});
after(async () => {
  await h.cleanup();
});

test('a question survives a server restart and its answer still reaches the same session', async () => {
  const task = await h.task({ projectId, title: 'Interest calc', assigneeId: alexId, description: '@@fake: write calc.txt v1; commit calc; ask Round half up or half even?@@' });
  const q = await waitFor(() => h.openQuestion(alexId), { label: 'question asked' });
  const before = (await h.session(alexId))!;

  await h.restartServer();

  // Everything is back from the database; the session was re-reported by its host, not assumed.
  const state = await h.state();
  assert.ok(state.employees.find((e) => e.id === alexId));
  assert.equal(state.tasks.find((t) => t.id === task.id)!.status, 'IN_PROGRESS');
  assert.equal(state.questions.find((x) => x.id === q.id)!.status, 'open');
  const session = await waitFor(async () => {
    const s = await h.session(alexId);
    return s?.status === 'running' ? s : null;
  }, { label: 'session re-reported after restart' });
  assert.equal(session.id, before.id);
  assert.equal(session.pid, before.pid, 'the worker process was never touched');
  assert.ok(state.events.some((e) => e.type === 'task.started' && e.taskId === task.id), 'event history persisted');

  // The tool call that was waiting died with the old server, so the answer travels by the terminal instead.
  await waitFor(async () => (await h.session(alexId))!.inTurn === false, { label: 'agent back at its prompt' });
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Half even. @@fake: write calc.txt v2-half-even; commit rounding; complete calc done@@' });
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q.id)!.status === 'confirmed', { label: 'answer delivered and confirmed by hook' });
  const done = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'task finished after restart', timeout: 20000 });
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:calc.txt'), 'v2-half-even');
  assert.equal(done.evidence.commits.length, 2);
});

test('work done while the server is down is reported afterwards, exactly once', async () => {
  const session = (await h.session(alexId))!;
  await waitFor(async () => (await h.session(alexId))!.inTurn === false, { label: 'idle' });
  const client = await h.client();
  const dataDir = path.join(h.tmp, 'server');
  void client;
  // Stop only the server. The agent and the tmux session keep running.
  await h.server.close();
  h.tmux('send-keys', '-t', session.tmuxPane!, '-l', '@@fake: write offline.txt made-while-server-was-down; say offline-work-finished@@');
  h.tmux('send-keys', '-t', session.tmuxPane!, 'Enter');
  await waitFor(() => fs.existsSync(path.join(session.cwd, 'offline.txt')), { label: 'worker kept working without the server' });
  void dataDir;

  await h.restartServer(); // restartServer tolerates an already-closed server
  const events = await waitFor(async () => {
    const list = await h.api('GET', `/events?sessionId=${session.id}&limit=500`);
    return list.filter((e: any) => e.summary === 'Alex modified offline.txt').length ? list : null;
  }, { label: 'queued hook events delivered after reconnect', timeout: 20000 });
  assert.equal(events.filter((e: any) => e.summary === 'Alex modified offline.txt').length, 1, 'delivered at least once, applied exactly once');
  await waitFor(async () => (await h.session(alexId))!.inTurn === false, { label: 'state caught up to reality' });
  fs.rmSync(path.join(session.cwd, 'offline.txt'));
});

test('an approval pending during a server restart is still pending afterwards; when the machine\'s agent stays away, it falls back to the real terminal prompt', async () => {
  const task = await h.task({ projectId, title: 'Rotate logs', assigneeId: danaId, kind: 'ops', verifyCommand: 'true', description: '@@fake: bash touch rotate.txt; say rotation-configured@@' });
  const q = await waitFor(() => h.openQuestion(danaId, 'permission'), { label: 'permission pending' });
  const wt = (await h.getTask(task.id)).worktree!;

  // The machine's agent keeps holding the hook while the office is away and hands the request back when it returns
  // (tests/e2e/37-held-through-restart.test.ts): the same request is still open, and nothing was approved by the restart.
  await h.restartServer();
  await sleep(2000);
  assert.equal((await h.state()).questions.find((x) => x.id === q.id)!.status, 'open');
  assert.ok(!fs.existsSync(path.join(wt, 'rotate.txt')), 'nothing was approved implicitly');

  // The agent itself goes away for longer than the hook waits for it (a restart alone the hook outlives:
  // 38-hook-outlives-agent): now the held hook is gone, and Orchestrator says so instead of pretending the request
  // is still answerable.
  await h.stopAgent();
  const pane = (await h.session(danaId))!.tmuxPane!;
  await waitFor(() => /Do you want to proceed\?/.test(h.tmux('capture-pane', '-p', '-t', pane)), { label: 'Claude Code asks in the terminal', timeout: 20000 });
  await h.startAgent();
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q.id)!.status === 'superseded', { label: 'the request through the hook is over', timeout: 20000 });
  const late = await h.apiRaw('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  assert.equal(late.status, 409);
  assert.ok(!fs.existsSync(path.join(wt, 'rotate.txt')), 'nothing was approved implicitly');

  // Claude Code is now showing its own prompt; the Notification hook tells the office.
  const session = await waitFor(async () => {
    const s = await h.session(danaId);
    return s?.status === 'running' && s.activity === 'needs_approval' ? s : null;
  }, { label: 'terminal prompt reported', timeout: 20000 });
  assert.match(h.tmux('capture-pane', '-p', '-t', session.tmuxPane!), /Do you want to proceed\?/);

  // The owner sits down at the workstation and answers it there.
  const boss = await h.client();
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => /Do you want to proceed\?/.test(boss.terminal(session.id)), { label: 'prompt visible in the office terminal' });
  boss.send({ t: 'control.acquire', sessionId: session.id });
  await waitFor(() => boss.control.get(session.id)?.you === true, { label: 'control' });
  boss.send({ t: 'term.input', sessionId: session.id, data: '1' });
  await waitFor(() => fs.existsSync(path.join(wt, 'rotate.txt')), { label: 'approved in the terminal' });
  await waitFor(() => /rotation-configured/.test(boss.terminal(session.id)), { label: 'agent continued' });
  boss.send({ t: 'control.release', sessionId: session.id });
});

test('pausing interrupts the real session and holds deliveries until resumed', async () => {
  await waitFor(async () => (await h.session(alexId))!.inTurn === false, { label: 'Alex idle' });
  const task = await h.task({ projectId, title: 'Long job', assigneeId: alexId, verifyCommand: 'true', description: '@@fake: say step-1; sleep 1500; say step-2; sleep 1500; say step-3-should-not-run@@' });
  const session = (await h.session(alexId))!;
  await waitFor(() => /step-1/.test(h.tmux('capture-pane', '-p', '-t', session.tmuxPane!)), { label: 'job started' });
  await h.api('POST', `/employees/${alexId}/pause`, {});
  const paused = (await h.session(alexId))!;
  assert.equal(paused.activity, 'paused');
  assert.equal(paused.control, 'PAUSED');
  await waitFor(() => /Interrupted/.test(h.tmux('capture-pane', '-p', '-t', session.tmuxPane!)), { label: 'Escape really interrupted the turn' });
  await sleep(1800);
  assert.doesNotMatch(h.tmux('capture-pane', '-p', '-t', session.tmuxPane!), /step-3-should-not-run/);
  const msg = await h.api('POST', `/employees/${alexId}/message`, { body: 'while paused' });
  await sleep(700);
  assert.equal((await h.state()).messages.find((m) => m.id === msg.id)!.delivery.status, 'queued', 'nothing is typed into a paused session');

  await h.api('POST', `/employees/${alexId}/resume`, {});
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === msg.id)!.delivery.status === 'confirmed', { label: 'delivered after resume' });
  assert.equal((await h.session(alexId))!.control, 'AGENT_CONTROLLED');
  assert.equal((await h.session(alexId))!.pid, session.pid, 'same process throughout');
  const types = (await h.state()).events.map((e) => e.type);
  assert.ok(types.includes('terminal.interrupt'));
  await h.api('PATCH', `/tasks/${task.id}`, { status: 'BLOCKED' });
});

test('pausing a project interrupts its work and stops scheduling; resuming continues on the same branch', async () => {
  const p2repo = h.makeRepo('billing');
  const p2 = await h.project('Billing', p2repo, { verifyCommand: 'true' });
  const eve = await h.employee('Eve', 'fullstack', { projectId: p2.id, autonomy: 'standard' });
  const t = await h.task({ projectId: p2.id, title: 'Invoices', assigneeId: eve.id, description: '@@fake: write inv.txt draft; commit wip; sleep 6000; say never-finished@@ ' });
  await waitFor(async () => (await h.getTask(t.id)).delivery.status === 'confirmed', { label: 'started' });
  const branch = (await h.getTask(t.id)).branch;
  // Let the work-in-progress commit land before interrupting.
  const wt = (await h.getTask(t.id)).worktree!;
  await waitFor(() => /wip/.test(h.git(wt, 'log', '--oneline', '-1')), { label: 'wip commit' });
  const res = await h.api('POST', `/projects/${p2.id}/pause`, {});
  assert.equal(res.interrupted, 1);
  const paused = await h.getTask(t.id);
  assert.equal(paused.status, 'READY');
  assert.equal((await h.state()).projects.find((x) => x.id === p2.id)!.status, 'paused');
  const queued = await h.task({ projectId: p2.id, title: 'More invoices', assigneeId: eve.id, description: 'x' });
  await sleep(600);
  assert.equal((await h.getTask(queued.id)).status, 'READY', 'paused projects are not scheduled');
  assert.equal((await h.getTask(t.id)).status, 'READY');

  await h.api('POST', `/projects/${p2.id}/resume`, {});
  const resumed = await waitFor(async () => {
    const x = await h.getTask(t.id);
    return x.status === 'IN_PROGRESS' && x.delivery.status === 'confirmed' ? x : null;
  }, { label: 'resumed' });
  assert.equal(resumed.branch, branch, 'same task branch, with the earlier commit still on it');
  assert.match(h.git(resumed.worktree!, 'log', '--oneline', '-1'), /wip/);
});

test('a late "session ended" report about a previous incarnation does not take down the restarted session', async () => {
  const fresh = await h.employee('Ines', 'backend', { projectId, autonomy: 'standard' });
  const first = await h.api('POST', `/employees/${fresh.id}/start`, {});
  await waitFor(async () => (await h.session(fresh.id))!.inTurn === false, { label: 'first incarnation ready' });
  await h.api('POST', `/employees/${fresh.id}/stop`, {});
  const second = await h.api('POST', `/employees/${fresh.id}/start`, {});
  assert.equal(second.id, first.id, 'same session record');
  assert.notEqual(second.launchId, first.launchId, 'a new launch');
  assert.notEqual(second.pid, first.pid);
  await waitFor(async () => (await h.session(fresh.id))!.inTurn === false, { label: 'second incarnation ready' });
  // The host's monitor reports the old tmux session as ended only now (it was slow, or the network was).
  (h.agent as any).send({ t: 'session.gone', sessionId: first.id, reason: 'tmux session ended', launchId: first.launchId });
  // …and so does a stale status report about it.
  (h.agent as any).send({ t: 'session', session: { ...first, sessionId: first.id, launchId: first.launchId, alive: false, exitReason: 'process exited with status 0' } });
  await sleep(400);
  const after = (await h.session(fresh.id))!;
  assert.equal(after.status, 'running');
  assert.equal(after.tmuxSession, second.tmuxSession);
  assert.ok(!(await h.state()).events.some((e) => e.type === 'session.lost' && e.sessionId === first.id && e.ts > second.startedAt), 'no false "session lost"');
  // A report about the incarnation that is actually running still counts.
  h.tmux('kill-session', '-t', second.tmuxSession);
  await waitFor(async () => (await h.session(fresh.id))!.status !== 'running', { label: 'the real end is noticed' }).catch(async (e) => {
    const now = (await h.session(fresh.id))!;
    const tracked = (h.agent as any).tracked.get(first.id);
    throw new Error(`${e.message}\noffice: ${JSON.stringify({ status: now.status, launchId: now.launchId, pid: now.pid })}\nagent: ${JSON.stringify(tracked && { launchId: tracked.launchId, gone: tracked.gone, alive: tracked.alive, tmux: tracked.tmuxSession })} connected=${h.agent.isConnected}\ntmux: ${h.tmux('list-sessions', '-F', '#{session_name}').trim().replace(/\n/g, ' ')}`);
  });
});

test('a revoked host is cut off and cannot come back with its old credential', async () => {
  await h.api('POST', `/hosts/${h.hostId}/revoke`, {});
  await waitFor(() => h.agent.rejection !== null || !h.agent.isConnected, { label: 'agent disconnected' });
  const state = await h.state();
  assert.equal(state.hosts.find((x) => x.id === h.hostId)!.status, 'revoked');
  assert.ok(state.sessions.filter((s) => s.hostId === h.hostId).every((s) => s.status !== 'running'), 'no session is shown as running on a revoked host');
  // Reconnecting with the revoked credential is refused.
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}/ws/agent`);
  const reply = await new Promise<any>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, hostId: h.hostId, credential: h.agentCfg.credential, info: {} }));
    ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
  });
  assert.equal(reply.t, 'rejected');
  // The tmux sessions themselves are untouched by revocation.
  assert.match(h.tmux('list-sessions', '-F', '#{session_name}'), /orch-alex-/);
});
