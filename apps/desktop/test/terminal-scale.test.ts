import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_GUESS, MAX_FONT, MIN_FONT, cellRatios, fontToFit } from '../src/terminal/scale.ts';

/** A terminal as the browser draws it: cells are whole pixels, a little wider and taller than the font size says. */
const drawn = (cols: number, rows: number, font: number) => ({ width: cols * Math.ceil(font * 0.6), height: rows * Math.ceil(font * 1.2 * 1.15) });

test('a watched terminal fills the panel: letters as large as the tighter of width and height allows', () => {
  // The case that was reported: a 120 × 34 pane in a large window, left in a corner at 16 px.
  const panel = { width: 1330, height: 863 };
  const ratios = cellRatios(drawn(120, 34, 16), 120, 34, 16)!;
  const font = fontToFit(panel, 120, 34, ratios);
  assert.ok(font > 16, `larger than the old limit: ${font}`);
  const now = drawn(120, 34, font);
  assert.ok(now.width <= panel.width && now.height <= panel.height, `inside the panel: ${now.width} × ${now.height}`);
  assert.ok(now.width > panel.width * 0.85 || now.height > panel.height * 0.85, 'and it uses the panel, on the side that is tighter');
});

test('whichever runs out first decides: a wide panel is limited by its height, a tall one by its width', () => {
  const ratios = { w: 0.6, h: 1.4 };
  assert.equal(fontToFit({ width: 3000, height: 476 }, 120, 34, ratios), 10, 'height: 476 / (34 × 1.4)');
  assert.equal(fontToFit({ width: 720, height: 3000 }, 120, 34, ratios), 10, 'width: 720 / (120 × 0.6)');
  assert.equal(fontToFit({ width: 725, height: 3000 }, 120, 34, ratios), 10, 'rounded down, never up: it must fit');
});

test('limits: a tiny pane does not become a poster, a tile on the wall stays a terminal, nonsense is not divided by', () => {
  assert.equal(fontToFit({ width: 2000, height: 1200 }, 20, 5), MAX_FONT);
  assert.equal(fontToFit({ width: 200, height: 90 }, 200, 60), MIN_FONT);
  for (const bad of [{ width: 0, height: 500 }, { width: 500, height: -1 }]) assert.equal(fontToFit(bad, 120, 34), MIN_FONT);
  assert.equal(fontToFit({ width: 500, height: 500 }, 0, 34), MIN_FONT);
  assert.equal(cellRatios({ width: 0, height: 0 }, 120, 34, 13), null, 'a terminal that has not drawn yet has nothing to measure');
});

test('before anything is measured the guess is on the careful side: the first drawing is not cut off', () => {
  const panel = { width: 1330, height: 863 };
  const font = fontToFit(panel, 120, 34);
  const first = drawn(120, 34, font);
  assert.ok(first.width <= panel.width && first.height <= panel.height, `${first.width} × ${first.height}`);
  const real = cellRatios(drawn(120, 34, 16), 120, 34, 16)!;
  assert.ok(FIRST_GUESS.w >= real.w - 0.05 && FIRST_GUESS.h >= real.h, 'not smaller than what a browser draws');
});
