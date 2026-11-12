import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, deskSeat, unlockedUpgrades } from '@orchestrator/contracts';
import { buildWorld, deskPods, moveWithCollision } from '../src/world.ts';
import { addDecoration, layoutProblems, movableEdges, moveDecoration, moveDesks, removeDecoration, renameRoom, resizeRoom } from '../src/layout-edit.ts';
import { parseSgrLine } from '../src/terminal-texture.ts';

const world = buildWorld(defaultLayout(), new Set());

function pathLength(pts: Array<[number, number]>, from: [number, number]): number {
  let len = 0;
  let prev = from;
  for (const p of pts) {
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  return len;
}

/** Does a straight segment cross any wall? Sampled finely; walls are 0.14 thick. */
function crossesWall(a: [number, number], b: [number, number]): boolean {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05);
  for (let i = 0; i <= steps; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / steps;
    const z = a[1] + ((b[1] - a[1]) * i) / steps;
    for (const w of world.walls) {
      const minX = Math.min(w.x1, w.x2) - 0.07;
      const maxX = Math.max(w.x1, w.x2) + 0.07;
      const minZ = Math.min(w.z1, w.z2) - 0.07;
      const maxZ = Math.max(w.z1, w.z2) + 0.07;
      if (x > minX && x < maxX && z > minZ && z < maxZ) return true;
    }
  }
  return false;
}

test('the world has every functional area and no locked rooms', () => {
  for (const kind of ['ceo', 'meeting', 'ops', 'server', 'break', 'reception', 'open', 'hall'] as const) assert.ok(world.room(kind), kind);
  assert.equal(world.room('team'), undefined, 'the team room appears only after its milestone');
  assert.ok(buildWorld(defaultLayout(), new Set(['team_room'])).room('team'));
  assert.ok(world.meeting && world.meeting.seats.length >= 8);
  assert.ok(world.breakSpots.length >= 4);
  assert.ok(world.racks.length >= 8);
  assert.deepEqual(world.interactables.map((i) => i.kind).sort(), ['board', 'break', 'ceo', 'hifi', 'meeting', 'ops', 'reception', 'server', 'tv', 'vault']);
});

test('the vault stands in the server room, clear of the racks and the door, and the owner can walk up to it', () => {
  const sr = world.room('server')!;
  const vault = world.vault!;
  const box = { minX: vault.x - 0.45, maxX: vault.x + 0.45, minZ: vault.z - 0.6, maxZ: vault.z + 0.6 };
  assert.ok(box.minX > sr.x + 0.07 && box.maxX < sr.x + sr.w && box.minZ > sr.z && box.maxZ < sr.z + sr.d - 0.07, 'inside the server room, off its walls');
  assert.ok(Math.abs(Math.sin(vault.rot) - 1) < 1e-9, 'its door faces east, into the room');
  // People walk around it: it is one of the solid things, and nothing else stands in its place.
  assert.ok(world.solids.some((o) => Math.abs(o.minX - box.minX) < 1e-9 && Math.abs(o.maxX - box.maxX) < 1e-9 && Math.abs(o.minZ - box.minZ) < 1e-9 && Math.abs(o.maxZ - box.maxZ) < 1e-9), 'it is an obstacle');
  for (const r of world.racks) assert.ok(r.x - 0.4 > box.maxX + 0.6 || r.z + 0.525 < box.minZ - 0.6 || r.z - 0.525 > box.maxZ + 0.6, `the rack at ${r.x},${r.z} is clear of the vault`);
  // The room's door (in its south wall) is not behind it or in front of it.
  for (const d of sr.doors ?? []) {
    const c = sr.x + sr.w * d.at;
    assert.ok(d.side !== 'w' && (d.side !== 's' || c - d.width / 2 > box.maxX + 1.2), 'the door stays free');
  }
  const spot = world.interactables.find((i) => i.kind === 'vault')!;
  assert.equal(spot.label, 'VAULT — PASSWORDS AND KEYS');
  // Standing where the prompt appears is possible, it is in front of the door, and the way there from the entrance is open.
  const [x, z] = moveWithCollision(world, spot.x, spot.z, 0, 0);
  assert.ok(Math.hypot(x - spot.x, z - spot.z) < 0.05, 'the spot in front of it is free');
  assert.ok(spot.x > box.maxX + 0.3 && Math.abs(spot.z - vault.z) < 0.01 && Math.hypot(spot.x - vault.x, spot.z - vault.z) < spot.radius);
  assert.ok(world.nav.walkable(spot.x, spot.z) && world.nav.reach(world.spawn.x, world.spawn.z)(spot.x, spot.z), 'it can be walked to from the entrance');
  // In front of the vault means the vault, not the room it stands in.
  const first = world.interactables.find((i) => Math.hypot(i.x - spot.x, i.z - spot.z) < i.radius)!;
  assert.equal(first.kind, 'vault');
  const server = world.interactables.find((i) => i.kind === 'server')!;
  assert.ok(Math.hypot(server.x - spot.x, server.z - spot.z) > server.radius, 'in the default office the two circles do not meet where one stands');
});

