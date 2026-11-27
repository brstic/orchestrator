import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * The office was out of reach for a moment (it was being updated): an employee found its tools gone, wrote "I'm stopping
 * and waiting; I'll pick it up once the office is back", and stopped — and stood eight hours, because nothing told it
 * the office was back (its turn ended while the office could not hear it, so it was not nudged on either). When its
 * machine connects again, whoever stands still with a task in progress is told to go on.
 */
test('back in reach: the employee standing still on a task is told to go on; one waiting for an answer is left be', async () => {
  const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => true, disconnect: () => undefined };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { resumeAfterReconnectMs: 5 } }, { send: () => undefined });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  const now = new Date().toISOString();
  const at = (name: string, activity: string, extra: Partial<AgentSession> = {}) => {
    const e = eng.employees.create({ name, roleKey: 'backend', projectId: shop, hostId: 'h', workingDir: `/tmp/${name}` });
    eng.core.put('session', { id: `s-${name}`, employeeId: e.id, hostId: 'h', origin: 'managed', mode: 'interactive_cli', tmuxSession: `orch-${name}`, tmuxPane: '%1', cwd: '/tmp/x', repoRoot: null, branch: null, claudeSessionId: 'c', status: 'running', activity, activityDetail: null, activitySince: now, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: null, model: null, cols: 120, rows: 34, pid: 1, usage: null, startedAt: now, endedAt: null, lastEventAt: now, exitReason: null, ...extra } as AgentSession);
    const t = eng.tasks.createTask({ projectId: shop, title: `${name}'s work`, description: 'x', released: false }, 'owner');
    eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: e.id, status: 'IN_PROGRESS', delivery: { ...eng.core.tasks.require(t.id).delivery, status: 'confirmed' } } as Task);
    return e;
  };
  const still = at('Ana', 'waiting_input');
  const busy = at('Bo', 'thinking', { inTurn: true });
  const waits = at('Cy', 'waiting_input', { waitingOn: { kind: 'colleague', employeeId: still.id } as any });
  const told = (id: string) => eng.core.messages.filter((m) => m.toEmployeeId === id && /office is back/i.test(m.body));
  eng.hosts.connected('h', { hostname: 'box' } as any);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(told(still.id).length, 1);
  assert.match(told(still.id)[0]!.body, /Go on with T-\d+/);
  assert.equal(told(busy.id).length, 0, 'in the middle of a turn');
  assert.equal(told(waits.id).length, 0, 'waiting for a colleague');
  // Connected again soon after: not told twice.
  eng.hosts.connected('h', { hostname: 'box' } as any);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(told(still.id).length, 1);
});
