import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apart, cleanOutside } from '../src/outside.ts';

test('what a window says about being out in the city is passed on only as far as it makes sense', () => {
  assert.equal(cleanOutside(null), null);
  assert.equal(cleanOutside({ phase: 'swim', x: 1, y: 2, z: 3, rot: 0 }), null);
  assert.equal(cleanOutside([1, 2]), null);
  const car = cleanOutside({ phase: 'car', x: 4700, y: -150, z: -3300, rot: 1, car: { kind: 'tank', paint: [2, 0.5, -1], speed: 900, steer: 3 }, extra: 'x' });
  assert.deepEqual(car, { phase: 'car', x: 4700, y: -150, z: -3300, rot: 1, car: { kind: 'sedan', paint: [1, 0.5, 0], speed: 60, steer: 1 } });
  // Far off, and not a number: held in.
  assert.deepEqual(cleanOutside({ phase: 'foot', x: 1e9, y: 'high', z: -Infinity, rot: 0 }), { phase: 'foot', x: 200_000, y: 0, z: 0, rot: 0 });
  // Whose car one rides in is kept only for a ride; the parachute's opening only under one.
  assert.deepEqual(cleanOutside({ phase: 'ride', x: 0, y: -150, z: 0, rot: 0, with: 'c2', chute: 1 }), { phase: 'ride', x: 0, y: -150, z: 0, rot: 0, with: 'c2' });
  assert.deepEqual(cleanOutside({ phase: 'foot', x: 0, y: -150, z: 0, rot: 0, with: 'c2' }), { phase: 'foot', x: 0, y: -150, z: 0, rot: 0 });
  assert.equal(cleanOutside({ phase: 'chute', x: 0, y: -50, z: 0, rot: 0, chute: 4 })!.chute, 1);
  assert.deepEqual(cleanOutside({ phase: 'foot', x: 0, y: -150, z: 0, rot: 0, parked: { x: 5, z: 6, rot: 1, kind: 'taxi', paint: [0.9, 0.7, 0.1] } })!.parked, {
    x: 5,
    z: 6,
    rot: 1,
    kind: 'taxi',
    paint: [0.9, 0.7, 0.1],
  });
});

test('how far apart two people are: in the office by where they stand, out in the city by where they are there, never between the two', () => {
  assert.equal(apart({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
  // Both out: by where they are out there (also up and down), not by the window they jumped from.
  assert.equal(apart({ x: 0, z: 0, out: { x: 100, y: -150, z: 0 } }, { x: 0, z: 0, out: { x: 100, y: -146, z: 3 } }), 5);
  // One in the office, one in the street below its window: nothing reaches.
  assert.equal(apart({ x: 0, z: 0 }, { x: 0, z: 0, out: { x: 0, y: -150, z: 0 } }), Infinity);
});
