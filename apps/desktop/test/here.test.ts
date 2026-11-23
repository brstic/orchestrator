import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HERE_IDLE_MS, isHere } from '../src/lib/here.ts';

test('here: the window in front, visible, and touched in the last minutes — open all day is not enough', () => {
  const now = 1_000_000_000;
  assert.equal(isHere({ visible: true, focused: true, lastInput: now - 1000, now }), true);
  assert.equal(isHere({ visible: true, focused: false, lastInput: now - 1000, now }), false, 'another window in front');
  assert.equal(isHere({ visible: false, focused: true, lastInput: now - 1000, now }), false, 'hidden');
  assert.equal(isHere({ visible: true, focused: true, lastInput: now - HERE_IDLE_MS - 1, now }), false, 'not touched for a while');
});
