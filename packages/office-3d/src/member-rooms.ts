import type { MemberRoomPrefs, Desk, OfficeLayout, RoomDef } from '@orchestrator/contracts';
import { MEMBER_ROOM_LIMITS } from '@orchestrator/contracts';
import { buildWorld, wallFixtures, type Box, type World } from './world.ts';

/**
 * Member rooms: while a member of the office is connected, a room of their own is attached to the building and
 * their personal employees sit in it. Nothing of this is stored. The rooms are derived, here, from the stored
 * layout and from who is connected, so every client arrives at the same rooms and the office itself never changes:
 * a room stands outside an outer wall, with a door cut through that wall.
 */

/** A member's own computer that is connected right now, and the employees that live on it. */
export interface MemberHost {
  hostId: string;
  memberId: string;
  memberName: string;
  employeeIds: string[];
  /** How the member arranged their room (size, colour, name, furniture); absent: as it comes. */
  prefs?: MemberRoomPrefs | null;
  /** The member is not in the office right now: their room stands where it is, dark and locked. */
  locked?: boolean;
  /**
   * The member closed their room to everyone else (and this window is someone else's): the lights are on and the
   * employees at work, but the door is shut — nobody walks in. In the member's own window this is never set.
   */
  closed?: boolean;
  /** Seats chosen for employees (employee id → seat number from 1); the others take the free seats in order. */
  seats?: Record<string, number>;
  /** The servers this member brought in and keeps to themselves, in a stable order: each stands in the room as a small rack. */
  servers?: Array<{ id: string }>;
}

export type MemberSide = 'n' | 'e' | 'w';

export interface MemberRoom {
  hostId: string;
  memberId: string;
  memberName: string;
  /** What the signs say. */
  title: string;
  /** The member is away: no way in, lights off, drawn grey. */
  locked: boolean;
  /** The member closed their room to everyone else: lit and at work, and no way in for whoever looks at this window. */
  closed: boolean;
  /** The wall of the building the room is attached to. */
  side: MemberSide;
  /** Id of the room in the effective layout: `m:<hostId>`. */
  roomId: string;
  /** The room's floor. */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Ids of its desks, in seating order: `m:<hostId>:<n>`. */
  desks: string[];
  /** How many employees the member has, and how many of them have no desk here (beyond the largest room). */
  employees: number;
  unseated: number;
  /** The middle of the door opening, on the building's outer wall. `rot` faces into the office. */
  door: { x: number; z: number; width: number; rot: number };
  /** The name plate on the office side of that wall: beside the door, or over it where there is no free wall beside it. */
  plaque: { x: number; z: number; rot: number; above: boolean };
  /** The name painted on the room's floor, for the overhead cameras: always read from the south. */
  label: { x: number; z: number; w: number; h: number };
  /** The member's own servers, as small racks along the back wall: where each stands, its front to the room. Those that do not fit are left out. */
  servers: Array<{ id: string; x: number; z: number; rot: number }>;
  /** Ceiling light panels (their middles). */
  lights: Array<[number, number]>;
  /** The member's colour: the room's carpet and the accents on its signs. */
  color: string;
  /** Where one may stand that belongs to the room: its floor and the doorway. */
  reach: Box;
}

/** The stored layout with the member rooms added. `base` is the stored layout itself, untouched. */
export interface EffectiveLayout extends OfficeLayout {
  base: OfficeLayout;
  memberRooms: MemberRoom[];
}

export interface MemberOffice {
  /** The stored layout itself when nobody has a room; otherwise an `EffectiveLayout`. */
  layout: OfficeLayout;
  rooms: MemberRoom[];
  /** Personal employee → their desk in their member's room. */
  deskOf: Map<string, string>;
  /** Hosts for which there was no wall left to attach a room to. */
  unplaced: string[];
}

/** A room is this long along the wall it is attached to, whatever its size: it grows away from the building, so its neighbours never move. */
export const ROOM_ALONG = 6.8;
/** From the wall to the middle of the first pod, from one pod to the next, and from the last pod to the back wall. */
// These leave more than a navigation cell (plus clearance) free on every side of a pod: beside it, behind it and
// between two pods, wherever the grid's cells happen to fall — so every seat can always be walked to.
const POD_FIRST = 3.0;
const POD_PITCH = 4.0;
const POD_BACK = 3.0;
const DOOR_WIDTH = 1.6;
/** A member's server in their room: a rack at a little over half size. From the middle of one to the middle of the next, and from the back wall to its middle. */
export const SMALL_RACK = 0.55;
const SERVER_PITCH = 0.62;
const SERVER_FROM_WALL = 0.4;
/** The name painted on the floor: as long as the smallest room allows. */
const LABEL_W = 4.2;
/** The largest room: five pods. A member with more employees than this is told so on the plaque. */
export const MEMBER_DESK_CAP = MEMBER_ROOM_LIMITS.desks;

