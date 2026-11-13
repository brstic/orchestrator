/**
 * Phase 4 acceptance: several agents work on one project without overwriting
 * each other's changes and complete a verified workflow — dependencies,
 * reviews, merge conflicts, agent-to-agent requests and meetings.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;
let repo = '';
let projectId = '';
const ids: Record<string, string> = {};

const taskDone = (id: string, label: string, timeout = 25000) =>
  waitFor(async () => {
    const t = await h.getTask(id);
    return t.status === 'DONE' ? t : null;
  }, { label, timeout });
const employeeIdle = (name: string) =>
  waitFor(async () => {
    const s = await h.session(ids[name]!);
    return s && ['idle', 'task_complete', 'waiting_input'].includes(s.activity) ? s : null;
  }, { label: `${name} idle` });
const terminalOf = async (name: string) => {
  const s = (await h.session(ids[name]!))!;
  boss.send({ t: 'term.open', sessionId: s.id });
  await waitFor(() => boss.terminals.has(s.id), { label: `${name} terminal` });
  return s.id;
};

before(async () => {
  h = await createHarness();
  boss = await h.client();
  repo = h.makeRepo('shop');
  projectId = (await h.project('Shop', repo, { verifyCommand: 'npm test --silent' })).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend'], ['Mike', 'qa']] as const) {
    ids[name] = (await h.employee(name, role, { projectId, autonomy: 'standard' })).id;
  }
});
after(async () => {
  await h.cleanup();
});

test('two employees work in parallel in isolated worktrees and both results are merged', async () => {
  const a = await h.task({ projectId, title: 'Build API', assigneeId: ids.Alex, description: '@@fake: write api.txt api-v1; sleep 400; commit api; complete api built@@' });
  const b = await h.task({ projectId, title: 'Build UI', assigneeId: ids.Sarah, description: '@@fake: write ui.txt ui-v1; sleep 400; commit ui; complete ui built@@' });
  // Both really are in progress at the same moment.
  await waitFor(async () => {
    const s = await h.state();
    return s.tasks.filter((t) => (t.id === a.id || t.id === b.id) && t.status === 'IN_PROGRESS').length === 2;
  }, { label: 'both in progress simultaneously' });
  const [ta, tb] = [await taskDone(a.id, 'API done'), await taskDone(b.id, 'UI done')];
  assert.notEqual(ta.worktree, tb.worktree);
  assert.notEqual(ta.branch, tb.branch);
  // Each worktree only ever contained its own work…
  assert.ok(fs.existsSync(path.join(ta.worktree!, 'api.txt')) && !fs.existsSync(path.join(ta.worktree!, 'ui.txt')));
  assert.ok(fs.existsSync(path.join(tb.worktree!, 'ui.txt')) && !fs.existsSync(path.join(tb.worktree!, 'api.txt')));
  // …and integration has both, merged without anyone overwriting anyone.
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:api.txt'), 'api-v1');
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:ui.txt'), 'ui-v1');
  assert.equal(ta.evidence.merge!.ok && tb.evidence.merge!.ok, true);
  assert.equal(h.git(repo, 'status', '--porcelain'), '');
  ids.apiTask = a.id;
});

test('dependent tasks wait, then start from a base that contains the dependency', async () => {
  const dep = await h.task({ projectId, title: 'Add orders endpoint', assigneeId: ids.Alex, description: '@@fake: sleep 600; write orders.txt orders-v1; commit orders; complete orders@@' });
  const child = await h.task({ projectId, title: 'Test orders endpoint', kind: 'test', roleHint: 'qa', dependsOn: [dep.id], description: '@@fake: read orders.txt; write orders.test.txt covered; commit tests; complete tested@@' });
  assert.equal(child.status, 'BACKLOG', 'blocked by its dependency');
  assert.equal(child.assigneeId, null);
  await taskDone(dep.id, 'dependency done');
  const done = await taskDone(child.id, 'dependent task done');
  // It was auto-assigned by role, and its branch started from integration including the dependency.
  assert.equal(done.assigneeId, ids.Mike);
  assert.ok(fs.existsSync(path.join(done.worktree!, 'orders.txt')), 'dependency work is present in the dependent worktree');
  assert.ok((await h.state()).events.some((e) => e.type === 'task.assigned' && e.taskId === child.id && (e.data as any).by === 'scheduler'));
});

test('conflicting work is never overwritten: the merge is aborted and the owner decides', async () => {
  const one = await h.task({ projectId, title: 'Set banner (Alex)', assigneeId: ids.Alex, description: '@@fake: write banner.txt from-alex; commit banner alex; sleep 300; complete alex banner@@' });
  const two = await h.task({ projectId, title: 'Set banner (Sarah)', assigneeId: ids.Sarah, description: '@@fake: write banner.txt from-sarah; commit banner sarah; sleep 1500; complete sarah banner@@' });
  await taskDone(one.id, 'first banner merged');
  const blocked = await waitFor(async () => {
    const t = await h.getTask(two.id);
    return t.status === 'BLOCKED' ? t : null;
  }, { label: 'second banner blocked by conflict' });
  assert.equal(blocked.evidence.verification!.passed, true, 'it passed verification; only the merge conflicted');
  assert.equal(blocked.evidence.merge!.ok, false);
  assert.match(blocked.evidence.merge!.detail, /banner\.txt/);
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:banner.txt'), 'from-alex', 'integration was not overwritten');
  const integrationWt = path.join(path.dirname(repo), '.orchestrator-worktrees', 'shop', '_integration');
  assert.equal(h.git(integrationWt, 'status', '--porcelain'), '', 'the aborted merge left nothing behind');
  assert.equal(fs.readFileSync(path.join(blocked.worktree!, 'banner.txt'), 'utf8').trim(), 'from-sarah', "Sarah's work is intact");
  assert.equal((await h.state()).company.mergeConflicts, 1);

  const q = await waitFor(async () => (await h.state()).questions.find((x) => x.kind === 'merge_conflict' && x.taskId === two.id && x.status === 'open'), { label: 'merge conflict question' });
  assert.equal(q.options.length, 2);
  // The owner resolves it by hand in Sarah's worktree, then retries the merge.
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'I will resolve it myself' });
  assert.equal((await h.getTask(two.id)).status, 'BLOCKED');
  try {
    h.git(blocked.worktree!, 'merge', 'orchestrator/integration');
  } catch {
    /* conflict expected */
  }
  fs.writeFileSync(path.join(blocked.worktree!, 'banner.txt'), 'from-alex-and-sarah\n');
  h.git(blocked.worktree!, 'add', '-A');
  h.git(blocked.worktree!, 'commit', '-q', '-m', 'resolve banner conflict');
  const merged = await h.api('POST', `/tasks/${two.id}/retry-merge`, {});
  assert.equal(merged.status, 'DONE');
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:banner.txt'), 'from-alex-and-sarah');
});