test('the vault in an office the owner has changed: it gives way to what already stands in its corner, and fits the smallest server room', () => {
  // A plant the owner put where the vault would stand: the vault takes the other corner, facing the other way.
  const layout = defaultLayout();
  const sr = layout.rooms.find((r) => r.kind === 'server')!;
  const planted = buildWorld({ ...layout, decorations: [...layout.decorations, { id: 'plant-u1', kind: 'plant', x: sr.x + 0.6, z: sr.z + sr.d - 1.0, rot: 0 }] }, new Set());
  const moved = planted.vault!;
  assert.ok(Math.abs(moved.x - (sr.x + sr.w - 0.55)) < 1e-9 && Math.abs(Math.sin(moved.rot) + 1) < 1e-9, 'in the east corner, its door facing west');
  const at = planted.interactables.find((i) => i.kind === 'vault')!;
  assert.ok(at.x < moved.x - 0.75 && planted.nav.reach(planted.spawn.x, planted.spawn.z)(at.x, at.z), 'one stands in front of its door there too');
  const plant = planted.solids.find((o) => Math.abs(o.minX - (sr.x + 0.6 - 0.275)) < 1e-9)!;
  const safe = { minX: moved.x - 0.45, maxX: moved.x + 0.45, minZ: moved.z - 0.6, maxZ: moved.z + 0.6 };
  assert.ok(plant && !(plant.minX < safe.maxX && plant.maxX > safe.minX && plant.minZ < safe.maxZ && plant.maxZ > safe.minZ), 'the plant and the vault do not stand in each other');
  // The server room made as small as the editor allows (10.5 × 7 m): the vault is clear of the racks and can be stood in front of.
  const w = buildWorld({ ...layout, rooms: layout.rooms.map((r) => (r.kind === 'server' ? { ...r, w: 10.5, d: 7 } : r)) }, new Set());
  const v = w.vault!;
  assert.ok(Math.sin(v.rot) > 0.99, 'in its own corner');
  for (const r of w.racks) assert.ok(r.x - 0.4 > v.x + 0.45 || r.z + 0.525 < v.z - 0.6, `the rack at ${r.x},${r.z} is clear of the vault`);
  const spot = w.interactables.find((i) => i.kind === 'vault')!;
  const [x, z] = moveWithCollision(w, spot.x, spot.z, 0, 0);
  assert.ok(Math.hypot(x - spot.x, z - spot.z) < 0.05, 'the spot in front of it is free');
  assert.ok(w.nav.reach(w.spawn.x, w.spawn.z)(spot.x, spot.z), 'and can be walked to');
});

test('the hi-fi stands in the break room, out of the way, and the owner can walk up to it', () => {
  const br = world.room('break')!;
  const hifi = world.hifi!;
  assert.ok(hifi.x > br.x && hifi.x < br.x + br.w && hifi.z > br.z && hifi.z < br.z + br.d, 'inside the break room');
  const spot = world.interactables.find((i) => i.kind === 'hifi')!;
  // Standing where the prompt appears is possible (nothing solid there), and it is within reach of the stereo.
  const [x, z] = moveWithCollision(world, spot.x, spot.z, 0, 0);
  assert.ok(Math.hypot(x - spot.x, z - spot.z) < 0.05, 'the spot in front of it is free');
  assert.ok(Math.hypot(spot.x - hifi.x, spot.z - hifi.z) < spot.radius);
  // Nobody on a break is standing inside it.
  for (const s of world.breakSpots) assert.ok(Math.abs(s.x - hifi.x) > 0.6 || Math.abs(s.z - hifi.z) > 1.7, `break spot ${s.x},${s.z} is clear of the hi-fi`);
});

