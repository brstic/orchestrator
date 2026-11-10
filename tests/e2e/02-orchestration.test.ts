/**
 * Phase 3 acceptance: assign a task through Orchestrator, observe genuine
 * activity, receive a real question, answer it, and see the session continue
 * to a verified completion.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;
let repo = '';
let projectId = '';

const events = async (type: string) => (await h.state()).events.filter((e) => e.type === type);

before(async () => {
  h = await createHarness();
  boss = await h.client();
  repo = h.makeRepo('crm');
  projectId = (await h.project('Customer Platform', repo, { verifyCommand: 'npm test --silent', requirements: 'Customers can log in.' })).id;
});
after(async () => {
  await h.cleanup();
});

test('project creation validates the repository on the host', async () => {
  const bad = await h.apiRaw('POST', '/projects', { name: 'Ghost', repoPath: path.join(h.tmp, 'does-not-exist'), hostId: h.hostId });
  assert.equal(bad.status, 400);
  const outside = await h.apiRaw('POST', '/projects', { name: 'Outside', repoPath: '/etc', hostId: h.hostId });
  assert.ok(outside.status >= 400, 'paths outside the host allow-list are refused');
  const p = (await h.state()).projects.find((x) => x.id === projectId)!;
  assert.equal(p.baseBranch, 'main');
  assert.equal(p.repoPath, repo);
});

test('a task is delivered to a real session, a question is asked and answered, and completion is verified', async () => {
  const alex = await h.employee('Alex', 'backend', { projectId, autonomy: 'standard' });
  const task = await h.task({
    projectId,
    title: 'Add login feature',
    assigneeId: alex.id,
    description: 'Implement it. @@fake: progress scaffolding done; write feature.txt hello; commit add feature; ask Should sessions expire?; write answer.txt recorded; commit record decision; complete implemented login@@',
    acceptance: 'feature.txt exists',
  });
  assert.equal(task.key, 'T-1');

  // The employee had no session: assigning work starts the real process in an isolated worktree.
  const started = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'IN_PROGRESS' && t.delivery.status === 'confirmed' ? t : null;
  }, { label: 'task delivered and acknowledged by a UserPromptSubmit hook' });
  assert.match(started.branch!, /^orch\/alex\/t-1-add-login-feature/);
  assert.ok(started.worktree!.includes('.orchestrator-worktrees/crm/alex'));
  assert.ok(fs.existsSync(started.worktree!), 'worktree exists on disk');
  const session = (await h.session(alex.id))!;
  assert.equal(session.cwd, started.worktree);
  assert.equal(session.permissionMode, 'acceptEdits', 'standard autonomy maps to acceptEdits');

  // The question arrives through the real MCP tool and blocks the agent.
  const q = await waitFor(() => h.openQuestion(alex.id), { label: 'question from ask_boss' });
  assert.equal(q.channel, 'mcp_tool');
  assert.equal(q.text, 'Should sessions expire?');
  assert.equal(q.taskId, task.id);
  assert.deepEqual(q.options.map((o) => o.label), ['Option A', 'Option B']);
  assert.equal((await h.session(alex.id))!.activity, 'waiting_answer');
  assert.ok((await h.state()).notifications.some((n) => n.questionId === q.id && !n.resolvedAt));
  assert.equal((await h.getTask(task.id)).progress.note, 'scaffolding done');
  // Work done so far is real, and isolated: the main checkout is untouched.
  assert.ok(fs.existsSync(path.join(started.worktree!, 'feature.txt')));
  assert.ok(!fs.existsSync(path.join(repo, 'feature.txt')));
  assert.ok(!fs.existsSync(path.join(started.worktree!, 'answer.txt')), 'the agent is genuinely waiting');

  const answered = await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Yes, after 30 minutes' });
  assert.equal(answered.status === 'answered' || answered.status === 'delivered' || answered.status === 'confirmed', true);

  const done = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'task verified and done', timeout: 20000 });

  // The answer really reached the agent as the tool result, and a hook confirmed it.
  const q2 = (await h.state()).questions.find((x) => x.id === q.id)!;
  assert.equal(q2.status, 'confirmed');
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => /The boss answered: Yes, after 30 minutes/.test(boss.terminal(session.id)), { label: 'answer visible in the real terminal' });
  boss.send({ t: 'term.close', sessionId: session.id });

  // Evidence is measured by Orchestrator, not taken from the agent's word.
  assert.equal(done.evidence.commits.length, 2);
  assert.deepEqual(done.evidence.filesChanged.sort(), ['answer.txt', 'feature.txt']);
  assert.equal(done.evidence.verification!.provenance, 'measured');
  assert.equal(done.evidence.verification!.passed, true);
  assert.equal(done.evidence.verification!.exitCode, 0);
  assert.match(done.evidence.verification!.outputTail, /all checks passed/);
  assert.equal(done.evidence.merge!.ok, true);
  assert.match(h.git(repo, 'log', '--oneline', 'orchestrator/integration'), /Merge T-1: Add login feature/);
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:feature.txt'), 'hello');
  assert.equal(h.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the owner\'s checkout was never switched');
  assert.equal(h.git(repo, 'status', '--porcelain'), '', 'the owner\'s checkout is clean');

  // Event trail, in order, all sourced from real signals.
  const types = (await h.state()).events.filter((e) => e.taskId === task.id).map((e) => e.type);
  for (const t of ['task.created', 'task.assigned', 'task.started', 'task.progress', 'agent.question', 'agent.question_answered', 'task.verifying', 'task.merged', 'task.completed']) assert.ok(types.includes(t as any), `missing event ${t}`);
  assert.ok(types.indexOf('task.started' as any) < types.indexOf('task.completed' as any));
  assert.ok((await events('agent.tool_finished')).some((e) => e.summary === 'Alex modified feature.txt'));

  // Progression is tied to the verified record.
  const after = (await h.state()).employees.find((e) => e.id === alex.id)!;
  assert.equal(after.stats.tasksCompleted, 1);
  assert.equal(after.stats.testsPassed, 1);
  assert.ok(after.xp >= 125);
  const xp = await h.api('GET', `/employees/${alex.id}/xp`);
  assert.ok(xp.every((x: any) => x.evidenceRef === task.id));
  assert.equal((await h.state()).company.tasksCompleted, 1);
  // Measured token usage comes from the transcript on the host.
  await waitFor(async () => ((await h.session(alex.id))?.usage?.outputTokens ?? 0) > 0, { label: 'usage read from transcript' });
});

test('failed verification keeps the task open; the agent is told and must fix it', async () => {
  const alex = (await h.state()).employees.find((e) => e.name === 'Alex')!;
  const task = await h.task({ projectId, title: 'Risky change', assigneeId: alex.id, description: '@@fake: write status.txt BROKEN; commit risky; complete first attempt@@' });
  await waitFor(async () => (await events('task.verification_failed')).some((e) => e.taskId === task.id), { label: 'verification failure recorded' });
  const t = await h.getTask(task.id);
  assert.equal(t.status, 'IN_PROGRESS');
  assert.equal(t.evidence.verification!.passed, false);
  assert.equal(t.evidence.verification!.exitCode, 1);
  assert.match(t.evidence.verification!.outputTail, /status\.txt is broken/);
  assert.equal(t.attempts, 1);
  assert.ok((await h.state()).notifications.some((n) => n.kind === 'test_failure' && n.taskId === task.id && !n.resolvedAt));
  assert.equal((await h.state()).employees.find((e) => e.id === alex.id)!.stats.tasksCompleted, 1, 'no XP for unverified work');
  // The failure output was returned to the agent in its own terminal.
  const session = (await h.session(alex.id))!;
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => /Verification FAILED for T-2/.test(boss.terminal(session.id)), { label: 'failure shown to agent' });
  boss.send({ t: 'term.close', sessionId: session.id });

  // The owner tells Alex how to fix it; the message is typed into the real session when it is idle.
  const msg = await h.api('POST', `/employees/${alex.id}/message`, { body: 'Fix it. @@fake: write status.txt fine; commit fix; complete second attempt@@' });
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === msg.id)?.delivery.status === 'confirmed', { label: 'message confirmed by hook' });
  const done = await waitFor(async () => {
    const x = await h.getTask(task.id);
    return x.status === 'DONE' ? x : null;
  }, { label: 'fixed and done' });
  assert.equal(done.evidence.verification!.passed, true);
  assert.equal(done.evidence.commits.length, 2);
  assert.ok(!(await h.state()).notifications.some((n) => n.kind === 'test_failure' && n.taskId === task.id && !n.resolvedAt), 'failure notification resolved');
});

test('completion is refused while work is uncommitted', async () => {
  const alex = (await h.state()).employees.find((e) => e.name === 'Alex')!;
  const task = await h.task({ projectId, title: 'Sloppy finish', assigneeId: alex.id, description: '@@fake: write notes.txt draft; complete too early; commit now committed; complete properly@@' });
  const done = await waitFor(async () => {
    const x = await h.getTask(task.id);
    return x.status === 'DONE' ? x : null;
  }, { label: 'done after committing' });
  assert.equal(done.evidence.commits.length, 1);
  const session = (await h.session(alex.id))!;
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => /Not complete: there are uncommitted changes/.test(boss.terminal(session.id)), { label: 'refusal shown to the agent' });
  boss.send({ t: 'term.close', sessionId: session.id });
});

test('a supervised employee needs approval for every edit; decisions travel through the real permission hook', async () => {
  const dana = await h.employee('Dana', 'devops', { projectId });
  assert.equal(dana.autonomy, 'supervised');
  const task = await h.task({ projectId, title: 'Edit pipeline', assigneeId: dana.id, kind: 'ops', verifyCommand: 'true', description: '@@fake: write ci.txt pipeline; write nope.txt denied; say after-permissions@@' });
  const q1 = await waitFor(() => h.openQuestion(dana.id, 'permission'), { label: 'permission request' });
  assert.equal(q1.channel, 'permission_hook');
  assert.equal(q1.tool!.name, 'Write');
  assert.match(String((q1.tool!.input as any).file_path), /ci\.txt$/);
  const session = (await h.session(dana.id))!;
  assert.equal(session.activity, 'needs_approval');
  assert.notEqual(session.permissionMode, 'acceptEdits');
  const wt = (await h.getTask(task.id)).worktree!;
  assert.ok(!fs.existsSync(path.join(wt, 'ci.txt')), 'nothing is written before approval');

  // A permission request cannot be "answered" with free text.
  assert.equal((await h.apiRaw('POST', `/questions/${q1.id}/answer`, { answer: 'sure' })).status, 400);
  await h.api('POST', `/questions/${q1.id}/answer`, { decision: 'allow' });
  await waitFor(() => fs.existsSync(path.join(wt, 'ci.txt')), { label: 'approved write happened' });
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q1.id)?.status === 'confirmed', { label: 'approval confirmed by PostToolUse' });

  const q2 = await waitFor(() => h.openQuestion(dana.id, 'permission'), { label: 'second permission request' });
  await h.api('POST', `/questions/${q2.id}/answer`, { decision: 'deny', answer: 'Not that file.' });
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => /denied: Not that file\./.test(boss.terminal(session.id)) && /after-permissions/.test(boss.terminal(session.id)), { label: 'denial reached the agent, which continued' });
  boss.send({ t: 'term.close', sessionId: session.id });
  assert.ok(!fs.existsSync(path.join(wt, 'nope.txt')), 'denied write never happened');
  const decided = await events('agent.permission_decided');
  assert.ok(decided.length >= 2);
  const audit = await h.api('GET', '/audit');
  assert.equal(audit.filter((a: any) => a.action === 'approval.decide').length, 2);
});

test('high-risk commands are escalated even for an autonomous employee', async () => {
  const otto = await h.employee('Otto', 'fullstack', { projectId, autonomy: 'autonomous' });
  const task = await h.task({ projectId, title: 'Ship it', assigneeId: otto.id, verifyCommand: 'true', description: '@@fake: bash git status; bash git push origin main; say pushed-or-not@@' });
  const q = await waitFor(() => h.openQuestion(otto.id, 'permission'), { label: 'high-risk escalation' });
  assert.equal(q.tool!.name, 'Bash');
  assert.match(String((q.tool!.input as any).command), /git push origin main/);
  assert.match(q.why, /high-risk/);
  // `git status` ran without asking: it is pre-approved for this autonomy level.
  const started = (await events('agent.tool_started')).filter((e) => e.employeeId === otto.id);
  assert.ok(started.some((e) => (e.data as any).input?.command === 'git status'));
  assert.ok(started.some((e) => (e.data as any).highRisk === true));
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'deny', answer: 'No pushing.' });
  await waitFor(async () => (await h.session(otto.id))?.activity !== 'needs_approval', { label: 'agent moved on' });
  void task;
});

test("Claude Code's AskUserQuestion is answered from the office through the hook", async () => {
  const otto = (await h.state()).employees.find((e) => e.name === 'Otto')!;
  await waitFor(async () => ['idle', 'waiting_input'].includes((await h.session(otto.id))!.activity), { label: 'Otto idle' });
  await h.api('POST', `/employees/${otto.id}/message`, { body: '@@fake: askuser Which database?|Postgres|SQLite@@' });
  const q = await waitFor(() => h.openQuestion(otto.id, 'question'), { label: 'AskUserQuestion surfaced' });
  assert.equal(q.channel, 'ask_user_question_hook');
  assert.equal(q.parts.length, 1);
  assert.deepEqual(q.parts[0]!.options.map((o) => o.label), ['Postgres', 'SQLite']);
  await h.api('POST', `/questions/${q.id}/answer`, { answers: { 'Which database?': 'SQLite' } });
  const session = (await h.session(otto.id))!;
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => /answer: SQLite/.test(boss.terminal(session.id)), { label: 'answer supplied to the tool' });
  boss.send({ t: 'term.close', sessionId: session.id });
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q.id)?.status === 'confirmed', { label: 'confirmed' });
});

test('a restricted employee cannot modify files at all', async () => {
  const rita = await h.employee('Rita', 'researcher', { projectId });
  assert.equal(rita.autonomy, 'restricted');
  const task = await h.task({ projectId, title: 'Investigate login', assigneeId: rita.id, kind: 'research', description: '@@fake: read README.md; write hack.txt nope; mcp submit_result {"title":"Findings","content":"Login is fine."}; complete-nocode findings submitted@@' });
  const done = await waitFor(async () => {
    const x = await h.getTask(task.id);
    return x.status === 'DONE' ? x : null;
  }, { label: 'research done' });
  assert.equal(done.branch, null, 'research tasks get no task branch');
  assert.equal(done.evidence.verification!.provenance, 'unavailable', 'nothing was verified, and it says so');
  assert.ok(!fs.existsSync(path.join(done.worktree!, 'hack.txt')));
  assert.ok((await h.state()).artifacts.some((a) => a.title === 'Findings' && a.employeeId === rita.id));
  assert.ok((await events('agent.permission_decided')).some((e) => e.employeeId === rita.id && (e.data as any).decision === 'deny'));
  // Activity states came from real hooks.
  const states = (await h.api('GET', `/events?employeeId=${rita.id}&includeActivity=1&limit=500`)).filter((e: any) => e.type === 'session.activity').map((e: any) => e.data.state);
  assert.ok(states.includes('idle'));
});

test('an autonomous employee who stops mid-task is nudged a bounded number of times, then shown as waiting', async () => {
  const otto = (await h.state()).employees.find((e) => e.name === 'Otto')!;
  const prev = (await h.state()).tasks.find((t) => t.title === 'Ship it')!;
  await h.api('PATCH', `/tasks/${prev.id}`, { status: 'BLOCKED' });
  const task = await h.task({ projectId, title: 'Wander off', assigneeId: otto.id, verifyCommand: 'true', description: '@@fake: say I will think about it@@' });
  await waitFor(async () => (await h.getTask(task.id)).nudges === 3, { label: 'three nudges' });
  await waitFor(async () => (await h.session(otto.id))!.activity === 'waiting_input', { label: 'waiting state after nudges' });
  const t = await h.getTask(task.id);
  assert.equal(t.status, 'IN_PROGRESS');
  assert.equal(t.nudges, 3, 'never more than the autonomy level allows');
  await sleep(600);
  assert.equal((await h.getTask(task.id)).nudges, 3);
});

test('Orchestrator never types into a terminal the owner is controlling', async () => {
  const rita = (await h.state()).employees.find((e) => e.name === 'Rita')!;
  const session = (await h.session(rita.id))!;
  await waitFor(async () => ['idle', 'task_complete'].includes((await h.session(rita.id))!.activity), { label: 'Rita idle' });
  boss.send({ t: 'term.open', sessionId: session.id });
  boss.send({ t: 'control.acquire', sessionId: session.id });
  await waitFor(() => boss.control.get(session.id)?.you === true, { label: 'owner in control' });
  const msg = await h.api('POST', `/employees/${rita.id}/message`, { body: 'held-until-release' });
  await sleep(1200);
  assert.equal((await h.state()).messages.find((m) => m.id === msg.id)!.delivery.status, 'queued', 'held back while the owner types');
  assert.doesNotMatch(boss.terminal(session.id), /held-until-release/);
  boss.send({ t: 'control.release', sessionId: session.id });
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === msg.id)!.delivery.status === 'confirmed', { label: 'delivered after release' });
  boss.send({ t: 'term.close', sessionId: session.id });
});

test('duplicate hook delivery is idempotent', async () => {
  const before = (await h.state()).events.length;
  const engine = h.server.engine;
  const session = (await h.state()).sessions.find((s) => s.status === 'running')!;
  const raw = { id: 'dup-test-1', ts: new Date().toISOString(), hostSeq: 1, sessionId: session.id, tmuxPane: session.tmuxPane, payload: { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: `${session.cwd}/dup.txt` }, cwd: session.cwd } };
  assert.equal(engine.hooks.onHook(h.hostId, raw as any), true);
  assert.equal(engine.hooks.onHook(h.hostId, raw as any), true, 'redelivery is acknowledged');
  assert.equal(engine.hooks.onHook(h.hostId, raw as any), true);
  const dup = (await h.api('GET', `/events?sessionId=${session.id}&limit=500`)).filter((e: any) => e.summary.endsWith('modified dup.txt'));
  assert.equal(dup.length, 1, 'applied exactly once');
  assert.ok((await h.state()).events.length >= before);
  // A hook claiming another host's session is ignored.
  engine.hooks.onHook('some-other-host', { ...raw, id: 'dup-test-2' } as any);
  assert.equal((await h.api('GET', `/events?sessionId=${session.id}&limit=500`)).filter((e: any) => e.summary.endsWith('modified dup.txt')).length, 1);
});
