/**
 * The task board in the employees' hands, end to end: a real server, a real host agent, real tmux sessions,
 * scripted workers that call the office's tools.
 *
 *   release    someone releases a task that waited in the backlog; it is scheduled and done
 *   unblock    someone says how a teammate's blocker is resolved; the teammate is told and goes on
 *   give       a task is given to whoever fits
 *   review     a teammate who was not appointed reviews finished work — never the author
 *   wake       a teammate who was never started is started because they are needed, and reads why first
 *   switched off: every one of these is refused in words and the tools are not offered
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let projectId = '';
let repo = '';
const ids: Record<string, string> = {};

const events = (query: string) => h.api<any[]>('GET', `/events?limit=1500&${query}`);
const atPrompt = (who: string, label = `${who} at the prompt`) =>
  waitFor(async () => {
    const s = await h.session(ids[who]!);
    return s?.status === 'running' && s.inTurn === false ? s : null;
  }, { label, timeout: 40000 });
const turnEnded = (who: string, said: RegExp, label: string) =>
  waitFor(async () => ((await events(`employeeId=${ids[who]}`)).some((e) => e.type === 'agent.turn_finished' && said.test(e.data.lastMessage ?? '')) ? true : null), { label, timeout: 40000 });
const tell = (who: string, body: string) => h.api('POST', `/employees/${ids[who]}/message`, { body });
/** Have someone call one tool and write down what it answered. (No semicolons in the arguments: they separate the scripted worker's steps.) */
const call = async (who: string, tool: string, args: Record<string, unknown>, tag: string) => {
  const cwd = (await h.session(ids[who]!))!.cwd;
  await tell(who, `Do this. @@fake: mcp ${tool} ${JSON.stringify(args)}; result ${tag}.txt; say ${tag}-done@@`);
  await turnEnded(who, new RegExp(`${tag}-done`), `${who} called ${tool}`);
  return fs.readFileSync(path.join(cwd, `${tag}.txt`), 'utf8').trim();
};
const done = (id: string, label: string) => waitFor(async () => ((await h.getTask(id)).status === 'DONE' ? true : null), { label, timeout: 60000 });

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('shop');
  projectId = (await h.project('Shop', repo, { verifyCommand: 'npm test --silent' })).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend'], ['Noor', 'qa'], ['Mila', 'docs']] as const) ids[name] = (await h.employee(name, role, { projectId, autonomy: 'auto' })).id;
  // Mila is never started here: she is the one who gets woken.
  for (const who of ['Alex', 'Sarah', 'Noor']) {
    await h.api('POST', `/employees/${ids[who]}/start`, {});
    await atPrompt(who, `${who} started`);
  }
});

after(async () => {
  await h?.cleanup();
});

test('the board tools are on by default and offered to every employee', async () => {
  assert.notEqual((await h.state()).settings.employeesManageBoard, false);
  const pane = h.tmux('capture-pane', '-p', '-J', '-S', '-400', '-t', (await h.session(ids.Alex!))!.tmuxPane!);
  void pane;
  const seen = await call('Alex', 'get_task', { task: 'T-999' }, 'none');
  assert.match(seen, /^ERROR No task "T-999" that you can see/);
});

test('an employee releases a task that waited in the backlog, and gives it to a colleague: it is scheduled and done', async () => {
  const t = await h.task({ projectId, title: 'Add the health endpoint', released: false, description: '@@fake: write health.txt ok; commit health; complete health added@@' });
  assert.deepEqual([(await h.getTask(t.id)).status, (await h.getTask(t.id)).released], ['BACKLOG', false]);
  const looked = await call('Alex', 'get_task', { task: t.key }, 'look');
  assert.match(looked, new RegExp(`^${t.key}: Add the health endpoint\\nStatus: BACKLOG \\(not released\\)[^\\n]*\\nAssigned to: nobody`));
  const given = await call('Alex', 'give_task', { task: t.key, employee: 'Sarah' }, 'give');
  assert.equal(given, `${t.key} "Add the health endpoint" is now assigned to Sarah. It is not released yet (release_task).`);
  const released = await call('Alex', 'release_task', { task: t.key }, 'release');
  assert.equal(released, `${t.key} "Add the health endpoint" is released. It is handed to Sarah as soon as they are free.`);
  await done(t.id, 'the released task done by Sarah');
  const after = await h.getTask(t.id);
  assert.equal(after.assigneeId, ids.Sarah);
  assert.ok(after.history.some((x) => x.note === 'Released for scheduling' && x.by === 'employee:Alex'), 'who released it is on the record');
  assert.ok(after.history.some((x) => x.note === 'Assigned to Sarah' && x.by === 'employee:Alex'));
  assert.equal(await call('Alex', 'release_task', { task: t.key }, 'again'), `${t.key} is already released (DONE).`);
});

