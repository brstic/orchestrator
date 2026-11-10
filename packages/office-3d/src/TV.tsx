import { Html } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { World } from './world.ts';
import { ON_SURFACE } from './surface.ts';
import { Model } from './models/Model.tsx';
import { mediaConsole } from './models/rooms.ts';

export interface TvView {
  on: boolean;
  title: string | null;
  audible: boolean;
}

/** Called with each new picture of the TV (a base64 JPEG), or null when it goes dark. Returns an unsubscribe function. */
export type TvFrames = (cb: (jpegBase64: string | null) => void) => () => void;

const W = 3.4;
const H = (W * 9) / 16;
const frameGeo = new RoundedBoxGeometry(W + 0.14, H + 0.14, 0.09, 3, 0.03);

/**
 * The big TV on the wall. Its screen shows what the TV is really showing: the picture of the
 * embedded browser, refreshed about once a second. Off, it is a dark panel with a standby light.
 */
export function TV({ world, tv, frames, onOpen }: { world: World; tv: TvView; frames: TvFrames; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const texture = useMemo(() => {
    const t = new THREE.Texture();
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }, []);
  const [hasPicture, setHasPicture] = useState(false);
  const body = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0e1014', roughness: 0.35, metalness: 0.5 }), []);
  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#05070a', roughness: 0.2, metalness: 0.1 }), []);
  const lit = useMemo(() => new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, ...ON_SURFACE }), [texture]);
  const led = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff4b4b', toneMapped: false }), []);

  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      texture.image = img;
      texture.needsUpdate = true;
      setHasPicture(true);
    };
    const off = frames((jpeg) => {
      if (!jpeg) return setHasPicture(false);
      img.src = `data:image/jpeg;base64,${jpeg}`;
    });
    return () => {
      alive = false;
      off();
    };
  }, [frames, texture]);
  useEffect(() => () => texture.dispose(), [texture]);
  useEffect(() => {
    led.color.set(tv.on ? '#3ddc84' : '#ff4b4b');
  }, [tv.on, led]);

  if (!world.tv) return null;
  const { x, z, rot } = world.tv;
  const showing = tv.on && hasPicture;
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
      <mesh geometry={frameGeo} material={body} position={[0, 1.75, 0.05]} castShadow />
      <mesh position={[0, 1.75, 0.097]} material={showing ? lit : dark}>
        <planeGeometry args={[W, H]} />
      </mesh>
      <mesh position={[W / 2 - 0.08, 1.75 - H / 2 - 0.035, 0.1]} material={led}>
        <circleGeometry args={[0.012, 12]} />
      </mesh>
      {/* a low media console under it */}
      <Model model={mediaConsole()} position={[0, 0, 0.24]} />
      {tv.on && <pointLight position={[0, 1.7, 1.2]} intensity={tv.audible ? 2.2 : 1.4} distance={6} color="#9db8ff" />}
      {(hover || (tv.on && !showing)) && (
        <Html position={[0, 1.75 + H / 2 + 0.28, 0.1]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
          <div className="doc-tip">{tv.on ? `TV · ${tv.title ?? 'on'}` : 'TV · click to switch it on'}</div>
        </Html>
      )}
    </group>
  );
}
