/**
 * A review nobody waits for any more is closed by the office. What happened on 2026-11-13: a colleague who had not
 * been asked approved a task while the reviewer who had been asked was still reading it. After that the reviewer's
 * own ticket could not be finished — submit_review refused the late verdict, and complete_task asked for a verdict —
 * so it ended up blocked in the boss's Inbox, with nothing in it to decide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, Host, Project, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, type AgentLink } from '../src/index.ts';

/** An engine whose one host is "online" but runs nothing: no session is ever started. */
const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

interface Office {
  eng: Engine;
  shop: Project;
  alex: Employee;
  sarah: Employee;
  bo: Employee;
  /** A task Alex handed in, and the review of it that Sarah was asked for and is reading. */
  inReview: (title: string, reviewBy: 'both' | 'peer') => { target: Task; review: Task };
  tool: (who: Employee, name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  task: (id: string) => Task;
}

async function office(): Promise<Office> {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  // Work is handed over by hand here, so the scheduler starts nothing.
  const shop = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  const [alex, sarah, bo] = (['Alex', 'Sarah', 'Bo'] as const).map((name) => eng.employees.create({ name, roleKey: name === 'Alex' ? 'backend' : 'frontend', projectId: shop.id, hostId: host.id, workingDir: '/tmp/x' }));
  const inReview = (title: string, reviewBy: 'both' | 'peer') => {
    const t = eng.tasks.createTask({ projectId: shop.id, title, kind: 'research', released: false, reviewBy });
    const target = eng.core.put('task', { ...t, assigneeId: alex!.id, status: 'REVIEW', requiresReview: true, reviewBy, reviewStage: 'peer', reviewerId: sarah!.id, startedAt: new Date().toISOString() } as Task);
    const r = eng.tasks.createTask({ projectId: shop.id, title: `Review ${target.key}`, kind: 'review', reviewOf: target.id, requiresReview: false, released: false });
    const review = eng.core.put('task', { ...r, assigneeId: sarah!.id, status: 'IN_PROGRESS', startedAt: new Date().toISOString() } as Task);
    return { target, review };
  };
  const tool = async (who: Employee, name: string, args: Record<string, unknown>) => {
    const session = { id: `none-${who.id}`, employeeId: who.id, hostId: who.hostId } as any;
    const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee: who, session });
    return { text: String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)), isError: res.body.result?.isError === true };
  };
  return { eng, shop, alex: alex!, sarah: sarah!, bo: bo!, inReview, tool, task: (id) => eng.core.tasks.require(id) };
}

test('a colleague who was not asked approves first: the asked reviewer\'s ticket is closed, and they are told', async () => {
  const o = await office();
  const { target, review } = o.inReview('Compare the payment providers', 'both');
  // Bo, whom nobody asked, approves; the work goes on to the boss.
  const first = await o.tool(o.bo, 'submit_review', { task: target.key, verdict: 'approve', comments: 'Reads right to me.' });
  assert.equal(first.isError, false, first.text);
  assert.deepEqual([o.task(target.id).status, o.task(target.id).reviewStage], ['REVIEW', 'boss']);

  // Sarah's review is not needed any more: closed by the office, with why, and she hears it.
  const closed = o.task(review.id);
  assert.equal(closed.status, 'DONE');
  assert.match(closed.evidence.summary ?? '', new RegExp(`Not needed any more: ${target.key} was approved by Bo`));
  assert.match(closed.history.at(-1)!.note, /Closed by the office/);
  const told = o.eng.core.messages.filter((m) => m.toEmployeeId === o.sarah.id && m.taskId === review.id);
  assert.equal(told.length, 1);
  assert.match(told[0]!.body, new RegExp(`Your review ${review.key} is closed: ${target.key} was approved by Bo`));
  assert.match(told[0]!.body, /Nothing waits for you/);
  // She is free: the closed ticket is not her task any more.
  assert.equal(o.eng.tasks.currentTask(o.sarah.id), undefined);

  // Her verdict comes late. It is not an error and changes nothing: it is written on the ticket as a second opinion.
  const late = await o.tool(o.sarah, 'submit_review', { task: target.key, verdict: 'request_changes', comments: 'The fees table leaves out refunds.' });
  assert.equal(late.isError, false, late.text);
  assert.match(late.text, /second opinion/);
  const after = o.task(target.id);
  assert.deepEqual([after.status, after.reviewStage, after.evidence.review, after.evidence.peerReview?.reviewerId], ['REVIEW', 'boss', null, o.bo.id]);
  const said = (after.comments ?? []).at(-1)!;
  assert.deepEqual([said.from.name, said.kind], ['Sarah', 'note']);
  assert.match(said.body, /^Second opinion \(would ask for changes\).*The fees table leaves out refunds\.$/s);

  // Somebody who was never asked still cannot add a verdict in the boss's place.
  const unasked = await o.tool(o.alex, 'submit_review', { task: target.key, verdict: 'approve', comments: 'mine is fine' });
  assert.equal(unasked.isError, true);
});

