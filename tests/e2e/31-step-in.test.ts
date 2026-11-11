/**
 * Stepping into a task somebody is working on — a real server, a real host agent, real tmux sessions, scripted workers.
 *
 *  - Correct it: the task's text changes and the employee is told at once (their turn interrupted in the real
 *    terminal when asked), and goes on with the corrected task.
 *  - Stop it: the employee is interrupted and told to leave it; the task is on hold (and comes back on the same
 *    branch when released) or removed. The employee is free for other work.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mayCall } from '../../apps/server/src/access.ts';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

/** A long job the scripted worker can be interrupted in: it looks for Escape between steps, not during one. */
const LONG = Array(300).fill('sleep 200').join('; ');

let h: Harness;
let project = '';
const ids: Record<string, string> = {};
const pane = async (name: string) => h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', (await h.session(ids[name]!))!.tmuxPane!);
const inProgress = (id: string) => waitFor(async () => {
  const t = await h.getTask(id);
  return t.status === 'IN_PROGRESS' && t.delivery.status === 'confirmed' && (await h.session(t.assigneeId!))?.inTurn === true ? t : null;
}, { label: 'the task is being worked on', timeout: 40000 });

before(async () => {
  h = await createHarness();
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  for (const name of ['Alex', 'Sarah', 'Noor']) ids[name] = (await h.employee(name, 'backend', { projectId: project, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('a correction: the task\'s text changes, the employee is interrupted and told, and finishes the corrected task', async () => {
  const task = await h.task({ projectId: project, title: 'Paint the header red', assigneeId: ids.Alex, description: `Make it red. @@fake: ${LONG}@@` });
  const started = await inProgress(task.id);
  const res = await h.api('POST', `/tasks/${task.id}/correct`, {
    note: 'Not red — blue, to match the logo. @@fake: write color.txt blue; commit paint it blue; complete header is blue@@',
    title: 'Paint the header blue',
    description: 'Make it blue.',
    now: true,
  });
  assert.equal(res.title, 'Paint the header blue');
  assert.equal(res.description, 'Make it blue.');
  assert.equal(res.status, 'IN_PROGRESS', 'it stays theirs');
  // Interrupted in the real terminal, then told — and the corrected task is what they finish.
  await waitFor(async () => /Interrupted/.test(await pane('Alex')), { label: 'the turn was interrupted', timeout: 15000 });
  const done = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'finished after the correction', timeout: 12000 }).catch(async (e) => {
    const t = await h.getTask(task.id);
    const ses = await h.session(ids.Alex!);
    throw new Error(`${e.message}\n${t.status} delivery=${JSON.stringify(t.delivery)} inTurn=${ses?.inTurn} activity=${ses?.activity}\n${(await h.state()).messages.filter((m) => m.toEmployeeId === ids.Alex).map((m) => `${m.delivery.status} ${m.delivery.detail ?? ''} | ${m.body.slice(0, 60)}`).join('\n')}\n${(await pane('Alex')).split('\n').filter((l) => l.trim()).slice(-14).map((l) => l.slice(0, 170)).join('\n')}`);
  });
  assert.equal(fs.readFileSync(path.join(started.worktree!, 'color.txt'), 'utf8').trim(), 'blue');
  assert.equal(done.branch, started.branch, 'the same task, the same branch');
  assert.ok(done.history.some((x) => /^Corrected by the boss: Not red — blue, to match the logo\./.test(x.note) && /\(changed: title, description\)/.test(x.note)));
  const told = (await h.state()).messages.find((m) => m.toEmployeeId === ids.Alex && /^Correction to T-\d+ "Paint the header blue" from the boss:/.test(m.body))!;
  assert.match(told.body, /The task now reads:\nPaint the header blue\n\nMake it blue\./);
  assert.match(told.body, /Go on with T-\d+ with this in mind/);
  const events = await h.api<any[]>('GET', '/events?limit=300');
  assert.match(events.find((e) => e.type === 'task.corrected').summary, /was corrected by the boss — Alex was told at once/);
  assert.ok(events.some((e) => e.type === 'terminal.interrupt' && /Alex was interrupted: T-\d+ was corrected/.test(e.summary)));
});

test('a correction without interrupting is read when the turn ends; one with nothing in it is refused', async () => {
  const task = await h.task({ projectId: project, title: 'Write the notes', assigneeId: ids.Sarah, description: '@@fake: sleep 1500; say first part written@@' });
  await inProgress(task.id);
  assert.equal((await h.apiRaw('POST', `/tasks/${task.id}/correct`, { note: '  ' })).status, 400);
  assert.equal((await h.apiRaw('POST', `/tasks/${task.id}/correct`, { title: 'Write the notes' })).status, 400, 'the same text is no correction');
  await h.api('POST', `/tasks/${task.id}/correct`, { note: 'Add a summary on top. @@fake: write notes.txt summary; commit notes; complete notes with a summary@@' });
  assert.doesNotMatch(await pane('Sarah'), /Interrupted/);
  await waitFor(async () => (await h.getTask(task.id)).status === 'DONE', { label: 'done with the correction', timeout: 40000 });
  assert.doesNotMatch(await pane('Sarah'), /Interrupted/, 'she was never interrupted');
  // A finished task is not corrected: that is a new task.
  assert.match(JSON.stringify((await h.apiRaw('POST', `/tasks/${task.id}/correct`, { note: 'one more thing' })).body), /is done; make a new task/);
});

test('stopping a task: the employee is interrupted and told, the task waits on hold, and they take other work', async () => {
  const task = await h.task({ projectId: project, title: 'Rebuild the cart', assigneeId: ids.Noor, description: `@@fake: write cart.txt half; ${LONG}@@` });
  const started = await inProgress(task.id);
  const res = await h.api('POST', `/tasks/${task.id}/stop`, { note: 'The client changed their mind.' });
  assert.deepEqual([res.interrupted, res.deleted], [true, false]);
  const held = await h.getTask(task.id);
  assert.deepEqual([held.status, held.released, held.assigneeId, held.delivery.status], ['BACKLOG', false, ids.Noor, 'none']);
  assert.equal(held.branch, started.branch, 'the branch is kept');
  assert.ok(held.history.some((x) => /^Stopped by the boss: The client changed their mind\. — on hold until it is released again$/.test(x.note)));
  await waitFor(async () => /Interrupted/.test(await pane('Noor')), { label: 'interrupted in the terminal', timeout: 15000 });
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === ids.Noor && /^The boss stopped T-\d+ "Rebuild the cart"/.test(m.body) && m.delivery.status !== 'queued'), { label: 'Noor was told', timeout: 20000 });
  assert.match(told.body, /Stop working on it now: do not continue it and do not call complete_task for it\./);
  assert.match(told.body, /Why: The client changed their mind\./);
  assert.match(told.body, /It is on hold; if it is released again it comes back to you\./);
  // What she had half-done is not lost and not in the way: it is on the task's branch, and her folder is clean.
  assert.match(told.body, /What you had uncommitted was committed on orch\/noor\/\S+ as work in progress; your folder is clean\./);
  assert.ok((await h.getTask(task.id)).history.some((x) => /What was uncommitted \(1 file\) was committed on orch\/noor\/\S+ as work in progress/.test(x.note)));
  assert.match(h.git(started.worktree!, 'log', '--format=%s', '-1', started.branch!), /^WIP T-\d+: stopped by the boss/);
  assert.equal(h.git(started.worktree!, 'show', `${started.branch}:cart.txt`).trim(), 'half');
  // Not nudged to go on with what was stopped.
  assert.equal((await h.getTask(task.id)).nudges, 0);
  // Free for other work.
  const other = await h.task({ projectId: project, title: 'Something else', assigneeId: ids.Noor, description: '@@fake: write other.txt x; commit other; complete other done@@' });
  await waitFor(async () => (await h.getTask(other.id)).status === 'DONE', { label: 'the other task done', timeout: 12000 }).catch(async (e) => {
    const t = await h.getTask(other.id);
    const ses = await h.session(ids.Noor!);
    throw new Error(`${e.message}\n${t.status} delivery=${JSON.stringify(t.delivery)} note=${t.progress.note} | session inTurn=${ses?.inTurn} activity=${ses?.activity} ${ses?.activityDetail}\n${t.history.map((x) => x.note).join(' / ')}\n${(await pane('Noor')).split('\n').filter((l) => l.trim()).slice(-12).map((l) => l.slice(0, 170)).join('\n')}`);
  });
  assert.equal((await h.getTask(task.id)).status, 'BACKLOG', 'the stopped task did not start again by itself');
  // Released again: it comes back to her, on the branch it had.
  await h.api('PATCH', `/tasks/${task.id}`, { description: '@@fake: write cart.txt whole; commit cart; complete cart rebuilt@@' });
  await h.api('POST', '/tasks/release', { ids: [task.id] });
  const done = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'done after it was released again', timeout: 40000 });
  assert.equal(done.branch, started.branch);
  assert.equal(done.assigneeId, ids.Noor);
  ids.stopped = task.id;
});

