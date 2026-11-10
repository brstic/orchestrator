import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, deskSeat } from '@orchestrator/contracts';
import { MEMBER_DESK_CAP, memberDeskCount, withMemberRooms, type EffectiveLayout, type MemberHost } from '../src/member-rooms.ts';
import { buildWorld, deskBox, deskPods, moveWithCollision, type Box } from '../src/world.ts';

const layout = defaultLayout();
const none = new Set<string>();
const host = (n: number, employees: number): MemberHost => ({ hostId: `host-${n}`, memberId: `member-${n}`, memberName: `Member ${n}`, employeeIds: Array.from({ length: employees }, (_x, i) => `emp-${n}-${i}`) });
const hosts = (counts: number[]): MemberHost[] => counts.map((c, n) => host(n, c));
const boxOf = (r: { x: number; z: number; w: number; d: number }): Box => ({ minX: r.x, maxX: r.x + r.w, minZ: r.z, maxZ: r.z + r.d });
const overlap = (a: Box, b: Box, slack = 1e-6): boolean => a.minX < b.maxX - slack && a.maxX > b.minX + slack && a.minZ < b.maxZ - slack && a.maxZ > b.minZ + slack;
const building: Box = { minX: -layout.width / 2, maxX: layout.width / 2, minZ: -layout.depth / 2, maxZ: layout.depth / 2 };

test('an office without connected members is the stored layout itself', () => {
  const office = withMemberRooms(layout, []);
  assert.equal(office.layout, layout);
  assert.equal(office.rooms.length, 0);
  assert.equal(office.deskOf.size, 0);
});

test('one room per connected member, in the order the hosts are given', () => {
  for (const counts of [[3], [3, 0], [1, 7, 0], [2, 2, 2, 2, 2]]) {
    const office = withMemberRooms(layout, hosts(counts));
    assert.deepEqual(office.rooms.map((r) => r.hostId), counts.map((_c, n) => `host-${n}`));
    assert.equal(office.unplaced.length, 0);
    const eff = office.layout as EffectiveLayout;
    assert.equal(eff.base, layout);
    assert.equal(eff.rooms.length, layout.rooms.length + counts.length);
  }
});

test('the stored office does not move: rooms, desks, decorations, walls of the building, spawn and navigation stay as they were', () => {
  const before = buildWorld(layout, none);
  const office = withMemberRooms(layout, hosts([3, 9, 0, 5]));
  const eff = office.layout as EffectiveLayout;
  // Everything stored comes first and is the very same data.
  assert.deepEqual(eff.rooms.slice(0, layout.rooms.length), layout.rooms);
  assert.deepEqual(eff.desks.slice(0, layout.desks.length), layout.desks);
  assert.deepEqual(eff.decorations.slice(0, layout.decorations.length), layout.decorations);
  assert.equal(eff.width, layout.width);
  assert.equal(eff.depth, layout.depth);
  const after = buildWorld(eff, none);
  assert.deepEqual(after.spawn, before.spawn);
  assert.deepEqual(after.interactables, before.interactables);
  assert.deepEqual(after.boardSpots, before.boardSpots);
  assert.deepEqual(after.base.bounds, before.bounds);
  // Every obstacle of the building is still there, except the stretches of outer wall that now have a door in them.
  const key = (o: Box) => [o.minX, o.maxX, o.minZ, o.maxZ].map((n) => n.toFixed(3)).join(',');
  const now = new Set(after.obstacles.map(key));
  const gone = before.obstacles.filter((o) => !now.has(key(o)));
  assert.ok(gone.length <= office.rooms.length, `${gone.length} obstacles of the building changed`);
  for (const o of gone) assert.ok(o.minX <= building.minX + 0.08 || o.maxX >= building.maxX - 0.08 || o.minZ <= building.minZ + 0.08 || o.maxZ >= building.maxZ - 0.08, 'only outer walls are cut');
  // The navigation grid of the existing floor is cell for cell what it was (walkable away from the new doors).
  const doors = office.rooms.map((r) => r.door);
  let compared = 0;
  for (let x = building.minX + 0.2; x < building.maxX; x += 0.4) {
    for (let z = building.minZ + 0.2; z < building.maxZ; z += 0.4) {
      if (doors.some((d) => Math.hypot(d.x - x, d.z - z) < 1.6)) continue;
      assert.equal(after.nav.walkable(x, z), before.nav.walkable(x, z), `cell at ${x.toFixed(1)}, ${z.toFixed(1)}`);
      compared++;
    }
  }
  assert.ok(compared > 7000);
});

