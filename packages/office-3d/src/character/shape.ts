import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU, lerp, smooth } from './motion.ts';

/**
 * The tools a character is sculpted with: surfaces stitched from rings and rows of points, lofts through
 * cross-sections, limbs that bend on two bones, and what paints and textures them. No body part is defined here.
 */
export const spow = (v: number, n: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);

/** Make triangles face away from the mesh centre, then compute smooth normals. */
export function orient(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const ix = g.index!;
  const a = ix.array as Uint16Array | Uint32Array;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < p.count; i++) {
    cx += p.getX(i);
    cy += p.getY(i);
    cz += p.getZ(i);
  }
  cx /= p.count;
  cy /= p.count;
  cz /= p.count;
  let sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const i0 = a[i]!;
    const i1 = a[i + 1]!;
    const i2 = a[i + 2]!;
    const ax = p.getX(i0);
    const ay = p.getY(i0);
    const az = p.getZ(i0);
    const e1x = p.getX(i1) - ax;
    const e1y = p.getY(i1) - ay;
    const e1z = p.getZ(i1) - az;
    const e2x = p.getX(i2) - ax;
    const e2y = p.getY(i2) - ay;
    const e2z = p.getZ(i2) - az;
    sum += (e1y * e2z - e1z * e2y) * (ax - cx) + (e1z * e2x - e1x * e2z) * (ay - cy) + (e1x * e2y - e1y * e2x) * (az - cz);
  }
  if (sum < 0) {
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Stitch a stack of closed rings (flat xyz arrays of equal length) into a smooth surface. */
export function ringGeo(rings: number[][], capStart: boolean, capEnd: boolean, poleStart = false, poleEnd = false): THREE.BufferGeometry {
  const n = rings[0]!.length / 3;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of rings) for (const v of r) pos.push(v);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      idx.push(a, a + n, b, b, a + n, b + n);
    }
  }
  const cap = (ring: number[], reverse: boolean) => {
    const base = pos.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < n; j++) {
      pos.push(ring[j * 3]!, ring[j * 3 + 1]!, ring[j * 3 + 2]!);
      cx += ring[j * 3]!;
      cy += ring[j * 3 + 1]!;
      cz += ring[j * 3 + 2]!;
    }
    pos.push(cx / n, cy / n, cz / n);
    for (let j = 0; j < n; j++) {
      const a = base + j;
      const b = base + ((j + 1) % n);
      if (reverse) idx.push(base + n, b, a);
      else idx.push(base + n, a, b);
    }
  };
  if (capStart) cap(rings[0]!, false);
  if (capEnd) cap(rings[rings.length - 1]!, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  orient(g);
  // A ring collapsed to a point gets one shared normal, so the pole does not pinch.
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const fixPole = (row: number) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let j = 0; j < n; j++) {
      x += nor.getX(row * n + j);
      y += nor.getY(row * n + j);
      z += nor.getZ(row * n + j);
    }
    const l = Math.hypot(x, y, z) || 1;
    for (let j = 0; j < n; j++) nor.setXYZ(row * n + j, x / l, y / l, z / l);
  };
  if (poleStart) fixPole(0);
  if (poleEnd) fixPole(rings.length - 1);
  return g;
}

/** One cross-section of a loft: height, half width, half depth, z centre, superellipse exponent. */
export type Sec = [y: number, hw: number, hd: number, zc: number, n: number];

export function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function resample(secs: Sec[], sub: number): Sec[] {
  const out: Sec[] = [];
  const at = (i: number) => secs[Math.max(0, Math.min(secs.length - 1, i))]!;
  for (let i = 0; i < secs.length - 1; i++) {
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      const r = [0, 0, 0, 0, 0] as Sec;
      for (let c = 0; c < 5; c++) r[c] = catmull(at(i - 1)[c]!, at(i)[c]!, at(i + 1)[c]!, at(i + 2)[c]!, t);
      out.push(r);
    }
  }
  out.push(secs[secs.length - 1]!);
  return out;
}

export function ellipseRing(sec: Sec, seg: number): number[] {
  const ring: number[] = [];
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * TAU;
    ring.push(sec[1] * spow(Math.cos(a), sec[4]), sec[0], sec[3] + sec[2] * spow(Math.sin(a), sec[4]));
  }
  return ring;
}

/** A smooth body part swept through elliptical cross-sections along Y. */
export function loft(secs: Sec[], sub = 3, seg = 28, capStart = true, capEnd = true): THREE.BufferGeometry {
  return ringGeo(
    resample(secs, sub).map((r) => ellipseRing(r, seg)),
    capStart,
    capEnd,
  );
}

export function secAt(rows: Sec[], y: number): Sec {
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]!;
    const b = rows[i + 1]!;
    if ((y >= a[0] && y <= b[0]) || (y <= a[0] && y >= b[0])) {
      const t = (y - a[0]) / (b[0] - a[0] || 1);
      return [y, lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t), lerp(a[4], b[4], t)];
    }
  }
  return rows[rows.length - 1]!;
}

