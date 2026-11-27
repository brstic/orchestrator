import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * Claude Code refused to continue a conversation it no longer has, in the middle of a task, after the session had
 * already ended twice: the office starts it again in a new conversation — and the owner was told, in red, that it
 * "is not started again by itself; restart it to resume the same conversation" (seen 2026-11-24: it was up a second
 * later, and resuming that conversation could never have worked).
 */
test('a refused resume is said as what happens: a new conversation, started by the office', () => {
  const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const ops = eng.employees.create({ name: 'Ops', roleKey: 'devops', hostId: 'h', workingDir: '/tmp/o' });
  const now = new Date().toISOString();
  const s = eng.core.put('session', { id: 's', employeeId: ops.id, hostId: 'h', origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-ops', tmuxPane: '%1', cwd: '/tmp/o', repoRoot: null, branch: null, claudeSessionId: 'c', status: 'running', activity: 'idle', activityDetail: null, activitySince: now, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: null, model: null, cols: 120, rows: 34, pid: 1, usage: null, startedAt: now, endedAt: null, lastEventAt: now, exitReason: null } as AgentSession);
  const shop = eng.core.put('project', { id: 'p', name: 'Shop', description: '', goals: '', requirements: '', docs: '', hostId: 'h', repoPath: '/tmp/o', baseBranch: 'main', integrationBranch: 'main', workspace: 'single', ownerEmployeeId: null, verifyCommand: null, verifyTimeoutSec: 0, extraRepos: [], dependsOn: [], color: '#fff', status: 'active', policy: { allow: [], deny: [], highRiskPatterns: [], autoAssign: false, requireReview: false, autoMerge: true }, milestones: [], deliveredAt: null, createdAt: now } as never) as { id: string };
  const t = eng.tasks.createTask({ title: 'Pull production', description: 'x', released: false, projectId: shop.id }, 'owner');
  eng.core.put('task', { ...eng.core.tasks.require(t.id), assigneeId: ops.id, status: 'IN_PROGRESS' } as Task);
  const reg = eng.sessions as any;
  reg.restartedFor.set(ops.id, [Date.now() - 60_000, Date.now() - 30_000]);
  reg.resumeProbes.set(s.id, now);
  reg.sessionDied(s, ops, 'process exited with status 1: No conversation found with session ID: c');
  const n = eng.core.notifications.filter((x) => x.kind === 'session_lost').at(-1)!;
  assert.doesNotMatch(n.body, /not started again by itself|resume the same conversation/);
  assert.match(n.body, /new conversation/);
  assert.equal(n.severity, 'warning');
});