test('stop and delete: the task is gone, the employee is told so; and who may step in', async () => {
  const task = await h.task({ projectId: project, title: 'A mistake', assigneeId: ids.Alex, description: `@@fake: ${LONG}@@` });
  await inProgress(task.id);
  const res = await h.api('POST', `/tasks/${task.id}/stop`, { then: 'delete' });
  assert.deepEqual([res.interrupted, res.deleted], [true, true]);
  assert.equal((await h.state()).tasks.some((t) => t.id === task.id), false);
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === ids.Alex && /^The boss stopped T-\d+ "A mistake"/.test(m.body) && m.delivery.status !== 'queued'), { label: 'Alex was told', timeout: 20000 });
  assert.match(told.body, /The task was removed from the board\./);
  await waitFor(async () => (await h.session(ids.Alex!))?.inTurn === false, { label: 'Alex is between turns', timeout: 20000 });
  // A task nobody is working on is simply put on hold; a finished one cannot be stopped.
  const idle = await h.task({ projectId: project, title: 'Not started', released: false });
  assert.deepEqual([(await h.api('POST', `/tasks/${idle.id}/stop`, {})).interrupted, (await h.getTask(idle.id)).status], [false, 'BACKLOG']);
  assert.match(JSON.stringify((await h.apiRaw('POST', `/tasks/${ids.stopped}/stop`, {})).body), /is done; there is nothing to stop/);
  // Whoever may work with the task may step in; a visitor may not.
  const engine = h.server.engine;
  for (const p of [`/tasks/${idle.id}/stop`, `/tasks/${idle.id}/correct`]) {
    assert.equal(mayCall(engine, { kind: 'guest', id: 'v', name: 'V', role: 'visitor' }, 'POST', p, {}).ok, false);
    assert.equal(mayCall(engine, { kind: 'guest', id: 'c', name: 'C', role: 'colleague' }, 'POST', p, {}).ok, true);
  }
});

