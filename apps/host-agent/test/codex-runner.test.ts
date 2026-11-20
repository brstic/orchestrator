import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbidden } from '../src/codex-runner.ts';

/** What a Codex worker is stopped for when it starts it anyway (`codex-runner.ts`, `forbidden`). */
const scratch = '/tmp/orch-session/codex-scratch';

test('a command, a web search or an image from the disk stops the worker', () => {
  assert.match(forbidden({ type: 'commandExecution', command: 'ls' }, scratch)!, /run a command/);
  assert.match(forbidden({ type: 'webSearch', query: 'x' }, scratch)!, /search the web/);
  assert.match(forbidden({ type: 'imageView', path: '/etc/x.png' }, scratch)!, /open a file/);
});

test('its own file changes may be in its scratch folder only', () => {
  assert.equal(forbidden({ type: 'fileChange', changes: [{ path: 'notes.md' }, { path: `${scratch}/a/b.txt` }] }, scratch), null);
  assert.match(forbidden({ type: 'fileChange', changes: [{ path: '../../home/x' }] }, scratch)!, /outside/);
  assert.match(forbidden({ type: 'fileChange', changes: [{ path: '/etc/hosts' }] }, scratch)!, /outside/);
});

test('its scratch folder counts as itself whichever way it is written (through a link or not)', () => {
  assert.equal(forbidden({ type: 'fileChange', changes: [{ path: '/private/tmp/orch-session/codex-scratch/a.txt' }] }, [scratch, '/private/tmp/orch-session/codex-scratch']), null);
  assert.match(forbidden({ type: 'fileChange', changes: [{ path: '/private/tmp/elsewhere/a.txt' }] }, [scratch, '/private/tmp/orch-session/codex-scratch'])!, /outside/);
});

test('what it may do passes', () => {
  for (const type of ['agentMessage', 'reasoning', 'mcpToolCall', 'userMessage', 'plan']) assert.equal(forbidden({ type }, scratch), null, type);
});
