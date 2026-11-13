/**
 * Cracking the whip at somebody who has left their chair — on a break, at the board, at a colleague's desk — sends
 * them running back to it. Not always at the first crack: some need one, some two or three, and which is which
 * changes from day to day. It is a gag on top of a gag: nothing is sent to anybody's session (that is the crack at a
 * sleeper, which the office does), only the character moves.
 *
 * Pure, so that every window draws the same: the cracks are the office's (`whipped`, with its time), and how
 * stubborn somebody is comes from who they are and what day it is.
 */

/** Cracks further apart than this are not one telling-off. */
export const CRACK_WINDOW_MS = 25_000;
/** Once back at the desk, they stay put this long, whatever else would draw them away. */
export const BACK_FOR_MS = 4 * 60_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** How many cracks it takes to send this employee back today: one, two or three. */
export function cracksNeeded(employeeId: string, now: number): number {
  const day = Math.floor(now / 86_400_000);
  return 1 + (hash(`${employeeId}:${day}`) % 3);
}

export interface Told {
  /** Cracks in this telling-off so far, and when the last one landed. */
  hits: number;
  last: number;
  /** Sent back: at the desk until then. 0: not (yet). */
  until: number;
}

/**
 * One more crack lands on somebody who is away from their chair. Returns what they have been told so far —
 * `until` is set the moment they have had enough.
 */
export function crackAt(told: Told | undefined, employeeId: string, at: number): Told {
  const fresh = !told || at - told.last > CRACK_WINDOW_MS;
  const hits = fresh ? 1 : told.hits + 1;
  return { hits, last: at, until: hits >= cracksNeeded(employeeId, at) ? at + BACK_FOR_MS : 0 };
}

/** Are they on their way back, or kept at their desk, right now? */
export const sentBack = (told: Told | undefined, now: number): boolean => !!told && told.until > now;
