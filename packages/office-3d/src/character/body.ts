import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { HANDLE_LEN, HIP_X, SHIN, TAU, THIGH, UPPER_ARM, clamp01, lerp, smooth } from './motion.ts';
import { STRIPE, type Sec, ball, clothUV, finish, frontPatch, fuse, jointed, loft, mirrorX, onBones, orient, paint, resample, ringGeo, secAt, sheet, spow, tube, xf } from './shape.ts';

/**
 * The body and what it wears: torso per garment, the seat of the trousers, arms and legs that bend, collars, cuffs
 * and hems, hands, shoes. Everything hangs from the hip centre (y up, z forward, x to the character's left), at the
 * sizes the poses and the furniture expect: shoulders at (±0.187, 0.44), hips at ±0.078, the neck joint at 0.585.
 */

/**
 * Cross-sections of the trunk from the waist up: [height, half width, half depth, centre front-to-back, squareness].
 * The chest is carried forward and the shoulder blades back, the waist is drawn in, and the shoulders slope from
 * the neck out to the top of the sleeve, so the arm comes out from under the shoulder rather than off its corner.
 */
const TORSO_TUCKED: Sec[] = [
  [0.05, 0.147, 0.093, 0.0, 2.5],
  [0.09, 0.149, 0.097, 0.002, 2.5],
  [0.17, 0.147, 0.097, 0.004, 2.45],
  [0.25, 0.156, 0.103, 0.008, 2.4],
  [0.33, 0.17, 0.112, 0.013, 2.4],
  [0.385, 0.19, 0.111, 0.008, 2.4],
  [0.415, 0.214, 0.106, 0.002, 2.6],
  [0.443, 0.225, 0.1, -0.002, 2.8],
  [0.467, 0.214, 0.091, -0.003, 2.8],
  [0.488, 0.176, 0.083, -0.005, 2.6],
  [0.507, 0.126, 0.074, -0.007, 2.3],
  [0.522, 0.082, 0.064, -0.008, 2.1],
  [0.534, 0.057, 0.055, -0.009, 2],
];
/** Worn outside the trousers: it hangs straight from the chest to a hem over the hips. */
const TORSO_LOOSE: Sec[] = [
  [-0.056, 0.168, 0.11, -0.002, 2.5],
  [-0.046, 0.176, 0.116, -0.002, 2.5],
  [0.02, 0.173, 0.113, 0.0, 2.5],
  [0.11, 0.162, 0.105, 0.003, 2.5],
  [0.2, 0.158, 0.103, 0.005, 2.45],
  [0.27, 0.161, 0.106, 0.008, 2.4],
  [0.33, 0.172, 0.113, 0.013, 2.4],
  [0.385, 0.192, 0.112, 0.008, 2.4],
  [0.415, 0.216, 0.107, 0.002, 2.6],
  [0.443, 0.227, 0.101, -0.002, 2.8],
  [0.467, 0.216, 0.092, -0.003, 2.8],
  [0.488, 0.178, 0.084, -0.005, 2.6],
  [0.507, 0.127, 0.075, -0.007, 2.3],
  [0.522, 0.082, 0.064, -0.008, 2.1],
  [0.534, 0.057, 0.055, -0.009, 2],
];
/** A tailored jacket: flared skirt over the seat, suppressed waist, full chest, square shoulders. */
const JACKET_HEM = -0.105;
const BUTTON_Y = 0.172;
const TORSO_JACKET: Sec[] = [
  [JACKET_HEM, 0.181, 0.124, -0.007, 2.7],
  [-0.03, 0.179, 0.122, -0.006, 2.7],
  [0.07, 0.167, 0.112, -0.003, 2.7],
  [0.17, 0.156, 0.103, 0.001, 2.6],
  [0.27, 0.164, 0.106, 0.004, 2.6],
  [0.36, 0.18, 0.112, 0.004, 2.5],
  [0.415, 0.216, 0.109, 0.003, 2.6],
  [0.445, 0.229, 0.103, 0.001, 2.8],
  [0.469, 0.218, 0.095, -0.002, 2.8],
  [0.49, 0.18, 0.087, -0.004, 2.5],
  [0.51, 0.126, 0.08, -0.005, 2.2],
  [0.524, 0.08, 0.066, -0.007, 2],
  [0.535, 0.054, 0.053, -0.008, 2],
];
/**
 * The seat of the trousers. It swallows the tops of the thighs and closes under the crotch above the point where
 * the legs part, so what shows between the legs is their own inseam, never a panel.
 */
const PELVIS: Sec[] = [
  [-0.085, 0.03, 0.03, 0.0, 2],
  [-0.065, 0.09, 0.05, -0.004, 2.3],
  [-0.035, 0.14, 0.084, -0.013, 2.5],
  [0.0, 0.168, 0.103, -0.009, 2.5],
  [0.04, 0.167, 0.099, -0.001, 2.5],
  [0.068, 0.158, 0.097, 0.0, 2.5],
  [0.095, 0.125, 0.082, 0.0, 2.4],
];

/** Half width of the shirt showing between the lapels at height y. */
const vEdge = (y: number) => 0.003 + 0.064 * clamp01((y - 0.2) / 0.305);

/** A point on the front of a lofted body at (x, y), pushed out by `off`. */
function frontZ(rows: Sec[], x: number, y: number, off: number): number {
  const sec = secAt(rows, y);
  const u = Math.min(0.995, Math.abs(x) / sec[1]);
  return sec[3] + sec[2] * Math.pow(1 - Math.pow(u, sec[4]), 1 / sec[4]) + off;
}

