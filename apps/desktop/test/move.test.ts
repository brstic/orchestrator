import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmployeeMoving } from '@orchestrator/contracts';
import { moveLine, movePercent } from '../src/lib/move.ts';

const m = (over: Partial<EmployeeMoving>): EmployeeMoving => ({ id: 'm1', fromHostId: 'a', toHostId: 'b', phase: 'sending', sent: 0, total: 0, startedAt: '', by: 'owner', error: null, ...over });

test('how far a move is: 0 while packed, what is sent, 99 while unpacked — never 100 before they are there', () => {
  assert.equal(movePercent(null), null);
  assert.equal(movePercent(m({ phase: 'packing' })), 0);
  assert.equal(movePercent(m({ sent: 50, total: 200 })), 25);
  assert.equal(movePercent(m({ sent: 200, total: 200 })), 99);
  assert.equal(movePercent(m({ phase: 'unpacking' })), 99);
  assert.equal(movePercent(m({ phase: 'failed', error: 'x' })), null);
});

test('the move in words', () => {
  assert.equal(moveLine(m({ phase: 'packing' }), 'My laptop'), 'Packing their desk for My laptop…');
  assert.equal(moveLine(m({ sent: 3 * 1024 ** 2, total: 12 * 1024 ** 2 }), 'My laptop'), 'Carrying it to My laptop: 25 % (3 MB of 12 MB)');
  assert.equal(moveLine(m({ phase: 'failed', error: 'tar failed' }), 'My laptop'), 'Moving to My laptop failed: tar failed');
});
