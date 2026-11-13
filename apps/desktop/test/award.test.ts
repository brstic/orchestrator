import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awardView, monthWords } from '../src/lib/award.ts';

const look = { skin: '#e0b089', hair: '#2d2218', hairStyle: 'short' as const, shirt: '#3f82f0', pants: '#222', accessory: 'none' as const, build: 1 };
const employees = {
  a: { id: 'a', name: 'Alex', title: 'Senior Backend Engineer', appearance: look, archived: false },
  b: { id: 'b', name: 'Bea', title: 'Designer', appearance: look, archived: true },
};

test('the month is said the way people say it', () => {
  assert.equal(monthWords('2026-11'), 'November 2026');
  assert.equal(monthWords('2027-01'), 'January 2027');
  assert.equal(monthWords('nonsense'), 'nonsense');
});

test('the board shows who the office says worked the most — their face, the month, whole hours', () => {
  assert.deepEqual(awardView({ employeeOfMonth: { employeeId: 'a', month: '2026-11', ms: 7.9 * 3_600_000 } }, employees), { employeeId: 'a', name: 'Alex', title: 'Senior Backend Engineer', appearance: look, month: 'November 2026', hours: 7 });
  assert.equal(awardView({ employeeOfMonth: { employeeId: 'a', month: '2026-11', ms: 60_000 } }, employees)!.hours, 0);
});

test('nobody is on the board before anybody has worked, in an office that does not count yet, or when they have left', () => {
  assert.equal(awardView(null, employees), null);
  assert.equal(awardView({}, employees), null, 'an office that has not been updated');
  assert.equal(awardView({ employeeOfMonth: null }, employees), null);
  assert.equal(awardView({ employeeOfMonth: { employeeId: 'gone', month: '2026-11', ms: 1 } }, employees), null);
  assert.equal(awardView({ employeeOfMonth: { employeeId: 'b', month: '2026-11', ms: 1 } }, employees), null, 'archived');
});
