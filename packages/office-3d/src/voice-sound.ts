/**
 * How loud someone's voice is where the listener's character stands. Unlike the hi-fi, a voice does not fill the
 * office: it is full when the two stand together, falls off with every step, and is gone some desks away.
 * (Whether a voice reaches a window at all — the range, and the meeting room that keeps it in — is decided by
 * the office: `apps/server/src/voice.ts`. This is only how loud what did arrive is played.)
 */

/** Within this many metres a voice is at full loudness: people standing together. */
export const VOICE_NEAR = 2.5;
/** From this far on nothing is heard. A little inside the office's own range, so a voice fades out rather than being cut. */
export const VOICE_FAR = 22;

/**
 * Loudness (0…1) at a distance in metres: 1 up close, easing out of it, falling fastest in the first metres after
 * and reaching 0 at `VOICE_FAR` with no step and no kink.
 */
export function voiceFalloff(distance: number): number {
  if (!(distance > VOICE_NEAR)) return 1; // also for a distance that is not a number
  if (distance >= VOICE_FAR) return 0;
  const u = (distance - VOICE_NEAR) / (VOICE_FAR - VOICE_NEAR);
  // A smoothstep over a bent distance: three metres further off is already clearly quieter, the last metres barely differ.
  const v = (1.5 * u) / (u + 0.5);
  return 1 - v * v * (3 - 2 * v);
}

/** Within this many metres a crack of the whip is at full loudness. */
export const CRACK_NEAR = 3;
/** From this far on it is not heard: a whip carries further than a voice, and not across the whole office. */
export const CRACK_FAR = 30;

/**
 * Loudness (0…1) of a crack of the whip — and of the yelp that answers it — at a distance in metres. The same shape
 * as a voice: full beside it, clearly quieter a few metres off, gone at the far end of the floor. A distance nobody
 * knows (somebody with no character in the office) is heard at half.
 */
export function crackFalloff(distance: number | null | undefined): number {
  if (distance == null || Number.isNaN(distance)) return 0.5;
  if (distance <= CRACK_NEAR) return 1;
  if (distance >= CRACK_FAR) return 0;
  const u = (distance - CRACK_NEAR) / (CRACK_FAR - CRACK_NEAR);
  const v = (1.5 * u) / (u + 0.5);
  return 1 - v * v * (3 - 2 * v);
}
