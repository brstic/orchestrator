/**
 * How loud the office hi-fi is at a distance: full next to it, quieter further away, never silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIFI_FAR, HIFI_FLOOR, HIFI_NEAR, hifiFalloff, hifiLoudnessAt, hifiPosition } from '../src/hifi-sound.ts';

test('next to the hi-fi the music is at full loudness', () => {
  for (const d of [0, 0.5, 1, 2.9, HIFI_NEAR]) assert.equal(hifiFalloff(d), 1, `${d} m`);
  assert.equal(hifiFalloff(-1), 1);
  assert.equal(hifiFalloff(Number.NaN), 1, 'a position that is not known yet is not a reason for silence');
});

test('at the far end of the office it is quiet, not silent', () => {
  assert.ok(HIFI_FLOOR >= 0.12 && HIFI_FLOOR <= 0.15, `the floor is ${HIFI_FLOOR}`);
  for (const d of [HIFI_FAR, HIFI_FAR + 1, 80, 500, Number.POSITIVE_INFINITY]) assert.equal(hifiFalloff(d), HIFI_FLOOR, `${d} m`);
  // Just before the far end it is already close to the floor.
  assert.ok(hifiFalloff(HIFI_FAR - 1) - HIFI_FLOOR < 0.01);
});

test('every step away makes it quieter, and no step is heard as a jump', () => {
  const step = 0.05; // one frame of running is less than this
  let last = hifiFalloff(0);
  let lastDrop = 0;
  let biggestDrop = 0;
  let biggestBend = 0;
  for (let d = step; d <= HIFI_FAR + 2; d += step) {
    const now = hifiFalloff(d);
    assert.ok(now <= last, `louder at ${d.toFixed(2)} m than a step closer`);
    if (d > HIFI_NEAR + step && d < HIFI_FAR - step) assert.ok(now < last, `no quieter at ${d.toFixed(2)} m than a step closer`);
    const drop = last - now;
    biggestDrop = Math.max(biggestDrop, drop);
    // Smooth: how fast it falls does not change abruptly either (no kink where the fall begins or ends).
    biggestBend = Math.max(biggestBend, Math.abs(drop - lastDrop));
    last = now;
    lastDrop = drop;
  }
  assert.ok(biggestDrop < 0.005, `the biggest change over 5 cm is ${biggestDrop.toFixed(4)}`);
  assert.ok(biggestBend < 0.001, `the fall changes pace by at most ${biggestBend.toFixed(5)} per 5 cm`);
  assert.ok(Math.abs(hifiFalloff(HIFI_NEAR + 0.001) - 1) < 1e-3 && Math.abs(hifiFalloff(HIFI_FAR - 0.001) - HIFI_FLOOR) < 1e-3, 'it meets both ends without a step');
});

test('it is clearly quieter outside the break room and still there at the far desks', () => {
  const at = (d: number) => hifiFalloff(d);
  assert.ok(at(6) > 0.8 && at(6) < 1, `6 m: ${at(6).toFixed(2)}`);
  assert.ok(at(12) > 0.5 && at(12) < 0.8, `12 m: ${at(12).toFixed(2)}`);
  assert.ok(at(24) > 0.18 && at(24) < 0.45, `24 m: ${at(24).toFixed(2)}`);
});

test('loudness is measured from where the hi-fi stands in the office that is drawn', () => {
  const before = hifiPosition.at;
  hifiPosition.at = { x: 10, z: -2 };
  assert.equal(hifiLoudnessAt(11, -2), 1);
  assert.equal(hifiLoudnessAt(10 - 40, -2), HIFI_FLOOR);
  assert.ok(hifiLoudnessAt(10, -2 + 10) < 1 && hifiLoudnessAt(10, -2 + 10) === hifiLoudnessAt(10 + 10, -2), 'the same in every direction: walls do not count');
  // An office without a hi-fi has nothing to be far from.
  hifiPosition.at = null;
  assert.equal(hifiLoudnessAt(100, 100), 1);
  hifiPosition.at = before;
});
