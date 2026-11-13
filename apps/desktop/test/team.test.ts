import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byProject, levelLine, teamLine } from '../src/lib/team.ts';

/** The order of the Team window (docs/UI.md). */

test('people stand under their projects, by the project’s name; whoever has none comes last', () => {
  const projects = { p: { id: 'p', name: 'Platform' }, a: { id: 'a', name: 'Atlas' } } as any;
  const e = (name: string, projectId: string | null) => ({ name, projectId });
  const got = byProject([e('Zed', 'p'), e('Ava', null), e('Bo', 'a'), e('Al', 'p'), e('Cy', 'gone')], projects);
  assert.deepEqual(got.map((g) => [g.project?.name ?? null, g.people.map((x) => x.name).join(' ')]), [['Atlas', 'Bo'], ['Platform', 'Zed Al'], [null, 'Ava Cy']]);
  assert.deepEqual(byProject([], projects), []);
});

test('the window’s one line, and the line about a level', () => {
  assert.equal(teamLine({ employees: 16, working: 11, archived: 0 }), '16 employees · 11 working');
  assert.equal(teamLine({ employees: 1, working: 0, archived: 2 }), '1 employee · 0 working · 2 archived');
  assert.equal(teamLine({ employees: 0, working: 0, archived: 0 }), 'Nobody works here yet');
  assert.equal(teamLine({ employees: 0, working: 0, archived: 3 }), 'Nobody on the team · 3 archived');
  assert.equal(levelLine(1, 0, 150), 'Level 1 · 0 XP · 150 to level 2');
  assert.equal(levelLine(3, 1420, 1500), 'Level 3 · 1,420 XP · 80 to level 4');
  assert.equal(levelLine(9, 99000, null), 'Level 9 · 99,000 XP · top level');
});