/** A strip lying on the front of a lofted body (shirt front, tie, placket). */
export function frontPatch(rows: Sec[], y0: number, y1: number, halfW: (t: number) => number, off: number, ny = 10, nx = 4): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= ny; i++) {
    const t = i / ny;
    const y = lerp(y0, y1, t);
    const sec = secAt(rows, y);
    const w = halfW(t);
    for (let j = 0; j <= nx; j++) {
      const x = lerp(-w, w, j / nx);
      const u = Math.min(0.999, Math.abs(x / sec[1]));
      pos.push(x, y, sec[3] + sec[2] * Math.pow(1 - Math.pow(u, sec[4]), 1 / sec[4]) + off);
    }
  }
  const up = y1 > y0;
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const a = i * (nx + 1) + j;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      if (up) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Distance between the pinstripes of a suit. */
export const STRIPE = 0.021;

/**
 * A whole limb as one surface: two segments hanging from the origin down −Y, skinned to two bones so that it bends
 * at the joint without a seam. `r0` → `rj` → `r1` are the radii at the top, the joint and the far end.
 */
export function jointed(r0: number, rj: number, r1: number, len0: number, len1: number, zone: number, o: { flat?: boolean; cap?: number; seg?: number; bulge?: number } = {}): THREE.BufferGeometry {
  const total = len0 + len1;
  const radius = (y: number) => {
    const d = -y;
    if (d <= len0) {
      const t = d / len0;
      return lerp(r0, rj, t * t * (3 - 2 * t));
    }
    const t = (d - len0) / len1;
    return lerp(rj, r1, t * t * (3 - 2 * t)) + (o.bulge ?? 0) * Math.sin(Math.PI * t);
  };
  // Rows every few centimetres, closer together where the limb bends.
  const ys: number[] = [];
  let y = -total + (o.flat ? r1 * 0.08 : 0);
  while (y < -0.004) {
    ys.push(y);
    y += Math.abs(y + len0) < zone * 1.6 ? zone / 4 : 0.045;
  }
  const pts: THREE.Vector2[] = [];
  if (o.flat) {
    pts.push(new THREE.Vector2(0.0001, -total), new THREE.Vector2(r1 * 0.94, -total));
  } else {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, r1 * Math.sin(a)), -total - r1 * Math.cos(a)));
    }
  }
  for (const yy of ys) pts.push(new THREE.Vector2(radius(yy), yy));
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0.0001, r0 * Math.cos(a)), r0 * Math.sin(a) * (o.cap ?? 1)));
  }
  const g = new THREE.LatheGeometry(pts, o.seg ?? 14);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const w: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const lower = smooth(-len0 + zone, -len0 - zone, pos.getY(i));
    w.push(1 - lower, lower, 0, 0);
  }
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  // Cloth texture runs down the limb: a whole number of stripes round it, so the seam does not show.
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const stripes = Math.round((TAU * r0) / STRIPE);
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * stripes);
  return g;
}

/** The same limb bound to a particular pair of bones of the character's skeleton. */
export function onBones(src: THREE.BufferGeometry, upper: number, lower: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'uv1', 'color', 'skinWeight']) if (src.getAttribute(name)) g.setAttribute(name, src.getAttribute(name));
  g.setIndex(src.index);
  const n = src.getAttribute('position').count;
  const idx = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    idx[i * 4] = upper;
    idx[i * 4 + 1] = lower;
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  return g;
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const S = new THREE.Vector3();

/** Bake a transform (scale, then rotate, then translate) into a geometry. */
export function xf(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.BufferGeometry {
  g.applyMatrix4(M.compose(P.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz)));
  return g;
}

/** Merge parts that share one material into a single draw call. */
export function fuse(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  // Texture coordinates survive only if every part has them; paint, if any part has it (the rest is left unpainted: white).
  const textured = flat.every((g) => g.getAttribute('uv'));
  const painted = flat.some((g) => g.getAttribute('color'));
  for (const g of flat) {
    if (!textured) g.deleteAttribute('uv');
    if (painted && !g.getAttribute('color')) paint(g, 1, 1, 1);
    g.deleteAttribute('uv1');
  }
  return mergeGeometries(flat, false)!;
}

/**
 * The last step for every part: corners that several triangles share become one vertex again (fusing, painting and
 * laying cloth coordinates give each triangle its own), so the graphics card works each of them out once.
 */
export function finish(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = mergeVertices(g, 1e-5);
  out.computeBoundingSphere();
  return out;
}

