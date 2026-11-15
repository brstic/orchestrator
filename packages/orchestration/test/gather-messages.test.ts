/**
 * A project can have what its employees write to each other gathered for a while (`ProjectPolicy.gatherSec`), so that
 * an idle colleague is woken once for several notes and not once for each: a wake is a whole turn of their model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherSecOf, type Employee, type Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, nextToType, type AgentLink } from '../src/index.ts';

const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

async function office(gatherSec?: number) {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const shop = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false, ...(gatherSec === undefined ? {} : { gatherSec }) } });
  const [alex, sarah] = (['Alex', 'Sarah'] as const).map((name) => eng.employees.create({ name, roleKey: 'backend', projectId: shop.id, hostId: host.id, workingDir: '/tmp/x' })) as [Employee, Employee];
  const fromAlex = { kind: 'employee' as const, id: alex.id, name: 'Alex' };
  return { eng, shop, alex, sarah, fromAlex, held: () => eng.comms.queued(sarah.id).map((d) => (d.holdUntil ? Math.round((d.holdUntil - Date.now()) / 1000) : 0)) };
}

test('nothing is gathered unless the project chose it', async () => {
  const o = await office();
  assert.equal(gatherSecOf(o.shop), 0);
  o.eng.comms.sendMessage({ from: o.fromAlex, toEmployeeId: o.sarah.id, body: 'The seed data is in.' });
  assert.deepEqual(o.held(), [0]);
});

test('in a project that gathers: a message and a comment from a colleague wait; a person, the office and a waited request do not', async () => {
  const o = await office(60);
  o.eng.comms.sendMessage({ from: o.fromAlex, toEmployeeId: o.sarah.id, body: 'The seed data is in.' });
  o.eng.comms.sendMessage({ from: o.fromAlex, toEmployeeId: o.sarah.id, body: 'See my note on the ticket.', kind: 'comment' });
  assert.deepEqual(o.held(), [60, 60]);
  o.eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'The boss' }, toEmployeeId: o.sarah.id, body: 'Stop and look at production.' });
  o.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: o.sarah.id, body: 'Your review is closed.', kind: 'system' });
  o.eng.comms.sendMessage({ from: o.fromAlex, toEmployeeId: o.sarah.id, body: 'Please review.', kind: 'review_request' });
  o.eng.comms.requestCollaboration(o.alex, o.sarah, 'Which port?', 'I cannot go on without it.', { waited: true });
  assert.deepEqual(o.held(), [60, 60, 0, 0, 0, 0]);
});

test('what is typed next into an idle session: the first that is not being gathered, or nothing until one is due', () => {
  const now = 1_000_000;
  assert.equal(nextToType([], now), null);
  assert.deepEqual(nextToType([{ holdUntil: now + 40_000 }, { holdUntil: now + 55_000 }], now), { waitMs: 40_000 });
  assert.deepEqual(nextToType([{ holdUntil: now + 40_000 }, {}], now), { index: 1 }, 'something else is ready: it goes, and the gathered ride behind it');
  assert.deepEqual(nextToType([{ holdUntil: now - 1 }, { holdUntil: now + 5000 }], now), { index: 0 }, 'the time is up');
});

test('the number is checked where a project is saved', async () => {
  const o = await office();
  assert.throws(() => o.eng.tasks.updateProject(o.shop.id, { policy: { gatherSec: 9999 } }), /policy\.gatherSec/);
  assert.throws(() => o.eng.tasks.updateProject(o.shop.id, { policy: { gatherSec: 1.5 } }), /policy\.gatherSec/);
  o.eng.tasks.updateProject(o.shop.id, { policy: { gatherSec: 120 } });
  assert.equal(gatherSecOf(o.eng.core.projects.require(o.shop.id)), 120);
  o.eng.tasks.updateProject(o.shop.id, { policy: { gatherSec: null } });
  assert.equal(gatherSecOf(o.eng.core.projects.require(o.shop.id)), 0);
});
