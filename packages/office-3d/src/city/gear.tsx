import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { PART, PARTS, WHEELS, vehicleShape, type Body } from './vehicles.ts';

/** What the owner has with them out in the city, where it is this frame (written by `Rig.tsx`, read here). */
export interface Gear {
  chute: { x: number; y: number; z: number; rot: number; open: number; bank: number } | null;
  car: CarAt | null;
  parked: CarAt | null;
}
export interface CarAt {
  x: number;
  y: number;
  z: number;
  rot: number;
  paint: [number, number, number];
  speed: number;
  /** Steering: -1 left … 1 right. */
  steer: number;
  kind: Exclude<Body, 'bus'>;
}

/** The canopy's size: across (span), front to back (chord), how high over the shoulders, how many cells. */
const SPAN = 7.6;
const CHORD = 2.7;
const HIGH = 5.4;
const CELLS = 9;
/** The arc the span is bent round (radius, m): a ram-air canopy hangs as a shallow arch. */
const ARC = 6.2;

/**
 * A ram-air parachute — a wing: nine cells side by side, bent into an arch over the shoulders, each with an aerofoil's
 * section (round at the front, where its mouth is open, thin at the back) and puffed out between the ribs; lines from
 * its underside in four rows down to two risers at the shoulders. Its origin is the shoulders; it faces +z.
 */
function makeChute(): { group: THREE.Group; canopy: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  const canopy = new THREE.Group();
  group.add(canopy);
  const along = CELLS * 6; // segments across the span
  const round = 16; // segments round the section
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const colours = ['#e8452c', '#f4f1ea', '#1f3a68', '#f4f1ea', '#e8452c', '#f2b134', '#e8452c', '#f4f1ea', '#1f3a68'].map((c) => new THREE.Color(c));
  const theta = SPAN / ARC; // the arc's angle
  /** A point of the canopy: `u` across (0…1), `v` round the section (0…1: from the trailing edge over the top to the nose and back along the bottom). */
  const point = (u: number, v: number): [number, number, number] => {
    const a = (u - 0.5) * theta;
    // The section: an aerofoil, thickest near the front.
    const c = v < 0.5 ? 1 - v * 2 : (v - 0.5) * 2; // 1 at the trailing edge, 0 at the nose
    const t = 0.36 * (1.4 * Math.sqrt(Math.max(c, 0)) - 1.2 * c + 0.25 * c * c - 0.45 * c * c * c) + 0.004;
    const cell = u * CELLS;
    const puff = 0.82 + 0.18 * Math.sin(Math.PI * (cell - Math.floor(cell))); // fuller between the ribs
    const top = v < 0.5;
    const off = top ? t * puff : -t * 0.28 * puff;
    const z = CHORD * (0.42 - c); // the nose ahead, the tail behind
    const r = ARC + off;
    return [Math.sin(a) * r, HIGH - ARC + Math.cos(a) * r, z];
  };
  for (let i = 0; i <= along; i++) {
    for (let j = 0; j <= round; j++) {
      const u = i / along;
      const v = j / round;
      pos.push(...point(u, v));
      const cell = Math.min(CELLS - 1, Math.floor(u * CELLS));
      const rib = Math.abs(u * CELLS - Math.round(u * CELLS)) < 0.06 ? 0.72 : 1;
      const under = v > 0.5 ? 0.8 : 1;
      const c = colours[cell]!;
      col.push(c.r * rib * under, c.g * rib * under, c.b * rib * under);
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < round; j++) {
      const a = i * (round + 1) + j;
      const b = a + round + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const canopyGeo = new THREE.BufferGeometry();
  canopyGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  canopyGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  canopyGeo.setIndex(idx);
  canopyGeo.computeVertexNormals();
  const canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
  canopy.add(new THREE.Mesh(canopyGeo, canopyMat));
  // Lines: from each rib's underside, four rows front to back, down to the riser on its side; the risers to the harness.
  const lines: number[] = [];
  const riser = (side: number): [number, number, number] => [side * 0.24, 0.55, 0.05];
  for (let k = 0; k <= CELLS; k++) {
    const u = k / CELLS;
    const side = u < 0.5 ? -1 : 1;
    for (const v of [0.56, 0.68, 0.82, 0.95]) {
      const p = point(u, v);
      const r = riser(side);
      lines.push(...p, ...r);
    }
  }
  for (const side of [-1, 1]) lines.push(...riser(side), side * 0.2, 0, 0);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: '#cfcfcf', transparent: true, opacity: 0.55 });
  canopy.add(new THREE.LineSegments(lineGeo, lineMat));
  return { group, canopy, dispose: () => [canopyGeo, canopyMat, lineGeo, lineMat].forEach((x) => x.dispose()) };
}

