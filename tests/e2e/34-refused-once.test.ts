/**
 * An action Claude Code refuses by itself (auto mode's own safety check) becomes a request to the owner, who may
 * allow exactly that call once. Until now it was only an alert: the employee could not get past it, and the owner's
 * "yes" given through the office changed nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let id = '';
const refusals = async () => (await h.state()).questions.filter((q) => q.employeeId === id && q.channel === 'auto_denied');
const q = async (qid: string) => (await h.state()).questions.find((x) => x.id === qid)!;
const idle = () => waitFor(async () => (await h.session(id))?.inTurn === false, { label: 'between turns', timeout: 20000 });
const say = async (script: string) => {
  await idle();
  await h.api('POST', `/employees/${id}/message`, { body: `Go on. @@fake: ${script}@@` });
};
/** Wait until the worker has printed this (the last step of a script: the script has run). */
const said = async (text: string) => {
  const pane = (await h.session(id))!.tmuxPane!;
  await waitFor(() => h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', pane).includes(text), { label: `the worker said "${text}"`, timeout: 20000 });
};

before(async () => {
  h = await createHarness();
  const project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  // "Standard": a shell command asks for permission — so a command that runs *without* asking was let through by the grant.
  id = (await h.employee('Dana', 'devops', { projectId: project, autonomy: 'standard' })).id;
  await h.api('POST', `/employees/${id}/start`, {});
  await idle();
});
after(async () => {
  await h?.cleanup();
});

test('a refusal by Claude Code is put to the owner; allowed once, exactly that call runs — once', async () => {
  const cwd = (await h.session(id))!.cwd;
  const command = 'echo deployed > deploy.txt';
  await say(`denied ${command}; say it was refused`);
  const asked = await waitFor(async () => (await refusals()).find((x) => x.status === 'open'), { label: 'the owner is asked', timeout: 20000 });
  assert.equal(asked.kind, 'permission');
  assert.match(asked.text, /Claude Code refused Dana's action: .*echo deployed/);
  assert.match(asked.context ?? '', /Reason given: blocked by a deny rule/);
  assert.deepEqual([asked.tool!.name, (asked.tool!.input as any).command], ['Bash', command]);
  // The same refusal again does not ask twice.
  await say(`denied ${command}; say refused-a-second-time`);
  await said('refused-a-second-time');
  assert.equal((await refusals()).length, 1);

  await h.api('POST', `/questions/${asked.id}/answer`, { decision: 'allow' });
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === id && /^I, the owner of this office, allow this once/.test(m.body) && m.delivery.status !== 'queued'), { label: 'Dana is told', timeout: 20000 });
  assert.ok(told.body.includes(command));
  assert.equal(told.from.kind, 'owner');
  assert.match((await q(asked.id)).deliveryDetail ?? '', /Allowed once: the machine lets exactly that call through/);

  // Exactly that call now runs without anybody being asked…
  await say(`bash ${command}; say ran it`);
  await waitFor(() => fs.existsSync(path.join(cwd, 'deploy.txt')), { label: 'the allowed call ran', timeout: 20000 });
  await waitFor(async () => (await q(asked.id)).status === 'confirmed', { label: 'confirmed by the call itself', timeout: 15000 });
  assert.equal(await h.openQuestion(id, 'permission'), undefined, 'nobody was asked for it');
  // …and only once: the same command again goes through the ordinary request for approval.
  fs.rmSync(path.join(cwd, 'deploy.txt'));
  await say(`bash ${command}; say second time`);
  const ordinary = await waitFor(() => h.openQuestion(id, 'permission'), { label: 'asked the ordinary way the second time', timeout: 20000 });
  assert.equal(ordinary.channel, 'permission_hook');
  assert.ok(!fs.existsSync(path.join(cwd, 'deploy.txt')));
  await h.api('POST', `/questions/${ordinary.id}/answer`, { decision: 'deny' });
  // A different command was never covered by it.
  const audit = await h.api<any[]>('GET', '/audit');
  assert.equal(audit.filter((a) => a.action === 'approval.granted_once').length, 1);
});

test('left refused: the employee is told to find another way; and a refusal after the owner\'s "allow" is reported, not retried', async () => {
  await say('denied curl -s http://169.254.169.254/latest/meta-data/; say refused');
  const asked = await waitFor(async () => (await refusals()).find((x) => x.status === 'open'), { label: 'the owner is asked', timeout: 20000 });
  await h.api('POST', `/questions/${asked.id}/answer`, { decision: 'deny', answer: 'Not from this machine.' });
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === id && /stays refused/.test(m.body)), { label: 'Dana is told no', timeout: 20000 });
  assert.match(told.body, /Not from this machine\. Do it another way, or report_blocker/);
  assert.equal((await q(asked.id)).status, 'confirmed');

  // Allowed — and Claude Code refuses it all the same: the owner hears that it cannot be overruled from here.
  await say('denied scp backup.tgz root@example.test:/srv/; say refused');
  const second = await waitFor(async () => (await refusals()).find((x) => x.status === 'open'), { label: 'asked about the second one', timeout: 20000 });
  await h.api('POST', `/questions/${second.id}/answer`, { decision: 'allow' });
  await waitFor(async () => (await q(second.id)).status === 'delivered', { label: 'allowed', timeout: 15000 });
  await say('denied scp backup.tgz root@example.test:/srv/; say refused although allowed');
  await waitFor(async () => (await q(second.id)).status === 'failed', { label: 'reported as not overruled', timeout: 20000 });
  assert.match((await q(second.id)).deliveryDetail ?? '', /refused it again although you allowed it/);
  assert.ok((await h.state()).notifications.some((n) => /Dana was refused again/.test(n.title)));
  await sleep(300);
  assert.equal((await refusals()).filter((x) => x.status === 'open').length, 0, 'not asked a third time for the same call');
});
