import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PgStore, generateToken, hashToken } from '../src/index.ts';
import { startPostgres, type TestPostgres } from '../../../tests/e2e/pg-helper.ts';

let pg: TestPostgres | null = null;
before(async () => {
  pg = await startPostgres();
});
after(() => pg?.stop());

const event = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'task.created' as const, source: { kind: 'server' as const }, correlationId: null, hostId: null, sessionId: null, employeeId: 'e1', taskId: 't1', projectId: null, summary: `event ${id}`, data: {}, ...over });

test('PostgreSQL store: same contract as SQLite, durable across reopen', async (t) => {
  if (!pg) return t.skip('PostgreSQL binaries (initdb, pg_ctl) are not installed');
  let store = await PgStore.open(pg.url);
  assert.match(store.file, /^postgres:\/\/orch@127\.0\.0\.1/);
  const things = store.col<{ id: string; name: string; n?: number }>('thing');
  things.put({ id: 'a', name: 'first' });
  things.put({ id: 'a', name: 'updated' });
  things.put({ id: 'b', name: 'second' });
  things.delete('b');
  // Reads are immediate (in-memory), before the database has caught up.
  assert.deepEqual(things.all(), [{ id: 'a', name: 'updated' }]);

  const stored = store.appendEvent(event('evt-1', { summary: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', data: { apiKey: 'zzz', nested: { password: 'p' } } }));
  assert.ok(stored && stored.seq === 1);
  assert.equal(store.appendEvent(event('evt-1')), null, 'duplicate event ids are ignored');
  assert.equal(stored!.summary, 'token [REDACTED]');
  assert.deepEqual(stored!.data, { apiKey: '[REDACTED]', nested: { password: '[REDACTED]' } });
  for (let i = 2; i <= 50; i++) store.appendEvent(event(`evt-${i}`, { employeeId: i % 2 ? 'e1' : 'e2', type: i % 5 ? 'task.created' : 'task.completed' }));
  assert.equal(store.queryEvents({ employeeId: 'e2' }).length, 25);
  assert.deepEqual(store.queryEvents({ types: ['task.completed'], limit: 3 }).map((e) => e.seq), [40, 45, 50], 'newest N, oldest first');
  assert.equal(store.queryEvents({ excludeTypes: ['task.created'] }).length, 10);
  assert.equal(store.queryEvents({ beforeSeq: 10 }).length, 9);

  assert.equal(store.markProcessed('hook:1'), true);
  assert.equal(store.markProcessed('hook:1'), false);
  assert.equal(store.nextCounter('task'), 1);
  assert.equal(store.nextCounter('task'), 2);
  store.kvSet('settings', { companyName: 'Acme', nested: { a: 1 } });
  const token = generateToken('orch_host');
  store.addCredential('host', token, { refId: 'h1', label: 'box' });
  const expired = generateToken('orch_enroll');
  store.addCredential('enrollment', expired, { ttlMs: -1000 });
  store.audit('owner', 'test.action', 'target', { password: 'x', note: 'ok' });

  await store.flush();
  assert.equal(store.pendingWrites, 0);
  // What is actually in PostgreSQL.
  assert.equal(pg.psql("SELECT data->>'name' FROM orch_docs WHERE kind = 'thing'"), 'updated');
  assert.equal(pg.psql('SELECT count(*) FROM orch_events'), '50');
  assert.equal(pg.psql("SELECT summary FROM orch_events WHERE id = 'evt-1'"), 'token [REDACTED]');
  assert.equal(pg.psql('SELECT hash FROM orch_credentials WHERE kind = \'host\''), hashToken(token), 'only the hash is stored');
  assert.equal(pg.psql(`SELECT count(*) FROM orch_credentials WHERE hash = '${token}' OR label = '${token}'`), '0');
  assert.equal(pg.psql("SELECT detail->>'password' FROM orch_audit"), '[REDACTED]');

  // A second server must not open the same database.
  await assert.rejects(PgStore.open(pg.url), /already using this database/);

  await store.close();
  assert.equal(store.appendEvent(event('late')), null, 'writes after close are ignored, not thrown');

  store = await PgStore.open(pg.url);
  assert.deepEqual(store.col('thing').all(), [{ id: 'a', name: 'updated' }]);
  assert.equal(store.queryEvents({ limit: 2000 }).length, 50);
  assert.equal(store.queryEvents({ taskId: 't1', limit: 1 })[0]!.seq, 50);
  assert.equal(store.appendEvent(event('evt-7')), null, 'idempotency survives a restart');
  assert.equal(store.appendEvent(event('evt-51'))!.seq, 51, 'sequence continues');
  assert.equal(store.markProcessed('hook:1'), false);
  assert.equal(store.nextCounter('task'), 3);
  assert.deepEqual(store.kvGet('settings', null), { companyName: 'Acme', nested: { a: 1 } });
  assert.equal(store.checkCredential('host', token)?.refId, 'h1');
  assert.equal(store.checkCredential('owner', token), null);
  assert.equal(store.checkCredential('enrollment', expired), null, 'expired tokens are refused');
  store.revokeCredentialsFor('host', 'h1');
  assert.equal(store.checkCredential('host', token), null, 'revocation is immediate');
  assert.deepEqual(store.recentAudit()[0]!.detail, { password: '[REDACTED]', note: 'ok' });
  await store.close();

  store = await PgStore.open(pg.url);
  assert.equal(store.checkCredential('host', token), null, 'revocation is durable');
  await store.close();
});

test('PostgreSQL store: thousands of writes keep their order', async (t) => {
  if (!pg) return t.skip('PostgreSQL binaries are not installed');
  const store = await PgStore.open(pg.url);
  const c = store.col<{ id: string; n: number }>('counter');
  for (let i = 1; i <= 3000; i++) c.put({ id: 'x', n: i });
  await store.flush();
  assert.equal(pg.psql("SELECT data->>'n' FROM orch_docs WHERE kind = 'counter' AND id = 'x'"), '3000', 'the last write wins in the database, as in memory');
  await store.close();
});
