/**
 * How the entrance page and the little office drawn on it share one floor.
 *
 * The page *is* the floor, seen from above and in front at a fixed angle with no perspective: a point of the page
 * `(x, y)` pixels from its top-left corner is the point `(x / ppu, 0, y / (ppu · sin))` of the scene, and a point
 * `h` metres above the floor is drawn `h · ppu · cos` pixels higher. So a desk stands still on the page while the
 * page scrolls, exactly as a picture would, and "further down the page" is "nearer to the viewer".
 *
 * No three.js here: the page needs these numbers before the scene's code has arrived.
 */

/** How steeply the floor is looked down on. */
export const PITCH = (40 * Math.PI) / 180;
export const SIN = Math.sin(PITCH);
export const COS = Math.cos(PITCH);

/** The size of things, measured once per layout by the page. */
export interface Geo {
  /** The visible part of the page, in pixels. */
  vw: number;
  vh: number;
  /** The whole page's height. */
  pageH: number;
  /** Pixels per metre. */
  ppu: number;
  /** How far the drawing reaches above and below what is visible, so that scrolling between two drawn frames shows no edge. */
  over: number;
  /** Where the figure walks when it is between places: a line down the page, `x` pixels from its left edge. */
  corridor: number;
}

/** Something of the scene, standing where the page left room for it: `(x, y)` is the page point of its origin on the floor. */
export interface Slot {
  id: string;
  kind: string;
  x: number;
  y: number;
}

/** The width kept free on the right for the figure and the furniture, and the scale that follows from it. */
export function laneOf(vw: number): { lane: number; ppu: number } {
  const lane = Math.max(300, Math.min(460, vw * 0.3));
  return { lane, ppu: lane / 3.9 };
}

export const overscanOf = (vh: number): number => Math.round(Math.min(360, vh * 0.32));
