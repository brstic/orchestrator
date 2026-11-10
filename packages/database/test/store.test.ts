import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, generateToken, hashToken } from '../src/index.ts';

test('documents, events, credentials and audit persist across reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-db-'));
  const file = path.join(dir, 'test.db');
  let store = new Store(file);
  store.col<{ id: string; name: string }>('thing').put({ id: 'a', name: 'first' });
  store.col<{ id: string; name: string }>('thing').put({ id: 'a', name: 'updated' });
  store.col<{ id: string; name: string }>('thing').put({ id: 'b', name: 'second' });
  store.col('thing').delete('b');
  const ev = { id: 'evt-1', type: 'task.created' as const, source: { kind: 'server' as const }, correlationId: null, hostId: null, sessionId: null, employeeId: 'e1', taskId: 't1', projectId: null, summary: 'created with token ghp_abcdefghijklmnopqrstuvwxyz0123456789', data: { apiKey: 'zzz' } };
  const stored = store.appendEvent(ev);
  assert.ok(stored && stored.seq > 0);
  assert.equal(store.appendEvent(ev), null, 'same event id is ignored (idempotent)');
  assert.equal(stored!.summary, 'created with token [REDACTED]');
  assert.deepEqual(stored!.data, { apiKey: '[REDACTED]' });
  assert.equal(store.markProcessed('hook:1'), true);
  assert.equal(store.markProcessed('hook:1'), false);
  const token = generateToken('orch_host');
  store.addCredential('host', token, { refId: 'h1' });
  store.audit('owner', 'test.action', 'target', { password: 'x', note: 'ok' });
  assert.equal(store.nextCounter('task'), 1);
  assert.equal(store.nextCounter('task'), 2);
  store.close();

  // The database file never contains the plaintext credential.
  const raw = Buffer.concat([fs.readFileSync(file), fs.existsSync(file + '-wal') ? fs.readFileSync(file + '-wal') : Buffer.alloc(0)]).toString('latin1');
  assert.ok(!raw.includes(token), 'token is stored only as a hash');
  assert.ok(raw.includes(hashToken(token)));
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'database is owner-only');

  store = new Store(file);
  assert.deepEqual(store.col('thing').all(), [{ id: 'a', name: 'updated' }]);
  assert.equal(store.queryEvents({ taskId: 't1' }).length, 1);
  assert.equal(store.queryEvents({ employeeId: 'nobody' }).length, 0);
  assert.equal(store.checkCredential('host', token)?.refId, 'h1');
  assert.equal(store.checkCredential('owner', token), null, 'a credential is only valid for its own kind');
  assert.equal(store.checkCredential('host', token + 'x'), null);
  store.revokeCredentialsFor('host', 'h1');
  assert.equal(store.checkCredential('host', token), null, 'revocation is immediate');
  assert.deepEqual(store.recentAudit()[0]!.detail, { password: '[REDACTED]', note: 'ok' });
  assert.equal(store.nextCounter('task'), 3);
  const expired = generateToken('orch_enroll');
  store.addCredential('enrollment', expired, { ttlMs: -1000 });
  assert.equal(store.checkCredential('enrollment', expired), null, 'expired tokens are refused');
  store.close();
  store.close();
  assert.equal(store.appendEvent({ ...ev, id: 'late' }), null, 'writes after close are ignored, not thrown');
  fs.rmSync(dir, { recursive: true, force: true });
});
