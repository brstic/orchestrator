/**
 * The shapes of what drives in the Skyline's city: a saloon, an SUV, a taxi and a bus.
 *
 * A body is its side outline (rounded with curves) pushed out to its width with bevelled edges; glass sits a few
 * centimetres proud of it; then bumpers, a grille, mirrors, lamps, tyres and wheel rims. Every vertex says which part it
 * belongs to (`aPart`, a `PART`), and the geometry has one group per part, in that order — so the traffic draws all of a
 * kind with one material that colours by part (`skyline.ts`), and the owner's own car uses one material per part
 * (`gear.tsx`). Each faces +z, its middle at the origin, standing on y = 0.
 */
import * as THREE from 'three';

export const PART = { paint: 0, glass: 1, tyre: 2, rim: 3, headlamp: 4, taillamp: 5, trim: 6, sign: 7, cabin: 8 } as const;
export const PARTS = 9;

export type Body = 'sedan' | 'suv' | 'taxi' | 'bus';

type Pt = [number, number];

/** A side outline (z forward, y up) as a shape, with the wheel arches cut out of its foot. */
function outline(points: Array<Pt | { q: Pt; to: Pt }>, wheels: number[], wheelR: number, foot: number): THREE.Shape {
  const shape = new THREE.Shape();
  const [first, ...rest] = points;
  shape.moveTo(...(first as Pt));
  for (const p of rest) {
    if (Array.isArray(p)) shape.lineTo(...p);
    else shape.quadraticCurveTo(p.q[0], p.q[1], p.to[0], p.to[1]);
  }
  // Along the foot from the front back, round the arches.
  const arch = wheelR + 0.06;
  for (const wz of [...wheels].sort((a, b) => b - a)) {
    shape.lineTo(wz + arch, foot);
    const steps = lowDetail ? 2 : 6;
    for (let k = 0; k <= steps; k++) {
      const a = 0.25 + ((Math.PI - 0.5) * k) / steps;
      shape.lineTo(wz + Math.cos(a) * arch, wheelR + Math.sin(a) * arch);
    }
    shape.lineTo(wz - arch, foot);
  }
  shape.closePath();
  return shape;
}

/** While a far shape is made: fewer points everywhere. */
let lowDetail = false;

/** A shape pushed out to `width` across x, centred. */
function pushed(shape: THREE.Shape, width: number, bevel: number): THREE.BufferGeometry {
  if (lowDetail) bevel = 0;
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: lowDetail ? 1 : 4 });
  // The shape's x is the car's z; its depth becomes the car's x.
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2 - bevel, 0, 0);
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** All parts into one geometry: grouped by part, each vertex tagged. */
function assemble(parts: Array<{ g: THREE.BufferGeometry; part: number }>): THREE.BufferGeometry {
  const byPart = new Map<number, THREE.BufferGeometry[]>();
  for (const { g, part } of parts) {
    const flat = g.index ? g.toNonIndexed() : g;
    if (!flat.getAttribute('normal')) flat.computeVertexNormals();
    byPart.set(part, [...(byPart.get(part) ?? []), flat]);
    if (flat !== g) g.dispose();
  }
  let count = 0;
  for (const list of byPart.values()) for (const g of list) count += g.getAttribute('position').count;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const tag = new Float32Array(count);
  const out = new THREE.BufferGeometry();
  let o = 0;
  for (let part = 0; part < PARTS; part++) {
    const list = byPart.get(part);
    if (!list) continue;
    const start = o;
    for (const g of list) {
      const p = g.getAttribute('position');
      position.set(p.array as Float32Array, o * 3);
      normal.set(g.getAttribute('normal').array as Float32Array, o * 3);
      tag.fill(part, o, o + p.count);
      o += p.count;
      g.dispose();
    }
    out.addGroup(start, o - start, part);
  }
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('aPart', new THREE.BufferAttribute(tag, 1));
  out.computeBoundingSphere();
  return out;
}

