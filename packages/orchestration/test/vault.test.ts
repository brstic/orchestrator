import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSecrets, nameFor, serviceWord, uniqueName } from '../src/vault-detect.ts';
import { Vault } from '../src/vault.ts';

const found = (text: string) => detectSecrets(text).map((f) => [f.pattern, f.value, f.service, f.username]);

test('credentials are found by their format: provider tokens, private keys, passwords inside addresses', () => {
  const gh = `ghp_${'a1B2'.repeat(9)}`;
  assert.deepEqual(found(`use ${gh} to push`), [['github_token', gh, 'github', '']]);
  assert.deepEqual(found('ANTHROPIC key: sk-ant-api03-abcdefghijklmnopqrstuvwx'), [['anthropic_key', 'sk-ant-api03-abcdefghijklmnopqrstuvwx', 'anthropic', '']]);
  assert.deepEqual(found('clone https://deploy:Tr0ub4dor&3x@git.example.net/shop.git'), [['url_password', 'Tr0ub4dor&3x', 'git.example.net', 'deploy']]);
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
  assert.deepEqual(detectSecrets(`here:\n${pem}\ndone`).map((f) => [f.kind, f.value]), [['ssh_key', pem]]);
  assert.deepEqual(found('curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://api.example.com/x')[0]!.slice(0, 2), ['bearer', 'abcdefghijklmnop1234567890']);
});

test('…and by what the text says: fields and sentences, in English and Serbian, with the login and the site nearby', () => {
  assert.deepEqual(found('DB_PASSWORD=Sup3r$ecretValue'), [['field', 'Sup3r$ecretValue', '', '']]);
  assert.deepEqual(found('"api_key": "9f8e7d6c5b4a39281706f5e4"'), [['field', '9f8e7d6c5b4a39281706f5e4', '', '']]);
  assert.deepEqual(found('lozinka za git.example.net je Abc123!xyz, user branko'), [['natural', 'Abc123!xyz', 'git.example.net', 'branko']]);
  assert.deepEqual(found('Log in at https://panel.example.com as admin; the password is Winter2026!ok.'), [['natural', 'Winter2026!ok', 'panel.example.com', '']]);
  assert.equal(detectSecrets('user deploy, password: Xk9#mmQ2pL')[0]!.username, 'deploy');
});

test('what only looks like one is left alone: code, placeholders, plain words, sentences about passwords', () => {
  for (const text of [
    'const token = process.env.API_TOKEN;',
    'API_KEY=$GITHUB_TOKEN',
    'password: <your-password-here>',
    'set SECRET_KEY=${SECRET_KEY}',
    'token = getToken(user)',
    'The password reset flow needs a token refresh endpoint.',
    'the password is strong enough already',
    'lozinka je jaka',
    'Password reset flow',
    'api_key: changeme',
    'It is already stored as {{vault:github-token}}, use that.',
    'password={{vault:shop-db-password}}',
  ]) assert.deepEqual(detectSecrets(text), [], text);
});

test('names say what a credential opens, and two never share one', () => {
  assert.equal(serviceWord('git.example.net'), 'example');
  assert.equal(serviceWord('api.cloudflare.com'), 'cloudflare');
  assert.equal(nameFor({ kind: 'token', service: 'github', username: '' }), 'github-token');
  assert.equal(nameFor({ kind: 'password', service: 'git.example.net', username: 'branko' }), 'example-branko-password');
  assert.equal(nameFor({ kind: 'password', service: '', username: '' }, ['Shop']), 'shop-password');
  assert.equal(nameFor({ kind: 'password', service: '', username: '' }), 'password');
  const taken = new Set(['github-token']);
  assert.equal(uniqueName('github-token', taken, ['github', 'deploy']), 'github-token-deploy');
  assert.equal(uniqueName('github-token', new Set(['github-token', 'github-token-deploy']), ['deploy']), 'github-token-2');
});

/** The least of the engine a vault needs. */
function fakeCore() {
  const kv = new Map<string, unknown>();
  const audit: Array<[string, string, string, any]> = [];
  const events: any[] = [];
  return {
    kv,
    audit,
    events,
    core: {
      store: { kvGet: <T>(k: string, fallback: T): T => (kv.has(k) ? (JSON.parse(JSON.stringify(kv.get(k))) as T) : fallback), kvSet: (k: string, v: unknown) => void kv.set(k, JSON.parse(JSON.stringify(v))) },
      bus: { emit: () => true },
      log: () => undefined,
      audit: (actor: string, action: string, target: string, detail: any) => void audit.push([actor, action, target, detail]),
      event: (e: any) => void events.push(e),
    } as any,
  };
}
const boss = { kind: 'owner' as const, id: null, name: 'Boss' };
const alex = { kind: 'employee' as const, id: 'e-alex', name: 'Alex' };

