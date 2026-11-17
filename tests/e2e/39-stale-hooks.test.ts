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
  // (The trust question is asked of the owner here, as it was before the office answered it by itself: 54-start-prompts.)
  await h.api('PATCH', '/settings', { acceptStartPrompts: false });
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

test('a session stopped on purpose is a stop, not a loss — nobody is told the employee "went offline"; one that dies still is', async () => {
  const zed = (await h.employee('Zed', 'backend', { projectId: project, autonomy: 'standard' })).id;
  await h.api('POST', `/employees/${zed}/start`, {});
  await waitFor(async () => (await h.session(zed))?.inTurn === false, { label: 'Zed is up', timeout: 30000 });
  const lostBefore = (await h.state()).company.sessionsLost;
  const alerts = async () => (await h.state()).notifications.filter((n) => n.kind === 'session_lost' && n.employeeId === zed).length;
  const events = async (type: string) => (await h.state()).events.filter((e) => e.type === type && e.employeeId === zed);

  // Stopped by the owner.
  await h.api('POST', `/employees/${zed}/stop`, {});
  await waitFor(async () => (await h.session(zed))?.status !== 'running', { label: 'stopped', timeout: 15000 });
  await sleep(1500);
  assert.match((await events('session.stopped')).map((e) => e.summary).join('\n'), /Zed's session was stopped \(stopped by the owner\)/);
  assert.deepEqual([(await events('session.lost')).length, await alerts(), (await h.state()).company.sessionsLost], [0, 0, lostBefore]);

  // Started again and stopped by the office in order to start it again (a change of model): the same.
  await h.api('POST', `/employees/${zed}/start`, {});
  await waitFor(async () => (await h.session(zed))?.inTurn === false, { label: 'Zed is up again', timeout: 30000 });
  const startedAt = (await h.session(zed))!.startedAt;
  await h.api('PATCH', `/employees/${zed}`, { model: 'sonnet' });
  await waitFor(async () => {
    const s = await h.session(zed);
    return s?.status === 'running' && s.startedAt !== startedAt && s.inTurn === false;
  }, { label: 'started again for the change', timeout: 30000 });
  await sleep(1000);
  assert.deepEqual([(await events('session.lost')).length, await alerts(), (await h.state()).company.sessionsLost], [0, 0, lostBefore]);
  assert.match((await events('session.stopped')).map((e) => e.summary).join('\n'), /Zed's session was stopped \(started again for a change of settings\)/);

  // Its tmux session is killed from outside: that is a loss, and it is said.
  h.tmux('kill-session', '-t', (await h.session(zed))!.tmuxSession!);
  await waitFor(async () => (await events('session.lost')).length === 1, { label: 'the loss is reported', timeout: 20000 });
  assert.deepEqual([await alerts(), (await h.state()).company.sessionsLost], [1, lostBefore + 1]);
});

test('a session that dies in the middle of a task is started again by the office and told to go on — twice, then a person is asked', async () => {
  // Seen on the live office: a session ended at Claude Code's start-up question while working on a ticket, and the
  // ticket stood "in progress" with nobody on it all night — the alert only said to restart the session by hand.
  const ula = (await h.employee('Ula', 'backend', { projectId: project, autonomy: 'auto' })).id;
  const task = await h.task({ projectId: project, title: 'Long careful change', assigneeId: ula, description: 'Wait for what is said on the ticket.' });
  await waitFor(async () => (await h.getTask(task.id)).status === 'IN_PROGRESS' && (await h.session(ula))?.inTurn === false, { label: 'Ula is at it', timeout: 30000 });
  const alerts = async () => (await h.state()).notifications.filter((n) => n.kind === 'session_lost' && n.employeeId === ula);
  const toldToGoOn = async () => (await h.state()).messages.filter((m) => m.toEmployeeId === ula && m.taskId === task.id && /started it again/.test(m.body));
  const kill = async (n: number) => {
    const s = (await h.session(ula))!;
    h.tmux('kill-session', '-t', s.tmuxSession!);
    await waitFor(async () => (await alerts()).length === n, { label: `loss ${n} is reported`, timeout: 20000 });
    return s.startedAt;
  };
  for (const n of [1, 2]) {
    const before = await kill(n);
    const back = await waitFor(async () => {
      const s = await h.session(ula);
      return s?.status === 'running' && s.startedAt !== before ? s : null;
    }, { label: `started again (${n})`, timeout: 30000 });
    assert.ok(back);
    const told = await waitFor(async () => ((await toldToGoOn()).length === n ? toldToGoOn() : null), { label: `told to go on (${n})` });
    assert.match(told.at(-1)!.body, new RegExp(`working on ${task.key} .*Continue ${task.key} where you left off`, 's'));
    assert.match((await alerts()).at(-1)!.body, /The office started it again/);
    // (Taken — acknowledged by Claude Code — before the next loss: one that was not is handed over again, as it should.)
    await waitFor(async () => (await toldToGoOn()).every((m) => m.delivery.status === 'confirmed') && (await h.session(ula))?.inTurn === false, { label: 'Ula took it', timeout: 30000 });
  }
  // A third time within the half hour: not again by itself — a person looks.
  await kill(3);
  await sleep(3000);
  assert.equal((await h.session(ula))!.status, 'lost', 'not started a third time');
  assert.match((await alerts()).at(-1)!.body, /stopped 3 times.*Restart the session/s);
  assert.equal((await h.getTask(task.id)).status, 'IN_PROGRESS');
});
