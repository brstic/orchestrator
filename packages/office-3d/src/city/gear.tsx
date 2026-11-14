import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

/** What the owner has with them out in the city, where it is this frame (written by `Rig.tsx`, read here). */
export interface Gear {
  chute: { x: number; y: number; z: number; rot: number; open: number } | null;
  car: CarAt | null;
  parked: CarAt | null;
}
interface CarAt {
  x: number;
  y: number;
  z: number;
  rot: number;
  paint: [number, number, number];
  speed: number;
}

/** A parachute: a canopy of coloured panels over the shoulders, and the lines down to them. Its origin is the shoulders. */
function makeChute(): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  const panels = 10;
  const canopy = new THREE.SphereGeometry(3.4, panels * 2, 6, 0, Math.PI * 2, 0, 1.05);
  canopy.scale(1.35, 0.5, 0.95);
  const colors: number[] = [];
  const pos = canopy.getAttribute('position');
  const stripe = [new THREE.Color('#e63946'), new THREE.Color('#f1faee'), new THREE.Color('#1d3557'), new THREE.Color('#f4a261')];
  for (let i = 0; i < pos.count; i++) {
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    const c = stripe[Math.floor(((a + Math.PI) / (Math.PI * 2)) * panels) % stripe.length]!;
    colors.push(c.r, c.g, c.b);
  }
  canopy.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  const top = new THREE.Mesh(canopy, canopyMat);
  top.position.y = 4.2;
  group.add(top);
  // The lines: from the canopy's rim down to the two shoulders.
  const rimY = 4.2 + 3.4 * 0.5 * Math.cos(1.05);
  const rimR = Math.sin(1.05) * 3.4;
  const line: number[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const sx = Math.cos(a) > 0 ? 0.22 : -0.22;
    line.push(Math.cos(a) * rimR * 1.35, rimY, Math.sin(a) * rimR * 0.95, sx, 0, 0);
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: '#d9d9d9', transparent: true, opacity: 0.7 });
  group.add(new THREE.LineSegments(lineGeo, lineMat));
  return { group, dispose: () => [canopy, canopyMat, lineGeo, lineMat].forEach((x) => x.dispose()) };
}

/** A car: body in its paint, a cabin of glass, wheels, lamps at both ends. Faces +z. */
function makeCar(): { group: THREE.Group; paint: THREE.MeshStandardMaterial; wheels: THREE.Mesh[]; dispose(): void } {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: '#888', roughness: 0.35, metalness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: '#0b0f16', roughness: 0.1, metalness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.9 });
  const front = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.8, 2.3) });
  const back = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.08, 0.05) });
  front.toneMapped = back.toneMapped = false;
  const geos: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    group.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(1.84, 0.62, 4.6), paint, 0, 0.6, 0);
  add(new THREE.BoxGeometry(1.6, 0.5, 2.3), glass, 0, 1.16, -0.2);
  add(new THREE.BoxGeometry(1.5, 0.06, 2.0), paint, 0, 1.43, -0.25);
  const wheels: THREE.Mesh[] = [];
  const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14).rotateZ(Math.PI / 2);
  for (const z of [-1.45, 1.4]) for (const x of [-0.82, 0.82]) wheels.push(add(wheel.clone(), rubber, x, 0.34, z));
  wheel.dispose();
  for (const x of [-0.62, 0.62]) {
    add(new THREE.BoxGeometry(0.4, 0.16, 0.05), front, x, 0.72, 2.31);
    add(new THREE.BoxGeometry(0.4, 0.14, 0.05), back, x, 0.74, -2.31);
  }
  return { group, paint, wheels, dispose: () => [...geos, paint, glass, rubber, front, back].forEach((x) => x.dispose()) };
}

/** The parachute and the cars, put each frame where the owner's out-in-the-city state says. */
export function CityGear({ gear }: { gear: { current: Gear } }) {
  const chute = useMemo(makeChute, []);
  const car = useMemo(makeCar, []);
  const parked = useMemo(makeCar, []);
  useEffect(() => () => [chute, car, parked].forEach((x) => x.dispose()), [chute, car, parked]);
  const roll = useMemo(() => ({ a: 0 }), []);
  useFrame((_s, dt) => {
    const g = gear.current;
    chute.group.visible = !!g.chute;
    if (g.chute) {
      // It opens from the shoulders up: small and close at first, then full above.
      const o = Math.max(0.05, g.chute.open);
      chute.group.position.set(g.chute.x, g.chute.y + 1.45, g.chute.z);
      chute.group.rotation.set(0, g.chute.rot, 0);
      chute.group.scale.set(0.3 + 0.7 * o, o, 0.3 + 0.7 * o);
    }
    for (const [mesh, at] of [[car, g.car], [parked, g.parked]] as const) {
      mesh.group.visible = !!at;
      if (!at) continue;
      mesh.group.position.set(at.x, at.y, at.z);
      mesh.group.rotation.set(0, at.rot, 0);
      mesh.paint.color.setRGB(at.paint[0], at.paint[1], at.paint[2], THREE.SRGBColorSpace);
    }
    if (g.car) {
      roll.a += (g.car.speed * Math.min(dt, 0.05)) / 0.34;
      for (const w of car.wheels) w.rotation.x = roll.a;
    }
  });
  return (
    <>
      <primitive object={chute.group} />
      <primitive object={car.group} />
      <primitive object={parked.group} />
    </>
  );
}
