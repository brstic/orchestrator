import { wallFixtures, type Box, type Wall, type World } from '../world.ts';

/** A window is at least this long; a shorter clear stretch of wall stays wall. */
const SHORTEST = 1.6;
/** Wall left standing at each end of a wall, and beside whatever a window must not be behind. */
const PIER = 0.45;
/** How far into the room something may stand from the wall and still count as "against it". */
const REACH = 0.8;

/**
 * The building's walls with windows in the outer ones — for an office that stands somewhere worth looking at.
 *
 * A stretch of outer wall becomes glass where nothing is on it or against it: no board, screen or sign, no rack or
 * counter, no inner wall meeting it, no member's room on its other side. Everything else stays as it was, and so
 * does the world itself: this is only what is drawn (a glass wall is as solid to walk into as any other).
 */
export function glazed(world: World): Wall[] {
  const blockers: Box[] = [...wallFixtures(world), ...world.solids, ...world.memberRooms.map((r) => ({ minX: r.x, maxX: r.x + r.w, minZ: r.z, maxZ: r.z + r.d }))];
  const out: Wall[] = [];
  for (const w of world.walls) {
    if (!w.outer || w.glass) {
      out.push(w);
      continue;
    }
    const alongX = Math.abs(w.z2 - w.z1) < 1e-6;
    const fixed = alongX ? w.z1 : w.x1;
    const from = alongX ? Math.min(w.x1, w.x2) : Math.min(w.z1, w.z2);
    const to = alongX ? Math.max(w.x1, w.x2) : Math.max(w.z1, w.z2);
    // The strip on both sides of the wall in which anything counts: furniture inside, a member's room outside.
    const lo = fixed - REACH;
    const hi = fixed + REACH;
    const blocked: Array<[number, number]> = [];
    for (const box of blockers) {
      const [pMin, pMax, aMin, aMax] = alongX ? [box.minZ, box.maxZ, box.minX, box.maxX] : [box.minX, box.maxX, box.minZ, box.maxZ];
      if (pMax < lo || pMin > hi) continue;
      blocked.push([aMin - PIER / 2, aMax + PIER / 2]);
    }
    // An inner wall that ends on this one: its end is not shown through glass.
    for (const o of world.walls) {
      if (o === w || o.outer) continue;
      const oAlongX = Math.abs(o.z2 - o.z1) < 1e-6;
      if (oAlongX === alongX) continue;
      const [oFixed, oFrom, oTo] = oAlongX ? [o.z1, Math.min(o.x1, o.x2), Math.max(o.x1, o.x2)] : [o.x1, Math.min(o.z1, o.z2), Math.max(o.z1, o.z2)];
      if (oFrom - 0.3 <= fixed && oTo + 0.3 >= fixed) blocked.push([oFixed - PIER, oFixed + PIER]);
    }
    blocked.sort((p, q) => p[0] - q[0]);
    const clear: Array<[number, number]> = [];
    let cursor = from + PIER;
    const end = to - PIER;
    for (const [a, z] of blocked) {
      if (a > cursor) clear.push([cursor, Math.min(a, end)]);
      cursor = Math.max(cursor, z);
      if (cursor >= end) break;
    }
    if (cursor < end) clear.push([cursor, end]);
    const windows = clear.filter(([a, z]) => z - a >= SHORTEST);
    if (!windows.length) {
      out.push(w);
      continue;
    }
    const piece = (a: number, z: number, glass: boolean): Wall => (alongX ? { x1: a, z1: fixed, x2: z, z2: fixed, glass, outer: true } : { x1: fixed, z1: a, x2: fixed, z2: z, glass, outer: true });
    let at = from;
    for (const [a, z] of windows) {
      if (a - at > 1e-6) out.push(piece(at, a, false));
      out.push(piece(a, z, true));
      at = z;
    }
    if (to - at > 1e-6) out.push(piece(at, to, false));
  }
  return out;
}

/**
 * The floor the building and every member's room stand on, with room to walk round them: what a terrace, a deck or
 * a platform is made to the size of. It grows when a member's room reaches further out than the building's own margin.
 */
export function plateOf(world: World): Box {
  const b = world.base.bounds;
  const all = world.bounds;
  const round = (v: number) => Math.round(v * 2) / 2;
  return { minX: round(Math.min(b.minX - 9, all.minX - 3)), maxX: round(Math.max(b.maxX + 9, all.maxX + 3)), minZ: round(Math.min(b.minZ - 9, all.minZ - 3)), maxZ: round(Math.max(b.maxZ + 9, all.maxZ + 3)) };
}
