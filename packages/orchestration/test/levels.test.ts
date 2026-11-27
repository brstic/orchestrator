import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTONOMY_LEVELS, ROLE_CATALOGUE, isAutonomyLevel, type Employee, type Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';
import { permissionsFor } from '../src/prompts.ts';

/**
 * How much an employee may do without asking is one of three levels — Standard, Auto, Unrestricted — and nothing
 * else (the owner's decision of 2026-11-13). Restricted, Supervised and Autonomous existed before; a record that
 * still names one is moved to Standard when the office starts, and nobody can be put on one again.
 */
const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
const office = (store = new Store(':memory:')) => {
  const eng = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0 } }, { send: () => undefined });
  eng.core.put('host', host);
  return eng;
};

test('there are three levels, and what each becomes in Claude Code', () => {
  assert.deepEqual([...AUTONOMY_LEVELS], ['standard', 'auto', 'unrestricted']);
  for (const gone of ['restricted', 'supervised', 'autonomous', '', null, undefined, 'Standard']) assert.equal(isAutonomyLevel(gone), false, String(gone));
  const eng = office();
  const alex = eng.employees.create({ name: 'Alex', roleKey: 'backend', hostId: host.id, workingDir: '/tmp/x' });
  const of = (level: string, version: string | null = '2.1.200') => permissionsFor(level as Employee['autonomy'], undefined, alex, version);
  assert.equal(of('standard').permissionMode, 'acceptEdits');
  assert.ok(of('standard').allow.includes('Bash(git commit:*)') && !of('standard').allow.includes('Bash(npm install:*)'));
  assert.equal(of('auto').permissionMode, 'auto');
  assert.equal(of('auto', '2.1.100').permissionMode, 'acceptEdits', 'a Claude Code without auto mode');
  assert.ok(of('auto').allow.includes('Bash(npm install:*)'));
  assert.deepEqual([of('unrestricted').permissionMode, of('unrestricted').allow], ['bypassPermissions', []]);
  // No level denies anything by itself: what an employee may not touch is their role's, their own or their project's.
  for (const level of AUTONOMY_LEVELS) assert.deepEqual(of(level).deny, [], level);
  // A record that names a level that is gone is never read as more than Standard.
  for (const gone of ['restricted', 'supervised', 'autonomous', 'anything']) assert.deepEqual(of(gone), of('standard'), gone);
});

test('whoever is hired without a level is on Standard, whatever their role; nobody can be put on a level that is gone', () => {
  const eng = office();
  for (const role of ROLE_CATALOGUE.filter((r) => r.key !== 'lead')) {
    const e = eng.employees.create({ name: `E ${role.key}`, roleKey: role.key, hostId: host.id, workingDir: '/tmp/x' });
    assert.equal(e.autonomy, 'standard', role.key);
  }
  // The role that hands work on cannot edit files at any level: that is the role's, not a level's.
  const lead = { ...eng.core.employees.all()[0]!, roleKey: 'lead', disallowedTools: ROLE_CATALOGUE.find((r) => r.key === 'lead')!.disallowedTools };
  assert.deepEqual(permissionsFor('unrestricted', undefined, lead, '2.1.200').deny, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const alex = eng.employees.create({ name: 'Alex', roleKey: 'backend', hostId: host.id, workingDir: '/tmp/x', autonomy: 'auto' });
  for (const gone of ['restricted', 'supervised', 'autonomous', 'everything']) {
    assert.throws(() => eng.employees.create({ name: `New ${gone}`, roleKey: 'backend', hostId: host.id, workingDir: '/tmp/x', autonomy: gone as any }), /is not a level: it is one of standard, auto, unrestricted/, gone);
    assert.throws(() => eng.employees.update(alex.id, { autonomy: gone as any }), /is not a level/, gone);
  }
  assert.equal(eng.core.employees.require(alex.id).autonomy, 'auto');
  assert.equal(eng.core.employees.find((e) => e.name.startsWith('New ')), undefined);
});

test('an office that starts with records from when there were six levels: those employees are on Standard, once, and it is on the record', () => {
  const store = new Store(':memory:');
  const before = office(store);
  const ids: Record<string, string> = {};
  for (const [name, level] of [['Rita', 'restricted'], ['Sam', 'supervised'], ['Otto', 'autonomous'], ['Ana', 'auto'], ['Uma', 'unrestricted'], ['Stan', 'standard']] as const) {
    const e = before.employees.create({ name, roleKey: 'backend', hostId: host.id, workingDir: '/tmp/x' });
    // Written the way an office before 2026-11-13 wrote it.
    before.core.put('employee', { ...e, autonomy: level as any });
    ids[name] = e.id;
  }
  // The office is started again on the same records (`Engine.start` does this before anything else reads a level).
  const eng = office(store);
  assert.equal(eng.sessions.adoptThreeLevels(), 3);
  const level = (name: string) => eng.core.employees.require(ids[name]!).autonomy;
  assert.deepEqual(['Rita', 'Sam', 'Otto', 'Ana', 'Stan'].map(level), ['standard', 'standard', 'standard', 'auto', 'standard']);
  assert.equal(level('Uma'), 'unrestricted');
  const moved = eng.core.store.recentAudit(40).filter((a) => a.action === 'autonomy.three_levels');
  assert.equal(moved.length, 1);
  assert.deepEqual((moved[0]!.detail as any).employees.sort(), ['Otto', 'Rita', 'Sam']);
  assert.equal(eng.sessions.adoptThreeLevels(), 0, 'nothing is left to move');
});
