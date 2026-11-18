/**
 * Out in the city together (docs/CITY.md, "Together").
 *
 * This window's own place out there (`ownerOutside`, written by `Rig.tsx` every frame, sent with the presence) and the
 * others' as they are drawn here this frame (`othersOutside`, written by `Humans.tsx`, read by `Rig.tsx` to get into
 * somebody's car and to go to somebody). The rest is pure: who one could ride with, and where one lands beside someone.
 */
import type { OutsideAt, OutsidePhase } from '@orchestrator/contracts';
import { STREET_Y, blocked, groundAt, type Solid } from './blocks.ts';

/** Where this window's own character is out in the city; null while it is in the office. */
export const ownerOutside: { at: OutsideAt | null } = { at: null };

/** Somebody else out in the city, where they are drawn in this window right now. */
export interface OtherOut {
  name: string;
  phase: OutsidePhase;
  x: number;
  y: number;
  z: number;
  rot: number;
  /** At the wheel: how fast they go (m/s). */
  speed: number;
}
export const othersOutside = new Map<string, OtherOut>();

/** How near a car has to be to get in. The same as for a car of the traffic. */
export const RIDE_REACH = 4.5;

/** Somebody driving near enough to get in with them (the nearest), or null. */
export function rideNear(others: ReadonlyMap<string, OtherOut>, x: number, z: number, reach = RIDE_REACH): { id: string; name: string; d: number } | null {
  let best: { id: string; name: string; d: number } | null = null;
  for (const [id, o] of others) {
    if (o.phase !== 'car') continue;
    const d = Math.hypot(o.x - x, o.z - z);
    if (d < reach && (!best || d < best.d)) best = { id, name: o.name, d };
  }
  return best;
}

/** In somebody's car: the seat beside the driver (to their right). */
export function passengerSeat(driver: Pick<OtherOut, 'x' | 'y' | 'z' | 'rot'>): { x: number; y: number; z: number; rot: number } {
  return { x: driver.x - Math.cos(driver.rot) * 0.45, y: driver.y, z: driver.z + Math.sin(driver.rot) * 0.45, rot: driver.rot };
}

/**
 * Where one comes down to join somebody: in the air beside them, under a parachute of one's own (far enough apart for
 * two canopies), when they are in the air; on foot beside them — where there is room — when they are on the ground.
 */
export function besideOf(t: Pick<OtherOut, 'phase' | 'x' | 'y' | 'z' | 'rot'>, solids: Solid[]): { phase: 'chute' | 'foot'; x: number; y: number; z: number; rot: number } {
  const sx = Math.cos(t.rot);
  const sz = -Math.sin(t.rot);
  if (t.phase === 'fall' || t.phase === 'chute') {
    for (const side of [1, -1]) {
      const x = t.x + sx * 9 * side;
      const z = t.z + sz * 9 * side;
      if (!blocked(solids, x, z, t.y, 0.35, 0)) return { phase: 'chute', x, y: t.y, z, rot: t.rot };
    }
    return { phase: 'chute', x: t.x, y: t.y + 8, z: t.z, rot: t.rot };
  }
  // On the ground (a car stands on the street): beside them, then behind, then in front.
  const fx = Math.sin(t.rot);
  const fz = Math.cos(t.rot);
  const base = t.phase === 'foot' ? t.y : STREET_Y;
  const reach = t.phase === 'foot' ? 1.4 : 2.6;
  for (const [a, b] of [
    [1, 0],
    [-1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const x = t.x + (sx * a + fx * b) * reach;
    const z = t.z + (sz * a + fz * b) * reach;
    if (blocked(solids, x, z, base, 0.35, 0.6)) continue;
    return { phase: 'foot', x, y: Math.max(base, groundAt(solids, x, z, base + 0.5, 0, 0.6)), z, rot: t.rot };
  }
  return { phase: 'foot', x: t.x, y: base, z: t.z, rot: t.rot };
}
