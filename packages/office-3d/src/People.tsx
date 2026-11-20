import { Html } from '@react-three/drei';
import { crackAt, sentBack, type Told } from './whip-back.ts';
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Character, type PoseName } from './Character.tsx';
import { Lineup } from './character/Lineup.tsx';
import type { PersonView, WalkRequest } from './types.ts';
import { deskSeat, type World } from './world.ts';
import { MoveBox, PACKED, Thing } from './MoveBox.tsx';

interface Dest {
  key: string;
  x: number;
  z: number;
  rot: number;
  sit: boolean;
  place: 'desk' | 'meeting' | 'break' | 'visit' | 'lobby' | 'board' | 'pack';
  /** Sent back with the whip: at a run. */
  run?: boolean;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Seated pose for a real activity state. Nothing here can show work that is not happening. */
function seatedPose(v: PersonView, place: Dest['place']): PoseName {
  if (!v.live) return 'offline';
  if (place === 'meeting') return 'talking';
  if (place === 'break') return 'idle';
  switch (v.activity) {
    case 'coding':
    case 'debugging':
    case 'running_command':
      return 'typing';
    case 'reading':
    case 'researching':
    case 'reviewing':
      return 'reading';
    case 'testing':
    case 'delegating':
    // Their turn is over and a command of theirs runs on: they watch it.
    case 'waiting_command':
      return 'watching';
    case 'thinking':
      return 'thinking';
    case 'planning':
      return 'planning';
    case 'waiting_answer':
    case 'needs_approval':
      return 'raiseHand';
    case 'blocked':
      return 'blocked';
    case 'task_complete':
      return 'celebrate';
    case 'idle':
      return 'idle';
    case 'meeting':
      return 'talking';
    case 'offline':
      return 'offline';
    // waiting_input, paused, unknown: sitting still. We do not act out a state we cannot see.
    default:
      return 'still';
  }
}

const STATE_CLASS: Record<string, string> = {
  coding: 'work',
  debugging: 'work',
  running_command: 'work',
  testing: 'work',
  reading: 'work',
  researching: 'work',
  reviewing: 'work',
  planning: 'work',
  thinking: 'work',
  delegating: 'work',
  waiting_answer: 'ask',
  needs_approval: 'ask',
  blocked: 'bad',
  task_complete: 'good',
  idle: 'idle',
  waiting_input: 'wait',
  waiting_command: 'cmd',
  paused: 'wait',
  unknown: 'unknown',
  offline: 'off',
  meeting: 'work',
};

const ICON = { question: '?', approval: '?', blocked: '!', done: '✓' } as const;

/** How long someone has to be thinking or reading (on a planning task) before they get up and walk to the board. */
const BOARD_DWELL_MS = 3000;

const OUCH = ['JAO!', 'AU!', 'JOJ!', 'AJOJ!', 'OPA!', 'EJ!'];

/**
 * How employees get about: a brisk walk (units per second), reached and left over a step or so (units per second
 * squared), turning toward where they are going at up to this many radians per second.
 */
const WALK_SPEED = 1.9;
/** Sent back to the desk with the whip. */
const RUN_SPEED = 4.6;
const WALK_ACCEL = 5.5;
const WALK_TURN = 5.5;

/** Turn `r.rot` toward `want`, eased and no faster than a person turns; returns what is left of the turn. */
function turnToward(r: { rot: number }, want: number, dt: number): number {
  let diff = want - r.rot;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const by = THREE.MathUtils.clamp(diff * (1 - Math.exp(-dt * 9)), -WALK_TURN * dt, WALK_TURN * dt);
  r.rot += by;
  return Math.abs(diff - by);
}

// One person is gone through again only when something about that person changed, not whenever anyone's did.
const Person = memo(function Person({
  v,
  whippedAt,
  world,
  dest,
  player,
  selected,
  cutaway,
  hideLabels,
  onSelect,
  onContext,
  positions,
}: {
  v: PersonView;
  whippedAt: number;
  world: World;
  dest: Dest;
  player: THREE.Vector3;
  selected: boolean;
  cutaway: boolean;
  hideLabels: boolean;
  onSelect: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
  positions: Map<string, THREE.Vector3>;
}) {
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const rt = useRef({ x: dest.x, z: dest.z, rot: dest.rot, v: 0, path: [] as Array<[number, number]>, key: dest.key, tx: dest.x, tz: dest.z, trot: dest.rot, arrived: true });
  const [moving, setMoving] = useState(false);
  const [far, setFar] = useState(false);
  const look = useRef(0);
  const tag = useRef<HTMLDivElement>(null);
  const phase = useMemo(() => (hash(v.id) % 628) / 100, [v.id]);
  const frame = useRef(0);
  /** How much of this person is drawn: 0 everything, 1 without the smallest parts, 2 from far away. */
  const detail = useRef(0);
  /** So that not everyone is looked at in the same frame. */
  const detailTurn = useRef(Math.floor(Math.random() * 12));
  // HTML overlays mounted in the scene's very first commit sometimes never appear (a name tag that is
  // simply missing); they are added once this person has been drawn.
  const [drawn, setDrawn] = useState(false);
  // Gone from the office (let go, or their member left): nothing is left standing where they were — a mark over their head would hang in the air.
  useEffect(() => {
    // (For the UI tests: how many times this person was put into the scene — once, unless they left it and came back.)
    const probe = ((window as any).__orchScene ??= {});
    (probe.personMounts ??= {})[v.id] = (probe.personMounts[v.id] ?? 0) + 1;
    return () => void positions.delete(v.id);
  }, [v.id, positions]);
  // Whipped: flinch for a moment, then carry on exactly as before.
  const [ouch, setOuch] = useState<string | null>(null);
  useEffect(() => {
    if (!whippedAt || Date.now() - whippedAt > 1500) return;
    // `whippedAt` is when the crack lands (a moment after the swing starts): flinch then, not before.
    const lands = Math.max(0, whippedAt - Date.now());
    const t1 = window.setTimeout(() => setOuch(OUCH[Math.floor(Math.random() * OUCH.length)]!), lands);
    const t2 = window.setTimeout(() => setOuch(null), lands + 950);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [whippedAt]);

  // Moved to another machine (`docs/MOVE.md`): their desk goes into a box while it is under way (the share over their
  // head); when it is done the box shows 100 % and they carry it to their new place, and put it down when they sit.
  const packing = !!v.moving && v.moving.phase !== 'failed';
  const packedAt = useRef<string | null>(null);
  const [carrying, setCarrying] = useState(false);
  const [arrived100, setArrived100] = useState(false);
  /** At 100 %: a moment at the desk while the box is closed, before they pick it up and go. */
  const [closing, setClosing] = useState(false);
  const closingUntil = useRef(0);
  const [closeTick, setCloseTick] = useState(0);
  // The share shown counts up to what has been done rather than jumping there (a small folder goes in a blink).
  const [shownPct, setShownPct] = useState(0);
  const targetPct = v.moving && v.moving.phase !== 'failed' ? v.moving.percent : 0;
  useEffect(() => {
    if (!v.moving || v.moving.phase === 'failed') {
      setShownPct(0);
      return;
    }
    const t = window.setInterval(() => setShownPct((p) => (p >= targetPct ? targetPct : Math.min(targetPct, p + 3))), 90);
    return () => window.clearInterval(t);
  }, [targetPct, v.moving]);
  useEffect(() => {
    if (packing) {
      if (packedAt.current === null) packedAt.current = v.deskId ?? '';
      return;
    }
    if (packedAt.current === null) return;
    const from = packedAt.current;
    packedAt.current = null;
    if (v.moving?.phase === 'failed') return;
    // Done: 100 %, the box closed at the desk, and off with it — to a new desk, or (the same desk on another machine of the office) only a moment.
    setArrived100(true);
    setCarrying(true);
    setClosing(true);
    closingUntil.current = Date.now() + 1400;
    window.setTimeout(() => {
      setClosing(false);
      setCloseTick((n) => n + 1);
    }, 1450);
    if ((v.deskId ?? '') === from) {
      const t = window.setTimeout(() => {
        setCarrying(false);
        setArrived100(false);
      }, 2500);
      return () => window.clearTimeout(t);
    }
  }, [packing, v.moving?.phase, v.deskId]);
  useEffect(() => {
    // Sat down at the new place: the box is put away.
    if (carrying && !moving && !packing && rt.current.arrived && rt.current.key === dest.key) {
      const t = window.setTimeout(() => {
        setCarrying(false);
        setArrived100(false);
      }, 600);
      return () => window.clearTimeout(t);
    }
  }, [carrying, moving, packing, dest.key]);

  useEffect(() => {
    const r = rt.current;
    // (The box is being closed: they set off when it is.)
    if (Date.now() < closingUntil.current) return;
    // A new place to be — or the same place moved (the owner rearranged the desks): walk there.
    if (r.key === dest.key && Math.abs(r.tx - dest.x) < 1e-3 && Math.abs(r.tz - dest.z) < 1e-3) return;
    r.key = dest.key;
    r.tx = dest.x;
    r.tz = dest.z;
    r.trot = dest.rot;
    r.path = world.nav.path(r.x, r.z, dest.x, dest.z);
    r.arrived = false;
    setMoving(true);
  }, [dest.key, dest.x, dest.z, world, closeTick]);

  useFrame((_s, rawDt) => {
    const r = rt.current;
    const g = group.current;
    if (!g) return;
    if (!r.arrived) {
      const dt = Math.min(rawDt, 0.05);
      if (!r.path.length) {
        // There: turn to face the way this place is used before sitting down (or standing) at it. (The place this walk
        // was to — not a newer one they have not set off for yet: they are not put there.)
        r.x = r.tx;
        r.z = r.tz;
        r.v = 0;
        if (turnToward(r, r.trot, dt) < 0.04) {
          r.arrived = true;
          r.rot = r.trot;
          setMoving(false);
        }
      } else {
        // Up to pace over the first step, and down again over the last one before the place they are going to.
        const p0 = r.path[0]!;
        const p1 = r.path[1];
        const left = r.path.length > 2 ? Infinity : Math.hypot(p0[0] - r.x, p0[1] - r.z) + (p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) : 0);
        const top = dest.run ? RUN_SPEED : WALK_SPEED;
        r.v = Math.min(top, Math.sqrt(2 * WALK_ACCEL * (dest.run ? 2.5 : 1) * left) + 0.3, r.v + WALK_ACCEL * (dest.run ? 2.5 : 1) * dt);
        let step = r.v * dt;
        while (step > 0 && r.path.length) {
          const next = r.path[0]!;
          const dx = next[0] - r.x;
          const dz = next[1] - r.z;
          const d = Math.hypot(dx, dz);
          if (d <= step) {
            // Past a corner of the route without losing the rest of this frame's step.
            r.x = next[0];
            r.z = next[1];
            r.path.shift();
            step -= d;
          } else {
            r.x += (dx / d) * step;
            r.z += (dz / d) * step;
            turnToward(r, Math.atan2(dx, dz), dt);
            step = 0;
          }
        }
      }
    }
    g.position.set(r.x, 0, r.z);
    g.rotation.y = r.rot;
    let p = positions.get(v.id);
    if (!p) positions.set(v.id, (p = new THREE.Vector3()));
    p.set(r.x, 0, r.z);
    // Someone who needs the boss looks toward the boss.
    if (v.attention === 'question' || v.attention === 'approval') {
      let a = Math.atan2(player.x - r.x, player.z - r.z) - r.rot;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      look.current += (THREE.MathUtils.clamp(a, -1.1, 1.1) - look.current) * Math.min(1, rawDt * 4);
    } else look.current *= 0.9;
    frame.current++;
    if (!drawn) setDrawn(true);
    if (frame.current % 3 === 0 && tag.current) {
      // Tags shrink with distance but never balloon when the owner stands right next to someone.
      // They are never switched off by distance: a name is how the owner finds someone across the floor.
      const d = camera.position.distanceTo(g.position);
      tag.current.style.transform = `translateY(-50%) scale(${THREE.MathUtils.clamp((cutaway ? 15 : 9) / d, 0.42, 1.1).toFixed(3)})`;
    }
    // From across the office the smallest parts of a person (eyes, cuffs, buttons) are thinner than a pixel, and their
    // shadows smaller still. They are left out there: in a full office people are two thirds of everything drawn, and
    // every part drawn costs the same whether it can be seen or not. Closer than a few desks, everything is back.
    if (frame.current % 12 === detailTurn.current && g) {
      const d = camera.position.distanceTo(g.position);
      const was = detail.current;
      const tier = was === 0 ? (d > 16 ? 1 : 0) : was === 1 ? (d < 14 ? 0 : d > 30 ? 2 : 1) : d < 27 ? 1 : 2;
      // Applied again every time even when the tier has not changed: a change of clothes brings new parts.
      detail.current = tier;
      const hideBelow = tier === 0 ? 0 : tier === 1 ? 0.045 : 0.062;
      const shadowFrom = tier === 0 ? 0 : tier === 1 ? 0.12 : 0.25;
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const size = m.geometry.boundingSphere?.radius ?? 1;
        if (m.userData.casts === undefined) m.userData.casts = m.castShadow;
        // Hidden by layer, not by `visible`: whether a part is shown at all stays the character's own business.
        const hide = size < hideBelow;
        if (hide !== (m.userData.left === true)) {
          m.userData.left = hide;
          m.layers.set(hide ? 1 : 0);
        }
        const casts = m.userData.casts === true && size >= shadowFrom;
        if (m.castShadow !== casts) m.castShadow = casts;
      });
    }
    if (frame.current % 30 === 0) {
      const limit = cutaway ? 95 : 38;
      const isFar = camera.position.distanceToSquared(g.position) > limit * limit;
      if (isFar !== far) setFar(isFar);
    }
    // Before the character animates (see `motion` in Character.tsx): its feet are then placed for this frame's position.
  }, -1);

