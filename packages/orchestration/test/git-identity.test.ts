import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A commit needs an author. Where the folder and the machine say nobody (no user.email), git refused it — "Author
 * identity unknown", 13 times by 9 employees in a month, and 35 commands a week wrote `-c user.name=…` around it. The
 * session is started with git's own fallback (EMAIL), which a configured identity still overrides.
 */
test("a session carries git's fallback address, the employee's own", async () => {
  const specs: any[] = [];
  const link: AgentLink = {
    rpc: async (_h, rpc) => {
      const p = (rpc as any).params;
      if (rpc.method !== 'session.create') return { ok: true } as any;
      specs.push(p.spec);
      return { sessionId: p.sessionId, launchId: p.spec.launchId, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'orch-x', tmuxPane: '%1', cwd: p.spec.cwd, repoRoot: null, branch: null, pid: 1, alive: true, command: 'claude', cols: 120, rows: 34, claudeSessionId: p.spec.claudeSessionId, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: p.spec.permissionMode, model: null, startedAt: new Date().toISOString(), exitReason: null } as any;
    },
    isOnline: () => true,
    respondHook: () => true,
    disconnect: () => undefined,
  };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const e = eng.employees.create({ name: 'Xagio Plugin', roleKey: 'backend', hostId: 'h', workingDir: '/tmp/x' });
  await eng.sessions.start(e.id, {});
  assert.equal(specs.at(-1)?.env?.EMAIL, 'xagio-plugin@orchestrator.local');
  assert.equal(specs.at(-1)?.env?.GIT_AUTHOR_NAME, undefined, 'a configured identity is not overridden');
});
