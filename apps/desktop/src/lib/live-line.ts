/**
 * The one line under a conversation that says what the employee is doing right now. Everything on it is already in
 * the window — the session's activity and its detail (from Claude Code's hooks), the note of the task in progress —
 * so it costs no request and nothing is kept: what the line remembers (the last step, how many it has seen) lives
 * only while the window is open.
 */

/** What the line has seen of the turn in progress. */
export interface Trail {
  /** The last step that had something to say ("Edit src/auth.ts"), kept while the session is back to thinking. */
  last: string | null;
  /** How many steps this window has seen in this turn. */
  steps: number;
  /** The moment (`activitySince`) of the step counted last, so that the same step is not counted twice. */
  at: string | null;
}
export const NO_TRAIL: Trail = { last: null, steps: 0, at: null };

/** The session's activity changed: what the line remembers after it. Between turns it remembers nothing. */
export function stepInto(trail: Trail, working: boolean, detail: string | null | undefined, since: string | null | undefined): Trail {
  if (!working) return trail.steps || trail.last ? NO_TRAIL : trail;
  const said = detail?.trim();
  if (!said || (since ?? null) === trail.at) return trail;
  return { last: said, steps: trail.steps + 1, at: since ?? null };
}

/** How long, for a line that changes every second: "8 s", "2 min 05 s", "1 h 12 min". */
export function took(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

export type LiveTone = 'think' | 'read' | 'write' | 'run' | 'test' | 'wait' | 'bad' | 'quiet';

const TONES: Record<string, LiveTone> = {
  thinking: 'think', planning: 'think', delegating: 'think',
  reading: 'read', researching: 'read', reviewing: 'read',
  coding: 'write', debugging: 'write',
  running_command: 'run',
  testing: 'test',
  waiting_answer: 'wait', waiting_input: 'wait', needs_approval: 'wait', waiting_command: 'wait',
  blocked: 'bad',
};
/** The colour family of an activity: thinking, reading, writing, running, testing, waiting, in trouble, or nothing going on. */
export const toneOf = (activity: string): LiveTone => TONES[activity] ?? 'quiet';

/** A line of the feed, split so that ticket keys ("T-212") can be drawn as keys. */
export function withKeys(text: string): Array<{ text: string; key: boolean }> {
  const out: Array<{ text: string; key: boolean }> = [];
  let at = 0;
  for (const m of text.matchAll(/\b[A-Z]{1,5}-\d+\b/g)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), key: false });
    out.push({ text: m[0], key: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), key: false });
  return out;
}
