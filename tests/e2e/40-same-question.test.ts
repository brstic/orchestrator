/**
 * The same question asked twice is one question.
 *
 * An employee asks the boss and waits inside that call. When the call is cut off — the office restarted (every
 * deploy), a connection dropped — the employee asks again, in the same words. The boss used to find two identical
 * questions in the Inbox, and answering one left the other open. (Three of fifteen questions in the live office on
 * 2026-11-11, each right after a deploy.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let project = '';
const ids: Record<string, string> = {};
const questions = async (name: string) => (await h.state()).questions.filter((q) => q.employeeId === ids[name]);
const pane = async (name: string) => h.tmux('capture-pane', '-p', '-J', '-S', '-120', '-t', (await h.session(ids[name]!))!.tmuxPane!).replace(/\s+/g, ' ');

before(async () => {
  // A call to the boss gives up waiting after a second and a half (four minutes in a real office).
  h = await createHarness({ timings: { askBossWaitMs: 1500 } });
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  for (const name of ['Dana', 'Omar', 'Lena']) ids[name] = (await h.employee(name, 'backend', { projectId: project })).id;
});
after(async () => {
  await h?.cleanup();
});

test('asked again in the same words while it still waits: the boss has one question, and its answer reaches the employee once', async () => {
  await h.task({ projectId: project, title: 'Pick a database', assigneeId: ids.Dana, description: '@@fake: ask Which database should the shop use?; ask Which   database should the shop use? ; say dana-asked-twice; ask Which cache then?; say dana-asked-another@@' });
  await waitFor(async () => /dana-asked-another/.test(await pane('Dana')), { label: 'Dana asked three times', timeout: 40000 });
  const asked = await questions('Dana');
  assert.deepEqual(asked.map((q) => [q.text, q.status]).sort(), [['Which cache then?', 'open'], ['Which database should the shop use?', 'open']], 'two questions, not three: a different question is a different one');
  assert.equal((await h.state()).notifications.filter((n) => n.employeeId === ids.Dana && n.kind === 'question').length, 2, 'and the boss was told once about each');
  const db = asked.find((q) => /database/.test(q.text))!;
  await h.api('POST', `/questions/${db.id}/answer`, { answer: 'Postgres.' });
  await waitFor(async () => ['delivered', 'confirmed'].includes((await questions('Dana')).find((q) => q.id === db.id)!.status), { label: 'the answer was handed over', timeout: 20000 });
  assert.equal((await questions('Dana')).length, 2);
});

test('asked again after the answer was given but before it was handed over: the tool returns the answer, and it is not typed in a second time', async () => {
  await h.task({ projectId: project, title: 'Pick a queue', assigneeId: ids.Omar, description: '@@fake: ask Which queue?; say omar-first-ask-over; sleep 4000; ask Which queue?; say omar-second-ask-over; sleep 1500; say omar-turn-ends@@' });
  await waitFor(async () => /omar-first-ask-over/.test(await pane('Omar')), { label: 'the first call gave up waiting', timeout: 30000 });
  const q = (await questions('Omar'))[0]!;
  // Omar is in the middle of his turn: the answer waits to be handed over between turns.
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Redis streams.' });
  assert.equal((await questions('Omar'))[0]!.status, 'answered');
  await waitFor(async () => /omar-second-ask-over/.test(await pane('Omar')), { label: 'the second call came back', timeout: 20000 });
  const now = (await questions('Omar'));
  assert.deepEqual(now.map((x) => x.id), [q.id], 'still one question');
  assert.match(`${now[0]!.status}: ${now[0]!.deliveryDetail}`, /^(delivered: Returned as the result of the ask_boss tool call|confirmed: The tool result reached the agent)$/);
  await waitFor(async () => /omar-turn-ends/.test(await pane('Omar')) && (await h.session(ids.Omar!))?.inTurn === false, { label: 'the turn ended', timeout: 20000 });
  await sleep(1500);
  assert.doesNotMatch((await pane('Omar')).split('omar-turn-ends').pop()!, /Redis streams|pasted \d+ chars/, 'the answer is not handed over a second time as a message');
});

test('two identical questions left open from before are one after the office starts; the later one stays', async () => {
  // Lena is on a task and has asked the same thing twice (as an office from before this fix let her).
  const task = await h.task({ projectId: project, title: 'Ask it', assigneeId: ids.Lena, description: '@@fake: say lena-started; sleep 6000; ask T-40, two things. (1) Is step B right?; say lena-asked@@' });
  await waitFor(async () => /lena-started/.test(await pane('Lena')), { label: 'Lena is at work', timeout: 30000 });
  const lena = (await h.state()).employees.find((e) => e.id === ids.Lena)!;
  const make = (text: string) => h.server.engine.comms.createQuestion({ kind: 'decision', channel: 'mcp_tool', employee: lena, session: null, text, context: '', why: '', options: [] } as any);
  const first = make('T-40, two things. (1) Is step B right?');
  await sleep(20);
  const second = make('T-40, two things. (1) Is step B right?');
  const other = make('T-41: a different question');
  assert.equal(second.taskId, task.id);
  await h.restartServer();
  const after = Object.fromEntries((await questions('Lena')).map((q) => [q.id, q.status]));
  assert.deepEqual([after[first.id], after[second.id], after[other.id]], ['superseded', 'open', 'open']);
  // Asked once more now (the call that waited was cut off by the restart): it is the one that stayed.
  await waitFor(async () => /lena-asked/.test(await pane('Lena')), { label: 'Lena asked again', timeout: 40000 });
  assert.equal((await questions('Lena')).filter((q) => q.status === 'open' && /T-40/.test(q.text)).length, 1);
  assert.equal((await questions('Lena')).length, 3);
});

test('a call that was cut off is still counted as waiting when the employee asks again: the call that is listening gets the answer', async () => {
  ids.Ivo = (await h.employee('Ivo', 'backend', { projectId: project })).id;
  const task = await h.task({ projectId: project, title: 'Pick a port', assigneeId: ids.Ivo, description: '@@fake: say ivo-started; sleep 1200; ask Which port for the dev server?; result got.txt; say ivo-done@@' });
  await waitFor(async () => /ivo-started/.test(await pane('Ivo')), { label: 'Ivo is at work', timeout: 30000 });
  // The first call, as the office still holds it after its caller hung up without saying so: a question, and
  // somebody waiting on it who will mark the answer as returned and tell nobody.
  const comms = h.server.engine.comms;
  const ivo = (await h.state()).employees.find((e) => e.id === ids.Ivo)!;
  const first = comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: ivo, session: null, text: 'Which port for the dev server?', context: '', why: '', options: [] } as any);
  assert.equal(first.taskId, task.id);
  void comms.waitForAnswer(first.id, 60000).then((a) => a && comms.answerReturnedByTool(first.id));
  // The same words about another task are another question; about this one, this one.
  assert.equal(comms.sameQuestion(ids.Ivo!, 'Which port  for the dev server?', 'some-other-task'), undefined);
  assert.equal(comms.sameQuestion(ids.Ivo!, 'Which port  for the dev server?', task.id)?.id, first.id);
  // Ivo asks again and waits; the boss answers while he does.
  // (Two are waiting on the one question now: the call that was cut off, and Ivo's.)
  await waitFor(() => (comms as unknown as { waiters: Map<string, Set<unknown>> }).waiters.get(first.id)?.size === 2, { label: 'Ivo waits on the same question', timeout: 15000, interval: 20 });
  await h.api('POST', `/questions/${first.id}/answer`, { answer: 'Port 5173.' });
  await waitFor(async () => /ivo-done/.test(await pane('Ivo')), { label: 'Ivo went on', timeout: 20000 });
  const got = fs.readFileSync(path.join((await h.getTask(task.id)).worktree!, 'got.txt'), 'utf8');
  assert.match(got, /Port 5173\./, 'the call that was listening was given the answer');
  assert.doesNotMatch(got, /has not answered yet/);
  assert.equal((await questions('Ivo')).length, 1);
});

test('a call whose caller hangs up stops waiting', async () => {
  const comms = h.server.engine.comms;
  const lena = (await h.state()).employees.find((e) => e.id === ids.Lena)!;
  const q = comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: lena, session: null, text: 'Asked by a call that is cut off', context: '', why: '', options: [] } as any);
  const cut = new AbortController();
  const waiting = comms.waitForAnswer(q.id, 60000, cut.signal);
  assert.equal(comms.hasWaiter(q.id), true);
  cut.abort();
  assert.equal(await waiting, null);
  assert.equal(comms.hasWaiter(q.id), false);
});
