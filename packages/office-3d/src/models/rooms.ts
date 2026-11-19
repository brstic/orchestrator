import * as THREE from 'three';
import { Build, M, at, cyl, lathe, keyed, once, slab, softBox, sphere, tint, torus, tube, type Model } from './kit.ts';
import { deskPlant, mug } from './decor.ts';
import { keyboard, monitor } from './workplace.ts';

/**
 * The furniture that belongs to one room each: the reception counter, the meeting table, the owner's desk,
 * the kitchen, the racks and the operators' console. Sizes follow the floor areas the office reserves for
 * them (see `world.ts`), so nobody walks through an edge that sticks out.
 */

/** The reception counter, 3.4 m wide: visitors stand at +Z, whoever works there sits at −Z. */
export const receptionDesk = once((): Model => {
  const b = new Build();
  const W = 3.4;
  const white = M.paint('#f2f4f7', 0.5);
  const oak = M.wood('#b98d5e');
  const stone = M.ceramic('#f3f1ec', 0.22);
  b.add(M.steel('#22262e'), at(softBox(W - 0.1, 0.08, 0.72, 0.004, { round: 1 }), 0, 0.04, 0.02), { cast: false });
  // The public front: a white body faced with upright oak battens.
  b.add(white, at(softBox(W, 1.0, 0.12, 0.02, { round: 2 }), 0, 0.58, 0.36));
  // Upright oak battens on a board of the same wood, a shade darker: the gaps between them read as shadow, not as
  // bright lines — fine light stripes crawl as one walks past them.
  b.add(M.wood('#8a6540'), at(softBox(W - 0.2, 0.84, 0.012, 0.004, { round: 1 }), 0, 0.56, 0.422), { turn: true, cast: false });
  const battens = M.wood('#a67c52');
  const n = 44;
  for (let i = 0; i < n; i++) {
    const g = new THREE.BoxGeometry(0.05, 0.8, 0.018);
    b.add(battens, at(g, -W / 2 + 0.135 + (i * (W - 0.27)) / (n - 1), 0.56, 0.436), { turn: true, cast: false });
  }
  for (const s of [-1, 1]) b.add(white, at(softBox(0.1, 1.0, 0.88, 0.02, { round: 2 }), s * (W / 2 - 0.05), 0.58, -0.01));
  // The high counter visitors lean on, and a line of light under its edge.
  b.add(stone, at(slab(W + 0.1, 0.04, 0.4, 0.02, 0.006), 0, 1.1, 0.28));
  b.add(M.glow('#ffe7bf', 1.5), at(softBox(W - 0.2, 0.008, 0.012, 0.003, { round: 1 }), 0, 1.07, 0.437), { cast: false });
  // The working surface behind it.
  b.add(oak, at(slab(W - 0.22, 0.03, 0.62, 0.01, 0.005), 0, 0.745, -0.07));
  b.put(monitor(), -0.55, 0.76, 0.02);
  b.put(keyboard(), -0.55, 0.76, -0.24);
  b.put(deskPlant(), 1.25, 1.12, 0.3, 0, 1.6);
  // A desk bell and a little stand of cards on the counter.
  b.add(M.metal('#d8dde4', 0.2), at(lathe([[0, 0], [0.045, 0], [0.048, 0.006], [0.04, 0.03], [0.02, 0.046], [0.006, 0.05], [0.006, 0.058], [0, 0.06]], 18), 0.5, 1.12, 0.3), { cast: false });
  b.add(M.paint('#22262e', 0.4), at(softBox(0.12, 0.06, 0.05, 0.004, { round: 1 }), -0.9, 1.15, 0.3), { cast: false });
  b.add(M.paint('#f7f8fa', 0.5), at(softBox(0.1, 0.06, 0.03, 0.002, { round: 1 }), -0.9, 1.175, 0.3, -0.2), { cast: false });
  return b.done();
});

const tables = new Map<string, Model>();

