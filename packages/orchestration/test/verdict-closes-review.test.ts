import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A reviewer's verdict finishes the reviewer's own review ticket. It was left for them to close with complete_task; on
 * the live office a reviewer gave its verdict and stopped, and its review ticket stood "in progress" for eight hours
 * with three more reviews queued behind it.
 */
test("the verdict finishes the reviewer's ticket; a complete_task after it is told so, not refused", async () => {
  const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  const mk = (name: string, roleKey: string) => eng.employees.create({ name, roleKey, projectId: shop, hostId: 'h', workingDir: '/tmp/x' }) as Employee;
  const alex = mk('Alex', 'backend');
  const rita = mk('Rita', 'reviewer');
  const t = eng.tasks.createTask({ projectId: shop, title: 'Price helper', description: 'x', released: false, reviewBy: 'peer' }, 'owner');
  eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: alex.id, authorId: alex.id, status: 'REVIEW', requiresReview: true, reviewBy: 'peer', reviewerId: rita.id, kind: 'docs' } as Task);
  const r = eng.tasks.createTask({ projectId: shop, title: `Review ${t.key}`, description: 'x', released: false }, 'orchestrator');
  eng.core.put('task', { ...eng.core.tasks.require(r.id), kind: 'review', reviewOf: t.id, assigneeId: rita.id, status: 'IN_PROGRESS', startedAt: new Date().toISOString() } as Task);
  await eng.tasks.submitReview(rita, t.key, 'approve', 'Reads well.', undefined, { checked: 'Read the helper and its two callers.' });
  const after = eng.core.tasks.require(r.id);
  assert.equal(after.status, 'DONE');
  assert.match(after.evidence.summary ?? '', /verdict/i);
  const late = await eng.tasks.completeFromAgent(rita, { summary: 'Reviewed.' });
  assert.notEqual(late.isError, true, late.text);
  assert.match(late.text, new RegExp(`${r.key}.*finished with your verdict`));
});

test('a verdict that sends the work back finishes the ticket too, and the reviewer is not told it was "not needed"', async () => {
  const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  eng.core.put('host', { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true } as Host);
  const shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  const alex = eng.employees.create({ name: 'Alex', roleKey: 'backend', projectId: shop, hostId: 'h', workingDir: '/tmp/x' }) as Employee;
  const rita = eng.employees.create({ name: 'Rita', roleKey: 'reviewer', projectId: shop, hostId: 'h', workingDir: '/tmp/x' }) as Employee;
  const t = eng.tasks.createTask({ projectId: shop, title: 'Price helper', description: 'x', released: false, reviewBy: 'peer' }, 'owner');
  eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: alex.id, authorId: alex.id, status: 'REVIEW', requiresReview: true, reviewBy: 'peer', reviewerId: rita.id, kind: 'docs' } as Task);
  const r = eng.tasks.createTask({ projectId: shop, title: `Review ${t.key}`, description: 'x', released: false }, 'orchestrator');
  eng.core.put('task', { ...eng.core.tasks.require(r.id), kind: 'review', reviewOf: t.id, assigneeId: rita.id, status: 'IN_PROGRESS', startedAt: new Date().toISOString() } as Task);
  await eng.tasks.submitReview(rita, t.key, 'request_changes', 'Round half up, not half even.');
  assert.equal(eng.core.tasks.require(r.id).status, 'DONE');
  assert.doesNotMatch(eng.core.tasks.require(r.id).evidence.summary ?? '', /Not needed/);
  assert.equal(eng.core.messages.filter((m) => m.toEmployeeId === rita.id && /not needed/i.test(m.body)).length, 0);
});
