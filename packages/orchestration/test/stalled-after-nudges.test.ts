import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * An employee who stops with its task unfinished is nudged on, a few times. Once the nudges are spent and it stops
 * again, somebody is told — once: the project manager whose work it is, or else the owner. (The foreman used to notice
 * an idle employee; since it is gone, nobody did, and the ticket stood "in progress".)
 */
const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => true, disconnect: () => undefined };
const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };

function office(createdBy: string) {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0 } }, { send: () => undefined });
  eng.core.put('host', host);
  const shop = eng.core.put('project', { id: 'p', name: 'Shop', description: '', goals: '', requirements: '', docs: '', hostId: host.id, repoPath: '/tmp/x', baseBranch: 'main', integrationBranch: 'main', workspace: 'single', ownerEmployeeId: null, verifyCommand: null, verifyTimeoutSec: 0, extraRepos: [], dependsOn: [], color: '#fff', status: 'active', policy: { allow: [], deny: [], highRiskPatterns: [], autoAssign: false, requireReview: false, autoMerge: true }, milestones: [], deliveredAt: null, createdAt: new Date().toISOString() } as never) as { id: string };
  const mia = eng.employees.create({ name: 'Mia', roleKey: 'pm', hostId: host.id, workingDir: '/tmp/m', projectId: shop.id });
  const alex = eng.employees.create({ name: 'Alex', roleKey: 'backend', hostId: host.id, workingDir: '/tmp/x', projectId: shop.id, autonomy: 'standard' } as never);
  const now = new Date().toISOString();
  eng.core.put('session', { id: 's', employeeId: alex.id, hostId: host.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-alex', tmuxPane: '%1', cwd: '/tmp/x', repoRoot: null, branch: null, claudeSessionId: 'c', status: 'running', activity: 'idle', activityDetail: null, activitySince: now, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: null, model: null, cols: 120, rows: 34, pid: 1, usage: null, startedAt: now, endedAt: null, lastEventAt: now, exitReason: null } as AgentSession);
  const t = eng.tasks.createTask({ projectId: shop.id, title: 'Cart badge', description: 'x', released: false }, createdBy);
  const task = eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: alex.id, status: 'IN_PROGRESS', delivery: { ...eng.core.tasks.require(t.id).delivery, status: 'confirmed' } } as Task);
  let n = 0;
  const stop = () => eng.hooks.onHookRequest(host.id, `r-${n}`, { id: `h-${++n}`, ts: new Date().toISOString(), hostSeq: n, sessionId: 's', tmuxPane: '%1', payload: { session_id: 'c', cwd: '/tmp/x', hook_event_name: 'Stop', last_assistant_message: 'Paused here.' } as any });
  const toMia = () => eng.core.messages.filter((m) => m.toEmployeeId === mia.id && /stopped/.test(m.body));
  const toOwner = () => eng.core.notifications.filter((x) => x.taskId === task.id && /stopped/.test(x.title));
  return { eng, task, stop, toMia, toOwner };
}

test("the nudges spent, the manager whose work it is is told, once", () => {
  const o = office('employee:Mia');
  o.stop(); // nudged (1/1 on Standard)
  assert.equal(o.toMia().length, 0);
  o.stop(); // stops again: told
  assert.equal(o.toMia().length, 1);
  assert.match(o.toMia()[0]!.body, /Alex stopped working on T-\d+ "Cart badge" without finishing/);
  assert.equal(o.toOwner().length, 0);
  o.stop();
  assert.equal(o.toMia().length, 1, 'once');
});

test('no manager: the owner is told, once', () => {
  const o = office('owner');
  o.stop();
  o.stop();
  o.stop();
  assert.equal(o.toOwner().length, 1);
});