/** Angles around the jacket (0 = the wearer's left, π/2 = front), denser where the front opens and where the back vent runs. */
function jacketAngles(): number[] {
  const out: number[] = [];
  const N = 40;
  for (let j = 0; j < N; j++) out.push((j / N) * TAU);
  const inv = (x: number) => Math.acos(Math.sign(x) * Math.pow(Math.abs(x) / 0.172, 1.3));
  for (const x of [0, 0.007, -0.007, 0.018, -0.018, 0.032, -0.032, 0.048, -0.048, 0.064, -0.064, 0.08, -0.08]) out.push(inv(x));
  for (const x of [0, 0.005, -0.005, 0.011, -0.011, 0.022, -0.022]) out.push(TAU - inv(x));
  out.sort((a, b) => a - b);
  const kept: number[] = [];
  for (const a of out) if (!kept.length || a - kept[kept.length - 1]! > 0.01) kept.push(a);
  return kept;
}

function buildJacket(): THREE.BufferGeometry {
  const fine = resample(TORSO_JACKET, 4);
  const angles = jacketAngles();
  // The first column is repeated at the end: the cloth's stripes need a seam (it sits under the left arm).
  angles.push(angles[0]! + TAU);
  const n = angles.length;
  const pos: number[] = [];
  const uv: number[] = [];
  // Stripes hang from the chest: each column keeps the stripe it has there.
  const chest = secAt(fine, 0.36);
  const us: number[] = [0];
  for (let j = 1; j < n; j++) {
    const a0 = angles[j - 1]!;
    const a1 = angles[j]!;
    us.push(us[j - 1]! + Math.hypot(chest[1] * (spow(Math.cos(a1), chest[4]) - spow(Math.cos(a0), chest[4])), chest[2] * (spow(Math.sin(a1), chest[4]) - spow(Math.sin(a0), chest[4]))));
  }
  const stripes = Math.round(us[n - 1]! / STRIPE);
  for (const row of fine) {
    for (let j = 0; j < n; j++) {
      const a = angles[j]!;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const x0 = row[1] * spow(c, row[4]);
      let y = row[0];
      if (sn > 0 && y < 0.2) {
        // Below the button the fronts are cut away in a curve, showing the trousers.
        const u = Math.min(1, Math.abs(x0) / 0.078);
        const edge = lerp(BUTTON_Y - 0.014, JACKET_HEM, Math.pow(u, 0.8));
        y = edge + ((y - JACKET_HEM) * (0.2 - edge)) / (0.2 - JACKET_HEM);
      } else if (sn < 0 && y < 0) {
        // The centre vent opens a little at the hem.
        const edge = JACKET_HEM + 0.045 * Math.max(0, 1 - Math.abs(x0) / 0.014);
        y = edge + ((y - JACKET_HEM) * (0 - edge)) / (0 - JACKET_HEM);
      }
      const sec = y === row[0] ? row : secAt(fine, y);
      const x = sec[1] * spow(c, sec[4]);
      let z = sec[3] + sec[2] * spow(sn, sec[4]);
      if (sn < 0) {
        // Vent below the waist, a faint centre seam above it.
        const depth = lerp(0.013, 0.002, smooth(0.06, 0.13, y)) * (1 - smooth(0.38, 0.46, y));
        z += depth * Math.exp(-((x / 0.009) ** 2));
        // One side of the vent laps over the other.
        if (x > 0 && y < 0.1) z -= 0.007 * (1 - smooth(0.04, 0.1, y)) * Math.max(0, 1 - x / 0.04);
      }
      pos.push(x, y, z);
      uv.push((us[j]! / us[n - 1]!) * stripes, row[0]);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < fine.length - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  orient(g);
  // Both sides of the seam share one normal.
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < fine.length; i++) {
    const a = i * n;
    const b = a + n - 1;
    const x = nor.getX(a) + nor.getX(b);
    const y = nor.getY(a) + nor.getY(b);
    const z = nor.getZ(a) + nor.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nor.setXYZ(a, x / l, y / l, z / l);
    nor.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Give a body part cloth coordinates as seen from the front, so a suit's stripes run down it. */
function striped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / STRIPE;
    uv[i * 2 + 1] = pos.getY(i);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** A patch from a grid of points, with its triangles facing (dx, dy, dz). */
function grid(nu: number, nv: number, at: (i: number, j: number, out: number[]) => void, dx: number, dy: number, dz: number, slant = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) at(i, j, pos);
  // Cloth stripes run straight down the patch, or at a slant (a lapel is the jacket's front folded back).
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uv.push((pos[i]! * Math.cos(slant) + pos[i + 1]! * Math.sin(slant)) / STRIPE, pos[i + 1]!);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j;
      const b = a + 1;
      const c = a + nv + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  let dot = 0;
  for (let i = 0; i < n.count; i++) dot += n.getX(i) * dx + n.getY(i) * dy + n.getZ(i) * dz;
  if (dot < 0) {
    const a = g.index!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
    g.computeVertexNormals();
  }
  return g;
}

/** A notch lapel: rolled where it folds back from the shirt, widening to a peak at the chest, stepping in where the collar takes over. */
function buildLapel(rows: Sec[], side: 1 | -1): THREE.BufferGeometry {
  const ys: number[] = [];
  const ws: number[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    ys.push(lerp(0.19, 0.428, t));
    ws.push(0.004 + 0.05 * Math.pow(Math.sin((t * Math.PI) / 2), 0.8));
  }
  ys.push(0.43, 0.45, 0.472, 0.494);
  ws.push(0.03, 0.033, 0.034, 0.03);
  const nx = 4;
  return grid(
    ys.length - 1,
    nx,
    (i, j, out) => {
      const y = ys[i]!;
      const u = j / nx;
      const x = vEdge(y) - 0.004 + ws[i]! * u;
      out.push(side * x, y, frontZ(rows, x, y, lerp(0.0105, 0.0045, Math.pow(u, 0.7))));
    },
    0,
    0,
    1,
    side * 0.42,
  );
}

/** The jacket's own collar: a band standing round the back and sides of the neck, leaving a rim of shirt collar above it. */
function buildJacketCollar(): THREE.BufferGeometry {
  const seg = 30;
  const gap = 0.8;
  const prof: [number, number, number][] = [
    [0.1, 0.088, 0.008],
    [0.09, 0.08, 0.027],
    [0.0775, 0.072, 0.05],
    [0.069, 0.064, 0.044],
  ];
  return grid(
    prof.length - 1,
    seg,
    (i, j, out) => {
      const a = lerp(Math.PI / 2 + gap, Math.PI / 2 - gap + TAU, j / seg);
      const end = smooth(0, 1, Math.min(j, seg - j) / 3);
      const p = prof[i]!;
      out.push(p[0] * Math.cos(a), 0.487 + p[2] * end, -0.005 + p[1] * Math.sin(a));
    },
    0,
    0.3,
    -1,
  );
}

/** A strip lying on a lofted body between two angles and two heights (pocket flaps). */
function wrapPatch(rows: Sec[], a0: number, a1: number, y0: number, y1: number, off: number): THREE.BufferGeometry {
  const am = (a0 + a1) / 2;
  return grid(
    2,
    8,
    (i, j, out) => {
      const y = lerp(y0, y1, i / 2);
      const a = lerp(a0, a1, j / 8);
      const sec = secAt(rows, y);
      const x = sec[1] * spow(Math.cos(a), sec[4]);
      const z = sec[3] + sec[2] * spow(Math.sin(a), sec[4]);
      const r = Math.hypot(x, z) || 1;
      out.push(x * (1 + off / r), y, z * (1 + off / r));
    },
    Math.cos(am),
    0,
    Math.sin(am),
  );
}

// ───────────────────────────── collars, hems, neck ─────────────────────────────

/** A point on a lofted body at angle `a` round it (0 = the wearer's left, π/2 = front) and height y, pushed out by `off`. */
function wrapPt(rows: Sec[], a: number, y: number, off: number): [number, number, number] {
  const sec = secAt(rows, y);
  const x = sec[1] * spow(Math.cos(a), sec[4]);
  const z = sec[2] * spow(Math.sin(a), sec[4]);
  const r = Math.hypot(x, z) || 1;
  return [x * (1 + off / r), y, sec[3] + z * (1 + off / r)];
}

/** Turn a surface that goes round the body so that it faces away from the point (cx, cy, cz). */
function outward(g: THREE.BufferGeometry, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  let dot = 0;
  for (let i = 0; i < pos.count; i++) dot += nor.getX(i) * (pos.getX(i) - cx) + nor.getY(i) * (pos.getY(i) - cy) + nor.getZ(i) * (pos.getZ(i) - cz);
  if (dot < 0) {
    const a = g.index!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
    g.computeVertexNormals();
  }
  return g;
}

interface Collar {
  /** Height of the fold at the back of the neck and at the front; how tall the band under it stands. */
  back: number;
  front: number;
  stand: number;
  /** Half the opening at the throat, and how far to each side the points lie (both as angles round the body). */
  gap: number;
  spread: number;
  /** Height of the leaf's edge on the shoulders, and of its points on the chest; how much the leaf rolls. */
  edge: number;
  tip: number;
  roll: number;
}

/**
 * A turned-down collar: a band standing round the neck, folded over into a leaf that lies on the shoulders and
 * comes down to a point on each side of the throat. One sheet, so the leaf has an underside and an edge.
 */
function foldCollar(rows: Sec[], c: Collar): THREE.BufferGeometry {
  const N = 44;
  const lines: number[][] = [[], [], [], [], []];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const s = 2 * t - 1;
    const a = Math.PI / 2 - c.gap - t * (TAU - 2 * c.gap);
    const end = smooth(0.7, 1, Math.abs(s));
    const fy = lerp(c.back, c.front, Math.pow(Math.max(0, Math.sin(a)), 2));
    const fx = 0.0605 * Math.cos(a);
    const fz = -0.006 + 0.057 * Math.sin(a);
    const ao = a + (c.spread - c.gap) * s * end;
    const oy = lerp(c.edge, c.tip, Math.pow(end, 1.5));
    const o = wrapPt(rows, ao, oy, 0.0075);
    const u = wrapPt(rows, ao, oy + 0.007, -0.002);
    lines[0]!.push(0.066 * Math.cos(a), fy - c.stand, -0.006 + 0.062 * Math.sin(a));
    lines[1]!.push(fx, fy, fz);
    lines[2]!.push(((fx + o[0]) / 2) * 1.05, (fy + oy) / 2 + c.roll + 0.006, ((fz + o[2]) / 2) * 1.05);
    lines[3]!.push(o[0], o[1], o[2]);
    lines[4]!.push(u[0], u[1], u[2]);
  }
  return outward(sheet(lines), 0, 0.5, 0);
}

/**
 * The collar of a shirt worn under a jacket and closed by a tie: a band standing inside the jacket's own collar
 * (a rim of it shows above that all the way round), and a point lying on the shirt front on each side of the knot.
 */
function tieCollar(rows: Sec[]): THREE.BufferGeometry {
  const fold = (a: number) => lerp(0.557, 0.533, Math.pow(Math.max(0, Math.sin(a)), 2));
  const seg = 28;
  const rings: number[][] = [[], [], [], []];
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * TAU;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    rings[0]!.push(0.0655 * c, 0.5, -0.006 + 0.061 * sn);
    rings[1]!.push(0.0625 * c, fold(a), -0.006 + 0.0585 * sn);
    rings[2]!.push(0.057 * c, fold(a) - 0.001, -0.006 + 0.054 * sn);
    rings[3]!.push(0.056 * c, 0.505, -0.006 + 0.053 * sn);
  }
  const parts = [ringGeo(rings, false, false)];
  for (const side of [1, -1]) {
    const lines: number[][] = [[], [], []];
    const n = 8;
    for (let j = 0; j <= n; j++) {
      // Along the fold from the throat round to the side of the neck…
      const a = Math.PI / 2 - side * lerp(0.06, 1.05, j / n);
      const top: [number, number, number] = [0.0635 * Math.cos(a), fold(a), -0.006 + 0.0595 * Math.sin(a)];
      // …and the leaf's edge on the shirt front: down to the point beside the knot, then back up to the fold.
      const u = j <= 2 ? j / 2 : 1 - (j - 2) / (n - 2);
      const ex = j <= 2 ? lerp(0.005, 0.033, u) : lerp(0.057, 0.033, u);
      const ey = j <= 2 ? lerp(0.514, 0.493, u) : lerp(0.53, 0.493, Math.pow(u, 1.3));
      const ez = frontZ(rows, ex, ey, 0.0085);
      lines[0]!.push(top[0], top[1], top[2]);
      lines[1]!.push((top[0] + side * ex) / 2, (top[1] + ey) / 2 + 0.002, (top[2] + ez) / 2 + 0.004);
      lines[2]!.push(side * ex, ey, ez);
    }
    parts.push(outward(sheet(lines), 0, 0.45, 0));
  }
  return fuse(parts);
}