/** The meeting table: a long walnut top with soft corners on two black trestles, a cable hatch in the middle. */
export function meetingTable(w: number, d: number): Model {
  const key = `${w}:${d}`;
  const had = tables.get(key);
  if (had) return had;
  const b = new Build();
  const top = 0.76;
  const steel = M.steel('#1f2229', 0.42);
  b.add(M.wood('#7a5638'), at(slab(w, 0.045, d, 0.3, 0.01, 8), 0, top - 0.0225, 0));
  // Two trestles: a foot on the floor, two legs leaning in, a bar under the top; and the beam between them.
  for (const s of [-1, 1]) {
    const x = s * (w / 2 - Math.min(1.0, w * 0.2));
    b.add(steel, at(softBox(0.07, 0.03, d - 0.36, 0.01, { round: 1 }), x, 0.015, 0));
    b.add(steel, at(softBox(0.07, 0.03, d - 0.7, 0.01, { round: 1 }), x, top - 0.06, 0));
    for (const z of [-1, 1]) b.add(steel, tube([[x, 0.02, z * (d / 2 - 0.26)], [x, top - 0.055, z * (d / 2 - 0.42)]], 0.022, 8, 2));
  }
  b.add(steel, at(softBox(w - Math.min(2.0, w * 0.4), 0.05, 0.05, 0.01, { round: 1 }), 0, top - 0.1, 0), { cast: false });
  // Cable hatch, a speakerphone, a carafe with two glasses.
  b.add(M.plastic('#1a1e25'), at(slab(0.5, 0.004, 0.14, 0.02, 0.001), 0, top + 0.002, 0), { cast: false });
  b.add(M.plastic('#22262e', 0.4), at(lathe([[0, 0], [0.085, 0], [0.095, 0.008], [0.085, 0.028], [0.04, 0.034], [0, 0.034]], 22), -0.75, top, 0), { cast: false });
  b.add(M.glow('#3ddc84', 1.2), at(cyl(0.012, 0.012, 0.002, 10), -0.75, top + 0.035, 0), { cast: false });
  const glass = M.glass('#d9eefb', 0.32);
  b.add(glass, at(lathe([[0, 0], [0.04, 0], [0.05, 0.06], [0.05, 0.16], [0.03, 0.2], [0.034, 0.23]], 16), 0.7, top, 0.05), { cast: false });
  for (const dz of [-0.14, 0.2]) b.add(glass, at(lathe([[0, 0], [0.028, 0], [0.034, 0.09]], 12), 0.9, top, dz), { cast: false });
  const m = b.done();
  tables.set(key, m);
  return m;
}

/** The owner's desk, 2.4 × 1.1 m in walnut: the owner sits at −Z, visitors face the panelled front at +Z. */
export const executiveDesk = once((): Model => {
  const b = new Build();
  const walnut = M.wood('#6e4a30');
  const dark = M.wood('#4a3324');
  const brass = M.metal('#b89a5e', 0.3);
  const top = 0.775;
  b.add(walnut, at(slab(2.4, 0.05, 1.1, 0.03, 0.008), 0, top - 0.025, 0));
  for (const s of [-1, 1]) b.add(dark, at(softBox(0.06, top - 0.05, 0.96, 0.01, { round: 1 }), s * 1.1, (top - 0.05) / 2, 0), { turn: true });
  b.add(dark, at(softBox(2.14, 0.56, 0.03, 0.006, { round: 1 }), 0, top - 0.33, 0.36));
  // Drawers on the owner's right.
  b.add(dark, at(softBox(0.5, 0.6, 0.8, 0.01, { round: 1 }), 0.8, 0.4, -0.04));
  let y = 0.7;
  for (const h of [0.14, 0.14, 0.3]) {
    y -= h / 2 + 0.006;
    b.add(walnut, at(softBox(0.47, h, 0.016, 0.005, { round: 1 }), 0.8, y, -0.446), { cast: false });
    b.add(brass, at(softBox(0.14, 0.012, 0.016, 0.005, { round: 1 }), 0.8, y + h / 2 - 0.035, -0.46), { cast: false });
    y -= h / 2;
  }
  // On it: a leather pad, the monitor and keyboard, a brass lamp, a plant, a cup.
  b.add(M.leather('#20242c'), at(slab(0.9, 0.006, 0.5, 0.02, 0.002), -0.1, top + 0.003, -0.2), { cast: false });
  b.put(monitor(), -0.1, top, 0.22);
  b.put(keyboard(), -0.1, top + 0.006, -0.2);
  b.add(brass, lathe([[0, top], [0.07, top], [0.075, top + 0.008], [0.02, top + 0.02], [0.012, top + 0.03], [0, top + 0.03]], 18).translate(0.95, 0, 0.3), { cast: false });
  b.add(brass, tube([[0.95, top + 0.02, 0.3], [0.95, top + 0.34, 0.3], [0.9, top + 0.44, 0.24], [0.78, top + 0.46, 0.12]], 0.008, 6, 16), { cast: false });
  b.add(brass, at(lathe([[0.012, 0.05], [0.05, 0.0], [0.075, -0.05], [0.07, -0.05], [0.046, 0.0], [0.01, 0.045]], 16), 0.74, top + 0.44, 0.08, 0.5, -0.6, 0.3), { cast: false });
  b.add(M.glow('#ffe7bf', 1.6), at(sphere(0.022, 10, 8), 0.73, top + 0.415, 0.07), { cast: false });
  b.put(deskPlant(), -0.98, top, 0.32, 0, 1.4);
  b.put(mug('#22262e'), 0.48, top, -0.12, 2.4);
  // The name plate facing visitors.
  b.add(brass, at(softBox(0.26, 0.05, 0.012, 0.004, { round: 1 }), -0.6, top + 0.03, 0.44, -0.25), { cast: false });
  b.add(dark, at(softBox(0.28, 0.012, 0.05, 0.004, { round: 1 }), -0.6, top + 0.006, 0.43), { cast: false });
  return b.done();
});

/**
 * The kitchen run, `L` long along X with its doors toward +Z: floor cabinets under a stone top, a sink and
 * tap, a coffee machine, a rack of cups, a bowl of fruit.
 */
