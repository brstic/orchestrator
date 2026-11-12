import type { PadButton } from './protocol.ts';

/**
 * The keys of a game: one person at a computer holds one pad, and the keys are the same for everybody — W A S D,
 * J K L, U I O — so that two people who play together need not ask each other which. (The second pad is held by
 * somebody at another computer, who pressed Join: docs/ARCADE.md.) A gamepad that is plugged in is that same pad.
 * Nothing here touches the page: keys and gamepads go in as plain values and buttons come out, so it can all be
 * tested without a browser.
 */

/** Keys by where they are on the keyboard (`KeyboardEvent.code`), so a Serbian or German layout plays the same. */
export const KEYS: Record<string, PadButton> = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyJ: 'a', KeyK: 'b', KeyL: 'c', KeyU: 'x', KeyI: 'y', KeyO: 'z',
  Enter: 'start', ShiftRight: 'mode',
};

/** The legend, in the words on the keys. */
export const KEY_LEGEND = 'W A S D to move (or the arrows) · J K L = A B C · U I O = X Y Z · Enter = Start';
export const PAD_LEGEND = 'D-pad or left stick to move · X A B = A B C · LB Y RB = X Y Z · Start = Start';

/** What a key means in a game: a button of the pad, or nothing (then the key stays the office's). */
export const buttonOfKey = (code: string): PadButton | null => (Object.prototype.hasOwnProperty.call(KEYS, code) ? KEYS[code]! : null);

export interface PadLike {
  buttons: ReadonlyArray<{ pressed: boolean } | undefined>;
  axes: ReadonlyArray<number | undefined>;
}

/** A gamepad in the browser's standard arrangement, as a Mega Drive pad: the three in a row are X, A, B. */
const PAD_MAP: Array<[number, PadButton]> = [
  [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right'],
  [2, 'a'], [0, 'b'], [1, 'c'],
  [4, 'x'], [3, 'y'], [5, 'z'],
  [9, 'start'], [8, 'mode'],
];
const STICK = 0.5;

export function buttonsOfPad(pad: PadLike): Set<PadButton> {
  const held = new Set<PadButton>();
  for (const [index, button] of PAD_MAP) if (pad.buttons[index]?.pressed) held.add(button);
  const [x = 0, y = 0] = pad.axes;
  if (x <= -STICK) held.add('left');
  if (x >= STICK) held.add('right');
  if (y <= -STICK) held.add('up');
  if (y >= STICK) held.add('down');
  return held;
}

/** What every gamepad on this computer holds, together: they are all the one pad of whoever sits here. */
export function buttonsOfPads(pads: ReadonlyArray<PadLike | null | undefined>): Set<PadButton> {
  const held = new Set<PadButton>();
  for (const pad of pads) if (pad) for (const b of buttonsOfPad(pad)) held.add(b);
  return held;
}

/** What changed between two readings of a pad: the buttons to press and to let go. */
export function changes(before: ReadonlySet<PadButton>, now: ReadonlySet<PadButton>): Array<{ button: PadButton; down: boolean }> {
  const out: Array<{ button: PadButton; down: boolean }> = [];
  for (const b of now) if (!before.has(b)) out.push({ button: b, down: true });
  for (const b of before) if (!now.has(b)) out.push({ button: b, down: false });
  return out;
}