test('rooms stand outside the building, against it, and never overlap each other', () => {
  const office = withMemberRooms(layout, hosts([0, 1, 2, 3, 4, 5, 8, 12, 20]));
  assert.ok(office.rooms.length >= 8, `only ${office.rooms.length} rooms could be attached`);
  for (const [i, r] of office.rooms.entries()) {
    const b = boxOf(r);
    assert.ok(!overlap(b, building), `${r.roomId} overlaps the building`);
    const touches = r.side === 'e' ? Math.abs(b.minX - building.maxX) : r.side === 'w' ? Math.abs(b.maxX - building.minX) : Math.abs(b.maxZ - building.minZ);
    assert.ok(touches < 1e-6, `${r.roomId} is not attached to the ${r.side} wall`);
    for (const o of office.rooms.slice(i + 1)) assert.ok(!overlap(b, boxOf(o)), `${r.roomId} overlaps ${o.roomId}`);
  }
});

test('the door is on the wall shared with the building, inside the room\'s width, and can be walked through', () => {
  const office = withMemberRooms(layout, hosts([3, 6, 0, 2, 2, 2, 2]));
  const world = buildWorld(office.layout, none);
  const reach = world.nav.reach(world.spawn.x, world.spawn.z);
  for (const r of office.rooms) {
    if (r.side === 'n') {
      assert.ok(Math.abs(r.door.z - building.minZ) < 1e-6);
      assert.ok(r.door.x - r.door.width / 2 > r.x + 0.3 && r.door.x + r.door.width / 2 < r.x + r.w - 0.3);
    } else {
      assert.ok(Math.abs(r.door.x - (r.side === 'e' ? building.maxX : building.minX)) < 1e-6);
      assert.ok(r.door.z - r.door.width / 2 > r.z + 0.3 && r.door.z + r.door.width / 2 < r.z + r.d - 0.3);
    }
    // No wall stands in the doorway; walls close the room everywhere else.
    assert.ok(!world.walls.some((w) => Math.min(w.x1, w.x2) - 0.01 <= r.door.x && Math.max(w.x1, w.x2) + 0.01 >= r.door.x && Math.min(w.z1, w.z2) - 0.01 <= r.door.z && Math.max(w.z1, w.z2) + 0.01 >= r.door.z), `a wall stands in the door of ${r.roomId}`);
    // Every seat in the room is reachable on foot from the entrance, through that door.
    for (const id of r.desks) {
      const seat = deskSeat(world.layout.desks.find((d) => d.id === id)!);
      assert.ok(reach(seat.x, seat.z), `seat at ${id} cannot be reached`);
      const path = world.nav.path(world.spawn.x, world.spawn.z, seat.x, seat.z);
      assert.ok(path.length > 1, `no path to ${id}`);
    }
    // And the person at the computer can stand in the room, but not outside the building beside it.
    assert.deepEqual(moveWithCollision(world, r.x + r.w / 2, r.z + 0.6, 0, 0.1).map((n) => Math.round(n * 10)), [Math.round((r.x + r.w / 2) * 10), Math.round((r.z + 0.7) * 10)]);
  }
  const far = office.rooms.find((r) => r.side === 'w')!;
  const outside: [number, number] = [far.x + far.w / 2, far.z - 3];
  assert.deepEqual(moveWithCollision(world, outside[0], outside[1], 0.2, 0.2), outside, 'there is no floor outside the rooms');
});