/** A band of cloth round a lofted body (a ribbed hem, a neckband), standing a little proud of it with its edges turned in. */
function band(secs: Sec[], seg = 32): THREE.BufferGeometry {
  return loft(secs, 2, seg, false, false);
}

/** Skin at the open neck of a shirt: a shallow V lying on the top of the chest, its edges turned in under the cloth. */
function openNeck(rows: Sec[], bottom: number, halfTop: number): THREE.BufferGeometry {
  const top = 0.534;
  const ny = 8;
  const nx = 3;
  const lines: number[][] = [];
  for (let i = 0; i <= ny; i++) {
    const t = i / ny;
    const y = lerp(bottom, top, t);
    const w = halfTop * Math.pow(t, 0.8);
    const line: number[] = [];
    for (let j = -nx; j <= nx; j++) {
      const x = (w * j) / nx;
      const off = i === 0 ? -0.002 : lerp(0.0032, -0.002, Math.pow(Math.abs(j) / nx, 2));
      line.push(x, y, frontZ(rows, x, y, off));
    }
    lines.push(line);
  }
  return outward(sheet(lines), 0, 0.4, 0);
}

const NECK: Sec[] = [
  [0.47, 0.058, 0.055, -0.01, 2],
  [0.51, 0.052, 0.051, -0.008, 2],
  [0.55, 0.051, 0.051, -0.005, 2],
  [0.6, 0.0505, 0.051, -0.001, 2],
  [0.632, 0.05, 0.051, 0.002, 2],
  [0.648, 0.043, 0.044, 0.003, 2],
];

