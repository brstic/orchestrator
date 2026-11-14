import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { Character, type Motion } from '../Character.tsx';
import { cityLive, cityWalkersFor } from '../surroundings/skyline.ts';
import type { Quality } from '../types.ts';
import { STREET_Y } from './blocks.ts';
import { walkerAt, type Walker } from './walkers.ts';

/** How many people near the camera are drawn as characters, and from how far. */
const SLOTS = 24;
const NEAR = 55;
/** How often who is near is decided (s). */
const PICK = 0.25;

const wrapPi = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/**
 * The people on the pavements near the camera, as the office's own characters — the same people the city draws far
 * away as one simple shape (`skyline.ts` hides those within `cityLive.walkersNear` of the camera, so nobody is drawn
 * twice). Only when the camera is down in the street.
 */
export function CityWalkers({ quality }: { quality: Quality }) {
  const list = useMemo(() => cityWalkersFor(quality), [quality]);
  const [near, setNear] = useState<number[]>([]);
  const last = useRef(-1);
  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime;
    if (t - last.current < PICK && last.current >= 0) return;
    last.current = t;
    const origin = { x: camera.position.x, z: camera.position.z };
    let chosen: number[] = [];
    let hide = 0;
    if (camera.position.y < STREET_Y + 60) {
      const close: Array<[number, number]> = [];
      for (let i = 0; i < list.length; i++) {
        const at = walkerAt(list[i]!, t, origin);
        const d = Math.hypot(at.x - origin.x, at.z - origin.z);
        if (d < NEAR) close.push([d, i]);
      }
      close.sort((a, b) => a[0] - b[0]);
      chosen = close.slice(0, SLOTS).map((c) => c[1]);
      hide = close.length <= SLOTS ? NEAR : (close[SLOTS - 1]![0] + close[SLOTS]![0]) / 2;
    }
    cityLive.walkersNear = hide;
    const key = [...chosen].sort((a, b) => a - b).join(',');
    if (key !== [...near].sort((a, b) => a - b).join(',')) setNear(chosen);
  });
  return (
    <>
      {near.map((i) => (
        <CityWalker key={i} w={list[i]!} />
      ))}
    </>
  );
}

function CityWalker({ w }: { w: Walker }) {
  const group = useRef<THREE.Group>(null);
  const motion = useRef<Motion>({ vx: 0, vz: 0, turn: 0, run: false });
  const facing = useRef<number | null>(null);
  // Before the character's own frame (priority −1), so its feet are placed for where the body is drawn.
  useFrame(({ camera, clock }, dt) => {
    const g = group.current;
    if (!g) return;
    const at = walkerAt(w, clock.elapsedTime, { x: camera.position.x, z: camera.position.z });
    // Round a corner the body turns over a few steps, not at once.
    const prev = facing.current ?? at.heading;
    const next = prev + wrapPi(at.heading - prev) * (1 - Math.exp(-Math.min(dt, 0.05) * 7));
    facing.current = next;
    g.position.set(at.x, STREET_Y, at.z);
    g.rotation.y = next;
    const m = motion.current;
    m.vx = 0;
    m.vz = at.speed;
    m.turn = dt > 1e-4 ? (next - prev) / dt : 0;
    m.run = false;
  }, -1);
  return (
    <group ref={group}>
      <Character appearance={w.look} pose="stand" motion={motion} level={1} phase={w.walk[0]} />
    </group>
  );
}
