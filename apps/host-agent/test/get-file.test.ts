import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostAgent } from '../src/agent.ts';
import { defaultConfig } from '../src/config.ts';

/**
 * What the machine's agent hands to the office as "a file an employee attached". On a member's own computer the
 * office is somebody else's machine, so the request itself is not trusted: not the working folder it names, either.
 * (Outside every temporary folder on purpose — those are allowed anyway.)
 */
const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.cache', `orch-getfile-${process.pid}`);
const home = path.join(here, 'agent-home');
const work = path.join(here, 'work');
const elsewhere = path.join(here, 'elsewhere');
fs.mkdirSync(path.join(work, 'src'), { recursive: true });
fs.mkdirSync(elsewhere, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(work, 'shot.png'), 'png');
fs.writeFileSync(path.join(work, '.env'), 'TOKEN=x');
fs.writeFileSync(path.join(work, 'id_ed25519_work'), 'key');
fs.writeFileSync(path.join(work, 'aws-credentials.txt'), 'key');
fs.writeFileSync(path.join(elsewhere, 'notes.txt'), 'other');
const agent = new HostAgent({ ...defaultConfig(), serverUrl: 'http://127.0.0.1:9', name: 'test', allowedRoots: [work] }, home, () => undefined);
const get = (file: string, cwd: string | null) => (agent as unknown as { getFile: (p: { path: string; cwd: string | null; sessionId: null; offset: number; length: number }) => { name: string } }).getFile({ path: file, cwd, sessionId: null, offset: 0, length: 100 });

test('a file is taken from inside the working folder, by a name that is not a key\'s', () => {
  assert.equal(get('shot.png', work).name, 'shot.png');
  assert.equal(get(path.join(work, 'shot.png'), work).name, 'shot.png');
  assert.throws(() => get('.env', work), /hidden file/);
  assert.throws(() => get('id_ed25519_work', work), /looks like a key or a credential/);
  assert.throws(() => get('aws-credentials.txt', work), /looks like a key or a credential/);
  assert.throws(() => get(work, work), /is not a file/);
});

test('the working folder the office names is not believed: it must be a folder, and one this machine allows', () => {
  // "The folder is this very file" used to leave nothing below it to check.
  assert.throws(() => get(path.join(work, '.env'), path.join(work, '.env')), /cannot be attached from there|hidden file/);
  // A folder outside what this machine lets the office work in is no working folder.
  assert.throws(() => get(path.join(elsewhere, 'notes.txt'), elsewhere), /cannot be attached from there/);
  assert.throws(() => get('notes.txt', elsewhere), /cannot be attached from there/);
  // Nor is a parent of the allowed folder.
  assert.throws(() => get(path.join(elsewhere, 'notes.txt'), here), /cannot be attached from there/);
});

test.after(() => fs.rmSync(here, { recursive: true, force: true }));
void os;