test('a conflict can be handed back to its author with the details', async () => {
  const one = await h.task({ projectId, title: 'Footer (Alex)', assigneeId: ids.Alex, description: '@@fake: write footer.txt alex; commit footer alex; complete footer@@' });
  const two = await h.task({
    projectId,
    title: 'Footer (Sarah)',
    assigneeId: ids.Sarah,
    description: '@@fake: write footer.txt sarah; commit footer sarah; sleep 1500; complete footer@@ @@fake-retry: bash git merge orchestrator/integration || true; write footer.txt alex+sarah; commit merge footer; complete footer resolved@@',
  });
  await taskDone(one.id, 'first footer merged');
  const q = await waitFor(async () => (await h.state()).questions.find((x) => x.kind === 'merge_conflict' && x.taskId === two.id && x.status === 'open'), { label: 'conflict question' });
  await h.api('POST', `/questions/${q.id}/answer`, { answer: q.options[0]!.label });
  const done = await taskDone(two.id, 'author resolved the conflict');
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:footer.txt'), 'alex+sarah');
  assert.ok(done.history.some((x) => /resolve the merge conflict/.test(x.note)));
  const term = await terminalOf('Sarah');
  await waitFor(() => /pasted \d+ chars/.test(boss.terminal(term)), { label: 'conflict feedback was delivered to her terminal' });
});

test('review workflow: changes requested, fixed, approved by a reviewing employee', async () => {
  ids.Rev = (await h.employee('Rev', 'reviewer', { projectId })).id;
  const task = await h.task({
    projectId,
    title: 'Add search',
    assigneeId: ids.Alex,
    requiresReview: true,
    description: '@@fake: write search.txt NEEDS-WORK draft; commit search draft; complete search@@ @@fake-retry: write search.txt polished; commit search polished; complete search fixed@@',
  });
  const reviewTask = await waitFor(async () => (await h.state()).tasks.find((t) => t.reviewOf === task.id), { label: 'review task created' });
  assert.equal(reviewTask.assigneeId, ids.Rev);
  assert.equal(reviewTask.kind, 'review');
  // First verdict: changes requested → back to Alex with the comments; nothing merged yet.
  await waitFor(async () => (await h.state()).events.some((e) => e.type === 'task.review_completed' && e.taskId === task.id && (e.data as any).verdict === 'changes_requested'), { label: 'changes requested', timeout: 25000 });
  assert.throws(() => h.git(repo, 'show', 'orchestrator/integration:search.txt'), 'unapproved work is not merged');
  const done = await taskDone(task.id, 'approved after fixes', 40000);
  assert.equal(done.evidence.review!.verdict, 'approved');
  assert.equal(done.evidence.review!.reviewerId, ids.Rev);
  assert.equal(done.attempts, 1);
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:search.txt'), 'polished');
  // The reviewer closes their own review task right after submitting the verdict.
  const state = await waitFor(async () => {
    const st = await h.state();
    return st.tasks.filter((t) => t.reviewOf === task.id).every((t) => t.status === 'DONE') ? st : null;
  }, { label: 'review tasks closed' });
  assert.equal(state.tasks.filter((t) => t.reviewOf === task.id).length, 2, 'one review per round');
  const rev = state.employees.find((e) => e.id === ids.Rev)!;
  assert.equal(rev.stats.reviewsCompleted, 2);
  const alex = state.employees.find((e) => e.id === ids.Alex)!;
  assert.ok(alex.stats.deliverablesAccepted >= 1);
});

