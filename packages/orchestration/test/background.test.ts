import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host } from '@orchestrator/contracts';
import { ACTIVITY_LABEL } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A command that goes on in the background: the office is told by the session's machine which command shells are
 * alive, and by its hooks which Bash call is in front of it. Both are fed in by hand here — no tmux, no model.
 */
const answers: Array<Record<string, unknown> | null> = [];
const link: AgentLink = {
  rpc: () => Promise.reject(new Error('this test host runs nothing')),
  isOnline: () => true,
  respondHook: (_h, _r, output) => {
    answers.push(output);
    return true;
  },
  disconnect: () => undefined,
};
const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };

function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, sleepIdleMs: 1 } }, { send: () => undefined });
  eng.core.put('host', host);
  const alex = eng.employees.create({ name: 'Alex', roleKey: 'backend', hostId: host.id, workingDir: '/tmp/x' });
  const now = new Date().toISOString();
  const session = eng.core.put('session', {
    id: 'sess-alex', employeeId: alex.id, hostId: host.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-alex', tmuxPane: '%1', cwd: '/tmp/x', repoRoot: null, branch: null, claudeSessionId: 'c',
    status: 'running', activity: 'idle', activityDetail: null, activitySince: now, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null,
    capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false },
    permissionMode: null, model: null, cols: 120, rows: 34, pid: 4242, usage: null, startedAt: now, endedAt: null, lastEventAt: now, exitReason: null,
  } as AgentSession);
  let n = 0;
  const hook = (payload: Record<string, unknown>) => eng.hooks.onHook(host.id, { id: `h-${++n}`, ts: new Date().toISOString(), hostSeq: n, sessionId: session.id, tmuxPane: '%1', payload: { session_id: 'c', cwd: '/tmp/x', ...payload } as any });
  /** The machine says these shells are alive: [pid, command, seconds running]. */
  const shells = (...list: Array<[number, string, number]>) => eng.background.onShells(host.id, session.id, list.map(([pid, command, seconds]) => ({ pid, command, seconds })));
  const s = () => eng.core.sessions.require(session.id);
  return { eng, alex, hook, shells, s };
}

const TESTS = 'pnpm test --run';

test('a command sent to the background: shown on the session while the employee goes on, and as what they wait for once the turn is over', () => {
  const o = office();
  o.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'run the suite and fix what fails' });
  // In front of the session: the command runs, and nothing is in the background.
  o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: TESTS, description: 'Run the full test suite', run_in_background: true } });
  o.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: TESTS, description: 'Run the full test suite', run_in_background: true }, tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash_1' } });
  o.shells([501, TESTS, 2]);
  assert.equal(o.s().background?.length, 1);
  assert.equal(o.s().background![0]!.what, 'Run the full test suite', "in Claude Code's own words for it");
  assert.ok(Date.now() - Date.parse(o.s().background![0]!.since) >= 1500, 'running since it was started, not since it was seen');
  // A command in front of the session meanwhile: its shell is not "in the background".
  o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-2', tool_input: { command: 'git status', description: 'Show the working tree' } });
  o.shells([501, TESTS, 4], [502, 'git status', 0]);
  assert.deepEqual(o.s().background!.map((b) => b.what), ['Run the full test suite']);
  assert.equal(o.s().activity, 'running_command', 'what they do in front is what is shown');
  o.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-2', tool_input: { command: 'git status' }, tool_response: { stdout: 'clean', stderr: '', interrupted: false } });
  o.shells([501, TESTS, 5]);
  // The turn ends: Alex has nothing in hand but the command.
  o.hook({ hook_event_name: 'Stop', last_assistant_message: 'The suite is running; I will look at the results when it finishes.' });
  assert.equal(o.s().inTurn, false);
  assert.equal(o.s().activity, 'waiting_command');
  assert.equal(ACTIVITY_LABEL[o.s().activity], '⏳ COMMAND RUNNING');
  assert.equal(o.s().activityDetail, 'Run the full test suite');
  // It ends: Alex is available again (Claude Code tells the session; what it then does, its hooks say).
  o.shells();
  assert.equal(o.s().background ?? null, null);
  assert.deepEqual([o.s().activity, o.s().activityDetail], ['idle', null]);
});

