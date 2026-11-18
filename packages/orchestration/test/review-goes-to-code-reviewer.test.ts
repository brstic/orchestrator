/**
 * A review goes to a code reviewer first, and only then to somebody else (the owner, 2026-11-18: "for tasks, when
 * there is a review, the code reviewers have priority, and only then somebody else"). Before, a colleague the author
 * named was asked though the team had a code reviewer, and a code reviewer of another project — or one of no project,
 * once their first review had tied them to it — was never asked: a colleague of the project reviewed instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, type AgentLink } from '../src/index.ts';

/** An engine whose hosts are "online" but run nothing: no session is ever started. */
const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

async function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host = (id: string): Host => eng.core.put('host', { id, name: id, status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true });
  host('box');
  host('other-box');
  const shop = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  const blog = await eng.tasks.createProject({ name: 'Blog', policy: { autoAssign: false } });
  eng.core.put('project', { ...shop, hostId: 'box' });
  const hire = (name: string, roleKey: string, projectId: string | null, hostId = 'box') => eng.employees.create({ name, roleKey, projectId, hostId, workingDir: '/tmp/x' });
  const alex = hire('Alex', 'backend', shop.id);
  const sarah = hire('Sarah', 'backend', shop.id);
  /** Work Alex has done on the shop, handed in for review. */
  const handedIn = (title: string, kind = 'feature'): Task => {
    const t = eng.tasks.createTask({ projectId: shop.id, title, kind: kind as Task['kind'], released: false, reviewBy: 'peer' });
    return eng.core.put('task', { ...t, assigneeId: alex.id, status: 'REVIEW', requiresReview: true, startedAt: new Date().toISOString() } as Task);
  };
  const reviewOf = (t: Task) => eng.core.tasks.find((x) => x.reviewOf === t.id);
  const tool = async (who: Employee, name: string, args: Record<string, unknown>) => {
    const session = { id: `none-${who.id}`, employeeId: who.id, hostId: who.hostId } as any;
    const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee: who, session });
    return String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body));
  };
  return { eng, shop, blog, hire, alex, sarah, handedIn, reviewOf, tool };
}

test('the team\'s code reviewer reviews it, even when the author named a colleague — and the author is told', async () => {
  const o = await office();
  const rita = o.hire('Rita', 'reviewer', o.shop.id);
  const t = o.handedIn('Checkout button');
  // Alex asks for Sarah, as the tool allows.
  const cur = o.eng.core.put('task', { ...t, status: 'IN_PROGRESS' } as Task);
  const said = await o.tool(o.alex, 'request_review', { reviewer: 'Sarah' });
  assert.match(said, /by Rita, the code reviewer.*Sarah is not asked/);
  o.eng.core.put('task', { ...o.eng.core.tasks.require(cur.id), status: 'REVIEW' } as Task);

  const reviewer = o.eng.tasks.requestReview(o.eng.core.tasks.require(t.id), 'Sarah');
  assert.equal(reviewer?.name, 'Rita');
  assert.equal(o.reviewOf(t)?.assigneeId, rita.id);
  assert.match(o.eng.core.tasks.require(t.id).history.map((h) => h.note).join('\n'), /Sarah was to review it; Rita, the code reviewer, reviews it instead/);
});

test('a code reviewer comes before an architect or a QA of the team, and a busy one before a free colleague', async () => {
  const o = await office();
  o.hire('Arto', 'architect', o.shop.id);
  o.hire('Quinn', 'qa', o.shop.id);
  const rita = o.hire('Rita', 'reviewer', o.shop.id);
  // Rita is at work on something else.
  const other = o.eng.tasks.createTask({ projectId: o.shop.id, title: 'Something of Rita', kind: 'review', released: false });
  o.eng.core.put('task', { ...other, assigneeId: rita.id, status: 'IN_PROGRESS', startedAt: new Date().toISOString() } as Task);
  assert.equal(o.eng.tasks.requestReview(o.handedIn('Cart totals'), null)?.name, 'Rita');
});

test('with no code reviewer on the team, one from elsewhere in the office is lent to the project for the review — on the project\'s machine only', async () => {
  const o = await office();
  // One on another machine could not open the shop's repository: not asked.
  o.hire('Faraway', 'reviewer', o.blog.id, 'other-box');
  const vera = o.hire('Vera', 'reviewer', o.blog.id);
  const t = o.handedIn('Order emails');
  assert.equal(o.eng.tasks.requestReview(t, null)?.name, 'Vera');
  const lent = o.eng.core.employees.require(vera.id);
  assert.equal(lent.projectId, o.blog.id, 'she keeps her own project');
  assert.ok(lent.alsoProjectIds?.includes(o.shop.id), 'and is lent to the shop');
  assert.equal(o.reviewOf(t)?.assigneeId, vera.id);
  // Once she is lent, she is the team's: the next review is hers too.
  assert.equal(o.eng.tasks.requestReview(o.handedIn('Refunds'), null)?.name, 'Vera');
});

test('one of no project reviews for every project, not only the first one they reviewed for', async () => {
  const o = await office();
  const nora = o.hire('Nora', 'reviewer', null);
  const blogWriter = o.hire('Bea', 'backend', o.blog.id);
  assert.equal(o.eng.tasks.requestReview(o.handedIn('Coupons'), null)?.name, 'Nora');
  // Her first review ties her to the shop (as anyone of no project is moved to the project of their first task).
  o.eng.core.put('employee', { ...o.eng.core.employees.require(nora.id), projectId: o.shop.id });
  const t = o.eng.tasks.createTask({ projectId: o.blog.id, title: 'RSS feed', kind: 'feature', released: false, reviewBy: 'peer' });
  const blogTask = o.eng.core.put('task', { ...t, assigneeId: blogWriter.id, status: 'REVIEW', requiresReview: true } as Task);
  assert.equal(o.eng.tasks.requestReview(blogTask, null)?.name, 'Nora');
});

test('with no code reviewer anywhere, a colleague of the team reviews it, as before; the colleague the author named still holds', async () => {
  const o = await office();
  o.hire('Bob', 'backend', o.shop.id);
  assert.ok(['Sarah', 'Bob'].includes(o.eng.tasks.requestReview(o.handedIn('Search'), null)?.name ?? ''));
  assert.equal(o.eng.tasks.requestReview(o.handedIn('Filters'), 'Bob')?.name, 'Bob');
});

test('a security task goes to the security reviewer first, then the code reviewer', async () => {
  const o = await office();
  o.hire('Rita', 'reviewer', o.shop.id);
  o.hire('Sam', 'security', o.shop.id);
  assert.equal(o.eng.tasks.requestReview(o.handedIn('Session cookies', 'security'), 'Rita')?.name, 'Rita', 'a code reviewer named for it holds');
  assert.equal(o.eng.tasks.requestReview(o.handedIn('CSRF tokens', 'security'), null)?.name, 'Sam');
});