/** Tyres with their rims, at (x, z) on each side. */
function wheels(at: Array<[number, number]>, r: number, width: number): Array<{ g: THREE.BufferGeometry; part: number }> {
  const out: Array<{ g: THREE.BufferGeometry; part: number }> = [];
  for (const [x, z] of at) {
    out.push({ g: new THREE.CylinderGeometry(r, r, width, lowDetail ? 6 : 10, 1, lowDetail).rotateZ(Math.PI / 2).translate(x, r, z), part: PART.tyre });
    if (lowDetail) continue;
    const side = Math.sign(x);
    out.push({ g: new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.03, 8).rotateZ(Math.PI / 2).translate(x + side * (width / 2 + 0.005), r, z), part: PART.rim });
  }
  return out;
}

/** Where a body's wheels are, and how big: used by `gear.tsx` to turn them. */
export const WHEELS: Record<Exclude<Body, 'bus'>, { at: Array<[number, number]>; r: number; width: number }> = {
  sedan: { at: [[-0.84, 1.42], [0.84, 1.42], [-0.84, -1.4], [0.84, -1.4]], r: 0.34, width: 0.24 },
  taxi: { at: [[-0.84, 1.42], [0.84, 1.42], [-0.84, -1.4], [0.84, -1.4]], r: 0.34, width: 0.24 },
  suv: { at: [[-0.88, 1.5], [0.88, 1.5], [-0.88, -1.48], [0.88, -1.48]], r: 0.38, width: 0.27 },
};

/**
 * The shape of one kind of vehicle. `withWheels: false` leaves the wheels out (the owner's car turns its own).
 * `far`: the same vehicle in a few hundred points — no rounded edges, no mirrors or sills — for the traffic seen from
 * further than a street away (`skyline.ts` draws the near ones with the full shape).
 */
