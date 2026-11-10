import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { RadioView } from './types.ts';
import type { World } from './world.ts';

const cabinetGeo = new RoundedBoxGeometry(1.5, 0.5, 0.48, 3, 0.03);
const ampGeo = new RoundedBoxGeometry(0.62, 0.15, 0.38, 3, 0.015);
const deckGeo = new RoundedBoxGeometry(0.5, 0.06, 0.4, 3, 0.012);
const speakerGeo = new RoundedBoxGeometry(0.36, 1.05, 0.34, 3, 0.03);
const platterGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.014, 40);
const coneGeo = new THREE.CircleGeometry(1, 36);
const knobGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.03, 20);
const barGeo = new THREE.BoxGeometry(0.03, 1, 0.006);
const BARS = 9;

/**
 * The office hi-fi: a sideboard with a receiver and a turntable between two floor speakers.
 * It is a view of the real player — the speaker cones, the level meter and the turning record
 * move only while a station is actually playing in the owner's window.
 */
export function HiFi({ world, radio, onOpen }: { world: World; radio: RadioView; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const cones = useRef<THREE.Mesh[]>([]);
  const bars = useRef<THREE.Mesh[]>([]);
  const platter = useRef<THREE.Mesh>(null);
  const level = useRef(0);
  const wood = useMemo(() => new THREE.MeshStandardMaterial({ color: '#7a5a3c', roughness: 0.55 }), []);
  const black = useMemo(() => new THREE.MeshStandardMaterial({ color: '#15181e', roughness: 0.5, metalness: 0.2 }), []);
  const metal = useMemo(() => new THREE.MeshStandardMaterial({ color: '#b8bec8', roughness: 0.3, metalness: 0.8 }), []);
  const cone = useMemo(() => new THREE.MeshStandardMaterial({ color: '#2a2f38', roughness: 0.85 }), []);
  const vinyl = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0c0d10', roughness: 0.35 }), []);
  const label = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d9483b', roughness: 0.6 }), []);
  const glow = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1b2a22', emissive: new THREE.Color('#3ddc84'), emissiveIntensity: 0, roughness: 0.4 }), []);
  const display = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0b1410', emissive: new THREE.Color('#3ddc84'), emissiveIntensity: 0.05, roughness: 0.3 }), []);

  useFrame(({ clock }, dt) => {
    // Eases in and out with the real play state; there is no audio analysis, so the motion is a steady groove.
    level.current += ((radio.playing ? 1 : 0) - level.current) * Math.min(1, dt * 4);
    const l = level.current;
    const t = clock.elapsedTime;
    const beat = Math.pow(Math.max(0, Math.sin(t * 7.3)), 6);
    cones.current.forEach((m, i) => {
      if (!m) return;
      const base = (m.userData.r as number) ?? 1;
      const pump = 1 + l * (0.05 + beat * (i % 2 ? 0.05 : 0.09));
      m.scale.setScalar(base * pump);
    });
    bars.current.forEach((m, i) => {
      if (!m) return;
      const h = 0.012 + l * 0.1 * (0.25 + 0.75 * Math.abs(Math.sin(t * (3.1 + i * 0.83) + i * 1.7)) * (0.6 + 0.4 * Math.sin(t * 1.3 + i)));
      m.scale.y = h;
      m.position.y = 0.335 + h / 2;
    });
    glow.emissiveIntensity = 0.1 + l * 1.5;
    display.emissiveIntensity = 0.05 + l * 0.9;
    if (platter.current) platter.current.rotation.y -= dt * 3.5 * l;
  });

  if (!world.hifi) return null;
  const { x, z, rot } = world.hifi;
  const speaker = (sx: number, key: string, offset: number) => (
    <group key={key} position={[sx, 0.525, 0]}>
      <mesh geometry={speakerGeo} material={wood} castShadow receiveShadow />
      <mesh position={[0, 0, 0.171]} material={black}>
        <planeGeometry args={[0.3, 0.98]} />
      </mesh>
      {[
        [0.3, 0.05],
        [0.02, 0.105],
        [-0.3, 0.125],
      ].map(([y, r], i) => (
        <mesh
          key={i}
          geometry={coneGeo}
          material={cone}
          position={[0, y!, 0.174]}
          userData={{ r }}
          scale={r}
          ref={(m) => {
            if (m) cones.current[offset + i] = m;
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
      {speaker(-1.1, 'l', 0)}
      {speaker(1.1, 'r', 3)}
      <mesh geometry={cabinetGeo} material={wood} position={[0, 0.3, 0]} castShadow receiveShadow />
      <mesh position={[0, 0.03, 0]} material={black}>
        <boxGeometry args={[1.4, 0.06, 0.4]} />
      </mesh>
      {/* receiver */}
      <group position={[-0.36, 0.625, 0.02]}>
        <mesh geometry={ampGeo} material={black} castShadow />
        <mesh position={[-0.1, 0.01, 0.191]} material={display}>
          <planeGeometry args={[0.3, 0.07]} />
        </mesh>
        {[0.14, 0.22].map((kx) => (
          <mesh key={kx} geometry={knobGeo} material={metal} position={[kx, 0, 0.2]} rotation={[Math.PI / 2, 0, 0]} />
        ))}
      </group>
      {/* level meter on the cabinet front */}
      {Array.from({ length: BARS }, (_, i) => (
        <mesh
          key={i}
          geometry={barGeo}
          material={glow}
          position={[-0.36 + (i - (BARS - 1) / 2) * 0.045, 0.34, 0.245]}
          ref={(m) => {
            if (m) bars.current[i] = m;
          }}
        />
      ))}
      {/* turntable */}
      <group position={[0.36, 0.58, 0.02]}>
        <mesh geometry={deckGeo} material={black} castShadow />
        <mesh ref={platter} geometry={platterGeo} material={vinyl} position={[-0.04, 0.04, 0]} />
        <mesh position={[-0.04, 0.049, 0]} material={label}>
          <cylinderGeometry args={[0.05, 0.05, 0.002, 24]} />
        </mesh>
        <mesh position={[0.17, 0.06, -0.02]} rotation={[0, 0.5, 0]} material={metal}>
          <boxGeometry args={[0.012, 0.012, 0.24]} />
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
