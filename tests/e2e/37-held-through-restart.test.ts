/**
 * A request that waits for somebody's decision — a permission, a question Claude Code asks — goes on waiting when
 * the office is restarted (every deploy) or the connection to the machine is lost for a moment.
 *
 * The machine's agent keeps holding Claude Code's hook and, when the office is back, sends the request again under
 * the same name; the office takes the same question up again. Nothing falls to Claude Code's own prompt in the
 * terminal — where a question would stand unseen. Only when the office stays away (longer than the agent waits for
 * it), or the agent itself lost the hook, is the request given up, and then the office says where the employee waits.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let project = '';
const ids: Record<string, string> = {};
const open = async (name: string, channel?: string) => (await h.state()).questions.filter((q) => q.employeeId === ids[name] && q.status === 'open' && (!channel || q.channel === channel));
const one = async (name: string, channel: string) => (await open(name, channel))[0];
const status = async (id: string) => (await h.state()).questions.find((q) => q.id === id)!;
// The pane's name is remembered: the terminal is looked at while the office is down, too.
const panes: Record<string, string> = {};
const pane = async (name: string) => h.tmux('capture-pane', '-p', '-J', '-S', '-120', '-t', (panes[name] ??= (await h.session(ids[name]!))!.tmuxPane!));
/** Between turns — or not started yet (a message starts them). */
const idle = (name: string) => waitFor(async () => ['idle', 'waiting_input', 'none'].includes((await h.session(ids[name]!))?.activity ?? 'none'), { label: `${name} idle`, timeout: 30000 });

before(async () => {
  // The hook waits half a minute for an answer; after the machine is back the office waits a second and a half for what it still holds.
  h = await createHarness({ approvalWaitSeconds: 30, timings: { terminalPromptMs: 1000, hookRejoinGraceMs: 1500, hookRejoinMs: 8000 } });
  // A hook waits two seconds for an agent that is not there (45 in a real office).
  h.agentCfg.hookRetrySeconds = 2;
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  for (const name of ['Dana', 'Omar', 'Lena', 'Ivo', 'Mara', 'Nela']) ids[name] = (await h.employee(name, 'devops', { projectId: project })).id;
});
after(async () => {
  await h?.cleanup();
});

test('a permission request waits through a restart of the office: the same request, answered from the office, no prompt in the terminal', async () => {
  const task = await h.task({ projectId: project, title: 'Write the pipeline', assigneeId: ids.Dana, kind: 'ops', description: '@@fake: write ci.txt pipeline; say after-the-restart@@' });
  const first = await waitFor(() => one('Dana', 'permission_hook'), { label: 'asked through the hook', timeout: 30000 });
  await h.restartServer();
  // What the machine still holds comes right behind its report; give the office longer than it waits for that.
  await sleep(2500);
  const now = await open('Dana');
  assert.deepEqual(now.map((q) => [q.id, q.channel, q.status]), [[first.id, 'permission_hook', 'open']], 'the same request, still open, asked once');
  assert.doesNotMatch(await pane('Dana'), /Do you want to proceed\?/, 'Claude Code was not left to ask in the terminal');
  assert.equal((await h.session(ids.Dana!))!.activity, 'needs_approval');
  const wt = (await h.getTask(task.id)).worktree!;
  assert.ok(!fs.existsSync(path.join(wt, 'ci.txt')), 'nothing was written while it waited');
  await h.api('POST', `/questions/${first.id}/answer`, { decision: 'allow' });
  await waitFor(() => fs.existsSync(path.join(wt, 'ci.txt')), { label: 'the approved write happened', timeout: 15000 });
  const done = await waitFor(async () => ((await status(first.id)).status === 'confirmed' ? status(first.id) : null), { label: 'confirmed by the tool running', timeout: 15000 });
  assert.match(done.deliveryDetail ?? '', /The approved tool ran/);
  await waitFor(async () => /after-the-restart/.test(await pane('Dana')), { label: 'the session went on', timeout: 15000 });
  assert.equal((await h.state()).notifications.filter((n) => n.employeeId === ids.Dana && /waiting at a/.test(n.title)).length, 0);
});

