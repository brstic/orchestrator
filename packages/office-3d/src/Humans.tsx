import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { Character, type PoseName } from './Character.tsx';
import { useActs } from './character/acts.ts';

/** Another person in the office (the owner, or a guest), as the server reports them about ten times a second. */
export interface HumanView {
  id: string;
  name: string;
  role: 'owner' | 'colleague' | 'visitor';
  x: number;
  z: number;
  rot: number;
  moving: boolean;
  hue: number;
  /** What they last said out loud, shown for a few seconds. */
  saying: string | null;
  /** When they last cracked the whip (ms); their character swings each time it changes. */
  whipAt?: number;
  /** When someone's whip lands on them (ms): their character flinches. */
  ouchAt?: number;
  /** The gesture they last asked their character to make (the wheel), and when. */
  emote?: { name: string; at: number } | null;
  /** They are talking right now (holding the talk key), within earshot of this window. */
  speaking?: boolean;
}

const SKIN = ['#f1c9a5', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const HAIR = ['#2c1b10', '#3b2a1a', '#6b4423', '#111111', '#a0522d', '#d6b370'];

/** A look that is the same every time for the same person, and different from person to person. */
function hsl(h: number, s: number, l: number): string {
  // Appearance colours are hex strings; convert so every part of the character can use them.
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function lookOf(h: HumanView): Appearance {
  return {
    skin: SKIN[h.hue % SKIN.length]!,
    hair: HAIR[(h.hue >> 2) % HAIR.length]!,
    hairStyle: (['short', 'long', 'bun', 'curly'] as const)[(h.hue >> 4) % 4]!,
    shirt: hsl(h.hue, 55, 46),
    pants: hsl((h.hue + 200) % 360, 18, 24),
    accessory: 'none',
    build: 1,
  };
}

function Human({ h }: { h: HumanView }) {
  const group = useRef<THREE.Group>(null);
  const at = useRef({ x: h.x, z: h.z, rot: h.rot });
  const [walking, setWalking] = useState(false);
  // The name tag is an HTML overlay; mounted in the very first commit of the scene (someone was already
  // here when the office loaded) it never appears, so it is added once this character has been drawn.
  const [drawn, setDrawn] = useState(false);
  const look = useMemo(() => lookOf(h), [h.hue]);
  // A whip crack, a flinch from someone else's, a gesture: each plays once when it is announced (as the owner's own character does).
  const act = useActs({ whipAt: h.whipAt, ouchAt: h.ouchAt, emote: h.emote });
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    if (!drawn) setDrawn(true);
    // Ease towards the last reported place: updates arrive in steps, people move smoothly.
    const k = 1 - Math.exp(-dt * 12);
    const a = at.current;
    const far = Math.hypot(h.x - a.x, h.z - a.z) > 6;
    a.x = far ? h.x : a.x + (h.x - a.x) * k;
    a.z = far ? h.z : a.z + (h.z - a.z) * k;
    let d = h.rot - a.rot;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    a.rot += d * k;
    g.position.set(a.x, 0, a.z);
    g.rotation.y = a.rot;
    const moving = h.moving || Math.hypot(h.x - a.x, h.z - a.z) > 0.08;
    if (moving !== walking) setWalking(moving);
  });
  const pose: PoseName = act.pose ?? (walking ? 'walk' : 'stand');
  return (
    <group ref={group} position={[h.x, 0, h.z]} rotation={[0, h.rot, 0]}>
      <Character appearance={look} pose={pose} cue={act.cue} whip={act.whipping} level={h.role === 'owner' ? 9 : 1} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.36, 0.44, 32]} />
        <meshBasicMaterial color={`hsl(${h.hue} 80% 60%)`} transparent opacity={0.9} toneMapped={false} />
      </mesh>
      {drawn && (
      <Html position={[0, 2.02, 0]} center zIndexRange={[32, 0]} style={{ pointerEvents: 'none' }}>
        <div className="human-tag" style={{ borderColor: `hsl(${h.hue} 70% 60%)` }}>
          {h.saying && <div className="human-says">{h.saying}</div>}
          <div className="human-name">
            {h.speaking && <span className="human-speaking" aria-label="talking" />}
            {h.name}
          </div>
          <div className="human-role">{h.role === 'owner' ? 'owner' : h.role}</div>
        </div>
      </Html>
      )}
    </group>
  );
}

/** The other people in the office: real persons at their own computers, drawn where they say they are. */
export function Humans({ humans }: { humans: HumanView[] }) {
  return (
    <>
      {humans.map((h) => (
        <Human key={h.id} h={h} />
      ))}
    </>
  );
}