test('shared walls are merged and doors are real openings', () => {
  // CEO office and meeting room share the wall at x = -12: it must exist once, not twice.
  const shared = world.walls.filter((w) => Math.abs(w.x1 + 12) < 1e-6 && Math.abs(w.x2 + 12) < 1e-6);
  const covered = shared.reduce((n, w) => n + Math.abs(w.z2 - w.z1), 0);
  assert.ok(Math.abs(covered - 8.5) < 1e-6, `shared wall length ${covered}`);
  // The meeting room's glass front has a door-sized gap.
  // (Adjacent glass fronts merge into one run, so measure what falls inside the meeting room's span.)
  const line = world.walls.filter((w) => Math.abs(w.z1 + 6.5) < 1e-6 && Math.abs(w.z2 + 6.5) < 1e-6);
  const within = (w: { x1: number; x2: number }) => Math.max(0, Math.min(w.x2, -1) - Math.max(w.x1, -12));
  const frontLen = line.reduce((n, w) => n + within(w), 0);
  assert.ok(Math.abs(frontLen - (11 - 1.8)) < 1e-6, `front wall length ${frontLen}`);
  assert.ok(line.filter((w) => within(w) > 0).every((w) => w.glass));
  // The entrance: the south perimeter is not continuous.
  const south = world.walls.filter((w) => Math.abs(w.z1 - 15) < 1e-6 && Math.abs(w.z2 - 15) < 1e-6);
  assert.ok(south.reduce((n, w) => n + Math.abs(w.x2 - w.x1), 0) < 44 - 3);
});

test('employees can walk from any desk to the meeting room and the break room without crossing a wall', () => {
  const targets = [world.meeting!.seats[0]!, world.meeting!.seats[5]!, world.breakSpots[0]!, world.breakSpots[3]!];
  for (const desk of world.layout.desks.filter((_d, i) => i % 5 === 0)) {
    const seat = deskSeat(desk);
    for (const t of targets) {
      const pts = world.nav.path(seat.x, seat.z, t.x, t.z);
      assert.ok(pts.length >= 1);
      const last = pts[pts.length - 1]!;
      assert.ok(Math.hypot(last[0] - t.x, last[1] - t.z) < 1e-6, 'the path ends exactly at the destination');
      // Interior segments (between waypoints on free cells) never pass through a wall.
      let prev: [number, number] = pts[0]!;
      for (const p of pts.slice(1, -1)) {
        assert.ok(!crossesWall(prev, p), `segment from ${prev} to ${p} crosses a wall (desk ${desk.id})`);
        prev = p;
      }
      const straight = Math.hypot(t.x - seat.x, t.z - seat.z);
      const len = pathLength(pts, [seat.x, seat.z]);
      assert.ok(len < straight * 2.6 + 8, `path is unreasonably long: ${len.toFixed(1)} vs ${straight.toFixed(1)}`);
    }
  }
});

test('colleague visits path between desks, including across the floor', () => {
  const a = deskSeat(world.layout.desks[0]!);
  const b = deskSeat(world.layout.desks[world.layout.desks.length - 1]!);
  const pts = world.nav.path(a.x, a.z, b.x, b.z);
  assert.ok(pts.length >= 2, 'not a straight line through furniture');
});

test('the owner cannot walk through walls or desks, and slides along them', () => {
  // Reception → pushing north into the break room's south wall (z = 4.5) is stopped.
  let [x, z] = [16, 6];
  for (let i = 0; i < 200; i++) [x, z] = moveWithCollision(world, x, z, 0, -0.05);
  assert.ok(z > 4.5, `stopped by the wall at z=${z.toFixed(2)}`);
  // Walking diagonally into it slides sideways instead of sticking.
  let [x2, z2] = [16, 5.2];
  for (let i = 0; i < 40; i++) [x2, z2] = moveWithCollision(world, x2, z2, 0.05, -0.05);
  assert.ok(x2 > 17 && z2 > 4.5);
  // A desk is solid.
  const desk = world.layout.desks[0]!;
  let [x3, z3] = [desk.x, desk.z - 3];
  for (let i = 0; i < 200; i++) [x3, z3] = moveWithCollision(world, x3, z3, 0, 0.05);
  assert.ok(z3 < desk.z - 0.4);
  // The edge of the building is the edge of the world (except the entrance).
  let [x4, z4] = [-21, 0];
  for (let i = 0; i < 200; i++) [x4, z4] = moveWithCollision(world, x4, z4, -0.05, 0);
  assert.ok(x4 > -22);
});

