import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pasteable } from '../src/tmux.ts';

test('what is pasted into a terminal is text: escape sequences and other control characters are taken out', () => {
  // The end-of-paste marker followed by "keys": Shift+Tab (the permission mode), Escape, a digit and Enter at a dialog.
  const hostile = 'Please look at this.\x1b[201~\x1b[Z\x1b1\rAnd this.';
  const out = pasteable(hostile);
  assert.equal(out, 'Please look at this.[201~[Z1\nAnd this.');
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out));
  // The 8-bit form of the same sequence, a bell, a backspace, a NUL, a DEL.
  assert.equal(pasteable('a\u009b201~b\x07c\x08d\x00e\x7ff'), 'a201~bcdef');
});

test('ordinary text passes as it is: line breaks, tabs, every alphabet', () => {
  const text = 'Prva linija\n\tuvučena — „navodnici", ćirilica: слика, emoji: 🙂\nlast line';
  assert.equal(pasteable(text), text);
  assert.equal(pasteable('windows\r\nlines\r\n'), 'windows\nlines\n');
  assert.equal(pasteable('a lone\rreturn'), 'a lone\nreturn', 'not the key that sends the line');
  assert.equal(pasteable(''), '');
});
