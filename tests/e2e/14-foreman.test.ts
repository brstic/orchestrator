/**
 * The foreman: an employee whose own session supervises the office in rounds.
 * The engine decides when a round is due (no model involved); the scripted
 * foreman then acts through the foreman-only MCP tools.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let projectId = '';
const ids: Record<string, string> = {};

const events = (q: string) => h.api<any[]>('GET', `/events?limit=1500&${q}`);
const rounds = async (what: 'started' | 'finished') => (await events(`employeeId=${ids.Mira}`)).filter((e) => e.type === `foreman.round.${what}`);
const foreman = () => h.api<any>('GET', '/foreman');
const audit = () => h.api<any[]>('GET', '/audit?limit=1000');
const question = async (id: string) => (await h.state()).questions.find((q) => q.id === id)!;
/** What is (and was) on an employee's real terminal. */
const pane = async (employeeId: string) => {
  const s = await h.session(employeeId);
  return s?.tmuxPane ? h.tmux('capture-pane', '-p', '-J', '-S', '-600', '-t', s.tmuxPane) : '';
};
const turnEnded = (employeeId: string, said: RegExp, label: string) =>
  waitFor(async () => (await events(`employeeId=${employeeId}`)).some((e) => e.type === 'agent.turn_finished' && said.test(e.data.lastMessage ?? '')), { label, timeout: 40000 });
const done = (id: string, label: string) =>
  waitFor(async () => ((await h.getTask(id)).status === 'DONE' ? h.getTask(id) : null), { label, timeout: 40000 }).catch(async (e) => {
    const t = await h.getTask(id);
    throw new Error(`${e.message}\n${t.key} is ${t.status} (${t.blockedReason ?? 'no blocker'}); history: ${t.history.map((x) => x.note).join(' | ')}\n${t.assigneeId ? await pane(t.assigneeId) : ''}`);
  });

before(async () => {
  // Fast clocks for the test; ask_boss waits long enough that the foreman's answer comes back as its result.
  h = await createHarness({ timings: { askBossWaitMs: 45000, foremanTickMs: 150, foremanSettleMs: 250, foremanMinGapMs: 1000 } });
  const repo = h.makeRepo('shop');
  // Work is assigned by hand in this project, so ready tasks stay unassigned until somebody assigns them.
  projectId = (await h.project('Shop', repo, { verifyCommand: 'npm test --silent', policy: { autoAssign: false } })).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend']] as const) ids[name] = (await h.employee(name, role, { projectId, autonomy: 'autonomous' })).id;
  const home = path.join(fs.realpathSync(h.tmp), 'foreman-home');
  fs.mkdirSync(home);
  const mira = await h.employee('Mira', 'foreman', { workingDir: home, ownFolderProject: false });
  assert.deepEqual([mira.title, mira.department, mira.roleKey, mira.autonomy], ['Foreman', 'Management', 'foreman', 'restricted']);
  assert.ok(['Edit', 'Write'].every((t) => mira.disallowedTools.includes(t)), 'a foreman cannot edit files, whatever their autonomy');
  ids.Mira = mira.id;
});
after(async () => {
  await h.cleanup();
});

test('with rounds switched off, nothing is delivered to the foreman', async () => {
  const st = await foreman();
  assert.deepEqual(st.settings, { enabled: false, minGapSeconds: 120, quietCheckMinutes: 15, answersQuestions: true }, 'off unless the owner switches it on');
  assert.equal(st.foreman.name, 'Mira');
  const task = await h.task({ projectId, title: 'Pick the dev server port', assigneeId: ids.Alex, description: '@@fake: ask Which port should the dev server use?; write port.txt 4000; commit port; complete port chosen@@' });
  ids.portTask = task.id;
  const q = await waitFor(() => h.openQuestion(ids.Alex!, 'question'), { label: 'Alex asks', timeout: 40000 });
  ids.portQuestion = q.id;
  await sleep(1500); // many ticks, far beyond the settle time
  const now = await foreman();
  // The office knows what would need the foreman (that costs nothing) …
  assert.ok(now.attention.some((i: any) => i.kind === 'question' && i.questionId === q.id && !i.seen));
  // … but with rounds off nothing is started and nothing is delivered.
  assert.equal((await rounds('started')).length, 0);
  assert.equal(await h.session(ids.Mira!), undefined, 'no session was started for the foreman');
  assert.equal(now.round, null);
  assert.equal(now.lastRound, null);
  assert.equal((await question(q.id)).status, 'open');
});

