import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_LAYOUTS, buttonOfKey, buttonsOfPad, changes, layoutOf, seatName, settleSeats, usualSeats, type Seats } from '../src/arcade/input.ts';
import { PAD_BUTTONS } from '../src/arcade/protocol.ts';

const pad = (pressed: number[], axes: number[] = [0, 0]) => ({ buttons: Array.from({ length: 17 }, (_x, i) => ({ pressed: pressed.includes(i) })), axes });

test('one player on the keyboard has all of it; two share it, the left half to player 1 and the right to player 2', () => {
  const solo: Seats = { p1: 'keys', p2: 'none' };
  assert.equal(layoutOf(solo, 1), 'whole');
  assert.equal(layoutOf(solo, 2), null);
  assert.deepEqual(buttonOfKey(solo, 'KeyW'), { player: 1, button: 'up' });
  assert.deepEqual(buttonOfKey(solo, 'ArrowUp'), { player: 1, button: 'up' }, 'alone, the arrows move too');
  assert.deepEqual(buttonOfKey(solo, 'KeyK'), { player: 1, button: 'b' });
  assert.deepEqual(buttonOfKey(solo, 'Enter'), { player: 1, button: 'start' });

  const both: Seats = { p1: 'keys', p2: 'keys' };
  assert.equal(layoutOf(both, 1), 'left');
  assert.equal(layoutOf(both, 2), 'right');
  assert.deepEqual(buttonOfKey(both, 'KeyW'), { player: 1, button: 'up' });
  assert.deepEqual(buttonOfKey(both, 'KeyG'), { player: 1, button: 'b' });
  assert.deepEqual(buttonOfKey(both, 'Digit1'), { player: 1, button: 'start' });
  assert.deepEqual(buttonOfKey(both, 'ArrowUp'), { player: 2, button: 'up' }, 'shared, the arrows are the second player\'s');
  assert.deepEqual(buttonOfKey(both, 'KeyK'), { player: 2, button: 'b' });
  assert.deepEqual(buttonOfKey(both, 'Enter'), { player: 2, button: 'start' });
  assert.equal(buttonOfKey(both, 'Space'), null, 'a key nobody holds is nobody\'s: the office keeps it');
});

test('the two halves of the keyboard share no key, and each half reaches every button of the pad', () => {
  const left = Object.keys(KEY_LAYOUTS.left);
  const right = Object.keys(KEY_LAYOUTS.right);
  assert.deepEqual(left.filter((k) => right.includes(k)), []);
  for (const layout of ['whole', 'left', 'right'] as const) assert.deepEqual([...new Set(Object.values(KEY_LAYOUTS[layout]))].sort(), [...PAD_BUTTONS].sort(), layout);
});

test('a player on a gamepad leaves the whole keyboard to the other', () => {
  const seats: Seats = { p1: 0, p2: 'keys' };
  assert.equal(layoutOf(seats, 1), null);
  assert.equal(layoutOf(seats, 2), 'whole');
  assert.deepEqual(buttonOfKey(seats, 'KeyJ'), { player: 2, button: 'a' });
});

test('a gamepad as a Mega Drive pad: the row of three is X A B, the stick moves as the d-pad does', () => {
  assert.deepEqual([...buttonsOfPad(pad([2, 0, 1]))].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...buttonsOfPad(pad([4, 3, 5]))].sort(), ['x', 'y', 'z']);
  assert.deepEqual([...buttonsOfPad(pad([9, 8]))].sort(), ['mode', 'start']);
  assert.deepEqual([...buttonsOfPad(pad([12, 15]))].sort(), ['right', 'up']);
  assert.deepEqual([...buttonsOfPad(pad([], [-0.9, 0.7]))].sort(), ['down', 'left']);
  assert.deepEqual([...buttonsOfPad(pad([], [0.2, -0.3]))], [], 'a stick at rest, a little off centre, holds nothing');
  assert.deepEqual([...buttonsOfPad({ buttons: [], axes: [] })], [], 'a pad with nothing on it');
});

