import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exhausted } from '../src/registry.ts';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 3600_000;

test('an account is used up while a window is full and has not reset', () => {
  assert.equal(exhausted({ fiveHour: { usedPercent: 99, resetsAt: ahead(H) }, sevenDay: null }), true);
  assert.equal(exhausted({ fiveHour: { usedPercent: 99, resetsAt: ago(H) }, sevenDay: null }), false);
  assert.equal(exhausted({ fiveHour: { usedPercent: 98, resetsAt: ahead(H) }, sevenDay: { usedPercent: 40, resetsAt: ahead(H) } }), false);
  assert.equal(exhausted({ fiveHour: null, sevenDay: null, spentUntil: ahead(H) }), true);
  assert.equal(exhausted({ fiveHour: null, sevenDay: null, spentUntil: ago(H) }), false);
});

test('a full window that names no reset time is believed for as long as the window is — not for ever', () => {
  // Just reported (or no time known at all: a report that is being looked at right now).
  assert.equal(exhausted({ fiveHour: { usedPercent: 100, resetsAt: null }, sevenDay: null }), true);
  assert.equal(exhausted({ fiveHour: { usedPercent: 100, resetsAt: null }, sevenDay: null, reportedAt: ago(H) }), true);
  // Nobody has been on the account since: after five hours the five-hour figure says nothing any more.
  assert.equal(exhausted({ fiveHour: { usedPercent: 100, resetsAt: null }, sevenDay: null, reportedAt: ago(6 * H) }), false);
  assert.equal(exhausted({ fiveHour: null, sevenDay: { usedPercent: 100, resetsAt: null }, reportedAt: ago(6 * H) }), true);
  assert.equal(exhausted({ fiveHour: null, sevenDay: { usedPercent: 100, resetsAt: null }, reportedAt: ago(8 * 24 * H) }), false);
});
