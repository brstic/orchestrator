/**
 * The vault, end to end: a real server, a real host agent, real tmux sessions, a scripted worker.
 *
 *   kept     a credential is stored encrypted; nothing the office keeps, lists or broadcasts holds its value
 *   used     an employee's command takes it out by name through the helper in its session: the value reaches the
 *            command, not the conversation, the terminal or the records
 *   moved    a credential the boss writes into a message is taken out of the message before it is delivered
 *   stored   an employee puts in what it was given or made — through the tool, or straight from a pipe
 *   noticed  a key in a well-known format that goes through a session is kept by itself
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let alex = '';
let cwd = '';
const TOKEN = `ghp_${'q7W3'.repeat(9)}`;

const events = (query: string) => h.api<any[]>('GET', `/events?limit=1500&${query}`);
const atPrompt = () =>
  waitFor(async () => {
    const s = await h.session(alex);
    return s?.status === 'running' && s.inTurn === false ? s : null;
  }, { label: 'Alex at the prompt', timeout: 40000 });
/** Tell Alex something and wait for the turn to end; a permission request on the way is allowed, as an owner at the keyboard would. */
const tell = async (body: string, said: RegExp) => {
  await atPrompt();
  await h.api('POST', `/employees/${alex}/message`, { body });
  await waitFor(async () => {
    const q = await h.openQuestion(alex, 'permission');
    if (q) await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' }).catch(() => undefined);
    return (await events(`employeeId=${alex}`)).some((e) => e.type === 'agent.turn_finished' && said.test(e.data.lastMessage ?? '')) ? true : null;
  }, { label: `turn that says ${said}`, timeout: 40000 });
};
const pane = async () => h.tmux('capture-pane', '-p', '-J', '-S', '-800', '-t', (await h.session(alex))!.tmuxPane!);
const vault = async () => (await h.api<{ entries: any[] }>('GET', '/vault')).entries;
/** Everything the office would send a window or keep on record, as text. */
const everything = async () => JSON.stringify([await h.state(), await events(''), await h.api('GET', '/audit?limit=500'), await vault()]);

before(async () => {
  h = await createHarness();
  const project = await h.project('Shop', h.makeRepo('shop'));
  alex = (await h.employee('Alex', 'backend', { projectId: project.id, autonomy: 'autonomous' })).id;
  await h.api('POST', `/employees/${alex}/start`, {});
  cwd = (await atPrompt()).cwd;
});
after(async () => {
  await h?.cleanup();
});

test('a credential is kept by name: the list, the state and the records never carry its value; an owner can look at it', async () => {
  const made = await h.api<any>('POST', '/vault', { service: 'github.com', kind: 'token', value: TOKEN, username: 'deploy', description: 'Pushes to the shop repository' });
  assert.deepEqual([made.created, made.entry.name, made.entry.kind, made.entry.source, made.entry.length], [true, 'github-deploy-token', 'token', 'added', TOKEN.length]);
  assert.ok(!JSON.stringify(made).includes(TOKEN), 'not even in the answer to adding it');
  assert.ok(!(await everything()).includes(TOKEN));
  // The key is a file of the server's alone, next to its database; the database holds no readable value.
  const dataDir = path.join(h.tmp, 'server');
  assert.equal((fs.statSync(path.join(dataDir, 'vault.key')).mode & 0o777).toString(8), '600');
  for (const f of fs.readdirSync(dataDir).filter((x) => x.startsWith('orchestrator.db'))) assert.ok(!fs.readFileSync(path.join(dataDir, f)).includes(TOKEN), `${f} holds the value in the clear`);
  const shown = await h.api<any>('POST', `/vault/${made.entry.id}/reveal`, {});
  assert.deepEqual([shown.name, shown.value], ['github-deploy-token', TOKEN]);
  assert.ok((await h.api<any[]>('GET', '/audit?limit=50')).some((a) => a.action === 'vault.revealed' && a.detail.name === 'github-deploy-token'), 'that somebody looked is on the record');
  assert.equal((await h.apiRaw('POST', '/vault', { name: 'empty', value: '   ' })).status, 400);
});

test('an employee uses it by name inside a command: the value reaches the command and nothing else', async () => {
  await tell('Push it. @@fake: bash "$ORCH_VAULT" get github-deploy-token > got.txt; say used-the-token@@', /used-the-token/);
  assert.equal(fs.readFileSync(path.join(cwd, 'got.txt'), 'utf8'), TOKEN, 'exactly the value, nothing around it');
  assert.ok(!(await pane()).includes(TOKEN), 'not on the terminal');
  assert.ok(!(await everything()).includes(TOKEN), 'not in the office\'s records');
  const entry = (await vault()).find((e) => e.name === 'github-deploy-token');
  assert.deepEqual([entry.uses, entry.lastUsedBy.name], [2, 'Alex'], 'the owner looked once, Alex used it once');
  assert.ok((await h.api<any[]>('GET', '/audit?limit=50')).some((a) => a.actor === 'employee:Alex' && a.action === 'vault.used' && a.detail.name === 'github-deploy-token'));
  // What is there, by name; and a name that is not there fails in words, with nothing printed.
  await tell('What do we have? @@fake: mcp vault_list {}; result list.txt; bash "$ORCH_VAULT" get no-such-thing > none.txt 2> err.txt || true; say listed@@', /listed/);
  const list = fs.readFileSync(path.join(cwd, 'list.txt'), 'utf8');
  assert.match(list, /- github-deploy-token \(token\) · github\.com · login deploy — Pushes to the shop repository/);
  assert.ok(!list.includes(TOKEN));
  assert.deepEqual([fs.readFileSync(path.join(cwd, 'none.txt'), 'utf8'), fs.readFileSync(path.join(cwd, 'err.txt'), 'utf8').trim()], ['', 'vault: there is nothing called "no-such-thing" in the vault']);
});

