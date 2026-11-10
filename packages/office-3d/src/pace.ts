import { advance } from '@react-three/fiber';
import { useEffect } from 'react';

/** What the loop is doing, for the settings page and the tests (`window.__orchPace`). */
export interface Pace {
  /** Milliseconds between two refreshes of this display. */
  display: number;
  /** The office is drawn on every `every`-th refresh. */
  every: number;
  /** Frames a second the office is being drawn at. */
  fps: number;
}

/**
 * Draws the office at an even rhythm.
 *
 * On a 120 Hz display a frame has 8 ms. When a busy office cannot be drawn that fast, drawing "as fast as possible"
 * lands some frames on one refresh and some on the next: the picture moves by uneven steps, which reads as stutter
 * even at 80–100 frames a second. A steady 60 looks far smoother than an unsteady 90. So: every refresh while that
 * holds; every second refresh when it does not; and back, after the office has been comfortably fast for a while
 * (trying again less and less often if it keeps failing). A 60 Hz display is always drawn on every refresh.
 *
 * The canvas must be mounted with `frameloop="never"`: this is its loop.
 */
export function usePacedLoop(): void {
  useEffect(() => {
    let raf = 0;
    let start = 0;
    let last = 0;
    let tick = 0;
    let every = 1;
    const gaps: number[] = [];
    let display = 16.7;
    // Frames that missed their refresh while drawing on every one; frames that were cheap while drawing on every second.
    let late = 0;
    let seen = 0;
    let easy = 0;
    let retryAfter = 4000;
    let slowSince = 0;
    let drawn = 0;
    let fpsFrom = 0;
    const pace: Pace = ((window as unknown as { __orchPace?: Pace }).__orchPace = { display, every, fps: 0 });

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!start) {
        start = t - 16;
        last = t - 16;
        fpsFrom = t;
      }
      const gap = t - last;
      last = t;
      // The display's own rhythm: the short end of what has been seen lately (a late frame only ever makes a gap longer).
      if (gap > 2 && gap < 100) {
        gaps.push(gap);
        if (gaps.length > 120) gaps.shift();
        if (gaps.length >= 20 && tick % 30 === 0) display = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.2)]!;
      }
      tick++;
      if (tick % every !== 0) return;

      const before = performance.now();
      advance((t - start) / 1000);
      const cost = performance.now() - before;
      drawn++;
      if (t - fpsFrom >= 1000) {
        pace.fps = Math.round((drawn * 1000) / (t - fpsFrom));
        drawn = 0;
        fpsFrom = t;
      }
      pace.display = display;
      pace.every = every;

      // Only a display faster than 60 Hz leaves the choice.
      if (display >= 12 || gaps.length < 60) return;
      if (every === 1) {
        seen++;
        if (gap > display * 1.45) late++;
        if (seen >= 90) {
          // One frame in six missing its refresh is what the eye picks up as stutter.
          if (late >= 15) {
            every = 2;
            easy = 0;
            // Just went back up and it did not hold: wait longer before the next try.
            if (slowSince && t - slowSince < 6000) retryAfter = Math.min(60000, retryAfter * 2);
            slowSince = t;
          } else if (late <= 3 && slowSince && t - slowSince > 20000) retryAfter = 4000;
          late = 0;
          seen = 0;
        }
      } else {
        // Comfortably inside one refresh for long enough: every refresh can be tried again.
        easy = cost < display * 0.5 ? easy + 1 : 0;
        if (easy * display * 2 >= retryAfter) {
          every = 1;
          late = 0;
          seen = 0;
          slowSince = t;
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}
