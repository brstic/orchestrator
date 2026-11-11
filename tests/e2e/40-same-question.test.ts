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
  const lena = (await h.state()).employees.find((e) => e.id === ids.Lena)!;
  const make = () => h.server.engine.comms.createQuestion({ kind: 'decision', channel: 'mcp_tool', employee: lena, session: null, text: 'T-40, two things. (1) Is step B right?', context: '', why: '', options: [] } as any);
  const first = make();
  await sleep(20);
  const second = make();
  const other = h.server.engine.comms.createQuestion({ kind: 'decision', channel: 'mcp_tool', employee: lena, session: null, text: 'T-41: a different question', context: '', why: '', options: [] } as any);
  await h.restartServer();
  const after = Object.fromEntries((await questions('Lena')).map((q) => [q.id, q.status]));
  assert.deepEqual([after[first.id], after[second.id], after[other.id]], ['superseded', 'open', 'open']);
  // Asked once more now (the call that waited was cut off by the restart): it is the one that stayed.
  await h.task({ projectId: project, title: 'Ask it', assigneeId: ids.Lena, description: '@@fake: ask T-40, two things. (1) Is step B right?; say lena-asked@@' });
  await waitFor(async () => /lena-asked/.test(await pane('Lena')), { label: 'Lena asked again', timeout: 40000 });
  assert.equal((await questions('Lena')).filter((q) => q.status === 'open' && /T-40/.test(q.text)).length, 1);
  assert.equal((await questions('Lena')).length, 3);
});
