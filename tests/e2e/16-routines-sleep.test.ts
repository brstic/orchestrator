/**
 * Routines and sleep, end to end: a real server, a real host agent, real tmux sessions, the scripted worker.
 *
 *   routines   a standing instruction is handed to the employee again and again; what it finds goes on the task
 *              board once; a run that finds them busy is skipped; routines survive a restart of the office
 *   sleep      a session with no work is stopped (the process and its tmux session really end) and whatever the
 *              employee is next needed for starts it again in the same folder, continuing the same conversation
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Routine } from '@orchestrator/contracts';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness; // routines: "a minute" is a second and a half; nobody is put to sleep
let z: Harness; // sleep: two seconds without work is "half an hour"
const ids: Record<string, string> = {};

const events = (o: Harness, q: string) => o.api<any[]>('GET', `/events?limit=1500&${q}`);
const routines = (o: Harness) => o.api<Routine[]>('GET', '/routines');
const routine = async (o: Harness, id: string) => (await routines(o)).find((r) => r.id === id)!;
const pane = async (o: Harness, employeeId: string) => {
  const s = await o.session(employeeId);
  return s?.tmuxPane && s.status === 'running' ? o.tmux('capture-pane', '-p', '-J', '-S', '-600', '-t', s.tmuxPane) : '';
};
const turnEnded = (o: Harness, employeeId: string, said: RegExp, label: string) =>
  waitFor(async () => (await events(o, `employeeId=${employeeId}`)).some((e) => e.type === 'agent.turn_finished' && said.test(e.data.lastMessage ?? '')), { label, timeout: 40000 });
const asleep = (o: Harness, employeeId: string, label: string) =>
  waitFor(async () => {
    const s = await o.session(employeeId);
    return s && s.status === 'exited' && s.asleepSince ? s : null;
  }, { label, timeout: 30000 });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

before(async () => {
  h = await createHarness({ timings: { routineTickMs: 150, routineMinuteMs: 1500 } });
  z = await createHarness({ timings: { sleepTickMs: 200, sleepIdleMs: 2000, routineTickMs: 150, routineMinuteMs: 1500, askBossWaitMs: 2500 } });
});

after(async () => {
  await h?.cleanup();
  await z?.cleanup();
});

test('a routine is handed over again and again; what it finds is put on the task board once', async () => {
  const repo = h.makeRepo('desk');
  ids.desk = (await h.project('Desk', repo, { verifyCommand: 'npm test --silent' })).id;
  ids.Ava = (await h.employee('Ava', 'backend', { projectId: ids.desk, autonomy: 'autonomous' })).id;
  // What is typed is validated like anything else the owner types.
  await assert.rejects(h.api('POST', '/routines', { employeeId: ids.Ava, instruction: 'x', everyMinutes: 0 }), /400: how often/);
  await assert.rejects(h.api('POST', '/routines', { employeeId: ids.Ava, instruction: '   ' }), /400: say what they should do each time/);
  await assert.rejects(h.api('POST', '/routines', { employeeId: 'nobody', instruction: 'x' }), /404|400/);

  // "Check the support desk every minute; put anything new on the board." Every check finds the same ticket.
  const found = '@@fake: mcp propose_tasks {"tasks":[{"title":"Ticket 4411 - login fails on Safari","description":"Reported on the support desk.","dedupe_key":"desk#4411"}]}@@';
  const r = await h.api<Routine>('POST', '/routines', { employeeId: ids.Ava, instruction: `Check the support desk at http://desk.example.test and put anything new on the task board. ${found}`, everyMinutes: 1 });
  ids.routine = r.id;
  assert.deepEqual([r.everyMinutes, r.enabled, r.createdBy], [1, true, 'owner']);
  // Ava had no session: it was started for the routine, as talking to her would have.
  assert.match(String(r.lastNote), /Ava had no session: it is being started for this/);
  const s = await waitFor(async () => {
    const x = await h.session(ids.Ava!);
    return x?.status === 'running' ? x : null;
  }, { label: 'Ava started for the routine' });
  assert.ok((await events(h, `employeeId=${ids.Ava}`)).some((e) => e.type === 'session.woken' && /Ava was started for a routine that was due/.test(e.summary)));

  // It runs, and runs again: each run a recorded message to her, delivered into the real session.
  await waitFor(async () => (await routine(h, r.id)).runs >= 3, { label: 'three runs', timeout: 30000 });
  const state = await h.state();
  const runs = state.messages.filter((m) => m.routineId === r.id);
  assert.ok(runs.length >= 3);
  assert.match(runs[0]!.body, /^Routine \(every 1 min\): Check the support desk/);
  await waitFor(async () => (await h.state()).messages.filter((m) => m.routineId === r.id && m.delivery.status === 'confirmed').length >= 2, { label: 'runs acknowledged by the session' });
  const text = await waitFor(async () => {
    const t = await pane(h, ids.Ava!);
    return /Nothing new was added/.test(t) ? t : null;
  }, { label: 'a later run found nothing new' });
  // (The scripted worker shows a pasted prompt only as "[pasted N chars]"; what the prompt says is covered by the unit test.)
  assert.match(text, /\[pasted \d+ chars\][\s\S]*\[pasted \d+ chars\]/, 'each run was typed into her terminal');
  assert.match(text, /Created 1 tasks: T-\d+\. They wait in the backlog for the boss to release them\./);
  assert.match(text, /Nothing new was added\. Already on the board, so not added again: T-\d+ \[BACKLOG\]/);

  // On the board: one task, proposed, waiting for the owner — in a project that otherwise hands work out by itself.
  const tasks = (await h.state()).tasks.filter((t) => t.dedupeKey === 'desk#4411');
  assert.equal(tasks.length, 1, 'the same ticket is not added twice');
  assert.deepEqual([tasks[0]!.status, tasks[0]!.released, tasks[0]!.assigneeId, tasks[0]!.createdBy], ['BACKLOG', false, null, 'employee:Ava']);
  assert.ok((await h.state()).notifications.some((n) => /Ava proposed 1 tasks/.test(n.title)));
  assert.equal((await h.session(ids.Ava!))!.id, s.id, 'the same session throughout');

  // In the feed like any message, and listed with what the last run came to.
  assert.ok((await events(h, `employeeId=${ids.Ava}`)).filter((e) => e.type === 'agent.message' && e.data.routineId === r.id).length >= 3);
  const listed = await routine(h, r.id);
  assert.ok(listed.lastRunAt && listed.nextRunAt && listed.lastMessageId);
  assert.ok(['delivered', 'skipped_busy'].includes(listed.lastOutcome!));
});

test('a run that finds the employee in the middle of something is skipped; a paused routine does not run', async () => {
  await h.api('PATCH', `/routines/${ids.routine}`, { enabled: false });
  const paused = await routine(h, ids.routine!);
  assert.deepEqual([paused.enabled, paused.nextRunAt], [false, null]);
  await waitFor(async () => (await h.session(ids.Ava!))?.inTurn === false, { label: 'Ava between turns' });
  await sleep(3500);
  assert.equal((await routine(h, ids.routine!)).runs, paused.runs, 'paused: more than two intervals pass and nothing runs');

  // Ava is given something that takes a while.
  await h.api('POST', `/employees/${ids.Ava}/message`, { body: 'Take your time. @@fake: sleep 5000; say took-my-time@@' });
  await waitFor(async () => (await h.session(ids.Ava!))?.inTurn === true, { label: 'Ava mid-turn' });
  const n = (await h.state()).messages.filter((m) => m.routineId === ids.routine).length;
  const skipped = await h.api<Routine>('POST', `/routines/${ids.routine}/run`, {});
  assert.equal(skipped.lastOutcome, 'skipped_busy');
  assert.match(String(skipped.lastNote), /Ava was in the middle of something/);
  assert.equal((await h.state()).messages.filter((m) => m.routineId === ids.routine).length, n, 'nothing was queued behind the turn');
  assert.ok((await events(h, `employeeId=${ids.Ava}`)).some((e) => e.type === 'routine.skipped' && /did not run: Ava was in the middle of something/.test(e.summary)));
  await turnEnded(h, ids.Ava!, /took-my-time/, 'the long turn ended');

  // Switched on again with another rhythm: one interval from now, never a burst.
  const t = Date.now();
  const on = await h.api<Routine>('PATCH', `/routines/${ids.routine}`, { enabled: true, everyMinutes: 2 });
  assert.ok(Math.abs(Date.parse(on.nextRunAt!) - (t + 3000)) < 1200, 'two "minutes" from now');
  await waitFor(async () => (await routine(h, ids.routine!)).runs > paused.runs, { label: 'it runs again', timeout: 20000 });
  assert.match((await h.state()).messages.filter((m) => m.routineId === ids.routine).at(-1)!.body, /^Routine \(every 2 min\):/);
});

test('routines outlive a restart of the office, and still add nothing twice', async () => {
  const before = await routine(h, ids.routine!);
  await h.restartServer();
  const kept = await routine(h, ids.routine!);
  assert.deepEqual([kept.instruction, kept.everyMinutes, kept.enabled], [before.instruction, 2, true]);
  await waitFor(async () => (await routine(h, ids.routine!)).runs > before.runs, { label: 'it runs after the restart', timeout: 40000 });
  await waitFor(async () => (await h.state()).messages.filter((m) => m.routineId === ids.routine && m.delivery.status === 'confirmed').length >= 4, { label: 'and is delivered', timeout: 30000 });
  assert.equal((await h.state()).tasks.filter((t) => t.dedupeKey === 'desk#4411').length, 1);
  // Removed: gone from the list, on the record, and it runs no more.
  await h.api('DELETE', `/routines/${ids.routine}`);
  assert.equal((await routines(h)).length, 0);
  assert.ok((await h.api<any[]>('GET', '/audit?limit=500')).some((a) => a.action === 'routine.removed'));
  const n = (await h.state()).messages.filter((m) => m.routineId === ids.routine).length;
  await sleep(3500);
  assert.equal((await h.state()).messages.filter((m) => m.routineId === ids.routine).length, n);
});

test('a session with no work is put to sleep: the process and its tmux session end, the conversation is kept', async () => {
  const repo = z.makeRepo('shop');
  ids.shop = (await z.project('Shop', repo, { verifyCommand: 'npm test --silent' })).id;
  ids.Bo = (await z.employee('Bo', 'backend', { projectId: ids.shop, autonomy: 'autonomous' })).id;
  // Bo does a task: he works in a folder of his own (a git worktree), on the task's branch.
  const task = await z.task({ projectId: ids.shop, title: 'Add a marker', assigneeId: ids.Bo, description: '@@fake: write marker.txt here; commit add marker; complete marker added@@', acceptance: 'Checks pass.' });
  await waitFor(async () => ((await z.getTask(task.id)).status === 'DONE' ? true : null), { label: 'task done', timeout: 40000 });
  const done = await z.getTask(task.id);
  const up = (await z.session(ids.Bo!))!;
  assert.equal(up.cwd, done.worktree, 'his session runs in his worktree');
  ids.session = up.id;
  ids.cwd = up.cwd;
  ids.conversation = up.claudeSessionId!;
  ids.tmux = up.tmuxSession;
  const pid = up.pid!;
  assert.ok(pid && alive(pid), 'a real process');
  assert.match(z.tmux('list-sessions', '-F', '#{session_name}'), new RegExp(up.tmuxSession));
  ids.branch = z.git(up.cwd, 'rev-parse', '--abbrev-ref', 'HEAD');

  // Nothing more for him: after "half an hour" (two seconds here) the office stops the session.
  const s = await asleep(z, ids.Bo!, 'Bo asleep');
  assert.equal(s.id, up.id);
  assert.match(String(s.exitReason), /^asleep after /);
  assert.equal(s.activity, 'offline');
  assert.deepEqual([s.claudeSessionId, s.cwd], [ids.conversation, ids.cwd], 'what is needed to continue is kept');
  // The memory is really freed: no tmux session, no process.
  await waitFor(() => !alive(pid), { label: 'the Claude Code process ended' });
  let listed = '';
  try {
    listed = z.tmux('list-sessions', '-F', '#{session_name}');
  } catch {
    listed = ''; // no sessions at all: tmux's server went with the last one
  }
  assert.ok(!listed.includes(up.tmuxSession), `the tmux session is gone (${listed.trim()})`);
  // Said plainly, and nobody alarmed.
  const ev = await events(z, `employeeId=${ids.Bo}`);
  assert.ok(ev.some((e) => e.type === 'session.asleep' && /Bo is asleep after .* without work/.test(e.summary)));
  assert.ok(!ev.some((e) => e.type === 'session.lost'), 'not a lost session');
  assert.ok(!(await z.state()).notifications.some((n) => n.kind === 'session_lost' && n.employeeId === ids.Bo && !n.resolvedAt), 'and no "went offline" alert');
  assert.ok((await z.api<any[]>('GET', '/audit?limit=500')).some((a) => a.action === 'session.asleep' && a.actor === 'office'));
});

test('a message wakes a sleeping employee: same folder, same branch, the same conversation continued', async () => {
  // Only the message: nothing asks for a start. The office starts the session because he is needed.
  const msg = await z.api<{ id: string }>('POST', `/employees/${ids.Bo}/message`, { body: 'Are you there? @@fake: say here-again@@' });
  await turnEnded(z, ids.Bo!, /here-again/, 'Bo answered after waking');
  const s = (await z.session(ids.Bo!))!;
  assert.deepEqual([s.id, s.status, s.cwd, s.claudeSessionId, s.resumed, s.asleepSince ?? null], [ids.session, 'running', ids.cwd, ids.conversation, true, null]);
  assert.equal(z.git(s.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), ids.branch, 'the folder is on the branch it was on');
  assert.equal((await z.state()).messages.find((m) => m.id === msg.id)!.delivery.status, 'confirmed', 'what woke him was delivered');
  const ev = await events(z, `employeeId=${ids.Bo}`);
  const woken = ev.filter((e) => e.type === 'session.woken');
  assert.equal(woken.length, 1);
  assert.match(woken[0]!.summary, /Bo was woken for a message from the boss — continuing where they left off/);
  // Claude Code itself says it resumed: its SessionStart hook, and what it printed.
  assert.ok(ev.some((e) => e.type === 'session.resumed' && e.data.source === 'resume'), 'the session started as a resume');
  assert.match(await pane(z, ids.Bo!), new RegExp(`session: ${ids.conversation} \\(resumed\\)`));
  assert.ok((await z.api<any[]>('GET', '/audit?limit=500')).some((a) => a.action === 'session.resumed' && a.actor === 'office'));
});

test('not while a question is open; and two things at once start one session', async () => {
  // Bo asks something and waits: however long that takes, the session stays.
  await z.api('POST', `/employees/${ids.Bo}/message`, { body: 'Decide. @@fake: ask Which database?@@' });
  const q = await waitFor(() => z.openQuestion(ids.Bo!), { label: 'question open' });
  await sleep(4500);
  assert.equal((await z.session(ids.Bo!))!.status, 'running', 'more than twice the idle time: still there, a question of his is open');
  await z.api('POST', `/questions/${q.id}/answer`, { answer: 'Option A' });
  await asleep(z, ids.Bo!, 'asleep once the question is settled');

  // A task and a message arrive together.
  const from = new Date().toISOString();
  const [task] = await Promise.all([
    z.task({ projectId: ids.shop, title: 'Second marker', assigneeId: ids.Bo, description: '@@fake: write second.txt here; commit add second; complete second added@@', acceptance: 'Checks pass.' }),
    z.api('POST', `/employees/${ids.Bo}/message`, { body: 'And say hello. @@fake: say hello-too@@' }),
  ]);
  await waitFor(async () => ((await z.getTask(task.id)).status === 'DONE' ? true : null), { label: 'the task was done after waking', timeout: 40000 });
  await turnEnded(z, ids.Bo!, /hello-too/, 'and the message was answered');
  const starts = (await z.api<any[]>('GET', '/audit?limit=1000')).filter((a) => (a.action === 'session.resumed' || a.action === 'session.started') && a.ts >= from && a.detail.employee === 'Bo');
  assert.equal(starts.length, 1, `one start for both (${starts.map((a) => `${a.action} by ${a.actor}`).join(', ')})`);
  assert.equal(starts[0]!.action, 'session.resumed');
  const s = (await z.session(ids.Bo!))!;
  assert.deepEqual([s.id, s.cwd, s.claudeSessionId], [ids.session, ids.cwd, ids.conversation]);
  assert.equal((await z.getTask(task.id)).worktree, ids.cwd);
});

test('a routine that comes due wakes its employee, does its round, and lets them sleep again', async () => {
  await asleep(z, ids.Bo!, 'Bo asleep before the routine');
  const n = (await events(z, `employeeId=${ids.Bo}`)).filter((e) => e.type === 'session.woken').length;
  // Every four "minutes" (six seconds): long enough to fall asleep in between.
  const r = await z.api<Routine>('POST', '/routines', { employeeId: ids.Bo, instruction: 'Look at the queue. @@fake: say queue-is-empty@@', everyMinutes: 4 });
  await turnEnded(z, ids.Bo!, /queue-is-empty/, 'the routine ran');
  const ev = await events(z, `employeeId=${ids.Bo}`);
  const woken = ev.filter((e) => e.type === 'session.woken');
  assert.equal(woken.length, n + 1);
  assert.match(woken.at(-1)!.summary, /Bo was woken for a routine that was due — continuing where they left off/);
  assert.deepEqual([(await z.session(ids.Bo!))!.id, (await z.session(ids.Bo!))!.cwd], [ids.session, ids.cwd]);
  // Asleep again between two runs, and woken for the next one.
  await asleep(z, ids.Bo!, 'asleep between runs');
  await waitFor(async () => (await routine(z, r.id)).runs >= 2, { label: 'the next run', timeout: 30000 });
  await waitFor(async () => (await events(z, `employeeId=${ids.Bo}`)).filter((e) => e.type === 'session.woken').length >= n + 2, { label: 'woken for it again' });
  await z.api('DELETE', `/routines/${r.id}`);
});
