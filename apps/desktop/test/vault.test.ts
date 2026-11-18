import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byService, commandFor, kindCounts, matches, origin, placeholderFor, usedLine, type VaultEntry } from '../src/lib/vault.ts';

const entry = (over: Partial<VaultEntry>): VaultEntry => ({
  id: over.name ?? 'x',
  name: 'x',
  kind: 'password',
  service: '',
  username: '',
  description: '',
  source: 'added',
  createdAt: '2026-11-18T10:00:00.000Z',
  createdBy: { kind: 'owner', name: 'Vera' },
  uses: 0,
  lastUsedAt: null,
  lastUsedBy: null,
  length: 12,
  ...over,
});

test('the boxes stand on shelves by what they open, in order, and what opens nothing named comes last', () => {
  const rows = [entry({ name: 'gh-token', service: 'github.com' }), entry({ name: 'misc' }), entry({ name: 'aws-key', service: 'AWS' }), entry({ name: 'gh-deploy', service: 'GitHub.com' })];
  assert.deepEqual(
    byService(rows).map((g) => [g.label, g.rows.map((r) => r.name)]),
    [
      ['AWS', ['aws-key']],
      ['github.com', ['gh-deploy', 'gh-token']],
      ['Other', ['misc']],
    ],
  );
});

test('finding: every word typed must be somewhere in it — the name, what it opens, the login, the note or the kind', () => {
  const e = entry({
    name: 'shop-db-admin',
    service: 'db.shop.example',
    username: 'admin',
    description: 'Production database',
    kind: 'password',
  });
  assert.ok(matches(e, ''));
  assert.ok(matches(e, 'shop admin'));
  assert.ok(matches(e, 'PRODUCTION passwords'));
  assert.ok(!matches(e, 'shop token'));
});

test('the words a box says: how it got here, how it was used, and how an employee asks for it', () => {
  assert.equal(origin(entry({ source: 'captured', createdBy: { kind: 'office', name: 'x' } })), 'taken out of a message from the office');
  assert.equal(origin(entry({ source: 'stored', createdBy: { kind: 'employee', name: 'Ava' } })), 'stored by Ava');
  assert.equal(usedLine(entry({})), 'Not used yet');
  assert.equal(
    usedLine(
      entry({
        uses: 1,
        lastUsedAt: '2026-11-18T10:00:00.000Z',
        lastUsedBy: { kind: 'employee', name: 'Ava' },
      }),
      () => '2h ago',
    ),
    'Used once, last by Ava 2h ago',
  );
  assert.equal(
    usedLine(entry({ uses: 4 }), () => ''),
    'Used 4 times',
  );
  assert.equal(placeholderFor('ci-token'), '{{vault:ci-token}}');
  assert.equal(commandFor('ci-token'), '$("$ORCH_VAULT" get ci-token)');
  assert.deepEqual(kindCounts([entry({ kind: 'token' }), entry({ kind: 'password' }), entry({ kind: 'token' })]), [
    { kind: 'password', n: 1 },
    { kind: 'token', n: 2 },
  ]);
});
