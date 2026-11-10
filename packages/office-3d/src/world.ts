import type { Desk, OfficeLayout, RoomDef } from '@orchestrator/contracts';
import { DESK_SIZE, decorationBox, decorationKind, deskSeat } from '@orchestrator/contracts';
import type { EffectiveLayout, MemberRoom } from './member-rooms.ts';

/**
 * Everything spatial that is derived from the layout data: walls, obstacles,
 * points of interest and a navigation grid. Pure functions of the layout, so
 * adding a desk or unlocking a room changes the world without touching rendering code.
 */

export interface Wall {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  glass: boolean;
  outer: boolean;
}

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Spot {
  x: number;
  z: number;
  rot: number;
  sit: boolean;
}

export interface Interactable {
  kind: 'board' | 'meeting' | 'server' | 'ops' | 'ceo' | 'break' | 'reception' | 'hifi' | 'tv';
  id: string;
  label: string;
  x: number;
  z: number;
  radius: number;
}

export interface World {
  layout: OfficeLayout;
  rooms: RoomDef[];
  walls: Wall[];
  obstacles: Box[];
  /** The obstacles that are not walls: furniture, desks, solid decorations. */
  solids: Box[];
  /** Everything there is a floor under: the building, and the member rooms attached to it. The navigation grid covers this. */
  bounds: Box;
  /**
   * The office without member rooms: this same world when it has none. Its rooms, features and layout keep their
   * identity while members come and go, so what is drawn from them is not rebuilt.
   */
  base: World;
  /** Rooms of the members who are in the office right now (see `member-rooms.ts`); empty in an office without any. */
  memberRooms: MemberRoom[];
  /** The desks that stand in member rooms. */
  memberDesks: Desk[];
  meeting: { x: number; z: number; w: number; d: number; seats: Spot[] } | null;
  breakSpots: Spot[];
  ceoDesk: { x: number; z: number; rot: number } | null;
  /** The office hi-fi (against the break room's west wall, facing into the room). */
  hifi: { x: number; z: number; rot: number } | null;
  /** The big TV on the break room's north wall, opposite the sofa. */
  tv: { x: number; z: number; rot: number } | null;
  reception: { x: number; z: number; rot: number } | null;
  board: { x: number; z: number; rot: number; w: number; h: number } | null;
  /** Places to stand in front of the project board, facing it (people planning stand here). */
  boardSpots: Spot[];
  /** The meeting-room whiteboard, on the room's back wall. */
  whiteboard: { x: number; z: number; rot: number; w: number; h: number } | null;
  opsWall: { x: number; z: number; w: number } | null;
  racks: Array<{ x: number; z: number; rot: number }>;
  interactables: Interactable[];
  spawn: { x: number; z: number; rot: number };
  nav: NavGrid;
  room(kind: RoomDef['kind']): RoomDef | undefined;
}

const WALL_T = 0.14;

type Interval = [number, number];

function unionIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b - a > 1e-6).sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtractIntervals(solids: Interval[], holes: Interval[]): Interval[] {
  let out = solids;
  for (const [ha, hb] of holes) {
    const next: Interval[] = [];
    for (const [a, b] of out) {
      if (hb <= a || ha >= b) next.push([a, b]);
      else {
        if (ha > a) next.push([a, ha]);
        if (hb < b) next.push([hb, b]);
      }
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.05);
}

/** Build wall segments, merging the shared walls of adjacent rooms and cutting door openings. */
function buildWalls(rooms: RoomDef[], bounds: Box): Wall[] {
  interface Line {
    axis: 'x' | 'z';
    at: number;
    solids: Array<{ iv: Interval; glass: boolean }>;
    doors: Interval[];
    outer: boolean;
  }
  const lines = new Map<string, Line>();
  const line = (axis: 'x' | 'z', at: number): Line => {
    const key = `${axis}:${at.toFixed(2)}`;
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { axis, at, solids: [], doors: [], outer: false }));
    return l;
  };
  // Perimeter, with the entrance in the reception's south wall.
  const reception = rooms.find((r) => r.kind === 'reception');
  const per: Array<[Line, Interval]> = [
    [line('z', bounds.minZ), [bounds.minX, bounds.maxX]],
    [line('z', bounds.maxZ), [bounds.minX, bounds.maxX]],
    [line('x', bounds.minX), [bounds.minZ, bounds.maxZ]],
    [line('x', bounds.maxX), [bounds.minZ, bounds.maxZ]],
  ];
  for (const [l, iv] of per) {
    l.solids.push({ iv, glass: false });
    l.outer = true;
  }
  if (reception) {
    const cx = reception.x + reception.w / 2;
    line('z', bounds.maxZ).doors.push([cx - 1.6, cx + 1.6]);
  }
  for (const r of rooms) {
    if (r.open) continue;
    const sides: Array<{ side: 'n' | 's' | 'e' | 'w'; l: Line; iv: Interval }> = [
      { side: 'n', l: line('z', r.z), iv: [r.x, r.x + r.w] },
      { side: 's', l: line('z', r.z + r.d), iv: [r.x, r.x + r.w] },
      { side: 'w', l: line('x', r.x), iv: [r.z, r.z + r.d] },
      { side: 'e', l: line('x', r.x + r.w), iv: [r.z, r.z + r.d] },
    ];
    for (const s of sides) {
      // Glass partitions face the floor; shared and back walls stay solid.
      const glass = !!r.glass && (s.side === 's' || (r.kind === 'team' && s.side === 'e'));
      s.l.solids.push({ iv: s.iv, glass });
      for (const d of r.doors ?? []) {
        if (d.side !== s.side) continue;
        const c = s.iv[0] + (s.iv[1] - s.iv[0]) * d.at;
        s.l.doors.push([c - d.width / 2, c + d.width / 2]);
      }
    }
  }
  const walls: Wall[] = [];
  for (const l of lines.values()) {
    const glassIv = unionIntervals(l.solids.filter((s) => s.glass).map((s) => [...s.iv] as Interval));
    const allIv = unionIntervals(l.solids.map((s) => [...s.iv] as Interval));
    const solidOnly = subtractIntervals(allIv, glassIv);
    const emit = (ivs: Interval[], glass: boolean) => {
      for (const [a, b] of subtractIntervals(ivs, l.doors)) {
        walls.push(l.axis === 'z' ? { x1: a, z1: l.at, x2: b, z2: l.at, glass, outer: l.outer } : { x1: l.at, z1: a, x2: l.at, z2: b, glass, outer: l.outer });
      }
    };
    emit(solidOnly, false);
    emit(l.outer ? [] : glassIv, true);
    if (l.outer) emit(glassIv, false);
  }
  return walls;
}

export function deskBox(d: Desk, grow = 0): Box {
  // A desk turned a quarter (as in a member room on the east or west side) is long along Z.
  const turned = Math.abs(Math.sin(d.rot)) > 0.7;
  const hw = (turned ? DESK_SIZE.d : DESK_SIZE.w) / 2 + grow;
  const hd = (turned ? DESK_SIZE.w : DESK_SIZE.d) / 2 + grow;
  return { minX: d.x - hw, maxX: d.x + hw, minZ: d.z - hd, maxZ: d.z + hd };
}

function rect(x: number, z: number, w: number, d: number): Box {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
}

// ───────────────────────────── navigation ─────────────────────────────

export class NavGrid {
  readonly cell = 0.4;
  readonly cols: number;
  readonly rows: number;
  private blocked: Uint8Array;
  private bounds: Box;

