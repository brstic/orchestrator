import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureKey } from '../src/hook-receiver.ts';

const bash = (command: string, stderr: string, exitCode = 1) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { exitCode, stderr, stdout: '' } });

test('the same failure is recognised again when only its numbers differ', () => {
  const a = failureKey(bash('npm test', 'FAIL src/cart.test.ts:42\n  expected 3 to equal 4\n(took 1203 ms)'))!;
  const b = failureKey(bash('npm test', 'FAIL src/cart.test.ts:57\n  expected 3 to equal 5\n(took 988 ms)'))!;
  assert.equal(a.key, b.key);
  assert.equal(a.what, '`npm test` — FAIL src/cart.test.ts:42');
  assert.notEqual(a.key, failureKey(bash('npm test', 'SyntaxError: Unexpected token'))!.key, 'another error is another failure');
  assert.notEqual(a.key, failureKey(bash('npm run lint', 'FAIL src/cart.test.ts:42'))!.key, 'another command too');
  assert.equal(failureKey({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: '/repo/a.ts' }, error: 'String to replace not found in file.\nmore' })!.what, 'Edit — String to replace not found in file.');
});

test('what is not a failed tool call is not counted', () => {
  assert.equal(failureKey(bash('npm test', '', 0)), null, 'it passed');
  assert.equal(failureKey({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'sleep 100' }, error: 'interrupted', is_interrupt: true }), null, 'the owner pressed Escape');
  assert.equal(failureKey({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
  assert.equal(failureKey({ hook_event_name: 'PostToolUse', tool_name: 'mcp__orchestrator__complete_task', tool_input: {}, tool_response: { isError: true } }), null, 'an answer from the office is not a loop');
});

test('a credential in the failing command is not repeated in what is said about it', () => {
  const what = failureKey(bash(`curl -H "Authorization: Bearer ghp_${'a1B2'.repeat(9)}" https://api.example.com`, 'curl: (22) The requested URL returned error: 401'))!.what;
  assert.ok(!what.includes('ghp_'), what);
});