export const kitchen = keyed((L: number): Model => {
  const b = new Build();
  const white = M.paint('#f4f5f7', 0.5);
  const carcass = M.paint('#dfe3e9', 0.6);
  const alu = M.metal('#c5cad3', 0.32);
  const stone = M.ceramic('#ecebe7', 0.28);
  const D = 0.76;
  b.add(M.steel('#22262e'), at(softBox(L - 0.04, 0.1, D - 0.1, 0.004, { round: 1 }), 0, 0.05, -0.03), { cast: false });
  b.add(carcass, at(softBox(L, 0.8, D, 0.008, { round: 1 }), 0, 0.5, 0));
  const n = Math.round(L / 0.575);
  const dw = L / n;
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + dw * (i + 0.5);
    const drawers = i === 1 || i === n - 2;
    if (drawers) {
      let y = 0.895;
      for (const h of [0.18, 0.27, 0.32]) {
        y -= h / 2 + 0.004;
        b.add(white, at(softBox(dw - 0.008, h, 0.018, 0.005, { round: 1 }), x, y, D / 2 + 0.008), { cast: false });
        b.add(alu, at(softBox(dw * 0.5, 0.01, 0.014, 0.004, { round: 1 }), x, y + h / 2 - 0.035, D / 2 + 0.024), { cast: false });
        y -= h / 2 + 0.004;
      }
    } else {
      b.add(white, at(softBox(dw - 0.008, 0.78, 0.018, 0.005, { round: 1 }), x, 0.5, D / 2 + 0.008), { cast: false });
      b.add(alu, at(softBox(0.01, 0.16, 0.014, 0.004, { round: 1 }), x + (i % 2 ? -1 : 1) * (dw / 2 - 0.045), 0.76, D / 2 + 0.024), { cast: false });
    }
  }
  b.add(stone, at(slab(L + 0.04, 0.04, D + 0.06, 0.012, 0.006), 0, 0.92, 0.01));
  const top = 0.94;
  // Upstand against the wall.
  b.add(stone, at(softBox(L + 0.04, 0.1, 0.02, 0.004, { round: 1 }), 0, top + 0.05, -D / 2 - 0.008), { cast: false });
  // Sink: a steel bowl let into the top, with a tall tap behind it.
  const sx = L / 2 - 1.0;
  b.add(M.metal('#aeb4bd', 0.3), at(softBox(0.5, 0.012, 0.38, 0.03, { round: 2 }), sx, top + 0.001, 0.02), { cast: false });
  b.add(M.metal('#7d838c', 0.35), at(softBox(0.44, 0.012, 0.32, 0.03, { round: 2 }), sx, top + 0.003, 0.02), { cast: false });
  b.add(alu, tube([[sx, top, -0.24], [sx, top + 0.26, -0.24], [sx, top + 0.33, -0.19], [sx, top + 0.3, -0.1], [sx, top + 0.24, -0.08]], 0.011, 8, 18), { cast: false });
  b.add(alu, at(cyl(0.02, 0.024, 0.03, 12), sx, top + 0.015, -0.24), { cast: false });
  b.add(alu, at(softBox(0.012, 0.012, 0.08, 0.004, { round: 1 }), sx + 0.06, top + 0.06, -0.24, 0, 0.6), { cast: false });
  // Coffee machine.
  const cx = -L / 2 + 1.3;
  const black = M.plastic('#1a1d23', 0.4);
  b.add(black, at(softBox(0.3, 0.36, 0.36, 0.03, { round: 2 }), cx, top + 0.18, -0.06));
  b.add(alu, at(softBox(0.31, 0.05, 0.37, 0.02, { round: 1 }), cx, top + 0.345, -0.06), { cast: false });
  b.add(M.metal('#8a9099', 0.3), at(softBox(0.24, 0.012, 0.16, 0.006, { round: 1 }), cx, top + 0.02, 0.15), { cast: false });
  b.add(alu, at(cyl(0.028, 0.028, 0.04, 14), cx, top + 0.25, 0.14), { cast: false });
  b.add(black, at(softBox(0.02, 0.02, 0.12, 0.006, { round: 1 }), cx + 0.03, top + 0.235, 0.2, 0, 0.5), { cast: false });
  b.add(M.glow('#6ea8ff', 1.4), at(cyl(0.012, 0.012, 0.004, 10), cx - 0.09, top + 0.3, 0.121, Math.PI / 2), { cast: false });
  b.put(mug('#f2f0ea'), cx, top + 0.026, 0.15, 1.2);
  // Cups waiting beside it, a kettle, and fruit.
  ['#f2f0ea', '#c96f4a', '#4f6d8f', '#f2f0ea', '#3b4350'].forEach((c, i) => b.put(mug(c), cx + 0.36 + (i % 3) * 0.105, top, -0.2 + Math.floor(i / 3) * 0.12, i * 1.3));
  const kx = cx - 0.5;
  b.add(M.metal('#d0d5dc', 0.22), at(lathe([[0, 0], [0.085, 0], [0.09, 0.01], [0.07, 0.2], [0.064, 0.215], [0, 0.22]], 20), kx, top, -0.1), { cast: false });
  b.add(black, at(torus(0.06, 0.009, 6, 14, Math.PI), kx + 0.075, top + 0.12, -0.1, 0, 0, -Math.PI / 2), { cast: false });
  b.add(black, at(sphere(0.014, 8, 6), kx, top + 0.228, -0.1), { cast: false });
  const fx = L / 2 - 2.1;
  b.add(M.wood('#b98d5e'), at(lathe([[0, 0], [0.07, 0], [0.13, 0.03], [0.165, 0.075], [0.158, 0.08], [0.12, 0.04], [0.06, 0.014], [0, 0.012]], 22), fx, top, 0), { cast: false });
  const fruit = M.varied(0.5);
  [['#d9483b', -0.05, 0.02], ['#e8a33c', 0.05, 0.03], ['#8fb84a', 0.0, -0.06], ['#d9483b', 0.02, 0.0]].forEach(([c, dx, dz], i) => b.add(fruit, tint(at(sphere(0.042, 12, 8), fx + (dx as number), top + (i === 3 ? 0.11 : 0.06), dz as number), c as string), { cast: false }));
  return b.done();
});

