/**
 * The city under the Skyline, block by block, without end.
 *
 * A block is made from its own two numbers (i, j) alone — its own random numbers seeded by them — so the same block is
 * the same on every computer and every time it is made again, and only the blocks around the camera need to exist
 * (`skyline.ts` draws those; the person who jumps out walks and drives among the very same `solids`). The office's
 * tower stands on block (0, 0), which is left empty here.
 *
 * Nothing is drawn here (only `rng` and `fbm2` come from the surroundings' kit).
 */
import { fbm2, rng } from '../surroundings/kit.ts';

/** How far the street is under the office floor. */
export const DROP = 150;
/** From the middle of one street to the middle of the next, and how wide a street is. */
export const PITCH = 116;
export const STREET = 20;
/** The street level, as a height in the world. */
export const STREET_Y = -DROP;
/** From a block's middle to its kerb, and to where its buildings may stand. */
export const KERB = (PITCH - STREET) / 2;
export const LOT = KERB - 4;

/** What a front is made of (the third number of a part's `look`). */
export const FRONT = { masonry: 0, ribbon: 1, glass: 2, piers: 3, plain: 4 } as const;
/** For `plain` things, what they are (the fourth number of `look`): concrete, metal, the wood of a water tank, leaves. */
export const PLAIN = { concrete: 0.3, metal: 0.7, wood: 0.9, leaves: 0.97 } as const;

/**
 * What a building is told about itself is kept on a grid of this many steps: exact in a float, and far enough from the
 * next step that the hair an interpolated value is off by on a graphics card never crosses one (`SURROUNDINGS.md`).
 */
export const SEED_STEPS = 4096;
export const onGrid = (v: number): number => Math.round(v * SEED_STEPS) / SEED_STEPS;

export type Shape = 'box' | 'round' | 'tank' | 'tree' | 'lawn';

/** One thing to draw: where its foot is (the middle of its base), its size, and how it looks. */
export interface Part {
  shape: Shape;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rot: number;
  /** seed, share of windows lit, what the front is, its tint. */
  look: [number, number, number, number];
}

/** Something one cannot walk or drive through: a box from the street up to `top`. */
export interface Solid {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** The height (world y) of its top: one can stand on it. */
  top: number;
}

export interface Block {
  i: number;
  j: number;
  parts: Part[];
  solids: Solid[];
  /** Red lights on the tall roofs: x, y, z. */
  beacons: Array<[number, number, number]>;
  /** A park instead of buildings. */
  park: boolean;
}

/** A block's own random numbers. */
function blockRandom(i: number, j: number): () => number {
  let h = Math.imul(i | 0, 73856093) ^ Math.imul(j | 0, 19349663) ^ 20261112;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return rng((h ^ (h >>> 15)) >>> 0);
}

/** How built up a part of the city is (0 low, 1 the tallest): districts that rise and fall over many blocks. */
export function districtOf(i: number, j: number): number {
  // The cluster of the tallest the office has always looked at, to the north-west against the last light.
  const home = Math.max(0, 1 - Math.hypot(i + 3.2, j + 2.4) / 2.3);
  const far = fbm2(i * 0.11 + 40, j * 0.11 - 17, 3, 9);
  return Math.max(home, Math.min(1, Math.max(0, (far - 0.52) * 3.2)));
}

const cache = new Map<string, Block>();

