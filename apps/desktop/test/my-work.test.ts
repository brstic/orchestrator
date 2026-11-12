import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutEmployee, askLine, byAttention, employeeState, myWorkLine, projectLine, taskState, tasksByProject } from '../src/lib/my-work.ts';

/** The words of the My work window (docs/UI.md). */

test('how an employee is: one word, one dot, a colour only when somebody is wanted', () => {
  assert.deepEqual(employeeState('thinking'), { word: 'thinking', dot: 'on', tone: 'calm' });
  assert.deepEqual(employeeState('running_command'), { word: 'running command', dot: 'on', tone: 'calm' });
  assert.deepEqual(employeeState('idle'), { word: 'available', dot: 'on', tone: 'calm' });
  // Asleep is not a fault: a ring, no colour.
  assert.deepEqual(employeeState('offline'), { word: 'sleeping', dot: 'off', tone: 'calm' });
  assert.deepEqual(employeeState('unknown'), { word: 'unknown', dot: 'off', tone: 'calm' });
  // The marks made for the name tags over their heads are not part of the word.
  assert.deepEqual(employeeState('waiting_answer'), { word: 'needs a decision', dot: 'busy', tone: 'warn' });
  assert.deepEqual(employeeState('needs_approval'), { word: 'needs approval', dot: 'busy', tone: 'warn' });
  assert.deepEqual(employeeState('blocked'), { word: 'blocked', dot: 'bad', tone: 'bad' });
  assert.deepEqual(employeeState('task_complete'), { word: 'task completed', dot: 'on', tone: 'calm' });
  // An open question of theirs outweighs whatever else they are doing — but not the more exact word for it.
  assert.deepEqual(employeeState('coding', true), { word: 'needs you', dot: 'busy', tone: 'warn' });
  assert.deepEqual(employeeState('needs_approval', true).word, 'needs approval');
  // A state the office learns tomorrow is shown as it is called.
  assert.deepEqual(employeeState('pair_programming'), { word: 'pair programming', dot: 'on', tone: 'calm' });
});

test('what an employee is, for whoever opens their line — the machine only where there are several', () => {
  const e = { title: 'Frontend Engineer', model: 'sonnet' };
  assert.equal(aboutEmployee(e, { project: "Mila's notes", machine: "Mila's computer", machines: 1 }), "Frontend Engineer · Mila's notes · sonnet");
  assert.equal(aboutEmployee(e, { project: "Mila's notes", machine: 'box', machines: 2 }), "Frontend Engineer · Mila's notes · box · sonnet");
  assert.equal(aboutEmployee({ title: 'QA' }, { machines: 1 }), 'QA');
});

test('who is listed first: whoever wants somebody, then whoever works, then whoever sleeps', () => {
  const p = (name: string, activity: string, asks = false) => ({ name, state: employeeState(activity, asks) });
  assert.deepEqual(
    byAttention([p('Zed', 'offline'), p('Ava', 'coding'), p('Bo', 'blocked'), p('Cy', 'thinking', true), p('Al', 'idle'), p('Di', 'needs_approval')]).map((x) => x.name),
    ['Bo', 'Cy', 'Di', 'Al', 'Ava', 'Zed'],
  );
});

test('open tasks by project: my projects first — each of them — then the others; a limit on the whole, and what was left out is counted', () => {
  const mine = [{ id: 'n', name: 'Notes' }, { id: 'a', name: 'Atlas' }, { id: 'e', name: 'Empty' }];
  const all = { n: mine[0], a: mine[1], e: mine[2], s: { id: 's', name: 'Shared platform' } } as any;
  const t = (id: string, projectId: string) => ({ id, projectId, status: 'IN_PROGRESS' as const });
  const tasks = [t('1', 'n'), t('2', 's'), t('3', 'a'), t('4', 'n'), t('5', 'n'), t('6', 'gone')];
  const got = tasksByProject(tasks, mine, all, 4);
  assert.deepEqual(got.map((g) => [g.project?.name ?? null, g.mine, g.tasks.map((x) => x.id).join(''), g.more]), [
    ['Atlas', true, '3', 0],
    ['Empty', true, '', 0],
    ['Notes', true, '14', 1],
    [null, false, '', 1],
    ['Shared platform', false, '2', 0],
  ]);
  // Nothing open anywhere: my projects are still there to be seen.
  assert.deepEqual(tasksByProject([], mine, all, 4).map((g) => g.project!.name), ['Atlas', 'Empty', 'Notes']);
});

test('the window’s one line', () => {
  assert.equal(myWorkLine({ employees: 3, working: 2, tasks: 2, waiting: 0 }), '3 employees, 2 working · 2 open tasks');
  assert.equal(myWorkLine({ employees: 1, working: 0, tasks: 1, waiting: 1 }), '1 employee, 0 working · 1 open task · 1 waiting for you');
  assert.equal(myWorkLine({ employees: 0, working: 0, tasks: 0, waiting: 0 }), 'Nobody of your own yet');
  assert.equal(myWorkLine({ employees: 0, working: 0, tasks: 4, waiting: 0 }), 'Nobody of your own yet · 4 open tasks');
});

test('how a task stands, and the small lines', () => {
  assert.deepEqual(taskState('BLOCKED'), { word: 'blocked', tone: 'bad' });
  assert.deepEqual(taskState('REVIEW'), { word: 'in review', tone: 'warn' });
  assert.deepEqual(taskState('IN_PROGRESS'), { word: 'in progress', tone: 'calm' });
  assert.deepEqual(taskState('READY'), { word: 'ready', tone: 'calm' });
  assert.equal(askLine('Mil-1', 'permission'), 'Mil-1 asks to be allowed something');
  assert.equal(askLine(undefined, 'question'), 'An employee asks you something');
  assert.equal(projectLine(3, 8), '3 of 8 done');
  assert.equal(projectLine(0, 0), 'no tasks yet');
});