/** One colour for every vertex of a part. The material multiplies it with its own colour, so white leaves that as it is. */
export function paint(g: THREE.BufferGeometry, r: number, gr: number, b: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = r;
    a[i * 3 + 1] = gr;
    a[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/**
 * Cloth coordinates, in metres, laid on from whichever of the three sides a triangle faces most (so a weave is the
 * same size everywhere and never stretched). They go in the second set (`uv1`): the first belongs to a suit's stripes.
 * The result has its own vertices for every triangle.
 */
export function clothUV(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let t = 0; t < pos.count; t += 3) {
    const ax = pos.getX(t);
    const ay = pos.getY(t);
    const az = pos.getZ(t);
    const e1x = pos.getX(t + 1) - ax;
    const e1y = pos.getY(t + 1) - ay;
    const e1z = pos.getZ(t + 1) - az;
    const e2x = pos.getX(t + 2) - ax;
    const e2y = pos.getY(t + 2) - ay;
    const e2z = pos.getZ(t + 2) - az;
    const nx = Math.abs(e1y * e2z - e1z * e2y);
    const ny = Math.abs(e1z * e2x - e1x * e2z);
    const nz = Math.abs(e1x * e2y - e1y * e2x);
    const axis = ny >= nx && ny >= nz ? 1 : nx >= nz ? 0 : 2;
    for (let i = t; i < t + 3; i++) {
      uv[i * 2] = axis === 0 ? pos.getZ(i) : pos.getX(i);
      uv[i * 2 + 1] = axis === 1 ? pos.getZ(i) : pos.getY(i);
    }
  }
  g.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** A surface through rows of points (flat xyz arrays of equal length), each row an open line. `flip` turns it to face the other way. */
export function sheet(rows: number[][], flip = false): THREE.BufferGeometry {
  const n = rows[0]!.length / 3;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of rows) for (const v of r) pos.push(v);
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      if (flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A round, tapering tube along a line of points (a finger, a strap), closed with a rounded tip at each end.
 * `radius(t)` is its thickness along the way (t from 0 to 1).
 */
export function tube(points: [number, number, number][], radius: (t: number) => number, seg = 8, tip = 2): THREE.BufferGeometry {
  const n = points.length;
  const rings: number[][] = [];
  const tan = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();
  const ring = (cx: number, cy: number, cz: number, r: number) => {
    const out: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      out.push(cx + u.x * c + v.x * s, cy + u.y * c + v.y * s, cz + u.z * c + v.z * s);
    }
    rings.push(out);
  };
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(n - 1, i + 1)]!;
    tan.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    // The same side of every ring faces the same way, so the tube does not twist.
    if (i === 0) u.crossVectors(tan, w.set(0.31, 0.83, 0.46).normalize()).normalize();
    else u.sub(w.copy(tan).multiplyScalar(u.dot(tan))).normalize();
    v.crossVectors(tan, u);
    const p = points[i]!;
    const r = radius(i / (n - 1));
    if (i === 0) {
      for (let k = 0; k <= tip; k++) {
        const q = (k / (tip + 1)) * (Math.PI / 2);
        ring(p[0] - tan.x * r * Math.cos(q), p[1] - tan.y * r * Math.cos(q), p[2] - tan.z * r * Math.cos(q), Math.max(1e-5, r * Math.sin(q)));
      }
    }
    ring(p[0], p[1], p[2], r);
    if (i === n - 1) {
      for (let k = tip; k >= 0; k--) {
        const q = (k / (tip + 1)) * (Math.PI / 2);
        ring(p[0] + tan.x * r * Math.cos(q), p[1] + tan.y * r * Math.cos(q), p[2] + tan.z * r * Math.cos(q), Math.max(1e-5, r * Math.sin(q)));
      }
    }
  }
  return ringGeo(rings, false, false, true, true);
}

/** Mirror a geometry left to right, keeping its faces outward. The result has its own vertices for every triangle. */
export function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  for (const name of Object.keys(g.attributes)) {
    const at = g.getAttribute(name) as THREE.BufferAttribute;
    const a = at.array as Float32Array;
    const n = at.itemSize;
    for (let i = 0; i < a.length; i += 3 * n) {
      if (name === 'position' || name === 'normal') for (let k = 0; k < 3; k++) a[i + k * n] = -a[i + k * n]!;
      for (let k = 0; k < n; k++) {
        const t = a[i + n + k]!;
        a[i + n + k] = a[i + 2 * n + k]!;
        a[i + 2 * n + k] = t;
      }
    }
  }
  return g;
}

/** A value that follows a list of [where, value] keys (ascending), easing from each to the next. */
export function curve(keys: [number, number][], at: number): number {
  if (at <= keys[0]![0]) return keys[0]![1];
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i]!;
    const k1 = keys[i + 1]!;
    if (at <= k1[0]) return lerp(k0[1], k1[1], smooth(k0[0], k1[0], at));
  }
  return keys[keys.length - 1]![1];
}

export const ball = (seg = 14, rows = 10) => new THREE.SphereGeometry(1, seg, rows);