  constructor(bounds: Box, obstacles: Box[], clearance = 0.28) {
    this.bounds = bounds;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / this.cell);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / this.cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
    for (const o of obstacles) {
      const c0 = Math.max(0, Math.floor((o.minX - clearance - bounds.minX) / this.cell));
      const c1 = Math.min(this.cols - 1, Math.floor((o.maxX + clearance - bounds.minX) / this.cell));
      const r0 = Math.max(0, Math.floor((o.minZ - clearance - bounds.minZ) / this.cell));
      const r1 = Math.min(this.rows - 1, Math.floor((o.maxZ + clearance - bounds.minZ) / this.cell));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.blocked[r * this.cols + c] = 1;
    }
  }

  private toCell(x: number, z: number): [number, number] {
    return [Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.bounds.minX) / this.cell))), Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.bounds.minZ) / this.cell)))];
  }

  private center(c: number, r: number): [number, number] {
    return [this.bounds.minX + (c + 0.5) * this.cell, this.bounds.minZ + (r + 0.5) * this.cell];
  }

  isBlocked(c: number, r: number): boolean {
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows || this.blocked[r * this.cols + c] === 1;
  }

  /** Nearest walkable cell to a point (seats sit inside a desk's clearance zone). */
  private nearestFree(x: number, z: number): [number, number] | null {
    const [c0, r0] = this.toCell(x, z);
    if (!this.isBlocked(c0, r0)) return [c0, r0];
    for (let radius = 1; radius < 14; radius++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (this.isBlocked(c, r)) continue;
          const [cx, cz] = this.center(c, r);
          const d = (cx - x) ** 2 + (cz - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = [c, r];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** The middle of the walkable cell nearest to a point, or null when there is none close by. */
  nearestWalkable(x: number, z: number): [number, number] | null {
    const cell = this.nearestFree(x, z);
    return cell ? this.center(cell[0], cell[1]) : null;
  }

  /** Is this point on a free cell (nothing solid within the clearance)? */
  walkable(x: number, z: number): boolean {
    const [c, r] = this.toCell(x, z);
    return !this.isBlocked(c, r);
  }

  /**
   * Which cells can be walked to from a point: a flood fill with the same rules as `path`
   * (no cutting corners). Returns a test for "can this other point be reached?".
   */
  reach(fromX: number, fromZ: number): (x: number, z: number) => boolean {
    const seen = new Uint8Array(this.cols * this.rows);
    const start = this.nearestFree(fromX, fromZ);
    if (start) {
      const queue: number[] = [start[1] * this.cols + start[0]];
      seen[queue[0]!] = 1;
      while (queue.length) {
        const cur = queue.pop()!;
        const cc = cur % this.cols;
        const cr = Math.floor(cur / this.cols);
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nc = cc + dc;
            const nr = cr + dr;
            if (this.isBlocked(nc, nr)) continue;
            if (dr && dc && (this.isBlocked(cc + dc, cr) || this.isBlocked(cc, cr + dr))) continue;
            const ni = nr * this.cols + nc;
            if (seen[ni]) continue;
            seen[ni] = 1;
            queue.push(ni);
          }
        }
      }
    }
    return (x, z) => {
      const cell = this.nearestFree(x, z);
      return !!cell && seen[cell[1] * this.cols + cell[0]] === 1;
    };
  }

  private lineClear(ax: number, az: number, bx: number, bz: number): boolean {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(dist / (this.cell * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const [c, r] = this.toCell(ax + (bx - ax) * t, az + (bz - az) * t);
      if (this.isBlocked(c, r)) return false;
    }
    return true;
  }

  /** A* over the grid, then string-pulled into a few straight segments. */
  path(fromX: number, fromZ: number, toX: number, toZ: number): Array<[number, number]> {
    const start = this.nearestFree(fromX, fromZ);
    const goal = this.nearestFree(toX, toZ);
    if (!start || !goal) return [[toX, toZ]];
    const N = this.cols * this.rows;
    const idx = (c: number, r: number) => r * this.cols + c;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open: number[] = [];
    const f = new Float32Array(N).fill(Infinity);
    const h = (c: number, r: number) => Math.hypot(c - goal[0], r - goal[1]);
    const s = idx(start[0], start[1]);
    g[s] = 0;
    f[s] = h(start[0], start[1]);
    open.push(s);
    const goalIdx = idx(goal[0], goal[1]);
    let found = false;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]!]! < f[open[bi]!]!) bi = i;
      const cur = open.splice(bi, 1)[0]!;
      if (cur === goalIdx) {
        found = true;
        break;
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % this.cols;
      const cr = Math.floor(cur / this.cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = cc + dc;
          const nr = cr + dr;
          if (this.isBlocked(nc, nr)) continue;
          // No cutting corners through obstacles.
          if (dr && dc && (this.isBlocked(cc + dc, cr) || this.isBlocked(cc, cr + dr))) continue;
          const ni = idx(nc, nr);
          if (closed[ni]) continue;
          const ng = g[cur]! + (dr && dc ? 1.4142 : 1);
          if (ng < g[ni]!) {
            g[ni] = ng;
            f[ni] = ng + h(nc, nr);
            came[ni] = cur;
            open.push(ni);
          }
        }
      }
    }
    if (!found) return [[toX, toZ]];
    const cells: Array<[number, number]> = [];
    for (let cur = goalIdx; cur !== -1; cur = came[cur]!) cells.push(this.center(cur % this.cols, Math.floor(cur / this.cols)));
    cells.reverse();
    // String pulling: keep only the corners that are needed.
    const pts: Array<[number, number]> = [];
    let anchor: [number, number] = [fromX, fromZ];
    for (let i = 0; i < cells.length; i++) {
      const next = cells[i + 1];
      if (!next || !this.lineClear(anchor[0], anchor[1], next[0], next[1])) {
        pts.push(cells[i]!);
        anchor = cells[i]!;
      }
    }
    pts.push([toX, toZ]);
    return pts;
  }
}