/** A button lying on the front of a lofted body. */
function button(rows: Sec[], y: number, r: number, off = 0.003): THREE.BufferGeometry {
  return xf(ball(8, 5), 0, y, frontZ(rows, 0, y, off), 0, 0, 0, r, r, r * 0.45);
}

// ───────────────────────────── hands ─────────────────────────────

/**
 * A relaxed left hand hanging from the wrist: palm toward the body (−x), thumb forward (+z), four fingers side by
 * side, each one smooth curve in toward the palm. The right hand is its mirror image.
 */
function buildHand(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    loft(
      [
        [0.01, 0.017, 0.0235, 0.0, 2.2],
        [-0.012, 0.0165, 0.03, 0.0015, 2.5],
        [-0.034, 0.015, 0.0365, 0.002, 2.8],
        [-0.054, 0.013, 0.0378, 0.001, 2.8],
        [-0.065, 0.0095, 0.0345, 0.0, 2.6],
      ],
      2,
      12,
    ),
    // Heel of the thumb.
    xf(ball(8, 6), -0.005, -0.025, 0.025, 0, 0, 0, 0.012, 0.022, 0.0145),
  ];
  // z across the palm, knuckle height, length, thickness, curl at the knuckle
  const fingers: [number, number, number, number, number][] = [
    [0.0262, -0.057, 0.059, 0.0093, 0.12],
    [0.0088, -0.06, 0.066, 0.0096, 0.17],
    [-0.0086, -0.0585, 0.061, 0.0091, 0.24],
    [-0.025, -0.054, 0.048, 0.0081, 0.32],
  ];
  for (const [z, y, len, r, curl] of fingers) {
    const pts: [number, number, number][] = [];
    let px = 0.001;
    let py = y + 0.006;
    const n = 4;
    for (let i = 0; i <= n; i++) {
      pts.push([px, py, z * (1 - 0.06 * (i / n))]);
      const a = curl + 0.95 * Math.pow(i / n, 1.2);
      px -= Math.sin(a) * (len / n);
      py -= Math.cos(a) * (len / n);
    }
    parts.push(tube(pts, (t) => r * (1 - 0.2 * t), 6, 1));
  }
  // Thumb: out of the side of the palm, forward and down.
  const thumb: [number, number, number][] = [
    [-0.004, -0.016, 0.027],
    [-0.005, -0.03, 0.04],
    [-0.008, -0.046, 0.0475],
    [-0.012, -0.06, 0.05],
  ];
  parts.push(tube(thumb, (t) => lerp(0.0118, 0.0088, t), 6, 1));
  return xf(fuse(parts), 0, 0, 0, 0, 0, 0, 1.08);
}

