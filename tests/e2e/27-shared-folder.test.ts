/**
 * Several employees under one project folder, and a session that loses the office.
 *
 *  - A project whose folder holds several repositories: each employee works in their own subfolder, at the same
 *    time, and nobody waits for the root.
 *  - A session whose Claude Code reports the office's tools as not connected is started again by the office with the
 *    same conversation, instead of being told again and again to finish what it cannot report.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let root = '';
let project = '';
const ids: Record<string, string> = {};
const cutOffs = async () => (await h.api<any[]>('GET', '/events?limit=400')).filter((e) => e.type === 'session.cut_off');

before(async () => {
  h = await createHarness();
  // One folder that is not a repository itself, with a repository per part — and somebody for each.
  const api = h.makeRepo('suite/api');
  const web = h.makeRepo('suite/web');
  root = path.dirname(api);
  project = (await h.project('Suite', root, { verifyCommand: null, workspace: 'in_place' })).id;
  ids.Ana = (await h.employee('Ana', 'backend', { projectId: project, workingDir: api, autonomy: 'autonomous' })).id;
  ids.Ben = (await h.employee('Ben', 'frontend', { projectId: project, workingDir: web, autonomy: 'autonomous' })).id;
  ids.Cy = (await h.employee('Cy', 'fullstack', { projectId: project, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('people with their own subfolder of the project work there, all at once, and nobody waits for the root', async () => {
  for (const n of ['Ana', 'Ben', 'Cy']) assert.equal((await h.state()).employees.find((e) => e.id === ids[n])!.projectId, project, `${n} is on the project`);
  const a = await h.task({ projectId: project, title: 'Ana holds the api', assigneeId: ids.Ana, description: '@@fake: write a.txt 1; say holding on to it@@' });
  await waitFor(async () => (await h.getTask(a.id)).delivery.status === 'confirmed', { label: 'Ana working', timeout: 30000 });
  const b = await h.task({ projectId: project, title: 'Ben changes the web', assigneeId: ids.Ben, description: '@@fake: write b.txt 2; commit b; complete web changed@@' });
  const c = await h.task({ projectId: project, title: 'Cy looks at the whole', assigneeId: ids.Cy, description: '@@fake: write notes.txt 3; complete-nocode looked at it@@' });
  const doneB = await waitFor(async () => {
    const t = await h.getTask(b.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'Ben done while Ana works', timeout: 40000 });
  const doneC = await waitFor(async () => {
    const t = await h.getTask(c.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'Cy done while Ana works', timeout: 40000 });
  const stillA = await h.getTask(a.id);
  assert.equal(stillA.status, 'IN_PROGRESS');
  // Each in their own folder; the one with none, at the project's.
  assert.equal(stillA.worktree, path.join(root, 'api'));
  assert.equal(doneB.worktree, path.join(root, 'web'));
  assert.equal(doneC.worktree, root);
  assert.equal((await h.session(ids.Ben!))!.cwd, path.join(root, 'web'));
  assert.ok(fs.existsSync(path.join(root, 'web', 'b.txt')) && fs.existsSync(path.join(root, 'api', 'a.txt')) && fs.existsSync(path.join(root, 'notes.txt')));
  assert.equal(doneB.evidence.commits.length, 1, "Ben's commit is in the web repository");
  for (const t of [stillA, doneB, doneC]) {
    assert.equal(t.history.some((x) => /^Waiting for/.test(x.note)), false, `${t.key} never waited`);
    assert.equal(t.sharedWith ?? null, null, 'different repositories are not a shared folder');
  }
  await waitFor(async () => (await h.session(ids.Ana!))!.inTurn === false, { label: 'Ana between turns', timeout: 20000 });
  await h.api('POST', `/employees/${ids.Ana}/message`, { body: 'Wrap up. @@fake: bash git add a.txt && git commit -q -m a; complete api held@@' });
  await waitFor(async () => (await h.getTask(a.id)).status === 'DONE', { label: 'Ana done', timeout: 30000 });
});

test('a session that lost the office is started again with the same conversation, not nudged to report what it cannot', async () => {
  const before = (await h.session(ids.Ben!))!;
  const t = await h.task({ projectId: project, title: 'Ben loses the office', assigneeId: ids.Ben, description: '@@fake: write c.txt 3; commit c; cutoff complete_task; say I cannot reach the office@@' });
  const again = await waitFor(async () => {
    const s = await h.session(ids.Ben!);
    return s?.status === 'running' && s.startedAt !== before.startedAt ? s : null;
  }, { label: 'Ben started again', timeout: 30000 });
  assert.equal(again.resumed, true, 'the same conversation');
  assert.equal(again.cwd, path.join(root, 'web'));
  const task = await h.getTask(t.id);
  assert.equal(task.status, 'IN_PROGRESS', 'the task is still his');
  assert.equal(task.nudges, 0, 'not told to finish while he could not');
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === ids.Ben && /had lost its connection to the office/.test(m.body) && m.delivery.status !== 'queued'), { label: 'Ben is told', timeout: 20000 });
  assert.match(told.body, new RegExp(`Go on with ${t.key} "Ben loses the office" from where you were`));
  assert.match((await cutOffs())[0].summary, /Ben's session lost its connection to the office's tools; it is being started again with the same conversation/);
  // The tools work in the new session: he finishes.
  await waitFor(async () => (await h.session(ids.Ben!))!.inTurn === false, { label: 'Ben between turns', timeout: 20000 });
  await h.api('POST', `/employees/${ids.Ben}/message`, { body: 'Now finish. @@fake: complete finished after the restart@@' });
  await waitFor(async () => (await h.getTask(t.id)).status === 'DONE', { label: 'done after the restart', timeout: 30000 });
});

test('twice in an hour is the limit: after that the owner is told, and the session is left alone', async () => {
  const cut = async () => {
    const before = (await h.session(ids.Ben!))!;
    await waitFor(async () => (await h.session(ids.Ben!))!.inTurn === false, { label: 'Ben between turns', timeout: 20000 });
    await h.api('POST', `/employees/${ids.Ben}/message`, { body: 'Try the office. @@fake: cutoff get_team; say still nothing@@' });
    return before;
  };
  const first = await cut();
  const second = await waitFor(async () => {
    const s = await h.session(ids.Ben!);
    return s?.status === 'running' && s.startedAt !== first.startedAt ? s : null;
  }, { label: 'started again a second time', timeout: 30000 });
  await waitFor(async () => (await h.state()).messages.filter((m) => m.toEmployeeId === ids.Ben && /had lost its connection/.test(m.body) && m.delivery.status !== 'queued').length === 2, { label: 'told a second time', timeout: 20000 });
  await cut();
  const note = await waitFor(async () => (await h.state()).notifications.find((n) => /Ben cannot reach the office from/.test(n.title)), { label: 'the owner is told', timeout: 20000 });
  assert.match(note.body ?? '', /started again twice/);
  await sleep(1500);
  assert.equal((await h.session(ids.Ben!))!.startedAt, second.startedAt, 'not started a third time');
  assert.equal((await cutOffs()).filter((e) => e.data.gaveUp).length, 1);
});