/** Resolve a circle against the obstacle boxes, sliding along them. */
export function moveWithCollision(world: World, x: number, z: number, dx: number, dz: number, radius = 0.3): [number, number] {
  const core = world.base.bounds;
  const hits = (px: number, pz: number) => {
    // Outside the building there is floor only in the member rooms (and in front of the entrance).
    if (px < core.minX + radius || px > core.maxX - radius || pz < core.minZ + radius || pz > core.maxZ + 6) {
      let inRoom = false;
      for (const r of world.memberRooms) if (!r.locked && px > r.reach.minX && px < r.reach.maxX && pz > r.reach.minZ && pz < r.reach.maxZ) inRoom = true;
      if (!inRoom) return true;
    }
    for (const o of world.obstacles) {
      if (px > o.minX - radius && px < o.maxX + radius && pz > o.minZ - radius && pz < o.maxZ + radius) return true;
    }
    return false;
  };
  let nx = x;
  let nz = z;
  if (!hits(x + dx, z)) nx = x + dx;
  if (!hits(nx, z + dz)) nz = z + dz;
  return [nx, nz];
}

const wallBox = (w: Wall): Box => ({ minX: Math.min(w.x1, w.x2) - WALL_T / 2, maxX: Math.max(w.x1, w.x2) + WALL_T / 2, minZ: Math.min(w.z1, w.z2) - WALL_T / 2, maxZ: Math.max(w.z1, w.z2) + WALL_T / 2 });

const NO_ROOMS: MemberRoom[] = [];
const NO_DESKS: Desk[] = [];

/**
 * The world of a layout. A layout that carries member rooms (see `withMemberRooms`) gives the stored office,
 * exactly as it is without them, plus those rooms: `base` is the world of the stored office, and may be handed in
 * when the caller already has it (the scene keeps it, so nothing of the existing office is rebuilt when a member arrives).
 */