test('people planning can stand at the project board: the spots are free, face the board and can be walked to', () => {
  const board = world.board!;
  assert.ok(world.boardSpots.length >= 4, `only ${world.boardSpots.length} places at the board`);
  for (const s of world.boardSpots) {
    // Nothing solid where they stand (same test as for the owner's own feet), and the navigation grid agrees.
    const [x, z] = moveWithCollision(world, s.x, s.z, 0, 0);
    assert.ok(Math.hypot(x - s.x, z - s.z) < 1e-9, `spot ${s.x},${s.z} is inside something`);
    for (const o of world.obstacles) assert.ok(!(s.x > o.minX - 0.3 && s.x < o.maxX + 0.3 && s.z > o.minZ - 0.3 && s.z < o.maxZ + 0.3), `spot ${s.x},${s.z} touches an obstacle`);
    assert.ok(world.nav.walkable(s.x, s.z), `spot ${s.x},${s.z} is not on a walkable cell`);
    // In front of the board, within reading distance, and facing it.
    const ahead = { x: s.x + Math.sin(s.rot) * 1.15, z: s.z + Math.cos(s.rot) * 1.15 };
    assert.ok(Math.abs(ahead.x - board.x) < 0.01 && Math.abs(ahead.z - board.z) <= board.w / 2, `spot ${s.x},${s.z} does not face the board`);
    assert.equal(s.sit, false);
  }
  // Nobody shares a spot.
  for (const a of world.boardSpots) for (const b of world.boardSpots) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 1, 'two people would stand on each other');
  // Reachable from the entrance and from desks across the floor, without crossing a wall.
  const reachable = world.nav.reach(world.spawn.x, world.spawn.z);
  for (const s of world.boardSpots) assert.ok(reachable(s.x, s.z), `spot ${s.x},${s.z} cannot be reached`);
  for (const desk of world.layout.desks.filter((_d, i) => i % 7 === 0)) {
    const seat = deskSeat(desk);
    const t = world.boardSpots[0]!;
    const pts = world.nav.path(seat.x, seat.z, t.x, t.z);
    const last = pts[pts.length - 1]!;
    assert.ok(Math.hypot(last[0] - t.x, last[1] - t.z) < 1e-6);
    let prev: [number, number] = pts[0]!;
    for (const p of pts.slice(1, -1)) {
      assert.ok(!crossesWall(prev, p), `walking to the board from ${desk.id} crosses a wall`);
      prev = p;
    }
  }
  // Something put where a spot would be removes that spot instead of making people stand in it.
  const first = world.boardSpots[0]!;
  const blocked = buildWorld({ ...defaultLayout(), decorations: [{ id: 'p', kind: 'plant', x: first.x, z: first.z, rot: 0 }] }, new Set());
  assert.ok(!blocked.boardSpots.some((s) => Math.hypot(s.x - first.x, s.z - first.z) < 0.5));
});

test('the whiteboard hangs on the back wall of the meeting room', () => {
  const mr = world.room('meeting')!;
  const wb = world.whiteboard!;
  assert.ok(wb.x - wb.w / 2 > mr.x && wb.x + wb.w / 2 < mr.x + mr.w);
  assert.ok(Math.abs(wb.z - mr.z) < 0.2);
});

test('desks are grouped into pods of the desks that stand together', () => {
  const pods = deskPods(defaultLayout().desks);
  assert.equal(pods.length, 8);
  assert.ok(pods.every((p) => p.deskIds.length === 4));
  assert.deepEqual(pods[0]!.deskIds, ['a-a', 'a-b', 'a-c', 'a-d']);
  // A desk taken out of a pod leaves a pod of three; a lone desk is its own pod.
  const fewer = deskPods(defaultLayout().desks.filter((d) => d.id !== 'a-b'));
  assert.deepEqual(fewer[0]!.deskIds, ['a-a', 'a-c', 'a-d']);
});

