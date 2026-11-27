import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A project with no check of its own gets one by itself (the owner, 2026-11-27: "yes, when it is clear" — of 133 pieces
 * of work in two weeks the office had tested none): its own read-only check script, the first that passes when tried,
 * types before lint before tests; said in the feed. Not one that fails; not over one already set; not on a member's
 * own computer; tried again at most once a week.
 */
function office(results: Record<string, number>, candidates: Array<{ command: string; kind: string }>) {
  const ran: string[] = [];
  const link: AgentLink = {
    rpc: async (_h, rpc) => {
      const p = (rpc as any).params;
      if (rpc.method === 'repo.checks') return { candidates: candidates.map((c) => ({ ...c, why: 'x' })) } as any;
      if (rpc.method === 'fs.inspect') return { exists: true, isDirectory: true, isGitRepo: true, hasCommits: true, branch: 'main', repoRoot: p.path } as any;
      if (rpc.method === 'verify.run') {
        ran.push(p.command);
        return { exitCode: results[p.command] ?? 1, timedOut: false, durationMs: 10, outputTail: '' } as any;
      }
      return { ok: true } as any;
    },
    isOnline: () => true,
    respondHook: () => true,
    disconnect: () => undefined,
  };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  return { eng, ran };
}

test('the first of its own checks that passes, types first, is set — and said', async () => {
  const o = office({ 'npm run -s typecheck': 0, 'npm run -s lint': 0 }, [{ command: 'npm test --silent', kind: 'tests' }, { command: 'npm run -s lint', kind: 'lint' }, { command: 'npm run -s typecheck', kind: 'types' }]);
  const p = await o.eng.tasks.createProject({ name: 'Shop', hostId: 'h', repoPath: '/tmp/shop' } as any);
  const set = await o.eng.tasks.adoptCheck(p.id);
  assert.equal(set, 'npm run -s typecheck');
  assert.equal(o.eng.core.projects.require(p.id).verifyCommand, 'npm run -s typecheck');
  assert.deepEqual(o.ran, ['npm run -s typecheck']);
  assert.ok(o.eng.core.store.queryEvents({ types: ['project.check_adopted'], limit: 5 }).length === 1);
  // Not again over one that is set.
  assert.equal(await o.eng.tasks.adoptCheck(p.id), null);
  // A person takes it away: it is not set again by itself.
  o.eng.tasks.updateProject(p.id, { verifyCommand: null }, 'owner');
  assert.equal(o.eng.core.projects.require(p.id).policy.adoptCheck, false);
  o.eng.core.store.kvSet(`check.adopt.tried.${p.id}`, 0);
  assert.equal(await o.eng.tasks.adoptCheck(p.id), null);
});

test('none passes: nothing is set, and it is not tried again within the week', async () => {
  const o = office({}, [{ command: 'npm run -s typecheck', kind: 'types' }]);
  const p = await o.eng.tasks.createProject({ name: 'Shop', hostId: 'h', repoPath: '/tmp/shop' } as any);
  assert.equal(await o.eng.tasks.adoptCheck(p.id), null);
  assert.equal(o.eng.core.projects.require(p.id).verifyCommand, null);
  await o.eng.tasks.adoptCheck(p.id);
  assert.equal(o.ran.length, 1, 'once a week');
});
