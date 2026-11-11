/**
 * The gate of an open microphone: with the microphone always on, only what is loud enough to be someone speaking
 * is sent — the room's hum, a keyboard far away and silence are not. Plain arithmetic, run by the tests.
 */

/** How loud a frame has to be (root mean square, 0…1) to open the gate, unless the person set it otherwise. */
export const GATE_DEFAULT = 0.02;
export const GATE_MIN = 0.004;
export const GATE_MAX = 0.1;
/** Frames the gate stays open after the last loud one (about 0.45 s): the gaps between words are not cut out. */
export const GATE_HANG = 14;

export const cleanGate = (v: unknown, fallback = GATE_DEFAULT): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(GATE_MAX, Math.max(GATE_MIN, v)) : fallback);

/**
 * What to do with a frame:
 *   'open'  — speech begins: send it (and the frame before it, so the first sound is not clipped);
 *   'on'    — send it;
 *   'close' — speech ended: do not send it, say that it is over;
 *   'off'   — do not send it.
 */
export type GateStep = 'open' | 'on' | 'close' | 'off';

export function makeGate(hang = GATE_HANG): { step: (level: number, threshold: number) => GateStep; reset: () => boolean } {
  let left = 0;
  return {
    step(level, threshold) {
      if (level >= threshold) {
        const was = left > 0;
        left = hang;
        return was ? 'on' : 'open';
      }
      if (left > 0) return --left === 0 ? 'close' : 'on';
      return 'off';
    },
    /** Shut it at once; true when it was open (so the other side has to be told). */
    reset() {
      const was = left > 0;
      left = 0;
      return was;
    },
  };
}