test('a password the boss writes in a message is moved to the vault: the employee is handed its name', async () => {
  await tell('Log in to staging as admin, the password is Winter2026!ok and report back. @@fake: say on-it@@', /on-it/);
  const prompts = (await events(`employeeId=${alex}`)).filter((e) => e.type === 'agent.prompt_submitted').map((e) => String(e.data.prompt ?? ''));
  const delivered = prompts.find((p) => /Log in to staging/.test(p))!;
  assert.match(delivered, /the password is \{\{vault:alex-password\}\} and report back/);
  assert.ok(!(await pane()).includes('Winter2026!ok'), 'the value never reached the terminal');
  assert.ok(!(await everything()).includes('Winter2026!ok'));
  const entry = (await vault()).find((e) => e.name === 'alex-password');
  assert.deepEqual([entry.kind, entry.source, entry.createdBy.kind], ['password', 'captured', 'owner']);
  // …and the employee can use it under that name.
  await tell('Go on. @@fake: bash "$ORCH_VAULT" get alex-password > pw.txt; say logged-in@@', /logged-in/);
  assert.equal(fs.readFileSync(path.join(cwd, 'pw.txt'), 'utf8'), 'Winter2026!ok');
  // A task is read the same way.
  const t = await h.task({ projectId: (await h.state()).projects[0]!.id, title: 'Rotate the key', released: false, description: 'The old one is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234, replace it.' });
  assert.equal((await h.getTask(t.id)).description, 'The old one is {{vault:anthropic-api-key}}, replace it.');
});

test('an employee puts in what it was given or made: through the tool, and straight from a pipe', async () => {
  await tell('Keep these. @@fake: mcp vault_store {"name":"Shop webhook","value":"whk-5f4e3d2c1b0a","service":"shop","description":"Signs the shop webhooks"}; result stored.txt; bash openssl rand -hex 12 | "$ORCH_VAULT" put shop-session-key --service shop --kind api_key > put.txt; say kept@@', /kept/);
  assert.match(fs.readFileSync(path.join(cwd, 'stored.txt'), 'utf8'), /^Stored as "shop-webhook"\. From now on write \{\{vault:shop-webhook\}\}/);
  assert.equal(fs.readFileSync(path.join(cwd, 'put.txt'), 'utf8').trim(), 'Stored as "shop-session-key".');
  const entries = await vault();
  const piped = entries.find((e) => e.name === 'shop-session-key');
  assert.deepEqual([piped.kind, piped.source, piped.createdBy.name, piped.service], ['api_key', 'stored', 'Alex', 'shop']);
  // What the command made went from the pipe to the vault: it was never typed, printed or read by anyone.
  const made = (await h.api<any>('POST', `/vault/${piped.id}/reveal`, {})).value as string;
  assert.match(made, /^[0-9a-f]{24}$/);
  assert.equal((await h.api<any>('POST', `/vault/${entries.find((e) => e.name === 'shop-webhook').id}/reveal`, {})).value, 'whk-5f4e3d2c1b0a');
  assert.ok((await events(`employeeId=${alex}`)).some((e) => e.type === 'vault.stored' && e.summary === 'Alex put "shop-session-key" in the vault'));
  assert.ok(!(await everything()).includes(made) && !(await pane()).includes(made));
});

test('a key in a well-known format that goes through a session is kept, and the owner is told where', async () => {
  const aws = 'AKIAQWERTYUIOPASDFGH';
  fs.writeFileSync(path.join(cwd, 'old.env'), `AWS_ACCESS_KEY_ID=${aws}\nREGION=eu-central-1\n`);
  await tell('Read the old settings. @@fake: read old.env; say read-it@@', /read-it/);
  const entry = await waitFor(async () => (await vault()).find((e) => e.source === 'noticed') ?? null, { label: 'the key kept' });
  assert.deepEqual([entry.name, entry.kind, entry.createdBy.name], ['aws-api-key', 'api_key', 'Alex']);
  assert.equal((await h.api<any>('POST', `/vault/${entry.id}/reveal`, {})).value, aws);
  const note = (await h.state()).notifications.find((n) => /looks like a secret/.test(n.title));
  assert.match(note!.body, /It was put in the vault as "aws-api-key"\./);
  assert.ok(!(await everything()).includes(aws));
});

test('removed by an owner, it can no longer be used', async () => {
  const entry = (await vault()).find((e) => e.name === 'github-deploy-token');
  await h.api('DELETE', `/vault/${entry.id}`);
  assert.equal((await vault()).some((e) => e.name === 'github-deploy-token'), false);
  await tell('Try again. @@fake: bash "$ORCH_VAULT" get github-deploy-token > gone.txt 2> gone-err.txt || true; say tried@@', /tried/);
  assert.deepEqual([fs.readFileSync(path.join(cwd, 'gone.txt'), 'utf8'), fs.readFileSync(path.join(cwd, 'gone-err.txt'), 'utf8').trim()], ['', 'vault: there is nothing called "github-deploy-token" in the vault']);
  // What is in the vault outlives a restart of the office.
  await h.restartServer();
  const after = await vault();
  assert.ok(after.some((e) => e.name === 'alex-password'));
  assert.equal((await h.api<any>('POST', `/vault/${after.find((e) => e.name === 'alex-password').id}/reveal`, {})).value, 'Winter2026!ok');
});
