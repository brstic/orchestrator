import type { Desk, OfficeLayout, RoomDef } from '@orchestrator/contracts';
import { DECORATION_KINDS, decorationBox, decorationKind, deskSeat } from '@orchestrator/contracts';
import { buildWorld, deskBox, type Box } from './world.ts';

/**
 * Editing the floor plan. Pure functions: each takes the current layout and
 * returns either the changed layout or the reason the change is refused. The
 * rules are the same ones the 3D world is built from (walls, furniture, the
 * navigation grid), so what the editor allows is exactly what can be walked.
 */

export type EditResult = { ok: true; layout: OfficeLayout } | { ok: false; error: string };

const refuse = (error: string): EditResult => ({ ok: false, error });

function overlap(a: Box, b: Box, gap = 0): boolean {
  return a.minX < b.maxX + gap && a.maxX > b.minX - gap && a.minZ < b.maxZ + gap && a.maxZ > b.minZ - gap;
}

function grow(b: Box, by: number): Box {
  return { minX: b.minX - by, maxX: b.maxX + by, minZ: b.minZ - by, maxZ: b.maxZ + by };
}

/** The floor a chair needs behind its desk. */
function seatBox(d: Desk): Box {
  const s = deskSeat(d);
  return { minX: s.x - 0.3, maxX: s.x + 0.3, minZ: s.z - 0.3, maxZ: s.z + 0.3 };
}

/**
 * Everything that is wrong with a layout, one sentence each: desks or decorations standing
 * in walls, furniture or each other, and desks or rooms nobody can walk to. An edit is
 * refused when it adds a sentence to this list — so a floor that already has a problem can
 * still be repaired step by step.
 */
export function layoutProblems(layout: OfficeLayout, unlocked: Set<string>): string[] {
  const out: string[] = [];
  const world = buildWorld(layout, unlocked);
  // Walls and room furniture only: the world built without desks or decorations.
  const fixed = buildWorld({ ...layout, desks: [], decorations: [] }, unlocked).obstacles;
  const inside = (b: Box) => b.minX >= world.bounds.minX && b.maxX <= world.bounds.maxX && b.minZ >= world.bounds.minZ && b.maxZ <= world.bounds.maxZ;
  const decor = layout.decorations
    .filter((d) => !d.requires || unlocked.has(d.requires))
    .map((d) => ({ d, box: decorationKind(d.kind)?.solid ? decorationBox(d) : null }))
    .filter((x): x is { d: OfficeLayout['decorations'][number]; box: Box } => !!x.box);

  layout.desks.forEach((d, i) => {
    const box = deskBox(d);
    const seat = seatBox(d);
    if (!inside(box) || !inside(seat)) out.push(`desk ${d.id} is outside the building`);
    else if (fixed.some((o) => overlap(box, o) || overlap(seat, o))) out.push(`desk ${d.id} stands in a wall or in room furniture`);
    for (const o of layout.desks.slice(i + 1)) {
      // Desks of one pod stand edge to edge, so tops may touch; a chair needs its own floor.
      if (overlap(box, deskBox(o), -0.02) || overlap(seat, deskBox(o)) || overlap(box, seatBox(o)) || overlap(seat, seatBox(o), 0.1)) out.push(`desks ${d.id} and ${o.id} are in each other's way`);
    }
    for (const x of decor) if (overlap(box, x.box) || overlap(seat, x.box)) out.push(`desk ${d.id} and the ${x.d.kind.replace(/_/g, ' ')} ${x.d.id} overlap`);
  });
  decor.forEach((x, i) => {
    if (!inside(x.box)) out.push(`${x.d.id} is outside the building`);
    else if (fixed.some((o) => overlap(x.box, o))) out.push(`${x.d.id} stands in a wall or in room furniture`);
    for (const y of decor.slice(i + 1)) if (overlap(x.box, y.box)) out.push(`${x.d.id} and ${y.d.id} overlap`);
  });

  // Everything people walk to must still be reachable from the entrance.
  const reachable = world.nav.reach(world.spawn.x, world.spawn.z);
  for (const d of layout.desks) {
    const s = deskSeat(d);
    if (!reachable(s.x, s.z)) out.push(`nobody can walk to desk ${d.id}`);
  }
  for (const it of world.interactables) if (!reachable(it.x, it.z)) out.push(`nobody can walk to the ${it.kind === 'hifi' ? 'hi-fi' : it.kind === 'board' ? 'project board' : `${it.kind} room`}`);
  for (const s of world.meeting?.seats ?? []) if (!reachable(s.x, s.z)) out.push('a seat at the meeting table cannot be reached');
  return [...new Set(out)];
}

