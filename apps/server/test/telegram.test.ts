/**
 * The pure parts of an employee's Telegram bot (`docs/TELEGRAM.md`): when a message in a group is said to the
 * employee, what they are given from a group, the pairing code of a `/start`, and long answers cut to Telegram's size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_UP_MS, addressedTo, answerOf, groupPrompt, pieces, startPayload } from '../src/telegram.ts';

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

test('what they are given from a group: where it is, what they have not seen, what is for them — or all of it, to judge', () => {
  const earlier = [{ who: 'Dana', text: 'who brings the cake?', id: 40 }];
  const one = groupPrompt({ group: 'Launch team', me: 'Kira', earlier, first: true, who: 'Dana', new: [{ who: 'Dana', text: 'kira, the checkout?', id: 41 }], everything: false });
  assert.match(one, /^On Telegram, in the group "Launch team" — you are Kira there\./);
  assert.match(one, /Earlier in the chat:\n#40 Dana: who brings the cake\?/);
  assert.match(one, /Dana to you:\n#41 Dana: kira, the checkout\?/);
  assert.match(one, /start it with \[reply #n\]/);
  assert.doesNotMatch(one, /NO_REPLY/);
  // Later in the same conversation: only what was said since, and said so.
  const later = groupPrompt({ group: 'Launch team', me: 'Kira', earlier: [{ who: 'Ivo', text: 'done', id: 44 }], first: false, who: 'Dana', new: [{ who: 'Dana', text: 'kira?', id: 45 }], everything: false });
  assert.match(later, /Meanwhile in the chat:\n#44 Ivo: done/);
  const quiet = groupPrompt({ group: 'Launch team', me: 'Kira', earlier: [], first: false, who: 'Dana', new: [{ who: 'Dana', text: 'and?', id: 46 }], everything: false });
  assert.doesNotMatch(quiet, /Earlier|Meanwhile/);
  const all = groupPrompt({ group: 'Launch team', me: 'Kira', earlier: [], first: true, who: null, new: [{ who: 'Ivo', text: 'lunch?', id: 50 }, { who: 'Mia', text: 'sure', id: 51 }], everything: true });
  assert.match(all, /New:\n#50 Ivo: lunch\?\n#51 Mia: sure/);
  assert.match(all, /otherwise reply exactly NO_REPLY/);
});

test('an answer is an ordinary message; a reply only to a message they chose, and only one the chat has', () => {
  const known = new Set([40, 41]);
  assert.deepEqual(answerOf('  sure, on it  ', known), { text: 'sure, on it', replyTo: null });
  assert.deepEqual(answerOf('[reply #40] the cake is mine', known), { text: 'the cake is mine', replyTo: 40 });
  assert.deepEqual(answerOf('[Reply #41]\nchecked: all fine', known), { text: 'checked: all fine', replyTo: 41 });
  // A number the chat does not have: the mark goes, the message is plain.
  assert.deepEqual(answerOf('[reply #999] hm', known), { text: 'hm', replyTo: null });
  // Not at the start: left as said.
  assert.deepEqual(answerOf('see [reply #40]', known), { text: 'see [reply #40]', replyTo: null });
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
