/**
 * What stands in a session's input box (`inputBox`, `boxHolds` in comms.ts): read when a prompt was typed into a
 * session and Claude Code never acknowledged it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxHolds, inputBox } from '../src/comms.ts';

const RULE = '─'.repeat(118);
/** The reviewer's terminal as it stood on the live office on 2026-11-12, forty minutes after a review was "handed" to it. */
const STUCK = [
  '  The PM has the summary. The report and his two screenshots are in',
  '  /home/dev/Projects/acme/_handoff/studio-images/. Nothing was changed on production, on dev, or on his sites.',
  '',
  '✻ Sautéed for 3m 3s · done 9:26 AM',
  '',
  RULE,
  '❯ - Decided by the boss — "T-27 waits on one read-only prod query you already approved. Server Admin\'s terminal guard',
  '  blocks it, and your approval through the office doesn\'t lift that. Can you run it yourse…": Close T-27 without prod',
  '  (applies this comes up again (first asked by Xagio Panel))',
  '  - Decided by the boss — "Xagio Panel (T-27) needs four read-only SELECTs on the reporting database (staging),',
  '  because the dev copy stops at 2026-11-05 and randyl@randyld.com\'s package switch happened…": Approve prod read-only',
  '  (applies this comes up again (first asked by Xagio Server Admin))',
  RULE,
  '  Orchestrator · Xagio Marketplace',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
const PROMPT = `[ORCH:TASK:abc] Review request — T-73: review T-72\n\n…\n\n- Decided by the boss — "Xagio Panel (T-27) needs four read-only SELECTs on the reporting database (staging), because the dev copy stops at 2026-11-05 and randyl@randyld.com's package switch happened…": Approve prod read-only (applies this comes up again (first asked by Xagio Server Admin))`;

test('a prompt that stands in the box unsent is recognised by its end, however the terminal wrapped it', () => {
  const box = inputBox(STUCK);
  assert.ok(box);
  assert.match(box!.text, /^- Decided by the boss/);
  assert.equal(boxHolds(box!, PROMPT), true);
  assert.equal(boxHolds(box!, 'Something else entirely that was typed to them and is long enough to compare.'), false);
  assert.equal(boxHolds({ text: 'short' }, 'hi'), false, 'too little to tell by');
});

test('an empty box is a box; a long paste folded into a tag is the paste', () => {
  assert.deepEqual(inputBox([' ready', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on']), { text: '' });
  assert.equal(boxHolds({ text: '' }, PROMPT), false);
  const folded = inputBox(['x', RULE, '❯ [Pasted text #1 +42 lines]', RULE, '  ? for shortcuts']);
  assert.deepEqual(folded, { text: '[Pasted text #1 +42 lines]' });
  assert.equal(boxHolds(folded!, PROMPT), true);
  // A terminal without rules that ends at the prompt sign (the scripted worker of the tests).
  assert.deepEqual(inputBox(['Understood.', '', '> ']), { text: '' });
  assert.deepEqual(inputBox(['Understood.', '> [pasted 1010 chars]']), { text: '[pasted 1010 chars]' });
});

test('a dialog is not a box: Enter there would be an answer', () => {
  const permission = ['Bash command', '  git push origin main', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don\'t ask again for git push', '  3. No, and tell Claude what to do differently (esc)'];
  assert.equal(inputBox(permission), null);
  const bypass = [' WARNING: Claude Code running in Bypass Permissions mode', ' ❯ 1. No, exit', '   2. Yes, I accept'];
  assert.equal(inputBox(bypass), null);
  const trust = [RULE, ' Do you trust the files in this folder?', ' ❯ 1. Yes, proceed', '   2. No, exit', RULE];
  assert.equal(inputBox(trust), null);
  // Nothing recognisable: a program that is starting, an empty screen, lines that are not text.
  assert.equal(inputBox(['Resuming conversation…', '']), null);
  assert.equal(inputBox([]), null);
  assert.equal(inputBox([null as any, 7 as any]), null);
  // A numbered list in what Claude wrote, above an ordinary box, is not a dialog.
  assert.deepEqual(inputBox(['Plan:', '1. Read the file', '2. Change it', '', RULE, '❯ ', RULE]), { text: '' });
});