test('a correction to a task nobody is working on is written into the task, and the office says that nobody was told', async () => {
  const waiting = await h.task({ projectId: project, title: 'Tidy the footer', released: false, description: 'Make the footer one line.' });
  const res = await h.api<any>('POST', `/tasks/${waiting.id}/correct`, { note: 'Two lines on a phone, one on a desktop.' });
  assert.equal(res.told, false);
  const now = await h.getTask(waiting.id);
  assert.match(now.description, /^Make the footer one line\.\n\nCorrection from the boss \(\d{4}-\d\d-\d\d\): Two lines on a phone, one on a desktop\.$/);
  assert.ok((await h.state()).events.some((e) => e.type === 'task.corrected' && e.taskId === waiting.id && !/was told/.test(e.summary)));
});

test('a task stopped while it is still being handed over is not started after all', async () => {
  const eve = (await h.employee('Eve', 'backend', { projectId: project })).id;
  const task = await h.task({ projectId: project, title: 'Write the banner', assigneeId: eve, description: '@@fake: sleep 2500; say eve-got-the-banner-task@@' });
  // The hand-over has begun (her session is being started for it) and has not arrived yet.
  await waitFor(async () => !!(await h.session(eve)), { label: 'her session is being started', timeout: 30000, interval: 10 });
  const stopped = await h.api<any>('POST', `/tasks/${task.id}/stop`, { then: 'hold', note: 'Not yet.' });
  assert.equal(stopped.deleted, false);
  await sleep(6000);
  const after = await h.getTask(task.id);
  assert.deepEqual([after.status, after.released], ['BACKLOG', false], 'the hand-over that was on its way did not put it back in progress');
  const s = await h.session(eve);
  if (s?.tmuxPane) assert.doesNotMatch(h.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', s.tmuxPane), /eve-got-the-banner-task/);
  // She is free for other work, once.
  const next = await h.task({ projectId: project, title: 'Write the notice', assigneeId: eve, description: '@@fake: say eve-got-the-notice-task; complete-nocode done@@' });
  await waitFor(async () => (await h.getTask(next.id)).status === 'DONE' || /eve-got-the-notice-task/.test(h.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', (await h.session(eve))!.tmuxPane!)), { label: 'she takes other work', timeout: 40000 });
  assert.equal((await h.state()).tasks.filter((t) => t.assigneeId === eve && t.status === 'IN_PROGRESS' && t.id === task.id).length, 0);
});

test('stopped while their machine is away for a moment: they are told when it is back', async () => {
  const ivo = (await h.employee('Ivo', 'backend', { projectId: project })).id;
  const task = await h.task({ projectId: project, title: 'Write the legal page', assigneeId: ivo, description: `@@fake: say ivo-started; ${Array.from({ length: 60 }, () => 'sleep 200').join('; ')}; say ivo-finished-the-legal-page@@` });
  await waitFor(async () => (await h.getTask(task.id)).delivery.status === 'confirmed', { label: 'Ivo has it', timeout: 30000 });
  const pane = (await h.session(ivo))!.tmuxPane!;
  // The link to his machine drops (its agent is stopped; his session goes on by itself).
  await h.stopAgent();
  await waitFor(async () => (await h.session(ivo))?.status === 'host_offline', { label: 'his machine is away', timeout: 15000 });
  const stopped = await h.api<any>('POST', `/tasks/${task.id}/stop`, { then: 'hold', note: 'The lawyers are not done.' });
  assert.equal(stopped.interrupted, false, 'nobody could be interrupted');
  const waiting = (await h.state()).messages.find((m) => m.toEmployeeId === ivo && new RegExp(`stopped ${task.key}`).test(m.body));
  assert.ok(waiting, 'the message waits for him');
  assert.match(waiting!.body, /The lawyers are not done\./);
  assert.equal(waiting!.delivery.status, 'queued');
  await h.startAgent();
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === waiting!.id)?.delivery.status !== 'queued', { label: 'he is told when the machine is back', timeout: 40000 });
  assert.equal((await h.getTask(task.id)).status, 'BACKLOG');
  void pane;
});
