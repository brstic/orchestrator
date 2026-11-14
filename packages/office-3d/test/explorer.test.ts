/**
 * Out in the city (`city/explorer.ts`, `city/blocks.ts`): the jump out of the office, the parachute, walking among
 * the buildings that are drawn, and driving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DROP, KERB, LOT, PITCH, STREET_Y, blockAt, groundAt, solidsNear, type Solid } from '../src/city/blocks.ts';
import { CHUTE_SINK, alight, board, leap, step, type Explorer, type Keys } from '../src/city/explorer.ts';

const still: Keys = { fwd: 0, turn: 0, strafe: 0, run: false, jump: false };
const ahead: Keys = { ...still, fwd: 1 };
/** The office's tower: its floor is at 0, its terrace reaches 30 m round the middle. */
const tower: Solid = { minX: -30, maxX: 30, minZ: -25, maxZ: 25, top: 0 };

function run(e: Explorer, keys: Keys, seconds: number, extra: Solid[] = [tower], each?: (e: Explorer) => void): void {
  for (let t = 0; t < seconds; t += 1 / 60) {
    step(e, keys, 1 / 60, solidsNear(e.x, e.z, extra));
    each?.(e);
  }
}

test('a block is the same every time it is made, and the office stands alone on its own', () => {
  const a = JSON.stringify(blockAt(3, -7));
  assert.equal(JSON.stringify(blockAt(3, -7)), a);
  assert.equal(blockAt(0, 0).parts.length, 0);
  // Far away there are still buildings (the city has no end), and they keep to their lots: the streets stay free.
  let parts = 0;
  for (const [i, j] of [[40, 40], [-120, 7], [5, 300]] as const) {
    const b = blockAt(i, j);
    parts += b.parts.length;
    for (const s of b.solids) {
      assert.ok(s.minX >= i * PITCH - LOT - 0.01 && s.maxX <= i * PITCH + LOT + 0.01 && s.minZ >= j * PITCH - LOT - 0.01 && s.maxZ <= j * PITCH + LOT + 0.01, `a building on the street at block ${i},${j}`);
      assert.ok(s.top > STREET_Y);
    }
  }
  assert.ok(parts > 10);
});

test('out of the window: a fall, then the parachute opens by itself, and one comes down slowly onto the street', () => {
  // Off the terrace's edge, facing away from the building, over the street between the blocks.
  const e = leap(31, 0, Math.PI / 2);
  let opened = -1;
  let fastest = 0;
  let t = 0;
  run(e, still, 60, [tower], (x) => {
    t += 1 / 60;
    if (x.phase === 'chute' && opened < 0) opened = t;
    if (x.phase === 'chute' && x.time > 2.5) fastest = Math.max(fastest, -x.vy);
  });
  assert.ok(opened > 1 && opened < 1.6, `opened after ${opened.toFixed(2)} s`);
  assert.ok(fastest <= CHUTE_SINK + 0.6, `sank at ${fastest.toFixed(1)} m/s under the parachute`);
  assert.equal(e.phase, 'foot');
  assert.ok(e.y <= STREET_Y + 0.6 + 60 && e.y >= STREET_Y - 1e-9, `landed at ${e.y}`);
});

test('a short drop is a fall without a parachute', () => {
  const e: Explorer = { ...leap(0, 0, 0), phase: 'fall', y: STREET_Y + 5, vx: 0, vy: 0, vz: 0, x: KERB + 5, z: 0 };
  run(e, still, 3, []);
  assert.equal(e.phase, 'foot');
  assert.equal(e.chute, 0);
  assert.equal(e.y, STREET_Y);
});

test('on foot one walks along the street, but not into a building', () => {
  const wall: Solid = { minX: 10, maxX: 30, minZ: -10, maxZ: 10, top: STREET_Y + 40 };
  const e: Explorer = { ...leap(0, 0, Math.PI / 2), phase: 'foot', x: 0, y: STREET_Y, z: 0, vx: 0, vy: 0, vz: 0 };
  for (let t = 0; t < 5; t += 1 / 60) step(e, ahead, 1 / 60, [wall]);
  assert.ok(e.x < 10 && e.x > 9, `stopped at x=${e.x.toFixed(2)}`);
  assert.equal(e.y, STREET_Y);
});

test('landing on a roof, one stands on it; walking off its edge, one falls — and the parachute opens again if it is high', () => {
  const roof: Solid = { minX: -20, maxX: 20, minZ: -20, maxZ: 20, top: STREET_Y + 80 };
  // Under a parachute 25 m over the roof, at its near side, braking.
  const e: Explorer = { ...leap(0, -18, 0), y: roof.top + 25, vx: 0, vy: -CHUTE_SINK, vz: 0, chute: 1 };
  e.phase = 'chute';
  e.time = 0;
  for (let t = 0; t < 30 && e.phase !== 'foot'; t += 1 / 60) step(e, { ...still, fwd: -1 }, 1 / 60, [roof]);
  assert.equal(e.phase, 'foot');
  assert.equal(e.y, roof.top);
  let chuted = false;
  for (let t = 0; t < 40; t += 1 / 60) {
    step(e, e.phase === 'foot' ? ahead : still, 1 / 60, [roof]);
    if (e.phase === 'chute') chuted = true;
  }
  assert.ok(chuted, 'no parachute after walking off an 80 m roof');
  assert.equal(e.y, STREET_Y);
});

test('at the wheel: it gets going, turns with the keys, and stops against a building', () => {
  const e: Explorer = { ...leap(0, 0, 0), phase: 'foot', y: STREET_Y, vx: 0, vy: 0, vz: 0 };
  board(e, { x: 0, z: 0, heading: 0, paint: [1, 0, 0], index: 7 });
  assert.equal(e.phase, 'car');
  for (let t = 0; t < 3; t += 1 / 60) step(e, ahead, 1 / 60, []);
  assert.ok(e.vf > 20 && e.z > 30, `after 3 s: ${e.vf.toFixed(1)} m/s, ${e.z.toFixed(1)} m`);
  const before = e.rot;
  for (let t = 0; t < 1; t += 1 / 60) step(e, { ...ahead, turn: 1 }, 1 / 60, []);
  assert.ok(e.rot < before - 0.5, 'did not turn right');
  const wall: Solid = { minX: -500, maxX: 500, minZ: e.z + 40, maxZ: e.z + 60, top: STREET_Y + 30 };
  e.rot = 0;
  for (let t = 0; t < 6; t += 1 / 60) step(e, ahead, 1 / 60, [wall]);
  assert.ok(e.z < wall.minZ, 'drove into the building');
  const left = alight(e, [wall]);
  assert.equal(e.phase, 'foot');
  assert.ok(Math.hypot(e.x - left.x, e.z - left.z) > 1.5, 'got out inside the car');
});

test('the ground under a point is the highest roof one can stand on, or the street', () => {
  const s: Solid[] = [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, top: STREET_Y + 20 }];
  assert.equal(groundAt(s, 5, 5, STREET_Y + 50), STREET_Y + 20);
  assert.equal(groundAt(s, 5, 5, STREET_Y), STREET_Y);
  assert.equal(groundAt(s, 50, 5, 0), STREET_Y);
  assert.equal(DROP, -STREET_Y);
});