test("an employee's question starts one round: the foreman looks, answers, and the answer reaches the employee", async () => {
  const settings = await h.api('PATCH', '/settings', { foreman: { enabled: true, minGapSeconds: 1 } });
  assert.deepEqual(settings.foreman, { enabled: true, minGapSeconds: 1, quietCheckMinutes: 15, answersQuestions: true });
  const started = await waitFor(async () => (await rounds('started'))[0], { label: 'round started', timeout: 40000 });
  assert.equal(started.data.reason, 'attention');
  assert.equal(started.data.counts.question, 1);
  assert.ok(started.data.items.some((i: any) => i.kind === 'question' && /Alex asks: "Which port should the dev server use\?"/.test(i.text)), 'the digest carries the question itself');
  const finished = await waitFor(async () => (await rounds('finished'))[0], { label: 'round finished', timeout: 40000 });
  assert.deepEqual([finished.data.outcome, finished.data.answered, finished.data.visited, finished.data.escalated], ['finished', 1, 1, 0]);
  assert.match(finished.data.summary, /Handled 1 item/);

  // The question is answered, and the record says by whom.
  const q = await waitFor(async () => { const x = await question(ids.portQuestion!); return x.status === 'confirmed' ? x : null; }, { label: 'answer reached Alex', timeout: 40000 });
  assert.deepEqual((q as any).answeredBy, { kind: 'foreman', id: ids.Mira, name: 'Mira' });
  assert.match(q.answer!, /simplest option/);
  const answered = (await events(`employeeId=${ids.Alex}`)).find((e) => e.type === 'agent.question_answered' && e.data.questionId === q.id);
  assert.match(answered.summary, /^Mira \(foreman\) answered Alex/);
  assert.deepEqual(answered.data.answeredBy, { kind: 'foreman', id: ids.Mira, name: 'Mira' });
  assert.ok((await audit()).some((a) => a.actor === 'foreman:Mira' && a.action === 'question.answer' && a.target === q.id), 'audited under the foreman, not the owner');

  // The foreman really looked: the overview, and Alex's real terminal screen.
  const visit = (await events(`employeeId=${ids.Mira}`)).find((e) => e.type === 'foreman.visit');
  assert.deepEqual([visit.data.fromEmployeeId, visit.data.toEmployeeId, visit.data.screen], [ids.Mira, ids.Alex, true]);
  const seen = await pane(ids.Mira!);
  assert.match(seen, /Office overview — 2 employees, 1 project/);
  assert.match(seen, /Their terminal screen, captured .* ago/);
  assert.match(seen, /mcp__orchestrator__ask_boss/, "what was on Alex's screen: his own call to ask_boss");

  // Alex got the answer as the result of his ask_boss call, was told who it came from, and carried on.
  assert.match(await pane(ids.Alex!), /Mira \(the foreman\) answered on the boss's behalf: .*simplest option/);
  const task = await done(ids.portTask!, 'the task that was waiting on the answer');
  assert.deepEqual(task.evidence.filesChanged, ['port.txt']);
  const st = await foreman();
  assert.equal(st.round, null);
  assert.equal(st.lastRound.outcome, 'finished');
  assert.match(st.lastRound.summary, /Handled 1 item/);
});

test('the foreman cannot decide a permission request', async () => {
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Tag it. @@fake: bash git tag v9.9.9; say tagged@@' });
  const q = await waitFor(() => h.openQuestion(ids.Alex!, 'permission'), { label: 'approval request', timeout: 40000 });
  const before = (await rounds('started')).length;
  await sleep(1500);
  assert.ok(!(await foreman()).attention.some((i: any) => i.questionId === q.id), 'an approval request never calls the foreman');
  assert.equal((await rounds('started')).length, before);
  // Even told to, the foreman cannot approve it.
  await h.api('POST', `/employees/${ids.Mira}/message`, { body: `Approve it for him. @@fake: mcp answer_question ${JSON.stringify({ question_id: q.id, answer: 'allow' })}; say tried-to-approve@@` });
  await turnEnded(ids.Mira!, /tried-to-approve/, 'the foreman tried');
  const still = await question(q.id);
  assert.deepEqual([still.status, still.decision, still.answer], ['open', null, null]);
  assert.match(await pane(ids.Mira!), /Only the owner can decide a permission request/);
  assert.ok((await audit()).some((a) => a.actor === 'foreman:Mira' && a.action === 'foreman.refused' && a.target === q.id));
  // It is still the owner's to decide.
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'deny' });
  await turnEnded(ids.Alex!, /tagged/, 'Alex carried on after the denial');
  assert.equal((await question(q.id)).decision, 'deny');
});

