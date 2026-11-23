/**
 * A project manager drives a job (the owner, 2026-11-23: "I tell the project manager what I need; it breaks it down,
 * uses the other agents, builds the whole thing — and approves from review itself, asking me when unsure"), in a real
 * office with real sessions (the scripted stand-in): it puts the work on the board for a colleague, the colleague does
 * it, the work waits for the manager's verdict instead of the boss's, the manager approves it, and hears it is done;
 * a second piece it is unsure of, it hands to the boss.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '@orchestrator/contracts';
import { handleMcpPost } from '@orchestrator/integrations';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let shop = '';
const ids: Record<string, string> = {};

const tool = async (who: string, name: string, args: Record<string, unknown> = {}) => {
  const eng = h.server.engine;
  const employee = eng.core.employees.require(ids[who]!);
  const session = eng.core.runningSessionOf(employee.id) ?? eng.core.sessionOf(employee.id) ?? ({ id: `none-${employee.id}`, employeeId: employee.id, hostId: employee.hostId } as any);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee, session });
  return { text: String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)), isError: res.body.result?.isError === true };
};
const byTitle = async (title: string): Promise<Task> => (await h.state()).tasks.find((t) => t.title === title)!;
const toMia = async () => (await h.state()).messages.filter((m) => m.toEmployeeId === ids.Mia && m.from.kind === 'system').map((m) => m.body);

before(async () => {
  h = await createHarness({ reviewDefault: 'boss' });
  shop = (await h.project('Shop', h.makeRepo('shop'))).id;
  ids.Mia = (await h.employee('Mia', 'pm', { projectId: shop })).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId: shop })).id;
});
after(async () => {
  await h?.cleanup();
});

test('the manager puts the work on the board, approves it in the boss\'s place, and hears it is done', async () => {
  const put = await tool('Mia', 'propose_tasks', { rationale: 'The boss asked for a banner.', tasks: [{ title: 'Add the banner', description: '@@fake: write banner.txt hi; commit banner; complete banner added@@', acceptance: 'banner.txt says hi', assignee: 'Alex', kind: 'feature' }] });
  assert.equal(put.isError, false, put.text);
  let t = await byTitle('Add the banner');
  if (!t.released) assert.equal((await tool('Mia', 'release_task', { task: t.key })).isError, false);
  t = await waitFor(async () => {
    const x = await byTitle('Add the banner');
    return x.status === 'REVIEW' ? x : null;
  }, { label: 'handed in', timeout: 40_000 });
  assert.equal(t.reviewStage, 'boss');
  assert.equal(t.approverId, ids.Mia, "the manager's to decide");
  assert.equal((await h.state()).notifications.filter((n) => n.kind === 'review' && n.taskId === t.id && !n.resolvedAt).length, 0, 'the boss is not asked');
  assert.ok((await toMia()).some((b) => new RegExp(`${t.key} .*waits for your verdict, in the boss's place`).test(b)));
  const verdict = await tool('Mia', 'submit_review', { task: t.key, verdict: 'approve', comments: 'It is what the boss asked for.', checked: 'Read the change: banner.txt holds "hi", as the acceptance says.' });
  assert.equal(verdict.isError, false, verdict.text);
  await waitFor(async () => (await byTitle('Add the banner')).status === 'DONE', { label: 'done' });
  await waitFor(async () => (await toMia()).some((b) => /"Add the banner", which you put on the board, is done \(Alex\)[\s\S]*Everything you put on the board is done/.test(b)), { label: 'the manager is told' });
});

test('not sure, the manager hands it to the boss', async () => {
  await tool('Mia', 'propose_tasks', { tasks: [{ title: 'Change the refund window', description: '@@fake: write refund.txt 30; commit refund; complete refund window changed@@', assignee: 'Alex', kind: 'feature' }] });
  let t = await byTitle('Change the refund window');
  if (!t.released) await tool('Mia', 'release_task', { task: t.key });
  t = await waitFor(async () => {
    const x = await byTitle('Change the refund window');
    return x.status === 'REVIEW' && x.approverId ? x : null;
  }, { label: 'handed in', timeout: 40_000 });
  const handed = await tool('Mia', 'escalate_review', { task: t.key, why: 'It changes what customers get back; the boss should say whether 30 days is right.' });
  assert.equal(handed.isError, false, handed.text);
  const n = (await h.state()).notifications.find((x) => x.kind === 'review' && x.taskId === t.id && !x.resolvedAt);
  assert.match(n?.body ?? '', /Mia, who manages it, asks you to decide/);
  await h.api('POST', `/tasks/${t.id}/review`, { verdict: 'approve', comments: '30 days is right.' });
  await waitFor(async () => (await byTitle('Change the refund window')).status === 'DONE', { label: 'the boss decided' });
});

test('in a project that assigns nothing by itself, what the manager puts on the board for a role is staffed and started', async () => {
  await h.api('PATCH', `/projects/${shop}`, { policy: { autoAssign: false } });
  const put = await tool('Mia', 'propose_tasks', { tasks: [{ title: 'Write the changelog entry', description: '@@fake: write CHANGES.txt banner; commit changes; complete changelog written@@', role: 'backend', kind: 'docs' }] });
  assert.match(put.text, /scheduled automatically/, put.text);
  const t = await waitFor(async () => {
    const x = await byTitle('Write the changelog entry');
    return x.status === 'REVIEW' || x.status === 'DONE' ? x : null;
  }, { label: 'staffed and handed in', timeout: 40_000 });
  assert.equal(t.assigneeId, ids.Alex);
});

test("a colleague's question about the manager's work is the manager's to answer first — through the real tools", async () => {
  const t = await h.task({ projectId: shop, title: 'Price page', assigneeId: ids.Alex, description: 'Wait for what is said on the ticket.', reviewBy: 'boss' });
  (h.server.engine.core.tasks.get(t.id) as any).createdBy = 'employee:Mia';
  await waitFor(async () => (await byTitle('Price page')).status === 'IN_PROGRESS', { label: 'Alex is on it' });
  const asking = tool('Alex', 'ask_boss', { question: 'Show prices with VAT or without?' });
  const q = await waitFor(async () => (await h.state()).questions.find((x) => /prices with VAT/.test(x.text) && x.status === 'open'), { label: 'asked' });
  assert.equal(q.managerId, ids.Mia);
  assert.equal((await h.state()).notifications.filter((n) => n.questionId === q.id).length, 0, 'not in the boss\'s Inbox');
  const answered = await tool('Mia', 'answer_team_question', { question_id: q.id, answer: 'With VAT, as on the old site.' });
  assert.equal(answered.isError, false, answered.text);
  await asking;
  const after = (await h.state()).questions.find((x) => x.id === q.id)!;
  assert.notEqual(after.status, 'open');
  assert.equal(after.answeredBy?.kind, 'manager');
});
