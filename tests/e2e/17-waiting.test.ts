/**
 * Waiting for a colleague, end to end: a real server, a real host agent, real tmux sessions, two scripted workers.
 *
 *   ask and wait     one asks the other with wait=true; the tool call stays open; the other (who had no session and
 *                    is started for it) answers; the first gets the answer as the result of its call and goes on
 *   wait for a task  one waits until a task the other has is DONE, and is told at once when it already is
 *   the bound        the call returns "not yet"; the wait stands and is shown; the late answer comes as a message
 *   a restart        the held call is cut; the wait is on record; `wait_for_colleague` with no arguments picks it up
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CollabRequest } from '@orchestrator/contracts';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness; // a wait is long enough for the colleague to get there
let q: Harness; // a wait is two and a half seconds
const ids: Record<string, string> = {};
let projectId = '';

const events = (o: Harness, query: string) => o.api<any[]>('GET', `/events?limit=1500&${query}`);
const pane = async (o: Harness, employeeId: string) => {
  const s = await o.session(employeeId);
  return s?.tmuxPane && s.status === 'running' ? o.tmux('capture-pane', '-p', '-J', '-S', '-600', '-t', s.tmuxPane) : '';
};
const taskDone = (o: Harness, id: string, label: string) =>
  waitFor(async () => {
    const t = await o.getTask(id);
    return t.status === 'DONE' ? t : null;
  }, { label, timeout: 40000 });
const turnEnded = (o: Harness, employeeId: string, said: RegExp, label: string, timeout = 40000) =>
  waitFor(async () => (await events(o, `employeeId=${employeeId}`)).some((e) => e.type === 'agent.turn_finished' && said.test(e.data.lastMessage ?? '')), { label, timeout });
const prompts = async (o: Harness, employeeId: string) => (await events(o, `employeeId=${employeeId}`)).filter((e) => e.type === 'agent.prompt_submitted').map((e) => String(e.data.prompt ?? ''));
const atPrompt = (o: Harness, employeeId: string, label: string) =>
  waitFor(async () => {
    const s = await o.session(employeeId);
    return s?.status === 'running' && s.inTurn === false ? s : null;
  }, { label, timeout: 30000 });
const tell = (o: Harness, employeeId: string, body: string) => o.api('POST', `/employees/${employeeId}/message`, { body });
const requestTo = async (o: Harness, employeeId: string, summary: string) => (await o.state()).collabs.find((c: CollabRequest) => c.toEmployeeId === employeeId && c.summary === summary);

before(async () => {
  h = await createHarness({ timings: { colleagueWaitMs: 30000, waitGoneGraceMs: 1500 } });
  q = await createHarness({ timings: { colleagueWaitMs: 2500, waitGoneGraceMs: 1500 } });
  projectId = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: 'npm test --silent' })).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend']] as const) ids[name] = (await h.employee(name, role, { projectId, autonomy: 'auto' })).id;
});

after(async () => {
  await h?.cleanup();
  await q?.cleanup();
});

test('one asks the other and waits: the answer comes back as the result of the call, and the work goes on', async () => {
  // Sarah has never been started. Alex's task cannot go on without her answer.
  assert.equal(await h.session(ids.Sarah!), undefined);
  const t = await h.task({
    projectId,
    title: 'Use the permissions contract',
    assigneeId: ids.Alex,
    description: '@@fake: mcp request_collaboration {"to":"Sarah","summary":"Need the permissions contract","detail":"The shape of the response.","wait":true}; result answer.txt; commit used the answer; complete built on the contract@@',
  });
  const done = await taskDone(h, t.id, 'Alex finished after the answer');

  // What the call returned, written down by the worker before it went on, and committed with the work.
  const answer = fs.readFileSync(path.join(done.worktree!, 'answer.txt'), 'utf8').trim();
  assert.equal(answer, 'Sarah answered your request "Need the permissions contract" — Sarah will do it as part of their current task: sarah will expose it as GET /api/permissions');
  assert.equal(h.git(done.worktree!, 'log', '-1', '--format=%s'), 'used the answer');

  const collab = (await requestTo(h, ids.Sarah!, 'Need the permissions contract'))!;
  assert.deepEqual([collab.waited, collab.status, collab.fromEmployeeId], [true, 'incorporated', ids.Alex]);
  // Sarah had no session: the request that is waited for started it, as a routine's run or talking to her would.
  assert.ok((await events(h, `employeeId=${ids.Sarah}`)).some((e) => e.type === 'session.woken' && /^Sarah was started for a request from Alex \(.*\), who is waiting for the answer/.test(e.summary)), 'Sarah was started for it');
  // She was told that Alex waits, and her answer said whom it let go on.
  const asked = (await prompts(h, ids.Sarah!)).find((p) => /Need the permissions contract/.test(p)) ?? '';
  assert.match(asked, /Request from Alex [^\n]*: Need the permissions contract\s+The shape of the response\.\s+Alex is waiting for your answer before going on\.\s+Answer before anything else/, 'the delivered request says who is waiting');
  await waitFor(async () => /Alex was waiting for it and has it now: they can go on\./.test((await pane(h, ids.Sarah!)).replace(/\s+/g, ' ')), { label: "respond_to_request's result on Sarah's screen" });

  // That Alex waited, and that the wait ended with what he waited for, is on the record. (What he was shown as
  // meanwhile is read in the next test, while it stands.)
  const alexEvents = await events(h, `employeeId=${ids.Alex}`);
  assert.ok(alexEvents.some((e) => e.type === 'agent.waiting' && e.data.phase === 'began' && e.summary === "Alex is waiting for Sarah's answer"));
  assert.ok(alexEvents.some((e) => e.type === 'agent.waiting' && e.data.phase === 'ended' && e.data.cutShort === false));
  assert.equal((await h.session(ids.Alex!))!.waitingOn ?? null, null);
  // The answer went back through the tool call, and was not also typed into Alex's terminal.
  const reply = await waitFor(async () => (await h.state()).messages.find((m) => m.threadId === collab.id && m.toEmployeeId === ids.Alex && m.delivery.status === 'confirmed'), { label: 'the answer confirmed as returned by the tool call' });
  assert.equal(reply.delivery.via, 'mcp_pull');
  assert.ok(!(await prompts(h, ids.Alex!)).some((p) => /Re: "Need the permissions contract"/.test(p)));
});

test('one waits until a task the other has is done, and is told at once when it already is', async () => {
  const theirs = await h.task({ projectId, title: 'Build the exporter', assigneeId: ids.Sarah, description: '@@fake: sleep 3000; write export.txt v1; commit exporter; complete exporter built@@' });
  const mine = await h.task({ projectId, title: 'Use the exporter', assigneeId: ids.Alex, description: `@@fake: mcp wait_for_colleague {"task":"${theirs.key}"}; result waited.txt; commit waited for it; complete went on once it was there@@` });

  // While Sarah works, Alex's call is open and he is shown waiting for her and that task.
  const waiting = await waitFor(async () => {
    const s = await h.session(ids.Alex!);
    return s?.waitingOn?.held ? s : null;
  }, { label: 'Alex waiting for the task', timeout: 30000 });
  assert.deepEqual([waiting.waitingOn!.taskId, waiting.waitingOn!.employeeId, waiting.activity, waiting.activityDetail], [theirs.id, ids.Sarah, 'waiting_input', `Waiting for Sarah (${theirs.key})`]);
  assert.notEqual((await h.getTask(theirs.id)).status, 'DONE');

  await taskDone(h, theirs.id, "Sarah's task done");
  const done = await taskDone(h, mine.id, "Alex's task done after it");
  const told = fs.readFileSync(path.join(done.worktree!, 'waited.txt'), 'utf8').trim();
  assert.equal(told, `${theirs.key} "Build the exporter" is DONE (Sarah). It is merged into orchestrator/integration.\nTheir summary: exporter built`);
  assert.equal((await h.session(ids.Alex!))!.waitingOn ?? null, null);

  // Asked again: it is already finished, so the answer is there at once.
  await atPrompt(h, ids.Alex!, 'Alex at the prompt');
  await tell(h, ids.Alex!, `Is it there? @@fake: mcp wait_for_colleague {"task":"${theirs.key}"}; result again.txt; say checked-again@@`);
  await turnEnded(h, ids.Alex!, /checked-again/, 'Alex checked again');
  assert.equal(fs.readFileSync(path.join((await h.session(ids.Alex!))!.cwd, 'again.txt'), 'utf8').trim(), told);
});

test('the bound passes: "not yet", the wait stands and is shown, and the late answer arrives as a message', async () => {
  const repo = q.makeRepo('desk');
  const project = (await q.project('Desk', repo)).id;
  for (const [name, role] of [['Ava', 'backend'], ['Ben', 'frontend']] as const) {
    ids[name] = (await q.employee(name, role, { projectId: project, autonomy: 'auto' })).id;
    await q.api('POST', `/employees/${ids[name]}/start`, {});
    await atPrompt(q, ids[name]!, `${name} started`);
  }
  // Ben is in the middle of something long: nothing can reach him until his turn ends.
  await tell(q, ids.Ben!, 'Long job. @@fake: sleep 7000; say ben-free@@');
  await waitFor(async () => (await q.session(ids.Ben!))!.inTurn === true, { label: 'Ben busy' });
  await tell(q, ids.Ava!, 'Ask Ben. @@fake: mcp request_collaboration {"to":"Ben","summary":"Which port","wait":true}; result first.txt; say ava-stopped@@');
  await turnEnded(q, ids.Ava!, /ava-stopped/, 'Ava stopped after the bound');

  const first = fs.readFileSync(path.join(repo, 'first.txt'), 'utf8').trim();
  const rid = /request ([0-9a-f]{8})/.exec(first)?.[1] ?? '';
  assert.match(first, /^Ben has not answered yet \(request [0-9a-f]{8}\): your request has not reached them yet; Ben is at work \(\w[\w ]*\)\. Do not guess the answer\./);
  assert.ok(first.includes(`call wait_for_colleague with request_id "${rid}" to keep waiting`));
  // Her turn is over and the answer has not come: she is waiting for Ben, and the office says so.
  const ava = await waitFor(async () => {
    const s = await q.session(ids.Ava!);
    return s?.inTurn === false && s.activity === 'waiting_input' ? s : null;
  }, { label: 'Ava shown as waiting' });
  assert.deepEqual([ava.activityDetail, ava.waitingOn?.requestId, ava.waitingOn?.held, ava.waitingOn?.employeeId], ["Waiting for Ben's answer", rid, false, ids.Ben]);
  assert.equal((await requestTo(q, ids.Ben!, 'Which port'))!.status, 'open');

  // Ben's turn ends; he gets the request, answers, and his answer is typed into Ava's session as a message.
  await waitFor(async () => (await prompts(q, ids.Ava!)).some((p) => /Message from Ben [^\n]*: Re: "Which port" — Ben will handle it as part of their current task\. ben will expose it/.test(p)), { label: "Ben's answer delivered to Ava", timeout: 40000 });
  assert.equal((await q.session(ids.Ava!))!.waitingOn ?? null, null);
  await waitFor(async () => /Response recorded \(incorporated\) and sent to Ava, who is waiting for it\./.test((await pane(q, ids.Ben!)).replace(/\s+/g, ' ')), { label: "who Ben's answer was for" });

  // Asked for again by its id: answered already, returned at once.
  await atPrompt(q, ids.Ava!, 'Ava at the prompt');
  await tell(q, ids.Ava!, `And now? @@fake: mcp wait_for_colleague {"request_id":"${rid}"}; result second.txt; say ava-done@@`);
  await turnEnded(q, ids.Ava!, /ava-done/, 'Ava asked again');
  assert.match(fs.readFileSync(path.join(repo, 'second.txt'), 'utf8'), /^Ben answered your request "Which port" — Ben will do it as part of their current task: ben will expose it/);
});

test('a restart of the office cuts the held call; the wait is on record and is picked up again', async () => {
  for (const who of ['Alex', 'Sarah']) await atPrompt(h, ids[who]!, `${who} at the prompt`);
  const cwd = (await h.session(ids.Alex!))!.cwd;
  // Sarah is busy for a while; Alex asks and waits, and — when that call fails — waits a little and asks again
  // with no arguments (he was never given the request's id: the call that would have returned it was cut).
  await tell(h, ids.Sarah!, 'Long job. @@fake: sleep 14000; say sarah-free@@');
  await waitFor(async () => (await h.session(ids.Sarah!))!.inTurn === true, { label: 'Sarah busy' });
  await tell(h, ids.Alex!, 'Ask Sarah. @@fake: mcp request_collaboration {"to":"Sarah","summary":"Across a restart","wait":true}; result cut.txt; sleep 5000; mcp wait_for_colleague {}; result resumed.txt; say alex-done@@');
  const before = await waitFor(async () => {
    const s = await h.session(ids.Alex!);
    return s?.waitingOn?.held ? s : null;
  }, { label: 'Alex waiting' });
  const rid = before.waitingOn!.requestId!;

  await h.restartServer();
  // The call did not come back; what Alex was waiting for is still on his session's record, with no call held.
  await waitFor(() => fs.existsSync(path.join(cwd, 'cut.txt')), { label: 'the cut call returned to the worker' });
  assert.match(fs.readFileSync(path.join(cwd, 'cut.txt'), 'utf8'), /^ERROR /);
  const after = (await h.session(ids.Alex!))!;
  assert.equal(after.waitingOn?.requestId, rid);
  assert.equal((await requestTo(h, ids.Sarah!, 'Across a restart'))!.status, 'open');

  // The continuation picks the wait up from what is stored, and Sarah's answer comes back through it.
  await turnEnded(h, ids.Alex!, /alex-done/, 'Alex got the answer after the restart', 60000);
  assert.match(fs.readFileSync(path.join(cwd, 'resumed.txt'), 'utf8'), /^Sarah answered your request "Across a restart" — Sarah will do it as part of their current task: sarah will expose it/);
  assert.equal((await h.session(ids.Alex!))!.waitingOn ?? null, null);
  assert.ok((await events(h, `employeeId=${ids.Alex}`)).filter((e) => e.type === 'agent.waiting' && e.data.requestId === rid && e.data.phase === 'began').length >= 1);
});
