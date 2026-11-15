/**
 * The pure parts of an employee's Telegram bot (`docs/TELEGRAM.md`): when a message in a group is said to the
 * employee, what they are given from a group, the pairing code of a `/start`, and long answers cut to Telegram's size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_UP_MS, addressedTo, groupPrompt, pieces, startPayload } from '../src/telegram.ts';

const base = { botUsername: 'kira_office_bot', botId: 9001, name: 'Kira', replyToFrom: null, entities: [], from: 1, lastAnswer: null, now: 1_000_000 };

test('said to them in a group: a mention, their name as a word, a reply to them, a follow-up from the one they answered', () => {
  const said = (text: string, more: Partial<Parameters<typeof addressedTo>[0]> = {}) => addressedTo({ ...base, text, ...more } as Parameters<typeof addressedTo>[0]);
  assert.equal(said('@Kira_Office_Bot what now?'), true);
  assert.equal(said('kira, check the checkout'), true);
  assert.equal(said('Can you look, Kira?'), true);
  assert.equal(said('Kira.'), true);
  assert.equal(said('lunch at noon?'), false);
  // Part of another word is not their name.
  assert.equal(said('the kirai sauce'), false);
  assert.equal(said('Okiran'), false);
  // A name with letters beyond English.
  assert.equal(addressedTo({ ...base, name: 'Đorđe', text: 'đorđe, pogledaj ovo' }), true);
  assert.equal(addressedTo({ ...base, name: 'Đorđe', text: 'đorđević je javio' }), false);
  // A reply to one of the bot's messages; a reply to somebody else's is not.
  assert.equal(said('ok', { replyToFrom: 9001 }), true);
  assert.equal(said('ok', { replyToFrom: 42 }), false);
  // A Telegram "text mention" of the bot.
  assert.equal(said('look', { entities: [{ type: 'text_mention', offset: 0, length: 4, user: { id: 9001 } }] } as any), true);
  // A follow-up from the person they just answered, while it is fresh.
  assert.equal(said('and the totals?', { from: 7, lastAnswer: { to: 7, at: base.now - 60_000 } }), true);
  assert.equal(said('and the totals?', { from: 7, lastAnswer: { to: 7, at: base.now - FOLLOW_UP_MS - 1 } }), false);
  assert.equal(said('and the totals?', { from: 8, lastAnswer: { to: 7, at: base.now - 1000 } }), false);
});

test('what they are given from a group: the conversation so far and what is for them — or all of it, to judge', () => {
  const heard = [{ who: 'Dana', text: 'who brings the cake?' }];
  const one = groupPrompt({ group: 'Launch team', me: 'Kira', heard, who: 'Dana', text: 'kira, the checkout?', everything: false });
  assert.match(one, /^\[Telegram group "Launch team" — you take part as Kira\./);
  assert.match(one, /- Dana: who brings the cake\?/);
  assert.match(one, /Dana said to you:\nkira, the checkout\?$/);
  assert.doesNotMatch(one, /NO_REPLY/);
  const all = groupPrompt({ group: 'Launch team', me: 'Kira', heard: [], who: null, text: 'Ivo: lunch?\nMia: sure', everything: true });
  assert.match(all, /New in the group:\nIvo: lunch\?\nMia: sure/);
  assert.match(all, /reply with exactly NO_REPLY and nothing else/);
});

test('a pairing code is what comes after /start, also /start@bot in a group', () => {
  assert.equal(startPayload('/start abcDEF_123-x'), 'abcDEF_123-x');
  assert.equal(startPayload('/start@kira_office_bot abc'), 'abc');
  assert.equal(startPayload('/start'), '');
  assert.equal(startPayload('hello /start abc'), null);
  assert.equal(startPayload('/starts abc'), null);
});

test('a long answer is cut into Telegram-sized pieces, at a paragraph or a line where it can be', () => {
  assert.deepEqual(pieces('short'), ['short']);
  const text = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
  const parts = pieces(text);
  assert.deepEqual(parts.map((p) => p.length), [3000, 3000]);
  const one = pieces('x'.repeat(9000));
  assert.ok(one.every((p) => p.length <= 4000) && one.join('') === 'x'.repeat(9000));
});
