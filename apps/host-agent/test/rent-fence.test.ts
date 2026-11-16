import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostAgent } from '../src/agent.ts';
import { defaultConfig } from '../src/config.ts';

/**
 * The fence of a rented employee on their machine (`docs/RENT.md`): the tools the owner did not allow are refused, and
 * so is any file or folder outside the ones they work in — named to a file tool, or written out in a command.
 */
const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.cache', `orch-rent-fence-${process.pid}`);
const home = path.join(here, 'agent-home');
const kira = path.join(here, 'kira');
const lea = path.join(here, 'lea');
const bob = path.join(here, 'bob');
for (const d of [path.join(home, 'sessions', 'mine'), path.join(home, 'files', 'said'), kira, lea, bob]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(bob, path.join(kira, 'to-bob'));
after(() => fs.rmSync(here, { recursive: true, force: true }));

const agent = new HostAgent({ ...defaultConfig(), serverUrl: 'http://127.0.0.1:9', name: 'test', allowedRoots: [here] }, home, () => undefined);
const fence = { roots: [kira, lea], commands: true, edit: true, web: true, client: 'Ana' };
const decide = (tool: string, input: Record<string, unknown>, f: Partial<typeof fence> = {}): string | null => {
  const out = (agent as unknown as { rentFence: (t: unknown, p: unknown) => any }).rentFence({ sessionId: 'mine', cwd: kira, spec: null, fence: { ...fence, ...f } }, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: kira });
  return out?.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : null;
};

test('files: their own folder and their co-rented colleague\'s are theirs; anything else is refused, a link out included', () => {
  assert.equal(decide('Read', { file_path: path.join(kira, 'a.txt') }), null);
  assert.equal(decide('Read', { file_path: 'src/b.ts' }), null, 'relative to their folder');
  assert.equal(decide('Edit', { file_path: path.join(lea, 'x.ts') }), null, "the colleague's");
  assert.match(decide('Read', { file_path: path.join(bob, 'secret') })!, /outside the folders you work in/);
  assert.match(decide('Read', { file_path: '../bob/secret' })!, /outside/);
  assert.match(decide('Read', { file_path: 'to-bob/secret' })!, /outside/, 'through a link');
  assert.match(decide('Grep', { pattern: 'x', path: os.homedir() })!, /outside/);
  assert.match(decide('Glob', { pattern: '/etc/**' })!, /outside/);
  assert.equal(decide('Glob', { pattern: '**/*.ts' }), null);
  assert.equal(decide('Read', { file_path: path.join(home, 'files', 'said', 'pic.png') }), null, 'a file said to them');
  assert.equal(decide('Read', { file_path: '/usr/include/stdio.h' }), null, "the system's own");
});

test('commands: paths written out are read; one outside their folders is refused, an address on the web is not a path', () => {
  assert.equal(decide('Bash', { command: 'ls -la && cat src/a.ts | wc -l' }), null);
  assert.equal(decide('Bash', { command: `ls ${lea}` }), null);
  assert.equal(decide('Bash', { command: 'curl -s https://example.com/a/b > /tmp/page.html' }), null);
  assert.match(decide('Bash', { command: `cat ${path.join(bob, 'x')}` })!, /this command names/);
  assert.match(decide('Bash', { command: 'cat ~/.ssh/id_rsa' })!, /names ~\/\.ssh\/id_rsa/);
  assert.match(decide('Bash', { command: 'cd .. && ls' })!, /names \.\./);
  assert.match(decide('Bash', { command: 'cat "$HOME/notes"' })!, /names/);
});

test('what the owner did not allow is refused, whatever the path', () => {
  assert.match(decide('Bash', { command: 'echo hi' }, { commands: false })!, /not let you run commands/);
  assert.match(decide('Write', { file_path: path.join(kira, 'a') }, { edit: false })!, /read files, not change them/);
  assert.equal(decide('Read', { file_path: path.join(kira, 'a') }, { edit: false }), null);
  assert.match(decide('WebFetch', { url: 'https://example.com' }, { web: false })!, /not let you use the web/);
  assert.equal(decide('WebFetch', { url: 'https://example.com' }), null);
});

test('a session without a fence is not fenced', () => {
  const out = (agent as unknown as { rentFence: (t: unknown, p: unknown) => any }).rentFence({ sessionId: 'mine', cwd: kira, spec: null }, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } });
  assert.equal(out, null);
});