export function buildWorld(layout: OfficeLayout, unlocked: Set<string>, base?: World): World {
  const eff = layout as Partial<EffectiveLayout>;
  if (!eff.base || !eff.memberRooms?.length) return buildCore(layout, unlocked);
  return extendWorld(base && base.layout === eff.base ? base : buildCore(eff.base, unlocked), layout as EffectiveLayout);
}

/** The stored office with the member rooms attached: new walls (the outer wall now has their doors), a wider floor to walk on, the same everything else. */
function extendWorld(core: World, layout: EffectiveLayout): World {
  const extra = new Set(layout.memberRooms.map((r) => r.roomId));
  const rooms = [...core.rooms, ...layout.rooms.filter((r) => extra.has(r.id))];
  // The outer walls still stand where the building ends; a member room is a closed room on the other side of one, with its door in it.
  const walls = buildWalls(rooms, core.bounds);
  const memberDesks = layout.desks.filter((d) => d.id.startsWith('m:'));
  const solids = [...core.solids];
  for (const d of memberDesks) solids.push(deskBox(d));
  for (const d of layout.decorations) {
    if (!d.id.startsWith('m:')) continue;
    const box = decorationKind(d.kind)?.solid ? decorationBox(d) : null;
    if (box) solids.push(box);
  }
  const obstacles = [...walls.map(wallBox), ...solids];
  // The navigation grid starts at the lowest corner: it grows there by whole cells, so every cell of the existing office stays where it was.
  const cell = 0.4;
  const b = { ...core.bounds };
  for (const r of layout.memberRooms) {
    b.minX = Math.min(b.minX, core.bounds.minX - Math.ceil((core.bounds.minX - r.x) / cell - 1e-6) * cell);
    b.minZ = Math.min(b.minZ, core.bounds.minZ - Math.ceil((core.bounds.minZ - r.z) / cell - 1e-6) * cell);
    b.maxX = Math.max(b.maxX, r.x + r.w);
    b.maxZ = Math.max(b.maxZ, r.z + r.d);
  }
  return { ...core, layout, rooms, walls, obstacles, solids, bounds: b, base: core, memberRooms: layout.memberRooms, memberDesks, nav: new NavGrid(b, obstacles) };
}

