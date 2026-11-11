/**
 * A permission prompt that ends up in the terminal is not lost to the office.
 *
 * The office holds a permission request through Claude Code's hook for a while; when that wait runs out, or the
 * office is restarted meanwhile, Claude Code shows its own prompt in the terminal and the employee sits there. The
 * office sees the prompt on the session's screen, asks about it again, and gives the answer with the prompt's own keys.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let project = '';
const ids: Record<string, string> = {};
const question = async (name: string, channel: string) => (await h.state()).questions.find((q) => q.employeeId === ids[name] && q.kind === 'permission' && q.status === 'open' && q.channel === channel);
const status = async (id: string) => (await h.state()).questions.find((q) => q.id === id)!;

before(async () => {
  // The hook gives up after two seconds; the office asks about a prompt that has stood for one.
  h = await createHarness({ approvalWaitSeconds: 2, timings: { terminalPromptMs: 1000 } });
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  for (const name of ['Dana', 'Omar', 'Lena']) ids[name] = (await h.employee(name, 'devops', { projectId: project })).id;
});
after(async () => {
  await h?.cleanup();
});

test('the wait for an answer runs out: the prompt is in the terminal, the office asks again, and "Allow" is given there', async () => {
  const task = await h.task({ projectId: project, title: 'Write the pipeline', assigneeId: ids.Dana, kind: 'ops', description: '@@fake: write ci.txt pipeline; say after-the-prompt@@' });
  const first = await waitFor(() => question('Dana', 'permission_hook'), { label: 'asked through the hook', timeout: 30000 });
  // Nobody answers. The hook gives up; the request through it is over…
  await waitFor(async () => (await status(first.id)).status === 'superseded', { label: 'the hook gave up', timeout: 15000 });
  // …and the office asks about the prompt that now stands in the terminal.
  const asked = await waitFor(() => question('Dana', 'terminal'), { label: 'asked again, through the terminal', timeout: 15000 });
  assert.match(asked.text, /Dana is waiting at a permission prompt in the terminal: .*ci\.txt/);
  const session = (await h.session(ids.Dana!))!;
  assert.equal(session.activity, 'needs_approval');
  assert.match(session.activityDetail ?? '', /permission prompt in the terminal/);
  const wt = (await h.getTask(task.id)).worktree!;
  assert.ok(!fs.existsSync(path.join(wt, 'ci.txt')), 'nothing was written while it waited');
  assert.equal((await h.state()).questions.filter((q) => q.employeeId === ids.Dana && q.status === 'open').length, 1, 'asked once');
  await h.api('POST', `/questions/${asked.id}/answer`, { decision: 'allow' });
  await waitFor(() => fs.existsSync(path.join(wt, 'ci.txt')), { label: 'the approved write happened', timeout: 15000 });
  const done = await waitFor(async () => {
    const q = await status(asked.id);
    return q.status === 'confirmed' ? q : null;
  }, { label: 'confirmed by the tool running', timeout: 15000 });
  assert.match(done.deliveryDetail ?? '', /The approved tool ran/);
  await waitFor(() => /after-the-prompt/.test(h.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', session.tmuxPane!)), { label: 'the session went on', timeout: 15000 });
  // The prompt is gone and nothing asks about it any more.
  await sleep(1500);
  assert.equal(await question('Dana', 'terminal'), undefined);
});

test('the office is restarted while a request waits: the prompt is found on the screen again, and "Deny" is given there', async () => {
  const task = await h.task({ projectId: project, title: 'Write the other pipeline', assigneeId: ids.Omar, kind: 'ops', description: '@@fake: write deploy.txt go; say after-the-denial@@' });
  const first = await waitFor(() => question('Omar', 'permission_hook'), { label: 'asked through the hook', timeout: 30000 });
  await h.restartServer();
  assert.equal((await status(first.id)).status, 'superseded');
  const asked = await waitFor(() => question('Omar', 'terminal'), { label: 'found on the screen after the restart', timeout: 30000 });
  assert.match(asked.text, /Omar is waiting at a permission prompt in the terminal: .*deploy\.txt/);
  assert.equal((await h.session(ids.Omar!))!.activity, 'needs_approval');
  await h.api('POST', `/questions/${asked.id}/answer`, { decision: 'deny' });
  const session = (await h.session(ids.Omar!))!;
  await waitFor(() => /rejected in terminal/.test(h.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', session.tmuxPane!)) && /after-the-denial/.test(h.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', session.tmuxPane!)), { label: 'the denial reached the session, which went on', timeout: 15000 });
  assert.ok(!fs.existsSync(path.join((await h.getTask(task.id)).worktree!, 'deploy.txt')), 'the denied write never happened');
  assert.match((await status(asked.id)).deliveryDetail ?? '', /Chose "No" on the prompt in the terminal|went on without it/);
  // No stray keys were left in the session's input.
  assert.doesNotMatch(h.tmux('capture-pane', '-p', '-J', '-S', '-10', '-t', session.tmuxPane!), /\[B/);
});

test('answered at the terminal by a person: the office stops asking; and it never presses keys at a prompt that is gone', async () => {
  const task = await h.task({ projectId: project, title: 'Write notes', assigneeId: ids.Lena, kind: 'ops', description: '@@fake: write notes.txt hello; say lena-done@@' });
  const asked = await waitFor(() => question('Lena', 'terminal'), { label: 'asked through the terminal', timeout: 40000 });
  const session = (await h.session(ids.Lena!))!;
  // Somebody at the workstation presses "1".
  h.tmux('send-keys', '-t', session.tmuxPane!, '1');
  await waitFor(() => fs.existsSync(path.join(session.cwd, 'notes.txt')), { label: 'the write happened', timeout: 15000 });
  await waitFor(async () => (await status(asked.id)).status === 'superseded', { label: 'the office stopped asking', timeout: 15000 });
  assert.match((await status(asked.id)).deliveryDetail ?? '', /answered in the terminal/);
  // An answer that arrives late presses nothing.
  const late = await h.apiRaw('POST', `/questions/${asked.id}/answer`, { decision: 'allow' });
  assert.equal(late.status, 409);
  await waitFor(() => /lena-done/.test(h.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', session.tmuxPane!)), { label: 'the session went on', timeout: 15000 });
});
