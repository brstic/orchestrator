/**
 * Capture, end to end with the scripted worker: a task fails verification, the retrospective is
 * delivered with the recorded facts in a structured form, the session records a lesson in the fixed
 * shape, and the next task's prompt carries it. Along the way, what costs nothing: the same failure
 * on a second task becomes proposed project knowledge, a new hire's first prompt gets the digest
 * once, and a correction in the owner's message is kept.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;
let projectId = '';
const ids: Record<string, string> = {};
const keys: Record<string, string> = {};

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
const learning = async (verb: string) => (await h.api('GET', '/events?limit=1000')).filter((e: any) => e.type === `learning.${verb}`);

before(async () => {
  h = await createHarness();
  boss = await h.client();
  projectId = (await h.project('Capture', h.makeRepo('capture'), { verifyCommand: 'npm test --silent' })).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId, autonomy: 'standard' })).id;
});
after(async () => {
  await h.cleanup();
});

test('a failed verification is reflected on with the recorded facts, and the lesson comes back in the fixed shape', async () => {
  const t = await h.task({ projectId, title: 'Sloppy work', kind: 'bug', assigneeId: ids.Alex, description: '@@fake: write sloppy.txt BROKEN; commit sloppy; complete first; write sloppy.txt fixed; commit fix; complete second@@' });
  const d = await done(t.id, 'sloppy task eventually done');
  keys.first = d.key;
  assert.equal(d.friction.failedVerifications, 1);
  const lesson = await waitFor(async () => (await h.state()).lessons.find((l) => l.employeeId === ids.Alex && l.source === 'retrospective'), { label: 'lesson recorded by the session' });
  // The rule, its trigger, and the evidence — which the session could only quote from the facts it was given:
  // the exact end of the verification output.
  assert.equal(lesson.text, "Run the project's verification command myself before calling complete_task");
  assert.equal(lesson.appliesWhen, 'before completing any task');
  assert.equal(lesson.captureWhy, 'Verification failed on this task before it passed, with "1 failing: sloppy.txt is broken"');
  assert.deepEqual([lesson.scope, lesson.status, lesson.evidence[0]!.id], ['employee', 'active', t.id]);
  assert.deepEqual([lesson.captureOrigin!.kind, lesson.captureOrigin!.taskKey], ['retrospective', d.key]);
  assert.ok(lesson.captureOrigin!.signatures!.some((s) => s.startsWith('verify|npm test --silent\n')), 'the lesson knows which friction it is about');
  const retro = (await h.api('GET', `/events?taskId=${t.id}&limit=500`)).find((e: any) => e.type === 'improvement.retrospective_requested');
  assert.deepEqual([retro.data.facts, retro.data.kinds, retro.data.revises], [2, ['attempts', 'verification'], null]);
  // One prompt for one task with friction: not more than the "friction" setting allows.
  assert.equal((await h.api('GET', '/events?limit=1000')).filter((e: any) => e.type === 'improvement.retrospective_requested').length, 1);
  await idle('Alex');
});

test("the next task's prompt contains the lesson", async () => {
  const before = (await h.state()).lessons.find((l) => l.employeeId === ids.Alex)!;
  const t = await h.task({ projectId, title: 'Next work', kind: 'bug', assigneeId: ids.Alex, description: '@@fake: saw Lessons from your own earlier work here; saw verification command myself before calling complete_task (applies before completing any task); saw What this team has learned; write next.txt ok; commit next; complete next@@' });
  await done(t.id, 'next task');
  const term = await termOf('Alex');
  await waitFor(() => /saw\[Lessons from your own earlier work here\]=yes/.test(boss.terminal(term)) && /complete_task \(applies before completing any task\)\]=yes/.test(boss.terminal(term)), { label: 'the lesson was in the delivered prompt' });
  // Alex has worked here before: no onboarding digest for him.
  assert.match(boss.terminal(term), /saw\[What this team has learned\]=no/);
  assert.ok((await h.state()).lessons.find((l) => l.id === before.id)!.appliedCount > before.appliedCount, 'inclusion in the task prompt is counted');
  // A clean task: no second retrospective.
  await idle('Alex');
  assert.equal((await h.api('GET', '/events?limit=1000')).filter((e: any) => e.type === 'improvement.retrospective_requested').length, 1);
});

test('the same failure on a second task becomes proposed project knowledge, citing both tasks', async () => {
  ids.Sarah = (await h.employee('Sarah', 'frontend', { projectId, autonomy: 'standard' })).id;
  const t = await h.task({ projectId, title: 'Sloppy too', kind: 'bug', assigneeId: ids.Sarah, description: '@@fake: write sloppy.txt BROKEN again; commit sloppy; complete first; write sloppy.txt mended; commit fix; complete second@@' });
  const d = await done(t.id, "Sarah's task eventually done");
  keys.second = d.key;
  const fact = await waitFor(async () => (await h.state()).lessons.find((l) => l.captureOrigin?.kind === 'repeat_failure'), { label: 'project knowledge proposed' });
  assert.deepEqual([fact.scope, fact.projectId, fact.status, fact.source], ['project', projectId, 'proposed', 'orchestrator']);
  assert.equal(fact.text, `"npm test --silent" fails with "1 failing: sloppy.txt is broken" when sloppy.txt changes — seen in ${keys.first}, ${keys.second}.`);
  assert.deepEqual(fact.evidence.map((e) => e.kind), ['task', 'task']);
  const captured = (await learning('captured')).find((e: any) => e.data.lessonId === fact.id);
  assert.deepEqual([captured.data.auto, captured.data.area, captured.data.undo], [true, 'capture', { lessonId: fact.id, status: 'retired' }]);
  await idle('Sarah');
});

test("a new hire's first prompt carries what the team has learned, once", async () => {
  ids.Bo = (await h.employee('Bo', 'backend', { projectId, autonomy: 'standard' })).id;
  const t = await h.task({ projectId, title: "Bo's first", kind: 'bug', assigneeId: ids.Bo, description: '@@fake: saw What this team has learned on Capture so far; saw has failed the same way on 2 tasks here; write bo1.txt ok; commit bo1; complete bo1@@' });
  await done(t.id, "Bo's first task");
  const term = await termOf('Bo');
  await waitFor(() => /saw\[What this team has learned on Capture so far\]=yes/.test(boss.terminal(term)) && /saw\[has failed the same way on 2 tasks here\]=yes/.test(boss.terminal(term)), { label: 'the digest was in the first prompt' });
  assert.equal((await learning('onboarded')).filter((e: any) => e.employeeId === ids.Bo).length, 1);
  await idle('Bo');
  const t2 = await h.task({ projectId, title: "Bo's second", kind: 'bug', assigneeId: ids.Bo, description: '@@fake: saw What this team has learned; write bo2.txt ok; commit bo2; complete bo2@@' });
  await done(t2.id, "Bo's second task");
  await waitFor(() => /saw\[What this team has learned\]=no/.test(boss.terminal(term)), { label: 'no digest the second time' });
  assert.equal((await learning('onboarded')).filter((e: any) => e.employeeId === ids.Bo).length, 1);
});

test("a correction in the owner's message is kept for that employee; a plain instruction is not", async () => {
  await idle('Alex');
  const lessons = async () => (await h.state()).lessons.filter((l) => l.captureOrigin?.kind === 'correction');
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Tell me which files you changed today.' });
  await idle('Alex');
  assert.equal((await lessons()).length, 0);
  const msg = await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'From now on, run the whole test script before you say a task is complete.' });
  const [kept] = await waitFor(async () => ((await lessons()).length ? await lessons() : null), { label: 'correction kept' });
  assert.deepEqual([kept!.text, kept!.scope, kept!.employeeId, kept!.status], ['From now on, run the whole test script before you say a task is complete.', 'employee', ids.Alex, 'active']);
  assert.deepEqual([kept!.evidence[0]!.kind, kept!.evidence[0]!.id, kept!.captureOrigin!.from, kept!.captureOrigin!.matched], ['message', msg.id, 'the boss', 'from now on']);
  await idle('Alex');
});