function buildCore(layout: OfficeLayout, unlocked: Set<string>): World {
  const rooms = layout.rooms.filter((r) => !r.requires || unlocked.has(r.requires));
  const bounds: Box = { minX: -layout.width / 2, maxX: layout.width / 2, minZ: -layout.depth / 2, maxZ: layout.depth / 2 };
  const room = (kind: RoomDef['kind']) => rooms.find((r) => r.kind === kind);
  const walls = buildWalls(rooms, bounds);
  const wallBoxes = walls.map(wallBox);
  // Everything pushed from here on is furniture; the walls are put in front of it at the end.
  const obstacles: Box[] = [];
  for (const d of layout.desks) obstacles.push(deskBox(d));
  const interactables: Interactable[] = [];

  // Meeting room: a table sized to the room with seats around it.
  let meeting: World['meeting'] = null;
  let whiteboard: World['whiteboard'] = null;
  const mr = room('meeting');
  if (mr) {
    const cx = mr.x + mr.w / 2;
    const cz = mr.z + mr.d / 2 - 0.2;
    const tw = Math.min(6.2, mr.w - 4);
    const td = 1.7;
    const seats: Spot[] = [];
    const perSide = Math.max(2, Math.floor(tw / 1.15));
    for (let i = 0; i < perSide; i++) {
      const x = cx - tw / 2 + (tw / perSide) * (i + 0.5);
      seats.push({ x, z: cz - td / 2 - 0.55, rot: 0, sit: true });
      seats.push({ x, z: cz + td / 2 + 0.55, rot: Math.PI, sit: true });
    }
    seats.push({ x: cx - tw / 2 - 0.6, z: cz, rot: Math.PI / 2, sit: true });
    seats.push({ x: cx + tw / 2 + 0.6, z: cz, rot: -Math.PI / 2, sit: true });
    meeting = { x: cx, z: cz, w: tw, d: td, seats };
    whiteboard = { x: cx, z: mr.z + 0.11, rot: 0, w: Math.min(4.4, mr.w - 2), h: 1.5 };
    obstacles.push(rect(cx, cz, tw, td));
    interactables.push({ kind: 'meeting', id: 'meeting', label: 'MEETING ROOM — PLAN & COLLABORATE', x: cx, z: cz + 2.2, radius: 2.6 });
  }

  let hifi: World['hifi'] = null;
  let tv: World['tv'] = null;
  // Break room: sofa, counter, a few places to stand.
  const breakSpots: Spot[] = [];
  const br = room('break');
  if (br) {
    const cx = br.x + br.w / 2;
    obstacles.push(rect(br.x + br.w - 0.55, br.z + 3.2, 0.8, 4.6)); // kitchen counter along the east wall
    obstacles.push(rect(cx - 0.8, br.z + br.d - 1.0, 2.6, 0.95)); // sofa
    obstacles.push(rect(cx - 0.8, br.z + br.d - 2.5, 1.3, 0.7)); // coffee table
    breakSpots.push({ x: cx - 1.5, z: br.z + br.d - 1.05, rot: Math.PI, sit: true }, { x: cx - 0.1, z: br.z + br.d - 1.05, rot: Math.PI, sit: true });
    breakSpots.push({ x: br.x + br.w - 1.5, z: br.z + 2.2, rot: Math.PI / 2, sit: false }, { x: br.x + br.w - 1.5, z: br.z + 4.2, rot: Math.PI / 2, sit: false }, { x: cx - 2.6, z: br.z + 3.4, rot: 0.6, sit: false }, { x: cx - 1.2, z: br.z + 3.0, rot: -0.7, sit: false });
    interactables.push({ kind: 'break', id: 'break', label: 'BREAK ROOM — WHO IS IDLE', x: cx - 0.8, z: br.z + 3.6, radius: 2.4 });
    // The hi-fi: a sideboard with the stereo and two floor speakers against the west wall.
    hifi = { x: br.x + 0.45, z: br.z + 2.0, rot: Math.PI / 2 };
    obstacles.push(rect(hifi.x, hifi.z, 0.7, 3.0));
    interactables.push({ kind: 'hifi', id: 'hifi', label: 'HI-FI — RADIO', x: hifi.x + 1.0, z: hifi.z, radius: 1.7 });
    // The TV hangs on the north wall where the sofa looks, clear of the door and the kitchen counter.
    tv = { x: cx + 0.5, z: br.z + 0.12, rot: 0 };
    obstacles.push(rect(tv.x, br.z + 0.36, 2.6, 0.5)); // its media console
    // Listed first: standing in front of the TV means the TV, even inside the break room's wider circle.
    interactables.unshift({ kind: 'tv', id: 'tv', label: 'TV — BROWSER, VIDEO, MUSIC', x: tv.x, z: br.z + 1.9, radius: 1.5 });
  }

  let ceoDesk: World['ceoDesk'] = null;
  const cr = room('ceo');
  if (cr) {
    ceoDesk = { x: cr.x + cr.w / 2 - 0.6, z: cr.z + 3.0, rot: Math.PI };
    obstacles.push(rect(ceoDesk.x, ceoDesk.z, 2.4, 1.1));
    obstacles.push(rect(cr.x + 1.3, cr.z + cr.d - 2.2, 0.9, 2.2)); // lounge chairs
    interactables.push({ kind: 'ceo', id: 'ceo', label: 'CEO DESK — COMPANY CONTROL', x: ceoDesk.x, z: ceoDesk.z - 1.3, radius: 1.9 });
  }

  let reception: World['reception'] = null;
  const rr = room('reception');
  if (rr) {
    reception = { x: rr.x + rr.w / 2, z: rr.z + rr.d - 4.2, rot: 0 };
    obstacles.push(rect(reception.x, reception.z, 3.4, 0.9));
    obstacles.push(rect(rr.x + rr.w - 1.0, rr.z + 2.6, 0.9, 3.0)); // waiting bench
    interactables.push({ kind: 'reception', id: 'reception', label: 'RECEPTION — COMPANY OVERVIEW', x: reception.x, z: reception.z + 1.5, radius: 2.0 });
  }

  // Project board on the west wall of the engineering floor.
  let board: World['board'] = null;
  const open = room('open');
  if (open) {
    board = { x: open.x + 0.12, z: open.z + 6.5, rot: Math.PI / 2, w: 9, h: 2.5 };
    interactables.push({ kind: 'board', id: 'board', label: 'PROJECT BOARD', x: open.x + 1.8, z: open.z + 6.5, radius: 2.6 });
  }

  let opsWall: World['opsWall'] = null;
  const or = room('ops');
  if (or) {
    opsWall = { x: or.x + or.w / 2, z: or.z + 0.16, w: or.w - 1.6 };
    obstacles.push(rect(or.x + or.w / 2, or.z + 4.6, 5.2, 1.0)); // operator console
    interactables.push({ kind: 'ops', id: 'ops', label: 'OPERATIONS — LIVE TERMINAL WALL', x: or.x + or.w / 2, z: or.z + 5.9, radius: 2.4 });
  }

  const racks: World['racks'] = [];
  const sr = room('server');
  if (sr) {
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 5; i++) {
        const x = sr.x + 2.2 + i * 1.75;
        const z = sr.z + 2.0 + row * 3.0;
        racks.push({ x, z, rot: 0 });
        obstacles.push(rect(x, z, 0.8, 1.05));
      }
    }
    interactables.push({ kind: 'server', id: 'server', label: 'SERVER ROOM — CONNECTED MACHINES', x: sr.x + sr.w / 2, z: sr.z + 6.6, radius: 2.6 });
  }

  for (const d of layout.decorations) {
    if (d.requires && !unlocked.has(d.requires)) continue;
    const box = decorationKind(d.kind)?.solid ? decorationBox(d) : null;
    if (box) obstacles.push(box);
  }

  // Standing room in front of the project board: a row of spots, centre first, skipping any that something stands on.
  const boardSpots: Spot[] = [];
  if (board) {
    const bx = board.x + Math.sin(board.rot) * 1.15;
    const bz = board.z + Math.cos(board.rot) * 1.15;
    // Along the board: perpendicular to the way it faces.
    const ax = Math.cos(board.rot);
    const az = -Math.sin(board.rot);
    for (const off of [-0.6, 0.6, -1.8, 1.8, -3.0, 3.0, -4.0, 4.0]) {
      if (Math.abs(off) > board.w / 2 - 0.3) continue;
      const x = bx + ax * off;
      const z = bz + az * off;
      const r = 0.32;
      const blocks = (o: Box) => x > o.minX - r && x < o.maxX + r && z > o.minZ - r && z < o.maxZ + r;
      if (wallBoxes.some(blocks) || obstacles.some(blocks)) continue;
      boardSpots.push({ x, z, rot: board.rot + Math.PI, sit: false });
    }
  }

  const spawn = rr ? { x: rr.x + rr.w / 2, z: rr.z + rr.d - 1.6, rot: Math.PI } : { x: 0, z: bounds.maxZ - 2, rot: Math.PI };
  const solids = obstacles;
  const all = [...wallBoxes, ...solids];
  const world = { layout, rooms, walls, obstacles: all, solids, bounds, memberRooms: NO_ROOMS, memberDesks: NO_DESKS, meeting, breakSpots, ceoDesk, hifi, tv, reception, board, boardSpots, whiteboard, opsWall, racks, interactables, spawn, nav: new NavGrid(bounds, all), room } as unknown as World;
  world.base = world;
  return world;
}

