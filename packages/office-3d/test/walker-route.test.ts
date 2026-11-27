import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, deskSeat } from '@orchestrator/contracts';
import { WALK_STOP_MS, walkStopAt, walkStops } from '../src/walker-route.ts';
import { withMemberRooms, type MemberHost } from '../src/member-rooms.ts';
import { buildWorld } from '../src/world.ts';

const layout = defaultLayout();
const none = new Set<string>();
const member = (n: number, employees: number, locked = false): MemberHost => ({ hostId: `host-${n}`, memberId: `member-${n}`, memberName: `Member ${n}`, locked, employeeIds: Array.from({ length: employees }, (_x, i) => `emp-${n}-${i}`) });

test('the walk: everyone with a desk, in the order the desks stand, each stop beside the chair and reachable on foot', () => {
  const world = buildWorld(layout, none);
  const desks = layout.desks.filter((d) => d.kind !== 'executive').slice(0, 6);
  // Given out of order, with someone who has no desk and someone at a desk that does not exist.
  const seated = [...desks.map((d, i) => ({ id: `e${i}`, deskId: d.id })).reverse(), { id: 'standing', deskId: null }, { id: 'ghost', deskId: 'no-such-desk' }];
  const stops = walkStops(world, seated);
  assert.deepEqual(stops.map((s) => s.id), desks.map((_d, i) => `e${i}`), 'desk order, whatever order people come in; nobody without a real desk');
  const reachable = world.nav.reach(world.spawn.x, world.spawn.z);
  for (const [i, s] of stops.entries()) {
    const seat = deskSeat(desks[i]!);
    const d = Math.hypot(s.x - seat.x, s.z - seat.z);
    assert.ok(d > 0.5 && d < 2.2, `stands beside ${desks[i]!.id}, not on it (${d.toFixed(2)} m from the chair)`);
    assert.ok(world.nav.walkable(s.x, s.z) && reachable(s.x, s.z), `${desks[i]!.id}: a place one can walk to`);
    // Facing the person.
    assert.ok(Math.abs(Math.atan2(seat.x - s.x, seat.z - s.z) - s.rot) < 1e-6);
  }
  assert.deepEqual(walkStops(world, []), []);
});

test('the walk goes through members\' rooms that are open and passes by the ones that are locked', () => {
  const office = withMemberRooms(layout, [member(0, 3), member(1, 2, true)]);
  const world = buildWorld(office.layout, none);
  const shared = layout.desks.filter((d) => d.kind !== 'executive').slice(0, 2).map((d, i) => ({ id: `shared-${i}`, deskId: d.id }));
  const personal = [...office.deskOf].map(([id, deskId]) => ({ id, deskId }));
  assert.equal(personal.length, 5);
  const stops = walkStops(world, [...personal, ...shared]).map((s) => s.id);
  assert.deepEqual(stops, ['shared-0', 'shared-1', 'emp-0-0', 'emp-0-1', 'emp-0-2'], 'the shared floor first, then the open room; nobody from the locked one');
  // The same people with the second member back: their room is on the walk too.
  const open = withMemberRooms(layout, [member(0, 3), member(1, 2)]);
  const again = walkStops(buildWorld(open.layout, none), [...open.deskOf].map(([id, deskId]) => ({ id, deskId }))).map((s) => s.id);
  assert.deepEqual(again, ['emp-0-0', 'emp-0-1', 'emp-0-2', 'emp-1-0', 'emp-1-1']);
});

test('which desk it is time for depends only on the clock: every computer shows the walker at the same one', () => {
  assert.equal(walkStopAt(0, 123456), -1, 'nobody to visit');
  assert.equal(walkStopAt(5, 0), 0);
  assert.equal(walkStopAt(5, WALK_STOP_MS - 1), 0);
  assert.equal(walkStopAt(5, WALK_STOP_MS), 1);
  assert.equal(walkStopAt(5, WALK_STOP_MS * 5), 0, 'round and round');
  const now = Date.now();
  assert.equal(walkStopAt(7, now), walkStopAt(7, now));
});
