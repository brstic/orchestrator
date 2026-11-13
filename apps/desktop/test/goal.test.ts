import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalCommand, goalStillShown, goalWords } from '../src/lib/goal.ts';

test('/goal in the box one talks to an employee in, as in Claude Code', () => {
  assert.deepEqual(goalCommand('/goal every test in packages/api passes'), { kind: 'set', condition: 'every test in packages/api passes' });
  assert.deepEqual(goalCommand('  /GOAL   the release is out\nand announced  '), { kind: 'set', condition: 'the release is out\nand announced' });
  assert.deepEqual(goalCommand('/goal clear'), { kind: 'clear' });
  assert.deepEqual(goalCommand('/goal stop'), { kind: 'clear' });
  assert.deepEqual(goalCommand('/goal'), { kind: 'show' });
  // Anything else is a message.
  for (const text of ['set a goal for the release', 'the /goal command', '/goals', '/goalkeeper']) assert.equal(goalCommand(text), null, text);
});

test('how a goal is said, and how long one that ended is still shown', () => {
  const base = { condition: 'x', check: null, setBy: { kind: 'owner' as const, id: null, name: 'the boss' }, setAt: '2026-11-13T10:00:00.000Z', idle: 0, outcome: null };
  assert.equal(goalWords({ ...base, status: 'active', turns: 0, endedAt: null }), 'just given');
  assert.equal(goalWords({ ...base, status: 'active', turns: 1, endedAt: null }), 'sent on 1 time');
  assert.equal(goalWords({ ...base, status: 'active', turns: 7, endedAt: null }), 'sent on 7 times');
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  assert.equal(goalStillShown({ ...base, status: 'met', turns: 3, endedAt: '2026-11-13T11:00:00.000Z' }, now), true);
  assert.equal(goalStillShown({ ...base, status: 'met', turns: 3, endedAt: '2026-11-13T09:00:00.000Z' }, now), false);
  assert.equal(goalStillShown(null, now), false);
});
