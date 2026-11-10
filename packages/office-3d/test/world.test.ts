import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, deskSeat } from '@orchestrator/contracts';
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
  assert.deepEqual(world.interactables.map((i) => i.kind).sort(), ['board', 'break', 'ceo', 'hifi', 'meeting', 'ops', 'reception', 'server', 'tv']);
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
