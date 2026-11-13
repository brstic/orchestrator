/**
 * What is merged is what was checked and reviewed.
 *
 * A task's branch stays checked out in its author's folder while the work waits for its review. The office used to
 * merge "the branch" when the review approved it — whatever it pointed at by then, commits made after the check
 * included. It now merges the commit that was verified. And an approval is for the work as it stood: when a task
 * goes back to its author, what comes next is reviewed again; approved work that cannot be merged yet is not "done".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let project = '';
let repo = '';
let integration = '';
const ids: Record<string, string> = {};
const settled = (id: string, status: string, label: string) => waitFor(async () => ((await h.getTask(id)).status === status ? h.getTask(id) : null), { label, timeout: 60000 });
const merged = () => h.git(repo, 'ls-tree', '-r', '--name-only', integration).split('\n').filter(Boolean);

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('shop');
  const p = await h.project('Shop', repo, { verifyCommand: null, policy: { requireReview: true, autoMerge: true } });
  project = p.id;
  integration = p.integrationBranch;
  for (const name of ['Alex', 'Bea']) ids[name] = (await h.employee(name, 'backend', { projectId: project, autonomy: 'auto' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('commits made on the branch after the work was handed in are not merged with it', async () => {
  const t = await h.task({ projectId: project, title: 'Add the footer', assigneeId: ids.Alex, requiresReview: true, description: '@@fake: write footer.txt reviewed; commit the footer; complete footer added@@' });
  const held = await settled(t.id, 'REVIEW', 'waiting for its review');
  assert.match(held.evidence.headSha ?? '', /^[0-9a-f]{40}$/, 'the commit that was checked is on record');
  assert.equal(held.evidence.headSha, h.git(held.worktree!, 'rev-parse', 'HEAD').trim());
  // While it waits, its author goes on committing in the same folder, on the same branch.
  fs.writeFileSync(path.join(held.worktree!, 'backdoor.txt'), 'nobody checked or saw this\n');
  h.git(held.worktree!, 'add', 'backdoor.txt');
  h.git(held.worktree!, '-c', 'user.name=Alex', '-c', 'user.email=alex@example.test', 'commit', '-q', '-m', 'one more thing');
  assert.notEqual(h.git(held.worktree!, 'rev-parse', 'HEAD').trim(), held.evidence.headSha);
  // The review approves what it was shown.
  await h.api('POST', `/tasks/${t.id}/review`, { verdict: 'approve', comments: 'The footer is fine.' });
  const done = await settled(t.id, 'DONE', 'merged and done');
  assert.equal(done.evidence.merge?.ok, true);
  const files = merged();
  assert.ok(files.includes('footer.txt'), 'the reviewed work is in');
  assert.ok(!files.includes('backdoor.txt'), 'the commit made after the check is not');
  assert.ok(done.history.some((x) => /1 commit made on .* after the work was checked was not merged/.test(x.note)));
  assert.ok((await h.state()).notifications.some((n) => n.taskId === t.id && /commits after the check were left out of the merge/.test(n.title)));
});

test('an approval is for the work as it stood: back with its author, what comes next is reviewed again', async () => {
  await waitFor(async () => (await h.session(ids.Alex!))?.inTurn === false, { label: 'Alex free', timeout: 40000 });
  const t = await h.task({ projectId: project, title: 'Add the header', assigneeId: ids.Alex, requiresReview: true, released: false, description: '@@fake: write header.txt second-version; commit the header again; complete header redone@@' });
  // As it stands after an approved review whose merge then failed, and the task was unblocked for its author:
  const rec = h.server.engine.core.tasks.require(t.id);
  rec.evidence.review = { reviewerId: ids.Bea!, verdict: 'approved', comments: 'fine as it was', ts: new Date().toISOString(), by: 'employee' };
  h.server.engine.core.put('task', rec);
  await h.api('POST', '/tasks/release', { ids: [t.id] });
  const again = await settled(t.id, 'REVIEW', 'in review again, not done on the old approval');
  assert.equal(again.evidence.review ?? null, null);
  assert.ok(!merged().includes('header.txt'), 'nothing was merged on the strength of an approval of something else');
  await h.api('POST', `/tasks/${t.id}/review`, { verdict: 'approve', comments: 'Now it is.' });
  await settled(t.id, 'DONE', 'done after its own review');
  assert.ok(merged().includes('header.txt'));
});

test('approved while its author\'s machine is away: it waits to be merged, and is done when it is', async () => {
  // (Somebody with nothing else in hand: the colleagues above may still be looking at each other's work.)
  ids.Cy = (await h.employee('Cy', 'backend', { projectId: project, autonomy: 'auto' })).id;
  const t = await h.task({ projectId: project, title: 'Add the sidebar', assigneeId: ids.Cy, requiresReview: true, description: '@@fake: write sidebar.txt ok; commit the sidebar; complete sidebar added@@' });
  await settled(t.id, 'REVIEW', 'waiting for its review');
  const depends = await h.task({ projectId: project, title: 'Style the sidebar', assigneeId: ids.Alex, dependsOn: [t.id], description: '@@fake: say alex-started-the-styling@@' });
  await h.stopAgent();
  await waitFor(async () => (await h.state()).hosts.find((x) => x.id === h.hostId)?.status !== 'online', { label: 'the machine is away', timeout: 15000 });
  await h.api('POST', `/tasks/${t.id}/review`, { verdict: 'approve', comments: 'Good.' });
  const waiting = await settled(t.id, 'BLOCKED', 'approved, waiting to be merged');
  assert.match(waiting.blockedReason ?? '', /Waiting to be merged into .*: Cy's machine is not reachable right now/);
  assert.ok(!merged().includes('sidebar.txt'));
  assert.notEqual((await h.getTask(depends.id)).status, 'IN_PROGRESS', 'what depends on it has not started without it');
  // The machine comes back: the office merges it by itself (the owner's "Retry merge" does the same).
  await h.startAgent();
  await settled(t.id, 'DONE', 'merged once the machine is back');
  assert.ok(merged().includes('sidebar.txt'));
});
