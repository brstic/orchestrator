import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Employee, Host, Question } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';
import { answerLine, answerPrompt } from '../src/prompts.ts';

/**
 * The foreman was removed (the owner, 2026-11-27). An office from before still has its records: an employee with the
 * old role, its settings, questions it answered. They must load, and the employee is archived — its session stopped
 * the office's normal way first (`session.kill` to the host agent, never anything else).
 */
const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };

function oldOffice(opts: { online: boolean; running: boolean }) {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const online = { now: opts.online };
  const link: AgentLink = { rpc: (async (_h: string, req: { method: string }) => void calls.push(req.method)) as AgentLink['rpc'], isOnline: () => online.now, respondHook: () => false, disconnect: () => undefined };
  const before = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0 } }, { send: () => undefined });
  before.core.put('host', host);
  const alex = before.employees.create({ name: 'Alex', roleKey: 'backend', hostId: host.id, workingDir: '/tmp/x' });
  // What an older office wrote: an employee with the role, and the role's settings.
  const mira: Employee = { ...before.employees.create({ name: 'Mira', roleKey: 'backend', hostId: host.id, workingDir: '/tmp/m' }), roleKey: 'foreman', deskId: null };
  before.core.put('employee', mira);
  store.kvSet('settings', { ...before.core.settings, foreman: { enabled: false, minGapSeconds: 120, quietCheckMinutes: 15, answersQuestions: true, idleMinutes: 10 } });
  if (opts.running) {
    const iso = new Date().toISOString();
    before.core.put('session', {
      id: 's-mira', employeeId: mira.id, hostId: host.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-mira', tmuxPane: '%1', cwd: '/tmp/m', repoRoot: null, branch: null, claudeSessionId: 'c',
      status: 'running', activity: 'idle', activityDetail: null, activitySince: iso, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null,
      capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false },
      permissionMode: null, model: null, cols: 120, rows: 34, pid: 1, usage: null, startedAt: iso, endedAt: null, lastEventAt: iso, exitReason: null,
    } as AgentSession);
  }
  const eng = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0 } }, { send: () => undefined });
  return { eng, calls, online, alex, mira };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('an office from before: the foreman is archived when the office starts, and its settings are dropped', async () => {
  const { eng, calls, alex, mira } = oldOffice({ online: true, running: false });
  assert.equal('foreman' in eng.core.settings, false, 'the old settings load, without the foreman key');
  eng.start();
  await settle();
  eng.stop();
  assert.equal(eng.core.employees.require(mira.id).archived, true);
  assert.equal(eng.core.employees.require(alex.id).archived, false, 'nobody else');
  assert.deepEqual(calls, [], 'no session, nothing to stop');
  // A client from before may still send the foreman's settings: ignored.
  eng.core.updateSettings({ foreman: { enabled: true } } as any);
  assert.equal('foreman' in eng.core.settings, false);
});

test('a foreman whose session runs is stopped the office\'s normal way, then archived; while its machine is away it waits', async () => {
  const { eng, calls, online, mira } = oldOffice({ online: false, running: true });
  eng.start();
  await settle();
  assert.equal(eng.core.employees.require(mira.id).archived, false, 'its machine is not there to stop the session');
  assert.deepEqual(calls, []);
  assert.equal(eng.core.sessions.require('s-mira').status, 'host_offline');
  // The machine is back and says the session still runs (what its report does).
  online.now = true;
  eng.core.put('session', { ...eng.core.sessions.require('s-mira'), status: 'running' });
  await eng.employees.retireForemen();
  eng.stop();
  assert.deepEqual(calls, ['session.kill'], 'stopped through the host agent, as any session the office started');
  assert.equal(eng.core.runningSessionOf(mira.id), undefined);
  assert.equal(eng.core.employees.require(mira.id).archived, true);
  // The role is gone: nobody is hired into it, and it is not given by a change of role either.
  assert.equal(eng.employees.create({ name: 'New', roleKey: 'foreman', hostId: host.id, workingDir: '/tmp/n' }).roleKey, 'custom');
});

test('a question the foreman answered in an older office still reads as it did', () => {
  const q = { id: 'q1', kind: 'question', text: 'Which key?', answer: 'The staging one.', answeredBy: { kind: 'foreman', id: 'e1', name: 'Mira' } } as unknown as Question;
  assert.match(answerPrompt(q), /Mira \(the foreman\) answered your question "Which key\?" on the boss's behalf: The staging one\./);
  assert.match(answerLine(q), /^Mira \(the foreman\) answered on the boss's behalf: The staging one\./);
});
