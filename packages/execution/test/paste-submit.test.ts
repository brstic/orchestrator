import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptBox, stillInTheBox } from '../src/paste-submit.ts';

/**
 * A prompt is pasted into Claude Code and sent with Enter. Enter can come too early — while the paste is still being
 * taken in — and then the text stays in the input box, unsent, and nobody is told. (2026-11-12: a message with four
 * files stood in an employee's box until the next message pushed it out.) So after Enter the box is looked at.
 */
const BORDER = '─'.repeat(80);
const real = (box: string[], above: string[] = ['● Done.', '']) => [...above, BORDER, ...box, BORDER, '  Orchestrator · Andra Events Lj', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];

test('the input box of Claude Code is what stands between its two rules, after the prompt sign', () => {
  assert.equal(promptBox(real(['❯ ']), 0), '');
  assert.equal(promptBox(real(['❯ [ORCH:MSG:8ad72e85] Message from the boss: look at this', '  and this second line']), 0), '[ORCH:MSG:8ad72e85] Message from the boss: look at this\nand this second line');
  assert.equal(promptBox(real(['❯ [Pasted text #1 +11 lines]']), 0), '[Pasted text #1 +11 lines]');
  // The older sign.
  assert.equal(promptBox(real(['> hello']), 0), 'hello');
  // A turn is running: the box is still there, under the spinner.
  assert.equal(promptBox(real(['❯ '], ['● Running 2 shell commands…', '✶ Precipitating… (2m 8s)', '']), 0), '');
});

test('a dialog, a list or a quoted line is not the input box', () => {
  // A permission dialog: its choice is marked with the same sign, and Enter there would approve.
  const dialog = ['Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don’t ask again', '  3. No', '', 'Esc to cancel'];
  assert.equal(promptBox(dialog, 3), null);
  // The prompt of an earlier turn, further up the screen, with the answer under it.
  assert.equal(promptBox(['> an earlier prompt', '', '● The answer.', ''], 3), null);
  assert.equal(promptBox([], 0), null);
});

test('a plain prompt line (no rules round it) counts only while the cursor stands on it', () => {
  // The scripted worker of the tests: "> " and what was typed, the cursor at its end.
  assert.equal(promptBox(['⏺ Done.', '> [pasted 418 chars]'], 1), '[pasted 418 chars]');
  assert.equal(promptBox(['⏺ Done.', '> '], 1), '');
  // Sent: the cursor has moved on, the old line is history.
  assert.equal(promptBox(['⏺ Done.', '> [pasted 418 chars]', ''], 2), null);
});

test('still in the box: what was pasted is recognised by its beginning, or by the note a long paste is folded into', () => {
  const pasted = '[ORCH:MSG:8ad72e85-7061] Message from the boss: vidi sve ove komentare\n\nFiles that go with this — open each with the Read tool before you answer:\n- /home/x/files/said/7c37-screenshot.png';
  assert.equal(stillInTheBox('[ORCH:MSG:8ad72e85-7061] Message from the boss: vidi sve ove komentare\nFiles that go with this', pasted), true);
  assert.equal(stillInTheBox('[Pasted text #2 +5 lines]', pasted), true);
  assert.equal(stillInTheBox('[pasted 418 chars]', pasted), true);
  // Typed before it by somebody at the terminal: the paste follows their words.
  assert.equal(stillInTheBox('wait — [ORCH:MSG:8ad72e85-7061] Message from the boss: vidi sve', pasted), true);
  // Sent: the box is empty again, or holds something that is not ours — which is left alone.
  assert.equal(stillInTheBox('', pasted), false);
  assert.equal(stillInTheBox(null, pasted), false, 'a screen that cannot be read is not a reason to press Enter');
  assert.equal(stillInTheBox('1. Yes', pasted), false);
  assert.equal(stillInTheBox('something a person is typing', pasted), false);
  assert.equal(stillInTheBox('x', ''), false);
});
