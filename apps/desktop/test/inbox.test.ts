import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalLine, byDay, dayOf, deliveryWord, needLine, oneLine } from '../src/lib/inbox.ts';

/** The words and the order of the Inbox (docs/UI.md). */

test('a long question is one line: its first line that says something, without Markdown, cut at a word', () => {
  assert.equal(oneLine('Should the login form remember the email?'), 'Should the login form remember the email?');
  assert.equal(oneLine('\n\n## Which **layout**?\n\n- the `wide` one\n- the narrow one'), 'Which layout?');
  assert.equal(oneLine('1. First do this\n2. then that'), 'First do this');
  assert.equal(oneLine('one two three four five six seven eight nine ten', 22), 'one two three four…');
  assert.equal(oneLine('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghij…');
  assert.equal(oneLine(''), '');
  assert.equal(oneLine(null), '');
});

test('an approval says what is to be run or written', () => {
  assert.equal(approvalLine({ name: 'Bash', input: { command: 'git push origin main' } }, 'David wants to run: Bash'), 'Bash: git push origin main');
  assert.equal(approvalLine({ name: 'Write', input: { file_path: '/srv/app/pipeline.txt', content: '…' } }, 'x'), 'Write: /srv/app/pipeline.txt');
  assert.equal(approvalLine({ name: 'Odd', input: { n: 1 } }, 'David wants to use Odd'), 'David wants to use Odd');
  assert.equal(approvalLine(null, 'David wants something'), 'David wants something');
});

test('news is cut into the days people speak of', () => {
  const now = new Date(2026, 10, 13, 9, 0, 0).getTime();
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).toISOString();
  assert.equal(dayOf(at(13, 0), now), 'Today');
  assert.equal(dayOf(at(12, 23), now), 'Yesterday');
  assert.equal(dayOf(at(11, 23), now), 'Earlier');
  // A clock that is a little ahead does not make "tomorrow".
  assert.equal(dayOf(at(14, 1), now), 'Today');
  const rows = [at(13, 8), at(13, 1), at(12, 20), at(9, 9), at(2, 9)].map((createdAt, i) => ({ id: i, createdAt }));
  assert.deepEqual(byDay(rows, now).map((g) => [g.day, g.rows.map((r) => r.id).join('')]), [['Today', '01'], ['Yesterday', '2'], ['Earlier', '34']]);
  assert.deepEqual(byDay([], now), []);
});

test('how an answer fared, and the window’s line', () => {
  assert.deepEqual(deliveryWord('confirmed'), { word: 'arrived', tone: 'calm' });
  assert.deepEqual(deliveryWord('failed'), { word: 'did not arrive', tone: 'bad' });
  assert.equal(deliveryWord('delivered').word, 'on its way');
  assert.equal(deliveryWord('superseded').word, 'settled elsewhere');
  assert.equal(needLine(0), 'Nothing needs you');
  assert.equal(needLine(1), '1 needs you');
  assert.equal(needLine(4), '4 need you');
});