// ───────────────────────────── shoes ─────────────────────────────

/** Sole profile along the foot: z, half width, underside, top. The heel is a block; the arch lifts off the floor. */
type SoleRow = [number, number, number, number];
const SOLE: SoleRow[] = [
  [-0.072, 0.014, -0.08, -0.056],
  [-0.067, 0.033, -0.08, -0.056],
  [-0.04, 0.0415, -0.08, -0.056],
  [-0.014, 0.0415, -0.08, -0.057],
  [-0.006, 0.04, -0.069, -0.058],
  [0.026, 0.042, -0.072, -0.061],
  [0.05, 0.047, -0.08, -0.066],
  [0.09, 0.052, -0.08, -0.067],
  [0.13, 0.05, -0.08, -0.068],
  [0.158, 0.04, -0.079, -0.068],
  [0.172, 0.022, -0.077, -0.068],
  [0.177, 0.007, -0.075, -0.069],
];
/** A trainer's sole: thick and flat from heel to toe, turning up at the front. */
const SOLE_TRAINER: SoleRow[] = [
  [-0.076, 0.016, -0.077, -0.052],
  [-0.071, 0.035, -0.08, -0.051],
  [-0.04, 0.043, -0.08, -0.051],
  [0.0, 0.0435, -0.08, -0.053],
  [0.05, 0.048, -0.08, -0.055],
  [0.09, 0.052, -0.08, -0.056],
  [0.13, 0.051, -0.08, -0.057],
  [0.16, 0.042, -0.079, -0.057],
  [0.175, 0.025, -0.075, -0.057],
  [0.181, 0.009, -0.071, -0.058],
];

function soleTop(sole: SoleRow[], z: number): number {
  for (let i = 0; i < sole.length - 1; i++) {
    const a = sole[i]!;
    const b = sole[i + 1]!;
    if (z <= b[0]) return lerp(a[3], b[3], clamp01((z - a[0]) / (b[0] - a[0])));
  }
  return sole[sole.length - 1]![3];
}

/** The upper of a shoe, relative to the ankle joint, from cuts across it: [z, half width, top]. */
function buildUpper(cuts: [number, number, number][], sole: SoleRow[], round: number): THREE.BufferGeometry {
  const seg = 18;
  const rings = cuts.map(([z, w, top]) => {
    const base = soleTop(sole, z) - 0.003;
    const ring: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      const sn = Math.sin(a);
      ring.push(w * spow(Math.cos(a), 2.7), sn >= 0 ? base + (top - base) * spow(sn, round) : base + 0.004 * sn, z);
    }
    return ring;
  });
  return ringGeo(rings, true, true);
}

/** A leather shoe: a firm heel counter, a low vamp, a rounded toe with some height to it. */
const UPPER: [number, number, number][] = [
  [-0.068, 0.013, -0.03],
  [-0.064, 0.03, -0.01],
  [-0.047, 0.0385, -0.001],
  [-0.018, 0.041, 0.002],
  [0.012, 0.042, -0.006],
  [0.042, 0.045, -0.021],
  [0.078, 0.048, -0.031],
  [0.112, 0.047, -0.038],
  [0.14, 0.041, -0.043],
  [0.158, 0.03, -0.049],
  [0.169, 0.016, -0.056],
  [0.174, 0.005, -0.062],
];
/** A trainer: padded round the ankle, fuller over the toes. */
const UPPER_TRAINER: [number, number, number][] = [
  [-0.071, 0.016, -0.02],
  [-0.066, 0.033, -0.001],
  [-0.047, 0.041, 0.009],
  [-0.017, 0.043, 0.011],
  [0.013, 0.044, 0.003],
  [0.043, 0.047, -0.012],
  [0.079, 0.05, -0.023],
  [0.113, 0.049, -0.029],
  [0.142, 0.044, -0.034],
  [0.161, 0.034, -0.04],
  [0.173, 0.02, -0.047],
  [0.178, 0.007, -0.054],
];

/** Sole and heel, plus the sock that fills the ankle between shoe and trouser hem. */
function buildSole(sole: SoleRow[], welt: number): THREE.BufferGeometry {
  const seg = 16;
  const rings = sole.map(([z, w, lo, hi]) => {
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2;
    const ring: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      ring.push(w * welt * spow(Math.cos(a), 5), mid + half * spow(Math.sin(a), 5), z);
    }
    return ring;
  });
  return fuse([ringGeo(rings, true, true), xf(ball(12, 8), 0, 0.002, -0.006, 0, 0, 0, 0.041, 0.046, 0.046)]);
}

// ───────────────────────────── the whip ─────────────────────────────

