import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREET_Y, type Solid } from '../src/city/blocks.ts';
import { besideOf, passengerSeat, rideNear, type OtherOut } from '../src/city/together.ts';

const other = (over: Partial<OtherOut>): OtherOut => ({ name: 'Ana', phase: 'foot', x: 0, y: STREET_Y, z: 0, rot: 0, speed: 0, ...over });

test('one can get in beside somebody who is driving — the nearest, within reach — and not beside somebody on foot', () => {
  const others = new Map<string, OtherOut>([
    ['a', other({ name: 'Ana', phase: 'car', x: 3 })],
    ['b', other({ name: 'Bo', phase: 'car', x: 2, z: 1 })],
    ['c', other({ name: 'Cy', phase: 'foot', x: 0.5 })],
    ['d', other({ name: 'Di', phase: 'car', x: 30 })],
  ]);
  assert.deepEqual(rideNear(others, 0, 0)?.id, 'b');
  assert.equal(rideNear(others, 100, 100), null);
  assert.equal(rideNear(new Map([['c', other({ phase: 'foot' })]]), 0, 0), null);
});

test('the seat beside the driver is to their right, and turns with the car', () => {
  const seat = passengerSeat({ x: 10, y: STREET_Y, z: 5, rot: 0 });
  // Facing +z, right is -x.
  assert.ok(Math.abs(seat.x - 9.55) < 1e-9 && Math.abs(seat.z - 5) < 1e-9 && seat.rot === 0 && seat.y === STREET_Y);
  const turned = passengerSeat({ x: 0, y: STREET_Y, z: 0, rot: Math.PI / 2 });
  // Facing +x, right is +z.
  assert.ok(Math.abs(turned.x) < 1e-9 && Math.abs(turned.z - 0.45) < 1e-9);
});

test('going to somebody: on foot beside them where there is room, and in the air beside them — two canopies apart — when they fly', () => {
  const wall: Solid = { minX: 0.5, maxX: 20, minZ: -20, maxZ: 20, top: -100 };
  // On foot, a wall on their left (+x when facing +z): one comes down on their right.
  const foot = besideOf(other({ phase: 'foot', x: 0, z: 0 }), [wall]);
  assert.equal(foot.phase, 'foot');
  assert.ok(foot.x < 0 && Math.hypot(foot.x, foot.z) < 3 && foot.y === STREET_Y, JSON.stringify(foot));
  // At the wheel: beside the car, on the street.
  const car = besideOf(other({ phase: 'car', x: -40, z: 0, y: STREET_Y + 0.2 }), []);
  assert.ok(car.phase === 'foot' && car.y === STREET_Y && Math.hypot(car.x + 40, car.z) > 2 && Math.hypot(car.x + 40, car.z) < 3, JSON.stringify(car));
  // Under a parachute: under one's own, nine metres to the side, as high.
  const air = besideOf(other({ phase: 'chute', x: -40, y: -60, z: 0 }), []);
  assert.ok(air.phase === 'chute' && air.y === -60 && Math.abs(Math.hypot(air.x + 40, air.z) - 9) < 1e-9, JSON.stringify(air));
  // On a roof: on that roof.
  const roof: Solid = { minX: -10, maxX: 10, minZ: -10, maxZ: 10, top: -90 };
  const up = besideOf(other({ phase: 'foot', x: 0, y: -90, z: 0 }), [roof]);
  assert.ok(up.phase === 'foot' && up.y === -90, JSON.stringify(up));
});
