/**
 * The traffic of the city under the Skyline: who drives where, and where each is at a given moment.
 *
 * Every crossing has lights on one cycle (`CYCLE`): first the streets that run along x have green, then the ones
 * along z. A vehicle waits in its lane behind the stop line while its light is red — in a queue, nose to tail — and
 * when it turns green the queue pulls away one after the other, drives one block, and stops in the same place in the
 * next queue. So in one cycle every vehicle moves exactly one block, and where it is at any moment follows from the
 * time alone (`centerAt`) — the graphics card works it out per vehicle (`TRAFFIC_GLSL` mirrors `centerAt`), nothing
 * is simulated.
 *
 * Why nobody runs into anybody: in a lane, the one behind starts later and takes no less time for the same block, so
 * it is never further along than the one ahead (`queue`); across a crossing, the two directions have green at
 * different times, and the last of a queue is through the crossing before the other direction's first starts. Both
 * are measured by `packages/office-3d/test/traffic.test.ts`.
 *
 * Pure: no three.js here.
 */

/** One whole turn of the lights, in seconds. */
export const CYCLE = 36;
/** When the streets along z get green, after those along x. */
export const Z_OFFSET = CYCLE / 2;
/** How long green and amber last, from the start of a direction's turn. */
export const GREEN = 15;
export const AMBER = 2.5;
/** Where the stop line is: this far before the middle of the crossing (half a street, the zebra crossing, a margin). */
export const STOP_BACK = 14.5;
/** Between one vehicle and the next in a queue. */
export const GAP = 2.2;
/** The most vehicles a lane holds before one crossing. */
export const MAX_QUEUE = 5;

export interface StreetGrid {
  /** From the middle of one street to the middle of the next. */
  pitch: number;
  /** How wide a street is. */
  street: number;
  /** Streets cross at (k + 0.5) · pitch for k from -reach - 1 to reach; a lane loops after (2 · reach + 1) blocks. */
  reach: number;
}

export type VehicleKind = 'car' | 'suv' | 'taxi' | 'bus';

export interface Vehicle {
  /** The street runs along x (else along z). */
  alongX: boolean;
  /** Where the lane is across its street (world z for a street along x, world x for one along z). */
  across: number;
  /** Which way along the street: +1 or -1. */
  dir: 1 | -1;
  /** Where its nose is while it waits in its first queue, measured along its own direction. */
  stop: number;
  /** After green, how long before it pulls away. */
  delay: number;
  /** How long it takes to drive one block. */
  travel: number;
  length: number;
  kind: VehicleKind;
  /** Its paint, 0–1 sRGB. */
  paint: [number, number, number];
}

/** Lengths of what drives, nose to tail. */
export const LENGTH: Record<VehicleKind, number> = { car: 4.6, suv: 4.9, taxi: 4.6, bus: 12 };

const PAINTS: Array<[number, number, number]> = [
  [0.72, 0.74, 0.77], // silver
  [0.1, 0.1, 0.12], // black
  [0.93, 0.93, 0.9], // white
  [0.3, 0.32, 0.36], // grey
  [0.45, 0.08, 0.07], // red
  [0.1, 0.18, 0.34], // blue
  [0.18, 0.24, 0.2], // green
  [0.42, 0.36, 0.28], // beige
];
const TAXI: [number, number, number] = [0.96, 0.74, 0.12];
const BUS: Array<[number, number, number]> = [
  [0.12, 0.33, 0.62],
  [0.86, 0.86, 0.84],
];

/** The lanes of a street, across it from its middle; the sign says the side. */
export const LANES = [-7.4, -2.6, 2.6, 7.4] as const;

/** Which way a lane goes: on a street along x the +z side drives towards +x; on a street along z the +x side towards -z. */
export const dirOf = (alongX: boolean, lane: number): 1 | -1 => ((lane > 0) === alongX ? 1 : -1);

/** The length of a lane before it comes round again. */
export const spanOf = (g: StreetGrid): number => (2 * g.reach + 1) * g.pitch;

/** Where the streets cross along a lane (the same numbers for both directions). */
export function crossingsOf(g: StreetGrid): number[] {
  const out: number[] = [];
  for (let k = -g.reach - 1; k < g.reach; k++) out.push((k + 0.5) * g.pitch);
  return out;
}

