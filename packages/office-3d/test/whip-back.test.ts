import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACK_FOR_MS, CRACK_WINDOW_MS, crackAt, cracksNeeded, sentBack } from '../src/whip-back.ts';

/** A crack at somebody away from their chair sends them back — some at once, some only after two or three. */
const T = Date.UTC(2026, 10, 13, 10, 0, 0);

test('how many cracks somebody needs: one, two or three — the same in every window, another day another answer', () => {
  const ids = Array.from({ length: 300 }, (_x, i) => `employee-${i}`);
  const needs = ids.map((id) => cracksNeeded(id, T));
  assert.deepEqual([...new Set(needs)].sort(), [1, 2, 3], 'all three kinds are among three hundred people');
  // The same person, asked again the same day (any window, any moment): the same.
  assert.deepEqual(ids.map((id) => cracksNeeded(id, T + 7 * 3600_000)), needs);
  // Another day: not the same list.
  assert.notDeepEqual(ids.map((id) => cracksNeeded(id, T + 86_400_000)), needs);
});

test('they go back when they have had enough, and not a crack sooner', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const need = cracksNeeded(id, T);
    let told = undefined as ReturnType<typeof crackAt> | undefined;
    for (let n = 1; n <= need; n++) {
      told = crackAt(told, id, T + n * 1000);
      assert.equal(sentBack(told, T + n * 1000 + 1), n >= need, `${id}: crack ${n} of ${need}`);
    }
    // Back, and kept there for a while; then free to wander again.
    assert.equal(told!.until, T + need * 1000 + BACK_FOR_MS);
    assert.equal(sentBack(told, told!.until - 1), true);
    assert.equal(sentBack(told, told!.until + 1), false);
  }
  assert.equal(sentBack(undefined, T), false);
});

test('cracks far apart are not one telling-off: the count starts again', () => {
  const stubborn = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].find((id) => cracksNeeded(id, T) === 3)!;
  let told = crackAt(undefined, stubborn, T);
  told = crackAt(told, stubborn, T + 2000);
  assert.deepEqual([told.hits, told.until], [2, 0]);
  // A long pause: the third crack is a first one.
  told = crackAt(told, stubborn, T + 2000 + CRACK_WINDOW_MS + 1);
  assert.deepEqual([told.hits, told.until], [1, 0]);
  // Three in a row do it.
  told = crackAt(told, stubborn, told.last + 1000);
  told = crackAt(told, stubborn, told.last + 1000);
  assert.equal(sentBack(told, told.last + 1), true);
});

test('a crack is heard from where it cracks: full beside it, fainter with every step, gone at the far end of the floor', async () => {
  const { CRACK_FAR, CRACK_NEAR, crackFalloff } = await import('../src/voice-sound.ts');
  assert.deepEqual([crackFalloff(0), crackFalloff(CRACK_NEAR), crackFalloff(CRACK_FAR), crackFalloff(CRACK_FAR + 20)], [1, 1, 0, 0]);
  // Never louder further off, and already clearly quieter a few desks away.
  let last = 1;
  for (let d = 0; d <= 40; d += 0.5) {
    const v = crackFalloff(d);
    assert.ok(v <= last + 1e-9 && v >= 0 && v <= 1, `at ${d} m`);
    last = v;
  }
  assert.ok(crackFalloff(8) < 0.7 && crackFalloff(8) > 0.3, `8 m: ${crackFalloff(8)}`);
  assert.ok(crackFalloff(20) < 0.15, `20 m: ${crackFalloff(20)}`);
  // Somebody with no character to measure to: half, not full and not silent.
  assert.deepEqual([crackFalloff(null), crackFalloff(undefined), crackFalloff(NaN)], [0.5, 0.5, 0.5]);
});
