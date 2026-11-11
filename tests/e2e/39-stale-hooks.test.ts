/**
 * A hook of a Claude Code process that is gone must not be taken for a sign of life of the one that replaced it.
 *
 * A session is started again in the same place under the same name (a change of level or account, a stop and a
 * start). The process that was stopped still reports its end — and that report can arrive after the new process
 * has been started. Taken for the new one's, it said "between turns": the office then typed what was waiting into
 * the new process, which was still standing at Claude Code's "do you trust this folder?" — and the text answered
 * that dialog. Seen in the live office on 2026-11-11: a session moved to another Claude account exited at the prompt.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let project = '';
let stan = '';
const pane = async () => h.tmux('capture-pane', '-p', '-J', '-S', '-120', '-t', (await h.session(stan))!.tmuxPane!).replace(/\s+/g, ' ');
const trustQuestion = async () => (await h.state()).questions.find((x) => x.employeeId === stan && x.kind === 'trust_prompt' && x.status === 'open');

before(async () => {
  h = await createHarness({ timings: { deliverySettleMs: 300 } });
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  stan = (await h.employee('Stan', 'backend', { projectId: project, autonomy: 'standard' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('the end of the old process, reported after the new one was started, does not open the new one for typing', async () => {
  await h.api('POST', `/employees/${stan}/start`, {});
  await waitFor(async () => (await h.session(stan))?.inTurn === false, { label: 'Stan is up', timeout: 30000 });
  const first = (await h.session(stan))!;
  // What the first process runs to report its end: the command in the settings it was started with.
  const settings = JSON.parse(fs.readFileSync(path.join(h.agentHome, 'sessions', first.id, 'settings.json'), 'utf8'));
  const endCommand: string = settings.hooks.SessionEnd[0].hooks[0].command;
  const stopCommand: string = settings.hooks.Stop[0].hooks[0].command;

  // Started again in a folder Claude Code does not trust yet: the new process stands at the prompt.
  fs.writeFileSync(path.join(first.cwd, '.fake-untrusted'), '');
  await h.api('POST', `/employees/${stan}/stop`, {});
  await waitFor(async () => (await h.session(stan))?.status !== 'running', { label: 'stopped', timeout: 15000 });
  await h.api('POST', `/employees/${stan}/start`, {});
  await waitFor(trustQuestion, { label: 'the owner is asked about the folder', timeout: 30000 });
  const second = (await h.session(stan))!;
  assert.equal(second.id, first.id, 'the same session of the office, a new process');
  assert.notEqual(second.inTurn, false);

  // Something is waiting for Stan…
  await h.api('POST', `/employees/${stan}/message`, { body: 'Are you there? @@fake: say stan-got-the-message@@' });
  // …and now the old process's last words arrive, late.
  for (const [command, event] of [[endCommand, 'SessionEnd'], [stopCommand, 'Stop']] as const) {
    // (Not a blocking call: the machine's agent, which the command talks to, runs in this very process.)
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TMUX_PANE: first.tmuxPane ?? '' } });
      child.on('close', resolve);
      child.stdin.end(JSON.stringify({ session_id: first.claudeSessionId, cwd: first.cwd, hook_event_name: event, reason: 'other' }));
    });
    assert.equal(code, 0);
  }
  await sleep(2500);
  const now = (await h.session(stan))!;
  assert.notEqual(now.inTurn, false, 'the new process has not said it is between turns');
  assert.equal(now.status, 'running');
  assert.ok(await trustQuestion(), 'the prompt still waits for the owner');
  assert.match(await pane(), /trust/i);
  assert.doesNotMatch(await pane(), /Are you there\?|pasted \d+ chars|stan-got-the-message/, 'nothing was typed into the dialog');
  const queued = (await h.state()).messages.find((m) => m.toEmployeeId === stan && /Are you there/.test(m.body))!;
  assert.equal(queued.delivery.status, 'queued');

  // The owner answers the prompt; then the message is handed over.
  await h.api('POST', `/questions/${(await trustQuestion())!.id}/answer`, { answer: 'Trust this folder' });
  await waitFor(async () => /stan-got-the-message/.test(await pane()), { label: 'the message reached Stan after the prompt', timeout: 30000 });
  assert.equal((await h.session(stan))!.status, 'running');
});

test('hooks of the process that is running are heard as before; one that names no start at all is from before, too', async () => {
  await waitFor(async () => (await h.session(stan))?.inTurn === false, { label: 'Stan between turns', timeout: 30000 });
  const s = (await h.session(stan))!;
  await h.api('POST', `/employees/${stan}/message`, { body: 'One more. @@fake: say stan-second-turn@@' });
  await waitFor(async () => /stan-second-turn/.test(await pane()), { label: 'a turn of the running process', timeout: 30000 });
  await waitFor(async () => (await h.session(stan))?.inTurn === false, { label: 'its end was heard', timeout: 15000 });
  assert.ok(Date.parse((await h.session(stan))!.lastEventAt!) >= Date.parse(s.startedAt!));
  // A process started before starts had names sends none: its hooks are not the running process's either.
  const settings = JSON.parse(fs.readFileSync(path.join(h.agentHome, 'sessions', s.id, 'settings.json'), 'utf8'));
  const unnamed = String(settings.hooks.UserPromptSubmit[0].hooks[0].command).replace(/ -H 'x-orch-launch: [^']*'/, '');
  assert.doesNotMatch(unnamed, /x-orch-launch/);
  const before = (await h.session(stan))!.lastEventAt;
  await new Promise<void>((resolve) => {
    const child = spawn('/bin/sh', ['-c', unnamed], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TMUX_PANE: s.tmuxPane ?? '' } });
    child.on('close', () => resolve());
    child.stdin.end(JSON.stringify({ session_id: s.claudeSessionId, cwd: s.cwd, hook_event_name: 'UserPromptSubmit', prompt: 'not from this process' }));
  });
  await sleep(800);
  const after = (await h.session(stan))!;
  assert.deepEqual([after.lastEventAt, after.inTurn], [before, false], 'it changed nothing');
});