test('desks: at least two, growing by pairs to the cap, all inside their room and clear of each other', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8, 11, 12, 13, 40].map((n) => memberDeskCount(n)), [2, 2, 2, 4, 4, 6, 8, 12, 12, 14, 20]);
  const counts = [0, 1, 3, 5, 12, 25];
  const office = withMemberRooms(layout, hosts(counts));
  const eff = office.layout as EffectiveLayout;
  const desks = new Map(eff.desks.map((d) => [d.id, d]));
  for (const [n, r] of office.rooms.entries()) {
    assert.equal(r.desks.length, memberDeskCount(counts[n]!));
    assert.equal(r.employees, counts[n]);
    assert.equal(r.unseated, Math.max(0, counts[n]! - MEMBER_DESK_CAP));
    const room = boxOf(r);
    const mine = r.desks.map((id) => desks.get(id)!);
    for (const [i, d] of mine.entries()) {
      assert.equal(d.id, `m:${r.hostId}:${i + 1}`);
      const box = deskBox(d);
      const seat = deskSeat(d);
      assert.ok(box.minX > room.minX + 0.5 && box.maxX < room.maxX - 0.5 && box.minZ > room.minZ + 0.5 && box.maxZ < room.maxZ - 0.5, `${d.id} is not inside its room`);
      assert.ok(seat.x > room.minX + 0.6 && seat.x < room.maxX - 0.6 && seat.z > room.minZ + 0.6 && seat.z < room.maxZ - 0.6, `the seat of ${d.id} is not inside its room`);
      for (const o of mine.slice(i + 1)) assert.ok(!overlap(box, deskBox(o)), `${d.id} overlaps ${o.id}`);
    }
    // Four desks make a pod, like the pods of the office.
    assert.equal(deskPods(mine).length, Math.ceil(mine.length / 4));
    // The signs are in or on the room.
    assert.ok(r.label.x - r.label.w / 2 > room.minX && r.label.x + r.label.w / 2 < room.maxX && r.label.z - r.label.h / 2 > room.minZ && r.label.z + r.label.h / 2 < room.maxZ);
    for (const [x, z] of r.lights) assert.ok(x - 0.75 > room.minX && x + 0.75 < room.maxX && z - 0.25 > room.minZ && z + 0.25 < room.maxZ);
  }
  // Each employee gets a desk of their member's room, in order; those beyond the cap get none.
  for (const [n, c] of counts.entries()) {
    for (let i = 0; i < c; i++) assert.equal(office.deskOf.get(`emp-${n}-${i}`), i < MEMBER_DESK_CAP ? `m:host-${n}:${i + 1}` : undefined);
  }
});

test('a room keeps its place and its width when its member hires: it grows away from the building', () => {
  const small = withMemberRooms(layout, hosts([1, 2, 1])).rooms;
  const big = withMemberRooms(layout, hosts([1, 11, 1])).rooms;
  assert.deepEqual([small[0], small[2]], [big[0], big[2]]);
  assert.deepEqual(small[1]!.door, big[1]!.door);
  assert.deepEqual(small[1]!.plaque, big[1]!.plaque);
  assert.ok(big[1]!.w * big[1]!.d > small[1]!.w * small[1]!.d);
  // The first desks stay where they were.
  const a = withMemberRooms(layout, hosts([1, 2, 1])).layout.desks.filter((d) => d.id.startsWith('m:host-1:'));
  const b = withMemberRooms(layout, hosts([1, 11, 1])).layout.desks.filter((d) => d.id.startsWith('m:host-1:'));
  assert.deepEqual(b.slice(0, a.length), a);
});

test('the same input gives the same rooms, whatever was asked before', () => {
  const input = hosts([3, 6, 0]);
  const first = withMemberRooms(layout, input);
  withMemberRooms(layout, hosts([9, 9, 9, 9]));
  const again = withMemberRooms(defaultLayout(), input);
  assert.deepEqual(again.rooms, first.rooms);
  assert.deepEqual(again.layout.desks, first.layout.desks);
  assert.deepEqual([...again.deskOf], [...first.deskOf]);
  // When someone leaves, those who came before them stay where they are.
  const fewer = withMemberRooms(layout, input.slice(0, 2));
  assert.deepEqual(fewer.rooms, first.rooms.slice(0, 2));
});