test('the floor-plan editor: the default office is sound, and edits that would break it are refused', () => {
  const all = new Set(['team_room', 'first_delivery', 'ten_tasks', 'fifty_tests']);
  const layout = defaultLayout();
  assert.deepEqual(layoutProblems(layout, new Set()), []);
  assert.deepEqual(layoutProblems(layout, all), []);
  const pod = deskPods(layout.desks).find((p) => p.id === 'c-a')!;

  // A pod moves as one, and the layout it came from is untouched.
  const moved = moveDesks(layout, all, pod.deskIds, 0.5, 0);
  assert.ok(moved.ok);
  if (moved.ok) {
    assert.equal(moved.layout.desks.find((d) => d.id === 'c-a')!.x, layout.desks.find((d) => d.id === 'c-a')!.x + 0.5);
    assert.equal(moved.layout.desks.find((d) => d.id === 'b-a')!.x, layout.desks.find((d) => d.id === 'b-a')!.x);
    assert.deepEqual(layoutProblems(moved.layout, all), []);
  }
  // Into the next pod, into a wall, out of the building: refused, with a reason.
  for (const [dx, dz] of [[-6, 0], [0, -6], [0, -40], [30, 0]] as const) {
    const r = moveDesks(layout, all, pod.deskIds, dx, dz);
    assert.ok(!r.ok && r.error.length > 5, `moving the pod by ${dx},${dz} should be refused`);
  }
  // Onto a plant: refused too.
  const plant = layout.decorations.find((d) => d.id === 'plant-3')!;
  const b = deskPods(layout.desks).find((p) => p.id === 'b-a')!;
  assert.ok(!moveDesks(layout, all, b.deskIds, plant.x - b.cx, plant.z - b.cz).ok);

  // A decoration is put on the nearest free floor — never in a desk, a wall or the owner.
  const here = { x: pod.cx, z: pod.cz };
  const added = addDecoration(layout, all, 'bookshelf', here);
  assert.ok(added.ok && added.id);
  if (added.ok) {
    const d = added.layout.decorations.find((x) => x.id === added.id)!;
    assert.deepEqual(layoutProblems(added.layout, all), []);
    assert.ok(Math.hypot(d.x - here.x, d.z - here.z) < 4, 'placed near where it was asked for');
    assert.ok(buildWorld(added.layout, all).obstacles.length === buildWorld(layout, all).obstacles.length + 1, 'it is solid');
    // Moving it into a wall is refused; a quarter turn and a free move are fine; removing it restores the layout.
    assert.ok(!moveDecoration(added.layout, all, d.id, 0, -40).ok);
    assert.ok(moveDecoration(added.layout, all, d.id, 0, 0, Math.PI / 2).ok);
    const removed = removeDecoration(added.layout, d.id);
    assert.ok(removed.ok && removed.layout.decorations.length === layout.decorations.length);
  }
  // Milestone rewards cannot be placed before they are earned, and cannot be thrown away once they are.
  assert.ok(!addDecoration(layout, new Set(), 'arcade', here).ok);
  assert.ok(addDecoration(layout, all, 'arcade', here).ok);
  assert.ok(!removeDecoration(layout, 'trophy').ok);
  assert.ok(!addDecoration(layout, all, 'jacuzzi', here).ok);

  // Rooms can be renamed.
  const renamed = renameRoom(layout, 'meeting', '  War   Room ');
  assert.ok(renamed.ok && renamed.layout.rooms.find((r) => r.id === 'meeting')!.name === 'War Room');
  assert.ok(!renameRoom(layout, 'meeting', '   ').ok);

  // Resizing: the wall between two rooms moves for both, so the floor stays tiled.
  assert.deepEqual(movableEdges(layout, 'meeting').sort(), ['e', 'w']);
  assert.deepEqual(movableEdges(layout, 'break'), ['s']);
  assert.deepEqual(movableEdges(layout, 'hall'), []);
  const wider = resizeRoom(layout, all, 'meeting', 'e', 1);
  assert.ok(wider.ok);
  if (wider.ok) {
    const m = wider.layout.rooms.find((r) => r.id === 'meeting')!;
    const o = wider.layout.rooms.find((r) => r.id === 'ops')!;
    assert.equal(m.w, 12);
    assert.equal(o.x, 0);
    assert.equal(o.w, 10);
    assert.deepEqual(layoutProblems(wider.layout, all), []);
    // The whiteboard and the table follow the room.
    assert.equal(buildWorld(wider.layout, all).whiteboard!.x, m.x + m.w / 2);
  }
  // Too small for the furniture, the outer wall, a wall shared with a longer room: refused.
  assert.ok(!resizeRoom(layout, all, 'meeting', 'e', -4).ok);
  assert.ok(!resizeRoom(layout, all, 'meeting', 'n', 1).ok);
  assert.ok(!resizeRoom(layout, all, 'meeting', 's', 1).ok);
  assert.ok(!resizeRoom(layout, all, 'hall', 's', 1).ok);
  // The break room grows into the reception, and the team room cannot grow over the desks next to it.
  const deeper = resizeRoom(layout, all, 'break', 's', 1);
  assert.ok(deeper.ok && deeper.layout.rooms.find((r) => r.id === 'reception')!.d === 9.5);
  assert.ok(resizeRoom(layout, all, 'team', 'e', 1).ok);
  assert.ok(!resizeRoom(layout, all, 'team', 'e', 3).ok, 'the team room would swallow pod h');
});