  // No session and no desk to sleep at: dozing on their feet.
  // (Packing their desk: busy with the hands at it, whatever the session is doing — it is stopped meanwhile.)
  const atBox = packing && !carrying && !moving && dest.place === 'pack';
  const usual: PoseName = moving ? 'walk' : dest.sit ? seatedPose(v, dest.place) : v.live || carrying || packing ? 'stand' : 'doze';
  const pose: PoseName = ouch && !moving ? 'ouch' : usual;
  const cls = STATE_CLASS[v.activity] ?? 'unknown';
  const labelY = moving || !dest.sit ? 1.95 : 1.62;

  return (
    <group ref={group} position={[dest.x, 0, dest.z]} rotation={[0, dest.rot, 0]}>
      <group
        onClick={(e) => {
          e.stopPropagation();
          onSelect(v.id);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          e.nativeEvent.preventDefault();
          onContext(v.id, e.nativeEvent.clientX, e.nativeEvent.clientY);
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <Character appearance={v.appearance} pose={pose} cue={whippedAt} offline={!v.live && !packing && !carrying} look={look} level={v.level} phase={phase} frozen={() => far} carrying={carrying && !closing && (moving || !dest.sit)} packing={atBox} />
      </group>
      {(atBox || (carrying && (closing || moving || !dest.sit))) && (
        // One box: on the desk in front of them, open and filling, then closed there; then in both hands in front of the chest.
        <group position={atBox || closing ? PACK_BOX : [0, 0.86, 0.36]}>
          <MoveBox fill={carrying ? 1 : shownPct / 100} closed={carrying} name={v.name} />
        </group>
      )}
      {atBox &&
        // What is still to go in, beside the box to their right.
        PACKED.map((p, i) =>
          shownPct / 100 < p.at ? (
            <group key={p.kind} position={PACK_THINGS[i]}>
              <Thing kind={p.kind} />
            </group>
          ) : null,
        )}
      {drawn && (packing || arrived100) && !hideLabels && (
        <Html position={[0, labelY, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
          <div className="move-wrap" data-move-badge={v.id}>
            <div className={`move-badge ${arrived100 ? 'move-badge-done' : ''}`}>
              <span className="move-badge-box">📦</span>
              {arrived100 ? '100' : shownPct}
              <span className="move-badge-pct">%</span>
            </div>
          </div>
        </Html>
      )}
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.5, 0.58, 40]} />
          <meshBasicMaterial color="#6ea8ff" transparent opacity={0.9} toneMapped={false} />
        </mesh>
      )}
      {ouch && (
        <Html position={[0, labelY, 0]} center zIndexRange={[45, 0]} style={{ pointerEvents: 'none' }}>
          {/* Lifted clear of the name tag, which sits just above this point. */}
          <div className="ouch-wrap">
            <div className="ouch-bubble">{ouch}</div>
          </div>
        </Html>
      )}
      {drawn && (
        <Html position={[0, labelY, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none', display: hideLabels ? 'none' : 'block' }}>
          <div ref={tag} className={`tag tag-${cls} ${v.dimmed ? 'tag-dim' : ''} ${selected ? 'tag-selected' : ''}`}>
            {v.attention && <div className={`tag-icon tag-icon-${v.attention}`}>{ICON[v.attention]}</div>}
            <div className="tag-name">
              {v.name}
              {v.controlled && <span className="tag-ctl">YOU</span>}
            </div>
            <div className="tag-state">{v.label}</div>
            {v.goal && (
              <div className="tag-goal" title={`Goal: ${v.goal}`}>
                🎯 {v.goal}
              </div>
            )}
            {v.background && (
              <div className="tag-bg" title={v.background.what}>
                ⏳ {v.background.count > 1 ? `${v.background.count} commands running` : v.background.what}
              </div>
            )}
            {v.taskKey && (
              <div className="tag-task">
                {v.taskKey}
                {v.progress != null && (
                  <span className="tag-bar">
                    <i style={{ width: `${v.progress}%` }} />
                  </span>
                )}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
});

/**
 * All employees in the office. Where an avatar is and how it moves is a
 * visualisation of recorded state: a seat at their desk, a chair in a real
 * meeting, the project board while thinking through a planning task, the break
 * room when genuinely idle, or a walk to a colleague's desk when a real
 * collaboration request was sent.
 */
/** Height of a desk top (`DESK_SIZE.h`). */
const DESK_TOP = 0.74;
/** Where someone stands to pack their desk (`docs/MOVE.md`), in their seat's frame: beside the chair, at the desk's front edge. */
const PACK_SPOT = { x: 0.5, z: 0.02 };
/** The box on the desk in front of them, and the things still to go in beside it (to their right), in their own frame. */
const PACK_BOX: [number, number, number] = [0.02, DESK_TOP, 0.56];
const PACK_THINGS: Array<[number, number, number]> = [
  [-0.36, DESK_TOP, 0.5],
  [-0.5, DESK_TOP, 0.66],
  [-0.3, DESK_TOP, 0.72],
  [-0.46, DESK_TOP, 0.42],
  [-0.22, DESK_TOP, 0.6],
];

export function People({
  people,
  whips,
  world,
  walks,
  player,
  selectedId,
  cutaway,
  hideLabels,
  onSelect,
  onContext,
  positions,
}: {
  people: PersonView[];
  /** Who the owner last cracked the whip at, and when (ms). A visual gag: nothing about their work changes. */
  whips: Record<string, number>;
  world: World;
  walks: WalkRequest[];
  player: THREE.Vector3;
  selectedId: string | null;
  cutaway: boolean;
  /** Sitting at a workstation: the terminal has the owner's attention, not the tags. */
  hideLabels: boolean;
  onSelect: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
  positions: Map<string, THREE.Vector3>;
}) {
  // Re-evaluate idle time (for break-room visits) on a slow clock, not every frame.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  // Who is eligible to stand at the project board, and since when: a short spell of thinking between
  // two commands should not send anyone across the floor and straight back.
  const boardSince = useRef(new Map<string, number>()).current;
  const [boardTick, setBoardTick] = useState(0);
  useEffect(() => {
    const t = Date.now();
    let waiting = false;
    for (const v of people) {
      if (!v.atBoard) boardSince.delete(v.id);
      else if (!boardSince.has(v.id)) boardSince.set(v.id, t);
      if (v.atBoard && t - boardSince.get(v.id)! < BOARD_DWELL_MS) waiting = true;
    }
    for (const id of [...boardSince.keys()]) if (!people.some((v) => v.id === id)) boardSince.delete(id);
    if (!waiting) return;
    const timer = window.setTimeout(() => setBoardTick((n) => n + 1), BOARD_DWELL_MS + 50);
    return () => window.clearTimeout(timer);
  }, [people, boardSince, boardTick]);

  // Whipped while away from their chair: after one crack, or two, or three (`whip-back.ts`), they run back and stay.
  const told = useRef(new Map<string, Told>()).current;
  const counted = useRef(new Map<string, number>()).current;
  const awayRef = useRef(new Map<string, boolean>());
  const [backTick, setBackTick] = useState(0);
  useEffect(() => {
    let changed = false;
    for (const [id, at] of Object.entries(whips)) {
      if (!at || counted.get(id) === at) continue;
      counted.set(id, at);
      // Only somebody who is away: at their desk a crack is a crack. (A meeting is work: nobody is whipped out of one.)
      if (!awayRef.current.get(id)) continue;
      told.set(id, crackAt(told.get(id), id, at));
      changed = true;
    }
    if (changed) setBackTick((n) => n + 1);
  }, [whips, told, counted]);

  const dests = useMemo(() => {
    const desks = new Map(world.layout.desks.map((d) => [d.id, d]));
    const out = new Map<string, Dest>();
    let lobby = 0;
    const breakTaken = new Set<number>();
    let boardTaken = 0;
    const t = Date.now();
    for (const v of people) {
      const desk = v.deskId ? desks.get(v.deskId) : undefined;
      const home: Dest = desk
        ? { ...deskSeat(desk), sit: true, place: 'desk', key: `desk:${desk.id}` }
        : { x: world.spawn.x - 3 + (lobby % 6) * 1.1, z: world.spawn.z - 3 - Math.floor(lobby++ / 6), rot: 0, sit: false, place: 'lobby', key: `lobby:${lobby}` };
      let dest = home;
      // Being moved to another machine: up from the chair, packing at the desk beside it (`docs/MOVE.md`).
      if (desk && v.moving && v.moving.phase !== 'failed') {
        const seat = deskSeat(desk);
        const c = Math.cos(seat.rot);
        const sn = Math.sin(seat.rot);
        dest = { x: seat.x + PACK_SPOT.x * c + PACK_SPOT.z * sn, z: seat.z - PACK_SPOT.x * sn + PACK_SPOT.z * c, rot: seat.rot, sit: false, place: 'pack', key: `pack:${desk.id}` };
        out.set(v.id, dest);
        awayRef.current.set(v.id, false);
        continue;
      }
      const walk = walks.find((w) => w.fromId === v.id);
      const target = walk ? people.find((p) => p.id === walk.toId) : undefined;
      const targetDesk = target?.deskId ? desks.get(target.deskId) : undefined;
      if (walk && targetDesk) {
        // Stand beside the colleague's chair, facing them.
        const seat = deskSeat(targetDesk);
        const side = { x: seat.x + Math.cos(seat.rot) * 0.95 - Math.sin(seat.rot) * 0.35, z: seat.z - Math.sin(seat.rot) * 0.95 - Math.cos(seat.rot) * 0.35 };
        dest = { x: side.x, z: side.z, rot: Math.atan2(seat.x - side.x, seat.z - side.z), sit: false, place: 'visit', key: `visit:${walk.id}` };
      } else if (v.meetingSeat != null && world.meeting) {
        const seat = world.meeting.seats[v.meetingSeat % world.meeting.seats.length]!;
        dest = { ...seat, place: 'meeting', key: `meeting:${v.meetingSeat}` };
      } else if (v.atBoard && boardTaken < world.boardSpots.length && t - (boardSince.get(v.id) ?? t) >= BOARD_DWELL_MS) {
        // Planning, and thinking or reading rather than typing: standing at the project board, facing it.
        // Spots are handed out centre first, so several planners stand side by side.
        const i = boardTaken++;
        dest = { ...world.boardSpots[i]!, place: 'board', key: `board:${i}` };
      } else if (v.live && v.activity === 'idle' && v.idleSince && world.breakSpots.length) {
        // Genuinely idle for a while → a visit to the break room (staggered so the floor never empties at once).
        const h = hash(v.id);
        const wait = 70_000 + (h % 60) * 1000;
        if (now - v.idleSince > wait && (h % 5) < 3) {
          let i = h % world.breakSpots.length;
          for (let n = 0; n < world.breakSpots.length && breakTaken.has(i); n++) i = (i + 1) % world.breakSpots.length;
          if (!breakTaken.has(i)) {
            breakTaken.add(i);
            dest = { ...world.breakSpots[i]!, place: 'break', key: `break:${i}` };
          }
        }
      }
      // Away from the chair for something that can wait — a break, the board, a word with a colleague.
      const away = !!desk && dest !== home && dest.place !== 'meeting';
      awayRef.current.set(v.id, away || (sentBack(told.get(v.id), t) && !!desk));
      if (away && sentBack(told.get(v.id), t)) dest = { ...home, run: true };
      out.set(v.id, dest);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, world, walks, now, boardTick, backTick]);

  // For the UI tests (see `window.__orchScene`): where each person is meant to be, and where they are right now.
  useEffect(() => {
    const probe = ((window as any).__orchScene ??= { detail: {} });
    probe.places = Object.fromEntries([...dests].map(([id, d]) => [id, d.place]));
    probe.where = (id: string) => {
      const p = positions.get(id);
      return p ? { x: p.x, z: p.z } : null;
    };
    probe.boardSpots = world.boardSpots.map((s) => ({ x: s.x, z: s.z }));
  }, [dests, positions, world]);

  return (
    <group>
      {people.map((v) => (
        <Person key={v.id} v={v} whippedAt={whips[v.id] ?? 0} world={world} dest={dests.get(v.id)!} player={player} selected={selectedId === v.id} cutaway={cutaway} hideLabels={hideLabels} onSelect={onSelect} onContext={onContext} positions={positions} />
      ))}
      <Lineup />
    </group>
  );
}