/**
 * Things on or against the walls that are not obstacles to walk around but would be cut through or hidden by a
 * door: boards, wall screens, signs, appliances, and the chairs at the desks.
 */
export function wallFixtures(world: World): Box[] {
  const out: Box[] = [];
  const b = world.board;
  // The project board hangs on the west wall of the engineering floor.
  if (b) out.push({ minX: b.x - 0.3, maxX: b.x + 0.3, minZ: b.z - b.w / 2 - 0.2, maxZ: b.z + b.w / 2 + 0.2 });
  const wb = world.whiteboard;
  if (wb) out.push({ minX: wb.x - wb.w / 2 - 0.2, maxX: wb.x + wb.w / 2 + 0.2, minZ: wb.z - 0.3, maxZ: wb.z + 0.3 });
  const ow = world.opsWall;
  if (ow) out.push({ minX: ow.x - ow.w / 2 - 0.2, maxX: ow.x + ow.w / 2 + 0.2, minZ: ow.z - 0.3, maxZ: ow.z + 0.3 });
  // The company board and the usage clocks fill the CEO room's north wall.
  const cr = world.room('ceo');
  if (cr) out.push({ minX: cr.x, maxX: cr.x + cr.w, minZ: cr.z, maxZ: cr.z + 0.3 });
  const rr = world.room('reception');
  if (rr) out.push({ minX: rr.x + rr.w - 0.3, maxX: rr.x + rr.w, minZ: rr.z + rr.d / 2 - 2.7, maxZ: rr.z + rr.d / 2 + 2.7 });
  const br = world.room('break');
  if (br) out.push(rect(br.x + br.w - 0.5, br.z + 5.9, 0.9, 0.9)); // the fridge
  if (world.tv) out.push(rect(world.tv.x, world.tv.z, 3.0, 0.5));
  for (const d of world.layout.decorations) {
    const box = decorationKind(d.kind)?.solid ? null : decorationBox(d);
    if (box) out.push({ minX: box.minX - 0.15, maxX: box.maxX + 0.15, minZ: box.minZ - 0.15, maxZ: box.maxZ + 0.15 });
  }
  for (const d of world.layout.desks) {
    const seat = deskSeat(d);
    out.push(rect(seat.x, seat.z, 0.7, 0.7));
  }
  return out;
}