test('terminal colours are parsed from real SGR sequences', () => {
  const state = { fg: '#cfd6e2', bg: null as string | null, bold: false, dim: false, inverse: false };
  const runs = parseSgrLine('\x1b[1;32m✔ passed\x1b[0m plain \x1b[38;5;196mred\x1b[39m \x1b[48;2;10;20;30mbg\x1b[0m\x1b[?25l', state);
  assert.deepEqual(runs.map((r) => r.text), ['✔ passed', ' plain ', 'red', ' ', 'bg']);
  assert.equal(runs[0]!.bold, true);
  assert.equal(runs[0]!.fg, '#6fd08c');
  assert.equal(runs[1]!.bold, false);
  assert.equal(runs[2]!.fg, 'rgb(255,0,0)');
  assert.equal(runs[4]!.bg, 'rgb(10,20,30)');
  // State carries across lines, as it does in a terminal.
  const next = parseSgrLine('still \x1b[7minverse', { ...state, fg: '#ff6b7d' });
  assert.equal(next[0]!.fg, '#ff6b7d');
  assert.equal(next[1]!.bg, '#ff6b7d');
});

test('the TV hangs on the break room wall facing the sofa, clear of the door, and can be walked up to', () => {
  const br = world.room('break')!;
  const tv = world.tv!;
  assert.ok(Math.abs(tv.z - br.z) < 0.3 && tv.x > br.x + 1 && tv.x < br.x + br.w - 1, 'on the north wall');
  // The north door of the break room is not behind the screen or its console (3.4 m wide).
  const door = br.doors!.find((d) => d.side === 'n')!;
  const doorFrom = br.x + door.at * br.w - door.width / 2;
  const doorTo = br.x + door.at * br.w + door.width / 2;
  assert.ok(tv.x - 1.7 >= doorTo || tv.x + 1.7 <= doorFrom, `door ${doorFrom}–${doorTo} vs TV ${tv.x - 1.7}–${tv.x + 1.7}`);
  const spot = world.interactables.find((i) => i.kind === 'tv')!;
  const [x, z] = moveWithCollision(world, spot.x, spot.z, 0, 0);
  assert.ok(Math.hypot(x - spot.x, z - spot.z) < 0.05, 'the place in front of it is free');
  // Standing there means the TV, not the wider break-room circle.
  assert.equal(world.interactables.find((i) => Math.hypot(i.x - spot.x, i.z - spot.z) < i.radius)!.kind, 'tv');
  for (const s of world.breakSpots) assert.ok(Math.hypot(s.x - tv.x, s.z - (br.z + 0.36)) > 1.0, 'nobody on a break stands in the console');
});

test('what a reached milestone grants stands in the office: the arcade after ten tasks, not before', () => {
  const layout = defaultLayout();
  const milestones = [
    { key: 'ten_tasks', unlocks: 'arcade', unlockedAt: null as string | null },
    { key: 'first_delivery', unlocks: 'trophy_case', unlockedAt: null as string | null },
    { key: 'first_task', unlocks: null, unlockedAt: '2026-01-01T00:00:00.000Z' },
    { key: 'team_room', unlocks: 'team_room', unlockedAt: null as string | null },
  ];
  const stands = (id: string) => {
    const unlocked = new Set(unlockedUpgrades(milestones));
    const d = layout.decorations.find((x) => x.id === id)!;
    return !d.requires || unlocked.has(d.requires);
  };
  assert.deepEqual(unlockedUpgrades(milestones), [], 'a milestone that grants nothing opens nothing');
  assert.equal(stands('arcade'), false);
  milestones[0]!.unlockedAt = '2026-01-02T00:00:00.000Z';
  assert.equal(stands('arcade'), true, 'the decoration asks for the milestone by its key');
  assert.equal(stands('trophy'), false);
  assert.ok(unlockedUpgrades(milestones).includes('arcade'), 'and what the milestone grants is in the set under its own name too');
  // The arcade cabinet is then something to walk around.
  const before = buildWorld(layout, new Set()).solids.length;
  assert.equal(buildWorld(layout, new Set(unlockedUpgrades(milestones))).solids.length, before + 1);
});