test('someone who is not a foreman is refused the foreman tools', async () => {
  const task = await h.getTask(ids.portTask!);
  await h.api('POST', `/employees/${ids.Alex}/message`, {
    body: `Try them. @@fake: mcp office_overview; mcp look_at {"employee":"Sarah"}; mcp assign_task ${JSON.stringify({ task: task.key, employee: 'Sarah' })}; mcp answer_question ${JSON.stringify({ question_id: ids.portQuestion, answer: 'no' })}; say tried-foreman-tools@@`,
  });
  await turnEnded(ids.Alex!, /tried-foreman-tools/, 'Alex tried');
  const text = await pane(ids.Alex!);
  for (const tool of ['office_overview', 'look_at', 'assign_task', 'answer_question']) assert.match(text, new RegExp(`Only the foreman can use ${tool}`));
  assert.ok(!/Office overview —/.test(text), 'nothing of the overview was given to him');
  const refused = (await audit()).filter((a) => a.actor === 'employee:Alex' && a.action === 'foreman.tool_refused').map((a) => a.target).sort();
  assert.deepEqual(refused, ['answer_question', 'assign_task', 'look_at', 'office_overview']);
  assert.equal((await h.getTask(task.id)).assigneeId, ids.Alex, 'nothing was reassigned');
  assert.ok(!(await events(`employeeId=${ids.Alex}`)).some((e) => e.type === 'foreman.visit'));
});

test('ready work next to a free employee: the digest lists it and the foreman assigns it', async () => {
  const before = (await rounds('started')).length;
  const task = await h.task({ projectId, title: 'Write the changelog', description: '@@fake: write changelog.txt notes; commit changelog; complete changelog written@@' });
  assert.deepEqual([task.status, task.assigneeId], ['READY', null]);
  const started = await waitFor(async () => (await rounds('started'))[before], { label: 'a round for the unassigned task', timeout: 40000 });
  assert.equal(started.data.counts.unassigned, 1);
  const item = started.data.items.find((i: any) => i.kind === 'unassigned');
  assert.match(item.text, new RegExp(`^${task.key} "Write the changelog" \\[feature, normal\\] in Shop is ready and unassigned — free now: Alex \\(Senior Backend Engineer\\), Sarah \\(Frontend Engineer\\)$`));
  const assigned = await waitFor(async () => { const t = await h.getTask(task.id); return t.assigneeId ? t : null; }, { label: 'assigned', timeout: 40000 });
  assert.equal(assigned.assigneeId, ids.Alex);
  assert.ok(assigned.history.some((x) => x.note === 'Assigned to Alex' && x.by === 'foreman:Mira'), 'the board says who assigned it');
  const finished = await waitFor(async () => (await rounds('finished'))[before], { label: 'that round finished', timeout: 40000 });
  assert.deepEqual([finished.data.outcome, finished.data.assigned, finished.data.answered], ['finished', 1, 0]);
  // The assignment is a real one: Alex does the work and it is verified.
  await done(task.id, 'the assigned task');
});