/** The owner's car: the city's shape of its kind, a material for each part, and wheels of its own that roll and steer. */
function makeCar(): { group: THREE.Group; body: THREE.Mesh; paint: THREE.MeshStandardMaterial; wheels: THREE.Group[]; setKind(kind: CarAt['kind']): void; dispose(): void } {
  const group = new THREE.Group();
  const shapes = { sedan: vehicleShape('sedan', false), suv: vehicleShape('suv', false), taxi: vehicleShape('taxi', false) };
  const paint = new THREE.MeshStandardMaterial({ color: '#888', roughness: 0.32, metalness: 0.55 });
  const lit = (c: THREE.Color) => {
    const m = new THREE.MeshBasicMaterial({ color: c });
    m.toneMapped = false;
    return m;
  };
  const mats: THREE.Material[] = [];
  mats[PART.paint] = paint;
  mats[PART.glass] = new THREE.MeshStandardMaterial({ color: '#0d121a', roughness: 0.06, metalness: 0.85 });
  mats[PART.tyre] = new THREE.MeshStandardMaterial({ color: '#111214', roughness: 0.9 });
  mats[PART.rim] = new THREE.MeshStandardMaterial({ color: '#b9bec6', roughness: 0.25, metalness: 0.9 });
  mats[PART.headlamp] = lit(new THREE.Color(3, 2.8, 2.3));
  mats[PART.taillamp] = lit(new THREE.Color(2.2, 0.08, 0.05));
  mats[PART.trim] = new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.7 });
  mats[PART.sign] = lit(new THREE.Color(2.2, 1.9, 1.2));
  mats[PART.cabin] = lit(new THREE.Color(1, 0.82, 0.55));
  for (let i = 0; i < PARTS; i++) mats[i] ??= paint;
  const body = new THREE.Mesh(shapes.sedan, mats);
  group.add(body);
  const tyreGeo = new THREE.CylinderGeometry(1, 1, 1, 20).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.04, 12).rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.05, 1.1, 0.12);
  const wheels: THREE.Group[] = [];
  for (let k = 0; k < 4; k++) {
    const w = new THREE.Group();
    const spin = new THREE.Group();
    spin.name = 'spin';
    spin.add(new THREE.Mesh(tyreGeo, mats[PART.tyre]));
    const rim = new THREE.Mesh(rimGeo, mats[PART.rim]);
    spin.add(rim);
    const spoke = new THREE.Mesh(spokeGeo, mats[PART.trim]);
    spin.add(spoke);
    w.add(spin);
    wheels.push(w);
    group.add(w);
  }
  let kind: CarAt['kind'] = 'sedan';
  const setKind = (k: CarAt['kind']) => {
    kind = k;
    body.geometry = shapes[k];
    const spec = WHEELS[k];
    wheels.forEach((w, i) => {
      const [x, z] = spec.at[i]!;
      w.position.set(x, spec.r, z);
      const spin = w.getObjectByName('spin')!;
      spin.scale.set(spec.width, spec.r, spec.r);
      // The rim and the spoke stand on the outside of the tyre.
      spin.children[1]!.position.x = spin.children[2]!.position.x = Math.sign(x) * 0.52;
    });
  };
  setKind(kind);
  return {
    group,
    body,
    paint,
    wheels,
    setKind: (k) => k !== kind && setKind(k),
    dispose: () => [...Object.values(shapes), ...new Set(mats), tyreGeo, rimGeo, spokeGeo].forEach((x) => x.dispose()),
  };
}

/** The parachute and the cars, put each frame where the owner's out-in-the-city state says. */
export function CityGear({ gear }: { gear: { current: Gear } }) {
  const chute = useMemo(makeChute, []);
  const car = useMemo(makeCar, []);
  const parked = useMemo(makeCar, []);
  useEffect(() => () => [chute, car, parked].forEach((x) => x.dispose()), [chute, car, parked]);
  const roll = useMemo(() => ({ a: 0, sway: 0 }), []);
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const g = gear.current;
    chute.group.visible = !!g.chute;
    if (g.chute) {
      // It opens from the shoulders up: a bundle first, then the wing spreads and fills.
      const o = Math.max(0.04, g.chute.open);
      const spread = o * o * (3 - 2 * o);
      chute.group.position.set(g.chute.x, g.chute.y + 1.45, g.chute.z);
      // It leans into a turn, and breathes a little in the air.
      roll.sway += dt;
      chute.group.rotation.set(0.05 * Math.sin(roll.sway * 0.9), g.chute.rot, -g.chute.bank * 0.35 + 0.02 * Math.sin(roll.sway * 1.3), 'YXZ');
      chute.canopy.scale.set(0.12 + 0.88 * spread, 0.25 + 0.75 * o, 0.3 + 0.7 * spread);
    }
    for (const [mesh, at] of [[car, g.car], [parked, g.parked]] as const) {
      mesh.group.visible = !!at;
      if (!at) continue;
      mesh.setKind(at.kind);
      mesh.group.position.set(at.x, at.y, at.z);
      mesh.group.rotation.set(0, at.rot, 0);
      mesh.paint.color.setRGB(at.paint[0], at.paint[1], at.paint[2], THREE.SRGBColorSpace);
    }
    if (g.car) {
      roll.a += (g.car.speed * dt) / WHEELS[g.car.kind].r;
      car.wheels.forEach((w, i) => {
        w.rotation.y = i < 2 ? -g.car!.steer * 0.45 : 0;
        w.getObjectByName('spin')!.rotation.x = roll.a;
      });
    }
    void state;
  });
  return (
    <>
      <primitive object={chute.group} />
      <primitive object={car.group} />
      <primitive object={parked.group} />
    </>
  );
}
