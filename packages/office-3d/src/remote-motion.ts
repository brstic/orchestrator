/**
 * Where another person's character is, between the reports that say where they were.
 *
 * A person's window reports its place about ten times a second; the office passes the reports on in batches. They
 * arrive unevenly — two close together, then a gap. A character that chases the newest report lurches after each one
 * and its legs, which walk by how the body really moves, stumble. So the character is drawn a moment in the past
 * (`REMOTE_DELAY`), at the place the reports say it had then: between two reports it moves evenly from one to the
 * other, by the *sender's* clock, so the unevenness of the way here does not show.
 */

export interface RemoteReport {
  x: number;
  z: number;
  rot: number;
  /** Under way at that moment, as the sender said. A report that says "not moving" is where they then stood. */
  moving?: boolean;
  /** The sender's clock when it reported this (ms), where its window sends one. */
  at?: number;
}

interface Snap {
  /** The time (ms) this place belongs to, on the clock the reports are kept in. */
  t: number;
  x: number;
  z: number;
  rot: number;
  moving: boolean;
}

/**
 * How far in the past another person's character is drawn (ms). A window reports every 100 ms (give or take its
 * timer) and the office passes reports on every 100 ms, so two that follow each other can reach us nearly 300 ms
 * apart; drawn this far back, there is a later report to move towards when one is needed. The character is never
 * moved ahead of what was reported — guessing ahead means stepping back when the guess was wrong.
 */
export const REMOTE_DELAY = 300;
/** A window reports this often while its person moves (ms). */
const STEP = 100;
/** Farther than this between two reports is not walking: the character is put there. */
const TELEPORT = 6;

const wrap = (a: number): number => {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class RemoteTrack {
  /** Reports, in the sender's time (or, from a window that sends none, in ours as they arrived). */
  private buf: Snap[] = [];
  /** The smallest difference seen between our clock and the sender's (ms): the truest measure of how its time maps onto ours. */
  private best: number | null = null;
  /** The difference the character is drawn by; it follows `best` gently, so a correction never shows as a jump. */
  private used: number | null = null;
  private sampledAt: number | null = null;

  /** A report arrived (`seen`: our clock, ms). */
  push(r: RemoteReport, seen: number): void {
    const stamped = typeof r.at === 'number' && Number.isFinite(r.at);
    let t = stamped ? r.at! : seen;
    const est = seen - t;
    // The quickest trip so far is the truest; it may creep up, so a clock that drifts is followed. A leap of seconds
    // (a different window, a clock that was set) starts the measure again.
    if (this.best === null || Math.abs(est - this.best) > 5000) {
      this.best = est;
      this.used = est;
      this.buf = [];
    } else this.best = Math.min(est, this.best + 1);
    const last = this.buf[this.buf.length - 1];
    if (last) {
      if (Math.hypot(r.x - last.x, r.z - last.z) > TELEPORT) this.buf = [];
      else {
        if (t <= last.t) t = last.t + 1;
        // They had come to a stop there (their last report said so) and have set off since: they stood at that place
        // until one report's time before this one — not drifting towards here all the while.
        if (!last.moving && t - last.t > STEP * 1.5) this.buf.push({ ...last, t: t - STEP });
      }
    }
    this.buf.push({ t, x: r.x, z: r.z, rot: r.rot, moving: r.moving !== false });
    if (this.buf.length > 24) this.buf.splice(0, this.buf.length - 24);
  }

  /** Where the character is at our time `now` (ms). Null before the first report. */
  sample(now: number): { x: number; z: number; rot: number } | null {
    const b = this.buf;
    if (!b.length || this.best === null || this.used === null) return null;
    // Towards the better measure at a tenth of real time at most: the character plays a little faster or slower for a moment, it does not skip.
    const dt = this.sampledAt === null ? 0 : Math.max(0, Math.min(now - this.sampledAt, 250));
    this.sampledAt = now;
    const gap = this.best - this.used;
    this.used += Math.sign(gap) * Math.min(Math.abs(gap), dt * 0.1);
    const rt = now - this.used - REMOTE_DELAY;
    const first = b[0]!;
    if (b.length === 1 || rt <= first.t) return { x: first.x, z: first.z, rot: first.rot };
    const last = b[b.length - 1]!;
    // No later report yet: where they last were, until one comes.
    if (rt >= last.t) return { x: last.x, z: last.z, rot: last.rot };
    let i = b.length - 2;
    while (i > 0 && b[i]!.t > rt) i--;
    const a = b[i]!;
    const c = b[i + 1]!;
    const k = (rt - a.t) / (c.t - a.t);
    return { x: a.x + (c.x - a.x) * k, z: a.z + (c.z - a.z) * k, rot: a.rot + wrap(c.rot - a.rot) * k };
  }
}