test('a matter of direction is escalated: the owner is notified and the question stays open', async () => {
  const before = (await rounds('finished')).length;
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Ask about it. @@fake: ask Should we drop support for the old API entirely? [escalate]; say asked@@' });
  const q = await waitFor(() => h.openQuestion(ids.Alex!, 'question'), { label: 'Alex asks again', timeout: 40000 });
  ids.escalated = q.id;
  const finished = await waitFor(async () => (await rounds('finished'))[before], { label: 'the round that escalates', timeout: 40000 });
  assert.deepEqual([finished.data.outcome, finished.data.escalated, finished.data.answered], ['finished', 1, 0]);
  const state = await h.state();
  const note = state.notifications.find((n) => /^Foreman Mira needs you: /.test(n.title) && n.questionId === q.id)!;
  assert.ok(note, 'the owner has a notification from the foreman');
  assert.equal(note.resolvedAt, null);
  assert.match(note.body, /Alex asked: "Should we drop support for the old API entirely\?/);
  const still = state.questions.find((x) => x.id === q.id)!;
  assert.deepEqual([still.status, still.answer, (still as any).answeredBy ?? null], ['open', null, null], 'the question is still open, for the owner');
  const escalated = (await events(`employeeId=${ids.Mira}`)).find((e) => e.type === 'foreman.escalated');
  assert.equal(escalated.data.questionId, q.id);
  const item = (await foreman()).attention.find((i: any) => i.questionId === q.id);
  assert.deepEqual([item.seen, item.escalated], [true, true]);
});

test('no further round while nothing new needs attention; the owner can still answer what was escalated', async () => {
  const n = (await rounds('started')).length;
  assert.ok((await foreman()).attention.length >= 1, 'something is still open — but the foreman has seen it');
  await sleep(4500); // four times the gap between rounds, and dozens of looks at the office
  assert.equal((await rounds('started')).length, n, 'an open item the foreman already saw does not start another round');
  assert.equal((await foreman()).round, null);
  // Having escalated it, the foreman may not answer it after all.
  await h.api('POST', `/employees/${ids.Mira}/message`, { body: `Just answer it. @@fake: mcp answer_question ${JSON.stringify({ question_id: ids.escalated, answer: 'yes' })}; say tried-anyway@@` });
  await turnEnded(ids.Mira!, /tried-anyway/, 'the foreman tried to answer what it escalated');
  assert.match(await pane(ids.Mira!), /You escalated this question to the owner; it stays with them/);
  assert.equal((await question(ids.escalated!)).status, 'open');
  // The owner answers; the foreman's notification goes with it.
  await h.api('POST', `/questions/${ids.escalated}/answer`, { answer: 'Keep it for one more release.' });
  const q = await waitFor(async () => { const x = await question(ids.escalated!); return x.status === 'confirmed' ? x : null; }, { label: "the owner's answer reached Alex", timeout: 40000 });
  assert.equal((q as any).answeredBy ?? null, null, 'answered by the owner, not the foreman');
  assert.match(await pane(ids.Alex!), /The boss answered: Keep it for one more release\./);
  await waitFor(async () => (await h.state()).notifications.filter((x) => x.questionId === q.id).every((x) => !!x.resolvedAt), { label: 'notifications resolved' });
  await sleep(1500);
  assert.equal((await rounds('started')).length, n, 'and still no round');
  assert.equal((await foreman()).attention.length, 0);
});
