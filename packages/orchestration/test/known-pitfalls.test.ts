import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * A known pitfall several employees fell into becomes a lesson for the whole office, by itself: `pkill -f` whose pattern
 * is also in the shell's own command line kills that shell (exit code 144) — 15 times in a week, five employees, on the
 * live office, each finding it out alone.
 */
test('a pitfall two employees fell into is taught to everybody, once', () => {
  const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  eng.core.updateSettings({ selfImprovement: { ...eng.core.settings.selfImprovement, autoApproveSharedLessons: true } });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const a = eng.employees.create({ name: 'Ana', roleKey: 'backend', hostId: 'h', workingDir: '/tmp/a' });
  const b = eng.employees.create({ name: 'Bo', roleKey: 'frontend', hostId: 'h', workingDir: '/tmp/b' });
  const failed = (who: string, command: string, error: string) => eng.core.event({ type: 'agent.tool_failed', source: 'hook', summary: 'x', employeeId: who, data: { tool: 'Bash', input: { command }, error } });
  const pitfall = () => eng.core.lessons.filter((l) => l.scope === 'company' && /pkill -f/.test(l.text));
  failed(a.id, 'pkill -f "php -S 127.0.0.1:8791"; php -S 127.0.0.1:8791 &', 'Exit code 144');
  eng.improver.analyze();
  assert.equal(pitfall().length, 0, 'one employee once: not yet');
  failed(b.id, 'pkill -f "node server/index.js" ; cd web && npm run dev', 'Exit code 144');
  failed(b.id, 'pkill -f "vite"', 'Exit code 1'); // not this pitfall
  eng.improver.analyze();
  assert.equal(pitfall().length, 1);
  assert.equal(pitfall()[0]!.status, 'active');
  assert.match(pitfall()[0]!.text, /\[p\]attern|\$!/);
  eng.improver.analyze();
  assert.equal(pitfall().length, 1, 'once');
});