/** Accept `next` unless it has a problem `before` did not have. */
function accept(before: OfficeLayout, next: OfficeLayout, unlocked: Set<string>): EditResult {
  const had = new Set(layoutProblems(before, unlocked));
  const added = layoutProblems(next, unlocked).filter((p) => !had.has(p));
  return added.length ? refuse(added[0]!) : { ok: true, layout: next };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Move some desks (a pod) together by (dx, dz) metres. */
export function moveDesks(layout: OfficeLayout, unlocked: Set<string>, deskIds: string[], dx: number, dz: number): EditResult {
  const ids = new Set(deskIds);
  if (!layout.desks.some((d) => ids.has(d.id))) return refuse('there is no such desk');
  if (!dx && !dz) return { ok: true, layout };
  const next = { ...layout, desks: layout.desks.map((d) => (ids.has(d.id) ? { ...d, x: round(d.x + dx), z: round(d.z + dz) } : d)) };
  return accept(layout, next, unlocked);
}

/** Decoration kinds the owner may place now: the plain ones, and the rewards whose milestone was reached. */
export function placeableDecorations(unlocked: Set<string>): Array<{ kind: string; label: string; locked: string | null }> {
  return DECORATION_KINDS.map((k) => ({ kind: k.kind, label: k.label, locked: k.unlock && !unlocked.has(k.unlock) ? k.unlock : null }));
}

/** Add a decoration at the free spot nearest to `near` (where the owner stands, or wherever they pointed). */
export function addDecoration(layout: OfficeLayout, unlocked: Set<string>, kind: string, near: { x: number; z: number }, keepClear?: { x: number; z: number }): EditResult & { id?: string } {
  const k = decorationKind(kind);
  if (!k) return refuse(`unknown decoration "${kind}"`);
  if (k.unlock && !unlocked.has(k.unlock)) return refuse(`${k.label} is a milestone reward that has not been reached yet`);
  let n = 1;
  while (layout.decorations.some((d) => d.id === `${kind}-u${n}`)) n++;
  const id = `${kind}-u${n}`;
  const had = new Set(layoutProblems(layout, unlocked));
  const snap = (v: number) => Math.round(v * 2) / 2;
  // Rings of candidate spots around the point, nearest first.
  for (let ring = 0; ring <= 24; ring++) {
    const cands: Array<[number, number]> = [];
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) if (Math.max(Math.abs(i), Math.abs(j)) === ring) cands.push([snap(near.x) + i * 0.5, snap(near.z) + j * 0.5]);
    cands.sort((a, b) => Math.hypot(a[0] - near.x, a[1] - near.z) - Math.hypot(b[0] - near.x, b[1] - near.z));
    for (const [x, z] of cands) {
      // Not on top of whoever asked for it (they would be standing inside it).
      if (keepClear && Math.hypot(x - keepClear.x, z - keepClear.z) < Math.max(k.w, k.d) / 2 + 0.9) continue;
      const next = { ...layout, decorations: [...layout.decorations, { id, kind, x, z, rot: 0 }] };
      // Cheap rejection first: the full check rebuilds the navigation grid.
      const box = decorationBox({ kind, x, z, rot: 0 })!;
      if (k.solid && (layout.desks.some((d) => overlap(box, deskBox(d)) || overlap(box, seatBox(d))) || x - k.w / 2 < -layout.width / 2 + 0.2 || x + k.w / 2 > layout.width / 2 - 0.2 || z - k.d / 2 < -layout.depth / 2 + 0.2 || z + k.d / 2 > layout.depth / 2 - 0.2)) continue;
      if (layoutProblems(next, unlocked).every((p) => had.has(p))) return { ok: true, layout: next, id };
    }
  }
  return refuse('there is no free floor for it');
}

