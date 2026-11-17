import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * Seen on the live office: "Host … is offline", a critical alarm, was raised 86 times in a week — almost every one for a
 * machine that was back within seconds (the office restarting, a deploy, a connection that dropped and came back).
 * Each stayed in the Inbox after its machine was back. A machine that is gone for a while is still an alarm.
 */
const link: AgentLink = {
  rpc: async (_host, rpc) => {
    const p = (rpc as any).params;
    if (rpc.method === 'session.create') return { sessionId: p.sessionId, launchId: p.spec.launchId, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-x', tmuxPane: '%1', cwd: p.spec.cwd, repoRoot: null, branch: null, pid: 1, alive: true, command: 'claude', cols: 120, rows: 34, claudeSessionId: p.spec.claudeSessionId, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: p.spec.permissionMode, model: null, startedAt: new Date().toISOString(), exitReason: null } as any;
    return { ok: true } as any;
  },
  isOnline: () => true,
  respondHook: () => false,
  disconnect: () => undefined,
};
const GRACE = 60;
let eng: Engine;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alarms = () => eng.core.notifications.filter((n) => n.kind === 'host_disconnected');

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { hostOfflineGraceMs: GRACE } }, { send: () => undefined });
  const host: Host = { id: 'box', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop = (await eng.tasks.createProject({ name: 'Shop' })).id;
  const ava = eng.employees.create({ name: 'Ava', roleKey: 'backend', projectId: shop, hostId: 'box', workingDir: '/tmp/ava' });
  await eng.sessions.start(ava.id);
});

test('a machine back within the grace raises no alarm; one that stays away does, once, and it is resolved when it is back', async () => {
  const info = { hostname: 'box', platform: 'linux', claudeVersion: '2', tmuxVersion: '3' } as any;
  eng.hosts.disconnected('box');
  await sleep(GRACE / 3);
  eng.hosts.connected('box', info);
  await sleep(GRACE * 2);
  assert.equal(alarms().length, 0, 'back in time: no alarm');

  // (Back, the machine reports its sessions again: running.)
  for (const s of eng.core.sessions.filter((x) => x.hostId === 'box')) eng.core.put('session', { ...s, status: 'running' });
  eng.hosts.disconnected('box');
  await sleep(GRACE * 2);
  assert.equal(alarms().length, 1, 'away for longer: the alarm');
  assert.match(alarms()[0]!.title, /Host "box" is offline/);
  assert.equal(alarms()[0]!.resolvedAt, null);
  eng.hosts.connected('box', info);
  assert.ok(alarms()[0]!.resolvedAt, 'resolved when it is back');
});
