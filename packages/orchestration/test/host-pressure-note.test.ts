import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A busy machine holds back new work there, and says so in the feed; the owner's Inbox is told only when it holds
 * something back — sessions running there, or work waiting to start there. (On the live office the owner's own Mac,
 * busy with other things, put 14 lines a week in their Inbox with no employee on it.)
 */
process.env.ORCH_RESOURCE_PRESSURE_MS = '1';
const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'mac', name: 'my Mac', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const busy = async (sessions: number) => {
    const r = { ts: new Date().toISOString(), cpuPercent: 100, loadAvg1: 9, memUsedBytes: 1, memTotalBytes: 10, sessionCount: sessions } as any;
    eng.hosts.resources('mac', r);
    await new Promise((res) => setTimeout(res, 5));
    eng.hosts.resources('mac', { ...r, ts: new Date().toISOString() });
  };
  const notes = () => eng.core.notifications.filter((n) => n.kind === 'host_resources');
  const events = () => eng.core.store.queryEvents({ types: ['host.resource_warning'], limit: 10 });
  return { eng, busy, notes, events };
}

test('busy with nothing of the office on it: in the feed, not in the Inbox', async () => {
  const o = office();
  await o.busy(0);
  assert.equal(o.events().length, 1);
  assert.equal(o.notes().length, 0);
});

test('busy with a session running there: the Inbox is told, in plain words', async () => {
  const o = office();
  await o.busy(1);
  assert.equal(o.notes().length, 1);
  assert.match(o.notes()[0]!.body, /the 1 session already running there is left alone/);
});
