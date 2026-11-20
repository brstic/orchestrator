import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { notificationFor } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A task for a person of the office (the owner, 2026-11-20: "a task should be assignable to an owner or a colleague,
 * a real person, and then they get a notification in their Inbox that they have a new task"): they are told, only
 * they; the office never hands it to an employee; they move it on themselves.
 */
const link: AgentLink = { rpc: async () => ({ ok: true }) as any, isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
let eng: Engine;
let shop = '';
let ava = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const told = () => eng.core.notifications.filter((n) => n.kind === 'task_assigned');

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'box', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  shop = (await eng.tasks.createProject({ name: 'Shop' })).id;
  ava = eng.employees.create({ name: 'Ava', roleKey: 'backend', projectId: shop, hostId: 'box', workingDir: '/tmp/ava' }).id;
  eng.comms.people = () => [
    { id: 'owner', name: 'Root', owner: true },
    { id: 'g-ana', name: 'Ana', owner: false },
  ];
});

test('a task made for a colleague: assigned to her, she alone is told, and no employee ever gets it', async () => {
  const t = eng.tasks.createTask({ projectId: shop, title: 'Call the supplier', description: 'Ask about the delivery date.', personId: 'g-ana', released: true }, 'owner');
  assert.deepEqual([t.personId, t.personName, t.assigneeId], ['g-ana', 'Ana', null]);
  const n = told().at(-1)!;
  assert.equal(n.title, `A new task for you: ${t.key} Call the supplier`);
  assert.match(n.body, /assigned .* to you \(Shop\)\.\n\nAsk about the delivery date\./);
  assert.equal(n.taskId, t.id);
  assert.ok(notificationFor(n, { id: 'g-ana', owner: false }));
  assert.ok(!notificationFor(n, { id: 'owner', owner: true }), 'not even an owner sees what is for her');
  // The scheduler, with an employee free and auto-assign on, leaves it alone.
  eng.tasks.schedule();
  await sleep(eng.core.timings.scheduleDebounceMs + 50);
  const now = eng.core.tasks.require(t.id);
  assert.deepEqual([now.assigneeId, now.status], [null, 'READY']);
  // She moves it on herself: on it, then done.
  eng.tasks.updateTask(t.id, { status: 'IN_PROGRESS' }, 'member:Ana');
  eng.tasks.updateTask(t.id, { status: 'DONE' }, 'member:Ana');
  assert.equal(eng.core.tasks.require(t.id).status, 'DONE');
});

test('reassigned: from an employee to a person and back; nobody who is not in the office', () => {
  const t = eng.tasks.createTask({ projectId: shop, title: 'Write the release notes', assigneeId: ava }, 'owner');
  const before = told().length;
  eng.tasks.updateTask(t.id, { personId: 'owner' }, 'member:Ana');
  let now = eng.core.tasks.require(t.id);
  assert.deepEqual([now.personId, now.personName, now.assigneeId], ['owner', 'Root', null]);
  assert.equal(told().length, before + 1);
  assert.deepEqual(told().at(-1)!.for, ['owner']);
  eng.tasks.updateTask(t.id, { assigneeId: ava }, 'owner');
  now = eng.core.tasks.require(t.id);
  assert.deepEqual([now.personId ?? null, now.assigneeId], [null, ava]);
  assert.throws(() => eng.tasks.updateTask(t.id, { personId: 'g-gone' }, 'owner'), /not in the office/);
  assert.throws(() => eng.tasks.createTask({ projectId: shop, title: 'Both', assigneeId: ava, personId: 'g-ana' }, 'owner'), /not both/);
  // An employee's task still starts only when it is delivered.
  assert.throws(() => eng.tasks.updateTask(t.id, { status: 'IN_PROGRESS' }, 'owner'), /delivered to an employee/);
});