/** A tall fridge-freezer in brushed steel, its doors toward +Z. */
export const fridge = once((): Model => {
  const b = new Build();
  const steel = M.metal('#c9ced6', 0.42);
  b.add(M.steel('#3a3f48', 0.5), at(softBox(0.76, 1.86, 0.7, 0.015, { round: 1 }), 0, 0.95, -0.03));
  b.add(steel, at(softBox(0.78, 1.16, 0.05, 0.016, { round: 2 }), 0, 1.3, 0.345));
  b.add(steel, at(softBox(0.78, 0.66, 0.05, 0.016, { round: 2 }), 0, 0.37, 0.345));
  const dark = M.steel('#2a2f38', 0.35);
  b.add(dark, at(softBox(0.022, 0.62, 0.03, 0.008, { round: 1 }), -0.31, 1.18, 0.39), { cast: false });
  b.add(dark, at(softBox(0.022, 0.3, 0.03, 0.008, { round: 1 }), -0.31, 0.5, 0.39), { cast: false });
  b.add(M.gloss('#0b0d11'), at(softBox(0.16, 0.1, 0.004, 0.002, { round: 1 }), 0.12, 1.5, 0.372), { cast: false });
  b.add(M.glow('#6ea8ff', 1.1), at(softBox(0.06, 0.02, 0.002, 0.001, { round: 1 }), 0.12, 1.5, 0.375), { cast: false });
  return b.done();
});

/**
 * A server rack 0.8 × 2.0 × 1.05 m, its door toward +Z: a steel frame, a smoked-glass door with a handle,
 * a vented top. The lights of the machines inside are drawn by the scene behind the door line.
 */
export const rack = once((): Model => {
  const b = new Build();
  const frame = M.steel('#262c37', 0.42);
  const trim = M.steel('#3a424f', 0.38);
  b.add(frame, at(softBox(0.8, 1.94, 1.0, 0.012, { round: 1 }), 0, 1.01, -0.02));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(trim, at(cyl(0.03, 0.035, 0.04, 10), sx * 0.32, 0.02, sz * 0.42), { cast: false });
  // The door: a frame around the machines' faces, standing a little proud of the body.
  b.add(trim, at(softBox(0.78, 1.9, 0.02, 0.008, { round: 1 }), 0, 1.01, 0.492), { cast: false });
  b.add(rackFace(), at(new THREE.PlaneGeometry(0.68, 1.78), 0, 1.01, 0.5035), { cast: false, keepUV: true });
  b.add(M.metal('#c5cad3', 0.3), at(softBox(0.016, 0.22, 0.02, 0.006, { round: 1 }), 0.362, 1.05, 0.512), { cast: false });
  // Vent slots in the top and the side panels' seams.
  for (let i = 0; i < 7; i++) b.add(M.paint('#0b0d11', 0.8), at(softBox(0.5, 0.004, 0.03, 0.001, { round: 1 }), 0, 1.981, -0.36 + i * 0.1), { cast: false });
  for (const s of [-1, 1]) b.add(trim, at(softBox(0.006, 1.8, 0.86, 0.002, { round: 1 }), s * 0.4, 1.01, -0.03), { cast: false });
  return b.done();
});

/**
 * What is seen through a rack's door: machines of one, two and four units stacked up, with their drive bays,
 * vents and handles. A picture, the same for every rack; the lights that mean something are drawn over it.
 */
