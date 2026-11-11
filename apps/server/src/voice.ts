/**
 * Talking in the office: who hears whom.
 *
 * People hold a key and speak; their window sends short frames of sound to the office, and the office passes each
 * frame on to the windows of those who are within earshot — nobody else receives it. How loud it is for each of
 * them is worked out in their own window, from how far apart the two characters stand (`packages/office-3d`,
 * `voice-sound.ts`); what is decided here is only whether they hear it at all:
 *
 *   - not beyond `VOICE_RANGE` metres;
 *   - a meeting room keeps what is said in it: someone inside is heard only by those inside the same room, and
 *     hears nobody outside it. That is what a meeting room is for.
 *
 * The office keeps no sound: a frame is passed on and forgotten.
 */
import type { OfficeLayout } from '@orchestrator/contracts';

/** Beyond this many metres a voice is not passed on. (Windows fade it out a little before that.) */
export const VOICE_RANGE = 26;
/** One frame: 40 ms of 16 kHz mono, one byte a sample, as base64 — and no more than this many characters. */
export const VOICE_FRAME_MAX = 2400;
/** Frames a window may send in a second (25 are needed; the rest is slack for a burst after a hiccup). */
export const VOICE_FRAMES_PER_SECOND = 45;

export interface Spot {
  x: number;
  z: number;
}

/** The meeting room a point is in (its id), or null: everywhere else is one open space as far as voices go. */
export function soundRoom(layout: Pick<OfficeLayout, 'rooms'> | null | undefined, at: Spot): string | null {
  for (const r of layout?.rooms ?? []) {
    if (r.kind !== 'meeting' || r.open) continue;
    if (at.x > r.x && at.x < r.x + r.w && at.z > r.z && at.z < r.z + r.d) return r.id;
  }
  return null;
}

/** Does someone standing at `listener` hear someone speaking at `speaker`? */
export function hears(layout: Pick<OfficeLayout, 'rooms'> | null | undefined, speaker: Spot, listener: Spot): boolean {
  if (soundRoom(layout, speaker) !== soundRoom(layout, listener)) return false;
  return Math.hypot(speaker.x - listener.x, speaker.z - listener.z) <= VOICE_RANGE;
}

/** Is this what a window may send as a frame of sound? */
export function validFrame(data: unknown): data is string {
  return typeof data === 'string' && data.length > 0 && data.length <= VOICE_FRAME_MAX && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}