test('an arcade cabinet that stands is something to walk up to: the spot is in front of its screen, and it wins over the room around it', () => {
  const layout = defaultLayout();
  assert.equal(buildWorld(layout, new Set()).interactables.some((i) => i.kind === 'arcade'), false, 'no cabinet, nothing to walk up to');
  const world = buildWorld(layout, new Set(['ten_tasks']));
  const cabinet = layout.decorations.find((d) => d.kind === 'arcade')!;
  const spot = world.interactables.find((i) => i.kind === 'arcade')!;
  assert.ok(spot, 'the cabinet is in the list of what can be walked up to');
  // In the default office its screen looks west (it is turned by -90°): the spot is a step west of it, at the same depth.
  assert.ok(Math.abs(spot.x - (cabinet.x - 1)) < 1e-9 && Math.abs(spot.z - cabinet.z) < 1e-9, `${spot.x}, ${spot.z}`);
  // Nobody has to stand inside the cabinet, or inside anything else, to play.
  const inside = (b: { minX: number; maxX: number; minZ: number; maxZ: number }) => spot.x > b.minX && spot.x < b.maxX && spot.z > b.minZ && spot.z < b.maxZ;
  assert.equal(world.obstacles.some(inside), false, 'the spot is free floor');
  assert.deepEqual(layoutProblems(layout, new Set(['ten_tasks'])), [], 'and it can be reached');
  // Standing there means the cabinet, whatever wider circle the spot also lies in.
  assert.equal(world.interactables.find((i) => Math.hypot(i.x - spot.x, i.z - spot.z) < i.radius)!.kind, 'arcade');
  // A cabinet the owner turned the other way is played from its other side; two cabinets are two spots.
  const two = { ...layout, decorations: [...layout.decorations.map((d) => (d.kind === 'arcade' ? { ...d, rot: Math.PI / 2 } : d)), { id: 'arcade-2', kind: 'arcade', x: 14, z: 0, rot: 0 }] };
  const spots = buildWorld(two, new Set(['ten_tasks'])).interactables.filter((i) => i.kind === 'arcade');
  assert.equal(spots.length, 2);
  assert.ok(spots.some((i) => Math.abs(i.x - (cabinet.x + 1)) < 1e-9), 'turned east, it is played from the east');
  assert.ok(spots.some((i) => i.id === 'arcade:arcade-2' && Math.abs(i.x - 14) < 1e-9 && Math.abs(i.z - 1) < 1e-9), 'one that faces south is played from the south');
});

