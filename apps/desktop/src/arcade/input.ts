import type { PadButton, Player } from './protocol.ts';

/**
 * Who plays with what. A player holds the keyboard or a gamepad; when both hold the keyboard it is shared, the left
 * half to player 1 and the right half to player 2. Nothing here touches the page: keys and gamepads go in as plain
 * values and buttons come out, so it can all be tested without a browser.
 */

/** A seat: the keyboard, a gamepad by its index, or (the second player only) nobody. */
export type Seat = 'keys' | 'none' | number;
export interface Seats {
  p1: Exclude<Seat, 'none'>;
  p2: Seat;
}

export type KeyLayout = 'whole' | 'left' | 'right';

/** Keys by where they are on the keyboard (`KeyboardEvent.code`), so a Serbian or German layout plays the same. */
export const KEY_LAYOUTS: Record<KeyLayout, Record<string, PadButton>> = {
  // One player, both hands: move with W A S D or the arrows, buttons under the right hand.
  whole: {
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyJ: 'a', KeyK: 'b', KeyL: 'c', KeyU: 'x', KeyI: 'y', KeyO: 'z',
    Enter: 'start', ShiftRight: 'mode',
  },
  left: {
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    KeyF: 'a', KeyG: 'b', KeyH: 'c', KeyR: 'x', KeyT: 'y', KeyY: 'z',
    Digit1: 'start', Digit2: 'mode',
  },
  right: {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyJ: 'a', KeyK: 'b', KeyL: 'c', KeyU: 'x', KeyI: 'y', KeyO: 'z',
    Enter: 'start', ShiftRight: 'mode',
  },
};

/** The legend of a layout, in the words on the keys. */
export const KEY_LEGEND: Record<KeyLayout, string> = {
  whole: 'W A S D to move (or the arrows) · J K L = A B C · U I O = X Y Z · Enter = Start',
  left: 'W A S D to move · F G H = A B C · R T Y = X Y Z · 1 = Start',
  right: 'Arrows to move · J K L = A B C · U I O = X Y Z · Enter = Start',
};
export const PAD_LEGEND = 'D-pad or left stick to move · X A B = A B C · LB Y RB = X Y Z · Start = Start';

/** Which half of the keyboard a player has: all of it unless the other player is on it too. */
export function layoutOf(seats: Seats, player: Player): KeyLayout | null {
  const mine = player === 1 ? seats.p1 : seats.p2;
  if (mine !== 'keys') return null;
  const other = player === 1 ? seats.p2 : seats.p1;
  return other === 'keys' ? (player === 1 ? 'left' : 'right') : 'whole';
}

/** What a key means right now: whose button, or nothing. */
export function buttonOfKey(seats: Seats, code: string): { player: Player; button: PadButton } | null {
  for (const player of [1, 2] as const) {
    const layout = layoutOf(seats, player);
    const button = layout ? KEY_LAYOUTS[layout][code] : undefined;
    if (button) return { player, button };
  }
  return null;
}

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

/** What changed between two readings of one pad: the buttons to press and to let go. */
export function changes(before: ReadonlySet<PadButton>, now: ReadonlySet<PadButton>): Array<{ button: PadButton; down: boolean }> {
  const out: Array<{ button: PadButton; down: boolean }> = [];
  for (const b of now) if (!before.has(b)) out.push({ button: b, down: true });
  for (const b of before) if (!now.has(b)) out.push({ button: b, down: false });
  return out;
}

/**
 * Who holds what when nobody has said: one player on the whole keyboard — W A S D, J K L, U I O — whatever is
 * plugged in. The same for everyone, so that two people who play together need not ask each other which keys; a
 * gamepad is something a person chooses (and the choice is remembered).
 */
export function usualSeats(_pads: number[] = []): Seats {
  return { p1: 'keys', p2: 'none' };
}

/**
 * What was chosen, made to hold with what is connected: a gamepad that is gone falls back to the usual, and one
 * gamepad is never both players' (the player who did not just choose it gives way).
 */
export function settleSeats(wanted: Partial<Seats> | null, pads: number[], changed?: Player): Seats {
  const usual = usualSeats(pads);
  const here = (s: Seat | undefined): s is Seat => s === 'keys' || s === 'none' || (typeof s === 'number' && pads.includes(s));
  let p1: Seats['p1'] = here(wanted?.p1) && wanted!.p1 !== ('none' as Seat) ? wanted!.p1! : usual.p1;
  let p2: Seat = here(wanted?.p2) ? wanted!.p2! : usual.p2;
  // A gamepad that was chosen and is gone leaves its player the keyboard — the second player too, who chose to play.
  if (typeof wanted?.p2 === 'number' && !pads.includes(wanted.p2)) p2 = 'keys';
  if (typeof p1 === 'number' && p1 === p2) {
    const free = pads.find((p) => p !== p1);
    if (changed === 2) p1 = free ?? 'keys';
    else p2 = free ?? 'keys';
  }
  return { p1, p2 };
}

/** A seat in words, for the choice and for the legend. */
export function seatName(seat: Seat, padNames: Record<number, string> = {}): string {
  if (seat === 'keys') return 'Keyboard';
  if (seat === 'none') return 'Nobody';
  const name = padNames[seat]?.replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor:.*?\)\s*$/i, '').trim();
  return name ? `Gamepad ${seat + 1} — ${name.slice(0, 40)}` : `Gamepad ${seat + 1}`;
}
