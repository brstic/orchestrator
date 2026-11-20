import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { inUse } from './break-room.ts';
import type { World } from './world.ts';

/**
 * The break room's things doing what they do while somebody uses them (`break-room.ts`): the coffee machine pours
 * into the cup under it and the cup steams; the tap runs into the sink; the fridge's door swings open on a lit
 * inside with its shelves, and closes again when nobody is there. Nothing moves while nobody is at them.
 */
const COFFEE = new THREE.MeshStandardMaterial({ color: '#4a2a14', roughness: 0.3, transparent: true, opacity: 0.9 });
const STEAM = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false });
const WATER = new THREE.MeshStandardMaterial({ color: '#bfe3ff', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false });
const DOOR = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.42, metalness: 0.6 });
const DARK = new THREE.MeshStandardMaterial({ color: '#2a2f38', roughness: 0.35, metalness: 0.5 });
const LINER = new THREE.MeshStandardMaterial({ color: '#f4f8ff', emissive: '#eaf3ff', emissiveIntensity: 0.55, roughness: 0.6 });
const SHELF = new THREE.MeshStandardMaterial({ color: '#dfe9f5', roughness: 0.2, transparent: true, opacity: 0.75 });
const GLOW = new THREE.MeshBasicMaterial({ color: '#6ea8ff' });
const THINGS = ['#e45b3c', '#f2c94c', '#6fcf97', '#ffffff', '#56ccf2', '#bb6bd9'].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));

function CoffeeBrew({ at }: { at: { x: number; y: number; z: number } }) {
  const group = useRef<THREE.Group>(null);
  const stream = useRef<THREE.Mesh>(null);
  const puffs = useRef<THREE.Mesh[]>([]);
  useFrame(({ clock }) => {
    const on = inUse('coffee');
    if (group.current) group.current.visible = on;
    if (!on) return;
    const t = clock.elapsedTime;
    // The stream pours in bursts (the machine's own rhythm), the steam goes up all the time.
    if (stream.current) stream.current.visible = t % 9 > 2 && t % 9 < 6.2;
    puffs.current.forEach((p, i) => {
      const k = ((t * 0.45 + i / puffs.current.length) % 1 + 1) % 1;
      p.position.set(Math.sin(t * 1.3 + i * 2.1) * 0.02 * k, 0.12 + k * 0.32, Math.cos(t * 1.1 + i) * 0.02 * k);
      const s = 0.012 + k * 0.035;
      p.scale.setScalar(s / 0.02);
      (p.material as THREE.MeshBasicMaterial).opacity = 0.26 * (1 - k);
    });
  });
  const puffMats = useMemo(() => Array.from({ length: 6 }, () => STEAM.clone()), []);
  return (
    <group ref={group} position={[at.x, at.y, at.z]} visible={false}>
      <mesh ref={stream} position={[0, 0.17, 0]} material={COFFEE}>
        <cylinderGeometry args={[0.004, 0.004, 0.12, 6]} />
      </mesh>
      {puffMats.map((m, i) => (
        <mesh key={i} ref={(el) => void (el && (puffs.current[i] = el))} material={m}>
          <sphereGeometry args={[0.02, 8, 6]} />
        </mesh>
      ))}
    </group>
  );
}

function TapWater({ at }: { at: { x: number; y: number; z: number } }) {
  const water = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const on = inUse('sink');
    if (!water.current) return;
    water.current.visible = on;
    if (on) water.current.scale.x = water.current.scale.z = 1 + Math.sin(clock.elapsedTime * 23) * 0.12;
  });
  return (
    <mesh ref={water} position={[at.x, at.y - 0.12, at.z]} material={WATER} visible={false}>
      <cylinderGeometry args={[0.008, 0.01, 0.24, 8]} />
    </mesh>
  );
}

/**
 * The fridge's upper door (the rest of the fridge is `fridge()` in models/rooms.ts), hinged on the side away from its
 * handle: open while somebody is at the fridge, on a lit inside — glass shelves with things on them.
 */
function FridgeDoor({ at }: { at: { x: number; z: number } }) {
  const hinge = useRef<THREE.Group>(null);
  const inside = useRef<THREE.Group>(null);
  const open = useRef(0);
  useFrame((_s, dt) => {
    const want = inUse('fridge') ? 1 : 0;
    open.current += (want - open.current) * Math.min(1, dt * (want ? 2.4 : 3.5));
    if (hinge.current) hinge.current.rotation.y = open.current * 1.75;
    if (inside.current) inside.current.visible = open.current > 0.02;
  });
  return (
    // (Turned as the fridge is: its doors toward the room. In its own frame the door faces +z; the hinge at +x.)
    <group position={[at.x, 0, at.z]} rotation={[0, -Math.PI / 2, 0]}>
      <group ref={inside} visible={false}>
        <mesh position={[0, 1.3, 0.322]} material={LINER}>
          <boxGeometry args={[0.7, 1.08, 0.004]} />
        </mesh>
        {[0.98, 1.3, 1.6].map((y) => (
          <mesh key={y} position={[0, y, 0.33]} material={SHELF}>
            <boxGeometry args={[0.68, 0.01, 0.03]} />
          </mesh>
        ))}
        {[
          [-0.22, 0.99, 0.05, 0.16],
          [-0.05, 0.99, 0.07, 0.1],
          [0.16, 0.99, 0.09, 0.12],
          [-0.18, 1.31, 0.12, 0.08],
          [0.1, 1.31, 0.05, 0.2],
          [0.0, 1.61, 0.14, 0.07],
        ].map(([x, y, w, h], i) => (
          <mesh key={i} position={[x!, y! + h! / 2, 0.336]} material={THINGS[i % THINGS.length]}>
            <boxGeometry args={[w!, h!, 0.02]} />
          </mesh>
        ))}
      </group>
      <group ref={hinge} position={[0.39, 0, 0.345]}>
        <group position={[-0.39, 0, 0]}>
          <mesh position={[0, 1.3, 0]} material={DOOR} castShadow>
            <boxGeometry args={[0.78, 1.16, 0.05]} />
          </mesh>
          <mesh position={[-0.31, 1.18, 0.045]} material={DARK}>
            <boxGeometry args={[0.022, 0.62, 0.03]} />
          </mesh>
          <mesh position={[0.12, 1.5, 0.027]} material={DARK}>
            <boxGeometry args={[0.16, 0.1, 0.004]} />
          </mesh>
          <mesh position={[0.12, 1.5, 0.03]} material={GLOW}>
            <boxGeometry args={[0.06, 0.02, 0.002]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** The break room's things that move: rendered with the break room (Environment.tsx). */
export function BreakThings({ props }: { props: NonNullable<World['breakProps']> }) {
  return (
    <>
      <CoffeeBrew at={props.coffee} />
      <TapWater at={props.tap} />
      <FridgeDoor at={props.fridge} />
    </>
  );
}