export function vehicleShape(kind: Body, withWheels = true, far = false): THREE.BufferGeometry {
  lowDetail = far;
  const parts: Array<{ g: THREE.BufferGeometry; part: number }> = [];
  const add = (g: THREE.BufferGeometry, part: number) => parts.push({ g, part });
  if (kind === 'bus') {
    // A city bus: a long box with a rounded roof edge, a band of lit windows, a big windscreen, doors.
    const side = outline([[-6, 0.38], [-6.02, 2.9], { q: [-6, 3.12], to: [-5.75, 3.12] }, [5.7, 3.12], { q: [6.02, 3.1], to: [6.02, 2.7] }, [6.04, 0.38]], [3.9, -3.7], 0.5, 0.38);
    add(pushed(side, 2.55, 0.06), PART.paint);
    add(pushed(outline([[-5.6, 1.55], [-5.6, 2.65], [5.2, 2.65], [5.2, 1.55]], [], 0, 1.55), 2.62, 0), PART.cabin);
    add(box(2.3, 1.55, 0.06, 0, 2.0, 6.05), PART.glass);
    add(box(2.3, 0.4, 0.06, 0, 3.0, 6.04), PART.sign);
    add(box(2.5, 0.3, 0.14, 0, 0.5, 6.08), PART.trim);
    add(box(2.5, 0.3, 0.14, 0, 0.5, -6.06), PART.trim);
    for (const x of [-0.75, 0.75]) {
      add(box(0.36, 0.16, 0.05, x, 0.82, 6.07), PART.headlamp);
      add(box(0.24, 0.42, 0.05, x * 1.45, 1.0, -6.05), PART.taillamp);
    }
    if (withWheels) parts.push(...wheels([[-1.1, 3.9], [1.1, 3.9], [-1.1, -3.7], [1.1, -3.7]], 0.5, 0.3));
    return assemble(parts);
  }
  const suv = kind === 'suv';
  const w = WHEELS[kind];
  const width = suv ? 1.92 : 1.82;
  const half = width / 2;
  const front = suv ? 2.45 : 2.3;
  const back = suv ? -2.45 : -2.3;
  const foot = 0.3;
  // The side outline: bumper, bonnet, windscreen, roof, rear screen, boot.
  const body = suv
    ? outline([[back, foot], [back - 0.02, 0.98], { q: [back, 1.62], to: [back + 0.25, 1.68] }, [-0.2, 1.74], { q: [0.55, 1.74], to: [0.95, 1.2] }, { q: [1.25, 1.06], to: [2.1, 1.0] }, { q: [front + 0.02, 0.95], to: [front, 0.6] }, [front - 0.02, foot]], w.at.map((a) => a[1]).filter((_, i) => i % 2 === 0), w.r, foot)
    : outline([[back, foot], [back - 0.03, 0.66], { q: [back, 0.88], to: [-1.95, 0.9] }, [-1.55, 0.93], { q: [-1.05, 1.36], to: [-0.6, 1.42] }, [0.15, 1.43], { q: [0.55, 1.4], to: [1.05, 0.98] }, { q: [1.5, 0.86], to: [2.05, 0.82] }, { q: [front + 0.02, 0.78], to: [front, 0.56] }, [front - 0.02, foot]], w.at.map((a) => a[1]).filter((_, i) => i % 2 === 0), w.r, foot);
  add(pushed(body, width, 0.07), PART.paint);
  // Side windows, a little proud of the body, with a pillar between.
  const sideGlass = suv
    ? [
        [[0.86, 1.2], [0.5, 1.66], [-0.1, 1.67], [-0.1, 1.2]],
        [[-0.22, 1.2], [-0.22, 1.67], [-1.25, 1.67], [-1.25, 1.2]],
        [[-1.37, 1.2], [-1.37, 1.66], [-2.2, 1.62], [-2.3, 1.2]],
      ]
    : [
        [[0.95, 1.0], [0.38, 1.36], [-0.05, 1.37], [-0.05, 1.0]],
        [[-0.17, 1.0], [-0.17, 1.37], [-0.7, 1.36], [-1.32, 1.0]],
      ];
  for (const poly of sideGlass) {
    const s = new THREE.Shape(poly.map(([z, y]) => new THREE.Vector2(z, y)));
    add(pushed(s, width + 0.03, 0), PART.glass);
  }
  // Windscreen and rear screen: thin panes laid on the slopes.
  const pane = (z1: number, y1: number, z2: number, y2: number, across: number) => {
    const len = Math.hypot(z2 - z1, y2 - y1);
    const g = new THREE.BoxGeometry(across, 0.03, len);
    g.rotateX(-Math.atan2(y2 - y1, z2 - z1));
    g.translate(0, (y1 + y2) / 2 + 0.03, (z1 + z2) / 2);
    return g;
  };
  if (suv) {
    add(pane(0.92, 1.22, 0.5, 1.7, width - 0.28), PART.glass);
    add(box(width - 0.3, 0.42, 0.04, 0, 1.38, back - 0.01), PART.glass);
  } else {
    add(pane(1.0, 1.0, 0.2, 1.42, width - 0.26), PART.glass);
    add(pane(-1.5, 0.95, -0.75, 1.39, width - 0.3), PART.glass);
  }
  // Bumpers, grille, sills, mirrors.
  add(box(width + 0.02, 0.22, 0.16, 0, 0.42, front - 0.02), PART.trim);
  add(box(width + 0.02, 0.22, 0.16, 0, 0.42, back + 0.02), PART.trim);
  add(box(width * 0.42, 0.16, 0.05, 0, suv ? 0.78 : 0.64, front + 0.01), PART.trim);
  for (const s of [-1, 1]) {
    if (!lowDetail) {
      add(box(0.06, 0.12, 2.0, s * (half + 0.01), 0.36, 0), PART.trim);
      add(box(0.16, 0.1, 0.12, s * (half + 0.08), suv ? 1.22 : 1.02, suv ? 0.82 : 0.9), PART.paint);
    }
    add(box(0.36, 0.11, 0.06, s * (half - 0.3), suv ? 0.86 : 0.72, front + 0.0), PART.headlamp);
    add(box(0.32, 0.12, 0.05, s * (half - 0.26), suv ? 0.95 : 0.76, back - 0.01), PART.taillamp);
  }
  if (kind === 'taxi') add(box(0.62, 0.17, 0.26, 0, 1.52, -0.15), PART.sign);
  if (withWheels) parts.push(...wheels(w.at, w.r, w.width));
  return assemble(parts);
}
