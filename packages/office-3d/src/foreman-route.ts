import { deskSeat, type World } from './world.ts';

/** How long the foreman stands at each desk on its walk through the office before moving on. */
export const FOREMAN_STOP_MS = 16_000;

export interface ForemanStop {
  /** The employee whose desk this is. */
  id: string;
  x: number;
  z: number;
  rot: number;
}

/** Where to stand at a desk: beside the chair, a step back, facing the person. */
function beside(world: World, desk: Parameters<typeof deskSeat>[0]): { x: number; z: number; rot: number } {
  const seat = deskSeat(desk);
  // The other side of the chair from where a visiting colleague stands, so the two never share a spot.
  const bx = seat.x - Math.cos(seat.rot) * 0.95 - Math.sin(seat.rot) * 0.45;
  const bz = seat.z + Math.sin(seat.rot) * 0.95 - Math.cos(seat.rot) * 0.45;
  const [x, z] = world.nav.walkable(bx, bz) ? [bx, bz] : (world.nav.nearestWalkable(bx, bz) ?? [bx, bz]);
  return { x, z, rot: Math.atan2(seat.x - x, seat.z - z) };
}

/**
 * The route of the foreman's walk: everyone who has a desk that can be walked to, in the order the desks stand —
 * the shared floor first, then each member's room. A member's room that is locked (they are away) has no door and
 * is passed by.
 */
export function foremanStops(world: World, seated: Array<{ id: string; deskId: string | null }>): ForemanStop[] {
  const order = new Map(world.layout.desks.map((d, i) => [d.id, i]));
  const desks = new Map(world.layout.desks.map((d) => [d.id, d]));
  const shut = new Set(world.memberRooms.filter((r) => r.locked).flatMap((r) => r.desks));
  const reachable = world.nav.reach(world.spawn.x, world.spawn.z);
  const out: Array<ForemanStop & { n: number }> = [];
  for (const p of seated) {
    const desk = p.deskId ? desks.get(p.deskId) : undefined;
    if (!desk || shut.has(desk.id)) continue;
    const at = beside(world, desk);
    if (!reachable(at.x, at.z)) continue;
    out.push({ id: p.id, ...at, n: order.get(desk.id) ?? 0 });
  }
  return out.sort((a, b) => a.n - b.n).map(({ n: _n, ...s }) => s);
}

/** Which stop of the walk it is time for. The same on every computer looking at the office, since it only depends on the clock. */
export function foremanStopAt(stops: number, now: number): number {
  return stops > 0 ? Math.floor(now / FOREMAN_STOP_MS) % stops : -1;
}
