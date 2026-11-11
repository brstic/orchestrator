/**
 * The model and the effort an employee runs on, end to end: chosen when hiring or in the profile, they are what
 * the real launch of the worker on the real host agent carries (`claude --model … --effort …`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let alex = '';

const pane = async () => {
  const s = await h.session(alex);
  return s?.tmuxPane && s.status === 'running' ? h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', s.tmuxPane) : '';
};
const atPrompt = (label: string) =>
  waitFor(async () => {
    const s = await h.session(alex);
    return s?.status === 'running' && s.inTurn === false ? s : null;
  }, { label, timeout: 40000 });
const restart = async () => {
  await h.api('POST', `/employees/${alex}/stop`, {});
  await waitFor(async () => ((await h.session(alex))?.status !== 'running' ? true : null), { label: 'stopped' });
  await h.api('POST', `/employees/${alex}/start`, {});
  return atPrompt('started again');
};

before(async () => {
  h = await createHarness();
});
after(async () => {
  await h?.cleanup();
});

test('the machine says which effort levels its Claude Code has', async () => {
  const host = (await h.state()).hosts.find((x) => x.id === h.hostId)!;
  assert.deepEqual(host.info!.claudeEffortLevels, ['low', 'medium', 'high', 'xhigh', 'max'], 'read from the help of the Claude Code on that machine');
});

test('someone hired with a model and an effort is started with exactly those', async () => {
  const project = await h.project('Shop', h.makeRepo('shop'));
  const made = await h.employee('Alex', 'backend', { projectId: project.id, model: 'opus', effort: 'high' });
  alex = made.id;
  assert.deepEqual([made.model, made.effort], ['opus', 'high']);
  await h.api('POST', `/employees/${alex}/start`, {});
  const session = await atPrompt('Alex started');
  assert.deepEqual([session.model, session.effort], ['opus', 'high']);
  assert.match(await pane(), /model: opus · effort: high/, 'what the worker itself was started with');
});

test('changed in the profile, they take effect the next time the session starts; "default" leaves both to Claude Code', async () => {
  const patched = await h.api<any>('PATCH', `/employees/${alex}`, { model: null, effort: 'max' });
  assert.deepEqual([patched.model, patched.effort], [null, 'max']);
  assert.match(await pane(), /model: opus · effort: high/, 'the running session is not touched');
  const session = await restart();
  assert.deepEqual([session.model, session.effort], [null, 'max']);
  assert.match(await pane(), /model: default · effort: max/);

  await h.api('PATCH', `/employees/${alex}`, { effort: null });
  await restart();
  assert.doesNotMatch(await pane(), /effort:/, 'neither option is passed');
});

test('a model or an effort that is not one is refused in words', async () => {
  const effort = await h.apiRaw('PATCH', `/employees/${alex}`, { effort: 'extreme' });
  assert.equal(effort.status, 400);
  assert.match(effort.body.error, /effort is one of: low, medium, high, xhigh, max/);
  // Nothing that could be read as another option of the CLI.
  for (const model of ['--dangerously-skip-permissions', 'opus --permission-mode bypassPermissions', 'a;b']) {
    const r = await h.apiRaw('PATCH', `/employees/${alex}`, { model });
    assert.equal(r.status, 400, model);
    assert.match(r.body.error, /a model is an alias such as "opus" or a model's full name/);
  }
  assert.equal((await h.apiRaw('PATCH', `/employees/${alex}`, { model: 'claude-sonnet-5-5' })).status, 200);
});