const COLORS = ['#e0a23a', '#4fb6a8', '#d0698c', '#7c8fe0', '#8cbf5a', '#d9774a'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Desks in a room for this many employees: always a pair to begin with, then by pairs up to the cap. */
export function memberDeskCount(employees: number, wanted = 0): number {
  return Math.min(MEMBER_DESK_CAP, Math.max(2, Math.ceil(employees / 2) * 2, Math.ceil(wanted / 2) * 2));
}

/** How far a room with this many desks reaches out from the building. */
export function memberRoomDepth(desks: number): number {
  return POD_FIRST + POD_PITCH * (Math.ceil(desks / 4) - 1) + POD_BACK;
}

const round = (n: number): number => Math.round(n * 1e4) / 1e4;
const overlap = (a: Box, b: Box): boolean => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

/** A place on an outer wall where a room can be attached. */
interface Slot {
  side: MemberSide;
  /** Where the room begins along the wall (Z for the east and west walls, X for the north wall). */
  start: number;
  /** The middle of the door along the wall, and on which side of it the plaque hangs (0: over the door). */
  door: number;
  plaqueDir: 1 | -1 | 0;
  /** What the door opens into: 0 an open area (hall, floor, reception), 1 a closed room, 2 the CEO's office. */
  quality: 0 | 1 | 2;
}

/** The only kind of place a member's room is attached to: one whose door opens into the shared part of the office. */
const SHARED_FLOOR = 0;

/** Wall coordinates → world: `a` along the wall, `v` away from it (positive: out of the building, negative: into it). */
function frame(core: Box, side: MemberSide): (a: number, v: number) => [number, number] {
  if (side === 'e') return (a, v) => [core.maxX + v, a];
  if (side === 'w') return (a, v) => [core.minX - v, a];
  return (a, v) => [a, core.minZ - v];
}

function boxOf(p: [number, number], q: [number, number]): Box {
  return { minX: Math.min(p[0], q[0]), maxX: Math.max(p[0], q[0]), minZ: Math.min(p[1], q[1]), maxZ: Math.max(p[1], q[1]) };
}

/**
 * Where rooms can be attached, best first. This depends on the stored layout only — never on who is connected —
 * so the n-th member to arrive always gets the same place.
 *
 * Along each wall (not the entrance wall) rooms are packed one after another wherever a door can be cut: the
 * doorway must be clear on the office side (no furniture, no wall meeting the outer wall there, nothing hanging
 * on it) and reachable on foot. The west wall is filled first, then the north, then the east — the command
 * centre's panel covers the east side of the picture, so rooms there are the last to be used. On each wall the
 * door nearest the middle of its room goes first and its neighbours follow, so members sit side by side where the
 * wall allows.
 *
 * The boundary: a member's room hangs off the shared part of the office only — its door opens into a hall, the open
 * floor or reception, never into a closed room. A room behind the meeting room, reached by walking through a
 * meeting, is not a place to work; the same goes for the server room, the break room and the CEO's office. Places
 * are found over the whole wall as before and then kept only where the door is in the shared part, so the places
 * that were good already stay exactly where they were.
 */
function slots(core: World): Slot[] {
  const b = core.bounds;
  const blockers = [...core.obstacles, ...wallFixtures(core)];
  const reach = core.nav.reach(core.spawn.x, core.spawn.z);
  const perSide: Array<{ side: MemberSide; list: Slot[] }> = [];
  for (const side of ['w', 'n', 'e'] as const) {
    const at = frame(b, side);
    const [min, max] = side === 'n' ? [b.minX, b.maxX] : [b.minZ, b.maxZ];
    const free = (a0: number, a1: number, v0: number, v1: number): boolean => {
      const box = boxOf(at(a0, -v0), at(a1, -v1));
      return !blockers.some((o) => overlap(box, o));
    };
    const doorOk = (c: number): boolean => {
      if (!free(c - DOOR_WIDTH / 2 - 0.15, c + DOOR_WIDTH / 2 + 0.15, 0.12, 1.6)) return false;
      const [x, z] = at(c, -0.9);
      return reach(x, z);
    };
    const plaqueOk = (c: number, dir: 1 | -1): boolean => {
      const a0 = c + dir * (DOOR_WIDTH / 2 + 0.15);
      const a1 = c + dir * (DOOR_WIDTH / 2 + 1.5);
      return Math.min(a0, a1) > min + 0.2 && Math.max(a0, a1) < max - 0.2 && free(Math.min(a0, a1), Math.max(a0, a1), 0.12, 0.4);
    };
    const quality = (c: number): Slot['quality'] => {
      const [x, z] = at(c, -0.9);
      const r = core.rooms.find((o) => !o.open && x > o.x && x < o.x + o.w && z > o.z && z < o.z + o.d);
      return !r ? 0 : r.kind === 'ceo' ? 2 : 1;
    };
    const list: Slot[] = [];
    const step = 0.2;
    let s = min;
    while (s + ROOM_ALONG <= max + 1e-6) {
      const mid = s + ROOM_ALONG / 2;
      let best: Slot | null = null;
      let bestScore = Infinity;
      for (let c = s + 1.2; c <= s + ROOM_ALONG - 1.2 + 1e-6; c += step) {
        if (!doorOk(c)) continue;
        const dir = plaqueOk(c, 1) ? 1 : plaqueOk(c, -1) ? -1 : 0;
        const q = quality(c);
        // What the door opens into matters most, then free wall beside it for the plaque, then a door in the middle of the room.
        const score = q * 100 + (dir ? 0 : 10) + Math.abs(c - mid);
        if (score < bestScore - 1e-9) {
          bestScore = score;
          best = { side, start: round(s), door: round(c), plaqueDir: dir, quality: q };
        }
      }
      if (best) {
        list.push(best);
        s += ROOM_ALONG;
      } else s += step;
    }
    perSide.push({ side, list });
  }
  const ordered: Slot[] = [];
  for (const { list } of perSide) {
    const usable = list.filter((x) => x.quality === SHARED_FLOOR);
    const first = usable[0];
    if (first) ordered.push(...usable.sort((p, q) => Math.abs(p.start - first.start) - Math.abs(q.start - first.start)));
  }
  return ordered;
}

const slotCache = new WeakMap<OfficeLayout, Map<string, { core: World; slots: Slot[] }>>();

function slotsOf(layout: OfficeLayout, unlocked: Set<string>): { core: World; slots: Slot[] } {
  // Layouts are replaced, never changed in place, so the places a layout offers are worked out once.
  let byUnlock = slotCache.get(layout);
  if (!byUnlock) slotCache.set(layout, (byUnlock = new Map()));
  const key = [...unlocked].sort().join(',');
  let hit = byUnlock.get(key);
  if (!hit) {
    const core = buildWorld(layout, unlocked);
    byUnlock.set(key, (hit = { core, slots: slots(core) }));
  }
  return hit;
}

function buildRoom(core: Box, slot: Slot, host: MemberHost): { room: MemberRoom; def: RoomDef; desks: Desk[]; decorations: OfficeLayout['decorations'] } {
  const at = frame(core, slot.side);
  const prefs = host.prefs ?? {};
  // Room for every employee, for as many desks as the member asked for, and for the furthest seat anyone chose.
  const count = memberDeskCount(host.employeeIds.length, Math.max(prefs.desks ?? 0, ...Object.values(host.seats ?? {})));
  // The open floor the member asked for is behind the desks, at the far end from the door.
  const lounge = Math.max(0, Math.min(MEMBER_ROOM_LIMITS.extraDepth, prefs.extraDepth ?? 0));
  const depth = memberRoomDepth(count) + lounge;
  const furniture = prefs.furniture ?? ['plant', 'bookshelf'];
  const rect = boxOf(at(slot.start, 0), at(slot.start + ROOM_ALONG, depth));
  const roomId = `m:${host.hostId}`;
  // Desks face each other across a pod, as in the office: the first pair has its back to the door, so the
  // screens are what one sees coming in. `rot` turns a desk so that its chair is on the door side.
  const rot = slot.side === 'e' ? Math.PI / 2 : slot.side === 'w' ? -Math.PI / 2 : Math.PI;
  const desks: Desk[] = [];
  const lights: Array<[number, number]> = [];
  const mid = slot.start + ROOM_ALONG / 2;
  for (let i = 0; i < count; i++) {
    const pod = Math.floor(i / 4);
    const n = i % 4;
    const v = POD_FIRST + POD_PITCH * pod + (n < 2 ? -0.5 : 0.5);
    const [x, z] = at(mid + (n % 2 ? 0.95 : -0.95), v);
    desks.push({ id: `${roomId}:${i + 1}`, x: round(x), z: round(z), rot: n < 2 ? rot : rot + Math.PI, zone: `member:${host.memberId}`, kind: 'standard' });
    if (n === 0) for (const side of [-1.3, 1.3]) lights.push(at(mid + side, POD_FIRST + POD_PITCH * pod).map(round) as [number, number]);
  }
  // The open floor is lit too: a pair of panels every four metres.
  for (let v = depth - lounge + 2; v < depth - 0.5; v += 4) for (const side of [-1.3, 1.3]) lights.push(at(mid + side, v).map(round) as [number, number]);
  const [dx, dz] = at(slot.door, 0);
  const [px, pz] = at(slot.door + slot.plaqueDir * (DOOR_WIDTH / 2 + 0.82), -0.07);
  // Facing into the office: the opposite of "away from the building".
  const facing = slot.side === 'e' ? -Math.PI / 2 : slot.side === 'w' ? Math.PI / 2 : 0;
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;
  // A bookshelf against the back wall and a plant in the corner beside it; the other back corner stays free to walk round the desks.
  const [plantX, plantZ] = at(slot.start + ROOM_ALONG - 0.5, depth - 0.5);
  const [shelfX, shelfZ] = at(slot.start + ROOM_ALONG - 1.7, depth - 0.33);
  const doorIn = boxOf(at(slot.door - DOOR_WIDTH / 2, 0), at(slot.door + DOOR_WIDTH / 2, -0.6));
  // The member's servers stand against the back wall from the corner opposite the bookshelf: after the floor lamp when
  // there is one, and as far as the sofa (or, without one, the bookshelf) leaves room. A room has what fits; the rest
  // are in My room all the same.
  const firstServer = slot.start + (furniture.includes('floor_lamp') ? 1.2 : 0.5);
  const lastServer = furniture.includes('sofa') && lounge >= 2 ? mid - 0.6 - 1.3 : slot.start + ROOM_ALONG - 2.8;
  const serversFit = Math.max(0, Math.floor((lastServer - firstServer) / SERVER_PITCH + 1e-6) + 1);
  const room: MemberRoom = {
    hostId: host.hostId,
    memberId: host.memberId,
    memberName: host.memberName,
    title: prefs.title?.trim() ? prefs.title.trim().toUpperCase() : memberRoomTitle(host.memberName),
    locked: host.locked === true,
    closed: host.closed === true && host.locked !== true,
    side: slot.side,
    roomId,
    x: round(rect.minX),
    z: round(rect.minZ),
    w: round(w),
    d: round(d),
    desks: desks.map((k) => k.id),
    employees: host.employeeIds.length,
    unseated: Math.max(0, host.employeeIds.length - count),
    door: { x: round(dx), z: round(dz), width: DOOR_WIDTH, rot: facing },
    plaque: { x: round(px), z: round(pz), rot: facing, above: slot.plaqueDir === 0 },
    // Along the room's south wall at the end nearest the building, or just inside the door of a room on the north
    // side: clear of the desks either way, and in view of the command centre's camera however far the room reaches.
    label: { x: round(slot.side === 'w' ? rect.maxX - 0.9 - LABEL_W / 2 : slot.side === 'e' ? rect.minX + 0.9 + LABEL_W / 2 : rect.minX + w / 2), z: round(rect.maxZ - 0.72), w: LABEL_W, h: 0.8 },
    servers: (host.servers ?? []).slice(0, serversFit).map((sv, i) => {
      const [x, z] = at(firstServer + i * SERVER_PITCH, depth - SERVER_FROM_WALL);
      return { id: sv.id, x: round(x), z: round(z), rot: facing };
    }),
    lights: host.locked ? [] : lights,
    color: prefs.color ?? COLORS[hash(host.memberId) % COLORS.length]!,
    reach: { minX: Math.min(rect.minX, doorIn.minX), maxX: Math.max(rect.maxX, doorIn.maxX), minZ: Math.min(rect.minZ, doorIn.minZ), maxZ: Math.max(rect.maxZ, doorIn.maxZ) },
  };
  const def: RoomDef = {
    id: roomId,
    name: `${host.memberName}'s room`,
    kind: 'team',
    x: room.x,
    z: room.z,
    w: room.w,
    d: room.d,
    // The door is on the wall the room shares with the building.
    // A locked room has no opening: the wall is whole and a closed door is drawn on it. The same for a room its member closed.
    doors: host.locked || host.closed ? [] : [{ side: slot.side === 'e' ? 'w' : slot.side === 'w' ? 'e' : 's', at: (slot.door - slot.start) / ROOM_ALONG, width: DOOR_WIDTH }],
  };
  // What the member chose to have in the room, along the back wall: bookshelf and plant in one corner, the sofa
  // (when there is open floor for it) in the middle facing the desks, a lamp beside it.
  const has = (k: string) => furniture.includes(k as never);
  const [sofaX, sofaZ] = at(mid - 0.6, depth - 0.75);
  const [lampX, lampZ] = at(slot.start + 0.6, depth - 0.6);
  const decorations: OfficeLayout['decorations'] = [
    ...(has('plant') ? [{ id: `${roomId}:plant`, kind: 'plant', x: round(plantX), z: round(plantZ), rot: 0 }] : []),
    // Against the back wall, its front to the room.
    ...(has('bookshelf') ? [{ id: `${roomId}:shelf`, kind: 'bookshelf', x: round(shelfX), z: round(shelfZ), rot: facing }] : []),
    // A sofa needs floor of its own: it comes with at least two metres of open floor.
    ...(has('sofa') && lounge >= 2 ? [{ id: `${roomId}:sofa`, kind: 'sofa', x: round(sofaX), z: round(sofaZ), rot: facing }] : []),
    ...(has('floor_lamp') ? [{ id: `${roomId}:lamp`, kind: 'floor_lamp', x: round(lampX), z: round(lampZ), rot: 0 }] : []),
  ];
  return { room, def, desks, decorations };
}

/**
 * The office as it is drawn: the stored layout plus one room for each connected member.
 *
 * `hosts` are the members' own computers that are online, in a stable order (by when they were enrolled); each
 * gets the next free place along the outer walls (see `slots`). An office without connected members gets its
 * stored layout back, the very same object.
 */
export function withMemberRooms(layout: OfficeLayout, hosts: MemberHost[], unlocked: Set<string> = new Set()): MemberOffice {
  const deskOf = new Map<string, string>();
  if (!hosts.length) return { layout, rooms: [], deskOf, unplaced: [] };
  const { core, slots: places } = slotsOf(layout, unlocked);
  const rooms: MemberRoom[] = [];
  const defs: RoomDef[] = [];
  const desks: Desk[] = [];
  const decorations: OfficeLayout['decorations'] = [];
  const unplaced: string[] = [];
  hosts.forEach((host, i) => {
    const slot = places[i];
    if (!slot) {
      unplaced.push(host.hostId);
      return;
    }
    const built = buildRoom(core.bounds, slot, host);
    rooms.push(built.room);
    defs.push(built.def);
    desks.push(...built.desks);
    decorations.push(...built.decorations);
    // Chosen seats first (one employee per seat, inside the room); everyone else takes the free seats in order.
    const taken = new Map<number, string>();
    for (const id of host.employeeIds) {
      const n = host.seats?.[id];
      if (n && n >= 1 && n <= built.desks.length && !taken.has(n)) taken.set(n, id);
    }
    const placed = new Set(taken.values());
    for (const [n, id] of taken) deskOf.set(id, built.desks[n - 1]!.id);
    let next = 1;
    for (const id of host.employeeIds) {
      if (placed.has(id)) continue;
      while (next <= built.desks.length && taken.has(next)) next++;
      if (next > built.desks.length) break;
      deskOf.set(id, built.desks[next - 1]!.id);
      taken.set(next, id);
    }
  });
  if (!rooms.length) return { layout, rooms, deskOf, unplaced };
  const effective: EffectiveLayout = { ...layout, rooms: [...layout.rooms, ...defs], desks: [...layout.desks, ...desks], decorations: [...layout.decorations, ...decorations], base: layout, memberRooms: rooms };
  return { layout: effective, rooms, deskOf, unplaced };
}

/** What is written on a member's room. */
export function memberRoomTitle(name: string): string {
  const n = name.trim() || 'Member';
  return `${n.toUpperCase()}'S ROOM`;
}