/** A whip coiled for carrying: three loops of lash, the handle hanging through them. Lies in the YZ plane (against a hip). */
function buildCoil(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const t = new THREE.TorusGeometry(0.07 - i * 0.006, 0.0075 - i * 0.001, 6, 22);
    parts.push(xf(t, -i * 0.008, 0.005 * i, 0.004 * (i - 1), 0.12 * (i - 1), Math.PI / 2, 0));
  }
  parts.push(xf(new THREE.CylinderGeometry(0.0125, 0.0105, HANDLE_LEN, 8), -0.012, 0.015, 0.012, 0.35, 0, 0));
  parts.push(xf(ball(8, 6), -0.012, 0.015 + Math.cos(0.35) * HANDLE_LEN * 0.5, 0.012 + Math.sin(0.35) * HANDLE_LEN * 0.5, 0, 0, 0, 0.0155));
  return fuse(parts);
}

function buildSpark(): THREE.BufferGeometry {
  const o = () => new THREE.OctahedronGeometry(1, 0);
  return fuse([xf(o(), 0, 0, 0, 0, 0, 0, 1, 0.13, 0.13), xf(o(), 0, 0, 0, 0, 0, 0, 0.13, 1, 0.13), xf(o(), 0, 0, 0, 0, 0, 0.8, 0.7, 0.1, 0.1), xf(o(), 0, 0, 0, 0, 0, -0.8, 0.7, 0.1, 0.1)]);
}

// ───────────────────────────── all of it ─────────────────────────────

export type Outfit = 'polo' | 'tee' | 'shirt' | 'sweater' | 'suit';

export interface Body {
  /** Skin of the neck; with an open collar, also what shows of the chest. */
  neck: THREE.BufferGeometry;
  neckOpen: THREE.BufferGeometry;
  torsoTucked: THREE.BufferGeometry;
  torsoLoose: THREE.BufferGeometry;
  torsoJacket: THREE.BufferGeometry;
  pelvis: THREE.BufferGeometry;
  /** Leather and buckle, painted. */
  belt: THREE.BufferGeometry;
  /** What is sewn onto each garment in a second tone: collar, placket and buttons, neckband, ribbed hem. Painted. */
  trim: Record<Outfit, THREE.BufferGeometry>;
  suitLapels: THREE.BufferGeometry;
  suitButtons: THREE.BufferGeometry;
  sleeveButtons: THREE.BufferGeometry;
  tie: THREE.BufferGeometry;
  sleeveShort: THREE.BufferGeometry;
  /** Skinned limbs, left and right: bare arm, sleeved arm, trouser leg. */
  armL: THREE.BufferGeometry;
  armR: THREE.BufferGeometry;
  sleeveL: THREE.BufferGeometry;
  sleeveR: THREE.BufferGeometry;
  legL: THREE.BufferGeometry;
  legR: THREE.BufferGeometry;
  /** At the wrist: a shirt's cuff, and the ribbed cuff of a sweater. */
  cuff: THREE.BufferGeometry;
  cuffKnit: THREE.BufferGeometry;
  handL: THREE.BufferGeometry;
  handR: THREE.BufferGeometry;
  shoe: THREE.BufferGeometry;
  sole: THREE.BufferGeometry;
  trainer: THREE.BufferGeometry;
  trainerSole: THREE.BufferGeometry;
  badge: THREE.BufferGeometry;
  coil: THREE.BufferGeometry;
  spark: THREE.BufferGeometry;
}

/** Parts sewn on in a second tone, as one painted piece of cloth: whatever has not been given a colour stays the cloth's own. */
function white(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = fuse(parts);
  if (!g.getAttribute('color')) paint(g, 1, 1, 1);
  return clothUV(g);
}

let BODY: Body | null = null;

/** The gold pin sits on the left lapel; the name badge on the chest of anything else. */
export const PIN_Z = frontZ(TORSO_JACKET, 0.079, 0.412, 0.0125);
export const BADGE_Z = frontZ(TORSO_TUCKED, 0.088, 0.36, 0.004);

/** Built once, on first use, and shared by every character. */
/** How high a short sleeve's cap rises over the shoulder joint, as a part of its radius (see `sleeveShort`). */
const SLEEVE_CAP = 0.8;
/** The trouser leg's radius where it leaves the seat (`jointed(0.092, …)` below), and the cloth's room above it. */
const THIGH_TOP_R = 0.092;
const LAP_ROOM = 0.016;
/** Where the chair's seat is under someone sitting, from the hip centre (`SEAT_TOP` − `SIT_Y`), and the cloth's room above it. */
const SEAT_FLOOR = -0.05 + 0.012;

/**
 * A garment worn over the hips moves with the thighs: they come forward at the height of the hip joint, and a hem
 * that hangs over the hips standing is cut through by a thigh that rises (a stride, a run, sitting) — and seated, the
 * jacket's back by the seat. The two surfaces passing through each other shimmered at the seam as the figure breathed
 * (the owner: "clothes sometimes flicker from some angles", 2026-11-17). Three morph targets, in this order:
 *   0  the left half of the front lifted onto the left thigh (character's left, +x) — driven by that hip's bend,
 *   1  the right half onto the right thigh,
 *   2  the back onto the seat — driven by sitting.
 * In front of the hip joint, what is below the top of the thighs is lifted onto them, eased forward and outward, as
 * cloth lies over a lap; behind it, what is below the seat is lifted onto the seat. With both thighs up the two
 * halves make one lap. Everything sewn onto the same garment gets the same, so it stays on it.
 */
