/**
 * An office that stands somewhere (`OwnerSettings.surroundings`): where its outer walls get windows, how large the
 * floor under it is, and that the place is the same for everybody who looks at it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURROUNDINGS, defaultLayout, surroundingsOf } from '@orchestrator/contracts';
import { withMemberRooms, type MemberHost } from '../src/member-rooms.ts';
import { buildWorld, moveWithCollision, wallFixtures, type Box, type Wall } from '../src/world.ts';
import { fbm2, noise2, rng } from '../src/surroundings/kit.ts';
import { glazed, plateOf } from '../src/surroundings/windows.ts';

const layout = defaultLayout();
const none = new Set<string>();
const host = (n: number, employees: number): MemberHost => ({ hostId: `host-${n}`, memberId: `member-${n}`, memberName: `Member ${n}`, employeeIds: Array.from({ length: employees }, (_x, i) => `emp-${n}-${i}`) });
const length = (w: Wall) => Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
const alongX = (w: Wall) => Math.abs(w.z2 - w.z1) < 1e-6;
/** The ground a wall stands on and a little to each side of it. */
const strip = (w: Wall, reach: number): Box => ({ minX: Math.min(w.x1, w.x2) - (alongX(w) ? 0 : reach), maxX: Math.max(w.x1, w.x2) + (alongX(w) ? 0 : reach), minZ: Math.min(w.z1, w.z2) - (alongX(w) ? reach : 0), maxZ: Math.max(w.z1, w.z2) + (alongX(w) ? reach : 0) });
const overlap = (a: Box, b: Box): boolean => a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6 && a.minZ < b.maxZ - 1e-6 && a.maxZ > b.minZ + 1e-6;
const key = (w: Wall) => (alongX(w) ? `z${w.z1.toFixed(3)}` : `x${w.x1.toFixed(3)}`);

test('a stored value is one of the places an office can stand in, or the plain one', () => {
  for (const kind of SURROUNDINGS) assert.equal(surroundingsOf(kind), kind);
  for (const other of [undefined, null, '', 'moon', 7, {}, ['park']]) assert.equal(surroundingsOf(other), 'studio');
});

test('the outer walls get windows, and the building is still closed all the way round', () => {
  const world = buildWorld(layout, none);
  const walls = glazed(world);
  const windows = walls.filter((w) => w.glass && w.outer);
  assert.ok(windows.length >= 6, `windows: ${windows.length}`);
  // On every side of the building.
  const b = world.bounds;
  for (const [side, at] of [['north', `z${b.minZ.toFixed(3)}`], ['south', `z${b.maxZ.toFixed(3)}`], ['west', `x${b.minX.toFixed(3)}`], ['east', `x${b.maxX.toFixed(3)}`]] as const) assert.ok(windows.some((w) => key(w) === at), `no window on the ${side} side`);
  // Each line of wall is as long as it was, piece after piece, with nothing missing and nothing twice.
  const sum = (list: Wall[]) => {
    const by = new Map<string, number>();
    for (const w of list.filter((x) => x.outer)) by.set(key(w), (by.get(key(w)) ?? 0) + length(w));
    return by;
  };
  const before = sum(world.walls);
  const after = sum(walls);
  for (const [line, total] of before) assert.ok(Math.abs((after.get(line) ?? 0) - total) < 1e-6, `${line}: ${after.get(line)} of ${total}`);
  const outer = walls.filter((w) => w.outer).sort((p, q) => key(p).localeCompare(key(q)) || Math.min(p.x1, p.x2) + Math.min(p.z1, p.z2) - Math.min(q.x1, q.x2) - Math.min(q.z1, q.z2));
  for (let i = 1; i < outer.length; i++) {
    if (key(outer[i]!) !== key(outer[i - 1]!)) continue;
    assert.ok(!overlap(strip(outer[i]!, 0.01), strip(outer[i - 1]!, 0.01)), 'two pieces of one wall overlap');
  }
  // The walls inside are as they were.
  assert.deepEqual(walls.filter((w) => !w.outer), world.walls.filter((w) => !w.outer));
});

test('a window is long enough to be one, and never behind something that hangs on the wall or stands against it', () => {
  const world = buildWorld(layout, none);
  const windows = glazed(world).filter((w) => w.glass && w.outer);
  const things = [...wallFixtures(world), ...world.solids];
  for (const w of windows) {
    assert.ok(length(w) >= 1.6 - 1e-6, `a window of ${length(w).toFixed(2)} m`);
    const hit = things.find((t) => overlap(strip(w, 0.5), t));
    assert.equal(hit, undefined, `a window at ${JSON.stringify(w)} is behind ${JSON.stringify(hit)}`);
  }
  // The project board, the wall of screens, the whiteboard and the TV keep a wall behind them.
  for (const [name, at] of [['the board', world.board], ['the whiteboard', world.whiteboard], ['the TV', world.tv]] as const) {
    if (!at) continue;
    const here: Box = { minX: at.x - 0.6, maxX: at.x + 0.6, minZ: at.z - 0.6, maxZ: at.z + 0.6 };
    assert.ok(!windows.some((w) => overlap(strip(w, 0.3), here)), `${name} hangs in front of glass`);
  }
});

