import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BREAK_TURN_MS, breakPlan, type BreakPlace } from '../src/break-room.ts';

/** Who is at which place of the break room (`break-room.ts`): everybody somewhere of their own, talking only in twos, and on to something else in time. */
const places: BreakPlace[] = [
  { x: 0, z: 0, rot: 0, sit: true, act: 'tv' },
  { x: 1, z: 0, rot: 0, sit: true, act: 'tv' },
  { x: 2, z: 0, rot: 0, sit: false, act: 'coffee' },
  { x: 3, z: 0, rot: 0, sit: false, act: 'sink' },
  { x: 4, z: 0, rot: 0, sit: false, act: 'fridge' },
  { x: 5, z: 0, rot: 0, sit: false, act: 'chat' },
  { x: 6, z: 0, rot: 0, sit: false, act: 'chat' },
];

test('nobody shares a place, and nobody talks alone', () => {
  for (const who of [['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']]) {
    for (let k = 0; k < 40; k++) {
      const plan = breakPlan(who, places, k * 7_919 * 13);
      const at = [...plan.values()].filter((i) => i >= 0);
      assert.equal(new Set(at).size, at.length, 'one person a place');
      const talking = at.filter((i) => places[i]!.act === 'chat').length;
      assert.ok(talking === 0 || talking === 2, `talking in twos, not ${talking}`);
      if (who.length === 1) assert.equal(talking, 0);
    }
  }
});

test('two on a break do talk sometimes, and everybody moves on to something else in time', () => {
  let talked = 0;
  const seen = new Set<string>();
  for (let k = 0; k < 30; k++) {
    const plan = breakPlan(['a', 'b'], places, k * BREAK_TURN_MS);
    if ([...plan.values()].some((i) => places[i]?.act === 'chat')) talked++;
    seen.add(places[plan.get('a')!]!.act);
  }
  assert.ok(talked >= 10 && talked < 30, `talked in ${talked} of 30 turns`);
  assert.ok(seen.size >= 4, `a did ${[...seen].join(', ')}`);
});
