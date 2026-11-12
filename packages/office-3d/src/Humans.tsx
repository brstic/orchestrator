import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { memo, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { Character, type Motion } from './Character.tsx';
import { RemoteTrack } from './remote-motion.ts';
import { jumpY } from './Rig.tsx';
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
  /** The sender's clock at that report (ms), from windows that send one: lets the character move evenly however unevenly the reports arrive. */
  at?: number;
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
  /** They are sitting: where they are is a seat, and their character sits on it. */
  sit?: boolean;
  /** When their character last jumped, by this window's clock (`performance.now()`). */
  jumpAt?: number;
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

/**
 * The newest report of each person, by id, and when it was seen here. Written whenever the list arrives (about ten
 * times a second while anybody moves) and read by each character every frame — so a report moves a character
 * without redrawing it.
 */
const reports = new Map<string, { x: number; z: number; rot: number; moving: boolean; at?: number; seen: number }>();

/** Faster than this over the floor (m/s) is a run: between the pace a person walks at (3.8) and the pace they run at (7.4). */
const RUNS_ABOVE = 5.6;

const Human = memo(function Human({ h }: { h: HumanView }) {
  const group = useRef<THREE.Group>(null);
  const track = useRef<RemoteTrack | null>(null);
  const taken = useRef<object | null>(null);
  const at = useRef<{ x: number; z: number; rot: number } | null>(null);
  const sampled = useRef<number | null>(null);
  // How the body really moved this frame, in its own frame of reference: the legs walk by this, as the owner's do.
  const motion = useRef<Motion>({ vx: 0, vz: 0, turn: 0, run: false });
  // The name tag is an HTML overlay; mounted in the very first commit of the scene (someone was already
  // here when the office loaded) it never appears, so it is added once this character has been drawn.
  const [drawn, setDrawn] = useState(false);
  const look = useMemo(() => lookOf(h), [h.hue]);
  // A whip crack, a flinch from someone else's, a gesture: each plays once when it is announced (as the owner's own character does).
  const act = useActs({ whipAt: h.whipAt, ouchAt: h.ouchAt, emote: h.emote });
  const jumpAt = useRef(h.jumpAt);
  jumpAt.current = h.jumpAt;
  const sitNow = useRef(h.sit);
  sitNow.current = h.sit;
  // Before the character animates (see `motion` in Character.tsx): its feet are then placed for this frame's position.
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    if (!drawn) setDrawn(true);
    const now = performance.now();
    const r = reports.get(h.id);
    const tr = (track.current ??= new RemoteTrack());
    if (r && r !== taken.current) {
      taken.current = r;
      tr.push(r, r.seen);
    }
    const p = tr.sample(now);
    if (!p) return;
    const was = at.current;
    const m = motion.current;
    // By the time that really passed between the two places (the frame clock's own step can differ from it).
    const step = sampled.current === null ? 0 : (now - sampled.current) / 1000;
    sampled.current = now;
    if (!was || step < 1e-4 || step > 0.25 || Math.hypot(p.x - was.x, p.z - was.z) > 3) {
      // First sight of them, or they were put somewhere else: there, at once, standing.
      m.vx = m.vz = m.turn = 0;
      m.run = false;
    } else {
      const wx = (p.x - was.x) / step;
      const wz = (p.z - was.z) / step;
      const sr = Math.sin(p.rot);
      const cr = Math.cos(p.rot);
      let d = p.rot - was.rot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // A little smoothing over the joins between reports; the place itself is exact.
      const k = 1 - Math.exp(-step * 20);
      m.vx += (wx * cr - wz * sr - m.vx) * k;
      m.vz += (wx * sr + wz * cr - m.vz) * k;
      m.turn += (d / step - m.turn) * k;
      const speed = Math.hypot(m.vx, m.vz);
      // With a margin both ways, so that a pace near the line does not flip between a walk and a run.
      m.run = m.run ? speed > RUNS_ABOVE - 0.8 : speed > RUNS_ABOVE;
      if (speed < 0.02) m.vx = m.vz = 0;
    }
    at.current = p;
    // A jump of theirs: up and down again, as this window saw it begin.
    const lift = jumpAt.current ? jumpY((now - jumpAt.current) / 1000) : 0;
    g.position.set(p.x, lift, p.z);
    g.rotation.y = p.rot;
    // For the UI tests (see `window.__orchScene`): where each other person is drawn right now and how they move.
    const probe = ((window as unknown as { __orchScene?: Record<string, any> }).__orchScene ??= { detail: {} });
    (probe.humans ??= {})[h.id] = { x: p.x, z: p.z, rot: p.rot, vx: m.vx, vz: m.vz, turn: m.turn, run: m.run, name: h.name, t: now, y: lift, sit: !!sitNow.current };
  }, -1);
  const body = useMemo(
    () => <Character appearance={look} pose={h.sit ? (act.pose === 'ouch' ? 'ouch' : 'idle') : (act.pose ?? 'stand')} cue={act.cue ?? 0} whip={act.whipping} level={h.role === 'owner' ? 9 : 1} motion={motion} />,
    [look, act.pose, act.cue, act.whipping, h.role, h.sit],
  );
  // (No position on the group itself: it is placed every frame above. A position given here would be put back on the
  // character at every report — a jump to where they are *now*, in the middle of walking to where they were.)
  return (
    <group ref={group}>
      {body}
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
}, sameButForPlace);

/** Everything about a person that is drawn by React — not where they are, which the frame loop reads for itself. */
function sameButForPlace(a: { h: HumanView }, b: { h: HumanView }): boolean {
  const x = a.h;
  const y = b.h;
  return x.id === y.id && x.name === y.name && x.role === y.role && x.hue === y.hue && x.saying === y.saying && !!x.sit === !!y.sit && x.jumpAt === y.jumpAt && x.whipAt === y.whipAt && x.ouchAt === y.ouchAt && x.emote?.at === y.emote?.at && x.emote?.name === y.emote?.name && !!x.speaking === !!y.speaking;
}

/** The other people in the office: real persons at their own computers, drawn where they say they are. */
export function Humans({ humans }: { humans: HumanView[] }) {
  // The places go to the frame loop; only what changes how somebody looks redraws them.
  const now = performance.now();
  const here = new Set<string>();
  for (const h of humans) {
    here.add(h.id);
    const r = reports.get(h.id);
    if (!r || r.x !== h.x || r.z !== h.z || r.rot !== h.rot || r.moving !== h.moving || r.at !== h.at) reports.set(h.id, { x: h.x, z: h.z, rot: h.rot, moving: h.moving, at: h.at, seen: now });
  }
  for (const id of reports.keys()) if (!here.has(id)) reports.delete(id);
  return (
    <>
      {humans.map((h) => (
        <Human key={h.id} h={h} />
      ))}
    </>
  );
}