test('a question Claude Code asks waits through a restart too, and through two; a denial reaches the hook as well', async () => {
  await h.task({ projectId: project, title: 'Choose the database', assigneeId: ids.Omar, kind: 'ops', description: '@@fake: askuser Which database?|Postgres|SQLite; say omar-went-on; complete-nocode chose@@' });
  const q = await waitFor(() => one('Omar', 'ask_user_question_hook'), { label: 'the question came through the hook', timeout: 30000 });
  await h.restartServer();
  await sleep(2000);
  await h.restartServer();
  await sleep(2500);
  assert.deepEqual((await open('Omar')).map((x) => x.id), [q.id]);
  assert.doesNotMatch(await pane('Omar'), /none supplied by hook/);
  await h.api('POST', `/questions/${q.id}/answer`, { answers: { 'Which database?': 'SQLite' } });
  await waitFor(async () => /answer: SQLite/.test(await pane('Omar')), { label: 'the answer reached the tool', timeout: 15000 });
  await waitFor(async () => (await status(q.id)).status === 'confirmed', { label: 'confirmed', timeout: 15000 });
  await waitFor(async () => /omar-went-on/.test(await pane('Omar')), { label: 'Omar went on', timeout: 15000 });

  await idle('Omar');
  const task = await h.task({ projectId: project, title: 'Write the other pipeline', assigneeId: ids.Omar, kind: 'ops', description: '@@fake: write deploy.txt go; say after-the-denial@@' });
  const p = await waitFor(() => one('Omar', 'permission_hook'), { label: 'asked through the hook', timeout: 30000 });
  await h.restartServer();
  await sleep(2500);
  await h.api('POST', `/questions/${p.id}/answer`, { decision: 'deny', answer: 'Not this one.' });
  await waitFor(async () => /denied: Not this one\./.test(await pane('Omar')) && /after-the-denial/.test(await pane('Omar')), { label: 'the denial reached the session through the hook', timeout: 15000 });
  assert.ok(!fs.existsSync(path.join((await h.getTask(task.id)).worktree!, 'deploy.txt')));
});

test('the connection to the machine drops for a moment: the request stays, and an answer given meanwhile is delivered when it is back', async () => {
  const task = await h.task({ projectId: project, title: 'Write notes', assigneeId: ids.Lena, kind: 'ops', description: '@@fake: write notes.txt hello; say lena-done@@' });
  const q = await waitFor(() => one('Lena', 'permission_hook'), { label: 'asked through the hook', timeout: 30000 });
  // The agent's side of the link is cut; it connects again by itself in half a second.
  (h.agent as unknown as { ws: { close(): void } }).ws.close();
  await waitFor(() => !h.agent.isConnected, { label: 'the link is down', timeout: 5000, interval: 5 });
  await waitFor(async () => (await h.state()).hosts.find((x) => x.id === h.hostId)?.status !== 'online', { label: 'the office saw it go', timeout: 5000, interval: 10 }).catch(() => undefined);
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  const wt = (await h.getTask(task.id)).worktree!;
  await waitFor(() => fs.existsSync(path.join(wt, 'notes.txt')), { label: 'the approved write happened after the link came back', timeout: 20000 });
  await waitFor(async () => (await status(q.id)).status === 'confirmed', { label: 'confirmed', timeout: 15000 });
  assert.doesNotMatch(await pane('Lena'), /Do you want to proceed\?/);
  assert.equal((await open('Lena')).length, 0);
});

test('a request made while the office is away for a moment waits for it instead of dropping to the terminal', async () => {
  const task = await h.task({ projectId: project, title: 'Write the readme', assigneeId: ids.Ivo, kind: 'ops', description: '@@fake: say ivo-started; sleep 2500; write readme.txt hi; say ivo-done@@' });
  await waitFor(async () => /ivo-started/.test(await pane('Ivo')), { label: 'Ivo is at work', timeout: 30000 });
  // The office goes down while Ivo is busy; his request for permission comes while it is away.
  await h.server.close();
  await sleep(4000);
  assert.doesNotMatch(await pane('Ivo'), /Do you want to proceed\?/, 'the request waits for the office');
  await h.restartServer();
  const q = await waitFor(() => one('Ivo', 'permission_hook'), { label: 'the request reached the office when it was back', timeout: 20000 });
  assert.match(q.text, /readme\.txt/);
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  const wt = (await h.getTask(task.id)).worktree!;
  await waitFor(() => fs.existsSync(path.join(wt, 'readme.txt')), { label: 'written', timeout: 15000 });
  await waitFor(async () => /ivo-done/.test(await pane('Ivo')), { label: 'Ivo went on', timeout: 15000 });
});

test('the agent itself stays away while a question waits: the hook is gone, the question is given up, and the owner is told where the employee waits', async () => {
  await h.task({ projectId: project, title: 'Choose the queue', assigneeId: ids.Mara, kind: 'ops', description: '@@fake: askuser Which queue?|Redis|SQS; say mara-went-on@@' });
  const q = await waitFor(() => one('Mara', 'ask_user_question_hook'), { label: 'the question came through the hook', timeout: 30000 });
  // (A restart alone the hook outlives — 38-hook-outlives-agent. Here the agent is away longer than the hook waits.)
  await pane('Mara');
  await h.stopAgent();
  await waitFor(async () => /none supplied by hook/.test(await pane('Mara')), { label: 'the hook gave up on the agent', timeout: 20000 });
  await h.startAgent();
  const over = await waitFor(async () => ((await status(q.id)).status === 'superseded' ? status(q.id) : null), { label: 'the held question is given up', timeout: 20000 });
  assert.match(over.deliveryDetail ?? '', /falls back to its own prompt in the terminal|stopped waiting|closed before/);
  assert.equal((await open('Mara')).length, 0);
  // A question in the terminal cannot be answered from the office (only a permission prompt can): the owner is told.
  const told = await waitFor(async () => (await h.state()).notifications.find((n) => n.employeeId === ids.Mara && /Mara is waiting at a question in the terminal/.test(n.title)), { label: 'the owner is told', timeout: 10000 });
  assert.match(told.body, /Which queue\?[\s\S]*Open the workstation to answer it/);
  assert.equal(told.kind, 'question');
});