const rackFace = once(() => {
  if (typeof document === 'undefined') return new THREE.MeshStandardMaterial({ color: '#12151a' });
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 672;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, 256, 672);
  let seed = 97;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let y = 10;
  while (y < 650) {
    const u = rnd() < 0.5 ? 16 : rnd() < 0.7 ? 32 : 64;
    if (y + u > 662) break;
    ctx.fillStyle = rnd() < 0.3 ? '#2b313b' : '#1d2129';
    ctx.fillRect(10, y, 236, u - 2);
    ctx.fillStyle = '#3a414d';
    ctx.fillRect(10, y, 236, 1);
    // Ears with their screws, then either drive bays or a vent grille.
    ctx.fillStyle = '#12151a';
    ctx.fillRect(10, y, 10, u - 2);
    ctx.fillRect(236, y, 10, u - 2);
    if (u >= 32 && rnd() < 0.7) {
      const bays = u >= 64 ? 12 : 6;
      const rows = u >= 64 ? 2 : 1;
      for (let r = 0; r < rows; r++)
        for (let i = 0; i < bays / rows; i++) {
          ctx.fillStyle = '#0d0f13';
          ctx.fillRect(28 + i * 33, y + 4 + r * (u / rows - 1), 29, u / rows - 9);
          ctx.fillStyle = '#343b46';
          ctx.fillRect(30 + i * 33, y + 6 + r * (u / rows - 1), 18, 2);
        }
    } else {
      ctx.fillStyle = '#0d0f13';
      for (let i = 0; i < 26; i++) ctx.fillRect(60 + i * 6, y + 3, 3, u - 8);
      ctx.fillStyle = '#343b46';
      ctx.fillRect(26, y + 4, 26, u - 10);
    }
    y += u;
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map, roughness: 0.3, metalness: 0.5, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -24 });
});

/**
 * The vault, 1.2 m wide, 0.9 m deep and 1.7 m high (a lifting eye on top of that), its door toward +Z: a steel
 * body on a plinth and a thick stepped door hung on two barrel hinges (at −X), with a five-spoke wheel, a keypad,
 * a maker's plate and a ring of bolts. Nothing on it moves; the keypad's light is steady.
 */