test('a value is stored encrypted, comes back only through use, and what the office keeps and says never holds it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vault-'));
  const keyFile = path.join(dir, 'vault.key');
  const f = fakeCore();
  const vault = new Vault(f.core, keyFile);
  const secret = 'Tr0ub4dor&3-horse-battery';
  const { entry, created } = vault.put({ name: 'Shop DB admin', value: secret, service: 'db.shop.example', username: 'admin' }, boss, 'added');
  assert.deepEqual([created, entry.name, entry.kind, entry.length, entry.uses], [true, 'shop-db-admin', 'password', secret.length, 0]);
  assert.equal((fs.statSync(keyFile).mode & 0o777).toString(8), '600', 'the key file is the owner\'s alone');
  const everything = JSON.stringify([[...f.kv.entries()], f.audit, f.events, vault.list()]);
  assert.ok(!everything.includes(secret), 'not in the store, the audit log, the events or the list');
  assert.ok(!('secret' in vault.list()[0]!) && !('fingerprint' in vault.list()[0]!));

  // The same value again is the same credential; another value under a taken name gets a name of its own.
  assert.deepEqual([vault.put({ name: 'other', value: secret }, alex, 'stored').created, vault.size], [false, 1]);
  assert.equal(vault.put({ name: 'shop-db-admin', value: 'another-One-9', service: 'staging' }, alex, 'stored').entry.name, 'shop-db-admin-staging');

  const used = vault.use('shop-db-admin', alex);
  assert.equal(used.value, secret);
  assert.deepEqual([used.entry.uses, used.entry.lastUsedBy?.name], [1, 'Alex']);
  assert.equal(vault.use('{{vault:shop-db-admin}}', alex).value, secret, 'asked for the way a message names it');
  assert.ok(f.audit.some(([actor, action, , detail]) => actor === 'employee:Alex' && action === 'vault.used' && detail.name === 'shop-db-admin'));
  assert.throws(() => vault.use('nothing-like-it', alex), /nothing called "nothing-like-it" in the vault/);

  // A new office process with the same key file reads it; with another key it says so instead of returning rubbish.
  assert.equal(new Vault(f.core, keyFile).use('shop-db-admin', boss, 'revealed').value, secret);
  assert.ok(f.audit.some(([actor, action]) => actor === 'owner' && action === 'vault.revealed'));
  fs.writeFileSync(keyFile, `${Buffer.alloc(32, 7).toString('base64')}\n`);
  assert.throws(() => new Vault(f.core, keyFile).use('shop-db-admin', boss), /cannot be read: the vault's key is not the one it was stored with/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a credential written into a message is taken out of it: the message goes on with its name', () => {
  const f = fakeCore();
  const vault = new Vault(f.core, null);
  const gh = `ghp_${'Z9y8'.repeat(9)}`;
  const first = vault.capture(`Push with ${gh}; the db password is Winter2026!ok. Thanks`, boss, ['Alex']);
  assert.equal(first.text, 'Push with {{vault:github-token}}; the db password is {{vault:alex-password}}. Thanks');
  assert.deepEqual(first.names, ['github-token', 'alex-password']);
  assert.deepEqual(vault.list().map((e) => [e.name, e.kind, e.source]), [['alex-password', 'password', 'captured'], ['github-token', 'token', 'captured']]);
  // The same token in a later message gets the name it already has; nothing new is stored.
  assert.equal(vault.capture(`again: ${gh}`, alex).text, 'again: {{vault:github-token}}');
  assert.equal(vault.size, 2);
  // A message that only names a credential is left as it is.
  assert.deepEqual(vault.capture('use {{vault:github-token}} for the push', boss), { text: 'use {{vault:github-token}} for the push', names: [] });
  assert.deepEqual(vault.mentioned('use {{vault:github-token}} and {{vault:not-there}}'), ['github-token']);
});

