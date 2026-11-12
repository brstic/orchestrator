import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutEmployee, askLine, employeeState, myWorkLine, projectLine, taskState } from '../src/lib/my-work.ts';

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

test('the phrase under an employee: what they are, on what, doing what — the machine only where there are several', () => {
  const e = { title: 'Frontend Engineer' };
  assert.equal(aboutEmployee(e, { project: "Mila's notes", machine: "Mila's computer", machines: 1, task: { key: 'T-9', title: 'Notes, part 1' } }), "Frontend Engineer · Mila's notes · T-9 Notes, part 1");
  assert.equal(aboutEmployee(e, { project: "Mila's notes", machine: 'box', machines: 2 }), "Frontend Engineer · Mila's notes · box");
  assert.equal(aboutEmployee(e, { machines: 1 }), 'Frontend Engineer');
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
