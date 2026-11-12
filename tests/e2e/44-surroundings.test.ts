/**
 * Where the office stands (`OwnerSettings.surroundings`): the office's own, kept by the server. An owner chooses it,
 * everybody in the office is given it, nobody else can change it, and it is still there after a restart.
 * What each place looks like is the 3D package's (`packages/office-3d/test/surroundings.test.ts`, `tests/ui/surroundings.mjs`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SURROUNDINGS, type AuditEntry } from '@orchestrator/contracts';
import { mayCall } from '../../apps/server/src/access.ts';
import { createHarness, type Harness } from './harness.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.cleanup();
});

test('an office that was never moved stands by itself; an owner moves it, and the choice is the office\'s', async () => {
  assert.equal((await h.state()).settings.surroundings, undefined, 'nothing is chosen for an office: it is as it always was');
  for (const kind of SURROUNDINGS) {
    const saved = await h.api<any>('PATCH', '/settings', { surroundings: kind });
    assert.equal(saved.surroundings, kind);
    assert.equal((await h.state()).settings.surroundings, kind, 'what every window of the office is given');
  }
  await h.api('PATCH', '/settings', { surroundings: 'island' });
  // A place the office does not know changes nothing — whatever was sent.
  for (const other of ['moon', '', null, 7, { kind: 'park' }, ['park']]) {
    const res = await h.apiRaw('PATCH', '/settings', { surroundings: other });
    assert.equal(res.status, 200, JSON.stringify(other));
    assert.equal((await h.state()).settings.surroundings, 'island', `after ${JSON.stringify(other)}`);
  }
  // Other settings are not disturbed by it, nor it by them.
  const before = (await h.state()).settings;
  await h.api('PATCH', '/settings', { companyName: 'Northwind' });
  const now = (await h.state()).settings;
  assert.equal(now.surroundings, 'island');
  assert.deepEqual({ ...now, companyName: before.companyName }, before);
  // On the record, as every change an owner makes to the office is.
  const audit = await h.api<AuditEntry[]>('GET', '/audit?limit=200');
  assert.ok(audit.some((a) => a.action === 'settings.changed' && (a.detail as any)?.changed?.includes('surroundings')), 'the change is in the audit log');
});

test('only an owner moves the office: a colleague and a visitor are shown the place and cannot change it', async () => {
  const engine = h.server.engine;
  // A member who is an owner (not the office's own computer, which the first test is).
  const owner = { kind: 'owner' as const, id: 'o1', name: 'O', role: 'owner' as const };
  const colleague = { kind: 'guest' as const, id: 'c1', name: 'C', role: 'colleague' as const };
  const visitor = { kind: 'guest' as const, id: 'v1', name: 'V', role: 'visitor' as const };
  assert.equal(mayCall(engine, owner, 'PATCH', '/settings', { surroundings: 'park' }).ok, true);
  for (const who of [colleague, visitor]) assert.equal(mayCall(engine, who, 'PATCH', '/settings', { surroundings: 'park' }).ok, false, who.role);
  assert.equal((await fetch(`${h.url}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ surroundings: 'park' }) })).status, 401, 'never without saying who asks');
  assert.equal((await h.state()).settings.surroundings, 'island');
});

test('the place is kept by the office, not by a window: it is there after a restart', async () => {
  await h.api('PATCH', '/settings', { surroundings: 'north' });
  await h.restartServer();
  assert.equal((await h.state()).settings.surroundings, 'north');
  // And back to the plain office, which is a choice like any other.
  await h.api('PATCH', '/settings', { surroundings: 'studio' });
  await h.restartServer();
  assert.equal((await h.state()).settings.surroundings, 'studio');
});
