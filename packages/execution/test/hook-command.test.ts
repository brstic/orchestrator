import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENT_UNREACHABLE_REASON, agentAwayMark, hookCommand } from '../src/claude.ts';

const bash = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } });
const read = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.txt' } });
const run = (shell: string, command: string, input: string) => spawnSync(shell, ['-c', command], { input, encoding: 'utf8', timeout: 20000 });
const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter((s) => fs.existsSync(s));

test('with no agent to reach, a bypass session\'s hook refuses a command and lets other tools be — in every shell here', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hook-'));
  const socketPath = path.join(dir, 'agent.sock');
  const command = hookCommand({ socketPath, token: 't', sessionId: 's', maxSeconds: 20, retrySeconds: 1, failClosed: true, launch: 'abc123def456' });
  for (const shell of shells) {
    fs.rmSync(agentAwayMark(socketPath), { force: true });
    const refused = run(shell, command, bash);
    assert.equal(refused.status, 0, shell);
    const said = JSON.parse(refused.stdout);
    assert.deepEqual([said.hookSpecificOutput.hookEventName, said.hookSpecificOutput.permissionDecision, said.hookSpecificOutput.permissionDecisionReason], ['PreToolUse', 'deny', AGENT_UNREACHABLE_REASON], shell);
    assert.ok(fs.existsSync(agentAwayMark(socketPath)), `${shell}: the mark that the agent is away`);
    // With the mark there the next hook does not wait again.
    const started = Date.now();
    const other = run(shell, command, read);
    assert.deepEqual([other.status, other.stdout], [0, ''], `${shell}: another tool gets no opinion`);
    assert.ok(Date.now() - started < 900, `${shell}: and did not wait (${Date.now() - started} ms)`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the refusal is printed even when the mark cannot be written (the agent\'s folder is gone)', () => {
  const socketPath = path.join(os.tmpdir(), `orch-no-such-folder-${process.pid}`, 'agent.sock');
  const command = hookCommand({ socketPath, token: 't', sessionId: 's', maxSeconds: 20, retrySeconds: 0, failClosed: true });
  for (const shell of shells) {
    const refused = run(shell, command, bash);
    assert.equal(refused.status, 0, shell);
    assert.match(refused.stdout, /"permissionDecision":"deny"/, `${shell} printed the refusal`);
  }
});

test('a hook of a session that is not in bypass mode says nothing when no agent answers; one that neither retries nor refuses is the plain command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hook-'));
  const socketPath = path.join(dir, 'agent.sock');
  const asking = hookCommand({ socketPath, token: 't', sessionId: 's', maxSeconds: 20, retrySeconds: 1 });
  for (const shell of shells) assert.deepEqual([run(shell, asking, bash).status, run(shell, asking, bash).stdout], [0, ''], shell);
  const plain = hookCommand({ socketPath, token: "to'ken", sessionId: 's', maxSeconds: 30, launch: 'abc123def456' });
  assert.match(plain, /^curl -sS --max-time 30 /);
  assert.match(plain, /-H 'x-orch-launch: abc123def456'/);
  assert.doesNotMatch(hookCommand({ socketPath, token: 't', sessionId: 's', maxSeconds: 30, launch: "x'; rm -rf ~; '" }), /rm -rf/, 'a name that is not a plain one is left out');
  for (const shell of shells) assert.deepEqual([run(shell, plain, bash).status, run(shell, plain, bash).stdout], [0, ''], shell);
  fs.rmSync(dir, { recursive: true, force: true });
});
