import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_TRAIL, stepInto, toneOf, took, withKeys } from '../src/lib/live-line.ts';

test('the line keeps the last step while the session is back to thinking, and forgets it between turns', () => {
  let t = stepInto(NO_TRAIL, true, null, 't0');
  assert.deepEqual(t, NO_TRAIL, 'thinking, nothing done yet');
  t = stepInto(t, true, 'Read src/auth.ts', 't1');
  assert.deepEqual(t, { last: 'Read src/auth.ts', steps: 1, at: 't1' });
  // Back to thinking: the step stays on the line. The same moment told twice is one step.
  assert.equal(stepInto(t, true, null, 't2'), t);
  assert.equal(stepInto(t, true, 'Read src/auth.ts', 't1'), t);
  // The same file read again later is another step.
  t = stepInto(t, true, 'Read src/auth.ts', 't3');
  t = stepInto(t, true, ' Edit src/auth.ts ', 't4');
  assert.deepEqual(t, { last: 'Edit src/auth.ts', steps: 3, at: 't4' });
  // The turn is over: nothing is remembered (and nothing changes when there was nothing).
  assert.equal(stepInto(t, false, null, 't5'), NO_TRAIL);
  assert.equal(stepInto(NO_TRAIL, false, 'x', 't6'), NO_TRAIL);
});

test('how long, in words short enough to change every second', () => {
  assert.deepEqual([took(-5), took(0), took(8_400), took(125_000), took(3_600_000 + 12 * 60_000 + 3_000)], ['0 s', '0 s', '8 s', '2 min 05 s', '1 h 12 min']);
});

test('every activity has a colour family; one nobody knows is quiet', () => {
  assert.deepEqual(['thinking', 'reading', 'coding', 'running_command', 'testing', 'needs_approval', 'blocked', 'idle', 'whatever'].map(toneOf), ['think', 'read', 'write', 'run', 'test', 'wait', 'bad', 'quiet', 'quiet']);
});

test('ticket keys in a line are found, and nothing else is', () => {
  assert.deepEqual(withKeys('Marko completed T-210: Studio /new, after T-203').filter((p) => p.key).map((p) => p.text), ['T-210', 'T-203']);
  assert.equal(withKeys('Marko completed T-210: Studio').map((p) => p.text).join(''), 'Marko completed T-210: Studio');
  assert.deepEqual(withKeys('utf-8 and x-1 are not keys'), [{ text: 'utf-8 and x-1 are not keys', key: false }]);
  assert.deepEqual(withKeys(''), []);
});
