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

test("a release: the manager's when it is low-risk — and its approval lets the author release; the boss's when it touches what is risky, and with the switch off", async () => {
  const o = await office();
  o.eng.core.updateSettings({ releaseGate: { on: true, hosts: [] } } as never);
  // (18 of 19 reviews in four days went to the boss: nearly every ticket has a release plan. The owner, 2026-11-27:
  // the manager approves low-risk releases.)
  const plain = o.handedIn('Ship the cart badge', { release: { plan: 'Push master; pull on the app server. No SQL, no cron, no switch.' } } as Partial<Task>);
  assert.equal(plain().approverId, o.mia.id);
  assert.equal(o.ownerAsked(plain().id).length, 0);
  await o.eng.tasks.submitReview(o.mia, plain().key, 'approve', 'Good.', undefined, { checked: 'Opened the cart on dev: the badge counts 3.' });
  assert.equal(plain().status, 'DONE');
  assert.equal(o.eng.release.decide(o.alex, 'git push origin master', 'it pushes to master').allow, true, "the manager's approval opens the release for the author");
  o.eng.release.close({ employeeId: o.alex.id }, 'test');
  for (const [title, plan, why] of [
    ['Add the orders column', 'Run the migration (ALTER TABLE orders ADD paid_at), then push master.', /database/],
    ['Charge in EUR', 'Push master; Stripe prices switch to EUR.', /payments/],
    ['Publish 2.0.1', 'Commit to SVN trunk and tag 2.0.1 on WordPress.org.', /public/],
    ['Fix the stored XSS', 'Push master: the CVE fix.', /security/],
    ['New vhost', 'Reload nginx on the app server with the new vhost.', /server/],
  ] as const) {
    const t = o.handedIn(title, { release: { plan } } as Partial<Task>);
    assert.equal(t().approverId, null, title);
    assert.match(o.ownerAsked(t().id).at(-1)!.body, why, title);
  }
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

test("what a project manager puts on the board starts at once; another employee's proposal still waits to be released", async () => {
  const o = await office();
  const { created } = o.eng.tasks.propose(o.mia, o.shop, [{ title: 'Build the API', description: 'x', assignee: 'Alex' }], 'The boss asked for an API.', 'planning');
  assert.equal(created[0]!.released, true);
  const theirs = o.eng.tasks.propose(o.zed, o.shop, [{ title: 'Refactor the footer', description: 'x' }], undefined, 'planning').created;
  assert.equal(theirs[0]!.released, false, 'the project does not assign by itself: the boss releases it');
});

test("a colleague's question about the manager's work goes to the manager first; it answers, or passes it to the boss", async () => {
  const o = await office();
  const t = o.eng.tasks.createTask({ projectId: o.shop, title: 'Price page', description: 'x', assigneeId: o.alex.id, released: false }, 'employee:Mia');
  const ask = (text: string, kind: 'decision' | 'deployment' = 'decision') => o.eng.comms.createQuestion({ kind, channel: 'mcp_tool', employee: o.alex, session: null, text, taskId: t.id });
  const ownerTold = (qid: string) => o.eng.core.notifications.filter((n) => n.questionId === qid).length;

  const q1 = ask('Show prices with VAT or without?');
  assert.equal(q1.managerId, o.mia.id);
  assert.equal(ownerTold(q1.id), 0, 'the boss is not asked');
  assert.match(o.toldMia().at(-1)!, new RegExp(`Alex asks about ${t.key}[\\s\\S]*Show prices with VAT[\\s\\S]*answer_team_question \\(question_id "${q1.id}"\\)[\\s\\S]*escalate_question`));
  await assert.rejects(o.eng.comms.answerAsManager(o.zed, q1.id, { answer: 'with' }), /not waiting for your answer/);
  const answered = await o.eng.comms.answerAsManager(o.mia, q1.id, { answer: 'With VAT, as on the old site.' });
  assert.equal(answered.status === 'open', false);
  assert.deepEqual(answered.answeredBy, { kind: 'manager', id: o.mia.id, name: 'Mia' });

  const q2 = ask('May I drop the old coupons table?');
  o.eng.comms.escalateQuestion(o.mia, q2.id, 'Dropping a table cannot be undone; that is the boss\'s call.');
  assert.equal(o.eng.core.questions.get(q2.id)!.managerId, null);
  assert.match(o.eng.core.notifications.find((n) => n.questionId === q2.id)!.body, /Mia passes it to you: Dropping a table cannot be undone/);

  const q3 = ask('Pull it on production now?', 'deployment');
  assert.equal(q3.managerId ?? null, null, 'a deployment is the boss\'s');
  assert.equal(ownerTold(q3.id), 1);
});

test("@boss on work the manager runs is the manager's to read first (102 of 117 tags of the boss in a week were on a manager's tickets); the manager's own tag reaches the boss", async () => {
  const o = await office();
  const t = o.eng.tasks.createTask({ projectId: o.shop, title: 'Checkout page', description: 'x', assigneeId: o.alex.id, released: false }, 'employee:Mia');
  o.eng.core.put('task', { ...o.eng.core.tasks.require(t.id), status: 'IN_PROGRESS' } as Task);
  const session = (e: Employee) => ({ id: `s-${e.id}`, employeeId: e.id, hostId: 'host-1' }) as any;
  const tags = () => o.eng.core.notifications.filter((n) => n.kind === 'mention' && n.taskId === t.id);
  const r = await o.eng.talk.byEmployee(o.alex, session(o.alex), { task: t.key, text: '@boss The checkout works on dev; the coupon field is next.' });
  assert.equal(tags().length, 0, 'the boss is not told');
  assert.match(r.text, /Mia/);
  assert.match(o.eng.core.messages.filter((m) => m.toEmployeeId === o.mia.id).at(-1)!.body, /tagged the boss on T-\d+[\s\S]*coupon field[\s\S]*@boss yourself/);
  await o.eng.talk.byEmployee(o.mia, session(o.mia), { task: t.key, text: '@boss Coupons: percent or fixed amount? The ticket does not say.' });
  assert.equal(tags().length, 1, "the manager's tag reaches the boss");
  // In review with the manager deciding: the author talks it over with the manager, not the boss.
  o.eng.core.put('task', { ...o.eng.core.tasks.require(t.id), status: 'REVIEW', reviewStage: 'boss', approverId: o.mia.id } as Task);
  await o.eng.talk.byEmployee(o.alex, session(o.alex), { task: t.key, text: 'Added the screenshot of the empty cart.' });
  assert.equal(tags().length, 1);
  assert.match(o.eng.core.messages.filter((m) => m.toEmployeeId === o.mia.id).at(-1)!.body, /empty cart/);
});

test("a blocker on the manager's work is the manager's to clear first: the boss's Inbox does not get it", async () => {
  const o = await office();
  const t = o.eng.tasks.createTask({ projectId: o.shop, title: 'Stock sync', description: 'x', assigneeId: o.alex.id, released: false }, 'employee:Mia');
  o.eng.core.put('task', { ...o.eng.core.tasks.require(t.id), status: 'IN_PROGRESS' } as Task);
  o.eng.tasks.blockFromAgent(o.alex, 'The supplier API needs a key nobody has given me.', 'an API key for the supplier');
  assert.equal(o.eng.core.notifications.filter((n) => n.kind === 'blocked' && n.taskId === t.id).length, 0, 'not in the boss\'s Inbox');
  assert.ok(o.toldMia().some((b) => /Stock sync[\s\S]*blocked/i.test(b)), 'the manager is told');
  // Work nobody manages: the boss, as before.
  const own = o.eng.tasks.createTask({ projectId: o.shop, title: 'Footer', description: 'x', assigneeId: o.zed.id, released: false }, 'owner');
  o.eng.core.put('task', { ...o.eng.core.tasks.require(own.id), status: 'IN_PROGRESS' } as Task);
  o.eng.tasks.blockFromAgent(o.zed, 'No design for the footer.', undefined);
  assert.equal(o.eng.core.notifications.filter((n) => n.kind === 'blocked' && n.taskId === own.id).length, 1);
});

test("work a manager runs is reported by the manager: no \"completed\" line for each of its tickets (34 a week, beside the manager's own reports)", async () => {
  const o = await office();
  const task = o.handedIn('Cart icon');
  await o.eng.tasks.submitReview(o.mia, task().key, 'approve', 'Good.', undefined, { checked: 'Opened the cart on dev: the icon shows.' });
  assert.equal(task().status, 'DONE');
  assert.equal(o.eng.core.notifications.filter((n) => n.kind === 'task_completed' && n.taskId === task().id).length, 0);
  assert.ok(o.toldMia().some((b) => /Cart icon[\s\S]*is done/.test(b)), 'the manager hears it, and reports to the boss');
});
