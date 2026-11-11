/**
 * Deleting a project, end to end: a real server, a real host agent, real tmux sessions, scripted workers.
 *
 * The project and its tasks go — work in progress is interrupted in the real terminal first. Its people stay
 * (with no project), what was learned for it alone is retired, questions about it are withdrawn, another
 * project's task that waited for one of its tasks no longer waits. Nothing on disk is touched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

/** A long job the scripted worker can be interrupted in: it looks for Escape between steps, not during one. */
const LONG = Array(200).fill('sleep 1500').join('; ');

let h: Harness;
let scratch = '';
let keep = '';
let repo = '';
const ids: Record<string, string> = {};

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('scratch');
  scratch = (await h.project('Scratch', repo)).id;
  keep = (await h.project('Keep', h.makeRepo('keep'))).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId: scratch, autonomy: 'autonomous' })).id;
  ids.Sarah = (await h.employee('Sarah', 'frontend', { projectId: scratch, autonomy: 'autonomous' })).id;
  ids.Noor = (await h.employee('Noor', 'backend', { projectId: keep, autonomy: 'autonomous' })).id;
});

after(async () => {
  await h?.cleanup();
});

test('an owner deletes a project: its tasks go, its people and its folder stay, and nothing is left pointing at it', async () => {
  // Work of every kind: finished, running, never started, with a question open — and a task elsewhere that waits for one of them.
  const done = await h.task({ projectId: scratch, title: 'Write the readme', assigneeId: ids.Alex, description: '@@fake: write notes.txt hello; commit notes; complete done@@' });
  await waitFor(async () => ((await h.getTask(done.id)).status === 'DONE' ? true : null), { label: 'the first task done', timeout: 40000 });
  const running = await h.task({ projectId: scratch, title: 'A long job', assigneeId: ids.Alex, description: `@@fake: progress started; ${LONG}@@` });
  await waitFor(async () => ((await h.getTask(running.id)).status === 'IN_PROGRESS' ? true : null), { label: 'the long task in progress', timeout: 40000 });
  const asking = await h.task({ projectId: scratch, title: 'Pick a colour', assigneeId: ids.Sarah, description: '@@fake: ask Which colour should the header be@@' });
  const question = await waitFor(async () => (await h.openQuestion(ids.Sarah!)) ?? null, { label: 'an open question', timeout: 40000 });
  const waiting = await h.task({ projectId: keep, title: 'Use what Scratch builds', dependsOn: [asking.id], released: false });
  const idle = await h.task({ projectId: scratch, title: 'Never started', released: false });
  const lesson = await h.api<any>('POST', '/lessons', { scope: 'project', projectId: scratch, text: 'Run the linter before committing.' });
  const company = await h.api<any>('POST', '/lessons', { scope: 'company', text: 'Write down decisions.' });
  await h.api('PATCH', `/projects/${keep}`, { dependsOn: [scratch] });
  const session = (await h.session(ids.Alex!))!;
  assert.equal(session.status, 'running');

  const res = await h.api<any>('DELETE', `/projects/${scratch}`);
  assert.equal(res.name, 'Scratch');
  assert.equal(res.interrupted, 2, 'both tasks that were in progress were stopped');
  assert.deepEqual([...res.employees].sort(), ['Alex', 'Sarah']);
  assert.ok(res.tasks >= 4);

  const s = await h.state();
  assert.equal(s.projects.some((p) => p.id === scratch), false, 'the project is gone');
  assert.equal(s.tasks.some((t) => t.projectId === scratch), false, 'and every task of it');
  for (const id of [done.id, running.id, asking.id, idle.id]) assert.equal((await h.apiRaw('GET', `/tasks/${id}`)).status, 404);
  // Its people stay in the office, without a project; the one who was working is at the prompt again, in the same session.
  for (const who of ['Alex', 'Sarah']) {
    const e = s.employees.find((x) => x.id === ids[who])!;
    assert.deepEqual([e.archived, e.projectId], [false, null], `${who} stays, with no project`);
  }
  const after = (await h.session(ids.Alex!))!;
  assert.deepEqual([after.id, after.status], [session.id, 'running'], 'the session was interrupted, not ended');
  await waitFor(async () => ((await h.session(ids.Alex!))!.activity === 'idle' ? true : null), { label: 'Alex idle after the interrupt' });
  // Nothing is left pointing at it.
  assert.deepEqual((await h.getTask(waiting.id)).dependsOn, [], 'the task of the other project no longer waits for a deleted one');
  assert.deepEqual(s.projects.find((p) => p.id === keep)!.dependsOn ?? [], []);
  assert.equal(s.questions.find((q) => q.id === question.id)!.status, 'superseded');
  assert.equal(s.questions.some((q) => q.status === 'open'), false);
  assert.equal(s.lessons.find((l) => l.id === lesson.id)!.status, 'retired', 'what was learned for this project alone is retired');
  assert.equal(s.lessons.find((l) => l.id === company.id)!.status, 'active', 'what the whole company learned is not');
  assert.equal(s.employees.find((x) => x.id === ids.Noor)!.projectId, keep);
  // Nothing on disk was touched: the folder, the work that was committed, the git history.
  assert.ok(fs.existsSync(path.join(repo, '.git')), 'the repository is still there');
  assert.ok(h.git(repo, 'branch', '--all').length > 0);
  // On the record.
  const audit = await h.api<any[]>('GET', '/audit?limit=50');
  const entry = audit.find((a) => a.action === 'project.deleted')!;
  assert.deepEqual([entry.detail.name, entry.detail.interrupted], ['Scratch', 2]);
  assert.ok((await h.api<any[]>('GET', '/events?limit=200')).some((e) => e.type === 'project.deleted' && /Project "Scratch" was deleted with its \d+ tasks/.test(e.summary)));
});

test('what was deleted stays deleted; the people go on working, and the folder can be a project again', async () => {
  assert.equal((await h.apiRaw('DELETE', `/projects/${scratch}`)).status, 404);
  // A restart of the office reads the same thing back from its store.
  await h.restartServer();
  const s = await h.state();
  assert.equal(s.projects.some((p) => p.name === 'Scratch'), false);
  assert.equal(s.tasks.some((t) => t.projectId === scratch), false);
  // Someone who lost their project can be talked to, and can be put on another one.
  await waitFor(async () => {
    const x = await h.session(ids.Sarah!);
    return x?.status === 'running' && x.inTurn === false ? true : null;
  }, { label: 'Sarah at the prompt', timeout: 40000 });
  await h.api('POST', `/employees/${ids.Sarah}/message`, { body: 'Still there? @@fake: say still-here-8841@@' });
  await waitFor(async () => ((await h.api<any[]>('GET', `/events?limit=300&employeeId=${ids.Sarah}`)).some((e) => e.type === 'agent.turn_finished' && /still-here-8841/.test(e.data.lastMessage ?? '')) ? true : null), { label: 'Sarah answered', timeout: 40000 });
  await h.api('PATCH', `/employees/${ids.Sarah}`, { projectId: keep });
  // The same folder, a new project of the same name.
  const again = await h.project('Scratch', repo);
  assert.notEqual(again.id, scratch);
  await h.api('PATCH', `/employees/${ids.Alex}`, { projectId: again.id });
  const t = await h.task({ projectId: again.id, title: 'Start over', assigneeId: ids.Alex, description: '@@fake: write again.txt hi; commit again; complete done again@@' });
  await waitFor(async () => ((await h.getTask(t.id)).status === 'DONE' ? true : null), { label: 'work in the new project done', timeout: 60000 });
});