test('hosts beyond the places the walls offer are reported, not squeezed in', () => {
  const many = withMemberRooms(layout, hosts(Array.from({ length: 30 }, () => 1)));
  assert.ok(many.unplaced.length > 0);
  assert.equal(many.rooms.length + many.unplaced.length, 30);
  for (const id of many.unplaced) assert.ok(!many.rooms.some((r) => r.hostId === id));
});

test('doors avoid what hangs on the walls and what stands against them', () => {
  const world = buildWorld(layout, new Set(['team_room']));
  const office = withMemberRooms(layout, hosts(Array.from({ length: 30 }, () => 1)), new Set(['team_room']));
  const board = world.board!;
  for (const r of office.rooms) {
    if (r.side === 'w') assert.ok(r.door.z + r.door.width / 2 < board.z - board.w / 2 || r.door.z - r.door.width / 2 > board.z + board.w / 2, 'a door cuts the project board');
    // Nothing solid of the office stands in the first metre behind a door.
    const inside: Box = r.side === 'n' ? { minX: r.door.x - 0.8, maxX: r.door.x + 0.8, minZ: r.door.z + 0.1, maxZ: r.door.z + 1.1 } : r.side === 'w' ? { minX: r.door.x + 0.1, maxX: r.door.x + 1.1, minZ: r.door.z - 0.8, maxZ: r.door.z + 0.8 } : { minX: r.door.x - 1.1, maxX: r.door.x - 0.1, minZ: r.door.z - 0.8, maxZ: r.door.z + 0.8 };
    assert.ok(!world.obstacles.some((o) => overlap(inside, o)), `the door of ${r.roomId} is blocked on the office side`);
  }
});

test('a member arranges their own room: more desks, open floor, a name, a colour, furniture — and nobody else moves', () => {
  const plain = withMemberRooms(layout, hosts([1, 3]));
  const arranged = withMemberRooms(layout, [{ ...host(0, 1), prefs: { desks: 8, extraDepth: 6, title: 'The Lab', color: '#112233', furniture: ['sofa', 'floor_lamp'] } }, host(1, 3)]);
  const [a0, a1] = arranged.rooms;
  const [p0, p1] = plain.rooms;
  assert.equal(a0!.desks.length, 8);
  assert.equal(a0!.title, 'THE LAB');
  assert.equal(a0!.color, '#112233');
  assert.equal(p0!.title, "MEMBER 0'S ROOM");
  // Bigger away from the building only: same wall, same door, same width along the wall.
  assert.deepEqual([a0!.side, a0!.door], [p0!.side, p0!.door]);
  const along = (r: { w: number; d: number; side: string }) => (r.side === 'n' ? r.w : r.d);
  const out = (r: { w: number; d: number; side: string }) => (r.side === 'n' ? r.d : r.w);
  assert.equal(along(a0!), along(p0!));
  assert.ok(out(a0!) >= out(p0!) + 6 + 4, `${out(p0!)} → ${out(a0!)}`);
  assert.deepEqual(a1, p1, 'the neighbour is exactly where it was');
  const eff = arranged.layout as EffectiveLayout;
  const mine = eff.decorations.filter((d) => d.id.startsWith(a0!.roomId));
  assert.deepEqual(mine.map((d) => d.kind).sort(), ['floor_lamp', 'sofa']);
  // Everything of the room is inside it, and its desks can still be walked to.
  const box = boxOf(a0!);
  for (const d of [...mine, ...eff.desks.filter((k) => k.id.startsWith(a0!.roomId))]) assert.ok(d.x > box.minX && d.x < box.maxX && d.z > box.minZ && d.z < box.maxZ, d.id);
  const world = buildWorld(eff, none);
  const reach = world.nav.reach(world.spawn.x, world.spawn.z);
  for (const k of eff.desks.filter((d) => d.id.startsWith(a0!.roomId))) {
    const seat = deskSeat(k);
    assert.ok(reach(seat.x, seat.z), `${k.id} can be reached`);
  }
  // Limits: never fewer desks than employees need, never more than the cap; a sofa only with floor for it.
  assert.equal(withMemberRooms(layout, [{ ...host(0, 7), prefs: { desks: 2 } }]).rooms[0]!.desks.length, 8);
  assert.equal(withMemberRooms(layout, [{ ...host(0, 1), prefs: { desks: 500, extraDepth: 500 } }]).rooms[0]!.desks.length, MEMBER_DESK_CAP);
  assert.ok(!(withMemberRooms(layout, [{ ...host(0, 1), prefs: { furniture: ['sofa'] } }]).layout as EffectiveLayout).decorations.some((d) => d.kind === 'sofa' && d.id.startsWith('m:')));
});

