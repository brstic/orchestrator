import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupLines, stumbleNet } from '../src/main.ts';

test('the office\'s own token is shown to a person at a terminal and never written where a log is kept', () => {
  const token = 'orch_owner_ThisIsNotARealOne0123456789';
  const terminal = startupLines('http://127.0.0.1:4600', token, '/home/x/.orchestrator/server/owner-token', true).join('\n');
  assert.match(terminal, new RegExp(`http://127\\.0\\.0\\.1:4600/\\?token=${token}`));
  const log = startupLines('http://127.0.0.1:4600', token, '/home/x/.orchestrator/server/owner-token', false).join('\n');
  assert.doesNotMatch(log, /orch_owner_|token=/);
  assert.match(log, /http:\/\/127\.0\.0\.1:4600/);
  assert.match(log, /stored in \/home\/x\/\.orchestrator\/server\/owner-token/);
});

test('a stumble in the office\'s own code is written down and the office goes on; ten in a minute stop it', () => {
  let now = Date.parse('2026-11-11T12:00:00Z');
  const lines: string[] = [];
  let stopped = 0;
  const net = stumbleNet((l) => void lines.push(l), () => void stopped++, { now: () => now });
  const caught = net('uncaught exception');
  for (let i = 0; i < 9; i++) {
    caught(new TypeError(`Cannot read properties of null (reading 't') #${i}`));
    now += 1000;
  }
  assert.equal(stopped, 0, 'nine in nine seconds: still running');
  assert.equal(lines.length, 9);
  assert.match(lines[0]!, /^\[2026-11-11T12:00:00\.000Z\] ERROR uncaught exception: TypeError: Cannot read properties of null/);
  // Spread out, they never add up: one every ten seconds, for ever.
  now += 120_000;
  for (let i = 0; i < 30; i++) {
    net('unhandled rejection')('a promise nobody waited for');
    now += 10_000;
  }
  assert.equal(stopped, 0);
  // Ten within the minute: something is really wrong.
  now += 120_000;
  for (let i = 0; i < 10; i++) caught(new Error('again'));
  assert.equal(stopped, 1);
});
