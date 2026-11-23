/**
 * Measured on the live office, 2026-11-23: no hand-in was ever checked by the office, half of the colleagues' reviews
 * ran nothing, some reviewers had done part of the work themselves. So: a colleague approves code the office did not
 * test only by saying what they checked, the owner reads it, and who worked on a ticket does not review it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Employee, Host, Project, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, reviewPrompt, type AgentLink } from '../src/index.ts';
import { syntaxCheckScript, syntaxChecked } from '../src/syntax-check.ts';

const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

async function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop: Project = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  const [alex, sarah, bo] = (['Alex', 'Sarah', 'Bo'] as const).map((name) => eng.employees.create({ name, roleKey: 'backend', projectId: shop.id, hostId: host.id, workingDir: '/tmp/x' })) as [Employee, Employee, Employee];
  const t = eng.tasks.createTask({ projectId: shop.id, title: 'Round prices to cents', kind: 'feature', released: false, reviewBy: 'both' });
  const handIn = (extra: Partial<Task> = {}) =>
    eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: alex.id, status: 'REVIEW', requiresReview: true, reviewBy: 'both', reviewStage: 'peer', reviewerId: sarah.id, ...extra } as Task);
  return { eng, alex, sarah, bo, handIn, task: () => eng.core.tasks.require(t.id) };
}

test('a colleague approves code nothing of the office tested only by saying what they checked — and the owner reads it', async () => {
  const o = await office();
  o.handIn();
  await assert.rejects(o.eng.tasks.submitReview(o.sarah, o.task().key, 'approve', 'Looks right.'), /nothing the office ran tests T-\d+.*"checked"/);
  assert.equal(o.task().reviewStage, 'peer', 'nothing was recorded');
  // Sending it back needs no "checked": what should change is said in the comments.
  const done = await o.eng.tasks.submitReview(o.sarah, o.task().key, 'approve', 'Looks right.', undefined, { checked: 'Ran php -l on both files and opened /prices on dev: 19.99 shows as 19.99.' });
  assert.equal(done.reviewStage, 'boss');
  assert.match(done.evidence.peerReview?.checked ?? '', /opened \/prices on dev/);
  assert.ok(done.comments?.some((c) => c.kind === 'approved' && /Checked: Ran php -l/.test(c.body)), 'said on the ticket too');
  const note = o.eng.core.notifications.filter((n) => n.kind === 'review' && n.taskId === done.id).at(-1)!;
  assert.match(note.body, /Sarah approved it: Looks right\.\nChecked: Ran php -l on both files/, 'and in the Inbox line the owner decides from');
});

test('a session whose tool has no "checked" yet says it in the comments', async () => {
  const o = await office();
  o.handIn();
  const t = await o.eng.tasks.submitReview(o.sarah, o.task().key, 'approve', 'Looks right.\n\nChecked: ran the price test on dev, 4 of 4 pass.');
  assert.equal(t.evidence.peerReview?.checked, 'ran the price test on dev, 4 of 4 pass.');
});

test('code the office tested with the project\'s own command needs no "checked"; a syntax check alone is not that', async () => {
  const o = await office();
  const measured = (kind: 'command' | 'syntax') => ({ evidence: { ...o.task().evidence, verification: { ts: new Date().toISOString(), command: kind === 'command' ? 'npm test' : 'syntax check of the changed files', exitCode: 0, passed: true, outputTail: '', durationMs: 5, provenance: 'measured' as const, kind } } });
  o.handIn(measured('syntax'));
  await assert.rejects(o.eng.tasks.submitReview(o.sarah, o.task().key, 'approve', 'Fine.'), /"checked"/);
  const prompt = reviewPrompt(o.task(), o.task(), o.eng.core.projects.require(o.task().projectId), 'Alex');
  assert.match(prompt, /Nothing the office ran tests this work \(it only checked that the changed files parse\)/);
  o.handIn(measured('command'));
  const t = await o.eng.tasks.submitReview(o.sarah, o.task().key, 'approve', 'Fine.');
  assert.equal(t.reviewStage, 'boss');
  assert.doesNotMatch(reviewPrompt(o.task(), o.task(), o.eng.core.projects.require(o.task().projectId), 'Alex'), /Nothing the office ran/);
});

test('who worked on a ticket with its author does not review it', async () => {
  const o = await office();
  o.handIn({ helperIds: [o.bo.id] });
  await assert.rejects(o.eng.tasks.submitReview(o.bo, o.task().key, 'approve', 'Good.', undefined, { checked: 'I ran it on dev myself and it works.' }), /you worked on T-\d+ with its author/);
});

test('the syntax check: what does not parse fails, what is gone or unknown is passed over, nothing is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-'));
  const put = (f: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  };
  put('src/bad.js', 'const a = ;\n');
  put('src/ok.mjs', 'export const a = 1;\n');
  put('data/bad.json', '{"a":1,}');
  put('tsconfig.json', '{ // comments are fine here\n}');
  put("it's ok.py", 'x = 1\n');
  put('-dash.sh', 'echo hi\n');
  put('README.md', '# not checked\n');
  const files = ['src/bad.js', 'src/ok.mjs', 'data/bad.json', 'tsconfig.json', "it's ok.py", '-dash.sh', 'README.md', 'src/deleted.js'];
  const r = syntaxCheckScript(files)!;
  assert.equal(r.files, 6, 'tsconfig and README are not of a kind it checks');
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  const run = spawnSync(r.script, { cwd: dir, shell: true, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /src\/bad\.js does not parse/);
  assert.match(run.stdout, /data\/bad\.json does not parse/);
  assert.doesNotMatch(run.stdout, /ok\.mjs does not parse|it's ok\.py does not parse|dash\.sh does not parse/);
  assert.ok(syntaxChecked(run.stdout) >= 3, run.stdout);
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before, 'nothing written into the folder (no __pycache__)');
  assert.equal(syntaxCheckScript(['README.md', 'logo.png']), null);
  const ok = spawnSync(syntaxCheckScript(['src/ok.mjs', 'src/deleted.js'])!.script, { cwd: dir, shell: true, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /syntax check: 1 checked, 0 failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});