test('approved for good by somebody else, sent back, or stopped: the open review is closed each time', async () => {
  const o = await office();
  // Approved, and that is all it needed: done.
  const a = o.inReview('Read up on fonts', 'peer');
  await o.eng.tasks.submitReview(o.bo, a.target.key, 'approve', 'Fine.');
  assert.deepEqual([o.task(a.target.id).status, o.task(a.review.id).status], ['DONE', 'DONE']);
  assert.match(o.task(a.review.id).evidence.summary ?? '', /was approved by Bo/);

  // The boss sends it back while the reviewer reads: nothing is left to review.
  const b = o.inReview('Read up on colours', 'both');
  await o.eng.tasks.submitReview('owner', b.target.key, 'request_changes', 'Start from the brand book.');
  assert.equal(o.task(b.review.id).status, 'DONE');
  assert.match(o.task(b.review.id).evidence.summary ?? '', /the boss sent .* back/);
  Object.assign(o.task(b.target.id), { status: 'BACKLOG', released: false });

  // A reviewer who had reported being stuck: the ticket leaves the boss's Inbox with it.
  const c = o.inReview('Read up on icons', 'both');
  o.eng.core.put('task', { ...o.task(c.review.id), status: 'BLOCKED', blockedReason: 'submit_review refuses my verdict' } as Task);
  o.eng.comms.notify({ kind: 'blocked', severity: 'warning', title: `${c.review.key} is blocked`, body: 'x', taskId: c.review.id, projectId: o.shop.id, employeeId: o.sarah.id });
  await o.eng.tasks.submitReview(o.bo, c.target.key, 'approve', '');
  assert.deepEqual([o.task(c.review.id).status, o.task(c.review.id).blockedReason], ['DONE', null]);
  assert.equal(o.eng.core.notifications.filter((n) => n.taskId === c.review.id && !n.resolvedAt).length, 0);

  // A review that had not been started is simply taken away.
  const d = o.inReview('Read up on spacing', 'both');
  o.eng.core.put('task', { ...o.task(d.review.id), status: 'READY', startedAt: null } as Task);
  await o.eng.tasks.submitReview(o.bo, d.target.key, 'approve', '');
  assert.equal(o.eng.core.tasks.get(d.review.id), undefined);
});

test('the reviewer who gave the verdict finishes their own ticket, as before', async () => {
  const o = await office();
  const { target, review } = o.inReview('Compare the hosts', 'both');
  await o.eng.tasks.submitReview(o.sarah, target.key, 'approve', 'Good.');
  // Hers is the verdict: the ticket is hers to complete.
  assert.equal(o.task(review.id).status, 'IN_PROGRESS');
  const done = await o.tool(o.sarah, 'complete_task', { summary: 'Reviewed it', no_code_changes: true });
  assert.equal(done.isError, false, done.text);
  assert.equal(o.task(review.id).status, 'DONE');
});

test('complete_task on a review does not ask for a verdict the task no longer waits for', async () => {
  const o = await office();
  const { target, review } = o.inReview('Compare the queues', 'both');
  // (As the office stood before reviews were closed for the reviewer: approved by Bo, Sarah's ticket still open.)
  o.eng.core.put('task', { ...o.task(target.id), reviewStage: 'boss', evidence: { ...o.task(target.id).evidence, peerReview: { reviewerId: o.bo.id, comments: '', ts: new Date().toISOString() } } } as Task);
  const done = await o.tool(o.sarah, 'complete_task', { summary: 'Nothing left to review', no_code_changes: true });
  assert.equal(done.isError, false, done.text);
  assert.equal(o.task(review.id).status, 'DONE');
});
