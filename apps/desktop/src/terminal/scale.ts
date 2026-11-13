/**
 * How large the letters of a watched terminal are drawn.
 *
 * Someone who only watches never changes the real terminal's size: its columns and rows are tmux's. So the pane is
 * drawn whole, with letters as large as the panel allows — whichever of width and height runs out first decides.
 */

/**
 * The largest and smallest letters, in pixels: a tiny pane does not become a poster, a huge one stays readable at all.
 * (The largest was 32 until 2026-11-13. Two wishes meet here: a pane must not be left small in a corner of a large
 * window — the reason it is scaled up at all — and on a very wide screen its letters must not be twice the size of
 * everything else. So it still grows to fill, up to 20 px; what makes the letters smaller for good is that sessions
 * now start wider, `SESSION_COLS`.)
 */
export const MAX_FONT = 20;
export const MIN_FONT = 6;

/**
 * What one character cell takes per pixel of font size, across and down. Measured from the terminal once it has
 * drawn (`cellRatios`); until then these stand in, on the careful side, so the first drawing is never cut off.
 */
export interface CellRatios {
  w: number;
  h: number;
}
export const FIRST_GUESS: CellRatios = { w: 0.62, h: 1.56 };

/** The ratios of a terminal that is on screen: the size of its drawing divided by its columns, rows and font size. */
export function cellRatios(screen: { width: number; height: number }, cols: number, rows: number, fontSize: number): CellRatios | null {
  if (!(screen.width > 0 && screen.height > 0 && cols > 0 && rows > 0 && fontSize > 0)) return null;
  return { w: screen.width / cols / fontSize, h: screen.height / rows / fontSize };
}

/** The font size (to a tenth of a pixel, rounded down) at which `cols` × `rows` fit into `width` × `height`. */
export function fontToFit(panel: { width: number; height: number }, cols: number, rows: number, ratios: CellRatios = FIRST_GUESS): number {
  if (!(panel.width > 0 && panel.height > 0 && cols > 0 && rows > 0)) return MIN_FONT;
  const fit = Math.min(panel.width / (cols * ratios.w), panel.height / (rows * ratios.h));
  return Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor(fit * 10) / 10));
}
