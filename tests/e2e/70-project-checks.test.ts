/**
 * What could check a project, read from its repository on its machine, and one tried there (`check-finder.tsx`,
 * `TaskManager.checksFor`/`tryCheck`, `detectChecks`): a real server, a real host agent, a real repository.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mayCall } from '../../apps/server/src/access.ts';
import { createHarness, type Harness } from './harness.ts';

let h: Harness;
let project: any;
let repo = '';

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('shop');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node check.js', lint: 'node -e "process.exit(0)"', dev: 'node server.js' } }, null, 2));
  project = await h.project('Shop', repo, { verifyCommand: null, workspace: 'in_place' });
});
after(async () => {
  await h.cleanup();
});

test('the repository offers its checks; the project has none yet', async () => {
  const r = await h.api<{ current: string | null; candidates: Array<{ command: string; kind: string }> }>('GET', `/projects/${project.id}/checks`);
  assert.equal(r.current, null);
  assert.deepEqual(r.candidates.map((c) => [c.command, c.kind]), [['npm test --silent', 'tests'], ['npm run -s lint', 'lint']]);
});

test('one tried: passing, failing with its output — and nothing is set by trying', async () => {
  const ok = await h.api<{ passed: boolean; durationMs: number }>('POST', `/projects/${project.id}/checks/try`, { command: 'npm test --silent' });
  assert.equal(ok.passed, true);
  const bad = await h.api<{ passed: boolean; exitCode: number; outputTail: string }>('POST', `/projects/${project.id}/checks/try`, { command: 'echo "it broke here" && exit 3' });
  assert.deepEqual([bad.passed, bad.exitCode], [false, 3]);
  assert.match(bad.outputTail, /it broke here/);
  assert.equal((await h.state()).projects.find((p) => p.id === project.id)!.verifyCommand, null);
  await assert.rejects(h.api('POST', `/projects/${project.id}/checks/try`, { command: '' }), /give the command/);
});

test('owners only: a colleague may neither read nor try', () => {
  const colleague = { kind: 'guest' as const, id: 'm1', name: 'Dana', role: 'colleague' as const };
  assert.equal(mayCall(h.server.engine, colleague, 'GET', `/projects/${project.id}/checks`, null).ok, false);
  assert.equal(mayCall(h.server.engine, colleague, 'POST', `/projects/${project.id}/checks/try`, { command: 'rm -rf /' }).ok, false);
});