test('an employee unblocks a teammate\'s task by saying how the blocker is resolved; the teammate is told and finishes it', async () => {
  await atPrompt('Sarah');
  const t = await h.task({ projectId, title: 'Wire the payment page', assigneeId: ids.Sarah, description: '@@fake: write pay.txt wip; commit wip; block The payment API key is missing@@' });
  await waitFor(async () => ((await h.getTask(t.id)).status === 'BLOCKED' ? true : null), { label: 'blocked', timeout: 40000 });
  assert.match(await call('Alex', 'get_task', { task: t.key }, 'look2'), /Status: BLOCKED[^\n]*\nAssigned to: Sarah\nBlocked on: The payment API key is missing/);
  assert.match(await call('Alex', 'unblock_task', { task: t.key, note: 'ok' }, 'short'), /^ERROR Say in "note" how the blocker is resolved/);
  const said = await call('Alex', 'unblock_task', { task: t.key, note: 'The key is in .env.example as PAYMENT_KEY and the sandbox value there works.' }, 'unblock');
  assert.equal(said, `${t.key} is unblocked: Sarah was told and continues it.`);
  assert.equal((await h.getTask(t.id)).status, 'IN_PROGRESS');
  // Sarah reads it as a message from Alex, not from the boss.
  await waitFor(async () => ((await events(`employeeId=${ids.Sarah}`)).some((e) => e.type === 'agent.prompt_submitted' && /Message from Alex [^\n]*: [^\n]*is unblocked \(was: The payment API key is missing\)\. The key is in \.env\.example/.test(String(e.data.prompt ?? ''))) ? true : null), { label: 'Sarah told by Alex', timeout: 40000 });
  assert.ok((await events(`taskId=${t.id}`)).some((e) => e.type === 'task.unblocked' && e.summary === `Alex unblocked ${t.key}`));
  // She goes on in the same session and finishes it. (The scripted worker does what its prompt scripts, so the rest is scripted here.)
  await atPrompt('Sarah');
  await tell('Sarah', 'Go on. @@fake: write pay.txt done; commit paid; complete payment page wired@@');
  await done(t.id, 'the unblocked task finished');
  // What the boss blocked stays blocked.
  const held = await h.task({ projectId, title: 'Not yet', released: false });
  await h.api('PATCH', `/tasks/${held.id}`, { status: 'BLOCKED' });
  assert.match(await call('Alex', 'unblock_task', { task: held.key, note: 'I think this can go ahead now.' }, 'owners'), /^ERROR The boss blocked/);
  assert.equal((await h.getTask(held.id)).status, 'BLOCKED');
});

test('a teammate who was not appointed reviews finished work; its author cannot', async () => {
  await atPrompt('Sarah');
  await atPrompt('Alex');
  // The appointed reviewer is in the middle of something long, so the review would wait for her.
  const long = await h.task({ projectId, title: 'A long test run', assigneeId: ids.Noor, description: `@@fake: progress running; ${Array(200).fill('sleep 1500').join('; ')}@@` });
  await waitFor(async () => ((await h.getTask(long.id)).status === 'IN_PROGRESS' ? true : null), { label: 'Noor busy', timeout: 40000 });
  const t = await h.task({ projectId, title: 'Change the footer', assigneeId: ids.Alex, requiresReview: true, reviewerId: ids.Noor, description: '@@fake: write footer.txt new; commit footer; complete footer changed@@' });
  await waitFor(async () => ((await h.getTask(t.id)).status === 'REVIEW' ? true : null), { label: 'waiting for review', timeout: 60000 });
  await atPrompt('Alex');
  assert.match(await call('Alex', 'submit_review', { task: t.key, verdict: 'approve', comments: 'Looks fine to me.' }, 'own'), /^ERROR Error: you cannot review your own task/);
  assert.equal((await h.getTask(t.id)).status, 'REVIEW');
  // Sarah was not asked to review it. She reads it and approves: it is merged and done.
  await call('Sarah', 'submit_review', { task: t.key, verdict: 'approve', comments: 'Read the diff: one file, as asked.' }, 'review');
  await done(t.id, 'approved and merged');
  const review = (await h.getTask(t.id)).evidence.review!;
  assert.deepEqual([review.verdict, review.reviewerId, review.by], ['approved', ids.Sarah, 'employee']);
});

test('an employee starts a colleague who was never started, and the colleague reads why first', async () => {
  assert.equal(await h.session(ids.Mila!), undefined);
  assert.match(await call('Alex', 'wake_colleague', { employee: 'Mila', reason: 'hi' }, 'thin'), /^ERROR Say in "reason" what they are needed for/);
  const said = await call('Alex', 'wake_colleague', { employee: 'Mila', reason: 'The checkout tests need a second pair of eyes before the release.' }, 'wake');
  assert.equal(said, 'Mila is started. Your message is the first thing they read.');
  const mila = await atPrompt('Mila', 'Mila started');
  assert.equal(mila.status, 'running');
  assert.ok((await events(`employeeId=${ids.Mila}`)).some((e) => e.type === 'session.woken' && /^Mila was started for Alex: The checkout tests need a second pair of eyes/.test(e.summary)), 'on the record: who wanted them and why');
  await waitFor(async () => ((await events(`employeeId=${ids.Mila}`)).some((e) => e.type === 'agent.prompt_submitted' && /Message from Alex [^\n]*: The checkout tests need a second pair of eyes/.test(String(e.data.prompt ?? ''))) ? true : null), { label: 'Mila read why', timeout: 40000 });
  // Someone who is at their desk is not started twice: they get the message.
  assert.match(await call('Alex', 'wake_colleague', { employee: 'Mila', reason: 'One more thing about the checkout tests.' }, 'awake'), /^Mila is at their desk already \(/);
});

test('switched off by the owner, the board is the owner\'s again: each tool says so and changes nothing', async () => {
  await h.api('PATCH', '/settings', { employeesManageBoard: false });
  const t = await h.task({ projectId, title: 'Waits for the boss', released: false });
  for (const [tool, args] of [['release_task', { task: t.key }], ['give_task', { task: t.key, employee: 'Sarah' }], ['unblock_task', { task: t.key, note: 'it is fine, go ahead with it' }], ['wake_colleague', { employee: 'Sarah', reason: 'something to look at' }]] as const) {
    assert.match(await call('Alex', tool, args, `off-${tool}`), /^ERROR The owner keeps the task board to themselves in this office/, tool);
  }
  const after = await h.getTask(t.id);
  assert.deepEqual([after.status, after.released, after.assigneeId], ['BACKLOG', false, null]);
  await h.api('PATCH', '/settings', { employeesManageBoard: true });
});
