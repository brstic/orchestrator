import { useFrame } from '@react-three/fiber';
import { useState } from 'react';
import type { Appearance } from '@orchestrator/contracts';
import { Character, type PoseName } from '../Character.tsx';

/** One figure of a character sheet: a look, a pose, and where it stands. */
export interface LineupEntry {
  appearance: Appearance;
  pose?: PoseName;
  level?: number;
  x: number;
  z: number;
  rot?: number;
  offline?: boolean;
  whip?: boolean;
  /** Lift (metres), e.g. to stand a row on a step behind another. */
  y?: number;
  /** Held perfectly still (no breathing, no blinking): whatever then changes from frame to frame is the drawing, not the figure. */
  still?: boolean;
}

const STILL = () => true;

/**
 * For looking at characters, not part of the office: `window.__orchScene.lineup = [{ appearance, pose, level, x, z, rot }]`
 * stands those figures on the floor (see `scripts/character-sheet.cjs`). Nothing is drawn until that is set, and
 * nobody but a capture script sets it.
 */
export function Lineup() {
  const [list, setList] = useState<LineupEntry[] | null>(null);
  useFrame(() => {
    const want = ((window as unknown as { __orchScene?: { lineup?: LineupEntry[] | null } }).__orchScene?.lineup ?? null) as LineupEntry[] | null;
    if (want !== list) setList(want);
  });
  if (!list) return null;
  return (
    <group name="lineup">
      {list.map((e, i) => (
        <group key={i} position={[e.x, e.y ?? 0, e.z]} rotation={[0, e.rot ?? 0, 0]}>
          <Character appearance={e.appearance} pose={e.pose ?? 'stand'} level={e.level ?? 1} offline={e.offline} whip={e.whip} phase={i * 1.7} frozen={e.still ? STILL : undefined} />
        </group>
      ))}
    </group>
  );
}