test('what goes through a session is kept only when its format cannot be mistaken', () => {
  const f = fakeCore();
  const vault = new Vault(f.core, null);
  const names = vault.noticed(`AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\nDB_PASSWORD=Sup3r$ecretValue\nthe password is Winter2026!ok`, alex, ['Shop']);
  assert.deepEqual(names, ['aws-api-key']);
  assert.deepEqual(vault.list().map((e) => [e.name, e.source, e.createdBy.name]), [['aws-api-key', 'noticed', 'Alex']]);
  assert.deepEqual(vault.noticed('AKIAABCDEFGHIJKLMNOP again', alex), [], 'seen before: nothing new');
});

test('credentials that already stand in old tasks, messages and questions are moved to the vault when the office starts', () => {
  const f = fakeCore();
  const saved: Array<[string, any]> = [];
  const tasks = [
    { id: 't1', projectId: 'p1', description: 'clone everything from git.example.net, username branko sifra Winter2026!ok', acceptance: '', evidence: { summary: 'Cloned. The password was not stored in any .git/config.' } },
    { id: 't2', projectId: 'p1', description: 'Add the health endpoint', acceptance: 'GET /healthz answers 200', evidence: { summary: null } },
  ];
  const messages = [{ id: 'm1', toEmployeeId: 'e1', body: `push with ghp_${'k4K4'.repeat(9)} please` }, { id: 'm2', toEmployeeId: 'e1', body: 'good morning' }];
  const questions = [{ id: 'q1', employeeId: 'e1', text: 'Which database?', context: '', answer: 'the staging one, password: Autumn2026!db' }];
  Object.assign(f.core, {
    tasks: { all: () => tasks },
    messages: { all: () => messages },
    questions: { all: () => questions },
    projects: { get: () => ({ name: 'Shop' }) },
    employees: { get: () => ({ name: 'Alex' }) },
    put: (kind: string, e: any) => void saved.push([kind, e.id]),
  });
  const vault = new Vault(f.core, null);
  assert.equal(vault.sweep(), 3);
  assert.equal(tasks[0]!.description, 'clone everything from git.example.net, username branko sifra {{vault:branko-password}}');
  assert.equal(messages[0]!.body, 'push with {{vault:github-token}} please');
  assert.equal(questions[0]!.answer, 'the staging one, password: {{vault:alex-password}}');
  // Only the records in which something was found are written back.
  assert.deepEqual(saved, [['task', 't1'], ['message', 'm1'], ['question', 'q1']]);
  assert.deepEqual(vault.list().map((e) => [e.name, e.source, e.createdBy.kind]), [['alex-password', 'captured', 'office'], ['branko-password', 'captured', 'office'], ['github-token', 'captured', 'office']]);
  assert.equal(vault.use('branko-password', { kind: 'owner', id: null, name: 'Boss' }, 'revealed').value, 'Winter2026!ok');
  // A second start finds nothing left to move.
  saved.length = 0;
  assert.equal(vault.sweep(), 0);
  assert.deepEqual(saved, []);
});

test('a value is taken whole: a password with an @ in an address, a quoted value, a line of an env file', () => {
  // The password runs to the last @ before the host; its tail is not read as the host (which is shown to everybody).
  assert.deepEqual(found('postgres://admin:Pa55@word!@db.example.net:5432/shop'), [['url_password', 'Pa55@word!', 'db.example.net', 'admin']]);
  assert.deepEqual(found('https://deploy:Tr0ub4dor&3@git.example.net/x.git'), [['url_password', 'Tr0ub4dor&3', 'git.example.net', 'deploy']]);
  // In quotes: everything between them.
  assert.deepEqual(found('"db_password": "Secr3t Pass;w0rd"').map((f) => f[1]), ['Secr3t Pass;w0rd']);
  // A line of an env file: the rest of the line.
  assert.deepEqual(found('PORT=5432\nDB_PASSWORD=Secr3tPass;w0rd\nNAME=shop').map((f) => f[1]), ['Secr3tPass;w0rd']);
  assert.deepEqual(found('export API_TOKEN=abc123DEF456,ghi789&more').map((f) => f[1]), ['abc123DEF456,ghi789&more']);
});

test('"pass" and "pin" name a credential only when the sentence says so', () => {
  assert.deepEqual(found('make the suite pass Node22.18 tests before merging'), []);
  assert.deepEqual(found('pin React18.3.1 in package.json'), []);
  assert.deepEqual(found('the pass is Jaka123!x for the staging site').map((f) => f[1]), ['Jaka123!x']);
  assert.deepEqual(found('pin: 4821Abc!').map((f) => f[1]), ['4821Abc!']);
  assert.deepEqual(found('lozinka za git.example.net je Abc123!x').map((f) => f[1]), ['Abc123!x'], 'the other words are as before');
});