test('a command moved to the background after its time ran out, or by hand, counts the same; the newest is the one in front when the words differ', () => {
  const o = office();
  o.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'build it' });
  o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'make all', description: 'Build everything' } });
  // (Seen by the machine two minutes in: the test does not wait for the clock.)
  o.shells([600, 'make all', 120]);
  assert.equal(o.s().background ?? null, null, 'in front of the session while it waits for it');
  // Claude Code gives up waiting and lets it run on.
  o.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'make all' }, tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash_2' } });
  assert.deepEqual(o.s().background!.map((b) => b.what), ['Build everything']);
  // A call whose shell does not read back as its command (a machine that writes it differently): the newest shell is its.
  o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-3', tool_input: { command: 'ls -la' } });
  o.shells([600, 'make all', 130], [601, '/bin/sh -c something else', 0]);
  assert.deepEqual(o.s().background!.map((b) => b.what), ['Build everything']);
  o.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-3', tool_input: { command: 'ls -la' }, tool_response: { stdout: '', stderr: '', interrupted: false } });
  o.shells([600, 'make all', 131]);
  // A call that waits for an approval has no shell yet: the older one is not taken for it.
  o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-4', tool_input: { command: 'rm -rf build' } });
  o.hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.deepEqual(o.eng.core.sessions.require('sess-alex').background!.map((b) => b.what), ['Build everything']);
  o.hook({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  // A secret in a command does not reach the office's records with it.
  o.shells([600, 'make all', 132], [602, 'curl -H "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" https://example.test', 1]);
  assert.equal(o.s().background!.length, 2);
  assert.ok(!JSON.stringify(o.s()).includes('sk-ant-api03-AAAA'), JSON.stringify(o.s().background));
});

test('what says more is not covered: a question, a wait for a colleague, a pause, a finished task — and nobody is nudged or put to sleep while their command runs', () => {
  const o = office();
  o.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true } });
  o.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'npm run dev', run_in_background: true }, tool_response: { backgroundTaskId: 'bash_3' } });
  // Before the machine has said anything about the shell, the office already knows not to nudge them on.
  assert.equal(o.eng.background.busy('sess-alex'), true);
  o.shells([700, 'npm run dev', 3]);
  o.hook({ hook_event_name: 'Stop', last_assistant_message: 'Server is up.' });
  assert.equal(o.s().activity, 'waiting_command');
  // A completed task says more: it stays, and the line under the name says that something still runs.
  o.eng.sessions.setActivity(o.s(), 'task_complete', 'T-1 done');
  assert.equal(o.s().activity, 'task_complete');
  assert.equal(o.s().background!.length, 1);
  // Waiting for a colleague says more too.
  o.eng.sessions.setActivity(o.s(), 'waiting_input', "Waiting for Sarah's answer on T-2");
  assert.equal(o.s().activity, 'waiting_input');
  // The sleeper leaves them be: stopping the session would stop the server.
  assert.equal(o.eng.sleeper.keptAwake(o.alex, o.s(), Date.now() + 60_000), 'a command of theirs is running in the background');
  // The session ends: nothing of it runs any more as far as the office knows.
  o.eng.sessions.onReport(host.id, { sessionId: 'sess-alex', origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-alex', tmuxPane: '%1', cwd: '/tmp/x', repoRoot: null, branch: null, pid: null, alive: false, command: null, cols: 120, rows: 34, claudeSessionId: 'c', capabilities: o.s().capabilities, permissionMode: null, model: null, startedAt: o.s().startedAt, exitReason: 'process exited' });
  assert.equal(o.s().background ?? null, null);
  assert.equal(o.s().activity, 'offline');
});

test('a report from another machine, or about a session it does not have, changes nothing', () => {
  const o = office();
  o.eng.background.onShells('host-2', 'sess-alex', [{ pid: 1, command: 'rm -rf /', seconds: 1 }]);
  o.eng.background.onShells(host.id, 'nobody', [{ pid: 1, command: 'x', seconds: 1 }]);
  o.eng.background.onShells(host.id, 'sess-alex', 'not a list');
  assert.equal(o.s().background ?? null, null);
  assert.equal(o.s().activity, 'idle');
});