test('glass is only what is drawn: the world, and what can be walked through, are untouched', () => {
  const world = buildWorld(layout, none);
  const wallsBefore = JSON.stringify(world.walls);
  const obstacles = world.obstacles.length;
  const windows = glazed(world).filter((w) => w.glass && w.outer);
  assert.equal(JSON.stringify(world.walls), wallsBefore);
  assert.equal(world.obstacles.length, obstacles);
  // Walking at a window from inside ends at the window.
  for (const w of windows.slice(0, 6)) {
    const mx = (w.x1 + w.x2) / 2;
    const mz = (w.z1 + w.z2) / 2;
    const inward = alongX(w) ? [0, mz > 0 ? -1 : 1] : [mx > 0 ? -1 : 1, 0];
    const from = [mx + inward[0]! * 0.6, mz + inward[1]! * 0.6] as const;
    let [x, z] = from;
    for (let i = 0; i < 40; i++) [x, z] = moveWithCollision(world, x, z, -inward[0]! * 0.05, -inward[1]! * 0.05);
    assert.ok(Math.abs(x) <= world.bounds.maxX && Math.abs(z) <= world.bounds.maxZ, `walked out through a window at ${mx.toFixed(1)}, ${mz.toFixed(1)}`);
  }
});

test('no window where a member has a room on the other side of the wall', () => {
  const office = withMemberRooms(layout, [host(0, 3), host(1, 9), host(2, 0), host(3, 5)]);
  const world = buildWorld(office.layout, none);
  assert.equal(world.memberRooms.length, 4);
  const windows = glazed(world).filter((w) => w.glass && w.outer);
  assert.ok(windows.length > 0);
  for (const r of world.memberRooms) {
    const room: Box = { minX: r.x, maxX: r.x + r.w, minZ: r.z, maxZ: r.z + r.d };
    assert.ok(!windows.some((w) => overlap(strip(w, 0.4), room)), `a window looks into ${r.memberName}'s room`);
  }
  // Member rooms have no windows of their own: only the building's outer walls do.
  const b = world.base.bounds;
  for (const w of windows) assert.ok([b.minX, b.maxX].some((x) => Math.abs(w.x1 - x) < 1e-6 && Math.abs(w.x2 - x) < 1e-6) || [b.minZ, b.maxZ].some((z) => Math.abs(w.z1 - z) < 1e-6 && Math.abs(w.z2 - z) < 1e-6), 'a window that is not on the building');
});

test('the floor under the office: room to walk round the building, and under every member room however deep', () => {
  const plain = buildWorld(layout, none);
  const p0 = plateOf(plain);
  assert.deepEqual(p0, { minX: plain.bounds.minX - 9, maxX: plain.bounds.maxX + 9, minZ: plain.bounds.minZ - 9, maxZ: plain.bounds.maxZ + 9 });
  // Small rooms fit on it as it is; the largest make it wider, and only where they are.
  const small = buildWorld(withMemberRooms(layout, [host(0, 1)]).layout, none);
  assert.deepEqual(plateOf(small), p0);
  const big = buildWorld(withMemberRooms(layout, [host(0, 20), host(1, 20), host(2, 20)]).layout, none);
  const p = plateOf(big);
  for (const r of big.memberRooms) assert.ok(r.x >= p.minX + 2.9 && r.x + r.w <= p.maxX - 2.9 && r.z >= p.minZ + 2.9 && r.z + r.d <= p.maxZ - 2.9, `${r.memberName}'s room hangs over the edge`);
  assert.ok(p.maxX - p.minX > p0.maxX - p0.minX || p.maxZ - p.minZ > p0.maxZ - p0.minZ, 'the floor did not grow');
  assert.equal(p.maxZ, p0.maxZ, 'no room is ever attached to the south side, where the door is');
  for (const v of Object.values(p)) assert.equal(v * 2, Math.round(v * 2), 'to the half metre, so it is not made again for nothing');
});

test('a place is the same for everybody: what it is scattered with comes from numbers that repeat', () => {
  const a = rng(77120);
  const b = rng(77120);
  const first = Array.from({ length: 200 }, () => a());
  assert.deepEqual(first, Array.from({ length: 200 }, () => b()));
  assert.ok(first.every((v) => v >= 0 && v < 1));
  assert.ok(new Set(first.map((v) => v.toFixed(6))).size > 190, 'the numbers repeat among themselves');
  assert.notDeepEqual(first.slice(0, 5), Array.from({ length: 5 }, rng(77121)));
  for (const [x, z] of [[0, 0], [12.5, -3.25], [-801.2, 440.9], [1e4, -1e4]]) {
    assert.equal(noise2(x!, z!, 3), noise2(x!, z!, 3));
    assert.ok(noise2(x!, z!, 3) >= 0 && noise2(x!, z!, 3) <= 1);
    assert.ok(fbm2(x!, z!, 4, 3) >= 0 && fbm2(x!, z!, 4, 3) <= 1);
  }
  // Smooth: a step of a centimetre moves the ground by next to nothing (hills, not cliffs).
  assert.ok(Math.abs(fbm2(10, 10, 4, 1) - fbm2(10.0001, 10, 4, 1)) < 1e-3);
});