test('the owner can review when asked to', async () => {
  const task = await h.task({ projectId, title: 'Add export', assigneeId: ids.Sarah, requiresReview: true, reviewerId: null, description: '@@fake: write export.txt csv; commit export; complete export@@' });
  await waitFor(async () => (await h.getTask(task.id)).status === 'REVIEW', { label: 'waiting for review' });
  // An employee review was queued for Rev; the owner steps in first.
  const view = await h.api('GET', `/tasks/${task.id}/git`);
  assert.match(view.diff.diff, /\+csv/);
  assert.deepEqual(view.diff.files, ['export.txt']);
  const res = await h.api('POST', `/tasks/${task.id}/review`, { verdict: 'approve', comments: 'Fine.' });
  assert.equal(res.status, 'DONE');
  assert.equal(res.evidence.review.by, 'owner');
});

test('an employee asks a teammate for something through Orchestrator and gets a real answer', async () => {
  await employeeIdle('Alex');
  await employeeIdle('Sarah');
  const task = await h.task({ projectId, title: 'Permissions UI', assigneeId: ids.Sarah, description: '@@fake: mcp request_collaboration {"to":"backend","summary":"Need an endpoint exposing the current user\'s permissions","detail":"The UI must hide admin actions."}; write perms.txt ui; commit perms ui; complete perms ui@@' });
  const collab = await waitFor(async () => (await h.state()).collabs.find((c) => c.fromEmployeeId === ids.Sarah && c.status !== 'open'), { label: 'request answered by the backend engineer', timeout: 25000 });
  assert.equal(collab.toEmployeeId, ids.Alex, 'routed by role to the backend engineer');
  assert.match(collab.response!, /GET \/api\/permissions/);
  const state = await h.state();
  const types = state.events.filter((e) => e.correlationId === collab.id).map((e) => e.type);
  assert.ok(types.includes('agent.collaboration_requested') && types.includes('agent.collaboration_resolved'));
  // Both directions were delivered into real sessions.
  const toAlex = state.messages.find((m) => m.threadId === collab.id && m.toEmployeeId === ids.Alex)!;
  assert.equal(toAlex.kind, 'collab_request');
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === toAlex.id)!.delivery.status === 'confirmed', { label: 'request delivered to Alex' });
  await waitFor(async () => (await h.state()).messages.some((m) => m.toEmployeeId === ids.Sarah && m.threadId === collab.id && /will handle it as part of their current task/.test(m.body) && m.delivery.status === 'confirmed'), { label: 'answer delivered back to Sarah, in the same thread as the request' });
  await taskDone(task.id, 'Sarah finished');
});

test('a request that needs prioritising goes to the owner, whose decision creates real work', async () => {
  await employeeIdle('Alex');
  await employeeIdle('Sarah');
  await h.api('POST', `/employees/${ids.Sarah}/message`, { body: '@@fake: mcp request_collaboration {"to":"Alex","summary":"[decision] Rate limiting on the API","detail":"Needed before launch."}@@' });
  const q = await waitFor(async () => (await h.state()).questions.find((x) => x.kind === 'priority' && x.status === 'open'), { label: 'priority question', timeout: 25000 });
  assert.equal(q.channel, 'system');
  assert.match(q.text, /Rate limiting on the API/);
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Do it next' });
  const created = await waitFor(async () => (await h.state()).tasks.find((t) => /Rate limiting on the API/.test(t.title)), { label: 'task from decision' });
  assert.equal(created.assigneeId, ids.Alex);
  assert.equal(created.priority, 'high');
  await waitFor(async () => (await h.state()).messages.some((m) => m.toEmployeeId === ids.Sarah && /is now a task for Alex/.test(m.body)), { label: 'requester informed' });
  await h.api('PATCH', `/tasks/${created.id}`, { status: 'BACKLOG' }).catch(() => undefined);
});

