/**
 * The office checks what it can (`docs/TASKS.md`, "The office checks what it can"), in a real office with a real
 * session (the scripted stand-in for Claude Code): in a project with no verification command, a hand-in whose changed
 * file does not parse is refused by the office itself; fixed, it goes to review with that check on record; and the
 * colleague's approval carries what they checked (an approval without it is refused: review-checked.test.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let ava: any;
let rita: any;

before(async () => {
  h = await createHarness();
  const repo = h.makeRepo('shop');
  ava = await h.api('POST', '/employees', { name: 'Ava', roleKey: 'backend', hostId: h.hostId, workingDir: repo });
  rita = await h.api('POST', '/employees', { name: 'Rita', roleKey: 'backend', hostId: h.hostId, projectId: ava.projectId, workingDir: repo });
  // (What is checked here is the office's own check with no command; one set by itself would take its place: adopt-check.test.ts.)
  await h.api('PATCH', `/projects/${ava.projectId}`, { policy: { adoptCheck: false } });
});
after(async () => {
  await h.cleanup();
});

test('no verification command: a changed file that does not parse is refused; fixed, it goes on with the check on record', async () => {
  const project = (await h.state()).projects.find((p: any) => p.id === ava.projectId)!;
  assert.equal(project.verifyCommand, null, 'the project has no command of its own');
  const task = await h.task({
    projectId: ava.projectId,
    title: 'Add the price helper',
    assigneeId: ava.id,
    reviewBy: 'peer',
    reviewerId: rita.id,
    description:
      '@@fake: write price.js const round = (x) => ; bash git add price.js && git commit -q -m "price helper"; mcp complete_task {"summary":"Price helper added.","tests_run":"none"}; write price.js export const round = (x) => Math.round(x * 100) / 100 ; bash git commit -qam "fix the helper"; mcp complete_task {"summary":"Price helper added and fixed.","tests_run":"none"}; result handed.txt@@',
  });
  const failed = await waitFor(async () => (await h.api<any[]>('GET', `/events?taskId=${task.id}&limit=200`)).find((e) => e.type === 'task.verification_failed'), { label: 'refused', timeout: 30_000 });
  assert.match(failed.summary, /a changed file does not parse/);
  assert.match(failed.data.outputTail, /price\.js does not parse/);
  const inReview = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'REVIEW' ? t : null;
  }, { label: 'handed in', timeout: 30_000 });
  const v = inReview.evidence.verification!;
  assert.equal(v.kind, 'syntax');
  assert.equal(v.passed, true);
  assert.equal(v.provenance, 'measured');
  assert.match(v.outputTail, /syntax check: 1 checked, 0 failed/);
  assert.equal(inReview.friction.failedVerifications, 1);
});

test('the colleague\'s approval carries what they checked, through the real tool', async () => {
  const t = (await h.state()).tasks.find((x: any) => x.title === 'Add the price helper')!;
  // Rita's session gets the review and answers it (the stand-in reads the diff and says so in "checked").
  const done = await waitFor(async () => {
    const x = await h.getTask(t.id);
    return x.status === 'DONE' ? x : null;
  }, { label: 'approved', timeout: 40_000 });
  assert.equal(done.evidence.review?.reviewerId, rita.id);
  assert.match(done.evidence.review?.checked ?? '', /Read the diff/);
  assert.ok(done.comments?.some((c: any) => c.kind === 'approved' && /Checked: Read the diff/.test(c.body)), 'on the ticket');
});
