/**
 * Two employees in one folder worked in place, committing on the same branch at the same time: each task's evidence
 * and its Changes are its own commits only (`Task.ownCommits`, `TaskManager.noteCommit`, `gitDiff(…, commits)`). On the
 * live office 45% of the commits recorded on tickets were another ticket's.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;

before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.cleanup();
});

test("a task's commits are its own, though a colleague committed on the same branch meanwhile", async () => {
  const repo = h.makeRepo('shared');
  const project = await h.project('Shared', repo, { workspace: 'in_place', verifyCommand: null });
  const ava = await h.api<any>('POST', '/employees', { name: 'Ava', roleKey: 'backend', hostId: h.hostId, projectId: project.id, workingDir: repo });
  const bo = await h.api<any>('POST', '/employees', { name: 'Bo', roleKey: 'frontend', hostId: h.hostId, projectId: project.id, workingDir: repo });
  const a = await h.task({ projectId: project.id, title: 'Ava work', assigneeId: ava.id, reviewBy: 'none', description: '@@fake: write ava.txt one; bash git add ava.txt && git commit -q -m "ava one"; sleep 5000; write ava2.txt two; bash git add ava2.txt && git commit -q -m "ava two"; mcp complete_task {"summary":"Ava done.","tests_run":"none"}; result ava-done.txt@@' });
  const b = await h.task({ projectId: project.id, title: 'Bo work', assigneeId: bo.id, reviewBy: 'none', description: '@@fake: sleep 2000; write bo.txt b; bash git add bo.txt && git commit -q -m "bo one"; mcp complete_task {"summary":"Bo done.","tests_run":"none"}; result bo-done.txt@@' });
  const done = async (id: string) => waitFor(async () => {
    const t = await h.getTask(id);
    return t.status === 'DONE' ? t : null;
  }, { label: `done ${id}`, timeout: 60_000 }).catch(async (e) => {
    const t = await h.getTask(id);
    console.log(t.key, t.status, t.blockedReason, JSON.stringify(t.history.map((x: any) => x.note).slice(-8)));
    const ev = await h.api<any[]>('GET', `/events?employeeId=${t.assigneeId}&limit=80&includeActivity=1`);
    console.log(ev.slice(-30).map((x) => `${x.type} ${x.summary}`.slice(0, 200)).join('\n'));
    const s = await h.session(t.assigneeId!);
    if (s?.tmuxPane) console.log(h.tmux('capture-pane', '-p', '-S', '-60', '-t', s.tmuxPane));
    throw e;
  });
  const [ta, tb] = [await done(a.id), await done(b.id)];
  // Bo's commit landed between Ava's two, on the same branch.
  assert.deepEqual(h.git(repo, 'log', '--format=%s', '-3').trim().split('\n'), ['ava two', 'bo one', 'ava one']);
  assert.deepEqual(ta.evidence.commits.map((c: any) => c.subject), ['ava two', 'ava one'], "only Ava's");
  assert.deepEqual([...ta.evidence.filesChanged].sort(), ['ava.txt', 'ava2.txt']);
  assert.deepEqual(tb.evidence.commits.map((c: any) => c.subject), ['bo one']);
  // The Changes tab shows the same.
  const view = await h.api<{ diff: { files: string[]; diff: string } }>('GET', `/tasks/${a.id}/git`);
  assert.deepEqual([...view.diff.files].sort(), ['ava.txt', 'ava2.txt']);
  assert.doesNotMatch(view.diff.diff, /bo\.txt/);
});
