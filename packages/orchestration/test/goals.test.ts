import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, GOAL_IDLE_TURNS, GOAL_MAX_TURNS, type AgentLink } from '../src/index.ts';

/**
 * Goals, the office's /goal (the owner, 2026-11-13: "something like Claude Code's /goal, so that it can work until it
 * has finished everything the goal asks"). The Stop hook a session sends when its turn ends is answered here by hand,
 * and its tools are fed in as hooks: no tmux, no model.
 */
const answers: Array<Record<string, unknown> | null> = [];
let checkExit = 0;
const checks: Array<{ cwd: string; command: string }> = [];
const link: AgentLink = {
  rpc: async (_h, rpc: any) => {
    if (rpc.method === 'verify.run') {
      checks.push({ cwd: rpc.params.cwd, command: rpc.params.command });
      return { exitCode: checkExit, timedOut: false, outputTail: checkExit ? '2 failing' : 'all passed', durationMs: 5 } as any;
    }
    if (rpc.method === 'session.paste') return { via: 'terminal' } as any;
    throw new Error('this test host runs nothing else');
  },
  isOnline: () => true,
  respondHook: (_h, _r, output) => {
    answers.push(output);
    return true;
  },
  disconnect: () => undefined,
};
const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };

function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0 } }, { send: () => undefined });
  eng.core.put('host', host);
  const alex = eng.employees.create({ name: 'Alex', roleKey: 'backend', hostId: host.id, workingDir: '/tmp/alex', autonomy: 'auto' });
  const now = new Date().toISOString();
  eng.core.put('session', {
    id: 'sess-alex', employeeId: alex.id, hostId: host.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-alex', tmuxPane: '%1', cwd: '/tmp/alex', repoRoot: null, branch: null, claudeSessionId: 'c',
    status: 'running', activity: 'idle', activityDetail: null, activitySince: now, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null,
    capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false },
    permissionMode: null, model: null, cols: 120, rows: 34, pid: 4242, usage: null, startedAt: now, endedAt: null, lastEventAt: now, exitReason: null,
  } as AgentSession);
  let n = 0;
  const raw = (payload: Record<string, unknown>) => ({ id: `h-${++n}`, ts: new Date().toISOString(), hostSeq: n, sessionId: 'sess-alex', tmuxPane: '%1', payload: { session_id: 'c', cwd: '/tmp/alex', ...payload } as any });
  const hook = (payload: Record<string, unknown>) => eng.hooks.onHook(host.id, raw(payload));
  /** One turn: a prompt, `tools` tool calls, and the Stop hook the office is asked to decide. Returns its answer. */
  const turn = (tools: number, prompt = 'go on') => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt });
    for (let i = 0; i < tools; i++) hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: `t${n}`, tool_input: { command: 'make' }, tool_response: { stdout: '', stderr: '' } });
    const r = raw({ hook_event_name: 'Stop', last_assistant_message: 'Done for now.' });
    eng.hooks.markRequest(r);
    eng.hooks.onHookRequest(host.id, `req-${n}`, r);
    return answers.at(-1) as { decision?: string; reason?: string } | null;
  };
  /** The tool as the server calls it once the session token has said who it is. */
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee: eng.core.employees.require(alex.id), session: eng.core.sessions.require('sess-alex') });
    return { text: String(res.body.result.content[0].text), isError: res.body.result.isError === true };
  };
  const goal = () => eng.core.employees.require(alex.id).goal ?? null;
  /** The goal's message reaches them (at the end of the turn in hand, as the office hands over what waits). */
  const told = () => {
    const a = turn(1);
    assert.equal(a?.decision, 'block');
    assert.match(String(a?.reason), /given you a goal:/);
  };
  return { eng, alex, turn, tool, goal, hook, told };
}
const BOSS = { kind: 'owner' as const, id: 'owner', name: 'the boss' };

test('given a goal, they are told it, and each time their turn ends without it holding they are sent on toward it', () => {
  const o = office();
  o.eng.goals.set(o.alex.id, { condition: 'Every test in packages/api passes and the branch is pushed.' }, BOSS);
  // Told in their session.
  const told = o.eng.core.messages.find((m) => m.toEmployeeId === o.alex.id && /the boss has given you a goal:\n\nEvery test in packages\/api passes/.test(m.body));
  assert.ok(told, 'the goal is a message to them');
  assert.match(told!.body, /goal_met/);
  o.told();
  // A turn ends with work done: they are sent on, with the goal in the words.
  const a = o.turn(4);
  assert.equal(a?.decision, 'block');
  assert.match(String(a?.reason), /^Goal not yet met — keep working toward it:\n\nEvery test in packages\/api passes/);
  assert.equal(o.goal()!.turns, 1);
  // And again: there is no budget of three nudges as there is for a task.
  for (let i = 0; i < 6; i++) assert.equal(o.turn(2)?.decision, 'block');
  assert.equal(o.goal()!.turns, 7);
  assert.ok(o.eng.core.store.recentAudit(20).some((x) => x.action === 'goal.set' && (x.detail as any).employee === 'Alex'));
});

