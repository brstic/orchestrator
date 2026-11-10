/**
 * The SDK-managed worker runtime: an employee driven through the Claude Agent
 * SDK instead of the interactive TUI. Prompts, approvals and interrupts are
 * structured calls; the tmux pane shows a transcript and still accepts a
 * human at the keyboard. A host without the SDK falls back, and says so.
 *
 * The SDK here is the fake-agent-sdk fixture (no model); the runner, agent,
 * tmux, hooks, MCP server and engine are the real ones.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_AGENT_SDK, createHarness, waitFor, sleep, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;
let box: Awaited<ReturnType<Harness['addHost']>>;
let repo = '';
let mira: any;
let sessionId = '';

const screen = (s: { tmuxPane: string | null }) => box.tmux('capture-pane', '-p', '-J', '-S', '-300', '-t', s.tmuxPane!);
const idle = (id: string) => waitFor(async () => (await h.session(id))!.inTurn === false, { label: 'idle' });

before(async () => {
  h = await createHarness();
  boss = await h.client();
  box = await h.addHost('sdk-box', { sdkPath: FAKE_AGENT_SDK, approvalWaitSeconds: 6 });
  repo = path.join(box.root, 'ledger');
  fs.mkdirSync(repo, { recursive: true });
  h.git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# ledger\n');
  h.git(repo, 'add', '-A');
  h.git(repo, 'commit', '-q', '-m', 'init');
});
after(async () => {
  await h.cleanup();
});

test('hosts report which worker runtimes they can actually provide', async () => {
  const hosts = await waitFor(async () => {
    const list = (await h.state()).hosts;
    return list.every((x) => x.info?.runtimes) ? list : null;
  }, { label: 'runtimes reported' });
  assert.deepEqual(hosts.find((x) => x.name === 'test-host')!.info!.runtimes, ['interactive_cli']);
  assert.deepEqual(hosts.find((x) => x.name === 'sdk-box')!.info!.runtimes, ['interactive_cli', 'managed_sdk']);
});

test('on a host without the SDK the employee falls back to the interactive CLI, visibly', async () => {
  const folder = h.makeRepo('plain');
  const ned = await h.api('POST', '/employees', { name: 'Ned', roleKey: 'backend', hostId: h.hostId, workingDir: folder, executionMode: 'managed_sdk' });
  const s = await h.api('POST', `/employees/${ned.id}/start`, {});
  assert.equal(s.mode, 'interactive_cli');
  const state = await h.state();
  assert.ok(state.notifications.some((n) => /runtime fallback/.test(n.title) && n.employeeId === ned.id));
  assert.ok(state.events.some((e) => e.employeeId === ned.id && (e.data as any)?.fallback === true));
  await h.api('POST', `/employees/${ned.id}/stop`, {});
});

test('an SDK-managed employee starts in a real tmux pane running the runner, with structured capabilities', async () => {
  mira = await h.api('POST', '/employees', { name: 'Mira', roleKey: 'backend', hostId: box.hostId, workingDir: repo, executionMode: 'managed_sdk', autonomy: 'supervised' });
  const s = await h.api('POST', `/employees/${mira.id}/start`, {});
  sessionId = s.id;
  assert.equal(s.mode, 'managed_sdk');
  assert.deepEqual(s.capabilities, { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: true });
  await idle(mira.id);
  const live = (await h.session(mira.id))!;
  assert.equal(live.status, 'running');
  assert.equal(live.activity, 'idle');
  assert.match(screen(live), /SDK-managed Claude worker/);
  // The process in the pane is the runner, not the claude TUI.
  assert.match(box.tmux('display-message', '-p', '-t', live.tmuxPane!, '#{pane_start_command}'), /managed-run/);
  assert.ok(!(await h.state()).notifications.some((n) => /runtime fallback/.test(n.title) && n.employeeId === mira.id));
});

test('a message is handed over as structured SDK input, confirmed by a hook, and the reply comes back', async () => {
  const msg = await h.api('POST', `/employees/${mira.id}/message`, { body: 'What is in this folder? @@fake: read README.md; say It holds the ledger README.@@' });
  const delivered = await waitFor(async () => {
    const m = (await h.state()).messages.find((x) => x.id === msg.id)!;
    return m.delivery.status === 'confirmed' ? m : null;
  }, { label: 'delivery confirmed' });
  assert.equal(delivered.delivery.via, 'sdk', 'nothing was typed into the terminal');
  const reply = await waitFor(async () => (await h.api('GET', `/events?employeeId=${mira.id}&limit=200`)).find((e: any) => e.type === 'agent.turn_finished' && /ledger README/.test(e.data.lastMessage ?? '')), { label: 'reply captured' });
  assert.equal(reply.source.kind, 'hook');
  const live = (await h.session(mira.id))!;
  // The pane is a faithful transcript of what happened.
  await waitFor(() => /What is in this folder\?/.test(screen(live)) && /⏺ Read/.test(screen(live)) && /It holds the ledger README\./.test(screen(live)), { label: 'transcript in the pane' });
});

test('usage is measured and the SDK cost estimate is recorded as an estimate', async () => {
  const s = await waitFor(async () => {
    const x = (await h.session(mira.id))!;
    return x.usage && x.usage.costUsdEstimate ? x : null;
  }, { label: 'usage with cost' });
  assert.ok(s.usage!.outputTokens > 0);
  assert.ok(s.usage!.costUsdEstimate! > 0);
  assert.ok(s.usage!.turns >= 1);
});

test('approvals go through the SDK permission callback: allow runs the tool, deny is reported to the agent', async () => {
  await idle(mira.id);
  await h.api('POST', `/employees/${mira.id}/message`, { body: 'Record two entries. @@fake: write a.txt first; write b.txt second; say after-approvals@@' });
  const q1 = await waitFor(() => h.openQuestion(mira.id, 'permission'), { label: 'permission request' });
  assert.equal(q1.channel, 'permission_hook');
  assert.equal(q1.tool!.name, 'Write');
  assert.equal((await h.session(mira.id))!.activity, 'needs_approval');
  assert.ok(!fs.existsSync(path.join(repo, 'a.txt')), 'nothing is written before approval');
  await h.api('POST', `/questions/${q1.id}/answer`, { decision: 'allow' });
  await waitFor(() => fs.existsSync(path.join(repo, 'a.txt')), { label: 'approved write happened' });
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q1.id)?.status === 'confirmed', { label: 'approval confirmed by PostToolUse' });
  const q2 = await waitFor(() => h.openQuestion(mira.id, 'permission'), { label: 'second permission request' });
  await h.api('POST', `/questions/${q2.id}/answer`, { decision: 'deny', answer: 'Not that file.' });
  const live = (await h.session(mira.id))!;
  await waitFor(() => /denied from the office: Not that file\./.test(screen(live)) && /after-approvals/.test(screen(live)), { label: 'denial reached the agent, which continued' });
  assert.ok(!fs.existsSync(path.join(repo, 'b.txt')), 'denied write never happened');
});

test('when nobody answers in the office, the approval falls back to the workstation keyboard', async () => {
  await idle(mira.id);
  await h.api('POST', `/employees/${mira.id}/message`, { body: 'One more. @@fake: write c.txt third; say after-keyboard@@' });
  await waitFor(() => h.openQuestion(mira.id, 'permission'), { label: 'permission request' });
  const live = (await h.session(mira.id))!;
  // Nobody answers: after the host's approval wait, the runner asks in the pane.
  await waitFor(() => /Allow this\? \[y\/N\]/.test(screen(live)), { label: 'prompt at the workstation', timeout: 15000 });
  assert.ok(!fs.existsSync(path.join(repo, 'c.txt')));
  box.tmux('send-keys', '-t', live.tmuxPane!, 'y');
  await waitFor(() => fs.existsSync(path.join(repo, 'c.txt')) && /after-keyboard/.test(screen(live)), { label: 'approved at the keyboard' });
  await waitFor(async () => !(await h.openQuestion(mira.id, 'permission')), { label: 'the office question is no longer open' });
});

test('interrupting uses the SDK interrupt, not a keypress', async () => {
  await idle(mira.id);
  await h.api('POST', `/employees/${mira.id}/message`, { body: 'Long job. @@fake: say step-1; sleep 4000; say step-2-should-not-run@@' });
  await waitFor(async () => (await h.session(mira.id))!.inTurn === true, { label: 'working' });
  await h.api('POST', `/employees/${mira.id}/pause`, {});
  const live = (await h.session(mira.id))!;
  assert.equal(live.activity, 'paused');
  await waitFor(() => /Interrupted \(office\)/.test(screen(live)), { label: 'runner interrupted through the SDK' });
  const ev = (await h.api('GET', `/events?employeeId=${mira.id}&limit=300`)).find((e: any) => e.type === 'terminal.interrupt');
  assert.equal(ev.data.via, 'sdk');
  assert.match(ev.summary, /through the Agent SDK/);
  await sleep(600);
  // The phrase appears once, in the echoed prompt — never as the agent's output.
  assert.equal(screen(live).split('step-2-should-not-run').length - 1, 1);
  await h.api('POST', `/employees/${mira.id}/resume`, {});
  const after = (await h.session(mira.id))!;
  assert.equal(after.status, 'running', 'the worker itself keeps running');
  assert.equal(after.pid, live.pid, 'same process throughout');
});

test('a person at the workstation can type a prompt; it is a normal turn', async () => {
  await idle(mira.id);
  const live = (await h.session(mira.id))!;
  box.tmux('send-keys', '-t', live.tmuxPane!, '-l', 'hello from the keyboard @@fake: say typed-prompt-works@@');
  box.tmux('send-keys', '-t', live.tmuxPane!, 'Enter');
  await waitFor(() => /typed-prompt-works/.test(screen(live)), { label: 'typed prompt answered' });
  const ev = await waitFor(async () => (await h.api('GET', `/events?employeeId=${mira.id}&limit=300`)).find((e: any) => e.type === 'agent.turn_finished' && /typed-prompt-works/.test(e.data.lastMessage ?? '')), { label: 'turn reported' });
  assert.ok(ev);
});

test('a task is delivered, done in the folder and verified, exactly as for an interactive worker', async () => {
  await idle(mira.id);
  await h.api('PATCH', `/employees/${mira.id}`, { autonomy: 'standard' });
  await h.api('POST', `/employees/${mira.id}/stop`, {});
  const restarted = await h.api('POST', `/employees/${mira.id}/start`, {});
  assert.equal(restarted.id, sessionId, 'same session record');
  assert.equal(restarted.mode, 'managed_sdk');
  await idle(mira.id);
  const live = (await h.session(mira.id))!;
  assert.match(screen(live), /\(resumed\)/, 'the same Claude conversation is resumed');
  assert.equal(live.permissionMode, 'acceptEdits');
  const task = await h.task({ projectId: mira.projectId, title: 'Add totals', assigneeId: mira.id, verifyCommand: 'test -f totals.txt', description: '@@fake: write totals.txt 42; commit add totals; complete totals added@@' });
  const done = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'task done', timeout: 25000 }).catch(async (e) => {
    const t = await h.getTask(task.id);
    throw new Error(`${e.message}\n${JSON.stringify({ status: t.status, blocked: t.blockedReason, delivery: t.delivery, history: t.history.slice(-4) }, null, 1)}\n${screen(live)}`);
  });
  assert.equal(done.evidence.verification!.passed, true);
  assert.equal(done.evidence.verification!.provenance, 'measured');
  assert.match(h.git(repo, 'log', '--oneline', '-1'), /add totals/);
  assert.equal(done.delivery.via, 'sdk');
});

test('the terminal is still a real, streamed terminal in the office', async () => {
  boss.send({ t: 'term.open', sessionId });
  await waitFor(() => /SDK-managed Claude worker/.test(boss.terminal(sessionId)) || /totals added|add totals/.test(boss.terminal(sessionId)), { label: 'terminal streamed to the office' });
  boss.send({ t: 'term.close', sessionId });
});