export const vault = once((): Model => {
  const b = new Build();
  const body = M.steel('#3d4655', 0.46);
  const dark = M.steel('#1b1f27', 0.5);
  const leaf = M.metal('#787f8a', 0.46);
  const face = M.metal('#9ba2ad', 0.4);
  const chrome = M.metal('#d8dde4', 0.2);
  const fitting = M.metal('#aab0ba', 0.3);
  const black = M.plastic('#14161b', 0.5);
  const turned = Math.PI / 2; // a lathed shape's axis laid toward the front

  // The body: a recessed plinth, a base band, the box itself and a cap, the bands a little wider than the box.
  b.add(dark, at(softBox(1.1, 0.08, 0.68, 0.004, { round: 1 }), 0, 0.04, -0.07), { cast: false });
  b.add(body, at(softBox(1.2, 0.07, 0.77, 0.012, { round: 1 }), 0, 0.105, -0.065));
  b.add(body, at(softBox(1.16, 1.53, 0.74, 0.02, { round: 2 }), 0, 0.9, -0.07));
  b.add(body, at(softBox(1.2, 0.05, 0.77, 0.012, { round: 1 }), 0, 1.675, -0.065));
  // A raised panel on each side, for the light to catch; on top a cover plate, and the eye it was lifted in by.
  for (const s of [-1, 1]) b.add(body, at(softBox(0.012, 1.3, 0.54, 0.005, { round: 1 }), s * 0.581, 0.9, -0.07));
  b.add(dark, at(slab(1.02, 0.008, 0.6, 0.03, 0.003), 0, 1.704, -0.065), { cast: false });
  b.add(fitting, at(lathe([[0.05, 0], [0.05, 0.006], [0.03, 0.012], [0.016, 0.016], [0.016, 0.03]], 14), 0, 1.708, -0.065), { cast: false });
  b.add(fitting, at(torus(0.03, 0.009, 6, 18), 0, 1.708 + 0.052, -0.065), { cast: false });

  // The door, 0.98 × 1.38 m: a slab standing out of its opening (the dark behind it is the gap all round), and
  // a raised face on it that leaves a border for the bolts.
  const DY = 0.9;
  const F = 0.375; // the door's face
  b.add(dark, at(new THREE.BoxGeometry(1.02, 1.42, 0.006), 0, DY, 0.301), { cast: false });
  b.add(leaf, at(softBox(0.98, 1.38, 0.06, 0.014, { round: 2 }), 0, DY, 0.32));
  b.add(face, at(softBox(0.84, 1.24, 0.03, 0.012, { round: 2 }), 0, DY, 0.36), { cast: false });

  // Bolts round the border: a washer and a six-sided head each, its flats left flat. None where the hinges sit.
  const washer = lathe([[0.023, 0], [0.023, 0.003], [0.012, 0.003]], 10);
  const hex = lathe([[0.017, 0.003], [0.017, 0.01], [0.0145, 0.013], [0, 0.013]], 6).toNonIndexed();
  hex.computeVertexNormals();
  const HINGES = [DY - 0.437, DY + 0.437];
  const bolts: Array<[number, number]> = [];
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) bolts.push([-0.455 + i * 0.2275, DY + s * 0.655]);
  for (let i = 1; i < 6; i++) for (const s of [-1, 1]) bolts.push([s * 0.455, DY - 0.655 + i * 0.2183]);
  for (const [x, y] of bolts) {
    if (x < 0 && HINGES.some((h) => Math.abs(h - y) < 0.1)) continue;
    b.add(fitting, at(washer, x, y, 0.35, turned), { cast: false });
    b.add(fitting, at(hex, x, y, 0.35, turned), { cast: false });
  }

  // Hinges: a barrel with two grooves at the door's edge, a strap on the door and a block on the body.
  const barrel = lathe([[0, -0.105], [0.02, -0.105], [0.03, -0.095], [0.03, -0.036], [0.025, -0.034], [0.025, -0.03], [0.03, -0.028], [0.03, 0.028], [0.025, 0.03], [0.025, 0.034], [0.03, 0.036], [0.03, 0.095], [0.02, 0.105], [0, 0.105]], 12);
  for (const y of HINGES) {
    b.add(fitting, at(barrel, -0.515, y, 0.345), { cast: false });
    b.add(fitting, at(softBox(0.08, 0.15, 0.012, 0.005, { round: 1 }), -0.458, y, 0.356), { cast: false });
    b.add(body, at(softBox(0.05, 0.16, 0.06, 0.008, { round: 1 }), -0.553, y, 0.33));
  }

  // The wheel, on a dished plate: a flange and a spindle out of the door, the hub, five spokes to the rim and a
  // ball where each meets it.
  const WY = 0.82;
  const WZ = F + 0.075;
  b.add(leaf, at(lathe([[0.268, 0], [0.262, 0.005], [0.236, 0.005], [0.228, 0.002], [0, 0.002]], 32), 0, WY, F, turned), { cast: false });
  b.add(chrome, at(lathe([[0.09, 0.002], [0.09, 0.008], [0.074, 0.013], [0.04, 0.02], [0.032, 0.03], [0.032, 0.056], [0.056, 0.06], [0.06, 0.066], [0.06, 0.084], [0.054, 0.092], [0.03, 0.102], [0, 0.105]], 20), 0, WY, F, turned), { cast: false });
  b.add(chrome, at(torus(0.2, 0.017, 8, 40), 0, WY, WZ), { cast: false });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.add(chrome, at(cyl(0.011, 0.013, 0.15, 8), -Math.sin(a) * 0.122, WY + Math.cos(a) * 0.122, WZ, 0, 0, a), { cast: false });
    b.add(chrome, at(sphere(0.025, 8, 6), -Math.sin(a) * 0.2, WY + Math.cos(a) * 0.2, WZ), { cast: false });
  }

  // The keypad: a black pad in a bright bezel, a dark display, twelve keys and the light.
  const KY = 1.3;
  b.add(fitting, at(softBox(0.18, 0.25, 0.008, 0.014, { round: 1 }), 0, KY, F + 0.004), { cast: false });
  b.add(black, at(softBox(0.16, 0.23, 0.014, 0.01, { round: 1 }), 0, KY, F + 0.007), { cast: false });
  b.add(M.gloss('#0b0d11'), at(softBox(0.094, 0.04, 0.003, 0.002, { round: 1 }), -0.018, KY + 0.075, F + 0.0145), { cast: false });
  b.add(M.glow('#3ddc84', 1.4), at(cyl(0.008, 0.008, 0.004, 12), 0.052, KY + 0.075, F + 0.0145, turned), { cast: false });
  const keys = M.plastic('#4b525e', 0.45);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) b.add(keys, at(new THREE.BoxGeometry(0.03, 0.024, 0.005), (c - 1) * 0.04, KY + 0.035 - r * 0.034, F + 0.0155), { cast: false });

  // The maker's plate, on two screws; what it says is a picture on it.
  b.add(M.metal('#b89a5e', 0.3), at(softBox(0.3, 0.075, 0.006, 0.004, { round: 1 }), 0, 0.42, F + 0.002), { cast: false });
  b.add(vaultPlate(), at(new THREE.PlaneGeometry(0.24, 0.06), 0, 0.42, F + 0.0056), { cast: false, keepUV: true });
  for (const s of [-1, 1]) b.add(dark, at(cyl(0.006, 0.006, 0.003, 8), s * 0.134, 0.42, F + 0.0055, turned), { cast: false });
  return b.done();
});

/** What the vault's brass plate says, engraved: a picture laid on the plate (plain brass where there is nothing to paint on). */
const vaultPlate = once(() => {
  if (typeof document === 'undefined') return M.metal('#b89a5e', 0.3);
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#b89a5e';
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = '#5f4c26';
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, 492, 108);
  ctx.fillStyle = '#4a3a1c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 62px "Inter", "SF Pro Display", "Segoe UI", system-ui, sans-serif';
  // Spaced out by hand: letter spacing on a canvas is not everywhere.
  [...'VAULT'].forEach((ch, i) => ctx.fillText(ch, 256 + (i - 2) * 72, 68));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map, roughness: 0.3, metalness: 0.92, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -24 });
});

