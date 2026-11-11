import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupLines } from '../src/main.ts';

test('the office\'s own token is shown to a person at a terminal and never written where a log is kept', () => {
  const token = 'orch_owner_ThisIsNotARealOne0123456789';
  const terminal = startupLines('http://127.0.0.1:4600', token, '/home/x/.orchestrator/server/owner-token', true).join('\n');
  assert.match(terminal, new RegExp(`http://127\\.0\\.0\\.1:4600/\\?token=${token}`));
  const log = startupLines('http://127.0.0.1:4600', token, '/home/x/.orchestrator/server/owner-token', false).join('\n');
  assert.doesNotMatch(log, /orch_owner_|token=/);
  assert.match(log, /http:\/\/127\.0\.0\.1:4600/);
  assert.match(log, /stored in \/home\/x\/\.orchestrator\/server\/owner-token/);
});