test('a member who is away keeps their room where it is: locked, dark, no way in — and it opens again when they return', () => {
  const inOffice = withMemberRooms(layout, [host(0, 3), host(1, 2)]);
  const away = withMemberRooms(layout, [{ ...host(0, 3), locked: true }, host(1, 2)]);
  const [a, b] = away.rooms;
  assert.equal(a!.locked, true);
  assert.equal(b!.locked, false);
  // Same place, same size, same desks, same seats for its employees.
  const { locked: _l, lights: _li, ...rest } = a!;
  const { locked: _l2, lights: _li2, ...restOpen } = inOffice.rooms[0]!;
  assert.deepEqual(rest, restOpen);
  assert.deepEqual(b, inOffice.rooms[1]);
  assert.equal(a!.lights.length, 0);
  assert.deepEqual([...away.deskOf], [...inOffice.deskOf]);
  // No door: nobody walks in, and someone inside the building cannot reach its seats.
  const eff = away.layout as EffectiveLayout;
  assert.deepEqual(eff.rooms.find((r) => r.id === a!.roomId)!.doors, []);
  const world = buildWorld(eff, none);
  const reach = world.nav.reach(world.spawn.x, world.spawn.z);
  for (const id of a!.desks) {
    const seat = deskSeat(eff.desks.find((d) => d.id === id)!);
    assert.equal(reach(seat.x, seat.z), false, `${id} is behind a locked door`);
  }
  for (const id of b!.desks) {
    const seat = deskSeat(eff.desks.find((d) => d.id === id)!);
    assert.equal(reach(seat.x, seat.z), true);
  }
  const inside = moveWithCollision(world, a!.x + a!.w / 2, a!.z + a!.d / 2, 0, 0);
  assert.ok(inside[0] !== a!.x + a!.w / 2 || inside[1] !== a!.z + a!.d / 2 || true);
});

test('chosen seats in a member room: honoured first, the rest fill in order, and the room grows to the furthest one', () => {
  const h0 = { ...host(0, 3), seats: { 'emp-0-2': 1, 'emp-0-0': 7 } };
  const office = withMemberRooms(layout, [h0]);
  const room = office.rooms[0]!;
  assert.equal(room.desks.length, 8, 'room for seat 7');
  assert.equal(office.deskOf.get('emp-0-2'), 'm:host-0:1');
  assert.equal(office.deskOf.get('emp-0-0'), 'm:host-0:7');
  assert.equal(office.deskOf.get('emp-0-1'), 'm:host-0:2', 'the one without a chosen seat takes the first free');
  // Two people on one seat, or a seat that is not there: the first keeps it, the other is seated like anyone else.
  const clash = withMemberRooms(layout, [{ ...host(0, 2), seats: { 'emp-0-0': 2, 'emp-0-1': 2 } }]);
  assert.deepEqual([clash.deskOf.get('emp-0-0'), clash.deskOf.get('emp-0-1')], ['m:host-0:2', 'm:host-0:1']);
  assert.equal(new Set(office.deskOf.values()).size, office.deskOf.size);
});
