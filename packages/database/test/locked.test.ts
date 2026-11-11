import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/index.ts';

/**
 * An office that is restarted starts while the one before it is still closing its database. Seen on the server on
 * 2026-11-11: "error: database is locked", the service failed and was started again five seconds later.
 *
 * What is tested here is the part that could be reproduced: the first statements at opening (switching the file to
 * WAL) ran before the wait for a lock was set, so they failed at once when another process held the file. The other
 * half of the cure is in `scripts/start-local.mjs`: the launcher now leaves only when the old server has ended.
 */
test('opening the database waits for a process that still holds it, instead of failing with "database is locked"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-db-'));
  const file = path.join(dir, 'orchestrator.db');
  try {
    // Another process has the file to itself for a second and a half (a database not yet in WAL: every statement of
    // the newcomer needs the lock the holder has).
    const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec('CREATE TABLE IF NOT EXISTS held (x)');
      db.exec('BEGIN EXCLUSIVE');
      console.log('held');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 1500);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => resolve());
      holder.once('error', reject);
    });
    const began = Date.now();
    const store = new Store(file);
    const waited = Date.now() - began;
    store.kvSet('still', 'works');
    assert.equal(store.kvGet('still', null), 'works');
    store.close();
    assert.ok(waited >= 1000, `it waited for the other process (${waited} ms)`);
    await new Promise((r) => (holder.exitCode === null ? holder.once('exit', r) : r(null)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
