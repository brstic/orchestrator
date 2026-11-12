/**
 * The dots over an employee I spoke to ("working on what you said") are shown only while somebody can be working on
 * it, and a wait whose answer will not come is ended (`src/lib/asks.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNACKNOWLEDGED_MS, answerAmong, askState, type AskFacts } from '../src/lib/asks.ts';

const now = Date.parse('2026-11-12T09:00:00Z');
const ask = { messageId: 'm1', at: now - 10 * 60_000 };
const employee = { archived: false };
const running = (inTurn: boolean | null, activity = 'idle') => ({ status: 'running', inTurn, activity });
const delivered = (status: string) => ({ status, ts: new Date(ask.at + 1000).toISOString() });
const facts = (over: Partial<AskFacts>): AskFacts => ({ ask, employee, session: running(true, 'thinking'), delivery: delivered('confirmed'), now, ...over });

test('dots while they are in the turn my message started', () => {
  assert.equal(askState(facts({})), 'working');
  // Whatever they are shown doing in it: a turn is a turn.
  assert.equal(askState(facts({ session: running(true, 'waiting_answer') })), 'working');
});

test('no dots over somebody who is between turns: the turn ended, however it ended', () => {
  // Interrupted, ended in an error, or finished while this window was closed — the office says "between turns".
  for (const activity of ['idle', 'waiting_input', 'unknown', 'task_complete']) assert.equal(askState(facts({ session: running(false, activity) })), 'over', activity);
});

test('no dots over somebody who is not at work, or not in the office any more', () => {
  for (const status of ['exited', 'crashed', 'host_offline', 'stopped']) assert.equal(askState(facts({ session: { status, inTurn: false, activity: 'offline' } })), 'over', status);
  assert.equal(askState(facts({ session: undefined })), 'over');
  assert.equal(askState(facts({ employee: undefined })), 'over');
  assert.equal(askState(facts({ employee: { archived: true } })), 'over');
});

test('a message that could not be delivered is not waited for', () => {
  assert.equal(askState(facts({ delivery: delivered('failed') })), 'over');
});

test('a message that is still on its way: dots when their session is up, nothing (but remembered) when it is not', () => {
  // They are in another turn; mine is handed over when it ends.
  assert.equal(askState(facts({ delivery: { status: 'queued', ts: null }, session: running(true, 'coding') })), 'working');
  assert.equal(askState(facts({ delivery: { status: 'queued', ts: null }, session: running(false) })), 'working');
  assert.equal(askState(facts({ delivery: { status: 'queued', ts: null }, session: { status: 'starting', inTurn: null, activity: 'unknown' } })), 'working');
  // Nobody is thinking: it waits for them to be started.
  assert.equal(askState(facts({ delivery: { status: 'queued', ts: null }, session: { status: 'exited', inTurn: false, activity: 'offline' } })), 'pending');
  assert.equal(askState(facts({ delivery: { status: 'queued', ts: null }, session: undefined })), 'pending');
});

test('typed into the session but not acknowledged yet: a moment to start, not for ever', () => {
  const just = { messageId: 'm1', at: now - 2000 };
  assert.equal(askState(facts({ ask: just, delivery: delivered('sent'), session: running(false) })), 'working');
  assert.equal(askState(facts({ ask: { ...just, at: now - UNACKNOWLEDGED_MS - 1 }, delivery: delivered('sent'), session: running(false) })), 'over');
  // Acknowledged and between turns is over at once: the acknowledgement is the start of the turn.
  assert.equal(askState(facts({ ask: just, delivery: delivered('confirmed'), session: running(false) })), 'over');
});

test('a session that reports no turns (no hooks) is judged by what it is seen doing', () => {
  assert.equal(askState(facts({ session: running(null, 'coding') })), 'working');
  assert.equal(askState(facts({ session: running(null, 'idle') })), 'over');
  assert.equal(askState(facts({ ask: { messageId: 'm1', at: now - 1000 }, session: running(null, 'idle') })), 'working');
});

test('a message the office no longer lists counts as typed in when I said it', () => {
  assert.equal(askState(facts({ delivery: undefined, session: running(true) })), 'working');
  assert.equal(askState(facts({ delivery: undefined, session: running(false) })), 'over');
  assert.equal(askState(facts({ ask: { messageId: null, at: now - 1000 }, delivery: undefined, session: running(false) })), 'working');
});

test('the answer to a wait that ended unseen is their last finished turn since my message reached them', () => {
  const at = (s: number) => new Date(ask.at + s * 1000).toISOString();
  const end = (employeeId: string, s: number, lastMessage: string) => ({ type: 'agent.turn_finished', employeeId, ts: at(s), data: { lastMessage } });
  const d = { ts: at(1) };
  // The turn before my message is not an answer to it.
  assert.equal(answerAmong([end('e1', -30, 'earlier')], 'e1', ask, d), null);
  assert.deepEqual(answerAmong([end('e1', -30, 'earlier'), end('e2', 20, 'somebody else'), end('e1', 40, '  here it is  '), { type: 'agent.tool_used', employeeId: 'e1', ts: at(50) }], 'e1', ask, d), { text: 'here it is', ts: at(40) });
  // The last one, when they went on by themselves after it.
  assert.equal(answerAmong([end('e1', 40, 'first'), end('e1', 90, 'second')], 'e1', ask, d)?.text, 'second');
  assert.equal(answerAmong([], 'e1', ask, d), null);
  // Without the office's time of delivery, since I said it.
  assert.equal(answerAmong([end('e1', 5, 'yes')], 'e1', ask, undefined)?.text, 'yes');
  assert.equal(answerAmong([end('e1', -5, 'no')], 'e1', ask, undefined), null);
});