/** How far along its block a vehicle is, from 0 (waiting) to 1 (waiting at the next): easing in and out. */
export const ease = (f: number): number => f * f * (3 - 2 * f);

/** The middle of a vehicle, along its own direction, at time `t` — wrapped into the lane's loop. */
export function centerAt(v: Pick<Vehicle, 'alongX' | 'stop' | 'delay' | 'travel' | 'length'>, t: number, g: StreetGrid): number {
  const span = spanOf(g);
  const tau = t - (v.alongX ? 0 : Z_OFFSET) - v.delay;
  const n = Math.floor(tau / CYCLE);
  const f = Math.min(1, Math.max(0, (tau - n * CYCLE) / v.travel));
  const c = v.stop - v.length / 2 + (n + ease(f)) * g.pitch;
  return ((((c + span / 2) % span) + span) % span) - span / 2;
}

/** The same as `centerAt`, for the graphics card. Expects `uTime`, `uSpan`, `uPitch`, `uCycle`, `uZOff`. */
export const TRAFFIC_GLSL = /* glsl */ `
float trafficF(float alongX, float delay, float travel, out float n) {
  float tau = uTime - (alongX > 0.5 ? 0.0 : uZOff) - delay;
  n = floor(tau / uCycle);
  return clamp((tau - n * uCycle) / travel, 0.0, 1.0);
}
float trafficCenter(float stop, float len, float n, float f) {
  float c = stop - len * 0.5 + (n + f * f * (3.0 - 2.0 * f)) * uPitch;
  return mod(c + uSpan * 0.5, uSpan) - uSpan * 0.5;
}
`;

/**
 * The traffic of the whole grid. `density` 1 is a busy evening (some 2.2 vehicles a lane a block); less for a slower
 * computer. Same numbers on every computer for the same `random`.
 */
export function traffic(g: StreetGrid, random: () => number, density = 1): Vehicle[] {
  const out: Vehicle[] = [];
  const crossings = crossingsOf(g);
  for (let k = -g.reach - 1; k <= g.reach; k++) {
    const mid = (k + 0.5) * g.pitch;
    for (const alongX of [true, false]) {
      for (const lane of LANES) {
        const dir = dirOf(alongX, lane);
        const outer = Math.abs(lane) > 5;
        for (const crossing of crossings) {
          // How many wait here: mostly a few, now and then a long queue, sometimes nobody.
          const r = random();
          const want = Math.round(Math.min(MAX_QUEUE, Math.max(0, (r < 0.18 ? 0 : 1 + r * r * 5.2) * density)));
          out.push(...queue({ alongX, across: mid + lane, dir, crossing, count: want, outer }, random));
        }
      }
    }
  }
  return out;
}

/** The vehicles that wait in one lane before one crossing, front first. */
export function queue(at: { alongX: boolean; across: number; dir: 1 | -1; crossing: number; count: number; outer: boolean }, random: () => number): Vehicle[] {
  const out: Vehicle[] = [];
  let nose = at.crossing - STOP_BACK;
  let delay = 0.6 + random() * 0.4;
  let travel = 12.2 + random() * 0.6;
  let used = 0;
  for (let i = 0; i < at.count; i++) {
    const r = random();
    // A bus only in the outer lane, and not where it would make the queue too long to clear the crossing in time.
    const kind: VehicleKind = at.outer && r < 0.07 && used + LENGTH.bus <= 34 ? 'bus' : r < 0.22 ? 'taxi' : r < 0.42 ? 'suv' : 'car';
    const length = LENGTH[kind];
    if (used + length > 40) break;
    const paint = kind === 'taxi' ? TAXI : kind === 'bus' ? BUS[Math.floor(random() * BUS.length)]! : PAINTS[Math.floor(random() * PAINTS.length)]!;
    out.push({ alongX: at.alongX, across: at.across, dir: at.dir, stop: nose, delay, travel, length, kind, paint });
    nose -= length + GAP;
    used += length + GAP;
    // The next one starts a little later and takes no less time: it never catches up with this one.
    delay += 0.85 + random() * 0.35 + (kind === 'bus' ? 0.8 : 0);
    travel += random() * 0.3;
  }
  return out;
}
