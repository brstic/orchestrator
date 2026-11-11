import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostAgent } from '../src/agent.ts';
import { defaultConfig } from '../src/config.ts';

/**
 * The fence around the office's own files on a machine, as it reads a shell command: which words of it name such a
 * file, and how long finding out may take. The command is the session's to shape, and the agent has one thread.
 */
const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.cache', `orch-fence-${process.pid}`);
const home = path.join(here, 'agent-home');
const work = path.join(here, 'work');
fs.mkdirSync(path.join(work, 'src'), { recursive: true });
fs.mkdirSync(path.join(home, 'sessions', 'mine', 'browser'), { recursive: true });
fs.mkdirSync(path.join(home, 'sessions', 'hers'), { recursive: true });
fs.writeFileSync(path.join(home, 'sessions', 'hers', 'mcp.json'), '{}');
fs.writeFileSync(path.join(home, 'config.json'), '{}');
fs.symlinkSync(home, path.join(work, 'a-link'));
after(() => fs.rmSync(here, { recursive: true, force: true }));

const agent = new HostAgent({ ...defaultConfig(), serverUrl: 'http://127.0.0.1:9', name: 'test', allowedRoots: [work] }, home, () => undefined);
const mentioned = (command: string): boolean => (agent as unknown as { officeFiles: (t: { sessionId: string; cwd: string }) => { mentioned: (c: string) => boolean } }).officeFiles({ sessionId: 'mine', cwd: work }).mentioned(command);
const timed = (command: string): [boolean, number] => {
  const t0 = process.hrtime.bigint();
  const found = mentioned(command);
  return [found, Number(process.hrtime.bigint() - t0) / 1e6];
};

test('a command that names one of the office\'s own files is seen; one that names the session\'s own folder, or anything else, is not', () => {
  assert.equal(mentioned(`cat ${path.join(home, 'config.json')}`), true);
  assert.equal(mentioned(`cp "${path.join(home, 'sessions', 'hers', 'mcp.json')}" /tmp/x`), true);
  assert.equal(mentioned('cat a-link/config.json'), true, 'through a link in the working folder');
  assert.equal(mentioned(`ls ${path.join(home, 'sessions', 'mine', 'browser')}/shot.png`), false, 'its own folder');
  assert.equal(mentioned('ls src/ && cat ./src/index.ts > /dev/null'), false);
  assert.equal(mentioned('echo no paths here'), false);
});

test('padding does not get a plain path past the fence', () => {
  const padding = Array.from({ length: 60_000 }, (_, i) => `d${i}/f`).join(' ');
  const [found, ms] = timed(`echo ${padding}; cat ${path.join(home, 'config.json')}`);
  assert.equal(found, true);
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});

test('reading a command for such paths takes time in step with its length: one built to be slow is not', () => {
  const hostile: Record<string, string> = {
    'one path, a hundred thousand folders deep': `cat ${'x/'.repeat(100_000)}y`,
    'paths as deep as a path can be': Array.from({ length: 60 }, (_, i) => `p${i}/${'x/'.repeat(1900)}y`).join(' '),
    'sixty thousand different paths': Array.from({ length: 60_000 }, (_, i) => `d${i}/f`).join(' '),
    'the same path, over and over': 'src/a/b/c/d '.repeat(40_000),
    'sixty thousand paths in its own folder': Array.from({ length: 60_000 }, (_, i) => path.join(home, 'sessions', 'mine', 'browser', `shot-${i}.png`)).join(' '),
    'the home folder, over and over': '$HOME/x '.repeat(30_000),
    'separators only': ';|&'.repeat(70_000),
  };
  for (const [what, command] of Object.entries(hostile)) {
    const [, ms] = timed(command);
    assert.ok(ms < 1500, `${what}: ${Math.round(ms)} ms for ${command.length} characters`);
  }
});
