/**
 * Self-improvement: workers build a playbook from their own verified
 * experience, and Orchestrator proposes changes to its own way of working
 * from its recorded history. All of it is grounded in real records.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, sleep, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;
let repo = '';
let projectId = '';
const ids: Record<string, string> = {};

const done = (id: string, label: string) =>
  waitFor(async () => {
    const t = await h.getTask(id);
    return t.status === 'DONE' ? t : null;
  }, { label, timeout: 25000 });
const idle = (name: string) => waitFor(async () => (await h.session(ids[name]!))?.inTurn === false, { label: `${name} idle`, timeout: 20000 });
const termOf = async (name: string) => {
  const s = (await h.session(ids[name]!))!;
  boss.send({ t: 'term.open', sessionId: s.id });
  await waitFor(() => boss.terminals.has(s.id), { label: 'terminal' });
  return s.id;
};

before(async () => {
  h = await createHarness();
  boss = await h.client();
  // These tests are about what the owner decides by hand; what the office applies by itself is in 23-learning-autopilot.
  await h.api('PATCH', '/settings', { selfImprovement: { autopilot: 'off' } });
  repo = h.makeRepo('learn');
  projectId = (await h.project('Learning', repo, { verifyCommand: 'npm test --silent' })).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId, autonomy: 'standard' })).id;
});
after(async () => {
  await h.cleanup();
});

test('a clean task triggers no retrospective', async () => {
  const t = await h.task({ projectId, title: 'Clean work', kind: 'bug', assigneeId: ids.Alex, description: '@@fake: write clean.txt ok; commit clean; complete clean@@' });
  const d = await done(t.id, 'clean task');
  assert.deepEqual(d.friction, { failedVerifications: 0, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 });
  await idle('Alex');
  const s = await h.state();
  assert.ok(!s.events.some((e) => e.type === 'improvement.retrospective_requested'), 'nothing to reflect on');
  assert.equal(s.lessons.length, 0);
});

test("after a failed verification, the worker's own session records a lesson with evidence", async () => {
  const t = await h.task({ projectId, title: 'Sloppy work', kind: 'bug', assigneeId: ids.Alex, description: '@@fake: write sloppy.txt BROKEN; commit sloppy; complete first; write sloppy.txt fixed; commit fix; complete second@@' });
  const d = await done(t.id, 'sloppy task eventually done');
  assert.equal(d.friction.failedVerifications, 1);
  const lesson = await waitFor(async () => (await h.state()).lessons.find((l) => l.employeeId === ids.Alex), { label: 'lesson recorded by the agent' });
  assert.equal(lesson.scope, 'employee');
  assert.equal(lesson.source, 'retrospective');
  assert.equal(lesson.status, 'active');
  assert.equal(lesson.authoredBy.kind, 'employee');
  assert.match(lesson.text, /verification command myself before calling complete_task/);
  assert.deepEqual(lesson.evidence.map((e) => e.id), [t.id], 'the lesson cites the task it came from');
  // The retrospective prompt carried the recorded facts into the real session.
  const types = (await h.state()).events.filter((e) => e.taskId === t.id).map((e) => e.type);
  assert.ok(types.includes('improvement.retrospective_requested') && types.includes('improvement.lesson_recorded'));
  await idle('Alex');
});

test('the lesson is fed back into the next task', async () => {
  const before = (await h.state()).lessons.find((l) => l.employeeId === ids.Alex)!;
  const t = await h.task({ projectId, title: 'Next work', kind: 'bug', assigneeId: ids.Alex, description: '@@fake: mcp get_playbook {}; write next.txt ok; commit next; complete next@@' });
  await done(t.id, 'next task');
  const term = await termOf('Alex');
  await waitFor(() => /Lessons from your own earlier work here/.test(boss.terminal(term)) && /verification command myself/.test(boss.terminal(term)), { label: 'playbook visible to the agent' });
  const after = (await h.state()).lessons.find((l) => l.id === before.id)!;
  assert.ok(after.appliedCount > before.appliedCount, 'inclusion in the task prompt is counted');
  // Measured effect, as plain counts: before the lesson 1 of 2 passed first time, after it 1 of 1.
  const perf = (await h.state()).performance.find((p) => p.employeeId === ids.Alex && p.kind === 'bug')!;
  assert.deepEqual({ completed: perf.completed, firstPass: perf.firstPass, failed: perf.failedVerifications }, { completed: 3, firstPass: 2, failed: 1 });
});

test("the boss's answer becomes project knowledge that other employees receive", async () => {
  await idle('Alex');
  const t = await h.task({ projectId, title: 'Pick a format', assigneeId: ids.Alex, description: '@@fake: ask Which date format do we use?; write fmt.txt iso; commit fmt; complete fmt@@' });
  const q = await waitFor(() => h.openQuestion(ids.Alex), { label: 'question' });
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'ISO 8601 everywhere' });
  await done(t.id, 'format task');
  const knowledge = await waitFor(async () => (await h.state()).lessons.find((l) => l.source === 'owner_answer'), { label: 'knowledge captured' });
  assert.equal(knowledge.scope, 'project');
  assert.equal(knowledge.projectId, projectId);
  assert.match(knowledge.text, /Which date format do we use\?.*ISO 8601 everywhere/);
  assert.equal(knowledge.evidence[0]!.id, q.id);
  // A different employee on the project is told, so the question is not asked twice.
  ids.Sarah = (await h.employee('Sarah', 'frontend', { projectId, autonomy: 'standard' })).id;
  const t2 = await h.task({ projectId, title: 'Render dates', assigneeId: ids.Sarah, description: '@@fake: mcp get_playbook {}; write dates.txt iso; commit dates; complete dates@@' });
  await done(t2.id, "Sarah's task");
  const term = await termOf('Sarah');
  await waitFor(() => /already made by the boss/.test(boss.terminal(term)) && /ISO 8601 everywhere/.test(boss.terminal(term)), { label: 'Sarah received the decision' });
});

test('a lesson proposed for the whole team waits for the owner', async () => {
  ids.Rev = (await h.employee('Rev', 'reviewer', { projectId })).id;
  await idle('Sarah');
  const t = await h.task({ projectId, title: 'Draft feature', assigneeId: ids.Sarah, requiresReview: true, description: '@@fake: write draft.txt NEEDS-WORK; commit draft; complete draft@@ @@fake-retry: write draft.txt final; commit final; complete final@@' });
  await done(t.id, 'reviewed and approved');
  const proposed = await waitFor(async () => (await h.state()).lessons.find((l) => l.status === 'proposed'), { label: 'team lesson proposed' });
  assert.equal(proposed.scope, 'project');
  assert.equal(proposed.authoredBy.name, 'Sarah');
  assert.ok((await h.state()).notifications.some((n) => n.kind === 'improvement' && /proposes a team lesson/.test(n.title)));
  // Not in anyone's prompt until approved.
  await idle('Alex');
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: '@@fake: mcp get_playbook {}@@' });
  const term = await termOf('Alex');
  await sleep(900);
  assert.doesNotMatch(boss.terminal(term), /Remove draft markers/);
  await h.api('PATCH', `/lessons/${proposed.id}`, { status: 'active' });
  await idle('Alex');
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'again @@fake: mcp get_playbook {}@@' });
  await waitFor(() => /Remove draft markers/.test(boss.terminal(term)), { label: 'approved lesson now shared' });
});

test('Orchestrator notices repeated approvals and proposes a rule; applying it changes real permissions', async () => {
  await idle('Alex');
  for (let i = 0; i < 3; i++) {
    await h.api('POST', `/employees/${ids.Alex}/message`, { body: `run ${i} @@fake: bash docker build -t app:${i} --help >/dev/null 2>&1 || true@@` });
    const q = await waitFor(() => h.openQuestion(ids.Alex, 'permission'), { label: `approval ${i}` });
    assert.equal(((await h.state()).improvements).filter((x) => x.kind === 'allow_rule').length, 0, 'not before the third approval');
    await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
    await idle('Alex');
  }
  const imp = await waitFor(async () => (await h.state()).improvements.find((x) => x.kind === 'allow_rule'), { label: 'allow-rule suggestion' });
  assert.equal(imp.status, 'proposed');
  assert.deepEqual(imp.action, { type: 'project.policy.allow', projectId, rule: 'Bash(docker build:*)' });
  assert.equal(imp.evidence.length, 3);
  assert.ok(!(await h.state()).projects.find((p) => p.id === projectId)!.policy.allow.includes('Bash(docker build:*)'), 'never applied without the owner');

  await h.api('POST', `/improvements/${imp.id}/apply`, {});
  assert.ok((await h.state()).projects.find((p) => p.id === projectId)!.policy.allow.includes('Bash(docker build:*)'));
  assert.equal((await h.apiRaw('POST', `/improvements/${imp.id}/apply`, {})).status, 409);
  // The rule reaches Claude Code's real settings on the next launch: no question this time.
  await h.api('POST', `/employees/${ids.Alex}/stop`, {});
  await h.api('POST', `/employees/${ids.Alex}/start`, { resume: false });
  await idle('Alex');
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'again @@fake: bash docker build -t app:9 --help >/dev/null 2>&1 || true; say ran-without-asking@@' });
  const term = await termOf('Alex');
  await waitFor(() => /ran-without-asking/.test(boss.terminal(term)), { label: 'command ran pre-approved' });
  assert.equal(await h.openQuestion(ids.Alex, 'permission'), undefined);
});

test('high-risk commands are never offered for pre-approval, however often they are approved', async () => {
  for (let i = 0; i < 3; i++) {
    await idle('Alex');
    await h.api('POST', `/employees/${ids.Alex}/message`, { body: `push ${i} @@fake: bash git push origin feature-${i} --dry-run || true@@` });
    const q = await waitFor(() => h.openQuestion(ids.Alex, 'permission'), { label: `push approval ${i}` });
    await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  }
  await idle('Alex');
  await h.api('POST', '/improvements/analyze', {});
  assert.ok(!(await h.state()).improvements.some((x) => x.action.type === 'project.policy.allow' && /git push/.test((x.action as any).rule)));
});

test('a dismissed suggestion is not proposed again', async () => {
  for (let i = 0; i < 3; i++) {
    await idle('Alex');
    await h.api('POST', `/employees/${ids.Alex}/message`, { body: `curl ${i} @@fake: bash wget --version >/dev/null 2>&1 || true@@` });
    const q = await waitFor(() => h.openQuestion(ids.Alex, 'permission'), { label: `deny ${i}` });
    await h.api('POST', `/questions/${q.id}/answer`, { decision: 'deny', answer: 'no downloads' });
  }
  const imp = await waitFor(async () => (await h.state()).improvements.find((x) => x.kind === 'deny_rule'), { label: 'deny-rule suggestion' });
  await h.api('POST', `/improvements/${imp.id}/dismiss`, {});
  const again = await h.api('POST', '/improvements/analyze', {});
  assert.equal(again.filter((x: any) => x.kind === 'deny_rule').length, 0);
  assert.equal((await h.state()).improvements.filter((x) => x.kind === 'deny_rule').length, 1);
});

test('routing learns from measured outcomes', async () => {
  // Bo has a clean record on bug tasks; Alex has a failure on his.
  ids.Bo = (await h.employee('Bo', 'backend', { projectId, autonomy: 'standard' })).id;
  for (const n of [1, 2]) {
    const t = await h.task({ projectId, title: `Bo bug ${n}`, kind: 'bug', assigneeId: ids.Bo, description: `@@fake: write bo${n}.txt ok; commit bo${n}; complete bo${n}@@` });
    await done(t.id, `Bo bug ${n}`);
  }
  await idle('Bo');
  await idle('Alex');
  const perf = (await h.state()).performance;
  const bo = perf.find((p) => p.employeeId === ids.Bo && p.kind === 'bug')!;
  const alex = perf.find((p) => p.employeeId === ids.Alex && p.kind === 'bug')!;
  assert.equal(bo.firstPass / bo.completed, 1);
  assert.ok(alex.firstPass / alex.completed < 1);
  const t = await h.task({ projectId, title: 'Unassigned bug', kind: 'bug', roleHint: 'backend', description: '@@fake: write routed.txt ok; commit routed; complete routed@@' });
  const routed = await done(t.id, 'routed bug');
  assert.equal(routed.assigneeId, ids.Bo, 'both were free and qualified; the better record won');
  assert.ok(routed.history.some((x) => /track record: 2\/2 bug tasks passed first time/.test(x.note)), 'and the reason is on the record');
});

test('switching self-improvement off stops retrospectives and prompt injection', async () => {
  await h.api('PATCH', '/settings', { selfImprovement: { enabled: false } });
  await idle('Alex');
  const t = await h.task({ projectId, title: 'Sloppy again', kind: 'bug', assigneeId: ids.Alex, description: '@@fake: write again.txt BROKEN; commit a; complete x; write again.txt ok; commit b; complete y; mcp get_playbook {}@@' });
  await done(t.id, 'done with learning off');
  await idle('Alex');
  const forTask = await h.api('GET', `/events?taskId=${t.id}&limit=500`);
  assert.ok(forTask.some((e: any) => e.type === 'task.verification_failed'), 'there was friction…');
  assert.ok(!forTask.some((e: any) => e.type === 'improvement.retrospective_requested'), '…but no retrospective while switched off');
  const term = await termOf('Alex');
  await waitFor(() => /Your playbook is empty so far/.test(boss.terminal(term)), { label: 'no lessons served while off' });
});