/**
 * The operators' console, 5.2 m wide: a long dark desk with a raised, sloped instrument deck toward the
 * screen wall (−Z). Operators stand or sit at +Z.
 */
export const opsConsole = once((): Model => {
  const b = new Build();
  const W = 5.2;
  const body = M.steel('#1c2029', 0.45);
  const top = M.plastic('#262b35', 0.45);
  b.add(M.steel('#12141a'), at(softBox(W - 0.1, 0.08, 0.8, 0.004, { round: 1 }), 0, 0.04, 0), { cast: false });
  b.add(body, at(softBox(W, 0.66, 0.92, 0.02, { round: 2 }), 0, 0.41, 0));
  b.add(top, at(slab(W + 0.06, 0.035, 1.0, 0.03, 0.006), 0, 0.757, 0));
  // The raised deck along the far edge, its face leaning toward the operator.
  const wedge = new THREE.Shape();
  wedge.moveTo(-0.2, 0);
  wedge.lineTo(0.2, 0);
  wedge.lineTo(0.2, 0.06);
  wedge.lineTo(-0.14, 0.3);
  wedge.lineTo(-0.2, 0.3);
  wedge.closePath();
  const g = new THREE.ExtrudeGeometry(wedge, { depth: W - 0.2, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1 });
  g.translate(0, 0, -(W - 0.2) / 2);
  g.rotateY(-Math.PI / 2);
  b.add(body, at(g, 0, 0.775, -0.28));
  // Keyboards and a row of lit keys on the flat.
  for (const x of [-1.6, 0, 1.6]) b.put(keyboard(), x, 0.775, 0.22, Math.PI);
  const colors = ['#3ddc84', '#3ddc84', '#f0c36a', '#6ea8ff', '#ff6b7d', '#6ea8ff', '#3ddc84', '#f0c36a'];
  for (let i = 0; i < 24; i++) {
    if (i % 8 === 7) continue;
    const x = -W / 2 + 0.5 + i * 0.18;
    b.add(M.glow(colors[i % colors.length]!, 1.1), at(softBox(0.035, 0.008, 0.035, 0.003, { round: 1 }), x, 0.779, 0.42), { cast: false });
  }
  // A strip of light under the front edge.
  b.add(M.glow('#3ddc84', 1.3), at(softBox(W - 0.4, 0.008, 0.01, 0.003, { round: 1 }), 0, 0.72, 0.465), { cast: false });
  return b.done();
});

/** The low media cabinet under the TV, 2.6 m wide, its doors toward +Z. */
export const mediaConsole = once((): Model => {
  const b = new Build();
  const walnut = M.wood('#6e4a30');
  const W = 2.6;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(M.steel('#1f2229', 0.4), at(cyl(0.014, 0.01, 0.12, 8), sx * (W / 2 - 0.12), 0.06, sz * 0.14), { cast: false });
  b.add(walnut, at(softBox(W, 0.34, 0.42, 0.014, { round: 2 }), 0, 0.29, 0));
  // Four slatted doors.
  const slat = M.wood('#5a3c27');
  for (let i = 0; i < 4; i++) {
    const x = -W / 2 + (W / 4) * (i + 0.5);
    b.add(slat, at(softBox(W / 4 - 0.012, 0.3, 0.012, 0.004, { round: 1 }), x, 0.29, 0.212), { cast: false });
    for (let k = 0; k < 9; k++) b.add(walnut, at(new THREE.BoxGeometry(W / 4 - 0.05, 0.012, 0.008), x, 0.17 + k * 0.03, 0.222), { cast: false });
  }
  // A game console and a soundbar on top.
  b.add(M.plastic('#f2f3f5', 0.4), at(softBox(0.26, 0.05, 0.2, 0.012, { round: 2 }), 0.85, 0.485, 0), { cast: false });
  b.add(M.plastic('#15181e', 0.5), at(softBox(1.1, 0.07, 0.1, 0.03, { round: 2 }), -0.2, 0.495, 0.06), { cast: false });
  return b.done();
});

/**
 * The hi-fi, 3.0 m wide with its front toward +Z: a walnut sideboard on legs between two floor speakers, a
 * receiver and a turntable on it. What moves or lights up with the music — the speaker cones, the level
 * meter, the record — is drawn by the scene on top of this.
 */
