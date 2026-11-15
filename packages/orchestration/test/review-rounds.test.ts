/**
 * Two things that keep a review from growing into a conversation of its own: what a reviewer is asked to look for,
 * and how many times colleagues may send the same work back before it is the boss's to decide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_SEND_BACKS, type Employee, type Host, type Project, type Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, reviewPrompt, type AgentLink } from '../src/index.ts';

const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

async function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop: Project = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  const [alex, sarah, bo] = (['Alex', 'Sarah', 'Bo'] as const).map((name) => eng.employees.create({ name, roleKey: name === 'Alex' ? 'backend' : 'frontend', projectId: shop.id, hostId: host.id, workingDir: '/tmp/x' })) as [Employee, Employee, Employee];
  const t = eng.tasks.createTask({ projectId: shop.id, title: 'Round prices to cents', kind: 'research', released: false, reviewBy: 'peer' });
  /** Alex hands the task in (again), and Sarah is asked to review it. */
  const handIn = () => eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: alex.id, status: 'REVIEW', requiresReview: true, reviewBy: 'peer', reviewStage: 'peer', reviewerId: sarah.id } as Task);
  return { eng, shop, alex, sarah, bo, id: t.id, handIn, task: () => eng.core.tasks.require(t.id) };
}

test('colleagues send the same work back twice; the third time it waits for the boss instead', async () => {
  const o = await office();
  assert.equal(REVIEW_SEND_BACKS, 2);
  for (let round = 1; round <= REVIEW_SEND_BACKS; round++) {
    o.handIn();
    await o.eng.tasks.submitReview(o.sarah, o.task().key, 'request_changes', `Round ${round}: totals are off by a cent.`);
    assert.deepEqual([o.task().status, o.task().friction.reviewRejections], ['READY', round], `round ${round} goes back to its author`);
  }
  o.handIn();
  await o.eng.tasks.submitReview(o.sarah, o.task().key, 'request_changes', 'I would still name the helper differently.');
  const held = o.task();
  assert.deepEqual([held.status, held.reviewStage, held.friction.reviewRejections], ['REVIEW', 'boss', REVIEW_SEND_BACKS], 'not sent back a third time, and not counted as one');
  assert.equal(held.evidence.contested?.reviewerId, o.sarah.id);
  assert.match(held.evidence.contested!.comments, /name the helper/);
  // The boss hears it, with what was asked for.
  const note = o.eng.core.notifications.filter((n) => n.taskId === held.id && n.kind === 'review' && !n.resolvedAt).at(-1)!;
  assert.match(note.title, /needs your decision/);
  assert.match(note.body, /sent back 2 times.*Sarah still asks for changes.*name the helper/s);
  // No colleague decides it now.
  await assert.rejects(o.eng.tasks.submitReview(o.bo, held.key, 'approve', 'fine'), /waits for the boss/);
});

test('the boss settles it: approving finishes the task, sending back is theirs to do as often as they like', async () => {
  const o = await office();
  for (let round = 1; round <= REVIEW_SEND_BACKS + 1; round++) {
    o.handIn();
    await o.eng.tasks.submitReview(o.sarah, o.task().key, 'request_changes', 'Still not it.');
  }
  await o.eng.tasks.submitReview('owner', o.task().key, 'request_changes', 'Sarah is right: rename it.');
  assert.deepEqual([o.task().status, o.task().friction.reviewRejections, o.task().evidence.contested ?? null], ['READY', REVIEW_SEND_BACKS + 1, null]);

  const p = await office();
  for (let round = 1; round <= REVIEW_SEND_BACKS + 1; round++) {
    p.handIn();
    await p.eng.tasks.submitReview(p.sarah, p.task().key, 'request_changes', 'Still not it.');
  }
  await p.eng.tasks.submitReview('owner', p.task().key, 'approve', 'Good enough.');
  assert.equal(p.task().status, 'DONE');
});

test('a reviewer is asked whether the work is right, and told what is not a reason to send it back', async () => {
  const o = await office();
  const target = { ...o.handIn(), branch: 'task/shop-1', description: 'Totals must round half up.', acceptance: '' } as Task;
  const review = o.eng.tasks.createTask({ projectId: o.shop.id, title: 'Review', kind: 'review', reviewOf: target.id, requiresReview: false, released: false });
  const text = reviewPrompt(review, target, o.shop, 'Alex');
  assert.match(text, /does this diff do what the task asked/);
  assert.match(text, /Not grounds to send it back: style, naming/);
  assert.match(text, /at most three under "Not blocking:"/);
  assert.doesNotMatch(text, /maintainability/);
  assert.doesNotMatch(text, /do not run the whole check again/, 'nothing was run by the office here');
  const checked = { ...target, evidence: { ...target.evidence, verification: { ts: '', command: 'npm test', exitCode: 0, passed: true, outputTail: '', durationMs: 1, provenance: 'measured' } } } as Task;
  assert.match(reviewPrompt(review, checked, o.shop, 'Alex'), /do not run the whole check again: the office ran it/);
});
