import type { Desk, Milestone, OfficeLayout, RoomDef } from './entities.ts';

/**
 * The default headquarters floor plan. Units are metres; +X is east, +Z is
 * south. The layout is data: desks and rooms can be added, moved or unlocked
 * without touching rendering code.
 */
export const DESK_SIZE = { w: 1.7, d: 0.85, h: 0.74 };

function pod(prefix: string, cx: number, cz: number, zone: string): Desk[] {
  // Four desks back to back; employees sit on the outside facing the middle.
  return [
    { id: `${prefix}-a`, x: cx - 0.95, z: cz - 0.5, rot: 0, zone, kind: 'standard' },
    { id: `${prefix}-b`, x: cx + 0.95, z: cz - 0.5, rot: 0, zone, kind: 'standard' },
    { id: `${prefix}-c`, x: cx - 0.95, z: cz + 0.5, rot: Math.PI, zone, kind: 'standard' },
    { id: `${prefix}-d`, x: cx + 0.95, z: cz + 0.5, rot: Math.PI, zone, kind: 'standard' },
  ];
}

export function defaultLayout(): OfficeLayout {
  const rooms: RoomDef[] = [
    { id: 'ceo', name: 'CEO Office', kind: 'ceo', x: -22, z: -15, w: 10, d: 8.5, glass: true, doors: [{ side: 's', at: 0.72, width: 1.8 }] },
    { id: 'meeting', name: 'Meeting Room', kind: 'meeting', x: -12, z: -15, w: 11, d: 8.5, glass: true, doors: [{ side: 's', at: 0.5, width: 1.8 }] },
    { id: 'ops', name: 'Operations Room', kind: 'ops', x: -1, z: -15, w: 11, d: 8.5, doors: [{ side: 's', at: 0.5, width: 2.2 }] },
    { id: 'server', name: 'Server Room', kind: 'server', x: 10, z: -15, w: 12, d: 8.5, doors: [{ side: 's', at: 0.3, width: 1.6 }] },
    { id: 'hall', name: 'Hallway', kind: 'hall', x: -22, z: -6.5, w: 44, d: 2.5, open: true },
    { id: 'open', name: 'Engineering Floor', kind: 'open', x: -22, z: -4, w: 32, d: 19, open: true },
    { id: 'break', name: 'Break Room', kind: 'break', x: 10, z: -4, w: 12, d: 8.5, doors: [{ side: 'w', at: 0.5, width: 2.2 }, { side: 'n', at: 0.3, width: 1.8 }] },
    { id: 'reception', name: 'Reception', kind: 'reception', x: 10, z: 4.5, w: 12, d: 10.5, open: true },
    { id: 'team', name: 'Team Room', kind: 'team', x: -22, z: 9.5, w: 9, d: 5.5, glass: true, requires: 'team_room', doors: [{ side: 'e', at: 0.5, width: 1.8 }] },
  ];
  const desks: Desk[] = [
    ...pod('a', -16.5, -0.2, 'north'),
    ...pod('b', -9.5, -0.2, 'north'),
    ...pod('c', -2.5, -0.2, 'north'),
    ...pod('d', 4.5, -0.2, 'north'),
    ...pod('e', -9.5, 6.2, 'south'),
    ...pod('f', -2.5, 6.2, 'south'),
    ...pod('g', 4.5, 6.2, 'south'),
    ...pod('h', -9.5, 12, 'south'),
  ];
  return {
    version: 1,
    width: 44,
    depth: 30,
    rooms,
    desks,
    decorations: [
      { id: 'plant-1', kind: 'plant', x: -21, z: -3.2, rot: 0 },
      { id: 'plant-2', kind: 'plant', x: 9, z: 14, rot: 0 },
      { id: 'plant-3', kind: 'plant', x: -13.2, z: 3, rot: 0 },
      { id: 'plant-4', kind: 'plant', x: 8.8, z: -3.2, rot: 0 },
      { id: 'trophy', kind: 'trophy_case', x: 15.5, z: 14.3, rot: Math.PI, requires: 'first_delivery' },
      { id: 'arcade', kind: 'arcade', x: 21, z: 3.2, rot: -Math.PI / 2, requires: 'ten_tasks' },
      { id: 'neon', kind: 'neon_sign', x: 0, z: 14.85, rot: Math.PI, requires: 'fifty_tests' },
    ],
  };
}

/** Where an employee sits for a desk: just behind it, facing the monitor. */
export function deskSeat(desk: Desk): { x: number; z: number; rot: number } {
  const dx = Math.sin(desk.rot);
  const dz = Math.cos(desk.rot);
  return { x: desk.x - dx * 0.78, z: desk.z - dz * 0.78, rot: desk.rot };
}

/**
 * What can stand in the office as decoration. Footprints are in metres, before
 * rotation (w along X, d along Z). `unlock` names the company-milestone upgrade
 * that has to be reached before the owner may place one.
 */
export interface DecorationKind {
  kind: string;
  label: string;
  w: number;
  d: number;
  /** People cannot walk through it. */
  solid: boolean;
  unlock?: string;
}

export const DECORATION_KINDS: DecorationKind[] = [
  { kind: 'plant', label: 'Plant', w: 0.55, d: 0.55, solid: true },
  { kind: 'bookshelf', label: 'Bookshelf', w: 1.6, d: 0.4, solid: true },
  { kind: 'floor_lamp', label: 'Floor lamp', w: 0.4, d: 0.4, solid: true },
  { kind: 'sofa', label: 'Sofa', w: 2.0, d: 0.9, solid: true },
  { kind: 'employee_of_month', label: 'Employee of the month', w: 1.0, d: 0.5, solid: true },
  { kind: 'arcade', label: 'Arcade cabinet', w: 0.9, d: 0.9, solid: true, unlock: 'ten_tasks' },
  { kind: 'trophy_case', label: 'Trophy case', w: 2.0, d: 0.5, solid: true, unlock: 'first_delivery' },
  { kind: 'neon_sign', label: 'Neon sign', w: 4.5, d: 0.1, solid: false, unlock: 'fifty_tests' },
];

export function decorationKind(kind: string): DecorationKind | undefined {
  return DECORATION_KINDS.find((k) => k.kind === kind);
}

/** The floor area a decoration occupies, with its quarter-turn rotation applied. */
export function decorationBox(d: { kind: string; x: number; z: number; rot: number }): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  const k = decorationKind(d.kind);
  if (!k) return null;
  const turned = Math.abs(Math.sin(d.rot)) > 0.7;
  const w = turned ? k.d : k.w;
  const dd = turned ? k.w : k.d;
  return { minX: d.x - w / 2, maxX: d.x + w / 2, minZ: d.z - dd / 2, maxZ: d.z + dd / 2 };
}

/**
 * What the company's reached milestones open in the office, as the set that rooms and decorations are checked
 * against. A room or decoration names the milestone it waits for (`requires`, `unlock`: "ten_tasks"); a
 * milestone also names what it grants ("arcade"). Both names are in the set for every milestone that has been
 * reached and grants something — so the arcade stands once "ten_tasks" is reached, whichever of the two is asked for.
 */
export function unlockedUpgrades(milestones: Array<Pick<Milestone, 'key' | 'unlocks' | 'unlockedAt'>>): string[] {
  const out = new Set<string>();
  for (const m of milestones) {
    if (!m.unlockedAt || !m.unlocks) continue;
    out.add(m.key);
    out.add(m.unlocks);
  }
  return [...out];
}