export const hifi = once((): Model => {
  const b = new Build();
  const walnut = M.wood('#7a5638');
  const black = M.plastic('#14161b', 0.5);
  const alu = M.metal('#c5cad3', 0.34);
  const steel = M.steel('#1f2229', 0.4);
  // Sideboard: a body on four turned legs, two sliding doors with finger pulls.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(walnut, at(cyl(0.022, 0.013, 0.16, 10), sx * 0.66, 0.08, sz * 0.17), { cast: false });
  b.add(walnut, at(softBox(1.5, 0.4, 0.48, 0.02, { round: 2 }), 0, 0.36, 0));
  for (const s of [-1, 1]) {
    b.add(M.wood('#6a4930'), at(softBox(0.7, 0.33, 0.012, 0.005, { round: 1 }), s * 0.36, 0.36, 0.242), { turn: true, cast: false });
    b.add(steel, at(cyl(0.018, 0.018, 0.006, 14), s * 0.08, 0.36, 0.249, Math.PI / 2), { cast: false });
  }
  // Receiver: a black case with a brushed face, a display window, one big knob and two small.
  const rx = -0.36;
  const top = 0.56;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(steel, at(cyl(0.016, 0.016, 0.012, 10), rx + sx * 0.25, top + 0.006, 0.02 + sz * 0.14), { cast: false });
  b.add(black, at(softBox(0.62, 0.13, 0.36, 0.012, { round: 1 }), rx, top + 0.077, 0.02));
  b.add(alu, at(softBox(0.63, 0.135, 0.012, 0.005, { round: 1 }), rx, top + 0.077, 0.205), { cast: false });
  b.add(M.gloss('#07090c'), at(softBox(0.32, 0.075, 0.004, 0.002, { round: 1 }), rx - 0.1, top + 0.087, 0.2115), { cast: false });
  const knob = (r: number, x: number, y: number) => {
    b.add(alu, at(lathe([[0, 0.03], [r * 0.86, 0.03], [r, 0.024], [r, 0.004], [r * 0.9, 0]], 20), x, y, 0.211, Math.PI / 2), { cast: false });
    b.add(black, at(softBox(0.003, r * 0.7, 0.002, 0.0008, { round: 1 }), x, y + r * 0.5, 0.2415), { cast: false });
  };
  knob(0.034, rx + 0.2, top + 0.085);
  for (const dx of [0.1, 0.27]) knob(0.014, rx + dx, top + 0.04);
  // Turntable: a plinth on feet, the platter's rim, the arm on its pivot.
  const tx = 0.36;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(steel, at(cyl(0.02, 0.018, 0.014, 10), tx + sx * 0.2, top + 0.007, 0.02 + sz * 0.15), { cast: false });
  b.add(walnut, at(softBox(0.5, 0.05, 0.4, 0.012, { round: 1 }), tx, top + 0.039, 0.02));
  b.add(black, at(softBox(0.488, 0.006, 0.388, 0.002, { round: 1 }), tx, top + 0.066, 0.02), { cast: false });
  b.add(alu, at(lathe([[0, 0.012], [0.165, 0.012], [0.168, 0.009], [0.168, 0], [0, 0]], 40), tx - 0.04, top + 0.069, 0.02), { cast: false });
  b.add(alu, at(cyl(0.02, 0.024, 0.04, 14), tx + 0.19, top + 0.089, -0.12), { cast: false });
  b.add(alu, tube([[tx + 0.19, top + 0.108, -0.17], [tx + 0.19, top + 0.108, -0.12], [tx + 0.17, top + 0.104, 0.04], [tx + 0.11, top + 0.098, 0.1]], 0.0045, 6, 14), { cast: false });
  b.add(black, at(cyl(0.014, 0.014, 0.03, 10), tx + 0.19, top + 0.108, -0.16, Math.PI / 2), { cast: false });
  b.add(black, at(softBox(0.018, 0.008, 0.034, 0.003, { round: 1 }), tx + 0.1, top + 0.096, 0.108, 0, -0.7), { cast: false });
  // Speakers: walnut cabinets on plinths, a black baffle, a trim ring round each driver.
  for (const s of [-1, 1]) {
    const x = s * 1.1;
    b.add(steel, at(softBox(0.3, 0.03, 0.28, 0.006, { round: 1 }), x, 0.015, 0), { cast: false });
    b.add(walnut, at(softBox(0.36, 1.03, 0.34, 0.025, { round: 2 }), x, 0.545, 0), { turn: true });
    b.add(black, at(softBox(0.31, 0.98, 0.01, 0.004, { round: 1 }), x, 0.545, 0.169), { cast: false });
    for (const [y, r] of [[0.855, 0.05], [0.575, 0.105], [0.255, 0.125]] as Array<[number, number]>) b.add(alu, at(torus(r + 0.008, 0.005, 6, 28), x, y, 0.174), { cast: false });
    // The bass port.
    b.add(M.paint('#050608', 0.9), at(cyl(0.03, 0.03, 0.004, 16), x + 0.1, 0.095, 0.175, Math.PI / 2), { cast: false });
  }
  return b.done();
});

/** A loudspeaker cone of radius 1 facing +Z: dust cap, the cone falling back from it, and the rolled surround. */
export const speakerCone = once(() => {
  const g = lathe([[0, 0.1], [0.14, 0.085], [0.24, 0.03], [0.27, -0.03], [0.5, 0.0], [0.78, 0.06], [0.84, 0.1], [0.92, 0.13], [1.0, 0.09]], 28);
  g.rotateX(Math.PI / 2);
  return g;
});
