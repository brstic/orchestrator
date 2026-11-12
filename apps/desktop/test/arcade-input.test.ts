import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEYS, KEY_LEGEND, buttonOfKey, buttonsOfPad, buttonsOfPads, changes } from '../src/arcade/input.ts';
import { PAD_BUTTONS } from '../src/arcade/protocol.ts';

const pad = (pressed: number[], axes: number[] = [0, 0]) => ({ buttons: Array.from({ length: 17 }, (_x, i) => ({ pressed: pressed.includes(i) })), axes });

test('the keys are the same for everybody: W A S D (or the arrows), J K L, U I O, Enter', () => {
  assert.deepEqual(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO', 'Enter', 'ShiftRight'].map(buttonOfKey), ['up', 'left', 'down', 'right', 'a', 'b', 'c', 'x', 'y', 'z', 'start', 'mode']);
  assert.deepEqual(['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].map(buttonOfKey), ['up', 'left', 'down', 'right'], 'the arrows move too');
  // Every button of the pad can be reached, and the legend names the keys a person is told about.
  assert.deepEqual([...new Set(Object.values(KEYS))].sort(), [...PAD_BUTTONS].sort());
  assert.match(KEY_LEGEND, /^W A S D to move .*J K L = A B C .*U I O = X Y Z .*Enter = Start$/);
});

test('one person at a computer holds one pad: no key is a second player\'s, and the rest stay the office\'s', () => {
  // What used to be the left half of a shared keyboard is no button any more.
  for (const code of ['KeyF', 'KeyG', 'KeyH', 'KeyR', 'KeyT', 'KeyY', 'Digit1', 'Digit2']) assert.equal(buttonOfKey(code), null, code);
  // Talking (V), the interact key and Escape are never the game's; nor is a name that is no key at all.
  for (const code of ['KeyV', 'Space', 'Escape', 'constructor', '']) assert.equal(buttonOfKey(code), null, code);
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

test('every gamepad on the computer is the one pad of whoever sits there', () => {
  assert.deepEqual([...buttonsOfPads([pad([2]), null, pad([9], [0.9, 0]), undefined])].sort(), ['a', 'right', 'start']);
  assert.deepEqual([...buttonsOfPads([])], []);
  assert.deepEqual([...buttonsOfPads([null, null, null, null])], [], 'what a browser reports with nothing plugged in');
});

test('keys a game holds are told to the office\'s early shortcuts, and given back when the game is over', async () => {
  const { keyTaken, takeKeys } = await import('../src/lib/keys-taken.ts');
  assert.equal(keyTaken('KeyV'), false, 'nothing is taken when nothing plays');
  const giveBack = takeKeys((code) => !!buttonOfKey(code));
  assert.equal(keyTaken('KeyK'), true, 'a button of the game');
  assert.equal(keyTaken('KeyV'), false, 'a key no player holds stays the office\'s: talking while playing still works');
  // A later taker replaces the earlier one, and the earlier one's giving back does not undo the later.
  const other = takeKeys((code) => code === 'KeyV');
  giveBack();
  assert.equal(keyTaken('KeyV'), true);
  other();
  assert.equal(keyTaken('KeyV'), false);
  assert.equal(keyTaken('KeyK'), false);
});