test('places to sit: the sofas and armchairs of the rooms, a sofa an owner put down, and the chairs at the meeting and team tables', () => {
  const layout = defaultLayout();
  const world = buildWorld(layout, new Set(['team_room']));
  const of = (prefix: string) => world.seats.filter((x) => x.id.startsWith(prefix));
  const br = world.room('break')!;
  // The break room's sofa: two seats, exactly where the employees on a break sit, facing the TV.
  const sofa = of('break-sofa');
  assert.equal(sofa.length, 2);
  const onBreak = world.breakSpots.filter((x) => x.sit);
  for (const seat of sofa) {
    assert.ok(onBreak.some((b) => Math.abs(b.x - seat.x) < 0.02 && Math.abs(b.z - seat.z) < 0.02), `${seat.x}, ${seat.z}`);
    assert.ok(Math.abs(Math.cos(seat.rot) + 1) < 1e-9, 'facing north, where the TV hangs');
    assert.equal(seat.kind, 'sofa');
  }
  assert.ok(sofa.every((x) => x.z > br.z + br.d - 1.5));
  // The long sofa at reception seats three, facing into the room (west); each armchair in the CEO's room seats one, facing east.
  const waiting = of('reception-sofa');
  assert.equal(waiting.length, 3);
  assert.ok(waiting.every((x) => Math.abs(Math.sin(x.rot) + 1) < 1e-9));
  const armchairs = of('ceo-armchair');
  assert.equal(armchairs.length, 2);
  assert.ok(armchairs.every((x) => Math.abs(Math.sin(x.rot) - 1) < 1e-9));
  // Every chair at the meeting table and at the team table, facing the table as the people in a meeting do.
  assert.deepEqual(of('meeting:').map((x) => [x.x, x.z, x.rot, x.kind]), world.meeting!.seats.map((x) => [x.x, x.z, x.rot, 'chair']));
  assert.deepEqual(of('team:').map((x) => [x.x, x.z, x.rot]), world.team!.seats.map((x) => [x.x, x.z, x.rot]));
  assert.equal(of('team-sofa').length, 2);
  // No team room, none of its seats.
  assert.equal(buildWorld(layout, new Set()).seats.some((x) => x.id.startsWith('team')), false);
  // A sofa an owner put on the floor is one to sit on, the way it was turned: turned a quarter, its seats lie along the other axis.
  const withSofa = { ...layout, decorations: [...layout.decorations, { id: 'mine', kind: 'sofa', x: 0, z: 0, rot: Math.PI / 2 }] };
  const mine = buildWorld(withSofa, new Set()).seats.filter((x) => x.id.startsWith('sofa:mine'));
  assert.equal(mine.length, 2);
  assert.ok(mine.every((x) => Math.abs(x.x + 0.05) < 1e-9) && Math.abs(mine[0]!.z + mine[1]!.z) < 1e-9, JSON.stringify(mine));
  assert.ok(mine.every((x) => Math.abs(Math.sin(x.rot) + 1) < 1e-9), 'facing the way the sofa looks');
  // From every seat somebody can get up onto floor that can be walked on, within a step.
  for (const seat of world.seats) {
    const at = world.nav.walkable(seat.x, seat.z) ? [seat.x, seat.z] : world.nav.nearestWalkable(seat.x + Math.sin(seat.rot) * 0.7, seat.z + Math.cos(seat.rot) * 0.7);
    assert.ok(at && Math.hypot(at[0]! - seat.x, at[1]! - seat.z) < 1.6, `nowhere to stand up from ${seat.id}`);
  }
  // Ids are one seat's each.
  assert.equal(new Set(world.seats.map((x) => x.id)).size, world.seats.length);
});

test('the team room, once earned, has a table and a sofa that people walk around; desks an owner put there are left alone', () => {
  const layout = defaultLayout();
  assert.equal(buildWorld(layout, new Set()).team, null, 'no team room, no furniture');
  const w = buildWorld(layout, new Set(['team_room']));
  const room = w.room('team')!;
  assert.ok(w.team, 'the earned team room is furnished');
  const t = w.team!;
  const inside = (x: number, z: number) => x > room.x + 0.2 && x < room.x + room.w - 0.2 && z > room.z + 0.2 && z < room.z + room.d - 0.2;
  assert.ok(inside(t.table.x - t.table.w / 2, t.table.z - t.table.d / 2) && inside(t.table.x + t.table.w / 2, t.table.z + t.table.d / 2), 'the table stands inside the room');
  assert.ok(t.seats.length >= 4 && t.seats.every((s) => inside(s.x, s.z)), 'with seats on both sides of it');
  assert.ok(inside(t.sofa.x, t.sofa.z));
  // The table is something to walk around, and the door still leads to the sofa.
  const [x] = moveWithCollision(w, t.table.x - t.table.w / 2 - 0.8, t.table.z, 1.5, 0);
  assert.ok(x < t.table.x - t.table.w / 2, 'nobody walks through the table');
  const door = { x: room.x + room.w + 0.8, z: room.z + room.d / 2 };
  const path = w.nav.path(door.x, door.z, t.sofa.x + 1.0, t.sofa.z);
  assert.ok(path && path.length > 0, 'the sofa can be walked to from the door');
  // An owner's own arrangement of that room wins.
  const own = { ...layout, desks: [...layout.desks, { id: 'x-a', x: t.table.x, z: t.table.z, rot: 0, zone: 'south', kind: 'standard' as const }] };
  assert.equal(buildWorld(own, new Set(['team_room'])).team, null);
});
