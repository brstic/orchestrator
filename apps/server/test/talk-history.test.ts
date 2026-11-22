import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, OrchestratorEvent } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { talkPage, talkSearch, type TalkDeps } from '../src/talk-history.ts';

/**
 * Talk's whole conversation (`talk-history.ts`): the boss's lines and the employee's answers read from where they are
 * kept — not only what the office's state still carries — a page at a time going back, from a moment on, and searched.
 */
const E = 'emp-1';
const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();

function office(opts: { canMessage?: (m: Message) => boolean; canEvent?: (e: OrchestratorEvent) => OrchestratorEvent | null } = {}) {
  const store = new Store(':memory:');
  const messages: Message[] = [];
  const say = (n: number, body: string, extra: Partial<Message> = {}) =>
    messages.push({ id: `m${n}`, from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: E, body, createdAt: at(n), delivery: { status: 'confirmed', via: 'hook' }, ...extra } as unknown as Message);
  const event = (n: number, type: string, data: Record<string, unknown>, summary = '', employeeId = E) =>
    store.appendEvent({ id: `e${n}`, ts: at(n), type: type as never, source: { kind: 'server' } as never, correlationId: null, hostId: null, sessionId: null, employeeId, taskId: null, projectId: null, summary, data });
  const deps: TalkDeps = { store, messages: () => messages, canMessage: opts.canMessage ?? (() => true), canEvent: opts.canEvent ?? ((e) => e) };
  return { store, say, event, deps };
}

test('a page at a time going back: the newest lines first, then the ones before, until there is nothing older', () => {
  const o = office();
  for (let i = 0; i < 30; i++) {
    o.say(i * 2, `question ${i}`);
    o.event(i * 2 + 1, 'agent.turn_finished', { lastMessage: `answer ${i}` });
  }
  // Not lines of this conversation: another employee's, an activity, a turn with nothing said, a client's turn.
  o.event(100, 'agent.turn_finished', { lastMessage: 'someone else' }, '', 'emp-2');
  o.event(101, 'session.activity', { activity: 'thinking' });
  o.event(102, 'agent.turn_finished', { lastMessage: '   ' });
  o.event(103, 'agent.turn_finished', { lastMessage: 'for a client', rentClientId: 'c1' });

  const first = talkPage(o.deps, E, { limit: 20 });
  assert.equal(first.messages.length + first.events.length, 20);
  assert.equal(first.more, true);
  assert.equal(first.events.at(-1)!.data.lastMessage, 'answer 29');
  assert.equal(first.from, at(40));
  const second = talkPage(o.deps, E, { before: first.from!, limit: 20 });
  assert.equal(second.messages.length + second.events.length, 20);
  assert.equal(second.from, at(20));
  const third = talkPage(o.deps, E, { before: second.from!, limit: 20 });
  assert.equal(third.messages.length + third.events.length, 20);
  assert.equal(third.more, false);
  assert.equal(third.messages[0]!.body, 'question 0', 'the very first line is reached');
});

test('from a moment on: every line from an old one a search found up to now, and whether anything is older', () => {
  const o = office();
  for (let i = 0; i < 10; i++) o.say(i, `line ${i}`);
  o.event(20, 'agent.turn_finished', { lastMessage: 'the last answer' });
  const p = talkPage(o.deps, E, { since: at(4) });
  assert.deepEqual(p.messages.map((m) => m.body), ['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
  assert.equal(p.events.length, 1);
  assert.equal(p.more, true);
  assert.equal(talkPage(o.deps, E, { since: at(0) }).more, false);
});

test('search: the whole conversation, every word, any case or accent — the boss\'s words, the answers, files and notes; newest first', () => {
  const o = office();
  o.say(1, 'Pošalji mi RAČUN za novembar');
  o.event(2, 'agent.turn_finished', { lastMessage: 'Evo računa za novembar, u prilogu.' });
  o.event(3, 'agent.file_given', { file: { id: 'f1', name: 'racun-novembar.pdf' }, caption: 'the invoice' });
  o.event(4, 'task.completed', {}, 'Invoice task done');
  o.say(5, 'Something else entirely');
  o.say(6, 'racun for a client', { channel: 'rent' } as Partial<Message>);
  const r = talkSearch(o.deps, E, 'racun novembar');
  assert.deepEqual(r.hits.map((h) => [h.id, h.kind]), [['e3', 'file'], ['e2', 'reply'], ['m1', 'boss']]);
  assert.deepEqual(talkSearch(o.deps, E, 'invoice').hits.map((h) => h.id), ['e4', 'e3']);
  assert.equal(talkSearch(o.deps, E, '').hits.length, 0);
  const few = talkSearch(o.deps, E, 'racun', 1);
  assert.equal(few.hits.length, 1);
  assert.equal(few.more, true);
});

test('only what the person asking may read: a message or an event they may not read is not a line, nor a hit', () => {
  const o = office({ canMessage: (m) => m.id !== 'm1', canEvent: (e) => (e.id === 'e2' ? null : e) });
  o.say(1, 'secret plan');
  o.event(2, 'agent.turn_finished', { lastMessage: 'secret answer' });
  o.say(3, 'open words');
  const p = talkPage(o.deps, E, {});
  assert.deepEqual(p.messages.map((m) => m.id), ['m3']);
  assert.equal(p.events.length, 0);
  assert.equal(talkSearch(o.deps, E, 'secret').hits.length, 0);
});