export function moveDecoration(layout: OfficeLayout, unlocked: Set<string>, id: string, dx: number, dz: number, turn = 0): EditResult {
  if (!layout.decorations.some((d) => d.id === id)) return refuse('there is no such decoration');
  const next = { ...layout, decorations: layout.decorations.map((d) => (d.id === id ? { ...d, x: round(d.x + dx), z: round(d.z + dz), rot: d.rot + turn } : d)) };
  return accept(layout, next, unlocked);
}

/** Remove a decoration. Milestone rewards stay: they are earned, not bought, and could not be put back. */
export function removeDecoration(layout: OfficeLayout, id: string): EditResult {
  const d = layout.decorations.find((x) => x.id === id);
  if (!d) return refuse('there is no such decoration');
  if (d.requires) return refuse('a milestone reward can be moved but not removed');
  return { ok: true, layout: { ...layout, decorations: layout.decorations.filter((x) => x.id !== id) } };
}

export function renameRoom(layout: OfficeLayout, id: string, name: string): EditResult {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) return refuse('a room needs a name');
  if (!layout.rooms.some((r) => r.id === id)) return refuse('there is no such room');
  return { ok: true, layout: { ...layout, rooms: layout.rooms.map((r) => (r.id === id ? { ...r, name: clean } : r)) } };
}

/** The smallest a room can be and still hold what stands in it (the furniture is placed from the room's own size). */
export const ROOM_MIN: Record<RoomDef['kind'], { w: number; d: number }> = {
  ceo: { w: 7, d: 7 },
  meeting: { w: 8, d: 6.5 },
  ops: { w: 8, d: 7 },
  server: { w: 10.5, d: 7 },
  break: { w: 8, d: 7.5 },
  reception: { w: 8, d: 8.5 },
  team: { w: 5, d: 4 },
  open: { w: 12, d: 8 },
  hall: { w: 4, d: 1.5 },
};

type Edge = 'n' | 's' | 'e' | 'w';
const EDGE_NAME: Record<Edge, string> = { n: 'north', s: 'south', e: 'east', w: 'west' };

function edgeOf(r: RoomDef, edge: Edge): { at: number; from: number; to: number } {
  if (edge === 'n') return { at: r.z, from: r.x, to: r.x + r.w };
  if (edge === 's') return { at: r.z + r.d, from: r.x, to: r.x + r.w };
  if (edge === 'w') return { at: r.x, from: r.z, to: r.z + r.d };
  return { at: r.x + r.w, from: r.z, to: r.z + r.d };
}

function withEdge(r: RoomDef, edge: Edge, at: number): RoomDef {
  if (edge === 'n') return { ...r, z: round(at), d: round(r.z + r.d - at) };
  if (edge === 's') return { ...r, d: round(at - r.z) };
  if (edge === 'w') return { ...r, x: round(at), w: round(r.x + r.w - at) };
  return { ...r, w: round(at - r.x) };
}

/** Which walls of a room can be moved at all: not the building's outer wall, and not a wall shared with a longer neighbour. */
export function movableEdges(layout: OfficeLayout, roomId: string): Edge[] {
  const r = layout.rooms.find((x) => x.id === roomId);
  if (!r || r.open) return [];
  return (['n', 's', 'e', 'w'] as Edge[]).filter((e) => !edgeBlocker(layout, r, e));
}

