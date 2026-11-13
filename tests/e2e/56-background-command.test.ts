/**
 * A command that goes on in the background (the owner, 2026-11-13: "it has to be known when a session has shell
 * commands it is waiting for in the background — shown, that it waits for something to finish"). The real chain: the
 * fake CLI starts the command's shell the way Claude Code does, the machine's agent finds it in the process table,
 * the office tells it from the call in front of the session by the hooks, and shows it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession } from '@orchestrator/contracts';
import { ACTIVITY_LABEL } from '@orchestrator/contracts';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let projectId = '';
const ids: Record<string, string> = {};

before(async () => {
  h = await createHarness();
  projectId = (await h.project('Shop', h.makeRepo('shop'))).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId, autonomy: 'auto' })).id;
  ids.Dana = (await h.employee('Dana', 'devops', { projectId, autonomy: 'auto' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('a command sent to the background is on the session while the turn goes on, and what the employee waits for once it is over', async () => {
  const client = await h.client();
  await h.api('POST', `/employees/${ids.Alex}/start`, {});
  await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.status === 'running' && s.inTurn === false ? s : null; }, { label: 'Alex is up', timeout: 30000 });
  // The suite runs in the background for six seconds; meanwhile a command runs in front of the session for one.
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Run the suite. @@fake: bg sleep 6 => Run the full test suite; bash sleep 1; say The suite is running; I will look when it ends.@@' });
  const waiting = await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.activity === 'waiting_command' ? s : null; }, { label: 'waiting for the command', timeout: 20000 });
  assert.equal(ACTIVITY_LABEL[waiting.activity], '⏳ COMMAND RUNNING');
  assert.equal(waiting.activityDetail, 'Run the full test suite');
  assert.equal(waiting.inTurn, false);
  assert.deepEqual(waiting.background!.map((b) => b.what), ['Run the full test suite']);
  // The command in front of the session was never shown as one in the background.
  const seen = client.messages.flatMap((m: any) => (m.t === 'entity' && m.kind === 'session' && m.data.id === waiting.id ? (m.data.background ?? []).map((b: any) => b.what) : []));
  assert.ok(seen.includes('Run the full test suite'), 'shown while the turn went on');
  assert.ok(!seen.includes('scripted by test'), `the call in front was taken for one in the background: ${JSON.stringify(seen)}`);
  // It ends: Alex is available again, and nothing runs.
  const done = await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.activity === 'idle' ? s : null; }, { label: 'the command ended', timeout: 20000 });
  assert.equal(done.background ?? null, null);
  const ws = client.ws;
  ws.close();
});

test('with a task in hand: not nudged on while the command runs, and back to waiting with the task once it has ended', async () => {
  await h.api('POST', `/employees/${ids.Dana}/start`, {});
  await waitFor(async () => { const s = await h.session(ids.Dana!); return s?.status === 'running' && s.inTurn === false ? s : null; }, { label: 'Dana is up', timeout: 30000 });
  const task = await h.task({ projectId, title: 'Build the release bundle', assigneeId: ids.Dana, kind: 'ops', verifyCommand: 'true', description: '@@fake: bg sleep 8 => Build the release bundle; say The build is running in the background.@@' });
  const waiting = await waitFor(async () => { const s = await h.session(ids.Dana!); return s?.activity === 'waiting_command' ? s : null; }, { label: 'Dana waits for the build', timeout: 30000 });
  assert.equal(waiting.activityDetail, 'Build the release bundle');
  // Auto would be nudged on up to three times for stopping with a task unfinished: not while its command runs.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await h.getTask(task.id)).nudges, 0);
  const after = await waitFor(async () => { const s = await h.session(ids.Dana!); return s && s.activity !== 'waiting_command' ? s : null; }, { label: 'the build ended', timeout: 20000 });
  assert.deepEqual([after.activity, after.background ?? null], ['waiting_input', null]);
  assert.equal(after.activityDetail, 'The build is running in the background.', 'what they said when the turn ended');
});

test('the session is stopped while its command runs: nothing is left on its record', async () => {
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: '@@fake: bg sleep 30 => Watch the logs@@' });
  await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.background?.length ? s : null; }, { label: 'the watcher runs', timeout: 20000 });
  await h.api('POST', `/employees/${ids.Alex}/stop`, {});
  const s: AgentSession = await waitFor(async () => { const x = await h.session(ids.Alex!); return x && x.status !== 'running' ? x : null; }, { label: 'stopped', timeout: 20000 });
  assert.equal(s.background ?? null, null);
});