test('a meeting is a real workflow: every contribution comes from a participant session', async () => {
  for (const n of ['Alex', 'Sarah', 'Mike']) await employeeIdle(n);
  ids.Zed = (await h.employee('Zed', 'docs', { projectId })).id; // never started: has no session
  const meeting = await h.api('POST', '/meetings', { topic: 'Architecture review for the payment integration', projectId, participantIds: [ids.Alex, ids.Sarah, ids.Mike, ids.Zed], context: 'Decide the module boundary.' });
  assert.deepEqual(meeting.absent, [ids.Zed], 'someone without a session is recorded as absent, not simulated');
  const done = await waitFor(async () => {
    const m = (await h.state()).meetings.find((x) => x.id === meeting.id)!;
    return m.status === 'concluded' ? m : null;
  }, { label: 'meeting concluded', timeout: 40000 });
  const by = (round: string) => done.contributions.filter((c) => c.round === round).map((c) => c.employeeId).sort();
  const present = [ids.Alex, ids.Sarah, ids.Mike].sort();
  assert.deepEqual(by('proposal'), present);
  assert.deepEqual(by('response'), present);
  assert.equal(by('synthesis').length, 1);
  assert.match(done.decisionDoc!, /## Decision\nAdopt the HTTP boundary/);
  assert.match(done.decisionDoc!, /Did not take part: Zed/);
  assert.match(done.decisionDoc!, /## Recorded disagreements/);
  assert.match(done.decisionDoc!, /prefers smaller pull requests/);
  // It produced real artifacts: a decision document and a task on the board.
  const state = await h.state();
  assert.ok(state.artifacts.some((a) => a.kind === 'decision_doc' && a.meetingId === meeting.id));
  assert.equal(done.generatedTaskIds.length, 1);
  const follow = state.tasks.find((t) => t.id === done.generatedTaskIds[0])!;
  assert.equal(follow.title, 'Document the HTTP boundary');
  assert.equal(follow.roleHint, 'docs');
  const rounds = state.events.filter((e) => e.correlationId === meeting.id).map((e) => e.type);
  assert.ok(rounds.filter((t) => t === 'meeting.contribution').length >= 6);
});

test('a project that asks for one at a time: the second task for the folder waits its turn, and starts when the folder is free', async () => {
  const plain = path.join(fs.realpathSync(h.tmp), 'plain-dir');
  fs.mkdirSync(plain);
  const p2 = await h.project('Scratch', plain, { verifyCommand: null, policy: { oneAtATime: true } });
  const e1 = await h.employee('Uma', 'fullstack', { projectId: p2.id, autonomy: 'standard' });
  const e2 = await h.employee('Vic', 'fullstack', { projectId: p2.id, autonomy: 'standard' });
  const t1 = await h.task({ projectId: p2.id, title: 'First writer', assigneeId: e1.id, description: '@@fake: write a.txt one; sleep 2500; say still here@@' });
  await waitFor(async () => (await h.getTask(t1.id)).status === 'IN_PROGRESS', { label: 'first writer started' });
  const t2 = await h.task({ projectId: p2.id, title: 'Second writer', assigneeId: e2.id, description: '@@fake: write b.txt two; complete-nocode second done@@' });
  // It is not blocked and nobody is told there is a problem: it waits, and says for whom.
  const waiting = await waitFor(async () => {
    const t = await h.getTask(t2.id);
    return t.progress.note ? t : null;
  }, { label: 'second writer waiting' });
  assert.equal(waiting.status, 'READY');
  assert.match(waiting.progress.note!, new RegExp(`^Waiting for Uma to finish ${t1.key}: they work in the same folder \\(.*plain-dir\\), one at a time$`));
  assert.equal(waiting.blockedReason ?? null, null);
  assert.equal(await h.session(e2.id), undefined, 'no session is started for a task that waits');
  assert.equal((await h.state()).notifications.some((n) => n.kind === 'blocked' && n.taskId === t2.id), false, 'nothing is reported as blocked');
  assert.equal(waiting.history.filter((x) => /^Waiting for Uma/.test(x.note)).length, 1, 'said once, however often the scheduler looks');
  // The first one finishes: the second is handed over by itself.
  await waitFor(async () => (await h.session(e1.id))?.inTurn === false, { label: 'Uma between turns', timeout: 20000 });
  await h.api('POST', `/employees/${e1.id}/message`, { body: 'Wrap it up. @@fake: complete-nocode first done@@' });
  await waitFor(async () => (await h.getTask(t1.id)).status === 'DONE', { label: 'first writer done', timeout: 30000 });
  await waitFor(async () => ['IN_PROGRESS', 'DONE'].includes((await h.getTask(t2.id)).status), { label: 'second writer started by itself', timeout: 30000 });
  assert.ok(await h.session(e2.id), 'now Vic has a session');
});
