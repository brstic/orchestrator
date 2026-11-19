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
  /** Milliseconds one drawing of the office took, on average over the last second (the main thread's share). */
  cost: number;
  /** The most it may be drawn at now (`drawCap`): 0 while nobody can see it, null when as fast as the display goes. */
  cap: number | null;
}

/**
 * Whether the window can be seen at all, as the app tells it. Electron's window keeps running in the background (the
 * terminals need it), and then the page is never told it was minimized or hidden — the app is (`main.cjs`).
 */
export const paceView = { shown: true };

/** Without a touch of the mouse or the keyboard for this long, a window in front is drawn as one in the background. */
export const IDLE_AFTER = 90_000;
/** Behind another window, a touch (the mouse over it) brings it to the working pace for this long. */
export const HOVER_FOR = 5_000;
/**
 * The most it is drawn at while somebody works in it, on every setting (High is more detail, not more frames). A 144 Hz
 * display drew it 144 times a second — a whole core of the computer, for motion nobody tells from 72. Drawn on every
 * second refresh there (72), every second on 120 Hz (60), every one on 60 Hz: always an even rhythm.
 */
export const WORKING_FPS = 75;
/** Frames a second for an office nobody is working in: still smooth to watch, a third to a quarter of the work. */
export const RESTING_FPS = 30;

/**
 * How fast the office may be drawn now (frames a second): not at all while it
 * cannot be seen (minimized, hidden, a tab in the background); at a resting pace while another window has the focus
 * (unless the mouse moves over it) or nobody has touched it for a while; at the working pace while somebody works in it.
 */
export function drawCap(v: { shown: boolean; focused: boolean; idleMs: number }): number {
  if (!v.shown) return 0;
  // (The mouse moving over it, or a key, counts even without the focus: somebody is looking at it.)
  if (v.idleMs < (v.focused ? IDLE_AFTER : HOVER_FOR)) return WORKING_FPS;
  return RESTING_FPS;
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
 * And no faster than it is looked at, nor faster than the eye gains from (`drawCap`): the office drawn 60–120 times a second behind another window, or
 * minimized, was most of what the app cost the computer.
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
    let spent = 0;
    let fpsFrom = 0;
    const pace: Pace = ((window as unknown as { __orchPace?: Pace }).__orchPace = { display, every, fps: 0, cost: 0, cap: null });
    // Is anybody looking, and working in it?
    let focused = document.hasFocus();
    let touched = performance.now();
    let drewAt = -Infinity;
    const touch = () => {
      touched = performance.now();
    };
    const onFocus = () => {
      focused = true;
      touch();
    };
    const onBlur = () => {
      focused = false;
    };
    const INPUT = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const ev of INPUT) window.addEventListener(ev, touch, { capture: true, passive: true });
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

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
      const cap = drawCap({ shown: paceView.shown && !document.hidden, focused, idleMs: t - touched });
      pace.cap = cap === Infinity ? null : cap;
      if (cap < Infinity) {
        // (A fifth of slack, so that 30 on a 60 Hz display is every second refresh and 75 on 144 Hz every second one —
        // not every third: a refresh comes a little early or late.)
        if (cap === 0 || t - drewAt < (1000 / cap) * 0.8) {
          if (cap === 0) pace.fps = 0;
          return;
        }
        // Frames skipped on purpose are not frames that came late.
        late = 0;
        seen = 0;
      }
      drewAt = t;

      const before = performance.now();
      advance((t - start) / 1000);
      const cost = performance.now() - before;
      drawn++;
      spent += cost;
      if (t - fpsFrom >= 1000) {
        pace.fps = Math.round((drawn * 1000) / (t - fpsFrom));
        pace.cost = Math.round((spent / drawn) * 100) / 100;
        spent = 0;
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
    return () => {
      cancelAnimationFrame(raf);
      for (const ev of INPUT) window.removeEventListener(ev, touch, { capture: true });
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
