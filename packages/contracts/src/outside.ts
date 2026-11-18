/**
 * Out in the city together (docs/CITY.md, "Together"): where a person's character is once they have jumped off the
 * office's terrace, as their window reports it with its place (`presence.out`) and the office passes it on to
 * everybody (`PersonPresence.out`). Absent while they are in the office.
 */

export type OutsidePhase = 'fall' | 'chute' | 'foot' | 'car' | 'ride';
export type OutsideCarKind = 'sedan' | 'suv' | 'taxi';

export interface OutsideAt {
  /** Falling, under the parachute, on foot, at the wheel, or riding in somebody else's car. */
  phase: OutsidePhase;
  /** Where, in the same world as the office (the street is 150 m under its floor). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Under the parachute: how far it is open (0–1). */
  chute?: number;
  /** At the wheel: the car's body and paint (0–1 sRGB), how fast it goes (m/s; negative: reversing), the wheels turned (-1…1). */
  car?: { kind: OutsideCarKind; paint: [number, number, number]; speed: number; steer: number };
  /** The car they left standing in the street. */
  parked?: { x: number; z: number; rot: number; kind: OutsideCarKind; paint: [number, number, number] };
  /** Riding: whose car they sit in (that person's window). */
  with?: string;
}

const PHASES: readonly OutsidePhase[] = ['fall', 'chute', 'foot', 'car', 'ride'];
const KINDS: readonly OutsideCarKind[] = ['sedan', 'suv', 'taxi'];
/** How far out a place may be (m): the city has no end, but a window that reports more than this is not believed. */
export const OUTSIDE_REACH = 200_000;

const num = (v: unknown, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const paint = (v: unknown): [number, number, number] => (Array.isArray(v) && v.length === 3 ? [num(v[0], 0, 1), num(v[1], 0, 1), num(v[2], 0, 1)] : [0.5, 0.5, 0.5]);
const kind = (v: unknown): OutsideCarKind => (KINDS.includes(v as OutsideCarKind) ? (v as OutsideCarKind) : 'sedan');

/** What a window said about where its person is outside, made safe to pass on; null for anything that is not that. */
export function cleanOutside(v: unknown): OutsideAt | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!PHASES.includes(o.phase as OutsidePhase)) return null;
  const at: OutsideAt = {
    phase: o.phase as OutsidePhase,
    x: num(o.x, -OUTSIDE_REACH, OUTSIDE_REACH),
    y: num(o.y, -1000, 1000),
    z: num(o.z, -OUTSIDE_REACH, OUTSIDE_REACH),
    rot: num(o.rot, -100, 100),
  };
  if (at.phase === 'chute') at.chute = num(o.chute, 0, 1);
  if (at.phase === 'car' && o.car && typeof o.car === 'object') {
    const c = o.car as Record<string, unknown>;
    at.car = { kind: kind(c.kind), paint: paint(c.paint), speed: num(c.speed, -60, 60), steer: num(c.steer, -1, 1) };
  }
  if (o.parked && typeof o.parked === 'object') {
    const p = o.parked as Record<string, unknown>;
    at.parked = { x: num(p.x, -OUTSIDE_REACH, OUTSIDE_REACH), z: num(p.z, -OUTSIDE_REACH, OUTSIDE_REACH), rot: num(p.rot, -100, 100), kind: kind(p.kind), paint: paint(p.paint) };
  }
  if (at.phase === 'ride' && typeof o.with === 'string' && o.with.length <= 64) at.with = o.with;
  return at;
}

/**
 * How far apart two people are, for what is heard (a voice, a crack of the whip) and what reaches (the whip itself):
 * in the office by where they stand, out in the city by where they are there — and never between the two, so
 * somebody in the street does not hear the office and the office does not hear the street.
 */
export function apart(a: { x: number; z: number; out?: Pick<OutsideAt, 'x' | 'y' | 'z'> | null }, b: { x: number; z: number; out?: Pick<OutsideAt, 'x' | 'y' | 'z'> | null }): number {
  if (!!a.out !== !!b.out) return Infinity;
  if (a.out && b.out) return Math.hypot(a.out.x - b.out.x, a.out.y - b.out.y, a.out.z - b.out.z);
  return Math.hypot(a.x - b.x, a.z - b.z);
}
