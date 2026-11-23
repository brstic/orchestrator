/**
 * Autonomy (the owner, 2026-11-23: "the project manager may approve from review itself, and when it is not sure it
 * asks me"; "I tell it what I need, and it breaks it down, uses the other agents and builds the whole thing"): work a
 * Project Manager put on the board waits for its verdict in the boss's place; it may hand it to the boss; and it hears
 * when its work is done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

async function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  const mk = (name: string, roleKey: string) => eng.employees.create({ name, roleKey, projectId: shop, hostId: host.id, workingDir: '/tmp/x' }) as Employee;
  const mia = mk('Mia', 'pm');
  const alex = mk('Alex', 'backend');
  const zed = mk('Zed', 'frontend');
  /** A task Mia put on the board, handed in by Alex, nobody but the boss to review it. */
  const handedIn = (title: string, extra: Partial<Task> = {}) => {
    const t = eng.tasks.createTask({ projectId: shop, title, description: 'x', released: false, reviewBy: 'boss' }, 'employee:Mia');
    const task = eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: alex.id, authorId: alex.id, status: 'REVIEW', requiresReview: true, reviewBy: 'boss', ...extra } as Task);
    eng.tasks.requestReview(task, null);
    return () => eng.core.tasks.require(t.id);
  };
  const toldMia = () => eng.core.messages.filter((m) => m.toEmployeeId === mia.id && m.from.kind === 'system').map((m) => m.body);
  const ownerAsked = (id: string) => eng.core.notifications.filter((n) => n.kind === 'review' && n.taskId === id && !n.resolvedAt);
  return { eng, shop, mia, alex, zed, handedIn, toldMia, ownerAsked };
}

test('work the manager put on the board waits for its verdict, not the boss; nobody else may give it', async () => {
  const o = await office();
  const task = o.handedIn('Add the cart badge');
  assert.equal(task().reviewStage, 'boss');
  assert.equal(task().approverId, o.mia.id);
  assert.equal(o.ownerAsked(task().id).length, 0, 'the boss is not asked');
  assert.match(o.toldMia().at(-1)!, /waits for your verdict, in the boss's place[\s\S]*escalate_review/);
  await assert.rejects(o.eng.tasks.submitReview(o.zed, task().key, 'approve', 'fine', undefined, { checked: 'looked at it carefully' }), /waits for Mia's verdict/);
  // Its verdict is held to what any reviewer's is: code nothing tested is approved only on what was checked.
  await assert.rejects(o.eng.tasks.submitReview(o.mia, task().key, 'approve', 'Good.'), /"checked"/);
  const done = await o.eng.tasks.submitReview(o.mia, task().key, 'approve', 'Good.', undefined, { checked: 'Opened the cart on dev: the badge counts 3 items.' });
  assert.equal(done.status, 'DONE');
  assert.ok(done.history.some((h) => /in the boss's place/.test(h.note)));
});

test('not sure: the manager hands it to the boss, with why', async () => {
  const o = await office();
  const task = o.handedIn('Change the refund rules');
  assert.throws(() => o.eng.tasks.escalateReview(o.zed, task().key, 'not mine but still'), /not waiting for your verdict/);
  o.eng.tasks.escalateReview(o.mia, task().key, 'It changes what customers get back; the boss should say whether 30 days is right.');
  assert.equal(task().approverId, null);
  assert.match(task().escalated?.why ?? '', /30 days/);
  assert.match(o.ownerAsked(task().id).at(-1)!.body, /Mia, who manages it, asks you to decide: It changes what customers get back/);
  await assert.rejects(o.eng.tasks.submitReview(o.mia, task().key, 'approve', 'ok', undefined, { checked: 'read it all through' }), /waits for the boss/);
});

test("the boss's still: a release with the gate on, and with the switch off", async () => {
  const o = await office();
  o.eng.core.updateSettings({ releaseGate: { on: true, hosts: [] } } as never);
  const released = o.handedIn('Ship the cart', { release: { plan: 'Push master.' } } as Partial<Task>);
  assert.equal(released().approverId, null);
  assert.equal(o.ownerAsked(released().id).length, 1);
  o.eng.core.updateSettings({ releaseGate: { on: false }, managersApprove: false } as never);
  const off = o.handedIn('Tidy the footer');
  assert.equal(off().approverId, null);
  assert.equal(o.ownerAsked(off().id).length, 1);
});

test('the manager hears when work it put on the board is done, and what is still open', async () => {
  const o = await office();
  const a = o.eng.tasks.createTask({ projectId: o.shop, title: 'Part one', description: 'x', released: false }, 'employee:Mia');
  o.eng.tasks.createTask({ projectId: o.shop, title: 'Part two', description: 'x', released: false }, 'employee:Mia');
  o.eng.core.put('task', { ...o.eng.core.tasks.require(a.id), assigneeId: o.alex.id, evidence: { ...a.evidence, summary: 'Part one works.' } } as Task);
  o.eng.core.event({ type: 'task.completed', source: 'server', summary: `${a.key} done`, taskId: a.id, projectId: o.shop, employeeId: o.alex.id, data: { key: a.key } });
  const said = o.toldMia().at(-1)!;
  assert.match(said, /"Part one", which you put on the board, is done \(Alex\): Part one works\./);
  assert.match(said, /1 task is still open: T-\d+ \(backlog\)/);
  assert.match(said, /Take the next step/);
});