test('the office stays away longer than the agent waits for it: Claude Code asks in the terminal, and the office finds the prompt there when it is back', async () => {
  // This machine's agent waits two seconds for the office.
  h.agentCfg.linkGraceSeconds = 2;
  await h.restartAgent();
  const task = await h.task({ projectId: project, title: 'Write the changelog', assigneeId: ids.Nela, kind: 'ops', description: '@@fake: write changes.txt one; say nela-done@@' });
  const first = await waitFor(() => one('Nela', 'permission_hook'), { label: 'asked through the hook', timeout: 30000 });
  await pane('Nela');
  await h.server.close();
  await waitFor(async () => /Do you want to proceed\?/.test(await pane('Nela')), { label: 'the agent let the hook go; the prompt is in the terminal', timeout: 15000 });
  await h.restartServer();
  await waitFor(async () => (await status(first.id)).status === 'superseded', { label: 'the request through the hook is over', timeout: 20000 });
  const asked = await waitFor(() => one('Nela', 'terminal'), { label: 'found on the screen', timeout: 20000 });
  assert.match(asked.text, /Nela is waiting at a permission prompt in the terminal: .*changes\.txt/);
  await h.api('POST', `/questions/${asked.id}/answer`, { decision: 'allow' });
  const wt = (await h.getTask(task.id)).worktree!;
  await waitFor(() => fs.existsSync(path.join(wt, 'changes.txt')), { label: 'the approved write happened', timeout: 15000 });
});

test('answered while its machine is away, then the office restarts and the machine no longer holds it: the request is not left "answered" for ever', async () => {
  ids.Tara = (await h.employee('Tara', 'devops', { projectId: project })).id;
  const task = await h.task({ projectId: project, title: 'Write the manifest', assigneeId: ids.Tara, kind: 'ops', description: '@@fake: write manifest.txt one; say tara-done@@' });
  const first = await waitFor(() => one('Tara', 'permission_hook'), { label: 'asked through the hook', timeout: 30000 });
  await pane('Tara');
  // The machine's agent goes away for longer than the hook waits for it: Claude Code asks in the terminal.
  await h.stopAgent();
  await waitFor(async () => /Do you want to proceed\?/.test(await pane('Tara')), { label: 'the prompt is in the terminal', timeout: 20000 });
  // The owner, who cannot know, answers the request in the office; then the office is restarted, then the machine is back.
  await h.api('POST', `/questions/${first.id}/answer`, { decision: 'allow' });
  assert.equal((await status(first.id)).status, 'answered');
  const restarting = h.restartServer();
  await sleep(1500);
  await h.startAgent();
  await restarting;
  const over = await waitFor(async () => (['failed', 'delivered', 'superseded'].includes((await status(first.id)).status) ? status(first.id) : null), { label: 'the request is closed', timeout: 30000 });
  assert.equal(over.status, 'failed');
  assert.match(over.deliveryDetail ?? '', /no longer waiting when its machine came back/);
  assert.ok(!fs.existsSync(path.join((await h.getTask(task.id)).worktree!, 'manifest.txt')), 'the answer that could not be delivered approved nothing');
  // What stands in the terminal is found there and asked about again.
  const asked = await waitFor(() => one('Tara', 'terminal'), { label: 'found on the screen', timeout: 20000 });
  await h.api('POST', `/questions/${asked.id}/answer`, { decision: 'allow' });
  await waitFor(async () => /tara-done/.test(await pane('Tara')), { label: 'Tara went on', timeout: 20000 });
});

test('after a restart of the office, somebody who was between turns is still shown as that — not as "unknown"', async () => {
  ids.Rade = (await h.employee('Rade', 'devops', { projectId: project })).id;
  await h.api('POST', `/employees/${ids.Rade}/start`, {});
  const before = await waitFor(async () => {
    const s = await h.session(ids.Rade!);
    return s?.inTurn === false && ['idle', 'waiting_input'].includes(s.activity) ? s : null;
  }, { label: 'Rade is between turns', timeout: 30000 });
  await h.restartServer();
  const after = await waitFor(async () => {
    const s = await h.session(ids.Rade!);
    return s?.status === 'running' ? s : null;
  }, { label: 'his machine reported him again', timeout: 20000 });
  assert.deepEqual([after.activity, after.activityDetail ?? null], [before.activity, before.activityDetail ?? null], 'what was known a moment ago is still known');
  assert.equal(after.activityBefore ?? null, null);
  // The same after the link to his machine dropped for a moment.
  (h.agent as unknown as { ws: { close(): void } }).ws.close();
  await waitFor(() => !h.agent.isConnected, { label: 'the link is down', timeout: 5000, interval: 5 });
  await waitFor(() => h.agent.isConnected, { label: 'and back', timeout: 15000 });
  const again = await waitFor(async () => {
    const s = await h.session(ids.Rade!);
    return s?.status === 'running' ? s : null;
  }, { label: 'reported again', timeout: 20000 });
  assert.equal(again.activity, before.activity);
});