/** Block (i, j): the same every time. Kept for a while, since it is asked for again as the camera moves. */
export function blockAt(i: number, j: number): Block {
  const key = `${i},${j}`;
  const hit = cache.get(key);
  if (hit) {
    // (Most recently used last.)
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const made = makeBlock(i, j);
  cache.set(key, made);
  if (cache.size > 900) cache.delete(cache.keys().next().value!);
  return made;
}

function makeBlock(i: number, j: number): Block {
  const block: Block = { i, j, parts: [], solids: [], beacons: [], park: false };
  if (i === 0 && j === 0) return block; // the office's own tower
  const random = blockRandom(i, j);
  const cx = i * PITCH;
  const cz = j * PITCH;
  const ring = Math.max(Math.abs(i), Math.abs(j));
  const district = districtOf(i, j);
  // Now and then a park: a lawn and trees.
  if (ring >= 2 && district < 0.3 && random() < 0.07) {
    block.park = true;
    block.parts.push({ shape: 'lawn', x: cx, y: STREET_Y, z: cz, w: 2 * LOT + 6, h: 0.3, d: 2 * LOT + 6, rot: 0, look: [onGrid(random()), 0, FRONT.plain, PLAIN.leaves] });
    for (let k = 0; k < 46; k++) {
      const r = 2.2 + random() * 2.2;
      const x = cx + (random() - 0.5) * (2 * LOT - 6);
      const z = cz + (random() - 0.5) * (2 * LOT - 6);
      block.parts.push({ shape: 'tree', x, y: STREET_Y + 2.6 + r * 0.6, z, w: r, h: r * 0.9, d: r, rot: random() * 6, look: [onGrid(random()), 0, FRONT.plain, PLAIN.leaves] });
    }
    return block;
  }
  const cols = random() < 0.3 ? 1 : random() < 0.6 ? 2 : 3;
  const rows = random() < 0.4 ? 1 : 2;
  const span = 2 * LOT;
  for (let a = 0; a < cols; a++) {
    for (let b = 0; b < rows; b++) {
      const lotW = span / cols;
      const lotD = span / rows;
      const r = random();
      let h = 22 + 150 * Math.pow(r, 2.1);
      if (district > 0.25 && random() < district) h = 120 + random() * (90 + 160 * district);
      else if (random() < 0.06 && ring >= 1) h = 150 + random() * 110;
      // Near the office the view is kept: low next door, and only the cluster rises above the floor within a few blocks.
      if (ring <= 4 && district < 0.25) h = Math.min(h, ring === 1 ? 60 + random() * 70 : 170);
      // Lots are built up to the pavement and to each other, as in a real city: the gaps are narrow.
      const w = Math.min(lotW - 1.5 - random() * (h > 110 ? 6 : 2.5), h > 150 ? 46 : 80);
      const d = Math.min(lotD - 1.5 - random() * (h > 110 ? 6 : 2.5), h > 150 ? 46 : 80);
      tower(block, random, cx - LOT + lotW * (a + 0.5), cz - LOT + lotD * (b + 0.5), w, d, h);
    }
  }
  return block;
}

function frontFor(random: () => number, h: number): number {
  const r = random();
  if (h < 45) return r < 0.7 ? FRONT.masonry : FRONT.ribbon;
  if (h < 110) return r < 0.4 ? FRONT.masonry : r < 0.68 ? FRONT.ribbon : r < 0.84 ? FRONT.piers : FRONT.glass;
  return r < 0.58 ? FRONT.glass : r < 0.84 ? FRONT.piers : FRONT.ribbon;
}

/** One building on its lot: maybe a podium, a shaft that steps back as it rises, what stands on its roof. */
function tower(block: Block, random: () => number, x: number, z: number, w: number, d: number, h: number): void {
  const seed = onGrid(random());
  const share = onGrid(0.05 + random() * random() * 0.42);
  const front = frontFor(random, h);
  const tint = onGrid(random());
  const round = front === FRONT.glass && h > 110 && random() < 0.28;
  const solid = (bx: number, bz: number, bw: number, bd: number, top: number, isRound = false) => {
    // A round part is stood against as the square round it would be a little inside: near enough at a walk.
    const hw = isRound ? bw * 0.47 : bw / 2;
    const hd = isRound ? bd * 0.47 : bd / 2;
    block.solids.push({ minX: bx - hw, maxX: bx + hw, minZ: bz - hd, maxZ: bz + hd, top });
  };
  const plain = (px: number, y: number, pz: number, pw: number, ph: number, pd: number, what: number) => {
    block.parts.push({ shape: 'box', x: px, y: STREET_Y + y, z: pz, w: pw, h: ph, d: pd, rot: 0, look: [onGrid(random()), 0, FRONT.plain, what] });
  };
  let base = 0;
  let bw = w;
  let bd = d;
  // A tall tower stands on a podium of shops and offices that fills its lot.
  if (h > 110) {
    const ph = 12 + random() * 14;
    const podium = random() < 0.5 ? FRONT.masonry : FRONT.ribbon;
    block.parts.push({ shape: 'box', x, y: STREET_Y, z, w, h: ph, d, rot: 0, look: [onGrid(random()), share, podium, onGrid(random())] });
    solid(x, z, w, d, STREET_Y + ph);
    base = ph;
    bw = w * (0.62 + random() * 0.15);
    bd = round ? bw : d * (0.62 + random() * 0.15);
  }
  // It steps back as it rises (the older ones in many steps), and may end in a mast.
  const rest = h - base;
  const tiers = h > 150 ? 2 + Math.floor(random() * 2) : h > 70 && random() < (front === FRONT.masonry ? 0.7 : 0.35) ? 2 : 1;
  for (let t = 0; t < tiers; t++) {
    const th = tiers === 1 ? rest : t === 0 ? rest * (0.55 + random() * 0.15) : (h - base) * (t === tiers - 1 ? 1 : 0.6);
    block.parts.push({ shape: round ? 'round' : 'box', x, y: STREET_Y + base, z, w: bw, h: th, d: round ? bw : bd, rot: 0, look: [seed, share, front, tint] });
    base += th;
    solid(x, z, bw, round ? bw : bd, STREET_Y + base, round);
    if (t < tiers - 1) {
      bw *= 0.68 + random() * 0.14;
      bd = round ? bw : bd * (0.68 + random() * 0.14);
    }
  }
  // On the roof: the lift's machine room, air handlers, and on an older building a water tank on legs.
  if (round) plain(x, base, z, bw * 0.4, 3 + random() * 3, bw * 0.4, PLAIN.concrete);
  else {
    const pw = bw * (0.3 + random() * 0.25);
    const pd = bd * (0.3 + random() * 0.25);
    const px = x + (random() - 0.5) * (bw - pw) * 0.6;
    const pz = z + (random() - 0.5) * (bd - pd) * 0.6;
    const penthouse = 3 + random() * 3.5;
    plain(px, base, pz, pw, penthouse, pd, PLAIN.concrete);
    solid(px, pz, pw, pd, STREET_Y + base + penthouse);
    const units = Math.floor(random() * 4);
    for (let k = 0; k < units; k++) {
      const ux = x + (random() - 0.5) * (bw - 6);
      const uz = z + (random() - 0.5) * (bd - 6);
      if (Math.abs(ux - px) < pw / 2 + 2 && Math.abs(uz - pz) < pd / 2 + 2) continue;
      plain(ux, base, uz, 2 + random() * 2.5, 1.4 + random() * 1.2, 2 + random() * 3, PLAIN.metal);
    }
    if (front === FRONT.masonry && h <= 110 && random() < 0.6 && bw > 14 && bd > 14) {
      const r = 2 + random() * 1.2;
      const tx = x + (random() < 0.5 ? -1 : 1) * (bw / 2 - r - 2);
      const tz = z + (random() < 0.5 ? -1 : 1) * (bd / 2 - r - 2);
      block.parts.push({ shape: 'tank', x: tx, y: STREET_Y + base, z: tz, w: r, h: r * (1 + random() * 0.3), d: r, rot: random() * 6, look: [onGrid(random()), 0, FRONT.plain, PLAIN.wood] });
    }
  }
  let top = base + 4;
  if (h > 170 && random() < 0.7) {
    const mast = 18 + random() * 34;
    plain(x, base, z, 1.4, mast, 1.4, PLAIN.metal);
    top = base + mast;
  }
  if (h > 120) block.beacons.push([x, STREET_Y + top + 1.2, z]);
}

/** Trees along the pavements of a block: x, z and the size of the crown. */
export function streetTrees(i: number, j: number): Array<[number, number, number]> {
  const random = blockRandom(i * 7 + 3, j * 7 - 5);
  const out: Array<[number, number, number]> = [];
  const inner = KERB - 0.9;
  const cx = i * PITCH;
  const cz = j * PITCH;
  for (let p = -inner + 7; p < inner - 7; p += 8 + random() * 5) {
    for (const [x, z] of [[cx + p, cz - inner], [cx + p, cz + inner], [cx - inner, cz + p], [cx + inner, cz + p]] as const) {
      if (random() < 0.3) continue;
      out.push([x, z, 1.8 + random() * 1.3]);
    }
  }
  return out;
}

/** The block a point is in (the streets around it belong to it too). */
export const blockIndex = (v: number): number => Math.round(v / PITCH);

/** Everything solid near a point: the blocks it is in and next to. `extra` (the office's tower) is added. */
export function solidsNear(x: number, z: number, extra: Solid[] = []): Solid[] {
  const bi = blockIndex(x);
  const bj = blockIndex(z);
  const out = [...extra];
  for (let i = bi - 1; i <= bi + 1; i++) for (let j = bj - 1; j <= bj + 1; j++) out.push(...blockAt(i, j).solids);
  return out;
}

/** The highest thing one can stand on under a point at height `y` (allowing a step of `step`), or the street. */
export function groundAt(solids: Solid[], x: number, z: number, y: number, radius = 0, step = 0.6): number {
  let g = STREET_Y;
  for (const s of solids) {
    if (x + radius < s.minX || x - radius > s.maxX || z + radius < s.minZ || z - radius > s.maxZ) continue;
    if (s.top <= y + step && s.top > g) g = s.top;
  }
  return g;
}

/** Is a circle at this height inside something taller than a step? */
export function blocked(solids: Solid[], x: number, z: number, y: number, radius: number, step = 0.6): boolean {
  for (const s of solids) {
    if (s.top <= y + step) continue;
    if (x + radius > s.minX && x - radius < s.maxX && z + radius > s.minZ && z - radius < s.maxZ) return true;
  }
  return false;
}
