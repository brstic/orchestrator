/**
 * Deleting an employee for good, end to end: a real server, a real host agent, real tmux sessions, scripted workers.
 *
 * The employee goes with what is theirs — the running session is stopped in the real terminal first; their sessions'
 * records, messages, questions, routines and XP go. Their tasks go with them, or go back on the board, as asked.
 * Nothing on disk is touched, and nothing is left pointing at them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mayCall } from '../../apps/server/src/access.ts';
import { createHarness, waitFor, type Harness } from './harness.ts';

/** A long job the scripted worker can be interrupted in: it looks for Escape between steps, not during one. */
const LONG = Array(200).fill('sleep 300').join('; ');

let h: Harness;
let project = '';
const ids: Record<string, string> = {};
const done = (id: string) => waitFor(async () => ((await h.getTask(id)).status === 'DONE' ? true : null), { label: 'a task done', timeout: 40000 });

before(async () => {
  h = await createHarness();
  project = (await h.project('Shop', h.makeRepo('shop'))).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend'], ['Noor', 'qa'], ['Omar', 'backend']] as const) ids[name] = (await h.employee(name, role, { projectId: project, autonomy: 'auto' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('an owner deletes an employee with everything that is theirs: the session is stopped, the tasks go, nothing points at them', async () => {
  const finished = await h.task({ projectId: project, title: 'Write the readme', assigneeId: ids.Alex, description: '@@fake: write notes.txt hello; commit notes; complete done@@' });
  await done(finished.id);
  const running = await h.task({ projectId: project, title: 'A long job', assigneeId: ids.Alex, description: `@@fake: progress started; ${LONG}@@` });
  await waitFor(async () => ((await h.getTask(running.id)).status === 'IN_PROGRESS' ? true : null), { label: 'the long task in progress', timeout: 40000 });
  const waiting = await h.task({ projectId: project, title: 'Uses the long job', assigneeId: ids.Sarah, dependsOn: [running.id], released: false });
  const reviewed = await h.task({ projectId: project, title: 'Sarah wants Alex to review', assigneeId: ids.Sarah, reviewerId: ids.Alex, released: false });
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'a note for later' });
  await h.api('POST', '/routines', { employeeId: ids.Alex, instruction: 'Check the build', everyMinutes: 60 });
  const session = (await h.session(ids.Alex!))!;
  assert.equal(session.status, 'running');
  const worktree = (await h.getTask(running.id)).worktree!;
  assert.ok(fs.existsSync(worktree));

  const res = await h.api<any>('DELETE', `/employees/${ids.Alex}?tasks=delete`);
  assert.equal(res.name, 'Alex');
  assert.equal(res.tasks, 2);
  assert.ok(res.sessions >= 1);

  const s = await h.state();
  assert.equal(s.employees.some((e) => e.id === ids.Alex), false, 'the employee is gone, not archived');
  assert.equal(s.sessions.some((x) => x.employeeId === ids.Alex), false);
  assert.equal(s.tasks.some((t) => t.assigneeId === ids.Alex), false);
  assert.equal(s.tasks.some((t) => t.id === finished.id || t.id === running.id), false);
  assert.deepEqual(s.tasks.find((t) => t.id === waiting.id)!.dependsOn, [], 'a colleague\'s task no longer waits for a task that does not exist');
  assert.equal(s.tasks.find((t) => t.id === reviewed.id)!.reviewerId, null);
  assert.equal(s.messages.some((m) => m.toEmployeeId === ids.Alex || m.from.id === ids.Alex), false);
  assert.equal((await h.api<any[]>('GET', '/routines')).some((r) => r.employeeId === ids.Alex), false);
  // (The feed is the record of what happened; it keeps their name and id.)
  const pointing = Object.entries(s).filter(([k, v]) => k !== 'events' && JSON.stringify(v ?? null).includes(ids.Alex!)).map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v.filter((x) => JSON.stringify(x).includes(ids.Alex!))).slice(0, 700) : JSON.stringify(v).slice(0, 700)}`);
  assert.deepEqual(pointing, [], 'nothing in the office\'s state but the record of what happened points at them');
  // The real session is gone from tmux; the folder they worked in is not touched.
  // (When it was the last one, the test's tmux server ends with it.)
  const sessionsNow = () => {
    try {
      return h.tmux('list-sessions', '-F', '#{session_name}').split('\n');
    } catch {
      return [];
    }
  };
  await waitFor(() => !sessionsNow().includes(session.tmuxSession!), { label: 'the tmux session is gone', timeout: 15000 });
  assert.ok(fs.existsSync(worktree), 'nothing on disk is deleted');
  // What happened stays on the record.
  const events = await h.api<any[]>('GET', '/events?limit=400');
  assert.match(events.find((e) => e.type === 'employee.deleted').summary, /Alex was deleted with 2 tasks/);
  // The name is free again, and so is the desk.
  const again = await h.employee('Alex', 'backend', { projectId: project });
  assert.notEqual(again.id, ids.Alex);
  await h.api('DELETE', `/employees/${again.id}`);
  assert.equal((await h.apiRaw('DELETE', `/employees/${ids.Alex}`)).status, 404);
});

test('without the tasks: unfinished ones go back on the board for someone else, finished ones stay as a record', async () => {
  const finished = await h.task({ projectId: project, title: 'Noor checks the cart', assigneeId: ids.Noor, description: '@@fake: write cart.txt ok; commit cart; complete checked@@' });
  await done(finished.id);
  const open = await h.task({ projectId: project, title: 'Noor checks the checkout', assigneeId: ids.Noor, description: `@@fake: ${LONG}@@` });
  await waitFor(async () => ((await h.getTask(open.id)).status === 'IN_PROGRESS' ? true : null), { label: 'the open task in progress', timeout: 40000 });
  const res = await h.api<any>('DELETE', `/employees/${ids.Noor}`);
  assert.deepEqual([res.tasks, res.released], [0, 1]);
  const kept = await h.getTask(finished.id);
  assert.deepEqual([kept.status, kept.assigneeId], ['DONE', null]);
  assert.match(kept.history.at(-1)!.note, /Noor, who did this, was deleted/);
  // Back on the board — and taken by whoever suits it (the scheduler hands a ready, unassigned task to a free colleague).
  const back = await waitFor(async () => {
    const t = await h.getTask(open.id);
    return t.assigneeId !== ids.Noor ? t : null;
  }, { label: 'the open task is off Noor', timeout: 10000 });
  assert.ok(['READY', 'IN_PROGRESS'].includes(back.status), back.status);
  assert.ok(back.history.some((x) => /Noor was deleted; back on the board/.test(x.note)));
});

test('an archived employee can be deleted too, and the state survives a restart', async () => {
  await h.api('PATCH', `/employees/${ids.Omar}`, { archived: true });
  await h.api('DELETE', `/employees/${ids.Omar}?tasks=delete`);
  await h.restartServer();
  const s = await h.state();
  assert.deepEqual(s.employees.filter((e) => [ids.Alex, ids.Noor, ids.Omar].includes(e.id)), []);
  assert.ok(s.employees.some((e) => e.id === ids.Sarah));
});

test('an employee is not deleted in the instant a task is being handed to them', async () => {
  const pat = await h.employee('Pat', 'backend', { projectId: (await h.state()).projects[0]!.id });
  // (The hand-over holds this mark for the second or two it takes; set by hand here so that the instant lasts.)
  const starting = (h.server.engine.tasks as unknown as { startingEmployees: Set<string> }).startingEmployees;
  starting.add(pat.id);
  const refused = await h.apiRaw('DELETE', `/employees/${pat.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /A task is being handed to Pat right now/);
  assert.ok((await h.state()).employees.some((e) => e.id === pat.id));
  starting.delete(pat.id);
  assert.equal((await h.apiRaw('DELETE', `/employees/${pat.id}`)).status, 200);
  assert.ok(!(await h.state()).employees.some((e) => e.id === pat.id));
});

test('who may delete: an owner anywhere; a colleague only their own employee on their own computer; a visitor nobody', async () => {
  const engine = h.server.engine;
  const colleague = { kind: 'guest' as const, id: 'm1', name: 'M', role: 'colleague' as const };
  assert.equal(mayCall(engine, { kind: 'owner', id: 'owner', name: 'Boss', role: 'owner' } as any, 'DELETE', `/employees/${ids.Sarah}`, null).ok, true);
  const shared = mayCall(engine, colleague, 'DELETE', `/employees/${ids.Sarah}`, null);
  assert.equal(shared.ok, false);
  assert.match(shared.reason ?? '', /Only an owner/);
  assert.equal(mayCall(engine, { ...colleague, role: 'visitor' }, 'DELETE', `/employees/${ids.Sarah}`, null).ok, false);
});
