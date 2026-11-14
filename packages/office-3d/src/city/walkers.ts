/**
 * People on the pavements of the Skyline's city: who they are, and where each is at a given moment.
 *
 * Each walks round one block, on the pavement, one ring each way; where they are follows from the time alone
 * (`walkerAt`, mirrored for the graphics card in `skyline.ts`). The blocks they walk round are a pattern of
 * `WALK_BLOCKS` × `WALK_BLOCKS` laid round wherever one looks from, like the traffic. Far away they are drawn as one
 * simple shape; near the camera as the office's own characters (`CityWalkers.tsx`), in their own clothes.
 *
 * Nothing is drawn here.
 */
import type { Appearance } from '@orchestrator/contracts';
import { rng } from '../surroundings/kit.ts';
import { KERB, PITCH } from './blocks.ts';

/** The pattern of blocks walked round, each way. */
export const WALK_BLOCKS = 9;

export interface Walker {
  /** Where round its ring it was at time 0 (m), its speed (m/s; the sign says which way round), how far its ring is from the block's middle, its stride (m). */
  walk: [number, number, number, number];
  /** Which block of the pattern, from its middle. */
  block: [number, number];
  look: Appearance;
}

const SKINS = ['#f1d2b6', '#e0ac69', '#c68642', '#8d5524', '#5c3a21', '#f5cfa8'];
const HAIRS = ['#1b1612', '#3b2a1e', '#6b4a2b', '#a87b4f', '#d9c08a', '#8a8a8a', '#2b2b2b'];
const SHIRTS = ['#24324d', '#8c1f28', '#e8e6df', '#3d6e8f', '#5b4c3a', '#1c1c1e', '#9c7a2e', '#3e6b4f', '#c96b3c', '#6c5b9e', '#d8b4a0', '#4a4f57'];
const TROUSERS = ['#14161c', '#2b3550', '#5a5047', '#1f1f22', '#3b3f45', '#6b5a43'];
const STYLES: Appearance['hairStyle'][] = ['short', 'short', 'long', 'bun', 'curly', 'bald'];
const EXTRAS: Appearance['accessory'][] = ['none', 'none', 'none', 'glasses', 'headphones', 'cap'];

/** Everybody on the pavements. `perSide`: how many walk each ring of a block. */
export function cityWalkers(perSide: number): Walker[] {
  const random = rng(5150);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const out: Walker[] = [];
  const half = (WALK_BLOCKS - 1) / 2;
  for (let a = -half; a <= half; a++) {
    for (let b = -half; b <= half; b++) {
      for (const [ring, way] of [[KERB - 2.6, 1], [KERB - 1.6, -1]] as const) {
        for (let k = 0; k < perSide; k++) {
          const speed = (1.15 + random() * 0.5) * way;
          out.push({
            walk: [random() * 8 * ring, speed, ring, 1.35 + random() * 0.25],
            block: [a, b],
            look: { skin: pick(SKINS), hair: pick(HAIRS), hairStyle: pick(STYLES), shirt: pick(SHIRTS), pants: pick(TROUSERS), accessory: pick(EXTRAS), build: 0.92 + random() * 0.16 },
          });
        }
      }
    }
  }
  return out;
}

const near = (v: number, origin: number, period: number) => origin + ((((v - origin + period / 2) % period) + period) % period) - period / 2;

/** Where a walker is at `t`, seen from `origin`, which way they face (0 is +z) and how fast they go. */
export function walkerAt(w: Walker, t: number, origin: { x: number; z: number }): { x: number; z: number; heading: number; speed: number } {
  const [start, speed, r] = w.walk;
  const len = 8 * r;
  const s = ((((start + speed * t) % len) + len) % len);
  const side = Math.floor(s / (2 * r));
  const u = s - side * 2 * r - r;
  const [ax, az] = side === 0 ? [u, -r] : side === 1 ? [r, u] : side === 2 ? [-u, r] : [-r, -u];
  let heading = side === 0 ? Math.PI / 2 : side === 1 ? 0 : side === 2 ? -Math.PI / 2 : Math.PI;
  if (speed < 0) heading += Math.PI;
  const period = WALK_BLOCKS * PITCH;
  return { x: near(w.block[0] * PITCH, origin.x, period) + ax, z: near(w.block[1] * PITCH, origin.z, period) + az, heading, speed: Math.abs(speed) };
}