/** A group of desks that stand together (a pod): where a team, and so a project, sits. */
export interface DeskPod {
  /** Stable for as long as the same desks stand together: the smallest desk id in the pod. */
  id: string;
  deskIds: string[];
  box: Box;
  cx: number;
  cz: number;
}

/** Group desks into pods: desks whose tops are within arm's reach of each other belong together. */
export function deskPods(desks: Desk[]): DeskPod[] {
  const parent = desks.map((_d, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < desks.length; i++) {
    for (let j = i + 1; j < desks.length; j++) {
      const a = deskBox(desks[i]!);
      const b = deskBox(desks[j]!);
      const gapX = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
      const gapZ = Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ, 0);
      if (gapX <= 0.45 && gapZ <= 0.45) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Desk[]>();
  desks.forEach((d, i) => {
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), d]);
  });
  const pods: DeskPod[] = [];
  for (const list of groups.values()) {
    const box: Box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const d of list) {
      const b = deskBox(d);
      box.minX = Math.min(box.minX, b.minX);
      box.maxX = Math.max(box.maxX, b.maxX);
      box.minZ = Math.min(box.minZ, b.minZ);
      box.maxZ = Math.max(box.maxZ, b.maxZ);
    }
    const ids = list.map((d) => d.id).sort();
    pods.push({ id: ids[0]!, deskIds: ids, box, cx: (box.minX + box.maxX) / 2, cz: (box.minZ + box.maxZ) / 2 });
  }
  return pods.sort((a, b) => a.id.localeCompare(b.id));
}

export { deskSeat, DESK_SIZE, WALL_T };
