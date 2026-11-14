/**
 * The Skyline's traffic (`surroundings/traffic.ts`): lights at every crossing, queues that wait at red and pull away
 * at green — and nobody drives into anybody, in a lane or across a crossing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AMBER, CYCLE, GREEN, STOP_BACK, Z_OFFSET, centerAt, crossingsOf, spanOf, traffic, type StreetGrid, type Vehicle } from '../src/surroundings/traffic.ts';
import { rng } from '../src/surroundings/kit.ts';

const GRID: StreetGrid = { pitch: 116, street: 20, reach: 6 };
const cars = traffic(GRID, rng(20261112));
const span = spanOf(GRID);
const wrap = (d: number) => ((((d + span / 2) % span) + span) % span) - span / 2;
/** Two cycles, a quarter of a second apart, starting somewhere that is not the beginning. */
const moments = Array.from({ length: (2 * CYCLE) / 0.25 }, (_, i) => 1000 + i * 0.25);

test('a busy evening: thousands of vehicles, taxis and buses among them, every lane of every street', () => {
  assert.ok(cars.length > 2500 && cars.length < 4500, `${cars.length} vehicles`);
  const kinds = new Set(cars.map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), ['bus', 'car', 'suv', 'taxi']);
  assert.equal(new Set(cars.map((c) => `${c.alongX}|${c.across}`)).size, 14 * 2 * 4);
  // Fewer on a slower computer.
  assert.ok(traffic(GRID, rng(20261112), 0.5).length < cars.length * 0.65);
});

test('in a lane nobody drives into the one ahead: at every moment of two cycles there is room between them', () => {
  const lanes = new Map<string, Vehicle[]>();
  for (const c of cars) lanes.set(`${c.alongX}|${c.across}`, [...(lanes.get(`${c.alongX}|${c.across}`) ?? []), c]);
  let closest = Infinity;
  for (const t of moments) {
    for (const lane of lanes.values()) {
      const at = lane.map((c) => centerAt(c, t, GRID));
      for (let i = 0; i < lane.length; i++) {
        for (let j = i + 1; j < lane.length; j++) {
          const room = Math.abs(wrap(at[i]! - at[j]!)) - (lane[i]!.length + lane[j]!.length) / 2;
          if (room < closest) closest = room;
          if (room < 1) assert.fail(`two vehicles ${room.toFixed(2)} m apart at t=${t}`);
        }
      }
    }
  }
  assert.ok(closest >= 1.9, `closest ${closest.toFixed(2)} m`);
});

/** Which crossings a vehicle is in at `t`: "street it crosses|crossing along its own street". */
function inCrossings(c: Vehicle, t: number): string[] {
  const middle = centerAt(c, t, GRID) * c.dir;
  const half = c.length / 2;
  const out: string[] = [];
  for (const x of crossingsOf(GRID)) {
    for (const at of [x, x + span, x - span]) {
      if (Math.abs(middle - at) < half + GRID.street / 2) out.push(`${Math.round(Math.round(c.across / GRID.pitch - 0.5))}|${Math.round(x / GRID.pitch - 0.5)}`);
    }
  }
  return out;
}

test('across a crossing nobody meets: the two directions are never in the same crossing at the same moment', () => {
  for (const t of moments) {
    const alongX = new Set<string>();
    const alongZ = new Set<string>();
    for (const c of cars) {
      for (const k of inCrossings(c, t)) {
        // The same crossing seen from each street: (row, column) for one, (column, row) for the other.
        const [street, along] = k.split('|');
        (c.alongX ? alongX : alongZ).add(c.alongX ? `${street}|${along}` : `${along}|${street}`);
      }
    }
    for (const k of alongX) assert.ok(!alongZ.has(k), `both directions in crossing ${k} at t=${t}`);
  }
});

test('on red nobody is in a crossing, and everybody waits behind the stop line', () => {
  for (const t of moments) {
    for (const c of cars.slice(0, 900)) {
      const local = (((t - (c.alongX ? 0 : Z_OFFSET)) % CYCLE) + CYCLE) % CYCLE;
      if (local < GREEN + AMBER + 0.01) continue;
      assert.deepEqual(inCrossings(c, t), [], `in a crossing on red at t=${t}`);
      // Standing: its nose is behind the stop line of the crossing ahead.
      const nose = wrap(centerAt(c, t, GRID) + c.length / 2);
      const ahead = crossingsOf(GRID).map((x) => wrap(x - nose)).filter((d) => d > 0);
      assert.ok(Math.min(...ahead) >= STOP_BACK - 0.01, `nose ${Math.min(...ahead).toFixed(2)} m before a crossing on red`);
    }
  }
});

test('while waiting a vehicle stands where it was put, and after a cycle it is one block on', () => {
  const c = cars.find((v) => v.alongX)!;
  assert.equal(centerAt(c, c.delay - 0.01, GRID), wrap(c.stop - c.length / 2));
  assert.ok(Math.abs(wrap(centerAt(c, CYCLE + c.delay - 0.01, GRID) - (c.stop - c.length / 2 + GRID.pitch))) < 1e-6);
});
