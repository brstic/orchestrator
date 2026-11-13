import * as THREE from 'three';
import { Build, M, at, cyl, lathe, once, slab, softBox, sphere, tint, torus, tube, type Model } from './kit.ts';

/**
 * What makes an office a place: plants, sofas, shelves of books, lamps, and the things a company earns.
 * Every model stands on the floor at its origin. Seating has its back toward +Z (whoever sits looks to −Z).
 */

function rng(seed: number): () => number {
  let s = Math.max(1, Math.floor(seed) % 2147483647);
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// ───────────────────────────── plants ─────────────────────────────

interface LeafOptions {
  /** How far the blade bends down along its length, in radians. */
  droop?: number;
  /** How much the two halves fold up from the midrib. */
  fold?: number;
  /** Where along the blade it is widest (0 base … 1 tip). */
  belly?: number;
  base?: string;
  tip?: string;
  seg?: number;
  /** Points across the blade: 3 for a narrow leaf, 5 for a broad one that should curve rather than crease. */
  across?: 3 | 5;
}

/** One leaf blade lying along +Z from the origin, face up, coloured from its base to its tip. */
function leaf(len: number, width: number, o: LeafOptions = {}): THREE.BufferGeometry {
  const seg = o.seg ?? 6;
  const droop = o.droop ?? 0.5;
  const fold = o.fold ?? 0.25;
  const belly = o.belly ?? 0.4;
  const n = o.across ?? 3;
  const half = (n - 1) / 2;
  const cBase = new THREE.Color(o.base ?? '#2c5e3a');
  const cTip = new THREE.Color(o.tip ?? '#57985a');
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    // Width: nothing at the stalk, widest at the belly, a point at the tip.
    const k = t < belly ? Math.sin((t / belly) * (Math.PI / 2)) : Math.cos(((t - belly) / (1 - belly)) * (Math.PI / 2));
    const hw = (width / 2) * Math.pow(Math.max(0, k), 0.75);
    const th = droop * t;
    const z = droop ? (len * Math.sin(th)) / droop : len * t;
    const y = droop ? (-len * (1 - Math.cos(th))) / droop : 0;
    for (let j = -half; j <= half; j++) {
      const a = j / half;
      // The halves rise from the midrib in a curve, steepest at the rib.
      pos.push(a * hw, y + Math.pow(Math.abs(a), 1.5) * hw * fold, z);
      c.copy(cBase).lerp(cTip, t * 0.9 + (j === 0 ? 0.12 : 0));
      col.push(c.r, c.g, c.b);
    }
    if (i < seg) {
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function pot(b: Build, kind: number): number {
  const soil = M.paint('#3a2c22', 0.95);
  if (kind === 0) {
    // A tall tapered planter in matt white.
    b.add(M.ceramic('#eceae4', 0.5), lathe([[0, 0], [0.14, 0], [0.155, 0.012], [0.2, 0.44], [0.212, 0.46], [0.2, 0.47], [0.185, 0.455], [0.18, 0.41]], 28));
    b.add(soil, at(cyl(0.182, 0.182, 0.01, 24), 0, 0.425, 0), { cast: false });
    return 0.43;
  }
  if (kind === 1) {
    // A round bowl on a three-legged oak stand.
    b.add(M.ceramic('#3b4350', 0.45), lathe([[0, 0.2], [0.12, 0.2], [0.185, 0.25], [0.215, 0.36], [0.21, 0.46], [0.2, 0.475], [0.19, 0.465], [0.19, 0.42]], 28));
    b.add(soil, at(cyl(0.19, 0.19, 0.01, 24), 0, 0.435, 0), { cast: false });
    const oak = M.wood('#b98d5e');
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      b.add(oak, tube([[Math.sin(a) * 0.2, 0.004, Math.cos(a) * 0.2], [Math.sin(a) * 0.185, 0.2, Math.cos(a) * 0.185], [Math.sin(a) * 0.2, 0.33, Math.cos(a) * 0.2]], 0.014, 8, 6));
    }
    b.add(oak, at(torus(0.19, 0.012, 6, 28), 0, 0.235, 0, Math.PI / 2));
    return 0.44;
  }
  // A straight-sided terracotta cylinder on a saucer.
  b.add(M.ceramic('#c0714c', 0.75), lathe([[0, 0.02], [0.17, 0.02], [0.185, 0.03], [0.195, 0.36], [0.205, 0.365], [0.205, 0.4], [0.19, 0.4], [0.185, 0.36]], 28));
  b.add(M.ceramic('#c0714c', 0.75), lathe([[0, 0], [0.2, 0], [0.215, 0.012], [0.215, 0.026], [0.2, 0.02], [0, 0.02]], 28), { cast: false });
  b.add(soil, at(cyl(0.186, 0.186, 0.01, 24), 0, 0.375, 0), { cast: false });
  return 0.38;
}

const plants: Model[] = [];

/**
 * A potted plant, about a person's height. Three kinds: a rubber tree with broad leaves up a stem, a
 * snake plant of upright blades, and a monstera with big leaves on long stalks. `n` picks one.
 */
export function plant(n: number): Model {
  const kind = ((n % 3) + 3) % 3;
  if (plants[kind]) return plants[kind]!;
  const b = new Build();
  const green = M.leaf();
  const rnd = rng(31 + kind * 7);
  const soilY = pot(b, kind);
  if (kind === 0) {
    const stem: Array<[number, number, number]> = [[0, soilY - 0.02, 0], [0.025, soilY + 0.35, 0.01], [-0.015, soilY + 0.72, -0.01], [0.012, soilY + 1.12, 0.005]];
    b.add(M.paint('#5a4632', 0.85), tube(stem, 0.016, 7, 14));
    const curve = new THREE.CatmullRomCurve3(stem.map((p) => new THREE.Vector3(...p)));
    const count = 26;
    for (let i = 0; i < count; i++) {
      const t = 0.2 + (i / (count - 1)) * 0.8;
      const p = curve.getPoint(t);
      const az = i * 2.39996;
      const up = 0.35 + t * 0.75 + (rnd() - 0.5) * 0.2;
      const len = 0.32 - t * 0.1 + rnd() * 0.04;
      const g = leaf(len, len * 0.52, { droop: 0.75 - t * 0.3, fold: 0.22, belly: 0.45, base: '#234f33', tip: i > count - 5 ? '#6aa860' : '#3f7d49' });
      b.add(green, at(g, p.x + Math.sin(az) * 0.03, p.y, p.z + Math.cos(az) * 0.03, -up, az, (rnd() - 0.5) * 0.4));
    }
  } else if (kind === 1) {
    const count = 15;
    for (let i = 0; i < count; i++) {
      const az = i * 2.39996 + rnd();
      const r = 0.02 + (i / count) * 0.1;
      const len = 0.95 - (i / count) * 0.45 + rnd() * 0.1;
      const g = leaf(len, 0.085 + rnd() * 0.02, { droop: 0.12 + rnd() * 0.22, fold: 0.5, belly: 0.3, base: '#2f5f3e', tip: '#8fb866', seg: 7 });
      b.add(green, at(g, Math.sin(az) * r, soilY - 0.02, Math.cos(az) * r, -(1.52 - (i / count) * 0.3 - rnd() * 0.08), az, (rnd() - 0.5) * 0.5));
    }
  } else {
    // Big leaves, each on a long stalk of its own that arches out of the pot; the leaf hangs from the stalk's end.
    const stalk = M.paint('#3d6b3f', 0.7);
    const count = 10;
    for (let i = 0; i < count; i++) {
      const az = i * 2.39996 + rnd() * 0.5;
      const rise = 0.5 + (i / count) * 0.8 + rnd() * 0.1;
      const out = 0.36 - (i / count) * 0.2 + rnd() * 0.06;
      const tipX = Math.sin(az) * out;
      const tipZ = Math.cos(az) * out;
      b.add(stalk, tube([[Math.sin(az) * 0.03, soilY - 0.02, Math.cos(az) * 0.03], [tipX * 0.25, soilY + rise * 0.55, tipZ * 0.25], [tipX * 0.7, soilY + rise * 0.96, tipZ * 0.7], [tipX, soilY + rise, tipZ]], 0.011, 5, 10), { cast: false });
      const len = 0.36 - (i / count) * 0.1;
      const g = leaf(len, len * 0.82, { droop: 0.55, fold: 0.14, belly: 0.3, base: '#1f5233', tip: '#4d9458', seg: 8, across: 5 });
      b.add(green, at(g, tipX, soilY + rise, tipZ, 0.25 + rnd() * 0.45, az, (rnd() - 0.5) * 0.4));
    }
  }
  return (plants[kind] = b.done());
}

/** A small plant for a desk or a shelf: a few leaves in a little pot. */
export const deskPlant = once((): Model => {
  const b = new Build();
  const rnd = rng(9);
  b.add(M.ceramic('#eceae4', 0.5), lathe([[0, 0], [0.04, 0], [0.047, 0.006], [0.055, 0.075], [0.058, 0.08], [0.052, 0.082], [0.048, 0.07]], 16), { cast: false });
  b.add(M.paint('#3a2c22', 0.95), at(cyl(0.049, 0.049, 0.004, 12), 0, 0.072, 0), { cast: false });
  for (let i = 0; i < 9; i++) {
    const az = i * 2.39996;
    const g = leaf(0.11 + rnd() * 0.05, 0.05, { droop: 0.9, fold: 0.3, base: '#2c5e3a', tip: '#69a862', seg: 4 });
    b.add(M.leaf(), at(g, 0, 0.07, 0, -(0.5 + rnd() * 0.8), az, 0), { cast: false });
  }
  return b.done();
});

// ───────────────────────────── seating ─────────────────────────────

const sofas = new Map<string, Model>();

/**
 * A sofa `w` wide (an armchair when narrow): loose seat and back cushions on a frame with arms, on short oak
 * legs. Its back is toward +Z. `seat` is the height people sit at.
 */
export function sofa(w: number, color = '#4f6d8f', o: { leather?: boolean; seat?: number } = {}): Model {
  const key = `${w}:${color}:${o.leather ? 'l' : 'f'}:${o.seat ?? 0}`;
  const had = sofas.get(key);
  if (had) return had;
  const b = new Build();
  const cloth = o.leather ? M.leather(color) : M.fabric(color);
  const darker = `#${new THREE.Color(color).multiplyScalar(0.86).getHexString()}`;
  const frame = o.leather ? M.leather(darker) : M.fabric(darker);
  const oak = M.wood('#8a6a48');
  const d = 0.9;
  const arm = 0.15;
  const top = o.seat ?? 0.46;
  // Legs.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(oak, at(cyl(0.022, 0.014, 0.12, 10), sx * (w / 2 - 0.09), 0.06, sz * (d / 2 - 0.1)), { cast: false });
  // The frame: a base, a back and two arms, all upholstered.
  b.add(frame, at(softBox(w, top - 0.26, d - 0.04, 0.04, { round: 2 }), 0, 0.12 + (top - 0.26) / 2, 0));
  b.add(frame, at(softBox(w, 0.52, 0.16, 0.06, { round: 3 }), 0, top + 0.08, d / 2 - 0.1, 0.1));
  for (const s of [-1, 1]) b.add(frame, at(softBox(arm, 0.3, d - 0.08, 0.06, { round: 3, puff: 0.006 }), s * (w / 2 - arm / 2), top + 0.02, -0.02));
  // Loose cushions: seats that have been sat on, backs that lean.
  const inner = w - arm * 2 - 0.02;
  const n = Math.max(1, Math.round(inner / 0.8));
  const cw = inner / n;
  for (let i = 0; i < n; i++) {
    const x = -inner / 2 + cw * (i + 0.5);
    b.add(cloth, at(softBox(cw - 0.012, 0.15, 0.62, 0.055, { round: 2, flat: [3, 1, 3], puff: 0.022, puffFront: 0.01 }), x, top - 0.075, -0.09));
    b.add(cloth, at(softBox(cw - 0.03, 0.36, 0.15, 0.07, { round: 2, flat: [3, 3, 1], puffBack: 0.035, puffFront: 0.01 }), x, top + 0.19, 0.2, 0.2));
  }
  const m = b.done();
  sofas.set(key, m);
  return m;
}

/** A low table: an oak top with rounded corners on a black steel frame, a few things left on it. */
export function coffeeTable(w = 1.3, d = 0.7, h = 0.33): Model {
  const b = new Build();
  const steel = M.steel('#22262e', 0.45);
  b.add(M.wood('#a67c52'), at(slab(w, 0.03, d, 0.06, 0.006), 0, h - 0.015, 0));
  for (const s of [-1, 1]) {
    const x = s * (w / 2 - 0.12);
    // A sled on each side: a runner on the floor and two legs leaning in from its ends.
    b.add(steel, at(softBox(0.02, 0.016, d - 0.12, 0.006, { round: 1 }), x, 0.008, 0));
    for (const z of [-1, 1]) b.add(steel, tube([[x, 0.012, z * (d / 2 - 0.07)], [x, h - 0.03, z * (d / 2 - 0.12)]], 0.009, 6, 2));
  }
  b.add(steel, at(softBox(w - 0.24, 0.016, 0.03, 0.005, { round: 1 }), 0, h - 0.04, 0), { cast: false });
  // Two magazines and a cup.
  const mags = M.varied(0.6);
  b.add(mags, tint(at(softBox(0.21, 0.008, 0.28, 0.003, { round: 1 }), -w * 0.22, h + 0.004, 0.03, 0, 0.25), '#d9e1ea'), { cast: false });
  b.add(mags, tint(at(softBox(0.2, 0.008, 0.27, 0.003, { round: 1 }), -w * 0.21, h + 0.012, 0.02, 0, -0.1), '#c96f4a'), { cast: false });
  b.put(mug('#f2f0ea'), w * 0.24, h, -0.08, 0.6);
  return b.done();
}

const mugs = new Map<string, Model>();
/** A coffee mug. */
export function mug(color = '#f2f0ea'): Model {
  const had = mugs.get(color);
  if (had) return had;
  const b = new Build();
  const c = M.ceramic(color, 0.3);
  b.add(c, lathe([[0, 0], [0.034, 0], [0.039, 0.004], [0.041, 0.09], [0.039, 0.094], [0.036, 0.09], [0.034, 0.012], [0, 0.01]], 18), { cast: false });
  b.add(c, at(torus(0.026, 0.006, 6, 14, Math.PI), 0.04, 0.048, 0, 0, 0, -Math.PI / 2), { cast: false });
  b.add(M.paint('#3b2417', 0.3), at(cyl(0.035, 0.035, 0.002, 14), 0, 0.078, 0), { cast: false });
  const m = b.done();
  mugs.set(color, m);
  return m;
}

const notebooks = new Map<string, Model>();
/** A closed notebook with an elastic band and a pen lying beside it. */
export function notebook(color = '#2f3846'): Model {
  const had = notebooks.get(color);
  if (had) return had;
  const b = new Build();
  b.add(M.paint('#f4f1e8', 0.9), at(softBox(0.146, 0.012, 0.206, 0.002, { round: 1 }), 0, 0.008, 0), { cast: false });
  b.add(M.leather(color), at(softBox(0.15, 0.004, 0.21, 0.0015, { round: 1 }), 0, 0.016, 0), { cast: false });
  b.add(M.leather(color), at(softBox(0.15, 0.004, 0.21, 0.0015, { round: 1 }), 0, 0.002, 0), { cast: false });
  b.add(M.rubber('#15171b'), at(softBox(0.008, 0.021, 0.212, 0.002, { round: 1 }), 0.045, 0.009, 0), { cast: false });
  b.add(M.metal('#c5cad3', 0.3), at(cyl(0.0042, 0.0042, 0.13, 8), 0.105, 0.0045, 0.01, Math.PI / 2, 0.3), { cast: false });
  b.add(M.paint('#22262e', 0.4), at(cyl(0.0044, 0.001, 0.016, 8), 0.105 + Math.sin(0.3) * 0.073, 0.0045, 0.01 + Math.cos(0.3) * 0.073, Math.PI / 2, 0.3), { cast: false });
  const m = b.done();
  notebooks.set(color, m);
  return m;
}

// ───────────────────────────── shelves, lamps ─────────────────────────────

const SPINES = ['#b5483c', '#3c6fb5', '#d9a441', '#4c8f5e', '#7a5aa8', '#e8e3d6', '#2f3846', '#c96f4a', '#5c8aa8', '#efe6d6'];

/** A row of books standing on a shelf from `x0` to `x1`, some leaning, some lying. */
function books(b: Build, rnd: () => number, x0: number, x1: number, y: number, z: number, depth: number, maxH: number): void {
  const paper = M.varied(0.7);
  let x = x0;
  while (x < x1 - 0.03) {
    if (rnd() < 0.12 && x1 - x > 0.3) {
      // A short stack lying flat, then a gap.
      let top = y;
      const sw = 0.2 + rnd() * 0.06;
      for (let k = 0; k < 2 + Math.floor(rnd() * 3); k++) {
        const t = 0.022 + rnd() * 0.02;
        b.add(paper, tint(at(new THREE.BoxGeometry(sw - k * 0.012, t, depth * 0.85), x + sw / 2, top + t / 2, z, 0, (rnd() - 0.5) * 0.15), SPINES[Math.floor(rnd() * SPINES.length)]!), { cast: false });
        top += t;
      }
      x += sw + 0.03;
      continue;
    }
    const t = 0.022 + rnd() * 0.034;
    const h = maxH * (0.62 + rnd() * 0.36);
    if (x + t > x1) break;
    const leanNow = rnd() < 0.08 ? 0.18 : 0;
    b.add(paper, tint(at(new THREE.BoxGeometry(t, h, depth * (0.74 + rnd() * 0.2)), x + t / 2 + leanNow * h * 0.5, y + h / 2, z, 0, 0, -leanNow), SPINES[Math.floor(rnd() * SPINES.length)]!), { cast: false });
    x += t + 0.002 + leanNow * h;
    if (rnd() < 0.07) x += 0.05 + rnd() * 0.1;
  }
}

/** An open bookcase, 1.6 m wide and 1.8 m tall, its back toward −Z: books, a plant, a few objects. */
export const bookshelf = once((): Model => {
  const b = new Build();
  const oak = M.wood('#9a744c');
  const rnd = rng(77);
  const W = 1.6;
  const H = 1.8;
  const D = 0.36;
  b.add(M.wood('#7d5d3c'), at(softBox(W - 0.02, H - 0.02, 0.014, 0.003, { round: 1 }), 0, H / 2, -D / 2 + 0.012), { turn: true });
  for (const s of [-1, 1]) b.add(oak, at(softBox(0.032, H, D, 0.006, { round: 1 }), s * (W / 2 - 0.016), H / 2, 0), { turn: true });
  b.add(oak, at(softBox(0.026, H - 0.1, D - 0.03, 0.005, { round: 1 }), 0, H / 2, 0), { turn: true });
  const levels = [0.07, 0.5, 0.93, 1.36, H - 0.016];
  for (const y of levels) b.add(oak, at(softBox(W - 0.06, 0.03, D - 0.01, 0.006, { round: 1 }), 0, y, 0));
  b.add(M.steel('#22262e'), at(softBox(W - 0.08, 0.055, D - 0.06, 0.004, { round: 1 }), 0, 0.028, -0.01), { cast: false });
  for (let l = 0; l < 4; l++) {
    const y = levels[l]! + 0.015;
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -W / 2 + 0.04 : 0.02;
      const x1 = side < 0 ? -0.02 : W / 2 - 0.04;
      const what = (l * 2 + (side > 0 ? 1 : 0)) % 8;
      if (what === 3) {
        b.put(deskPlant(), (x0 + x1) / 2 - 0.2, y, 0.02, 0, 1.5);
        books(b, rnd, (x0 + x1) / 2, x1, y, 0, D - 0.1, 0.3);
      } else if (what === 6) {
        // A storage box and a framed picture leaning on the back.
        b.add(M.fabric('#8592a8'), at(softBox(0.3, 0.2, 0.26, 0.012, { round: 2 }), x0 + 0.2, y + 0.1, 0.01), { cast: false });
        b.add(M.wood('#3a2c22'), at(softBox(0.2, 0.26, 0.015, 0.004, { round: 1 }), x1 - 0.2, y + 0.128, -0.05, -0.14), { cast: false });
        b.add(M.paint('#e9edf2', 0.4), at(softBox(0.16, 0.22, 0.004, 0.001, { round: 1 }), x1 - 0.2, y + 0.129, -0.04, -0.14), { cast: false });
      } else books(b, rnd, x0, x1, y, 0, D - 0.1, l === 3 ? 0.28 : 0.33);
    }
  }
  return b.done();
});

/** A standing lamp: a weighted foot, a slim brass stem, a linen drum shade lit from inside. */
export const floorLamp = once((): Model => {
  const b = new Build();
  const brass = M.metal('#b89a5e', 0.32);
  b.add(M.steel('#22262e', 0.4), lathe([[0, 0], [0.15, 0], [0.16, 0.008], [0.16, 0.02], [0.12, 0.034], [0.03, 0.04], [0, 0.04]], 28));
  b.add(brass, at(cyl(0.011, 0.011, 1.48, 10), 0, 0.78, 0));
  b.add(brass, at(sphere(0.022, 12, 8), 0, 1.52, 0), { cast: false });
  // The shade is open above and below; its cloth glows, its rims are brass.
  const shade = M.glow('#ffe7bf', 0.95);
  shade.side = THREE.DoubleSide;
  b.add(shade, at(cyl(0.17, 0.2, 0.28, 28, true), 0, 1.6, 0));
  b.add(brass, at(torus(0.17, 0.004, 5, 28), 0, 1.74, 0, Math.PI / 2), { cast: false });
  b.add(brass, at(torus(0.2, 0.004, 5, 28), 0, 1.46, 0, Math.PI / 2), { cast: false });
  b.add(M.glow('#fff4dc', 2.2), at(sphere(0.045, 12, 8), 0, 1.6, 0), { cast: false });
  return b.done();
});

/** A flat rug with a darker border, `w` × `d`, lying on the floor. */
export function rug(w: number, d: number, color = '#39465c', border = '#2a3446'): Model {
  const b = new Build();
  b.add(M.fabric(border), at(slab(w, 0.012, d, 0.05, 0.004), 0, 0.012, 0), { cast: false });
  b.add(M.fabric(color), at(slab(w - 0.3, 0.012, d - 0.3, 0.03, 0.003), 0, 0.016, 0), { cast: false });
  return b.done();
}

// ───────────────────────────── earned ─────────────────────────────

/** An arcade cabinet, its screen toward +Z. The lit screen and marquee are drawn by the scene on top of it. */
export const arcade = once((): Model => {
  const b = new Build();
  const side = new THREE.Shape();
  // The classic side profile, drawn on depth (X) × height (Y), front to the right.
  side.moveTo(-0.38, 0);
  side.lineTo(0.3, 0);
  side.lineTo(0.3, 0.86);
  side.lineTo(0.4, 0.94);
  side.lineTo(0.4, 1.02);
  side.lineTo(0.12, 1.5);
  side.lineTo(0.3, 1.62);
  side.lineTo(0.3, 1.86);
  side.lineTo(-0.38, 1.86);
  side.closePath();
  const panel = (thick: number) => {
    const g = new THREE.ExtrudeGeometry(side, { depth: thick, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1 });
    g.translate(0, 0, -thick / 2);
    g.rotateY(-Math.PI / 2);
    return g;
  };
  const purple = M.paint('#5b2d8e', 0.45);
  const black = M.plastic('#16181d', 0.5);
  for (const s of [-1, 1]) b.add(purple, at(panel(0.03), s * 0.385, 0.006, 0));
  b.add(black, at(panel(0.74), 0, 0.008, 0, 0, 0, 0, 1, 0.992, 0.97));
  // Control deck with a stick and buttons.
  b.add(black, at(softBox(0.74, 0.03, 0.2, 0.008, { round: 1 }), 0, 0.985, 0.33, 0.12), { cast: false });
  b.add(M.metal('#c5cad3', 0.3), at(cyl(0.007, 0.007, 0.07, 8), -0.2, 1.03, 0.33), { cast: false });
  b.add(M.paint('#e0483c', 0.3), at(sphere(0.022, 12, 10), -0.2, 1.075, 0.33), { cast: false });
  ['#f5c542', '#3ddc84', '#6ea8ff'].forEach((c, i) => b.add(M.paint(c, 0.35), at(cyl(0.02, 0.022, 0.014, 14), 0.02 + i * 0.075, 1.006 - (i % 2) * 0.003, 0.33 + (i % 2) * 0.03, 0.12), { cast: false }));
  // Coin door.
  b.add(M.steel('#2a2f38', 0.4), at(softBox(0.3, 0.36, 0.012, 0.01, { round: 1 }), 0, 0.5, 0.302), { cast: false });
  for (const s of [-1, 1]) b.add(M.glow('#ff7a3c', 1.2), at(softBox(0.035, 0.05, 0.008, 0.004, { round: 1 }), s * 0.06, 0.56, 0.31), { cast: false });
  // Stripes down the sides.
  for (const s of [-1, 1]) b.add(M.paint('#f5c542', 0.45), at(softBox(0.004, 1.5, 0.05, 0.001, { round: 1 }), s * 0.402, 0.85, -0.1), { cast: false });
  return b.done();
});

/** A cup trophy about 0.3 m tall. */
function trophy(b: Build, x: number, y: number, z: number, s: number, metal: THREE.Material): void {
  b.add(M.wood('#3a2c22'), at(softBox(0.1, 0.035, 0.1, 0.006, { round: 1 }), x, y + 0.0175 * s, z, 0, 0, 0, s), { cast: false });
  b.add(metal, at(lathe([[0, 0.035], [0.034, 0.035], [0.036, 0.045], [0.014, 0.06], [0.01, 0.11], [0.02, 0.125], [0.05, 0.16], [0.068, 0.22], [0.072, 0.28], [0.068, 0.285], [0.062, 0.275], [0.058, 0.22], [0.04, 0.17], [0, 0.155]], 20), x, y, z, 0, 0, 0, s), { cast: false });
  for (const side of [-1, 1]) b.add(metal, at(torus(0.034, 0.006, 6, 12, Math.PI), x + side * 0.066 * s, y + 0.225 * s, z, 0, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, s), { cast: false });
}

/** A display cabinet of the company's trophies: an oak base with a glass case on it, the front toward +Z. */
export const trophyCase = once((): Model => {
  const b = new Build();
  const oak = M.wood('#7d5d3c');
  const W = 2.0;
  const D = 0.45;
  b.add(M.steel('#22262e'), at(softBox(W - 0.1, 0.06, D - 0.08, 0.004, { round: 1 }), 0, 0.03, 0), { cast: false });
  b.add(oak, at(softBox(W, 0.84, D, 0.012, { round: 2 }), 0, 0.48, 0));
  // Door lines and pulls on the base.
  for (const x of [-0.5, 0, 0.5]) b.add(M.steel('#22262e'), at(softBox(0.006, 0.76, 0.006, 0.002, { round: 1 }), x, 0.48, D / 2 + 0.001), { cast: false });
  for (const x of [-0.56, -0.44, 0.44, 0.56]) b.add(M.metal('#b89a5e', 0.3), at(cyl(0.006, 0.006, 0.12, 8), x, 0.6, D / 2 + 0.012), { cast: false });
  b.add(oak, at(slab(W + 0.04, 0.03, D + 0.03, 0.01, 0.005), 0, 0.915, 0));
  // The glass case: slim brass posts, a glass shelf, a lit top.
  const brass = M.metal('#b89a5e', 0.3);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(brass, at(softBox(0.016, 0.78, 0.016, 0.004, { round: 1 }), sx * (W / 2 - 0.02), 1.32, sz * (D / 2 - 0.02)));
  b.add(M.glass('#cfe6f5', 0.16), at(softBox(W - 0.03, 0.76, D - 0.03, 0.004, { round: 1 }), 0, 1.31, 0), { cast: false });
  b.add(M.glass('#cfe6f5', 0.3), at(softBox(W - 0.08, 0.008, D - 0.1, 0.002, { round: 1 }), 0, 1.3, 0), { cast: false });
  b.add(oak, at(slab(W + 0.02, 0.03, D + 0.02, 0.01, 0.005), 0, 1.715, 0));
  b.add(M.glow('#fff1d0', 1.6), at(softBox(W - 0.2, 0.006, 0.03, 0.002, { round: 1 }), 0, 1.698, 0.1), { cast: false });
  const gold = M.metal('#e8b93c', 0.22);
  const silver = M.metal('#d5dae2', 0.22);
  const bronze = M.metal('#b0713c', 0.28);
  trophy(b, 0, 0.93, 0, 1.15, gold);
  trophy(b, -0.6, 0.93, 0.02, 0.95, silver);
  trophy(b, 0.6, 0.93, 0.02, 0.9, bronze);
  trophy(b, -0.3, 1.304, 0, 0.8, gold);
  trophy(b, 0.32, 1.304, 0, 0.8, silver);
  // A medal on a stand, and a plaque.
  b.add(M.wood('#3a2c22'), at(softBox(0.22, 0.16, 0.02, 0.006, { round: 1 }), 0.02, 1.39, -0.1, -0.15), { cast: false });
  b.add(gold, at(softBox(0.15, 0.09, 0.004, 0.002, { round: 1 }), 0.02, 1.392, -0.087, -0.15), { cast: false });
  return b.done();
});

/**
 * The stand of the "employee of the month": a framed board at eye height on a slim post, with a small brass
 * light over it. The picture in the frame (0.78 × 1.0 m, centred 1.42 m up) is drawn by the scene.
 */
export const awardStand = once((): Model => {
  const b = new Build();
  const steel = M.steel('#22262e', 0.4);
  const walnut = M.wood('#5b4030');
  const brass = M.metal('#c8a25a', 0.3);
  b.add(steel, at(softBox(0.62, 0.035, 0.42, 0.01, { round: 2 }), 0, 0.018, 0), { cast: false });
  b.add(steel, at(softBox(0.05, 0.9, 0.05, 0.008, { round: 1 }), 0, 0.47, -0.02));
  // The frame, and the dark back the picture lies on.
  b.add(walnut, at(softBox(0.9, 1.12, 0.05, 0.012, { round: 2 }), 0, 1.42, 0));
  b.add(M.paint('#10141c', 0.8), at(softBox(0.8, 1.02, 0.01, 0.002, { round: 1 }), 0, 1.42, 0.024), { cast: false });
  // A thin brass line inside the frame.
  for (const sx of [-1, 1]) b.add(brass, at(softBox(0.008, 1.03, 0.008, 0.002, { round: 1 }), sx * 0.404, 1.42, 0.028), { cast: false });
  for (const sy of [-1, 1]) b.add(brass, at(softBox(0.816, 0.008, 0.008, 0.002, { round: 1 }), 0, 1.42 + sy * 0.514, 0.028), { cast: false });
  // The picture light: an arm from the top of the frame and a warm strip.
  b.add(brass, at(softBox(0.014, 0.014, 0.12, 0.004, { round: 1 }), 0, 2.02, 0.05), { cast: false });
  b.add(brass, at(softBox(0.014, 0.06, 0.014, 0.004, { round: 1 }), 0, 1.995, 0), { cast: false });
  b.add(brass, at(softBox(0.42, 0.03, 0.04, 0.008, { round: 1 }), 0, 2.02, 0.11), { cast: false });
  b.add(M.glow('#ffe9c4', 1.8), at(softBox(0.38, 0.006, 0.024, 0.002, { round: 1 }), 0, 2.003, 0.11), { cast: false });
  return b.done();
});

/** The backing of the neon sign: a dark panel on stand-offs. The glowing tubes are drawn by the scene. */
export const neonBoard = once((): Model => {
  const b = new Build();
  b.add(M.paint('#14171d', 0.6), at(softBox(4.5, 0.9, 0.03, 0.012, { round: 1 }), 0, 0, 0), { cast: false });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) b.add(M.metal('#c5cad3', 0.3), at(cyl(0.02, 0.02, 0.012, 12), sx * 2.1, sy * 0.36, 0.02, Math.PI / 2), { cast: false });
  return b.done();
});
