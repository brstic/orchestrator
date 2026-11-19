import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOL_FOR, HOVER_FOR, IDLE_AFTER, RESTING_FPS, SAVING_FPS, SAVING_RESTING_FPS, WORKING_FPS, drawCap, isWarm, powerSaving } from '../src/pace.ts';

test('the office is drawn no faster than it is looked at: at the working pace while worked in, resting behind another window or left alone, not at all when it cannot be seen', () => {
  assert.equal(drawCap({ shown: true, focused: true, idleMs: 1000 }), WORKING_FPS, 'no faster than the eye gains from, on any setting');
  assert.equal(WORKING_FPS, 75);
  assert.equal(drawCap({ shown: true, focused: false, idleMs: HOVER_FOR }), RESTING_FPS, 'another window has the focus');
  assert.equal(drawCap({ shown: true, focused: false, idleMs: 1000 }), WORKING_FPS, 'the mouse moves over it: somebody looks');
  assert.equal(drawCap({ shown: true, focused: true, idleMs: IDLE_AFTER }), RESTING_FPS, 'nobody touched it for a while');
  assert.equal(drawCap({ shown: true, focused: true, idleMs: IDLE_AFTER - 1 }), WORKING_FPS);
  assert.equal(drawCap({ shown: false, focused: true, idleMs: 0 }), 0, 'minimized or hidden');
  assert.equal(RESTING_FPS, 30);
});

test('on battery, on a warm computer, or by choice, the office is drawn at half of each pace', () => {
  for (const saving of ['battery', 'warm', 'chosen'] as const) {
    assert.equal(drawCap({ shown: true, focused: true, idleMs: 1000, saving }), SAVING_FPS);
    assert.equal(drawCap({ shown: true, focused: false, idleMs: HOVER_FOR, saving }), SAVING_RESTING_FPS);
    assert.equal(drawCap({ shown: false, focused: true, idleMs: 0, saving }), 0);
  }
  assert.equal(SAVING_FPS, 30);
  assert.equal(SAVING_RESTING_FPS, 15);
});

test('which computers save: auto on battery and while warm (and a while after), always when chosen, never on full', () => {
  const cool = { battery: false, thermal: 'nominal' };
  const t = 1_000_000;
  assert.equal(powerSaving('auto', cool, -Infinity, t), null, 'plugged in and cool: the full pace');
  assert.equal(powerSaving('auto', { battery: true, thermal: 'nominal' }, -Infinity, t), 'battery');
  assert.equal(powerSaving('auto', { battery: false, thermal: 'fair' }, -Infinity, t), 'warm', 'fair is already warm on a fanless laptop');
  assert.equal(powerSaving('auto', { battery: false, thermal: 'serious' }, -Infinity, t), 'warm');
  assert.equal(powerSaving('auto', { battery: false, thermal: null }, -Infinity, t), null, 'a computer that does not say (a browser without the API)');
  assert.equal(powerSaving('auto', cool, t - COOL_FOR + 1, t), 'warm', 'just cooled down: not back and forth');
  assert.equal(powerSaving('auto', cool, t - COOL_FOR, t), null);
  assert.equal(isWarm('fair'), true);
  assert.equal(isWarm('nominal'), false);
  assert.equal(powerSaving('save', cool, -Infinity, t), 'chosen');
  assert.equal(powerSaving('full', { battery: true, thermal: 'critical' }, t, t), null, 'their choice');
});

test('behind a window of the app that covers most of the office (Tasks, a terminal), it is drawn at the resting pace while they work in that window', () => {
  assert.equal(drawCap({ shown: true, focused: true, idleMs: 0, covered: true }), RESTING_FPS);
  assert.equal(drawCap({ shown: true, focused: true, idleMs: 0, covered: true, saving: 'battery' }), SAVING_RESTING_FPS);
  assert.equal(drawCap({ shown: false, focused: true, idleMs: 0, covered: true }), 0);
  assert.equal(drawCap({ shown: true, focused: true, idleMs: 0, covered: false }), WORKING_FPS);
});
