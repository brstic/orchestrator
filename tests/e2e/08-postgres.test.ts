/**
 * The whole office on PostgreSQL: a real task flow, then a server restart that
 * must rebuild everything from the database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';
import { startPostgres, type TestPostgres } from './pg-helper.ts';

let pg: TestPostgres | null = null;
let h: Harness | null = null;

before(async () => {
  pg = await startPostgres();
  if (pg) h = await createHarness({ database: pg.url });
});
after(async () => {
  await h?.cleanup();
  pg?.stop();
});

test('an office backed by PostgreSQL runs real work and survives a restart', async (t) => {
  if (!pg || !h) return t.skip('PostgreSQL binaries (initdb, pg_ctl) are not installed');
  const repo = h.makeRepo('pg-project');
  const project = await h.project('On Postgres', repo, { verifyCommand: 'npm test --silent' });
  const alex = await h.employee('Alex', 'backend', { projectId: project.id, autonomy: 'standard' });
  const task = await h.task({ projectId: project.id, title: 'Stored in Postgres', assigneeId: alex.id, description: '@@fake: write pg.txt hello; commit pg change; ask Keep going?; complete pg done@@' });
  const q = await waitFor(() => h!.openQuestion(alex.id), { label: 'question' });
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Yes' });
  await waitFor(async () => ((await h!.getTask(task.id)).status === 'DONE' ? true : null), { label: 'done', timeout: 45000 });
  const before = await h.state();
  const eventsBefore = before.events.filter((e) => e.taskId === task.id).map((e) => e.type);

  // The data really is in PostgreSQL, and no token is stored in the clear.
  await waitFor(() => Number(pg!.psql("SELECT count(*) FROM orch_docs WHERE kind = 'task'")) === before.tasks.length, { label: 'tasks written through' });
  assert.equal(pg.psql(`SELECT data->>'status' FROM orch_docs WHERE kind = 'task' AND id = '${task.id}'`), 'DONE');
  assert.ok(Number(pg.psql('SELECT count(*) FROM orch_events')) > 10);
  assert.equal(pg.psql(`SELECT count(*) FROM orch_credentials WHERE hash = '${h.token}'`), '0');
  assert.equal(pg.psql("SELECT count(*) FROM orch_credentials WHERE kind = 'owner'"), '1');

  const sessionBefore = (await h.session(alex.id))!;
  const restartedAt = new Date().toISOString();
  await h.restartServer();

  const after = await h.state();
  assert.equal(after.tasks.find((x) => x.id === task.id)!.status, 'DONE');
  assert.equal(after.tasks.find((x) => x.id === task.id)!.evidence.verification!.passed, true);
  assert.equal(after.employees.find((e) => e.id === alex.id)!.stats.tasksCompleted, 1);
  assert.equal(after.questions.find((x) => x.id === q.id)!.status, 'confirmed');
  assert.equal(after.company.tasksCompleted, 1);
  assert.ok(after.lessons.some((l) => l.source === 'owner_answer'), 'project knowledge persisted');
  const eventsAfter = (await h.api('GET', `/events?taskId=${task.id}&limit=500`)).map((e: any) => e.type);
  for (const type of eventsBefore) assert.ok(eventsAfter.includes(type), `event ${type} persisted`);
  // The owner token and the host credential still work: both were stored (hashed) in PostgreSQL.
  const session = await waitFor(async () => {
    const s = await h!.session(alex.id);
    return s?.status === 'running' ? s : null;
  }, { label: 'host reconnected with its stored credential', timeout: 45000 });
  assert.equal(session.pid, sessionBefore.pid);
  // And work continues.
  await waitFor(async () => (await h!.session(alex.id))!.inTurn === false, { label: 'idle' }).catch(async (e) => {
    const x = (await h!.session(alex.id))!;
    const evs = (await h!.api('GET', `/events?employeeId=${alex.id}&limit=500&includeActivity=1`)) as any[];
    console.log('DIAG session', JSON.stringify({ status: x.status, activity: x.activity, inTurn: x.inTurn, turnStartedAt: (x as any).turnStartedAt, lastHookAt: (x as any).lastHookAt, updatedAt: (x as any).updatedAt }));
    console.log('DIAG restart at', restartedAt);
    console.log('DIAG events', evs.slice(-25).map((v) => `${v.ts.slice(11, 23)} ${v.type} ${v.source?.kind}`).join('\n'));
    throw e;
  });
  const next = await h.task({ projectId: project.id, title: 'After the restart', assigneeId: alex.id, description: '@@fake: write pg2.txt again; commit pg again; complete pg again@@' });
  assert.equal(next.key, 'T-2', 'counters continue from the database');
  await waitFor(async () => ((await h!.getTask(next.id)).status === 'DONE' ? true : null), { label: 'second task done', timeout: 45000 });
});