export function addSeatedMorph(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const left = new Float32Array(pos.count * 3);
  const right = new Float32Array(pos.count * 3);
  const back = new Float32Array(pos.count * 3);
  let moved = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Cloth bridges the gap between the thighs: as high as the top of a thigh across the middle, falling off outside.
    const dx = Math.max(0, Math.abs(x) - HIP_X);
    const top = Math.sqrt(Math.max(0, THIGH_TOP_R * THIGH_TOP_R - dx * dx)) + LAP_ROOM;
    // How much of this point is over the thighs rather than behind them: none at the back, all from the joint forward.
    const front = smooth(-0.03, 0.03, z);
    const lap = Math.max(0, top - y) * front;
    const seat = Math.max(0, SEAT_FLOOR - y) * (1 - front);
    if (lap <= 0 && seat <= 0) continue;
    // Lifted (the rows below the lap close up into the hem's edge), carried forward a little as cloth lies over a
    // lap, and eased outward so it stays clear of the seat of the trousers at the hips.
    if (lap > 0) {
      const l = smooth(-0.06, 0.06, x);
      const out = x * 0.1 * Math.min(1, lap / 0.03);
      for (const [d, k] of [[left, l], [right, 1 - l]] as const) {
        d[i * 3] = out * k;
        d[i * 3 + 1] = lap * k;
        d[i * 3 + 2] = lap * 0.35 * k;
      }
    }
    if (seat > 0) {
      back[i * 3] = x * 0.1 * Math.min(1, seat / 0.03);
      back[i * 3 + 1] = seat;
      back[i * 3 + 2] = -seat * 0.5;
    }
    moved++;
  }
  if (moved) {
    g.morphAttributes.position = [new THREE.BufferAttribute(left, 3), new THREE.BufferAttribute(right, 3), new THREE.BufferAttribute(back, 3)];
    g.morphTargetsRelative = true;
  }
  return g;
}

