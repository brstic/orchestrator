import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Model } from './models/Model.tsx';
import { ON_SURFACE } from './surface.ts';
import { hifi, speakerCone } from './models/rooms.ts';
import type { RadioView } from './types.ts';
import type { World } from './world.ts';

const platterGeo = new THREE.CylinderGeometry(0.155, 0.155, 0.004, 40);
const barGeo = new THREE.BoxGeometry(0.022, 1, 0.004);
const BARS = 9;

/**
 * The office hi-fi: a sideboard with a receiver and a turntable between two floor speakers.
 * It is a view of the real player — the speaker cones, the level meter and the turning record
 * move only while a station is actually playing in the owner's window.
 */
export function HiFi({ world, radio, onOpen }: { world: World; radio: RadioView; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const coneRefs = useRef<THREE.Mesh[]>([]);
  const bars = useRef<THREE.Mesh[]>([]);
  const platter = useRef<THREE.Mesh>(null);
  const level = useRef(0);
  const cone = useMemo(() => new THREE.MeshStandardMaterial({ color: '#3a404b', roughness: 0.62, side: THREE.DoubleSide }), []);
  const vinyl = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0a0b0e', roughness: 0.28, metalness: 0.2 }), []);
  const label = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d9483b', roughness: 0.6 }), []);
  const glow = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1b2a22', emissive: new THREE.Color('#3ddc84'), emissiveIntensity: 0, roughness: 0.4, ...ON_SURFACE }), []);
  const display = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0b1410', emissive: new THREE.Color('#3ddc84'), emissiveIntensity: 0.05, roughness: 0.3, ...ON_SURFACE }), []);

  useFrame(({ clock }, dt) => {
    // Eases in and out with the real play state; there is no audio analysis, so the motion is a steady groove.
    level.current += ((radio.playing ? 1 : 0) - level.current) * Math.min(1, dt * 4);
    const l = level.current;
    const t = clock.elapsedTime;
    const beat = Math.pow(Math.max(0, Math.sin(t * 7.3)), 6);
    coneRefs.current.forEach((m, i) => {
      if (!m) return;
      const base = (m.userData.r as number) ?? 1;
      const pump = 1 + l * (0.05 + beat * (i % 2 ? 0.05 : 0.09));
      m.scale.setScalar(base * pump);
    });
    bars.current.forEach((m, i) => {
      if (!m) return;
      const h = 0.006 + l * 0.056 * (0.25 + 0.75 * Math.abs(Math.sin(t * (3.1 + i * 0.83) + i * 1.7)) * (0.6 + 0.4 * Math.sin(t * 1.3 + i)));
      m.scale.y = h;
      m.position.y = 0.617 + h / 2;
    });
    glow.emissiveIntensity = 0.1 + l * 1.5;
    display.emissiveIntensity = 0.05 + l * 0.9;
    if (platter.current) platter.current.rotation.y -= dt * 3.5 * l;
  });

  if (!world.hifi) return null;
  const { x, z, rot } = world.hifi;
  const cones = (sx: number, key: string, offset: number) => (
    <group key={key} position={[sx, 0, 0]}>
      {[
        [0.855, 0.05],
        [0.575, 0.105],
        [0.255, 0.125],
      ].map(([y, r], i) => (
        <mesh
          key={i}
          geometry={speakerCone()}
          material={cone}
          position={[0, y!, 0.172]}
          userData={{ r }}
          scale={r}
          ref={(m) => {
            if (m) coneRefs.current[offset + i] = m;
          }}
        />
      ))}
    </group>
  );
  return (
    <group
      position={[x, 0, z]}
      rotation={[0, rot, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = '';
      }}
    >
      <Model model={hifi()} />
      {cones(-1.1, 'l', 0)}
      {cones(1.1, 'r', 3)}
      {/* the receiver's display, and the level meter in it */}
      <mesh position={[-0.46, 0.647, 0.2145]} material={display}>
        <planeGeometry args={[0.31, 0.068]} />
      </mesh>
      {Array.from({ length: BARS }, (_, i) => (
        <mesh
          key={i}
          geometry={barGeo}
          material={glow}
          position={[-0.46 + (i - (BARS - 1) / 2) * 0.03, 0.62, 0.2155]}
          ref={(m) => {
            if (m) bars.current[i] = m;
          }}
        />
      ))}
      {/* the record */}
      <group position={[0.32, 0.643, 0.02]}>
        <mesh ref={platter} geometry={platterGeo} material={vinyl} />
        <mesh position={[0, 0.003, 0]} material={label}>
          <cylinderGeometry args={[0.05, 0.05, 0.002, 24]} />
        </mesh>
      </group>
      {(hover || radio.playing) && (
        <Html position={[0, 1.42, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
          <div className="doc-tip">{radio.playing ? `♪ ${radio.station ?? 'Radio'}` : 'Hi-fi · click to choose a station'}</div>
        </Html>
      )}
    </group>
  );
}
