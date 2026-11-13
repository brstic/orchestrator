import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressOf, projectsLine } from '../src/lib/project-view.ts';

/** How a project stands, as the Projects window says it (docs/UI.md). */
const t = (...s: string[]) => s.map((status) => ({ status }));

test('where a project’s tasks are: one bar, one line', () => {
  const p = progressOf(t('DONE', 'DONE', 'IN_PROGRESS', 'ASSIGNED', 'BLOCKED', 'READY', 'BACKLOG', 'REVIEW'));
  assert.equal(p.line, '2 of 8 done · 1 in review · 2 in progress · 1 blocked');
  assert.deepEqual(p.parts.map((x) => [x.part, x.n, x.percent]), [['done', 2, 25], ['review', 1, 12.5], ['doing', 2, 25], ['blocked', 1, 12.5], ['waiting', 2, 25]]);
  assert.equal(Math.round(p.parts.reduce((n, x) => n + x.percent, 0)), 100);
  // Only what there is: a project that is all done is one part.
  assert.deepEqual(progressOf(t('DONE', 'DONE')).parts.map((x) => x.part), ['done']);
  assert.equal(progressOf(t('DONE', 'DONE')).line, '2 of 2 done');
  assert.equal(progressOf(t('READY')).line, '0 of 1 done');
  assert.deepEqual(progressOf([]), { total: 0, done: 0, parts: [], line: 'No tasks yet' });
  // A state nobody knows yet is not lost: it counts as not started.
  assert.deepEqual(progressOf(t('SOMETHING_NEW')).parts.map((x) => [x.part, x.n]), [['waiting', 1]]);
});

test('the window’s line about all the projects', () => {
  assert.equal(projectsLine([{ status: 'active' }, { status: 'paused' }, { status: 'archived' }]), '2 projects · 1 paused');
  assert.equal(projectsLine([{ status: 'active' }]), '1 project');
  assert.equal(projectsLine([{ status: 'archived' }]), 'None yet');
});
