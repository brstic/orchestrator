import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOVER_FOR, IDLE_AFTER, RESTING_FPS, drawCap } from '../src/pace.ts';

test('the office is drawn no faster than it is looked at: in full while worked in, resting behind another window or left alone, not at all when it cannot be seen', () => {
  assert.equal(drawCap({ shown: true, focused: true, idleMs: 1000 }), Infinity);
  assert.equal(drawCap({ shown: true, focused: false, idleMs: HOVER_FOR }), RESTING_FPS, 'another window has the focus');
  assert.equal(drawCap({ shown: true, focused: false, idleMs: 1000 }), Infinity, 'the mouse moves over it: somebody looks');
  assert.equal(drawCap({ shown: true, focused: true, idleMs: IDLE_AFTER }), RESTING_FPS, 'nobody touched it for a while');
  assert.equal(drawCap({ shown: true, focused: true, idleMs: IDLE_AFTER - 1 }), Infinity);
  assert.equal(drawCap({ shown: false, focused: true, idleMs: 0 }), 0, 'minimized or hidden');
  assert.equal(RESTING_FPS, 30);
});
