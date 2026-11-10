import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Character, type PoseName } from './Character.tsx';
import type { ForemanView, PersonView } from './types.ts';
import { foremanStopAt, foremanStops } from './foreman-route.ts';
import type { World } from './world.ts';

/** An unhurried walk from desk to desk: slower than someone going to a colleague's desk. */
const SPEED = 1.25;
/** Called to someone during a round, it does not dawdle. */
const VISIT_SPEED = 2.0;
/** Having reached a desk on its walk, it stands there at least this long before going on, however late it is. */
const MIN_STAND_MS = 6000;

/**
 * The foreman: no desk and no chair. While a round runs it stands with whoever it is looking at, answering or
 * giving work to; between rounds it walks the office desk by desk — the shared floor and the members' rooms that
 * are open — pausing at each. With rounds switched off it waits by the entrance.
 */
export function Foreman({
  foreman,
  people,
  world,
  selected,
  cutaway,
  hideLabels,
  onSelect,
  onContext,
  positions,
}: {
  foreman: ForemanView;
  people: PersonView[];
  world: World;
  selected: boolean;
  cutaway: boolean;
  hideLabels: boolean;
  onSelect: (id: string | null) => void;
  onContext: (id: string, x: number, y: number) => void;
  positions: Map<string, THREE.Vector3>;
}) {
  const group = useRef<THREE.Group>(null);
  const tag = useRef<HTMLDivElement>(null);
  const { camera } = useThree();
  const seatedKey = people.map((p) => `${p.id}:${p.deskId ?? ''}`).join('|');
  const stops = useMemo(() => foremanStops(world, people), [world, seatedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const home = useMemo(() => {
    const [x, z] = world.nav.nearestWalkable(world.spawn.x + 1.8, world.spawn.z - 1.4) ?? [world.spawn.x, world.spawn.z];
    return { x, z, rot: world.spawn.rot };
  }, [world]);

  /** Where it should be right now, and a key that changes exactly when that place does. */
  const want = (now: number): { key: string; x: number; z: number; rot: number } => {
    const visit = foreman.visitingId ? stops.find((s) => s.id === foreman.visitingId) : undefined;
    if (visit) return { key: `visit:${visit.id}`, ...visit };
    const i = foreman.patrolling ? foremanStopAt(stops.length, now) : -1;
    const stop = i >= 0 ? stops[i]! : undefined;
    return stop ? { key: `stop:${stop.id}`, x: stop.x, z: stop.z, rot: stop.rot } : { key: 'home', ...home };
  };

  const first = useMemo(() => want(Date.now()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const rt = useRef({ x: first.x, z: first.z, rot: first.rot, key: first.key, tx: first.x, tz: first.z, trot: first.rot, path: [] as Array<[number, number]>, arrived: true, arrivedAt: 0, frame: 0 });
  const [moving, setMoving] = useState(false);
  // An HTML overlay mounted in the scene's very first commit sometimes never appears: added once the character is drawn.
  const [drawn, setDrawn] = useState(false);

  // For the UI tests (see `window.__orchScene`): where the foreman is meant to be and where it is.
  useEffect(() => {
    const probe = ((window as unknown as { __orchScene?: Record<string, unknown> }).__orchScene ??= { detail: {} });
    probe.foreman = () => ({ id: foreman.id, stops: stops.map((s) => s.id), key: rt.current.key, x: rt.current.x, z: rt.current.z, arrived: rt.current.arrived, visitingId: foreman.visitingId, patrolling: foreman.patrolling });
    return () => {
      delete probe.foreman;
    };
  }, [foreman.id, foreman.visitingId, foreman.patrolling, stops]);

  useFrame((_s, dt) => {
    const g = group.current;
    const r = rt.current;
    if (!g) return;
    // Where to be is looked at a few times a second: it changes when a visit starts or ends, or when it is time for the next desk.
    if (r.frame++ % 20 === 0) {
      const now = Date.now();
      const w = want(now);
      const moved = w.key === r.key && (Math.abs(w.x - r.tx) > 1e-3 || Math.abs(w.z - r.tz) > 1e-3);
      // On its walk it finishes the way to a desk and stands there a moment before going on to the one it is time
      // for (on a slow computer it may skip a desk; it never turns round half-way or walks without ever stopping).
      // Only someone it is called to — a visit during a round — is gone to at once.
      const settled = r.arrived && now - r.arrivedAt >= MIN_STAND_MS;
      if (moved || (w.key !== r.key && (w.key.startsWith('visit:') || settled))) {
        r.key = w.key;
        r.tx = w.x;
        r.tz = w.z;
        r.trot = w.rot;
        r.path = world.nav.path(r.x, r.z, w.x, w.z);
        r.arrived = false;
        if (!moving) setMoving(true);
      }
    }
    if (!r.arrived) {
      const next = r.path[0];
      if (!next) {
        r.arrived = true;
        r.arrivedAt = Date.now();
        r.x = r.tx;
        r.z = r.tz;
        if (moving) setMoving(false);
      } else {
        const dx = next[0] - r.x;
        const dz = next[1] - r.z;
        const d = Math.hypot(dx, dz);
        const step = (r.key.startsWith('visit:') ? VISIT_SPEED : SPEED) * Math.min(dt, 0.1);
        if (d <= step) {
          r.x = next[0];
          r.z = next[1];
          r.path.shift();
        } else {
          r.x += (dx / d) * step;
          r.z += (dz / d) * step;
          let diff = Math.atan2(dx, dz) - r.rot;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          r.rot += diff * Math.min(1, dt * 8);
        }
      }
    } else {
      // Standing: turned towards whoever it stopped at.
      let diff = r.trot - r.rot;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      r.rot += diff * Math.min(1, dt * 5);
    }
    g.position.set(r.x, 0, r.z);
    g.rotation.y = r.rot;
    let p = positions.get(foreman.id);
    if (!p) positions.set(foreman.id, (p = new THREE.Vector3()));
    p.set(r.x, 0, r.z);
    if (!drawn) setDrawn(true);
    if (r.frame % 3 === 0 && tag.current) {
      const d = camera.position.distanceTo(g.position);
      tag.current.style.transform = `translateY(-50%) scale(${THREE.MathUtils.clamp((cutaway ? 15 : 9) / d, 0.42, 1.1).toFixed(3)})`;
    }
  });
  useEffect(() => () => void positions.delete(foreman.id), [foreman.id, positions]);

  const pose: PoseName = moving ? 'walk' : 'stand';
  return (
    <group ref={group} position={[first.x, 0, first.z]} rotation={[0, first.rot, 0]}>
      <group
        onClick={(e) => {
          e.stopPropagation();
          onSelect(foreman.id);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          e.nativeEvent.preventDefault();
          onContext(foreman.id, e.nativeEvent.clientX, e.nativeEvent.clientY);
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <Character appearance={foreman.appearance} pose={pose} offline={!foreman.live && !foreman.patrolling} level={foreman.level} />
      </group>
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.5, 0.58, 40]} />
          <meshBasicMaterial color="#6ea8ff" transparent opacity={0.9} toneMapped={false} />
        </mesh>
      )}
      {drawn && (
        <Html position={[0, 1.95, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none', display: hideLabels ? 'none' : 'block' }}>
          <div ref={tag} className={`tag tag-foreman ${foreman.dimmed ? 'tag-dim' : ''} ${selected ? 'tag-selected' : ''}`}>
            <div className="tag-name">{foreman.name}</div>
            <div className="tag-state">FOREMAN · {foreman.space}</div>
            <div className="tag-task tag-foreman-doing">{foreman.doing}</div>
          </div>
        </Html>
      )}
    </group>
  );
}
