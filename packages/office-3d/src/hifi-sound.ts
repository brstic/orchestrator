/**
 * How loud the office hi-fi is where someone stands. The music plays for the whole office: full next to the
 * hi-fi, quieter with every step away, and never silent — at the far desks it is still there, quietly.
 * Walls do not count: only the distance on the floor.
 */

/** Within this many metres of the hi-fi the music is at full loudness. */
export const HIFI_NEAR = 3;
/** From this far on it stays at the quiet floor. The far corners of the standard office are about 36 m from the hi-fi. */
export const HIFI_FAR = 36;
/** How much is left at the far end of the office (of the listener's own volume). */
export const HIFI_FLOOR = 0.14;

/**
 * Loudness (HIFI_FLOOR…1) at a distance in metres. It eases out of full loudness, falls fastest some metres on
 * and levels out towards the far end, with no step and no kink anywhere: the slope is zero at both ends of the fall.
 */
export function hifiFalloff(distance: number): number {
  if (!(distance > HIFI_NEAR)) return 1; // also for a distance that is not a number
  if (distance >= HIFI_FAR) return HIFI_FLOOR;
  const u = (distance - HIFI_NEAR) / (HIFI_FAR - HIFI_NEAR);
  // A smoothstep over a bent distance: more than half of the fall happens in the first third of the way.
  const v = (1.8 * u) / (u + 0.8);
  return HIFI_FLOOR + (1 - HIFI_FLOOR) * (1 - v * v * (3 - 2 * v));
}

/**
 * Where the hi-fi stands in the office that is drawn (null: this office has none), kept current by the scene
 * like `ownerPosition`, so what is heard is measured in the same world that is seen.
 */
export const hifiPosition: { at: { x: number; z: number } | null } = { at: null };

/** How loud the hi-fi is for someone standing at (x, z). In an office without a hi-fi there is nothing to be far from: full. */
export function hifiLoudnessAt(x: number, z: number): number {
  const at = hifiPosition.at;
  return at ? hifiFalloff(Math.hypot(x - at.x, z - at.z)) : 1;
}
