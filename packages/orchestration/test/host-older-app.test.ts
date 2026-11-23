import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host, HostInfo } from '@orchestrator/contracts';
import { hostLacks } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A member's computer with an older app (the live office, 2026-11-23: two ran without the release gate and the central
 * context, and only the server's log said so): the owners are told once what it lacks, and the notice goes when it is
 * updated.
 */
const link: AgentLink = { rpc: () => Promise.reject(new Error('nothing runs here')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
const base: HostInfo = { hostname: 'ben', platform: 'darwin', arch: 'arm64', agentVersion: '0.1.0', tmuxVersion: null, claudeVersion: null, cpus: 8, totalMemBytes: 1, user: 'b' };
const now = new Date().toISOString();

test("an older machine's app: the owners are told once what it lacks; updated, the notice goes", () => {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'h-ben', name: 'Ben', status: 'offline', info: null, resources: null, enrolledAt: now, lastSeenAt: null, revokedAt: null, local: false, memberId: 'm-1', memberName: 'Fenix' } as Host;
  eng.core.put('host', host);
  const older: HostInfo = { ...base, saysHeldFor: true, rentFence: true, moves: true };
  assert.deepEqual(hostLacks(older), ['the release gate (and the central context)']);
  eng.hosts.connected('h-ben', older);
  eng.hosts.connected('h-ben', older);
  const open = () => eng.core.notifications.filter((n) => n.hostId === 'h-ben' && n.title === 'Ben runs an older Orchestrator' && !n.resolvedAt);
  assert.equal(open().length, 1, 'once, not at every connect');
  assert.match(open()[0]!.body, /release gate.*Fenix opens the new version/);
  assert.deepEqual(open()[0]!.for, ['#owners']);
  eng.hosts.connected('h-ben', { ...older, releaseGate: true });
  assert.equal(open().length, 0, 'updated: the notice goes');
  assert.deepEqual(hostLacks(null), [], 'nothing known: nothing said');
});