test('they say it holds: without a check their word ends it; with one, only a pass does — and then they stop', async () => {
  const o = office();
  o.eng.goals.set(o.alex.id, { condition: 'The report is written.' }, BOSS);
  o.told();
  assert.equal((await o.tool('goal_met', { evidence: 'ok' })).isError, true, 'how they know must be said');
  const met = await o.tool('goal_met', { evidence: 'docs/report.md is written and reviewed against the outline.' });
  assert.equal(met.isError, false, met.text);
  assert.equal(o.goal()!.status, 'met');
  assert.equal(o.turn(3), null, 'nothing sends them on any more');
  assert.ok(!!o.eng.core.notifications.find((n) => n.title === 'Alex met the goal you gave them'));

  // With a command to check by: run in their folder; a failure keeps the goal.
  o.eng.goals.set(o.alex.id, { condition: 'All tests pass.', check: 'pnpm test' }, BOSS);
  o.told();
  checkExit = 1;
  const no = await o.tool('goal_met', { evidence: 'I ran the tests and they passed.' });
  assert.equal(no.isError, true);
  assert.match(no.text, /Not yet: the check "pnpm test" ended with exit code 1[\s\S]*2 failing[\s\S]*Your goal stands/);
  assert.deepEqual(checks.at(-1), { cwd: '/tmp/alex', command: 'pnpm test' });
  assert.equal(o.goal()!.status, 'active');
  checkExit = 0;
  assert.equal((await o.tool('goal_met', { evidence: 'Fixed the two failing tests; pnpm test passes.' })).isError, false);
  assert.equal(o.goal()!.status, 'met');
});

test('it stops by itself: three turns that did nothing, or the ceiling of turns — and the owner is told', () => {
  const o = office();
  o.eng.goals.set(o.alex.id, { condition: 'The migration is done.' }, BOSS);
  o.told();
  assert.equal(o.turn(1)?.decision, 'block');
  // Turns in which nothing was done (only words, or only the office's bookkeeping).
  o.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  o.hook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__orchestrator__report_progress', tool_input: {}, tool_response: {} });
  for (let i = 1; i < GOAL_IDLE_TURNS; i++) {
    const a = o.turn(0);
    assert.equal(a?.decision, 'block');
    assert.match(String(a?.reason), new RegExp(`without anything done \\(${i} of ${GOAL_IDLE_TURNS}\\)`));
  }
  assert.equal(o.turn(0), null, 'the third does not send them on');
  assert.equal(o.goal()!.status, 'stopped');
  assert.match(String(o.goal()!.outcome), /no progress/);
  assert.ok(!!o.eng.core.notifications.find((n) => n.title === 'Alex stopped working toward their goal'));

  // The ceiling.
  o.eng.goals.set(o.alex.id, { condition: 'Something that never comes.' }, BOSS);
  o.told();
  o.eng.core.put('employee', { ...o.eng.core.employees.require(o.alex.id), goal: { ...o.goal()!, turns: GOAL_MAX_TURNS } });
  assert.equal(o.turn(5), null);
  assert.match(String(o.goal()!.outcome), new RegExp(`${GOAL_MAX_TURNS} times`));
});

test('it waits, without ending, while they wait: an open question, a blocker they reported, a paused session', () => {
  const o = office();
  o.eng.goals.set(o.alex.id, { condition: 'The release is out.' }, BOSS);
  o.told();
  const q = o.eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: o.alex, session: o.eng.core.sessions.require('sess-alex'), text: 'Which version number?', context: '', why: '' });
  assert.equal(o.turn(2), null, 'they wait for the answer');
  assert.equal(o.goal()!.status, 'active');
  o.eng.comms.supersede(q.id, 'answered elsewhere');
  o.eng.sessions.setActivity(o.eng.core.sessions.require('sess-alex'), 'blocked', 'Need the signing key');
  o.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  o.eng.sessions.setActivity(o.eng.core.sessions.require('sess-alex'), 'blocked', 'Need the signing key');
  const r = { id: 'stop-b', ts: new Date().toISOString(), hostSeq: 999, sessionId: 'sess-alex', tmuxPane: '%1', payload: { hook_event_name: 'Stop', session_id: 'c' } as any };
  o.eng.hooks.markRequest(r);
  o.eng.hooks.onHookRequest(host.id, 'req-b', r);
  assert.equal(answers.at(-1), null, 'a blocker they reported is the owner\'s to answer');
  assert.equal(o.goal()!.status, 'active');
});

test('who may do what: they set their own (not over a person\'s), give no command to check by, and do not clear what a person gave', async () => {
  const o = office();
  const own = await o.tool('set_goal', { condition: 'The flaky test in api/auth.test.ts is found and fixed.' });
  assert.equal(own.isError, false, own.text);
  assert.equal(o.goal()!.setBy.kind, 'employee');
  assert.equal(o.eng.core.messages.filter((m) => m.toEmployeeId === o.alex.id && /given you a goal/.test(m.body)).length, 0, 'not told what they said themselves');
  assert.equal(o.turn(2)?.decision, 'block');
  // A command to check by is a person's to give.
  assert.throws(() => o.eng.goals.set(o.alex.id, { condition: 'x is done', check: 'rm -rf /' }, { kind: 'employee', id: o.alex.id, name: 'Alex' }), /Only a person gives a command/);
  // A person's goal stands over theirs.
  o.eng.goals.set(o.alex.id, { condition: 'Ship the login page.' }, BOSS);
  o.told();
  const over = await o.tool('set_goal', { condition: 'Refactor everything.' });
  assert.equal(over.isError, true);
  assert.match(over.text, /already have a goal the boss gave you/);
  assert.throws(() => o.eng.goals.clear(o.alex.id, { kind: 'employee', id: o.alex.id, name: 'Alex' }), /only a person can clear it/);
  // The person clears it: nothing sends them on.
  o.eng.goals.clear(o.alex.id, BOSS);
  assert.equal(o.goal()!.status, 'stopped');
  assert.equal(o.turn(2), null);
  // What they work toward is in get_current_task.
  o.eng.goals.set(o.alex.id, { condition: 'Ship the login page.' }, BOSS);
  assert.match((await o.tool('get_current_task', {})).text, /Your goal \(from the boss, 0 turns so far\): Ship the login page\./);
  assert.throws(() => o.eng.goals.set(o.alex.id, { condition: '  ' }, BOSS), /Say what has to be true/);
});