test('only what changed on a pad is passed on', () => {
  assert.deepEqual(changes(new Set(['a']), new Set(['a', 'up'])), [{ button: 'up', down: true }]);
  assert.deepEqual(changes(new Set(['a', 'up']), new Set(['up'])), [{ button: 'a', down: false }]);
  assert.deepEqual(changes(new Set(['a']), new Set(['a'])), []);
});

test('who holds what when nobody has said: the keyboard, the same for everyone — a gamepad is chosen, never assumed', () => {
  assert.deepEqual(usualSeats([]), { p1: 'keys', p2: 'none' });
  assert.deepEqual(usualSeats([0]), { p1: 'keys', p2: 'none' });
  assert.deepEqual(usualSeats([1, 3]), { p1: 'keys', p2: 'none' });
  // …and with nothing chosen the keys are W A S D (or the arrows), J K L and U I O.
  const seats = settleSeats(null, [0, 1]);
  assert.deepEqual(seats, { p1: 'keys', p2: 'none' });
  assert.deepEqual(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO', 'Enter'].map((c) => buttonOfKey(seats, c)?.button), ['up', 'left', 'down', 'right', 'a', 'b', 'c', 'x', 'y', 'z', 'start']);
});

test('a choice holds only with what is connected, and one gamepad is never both players\'', () => {
  assert.deepEqual(settleSeats({ p1: 'keys', p2: 'keys' }, []), { p1: 'keys', p2: 'keys' });
  assert.deepEqual(settleSeats({ p1: 2, p2: 'keys' }, []), { p1: 'keys', p2: 'keys' }, 'the gamepad that was chosen is gone');
  assert.deepEqual(settleSeats({ p1: 'keys', p2: 2 }, [0]), { p1: 'keys', p2: 'keys' }, 'the second player, whose gamepad is gone, plays on with the keyboard');
  assert.deepEqual(settleSeats({ p1: 0, p2: 1 }, [0, 1]), { p1: 0, p2: 1 }, 'two gamepads that were chosen and are there');
  // Player 2 has just taken the gamepad player 1 had: player 1 gives way.
  assert.deepEqual(settleSeats({ p1: 0, p2: 0 }, [0], 2), { p1: 'keys', p2: 0 });
  assert.deepEqual(settleSeats({ p1: 0, p2: 0 }, [0, 1], 2), { p1: 1, p2: 0 });
  // Player 1 has just taken player 2's: player 2 gives way.
  assert.deepEqual(settleSeats({ p1: 0, p2: 0 }, [0], 1), { p1: 0, p2: 'keys' });
  // Something that is no seat at all (a stored choice from another shape) is the usual.
  assert.deepEqual(settleSeats({ p1: 'none' as never, p2: 'x' as never }, []), { p1: 'keys', p2: 'none' });
});

test('a seat in words', () => {
  assert.equal(seatName('keys'), 'Keyboard');
  assert.equal(seatName('none'), 'Nobody');
  assert.equal(seatName(0, { 0: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)' }), 'Gamepad 1 — Xbox Wireless Controller');
  assert.equal(seatName(1), 'Gamepad 2');
});

test('keys a game holds are told to the office\'s early shortcuts, and given back when the game is over', async () => {
  const { keyTaken, takeKeys } = await import('../src/lib/keys-taken.ts');
  assert.equal(keyTaken('KeyV'), false, 'nothing is taken when nothing plays');
  const seats: Seats = { p1: 'keys', p2: 'keys' };
  const giveBack = takeKeys((code) => !!buttonOfKey(seats, code));
  assert.equal(keyTaken('KeyT'), true, 'a player\'s button');
  assert.equal(keyTaken('KeyV'), false, 'a key no player holds stays the office\'s: talking while playing still works');
  // A later taker replaces the earlier one, and the earlier one's giving back does not undo the later.
  const other = takeKeys((code) => code === 'KeyV');
  giveBack();
  assert.equal(keyTaken('KeyV'), true);
  other();
  assert.equal(keyTaken('KeyV'), false);
  assert.equal(keyTaken('KeyT'), false);
});
