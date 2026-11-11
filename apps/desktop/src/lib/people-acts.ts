/**
 * The arithmetic behind what a person does with their character among the other people: which gesture the mouse
 * points at on the wheel, and who the whip is for. Nothing here needs a window: the tests run it as it is.
 */

/** How far from the middle the pointer has to be before a gesture is picked, and where the wheel's ring ends, in pixels. */
export const WHEEL_DEAD = 34;
export const WHEEL_REACH = 128;

/** Which of `n` slices a direction falls into: slice 0 is straight up, and they go round clockwise. `null` in the middle. */
export function sliceAt(dx: number, dy: number, n: number, dead = WHEEL_DEAD): number | null {
  if (!(Math.hypot(dx, dy) >= dead)) return null;
  const turn = (Math.atan2(dx, -dy) / (Math.PI * 2) + 1) % 1;
  return Math.round(turn * n) % n;
}

/**
 * The other person nearest this one's character, if within a whip's reach and not behind their back: who the whip
 * is for when no employee is. `null`: nobody.
 */
export function personInReach(people: Array<{ id: string; x: number; z: number }>, me: { x: number; z: number; rot: number }, myId: string, reach = 3.4): string | null {
  let best: string | null = null;
  let bestD = reach;
  for (const p of people) {
    if (p.id === myId) continue;
    const dx = p.x - me.x;
    const dz = p.z - me.z;
    const d = Math.hypot(dx, dz);
    if (!(d < bestD)) continue;
    // In front or beside (the character faces +z turned by `rot`): not someone straight behind, unless they stand on one's toes.
    const ahead = (dx * Math.sin(me.rot) + dz * Math.cos(me.rot)) / (d || 1);
    if (d > 0.9 && ahead < -0.35) continue;
    best = p.id;
    bestD = d;
  }
  return best;
}
