import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@orchestrator/contracts';
import { messagePrompt } from '../src/prompts.ts';

const msg = (more: Partial<Message>): Message =>
  ({ id: 'm1234567', kind: 'chat', from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: 'e1', body: 'look at the banner', taskId: null, threadId: null, delivery: { status: 'queued', via: null, ts: '', detail: null }, createdAt: '', readAt: null, ...more }) as Message;

test('who a message is from: the boss is the boss — a colleague or another owner is named, not called the boss', () => {
  assert.match(messagePrompt(msg({}), undefined), /Message from the boss: look at the banner$/);
  assert.match(messagePrompt(msg({ from: { kind: 'owner', id: null, name: 'Vera (a colleague the boss invited; not the boss)' } }), undefined), /Message from Vera \(a colleague the boss invited; not the boss\): look/);
});

test('from Telegram: a private chat says so and how to answer; a group message carries its own context', () => {
  const dm = messagePrompt(msg({ channel: 'telegram' }), undefined);
  assert.match(dm, /On Telegram, the boss writes: look at the banner\n/);
  assert.match(dm, /sent back to Telegram as a chat message/);
  assert.match(dm, /Messages without "On Telegram" come from the office/);
  const group = messagePrompt(msg({ channel: 'telegram', chat: 'Launch team', body: 'On Telegram, in the group "Launch team" — you are Kira there.\n\nDana to you:\n#41 Dana: kira?' }), undefined);
  assert.match(group, /^\[ORCH:MSG:[^\]]+\] On Telegram, in the group "Launch team"/);
  assert.doesNotMatch(group, /Message from/);
});
