import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host, Improvement, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * Suggestions about a situation that the record no longer shows a few days on are taken back undecided (the live
 * office, 2026-11-23: "nothing to do while the backlog waits" and the like stood in "Waiting for you" for a week).
 */
const link: AgentLink = { rpc: () => Promise.reject(new Error('nothing runs here')), isOnline: () => false, respondHook: () => false, disconnect: () => undefined };
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('a suggestion about a situation that no longer shows is taken back; one that still holds, a rule, or a fresh one stays', async () => {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: ago(0), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop = (await eng.tasks.createProject({ name: 'Shop' })).id;
  // Shop's code is still finished with nothing to check it against: what the verification advice says still holds.
  for (let i = 0; i < 3; i++) {
    const t = eng.tasks.createTask({ projectId: shop, title: `Change ${i}`, description: 'x', released: false }, 'owner');
    eng.core.put('task', { ...eng.core.tasks.require(t.id), status: 'DONE', evidence: { ...t.evidence, commits: [{ sha: `a${i}`, subject: 's', author: 'a', ts: ago(DAY) }], verification: null } } as Task);
  }
  const imp = (key: string, kind: Improvement['kind'], days: number): Improvement =>
    eng.core.put('improvement', { id: key.slice(0, 8), kind, title: `About ${key}`, rationale: 'r', evidence: [], projectId: shop, employeeId: null, action: { type: 'advice' }, status: 'proposed', dedupeKey: key, createdAt: ago(days * DAY), decidedAt: null } as Improvement);
  imp('idle:gone', 'idle_capacity', 4);
  imp(`verify:${shop}`, 'verify_command', 5);
  imp('allow:old', 'allow_rule', 9);
  imp('stall:fresh', 'stall', 1);
  eng.improver.analyze();
  const get = (key: string) => eng.core.improvements.filter((i) => i.dedupeKey === key)[0]!;
  assert.equal(get('idle:gone').status, 'dismissed');
  assert.match(get('idle:gone').withdrawn ?? '', /no longer shows/);
  assert.equal(get(`verify:${shop}`).status, 'proposed', 'it still holds: found again');
  assert.equal(get('allow:old').status, 'proposed', 'a rule waits for somebody to decide');
  assert.equal(get('stall:fresh').status, 'proposed', 'too fresh to take back');
});
