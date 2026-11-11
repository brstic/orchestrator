/**
 * Work that passes its checks after changing the checks is not taken at its word: it is flagged and goes to
 * review, and the reviewer is told what to look at first. A real server, a real host agent, real tmux and git;
 * a scripted worker.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let projectId = '';
let alex = '';

before(async () => {
  h = await createHarness();
  // No review is asked for in this project: only what the office itself notices sends work to one.
  projectId = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: 'npm test --silent', policy: { requireReview: false } })).id;
  alex = (await h.employee('Alex', 'backend', { projectId, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h?.cleanup();
});

const settled = (id: string, status: string, label: string) => waitFor(async () => ((await h.getTask(id)).status === status ? h.getTask(id) : null), { label, timeout: 60000 });

test('ordinary work that passes is done, as before', async () => {
  const t = await h.task({ projectId, title: 'Add the notes', assigneeId: alex, description: '@@fake: write notes.txt hello; commit notes; complete notes added@@' });
  const done = await settled(t.id, 'DONE', 'plain work done');
  assert.equal(done.evidence.verification!.passed, true);
  assert.equal(done.evidence.verification!.touchedChecks, undefined);
});

test('work that made its own checks pass by rewriting them goes to review, and the record says why', async () => {
  // The task breaks the product (BROKEN fails the real check) and then replaces the check with one that always passes.
  const t = await h.task({ projectId, title: 'Make the build green', assigneeId: alex, description: '@@fake: write feature.txt BROKEN; write check.js process.exit(0); commit made it green; complete all green now@@' });
  const held = await settled(t.id, 'REVIEW', 'held for review');
  assert.equal(held.evidence.verification!.passed, true, 'its (rewritten) checks did pass');
  assert.deepEqual(held.evidence.verification!.touchedChecks, ['check.js']);
  assert.equal(held.requiresReview, true);
  assert.ok(held.history.some((x) => /Verification passed, but the task changed what it is checked by: check\.js/.test(x.note)));
  assert.ok((await h.api<any[]>('GET', `/events?taskId=${t.id}&limit=200`)).some((e) => /passed its checks after changing them \(check\.js\): it goes to review/.test(e.summary)));
  // Nobody else is on the team, so it waits for the owner, who sends it back.
  await waitFor(async () => ((await h.state()).notifications.some((n) => n.kind === 'review' && n.taskId === t.id) ? true : null), { label: 'the owner asked to review' });
  await h.api('POST', `/tasks/${t.id}/review`, { verdict: 'request_changes', comments: 'The check was replaced, not satisfied. Put it back.' });
  assert.equal((await h.getTask(t.id)).status === 'DONE', false);
});

test('a task that is about the tests may change them: it is noted, not held up', async () => {
  await waitFor(async () => ((await h.session(alex))?.inTurn === false ? true : null), { label: 'Alex free', timeout: 40000 });
  // Park the task that was sent back, so the next one is handed out.
  for (const x of (await h.state()).tasks.filter((x) => x.title === 'Make the build green')) await h.api('PATCH', `/tasks/${x.id}`, { status: 'BACKLOG' });
  const t = await h.task({ projectId, title: 'Cover the cart with tests', kind: 'test', assigneeId: alex, description: '@@fake: write cart.test.js ok; commit tests; complete tests added@@' });
  const done = await settled(t.id, 'DONE', 'the test task done');
  assert.deepEqual(done.evidence.verification!.touchedChecks, ['cart.test.js']);
});

test('someone who keeps hitting the same failure is told at the third time, and the owner at the sixth', async () => {
  await waitFor(async () => ((await h.session(alex))?.inTurn === false ? true : null), { label: 'Alex free', timeout: 40000 });
  const failing = 'bash ls /no/such/folder/anywhere';
  await h.api('POST', `/employees/${alex}/message`, { body: `Try it. @@fake: ${Array(6).fill(failing).join('; ')}; say gave-up@@` });
  const note = await waitFor(async () => (await h.state()).notifications.find((n) => /Alex is going in circles/.test(n.title)) ?? null, { label: 'the owner told', timeout: 40000 });
  assert.match(note.body, /The same failure has come back 6 times[^:]*: `ls \/no\/such\/folder\/anywhere`/);
  assert.match(note.body, /They were told to change approach at the third\./);
  // What Alex was told, as a message from the office itself.
  const told = (await h.state()).messages.find((m) => m.toEmployeeId === alex && m.kind === 'system' && /has now failed 3 times/.test(m.body));
  assert.ok(told, 'the note to the employee');
  assert.match(told!.body, /Stop, read the error in full, and change the approach — or, if you cannot get past it, say so with report_blocker\./);
  assert.equal((await h.state()).notifications.filter((n) => /going in circles/.test(n.title)).length, 1, 'said once');
});