export function body(): Body {
  if (BODY) return BODY;
  const tucked = resample(TORSO_TUCKED, 3);
  const jacket = resample(TORSO_JACKET, 4);
  const collar = tieCollar(jacket);
  const knotZ = frontZ(jacket, 0, 0.506, 0.0105);
  const tieKnot = xf(ball(8, 6), 0, 0.506, knotZ, 0, 0, 0, 0.0155, 0.0145, 0.008);
  const lathe = (pts: [number, number][], seg = 14) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  const sleeveButtons: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) sleeveButtons.push(xf(ball(6, 4), 0, -0.168 - i * 0.014, -0.0405, 0, 0, 0, 0.0052, 0.0052, 0.003));
  const hand = buildHand();
  const bareArm = finish(jointed(0.046, 0.039, 0.0315, UPPER_ARM, 0.23, 0.03, { cap: 0.8, bulge: 0.0035 }));
  const sleeve = finish(clothUV(jointed(0.0555, 0.047, 0.039, UPPER_ARM, 0.214, 0.032, { flat: true, cap: 0.62 })));
  const trouser = finish(clothUV(jointed(0.092, 0.074, 0.068, THIGH, SHIN - 0.005, 0.045, { flat: true, seg: 18 })));
  // A darker tone for the buttons of a shirt, painted onto the trim.
  const dark = (g: THREE.BufferGeometry) => paint(g, 0.42, 0.42, 0.45);
  const placket = (y0: number, y1: number, buttons: number[]) => [frontPatch(tucked, y0, y1, () => 0.0115, 0.0026, 12, 2), ...buttons.map((y) => dark(button(tucked, y, 0.0048, 0.0036)))];
  BODY = {
    neck: loft(NECK, 2, 16, false, true),
    neckOpen: fuse([loft(NECK, 2, 16, false, true), openNeck(tucked, 0.462, 0.034)]),
    torsoTucked: clothUV(loft(TORSO_TUCKED, 3, 32)),
    torsoLoose: clothUV(loft(TORSO_LOOSE, 3, 32)),
    torsoJacket: clothUV(buildJacket()),
    pelvis: clothUV(striped(loft(PELVIS, 3, 32))),
    belt: fuse([
      paint(loft([[0.043, 0.172, 0.1045, 0, 2.5], [0.076, 0.169, 0.1035, 0, 2.5]], 1, 32), 0.023, 0.019, 0.016),
      paint(xf(new RoundedBoxGeometry(0.034, 0.027, 0.008, 1, 0.003), 0, 0.0595, 0.1065), 0.6, 0.55, 0.42),
      paint(xf(new THREE.BoxGeometry(0.022, 0.016, 0.009), 0, 0.0595, 0.107), 0.023, 0.019, 0.016),
    ]),
    trim: {
      // A polo: soft collar, a short placket with two buttons.
      polo: white([foldCollar(tucked, { back: 0.552, front: 0.526, stand: 0.03, gap: 0.2, spread: 0.46, edge: 0.515, tip: 0.472, roll: 0.003 }), ...placket(0.395, 0.474, [0.418, 0.452])]),
      // A shirt: a taller, crisper collar, buttons down the front.
      shirt: white(
        [
          foldCollar(tucked, { back: 0.558, front: 0.53, stand: 0.034, gap: 0.14, spread: 0.36, edge: 0.518, tip: 0.466, roll: 0.001 }),
          ...placket(0.06, 0.478, [0.11, 0.19, 0.27, 0.35, 0.43]),
        ],
      ),
      // A T-shirt: a ribbed band at the neck.
      tee: white([band([[0.512, 0.083, 0.072, -0.006, 2], [0.53, 0.076, 0.068, -0.006, 2], [0.541, 0.063, 0.058, -0.006, 2], [0.534, 0.054, 0.051, -0.006, 2]], 24)]),
      // A sweater: a thick rolled neck, and a ribbed band gathering the hem.
      sweater: white(
        [
          band([[0.506, 0.09, 0.078, -0.006, 2], [0.528, 0.083, 0.074, -0.006, 2], [0.549, 0.068, 0.062, -0.006, 2], [0.543, 0.055, 0.052, -0.006, 2]], 24),
          band([[-0.062, 0.168, 0.11, -0.002, 2.5], [-0.052, 0.1795, 0.119, -0.002, 2.5], [-0.03, 0.1795, 0.119, -0.001, 2.5], [-0.014, 0.17, 0.11, 0, 2.5]]),
        ],
      ),
      // Under a jacket: shirt collar, the shirt front between the lapels, and the shirt at the waist behind the jacket's cut-away fronts.
      suit: white([
        collar,
        // The shirt round the base of the neck, between its collar and the lapels.
        frontPatch(jacket, 0.488, 0.5345, (t) => 0.066 - 0.016 * t * t, 0.003, 8, 4),
        frontPatch(jacket, 0.2, 0.532, (t) => Math.min(vEdge(lerp(0.2, 0.532, t)) + 0.004, secAt(jacket, lerp(0.2, 0.532, t))[1] * 0.9), 0.004, 14),
        frontPatch(jacket, 0.06, 0.2, () => 0.09, -0.012),
      ]),
    },
    suitLapels: fuse([
      buildLapel(jacket, 1),
      buildLapel(jacket, -1),
      buildJacketCollar(),
      wrapPatch(jacket, Math.PI / 2 - 1.22, Math.PI / 2 - 0.5, 0.002, 0.034, 0.0035),
      wrapPatch(jacket, Math.PI / 2 + 0.5, Math.PI / 2 + 1.22, 0.002, 0.034, 0.0035),
    ]),
    // The front button, and the shadow inside the back vent.
    suitButtons: fuse([
      xf(ball(10, 6), 0, BUTTON_Y + 0.006, frontZ(jacket, 0, BUTTON_Y + 0.006, 0.003), 0, 0, 0, 0.009, 0.009, 0.0045),
      wrapPatch(jacket, Math.PI * 1.5 - 0.0045, Math.PI * 1.5 + 0.0005, JACKET_HEM + 0.03, 0.07, -0.002),
    ]),
    sleeveButtons: fuse(sleeveButtons),
    tie: fuse([frontPatch(jacket, 0.2, 0.505, (t) => lerp(0.021, 0.0115, t), 0.0075, 12, 2), tieKnot]),
    // A short sleeve: to the middle of the upper arm, ending in a turned hem that stands off the arm.
    sleeveShort: clothUV(
      lathe([
        [0.0001, -0.134],
        [0.05, -0.134],
        [0.0572, -0.131],
        [0.0578, -0.116],
        [0.0556, -0.113],
        [0.0556, -0.06],
        [0.0556, 0],
        // The cap stands clear of the arm's own rounded top (0.046 × 0.8 = 3.7 cm, `bareArm`): at 0.62 (3.45 cm) the
        // skin of the shoulder showed through the top of a short sleeve, as a fleck that came and went with the light.
        [0.0556 * Math.cos(0.4), 0.0556 * Math.sin(0.4) * SLEEVE_CAP],
        [0.0556 * Math.cos(0.8), 0.0556 * Math.sin(0.8) * SLEEVE_CAP],
        [0.0556 * Math.cos(1.2), 0.0556 * Math.sin(1.2) * SLEEVE_CAP],
        [0.0001, 0.0556 * SLEEVE_CAP],
      ]),
    ),
    armL: onBones(bareArm, 4, 5),
    armR: onBones(bareArm, 6, 7),
    sleeveL: onBones(sleeve, 4, 5),
    sleeveR: onBones(sleeve, 6, 7),
    legL: onBones(trouser, 0, 1),
    legR: onBones(trouser, 2, 3),
    // A shirt cuff: a band below the end of the sleeve, a little wider than the wrist.
    cuff: white([lathe([
      [0.0001, -0.237],
      [0.031, -0.237],
      [0.0345, -0.232],
      [0.0352, -0.2],
    ])]),
    // A sweater's cuff: a thick ribbed band over the end of the sleeve.
    cuffKnit: white([
      lathe([
        [0.0001, -0.222],
        [0.034, -0.222],
        [0.0415, -0.216],
        [0.0425, -0.196],
        [0.0405, -0.186],
        [0.037, -0.183],
      ]),
    ]),
    handL: hand,
    handR: mirrorX(hand),
    shoe: buildUpper(UPPER, SOLE, 2.2),
    sole: buildSole(SOLE, 1.06),
    trainer: buildUpper(UPPER_TRAINER, SOLE_TRAINER, 2.4),
    trainerSole: buildSole(SOLE_TRAINER, 1.04),
    badge: new RoundedBoxGeometry(0.044, 0.028, 0.012, 2, 0.005),
    coil: buildCoil(),
    spark: buildSpark(),
  };
  // (Limbs were finished before they were bound to their bones.)
  const all = BODY as unknown as Record<string, THREE.BufferGeometry | Record<string, THREE.BufferGeometry>>;
  for (const [name, g] of Object.entries(all)) {
    if (!(g instanceof THREE.BufferGeometry)) for (const [o, t] of Object.entries(g)) g[o] = finish(t);
    else if (!g.getAttribute('skinIndex')) all[name] = finish(g);
  }
  // What is worn on the trunk over the hips follows them when sitting (after `finish`, which would drop it).
  for (const g of [BODY.torsoLoose, BODY.torsoJacket, BODY.suitLapels, BODY.suitButtons, ...Object.values(BODY.trim)]) addSeatedMorph(g);
  return BODY;
}
