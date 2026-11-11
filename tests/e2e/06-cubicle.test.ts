/**
 * The "cubicle" model: an employee lives in a folder and owns the project in
 * it. The owner can walk up and talk to them directly; Orchestrator manages
 * everyone from above.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let folder = '';
let lena: any;

before(async () => {
  h = await createHarness();
  folder = h.makeRepo('billing-service');
});
after(async () => {
  await h.cleanup();
});

test('hiring someone into a folder makes that folder their project, worked in place', async () => {
  lena = await h.api('POST', '/employees', { name: 'Lena', roleKey: 'backend', hostId: h.hostId, workingDir: folder, autonomy: 'standard', verifyCommand: 'npm test --silent' });
  const state = await h.state();
  const project = state.projects.find((p) => p.id === lena.projectId)!;
  assert.ok(project, 'a project was created for the folder');
  assert.equal(project.name, 'billing-service');
  assert.equal(project.repoPath, folder);
  assert.equal(project.workspace, 'in_place');
  assert.equal(project.ownerEmployeeId, lena.id);
  assert.equal(project.verifyCommand, 'npm test --silent');
  // A folder that does not exist on the machine is refused, not silently accepted.
  const bad = await h.apiRaw('POST', '/employees', { name: 'Ghost', roleKey: 'backend', hostId: h.hostId, workingDir: path.join(h.tmp, 'nowhere') });
  assert.equal(bad.status, 400);
});

test('walking up and talking: the instruction reaches their real session and their real reply comes back', async () => {
  const session = await h.api('POST', `/employees/${lena.id}/start`, {});
  assert.equal(session.cwd, folder, 'the session lives in the folder itself, not in a worktree');
  await waitFor(async () => (await h.session(lena.id))!.inTurn === false, { label: 'Lena ready' });
  const msg = await h.api('POST', `/employees/${lena.id}/message`, { body: 'Please look at the README and tell me what this service does. @@fake: read README.md; say It is the billing service; it has a README and a test script.@@' });
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === msg.id)!.delivery.status === 'confirmed', { label: 'delivered to the session' });
  // The reply is the final message of that turn, as reported by Claude Code's Stop hook.
  const reply = await waitFor(async () => (await h.api('GET', `/events?employeeId=${lena.id}&limit=200`)).find((e: any) => e.type === 'agent.turn_finished' && /billing service/.test(e.data.lastMessage ?? '')), { label: 'reply captured' });
  assert.equal(reply.source.kind, 'hook');
  assert.match(reply.data.lastMessage, /It is the billing service/);
});

test('a task for them is done in place: no worktree, no branch switching, no merge — still verified', async () => {
  await waitFor(async () => (await h.session(lena.id))!.inTurn === false, { label: 'idle' });
  const task = await h.task({ projectId: lena.projectId, title: 'Add invoice numbering', assigneeId: lena.id, description: '@@fake: write invoice.txt numbered; commit add invoice numbering; complete numbering added@@' });
  const done = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'done', timeout: 20000 });
  assert.equal(done.worktree, folder);
  assert.equal(done.branch, 'main', 'worked on the branch that was checked out');
  assert.equal(done.evidence.merge, null, 'nothing to merge');
  assert.equal(done.evidence.commits.length, 1);
  assert.equal(done.evidence.verification!.provenance, 'measured');
  assert.equal(done.evidence.verification!.passed, true);
  assert.match(h.git(folder, 'log', '--oneline', '-1'), /add invoice numbering/);
  assert.equal(h.git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.ok(!fs.existsSync(path.join(path.dirname(folder), '.orchestrator-worktrees')), 'no worktrees were created');
  assert.equal(h.git(folder, 'branch', '--list', 'orchestrator/*'), '', 'no integration branch either');
});

test("the owner's own uncommitted files in the folder never block a task and are never the employee's to tidy", async () => {
  await waitFor(async () => (await h.session(lena.id))!.inTurn === false, { label: 'idle' });
  // The owner is in the middle of something in their own folder.
  fs.writeFileSync(path.join(folder, 'owner-notes.txt'), 'half-written thoughts\n');
  fs.appendFileSync(path.join(folder, 'README.md'), '\nTODO from the owner\n');
  const task = await h.task({
    projectId: lena.projectId,
    title: 'Add tax rates',
    assigneeId: lena.id,
    description: '@@fake: write scratch.txt leftover; write tax.txt rates; bash git add tax.txt && git commit -q -m "add tax rates"; complete first attempt; bash git add scratch.txt && git commit -q -m "keep scratch"; complete tax rates added@@',
  });
  const started = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.delivery.status === 'confirmed' ? t : null;
  }, { label: 'task delivered' });
  assert.deepEqual([...started.baseDirty!].sort(), ['README.md', 'owner-notes.txt'], 'what was already uncommitted is recorded as the owner’s');
  const done = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'done', timeout: 20000 });
  const session = (await h.session(lena.id))!;
  const screen = h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', session.tmuxPane!);
  // The first attempt was refused because of the employee's own leftover — and only that.
  assert.match(screen, /these files changed during this task and are not committed/);
  const refusal = screen.slice(screen.indexOf('these files changed during this task'));
  assert.match(refusal, /scratch\.txt/);
  assert.doesNotMatch(refusal.split('Commit what belongs')[0]!, /owner-notes\.txt|README\.md/);
  assert.equal(done.evidence.commits.length, 2);
  // The owner's work in progress is exactly as they left it.
  assert.equal(h.git(folder, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort().join('|'), '?? owner-notes.txt|M README.md');
  assert.equal(fs.readFileSync(path.join(folder, 'owner-notes.txt'), 'utf8'), 'half-written thoughts\n');
  h.git(folder, 'checkout', '--', 'README.md');
  fs.rmSync(path.join(folder, 'owner-notes.txt'));
});

test('a second employee in the same folder shares the project but never edits it at the same time', async () => {
  const omar = await h.api('POST', '/employees', { name: 'Omar', roleKey: 'backend', hostId: h.hostId, workingDir: folder, autonomy: 'standard' });
  assert.equal(omar.projectId, lena.projectId, 'same folder → same project');
  assert.equal((await h.state()).projects.find((p) => p.id === lena.projectId)!.ownerEmployeeId, lena.id, 'the folder still belongs to Lena');
  await waitFor(async () => (await h.session(lena.id))!.inTurn === false, { label: 'Lena idle' });
  const t1 = await h.task({ projectId: lena.projectId, title: 'Long change', assigneeId: lena.id, description: '@@fake: write long.txt a; sleep 3000; say still going@@' });
  await waitFor(async () => (await h.getTask(t1.id)).delivery.status === 'confirmed', { label: 'Lena working' });
  const t2 = await h.task({ projectId: lena.projectId, title: 'Colliding change', assigneeId: omar.id, description: '@@fake: write long.txt b@@' });
  // It waits its turn — ready, not blocked — and says for whom.
  const waiting = await waitFor(async () => {
    const t = await h.getTask(t2.id);
    return t.progress.note ? t : null;
  }, { label: 'the second change waits' });
  assert.equal(waiting.status, 'READY');
  assert.match(waiting.progress.note!, /^Waiting for Lena to finish T-\d+: they work in the same folder/);
});