/** Why a wall cannot move, or null. Also used to find the neighbours that move with it. */
function edgeBlocker(layout: OfficeLayout, r: RoomDef, edge: Edge): string | null {
  const e = edgeOf(r, edge);
  const limit = edge === 'n' ? -layout.depth / 2 : edge === 's' ? layout.depth / 2 : edge === 'w' ? -layout.width / 2 : layout.width / 2;
  if (Math.abs(e.at - limit) < 1e-6) return `the ${EDGE_NAME[edge]} wall of ${r.name} is the outer wall of the building`;
  const opposite: Edge = edge === 'n' ? 's' : edge === 's' ? 'n' : edge === 'w' ? 'e' : 'w';
  for (const o of layout.rooms) {
    if (o.id === r.id) continue;
    const oe = edgeOf(o, opposite);
    if (Math.abs(oe.at - e.at) > 1e-6 || oe.to <= e.from + 1e-6 || oe.from >= e.to - 1e-6) continue;
    // A neighbour on the other side of this wall: it has to give or take the same strip, so it must not be longer than the wall.
    if (oe.from < e.from - 1e-6 || oe.to > e.to + 1e-6) return `that wall is shared with ${o.name}, which is longer than ${r.name}`;
  }
  return null;
}

/**
 * Move one wall of a room by `delta` metres (positive = east or south). A neighbour that
 * shares the wall gives or takes the same strip, so the floor stays tiled; the result is
 * refused when a room would become too small for its furniture or anything ends up in a wall.
 */
export function resizeRoom(layout: OfficeLayout, unlocked: Set<string>, roomId: string, edge: Edge, delta: number): EditResult {
  const r = layout.rooms.find((x) => x.id === roomId);
  if (!r) return refuse('there is no such room');
  if (r.open) return refuse(`${r.name} has no walls of its own; resize the rooms around it`);
  const blocked = edgeBlocker(layout, r, edge);
  if (blocked) return refuse(blocked);
  const e = edgeOf(r, edge);
  const at = e.at + delta;
  const opposite: Edge = edge === 'n' ? 's' : edge === 's' ? 'n' : edge === 'w' ? 'e' : 'w';
  const rooms = layout.rooms.map((o) => {
    if (o.id === r.id) return withEdge(o, edge, at);
    const oe = edgeOf(o, opposite);
    const neighbour = Math.abs(oe.at - e.at) < 1e-6 && oe.from >= e.from - 1e-6 && oe.to <= e.to + 1e-6;
    return neighbour ? withEdge(o, opposite, at) : o;
  });
  for (const o of rooms) {
    const min = ROOM_MIN[o.kind];
    const was = layout.rooms.find((x) => x.id === o.id)!;
    if ((o.w < min.w - 1e-6 && o.w < was.w) || (o.d < min.d - 1e-6 && o.d < was.d)) return refuse(`${o.name} cannot be smaller than ${min.w} × ${min.d} m: its furniture would not fit`);
    if (o.x < -layout.width / 2 - 1e-6 || o.x + o.w > layout.width / 2 + 1e-6 || o.z < -layout.depth / 2 - 1e-6 || o.z + o.d > layout.depth / 2 + 1e-6) return refuse(`${o.name} would stick out of the building`);
  }
  // A room standing free on the open floor (the team room) may not grow into another walled room.
  const walled = rooms.filter((o) => !o.open);
  for (let i = 0; i < walled.length; i++) {
    for (let j = i + 1; j < walled.length; j++) {
      const a = walled[i]!;
      const b = walled[j]!;
      if (a.x < b.x + b.w - 1e-6 && a.x + a.w > b.x + 1e-6 && a.z < b.z + b.d - 1e-6 && a.z + a.d > b.z + 1e-6) return refuse(`${a.name} and ${b.name} would overlap`);
    }
  }
  return accept(layout, { ...layout, rooms }, unlocked);
}
