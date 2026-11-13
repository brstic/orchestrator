/**
 * Connecting a Claude account without leaving the office: the owner signs in from the Claude tab (the machine runs
 * Claude Code's own sign-in in a terminal of its own; the office shows it and passes on what is typed), an account
 * is known by who is signed in to it from the moment its machine is in the office, and an account of another
 * service (Z.AI's GLM Coding Plan) is a folder whose own settings hold the address and the key.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mayCall } from '../../apps/server/src/access.ts';

// A home folder of its own for this file: the "machine's" Claude logins live in it.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-home-')));
process.env.HOME = home;
const { createHarness, waitFor, sleep } = await import('./harness.ts');
type Harness = Awaited<ReturnType<typeof createHarness>>;

const inAnHour = Math.floor(Date.now() / 1000) + 3600;
const limits = (dir: string, five: number) => fs.writeFileSync(path.join(dir, 'fake-limits.json'), JSON.stringify({ five_hour: { used_percentage: five, resets_at: inAnHour }, seven_day: { used_percentage: 10, resets_at: inAnHour + 86400 } }));
const KEY = 'zai-test-key-0123456789abcdef';

let h: Harness;
const ids: Record<string, string> = {};
const usage = () => h.api<any[]>('GET', '/usage');
const account = async (dir: string | null) => (await usage()).find((r) => r.hostId === h.hostId && r.configDir === dir);
const login = (dir: string | null) => h.api<any>('GET', `/hosts/${h.hostId}/accounts/login${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
const host = async () => (await h.state()).hosts.find((x) => x.id === h.hostId)!;

before(async () => {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'first@example.test', organizationName: 'Org' } }));
  limits(home, 20);
  h = await createHarness({ timings: { accountFailoverMs: 400 } });
  const repo = h.makeRepo('shop');
  ids.project = (await h.project('Shop', repo)).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId: ids.project, autonomy: 'auto' })).id;
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('an account is known by who is signed in to it as soon as its machine is in the office — before any session has run', async () => {
  const row = await waitFor(async () => { const a = await account(null); return a?.email ? a : null; }, { label: 'the default login has its name', timeout: 15000 });
  assert.deepEqual([row.email, row.organization, row.provider, row.loggedIn, row.reportedAt], ['first@example.test', 'Org', 'anthropic', true, null]);
  assert.equal((await h.state()).sessions.length, 0, 'nobody was started for it');
});

test('a new Claude account is signed in to from the office: a link to open, a code to paste, and it is ready', async () => {
  const started = await h.api<any>('POST', `/hosts/${h.hostId}/accounts/login`, { fresh: true });
  // The office chose the folder, made it and put it on the machine's list.
  assert.equal(started.dir, '~/.claude-2');
  assert.deepEqual((await host()).claudeAccounts, ['~/.claude-2']);
  const dir = path.join(home, '.claude-2');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(path.join(home, '.claude', 'projects')));
  // Its terminal shows the address of the sign-in page — whole, in one line — and waits for the code.
  const shown = await waitFor(async () => { const l = await login('~/.claude-2'); return l.lines.some((x: string) => /Paste code here/.test(x)) ? l : null; }, { label: 'the sign-in asks for the code', timeout: 20000 });
  assert.equal(shown.running, true);
  assert.equal(shown.account.loggedIn, false);
  const link = shown.lines.find((x: string) => x.startsWith('https://claude.ai/oauth/authorize'));
  assert.match(link ?? '', /state=S{180}$/, 'the address is not cut by the width of the terminal');
  // A code the page did not give is refused there, and the sign-in goes on.
  await h.api('POST', `/hosts/${h.hostId}/accounts/login/input`, { dir: '~/.claude-2', text: 'wrong', key: 'enter' });
  await waitFor(async () => (await login('~/.claude-2')).lines.some((x: string) => /Invalid code/.test(x)), { label: 'refused', timeout: 10000 });
  assert.equal((await account('~/.claude-2')).loggedIn, false);
  // The code from the page: signed in.
  await h.api('POST', `/hosts/${h.hostId}/accounts/login/input`, { dir: '~/.claude-2', text: 'second', key: 'enter' });
  const done = await waitFor(async () => { const l = await login('~/.claude-2'); return l.account.loggedIn && !l.running ? l : null; }, { label: 'signed in', timeout: 15000 });
  assert.deepEqual([done.account.email, done.account.organization, done.account.provider], ['second@example.test', 'Signed In Org', 'anthropic']);
  const row = await account('~/.claude-2');
  assert.deepEqual([row.email, row.loggedIn, row.employeeIds], ['second@example.test', true, []]);
  // Put away: nothing of it is left running, and asking again shows nothing.
  await h.api('DELETE', `/hosts/${h.hostId}/accounts/login?dir=${encodeURIComponent('~/.claude-2')}`);
  assert.deepEqual([(await login('~/.claude-2')).running, (await login('~/.claude-2')).lines], [false, []]);
  // It never was a session of the office.
  assert.equal((await h.state()).sessions.length, 0);
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.action === 'account.login_started' && a.detail.dir === '~/.claude-2'));
  assert.ok(!JSON.stringify(audit).includes('second#') && !JSON.stringify(await h.api('GET', '/events?limit=400')).includes('Paste code'), 'what was typed and shown is not on the record');
});

test('the machine\'s own login is signed in to again the same way; only an owner may', async () => {
  const started = await h.api<any>('POST', `/hosts/${h.hostId}/accounts/login`, {});
  assert.equal(started.dir, null);
  await waitFor(async () => (await login(null)).lines.some((x: string) => /Paste code here/.test(x)), { label: 'asks for the code', timeout: 20000 });
  await h.api('POST', `/hosts/${h.hostId}/accounts/login/input`, { text: 'boss', key: 'enter' });
  await waitFor(async () => (await account(null))?.email === 'boss@example.test', { label: 'the default login is somebody else now', timeout: 15000 });
  assert.deepEqual((await host()).claudeAccounts, ['~/.claude-2'], 'the default login is not an added account');
  await h.api('DELETE', `/hosts/${h.hostId}/accounts/login`);
  for (const role of ['colleague', 'visitor'] as const) {
    for (const [m, p] of [['POST', `/hosts/${h.hostId}/accounts/login`], ['GET', `/hosts/${h.hostId}/accounts/login`], ['POST', `/hosts/${h.hostId}/accounts/login/input`], ['DELETE', `/hosts/${h.hostId}/accounts/login`], ['POST', `/hosts/${h.hostId}/accounts/provider`]] as const) {
      assert.equal(mayCall(h.server.engine, { kind: 'guest', id: 'm1', name: 'M', role }, m, p, null).ok, false, `${role} ${m} ${p}`);
    }
  }
  for (const bad of ['../etc', '/etc/claude', '~/$(id)']) assert.equal((await h.apiRaw('POST', `/hosts/${h.hostId}/accounts/login`, { dir: bad })).status, 400, bad);
});

test('a Z.AI account: the key is written into the account\'s own folder on the machine, and is nowhere in the office', async () => {
  const made = await h.api<any>('POST', `/hosts/${h.hostId}/accounts/provider`, { provider: 'zai', token: KEY });
  assert.deepEqual([made.dir, made.provider, made.endpoint, made.loggedIn, made.email], ['~/.claude-zai', 'zai', 'api.z.ai', true, null]);
  const dir = path.join(home, '.claude-zai');
  const file = path.join(dir, 'settings.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).env, { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: KEY, API_TIMEOUT_MS: '3000000' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).hasCompletedOnboarding, true, 'the first session does not stop at the first-run screens');
  assert.deepEqual((await host()).claudeAccounts, ['~/.claude-2', '~/.claude-zai']);
  const row = await account('~/.claude-zai');
  assert.deepEqual([row.provider, row.endpoint, row.loggedIn, row.email], ['zai', 'api.z.ai', true, null]);
  // The key: on that machine, in that file — not in what the office says, keeps or records.
  for (const [what, value] of [['usage', await usage()], ['state', await h.state()], ['audit', await h.api('GET', '/audit')], ['events', await h.api('GET', '/events?limit=400')], ['the answer', made]] as const) assert.ok(!JSON.stringify(value).includes(KEY), `the key is not in ${what}`);
  assert.ok((await h.api<any[]>('GET', '/audit')).some((a) => a.action === 'account.added' && a.detail.dir === '~/.claude-zai' && a.detail.provider === 'zai'));
  // Saying which models, later: what else was in the folder's settings stays.
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...settings, theme: 'dark', env: { ...settings.env, MY_OWN: '1' } }));
  await h.api('POST', `/hosts/${h.hostId}/accounts/provider`, { provider: 'zai', dir: '~/.claude-zai', token: KEY, models: { opus: 'glm-big', sonnet: '', haiku: 'glm-small' } });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([after.theme, after.env.MY_OWN, after.env.ANTHROPIC_DEFAULT_OPUS_MODEL, after.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, after.env.ANTHROPIC_DEFAULT_SONNET_MODEL], ['dark', '1', 'glm-big', 'glm-small', undefined]);
  assert.equal((await host()).claudeAccounts!.length, 2, 'twice is once');
  for (const bad of [{ provider: 'zai', token: '' }, { provider: 'zai', token: 'two words' }, { provider: 'custom', token: KEY, baseUrl: 'http://plain.example.test' }, { provider: 'zai', token: KEY, dir: '../etc' }]) assert.equal((await h.apiRaw('POST', `/hosts/${h.hostId}/accounts/provider`, bad)).status, 400, JSON.stringify(bad).replace(KEY, '…'));
});

test('an employee put on the Z.AI account runs with that folder; nobody is moved to it or off it by the office', async () => {
  // Alex works on the default login, which then runs out. The only other account with room is Z.AI's: Alex stays.
  // (The second Claude account would take him; it is taken off the list first, so that only Z.AI is left.)
  await h.api('DELETE', `/hosts/${h.hostId}/accounts?dir=${encodeURIComponent('~/.claude-2')}`);
  limits(home, 100);
  await h.task({ projectId: ids.project, title: 'Alex reports', assigneeId: ids.Alex, description: '@@fake: write a.txt a; commit a; complete done@@' });
  await waitFor(async () => (await account(null))?.exhausted === true, { label: 'the default login is known to be used up', timeout: 30000 });
  await sleep(2000); // several looks of the office
  assert.equal((await h.state()).employees.find((e) => e.id === ids.Alex)!.claudeConfigDir ?? null, null);
  assert.equal((await h.api<any[]>('GET', '/events?limit=400')).filter((e) => e.type === 'account.switched').length, 0);
  // Put there by a person, he runs on it.
  await waitFor(async () => (await h.session(ids.Alex!))?.inTurn === false, { label: 'Alex is between turns', timeout: 30000 });
  await h.api('PATCH', `/employees/${ids.Alex}`, { claudeConfigDir: '~/.claude-zai' });
  await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.status === 'running' && s.claudeConfigDir === '~/.claude-zai' ? s : null; }, { label: 'started again on the Z.AI account', timeout: 30000 });
  const s = (await h.session(ids.Alex!))!;
  assert.match(h.started().split('\n').filter((l) => l.startsWith(s.tmuxSession!)).pop() ?? '', new RegExp(`CLAUDE_CONFIG_DIR=${home}/\\.claude-zai`));
  assert.deepEqual((await account('~/.claude-zai')).employeeIds, [ids.Alex]);
});

test('somebody is hired straight onto an account: the hire names it, beside the model and the effort', async () => {
  const zed = await h.api<any>('POST', '/employees', { name: 'Zed', roleKey: 'backend', hostId: h.hostId, projectId: ids.project, autonomy: 'auto', model: 'sonnet', effort: 'low', claudeConfigDir: '~/.claude-zai/' });
  assert.deepEqual([zed.claudeConfigDir, zed.model, zed.effort], ['~/.claude-zai', 'sonnet', 'low']);
  assert.ok((await account('~/.claude-zai')).employeeIds.includes(zed.id));
  // Not named: the machine's default login, as before.
  const ivy = await h.api<any>('POST', '/employees', { name: 'Ivy', roleKey: 'backend', hostId: h.hostId, projectId: ids.project });
  assert.equal(ivy.claudeConfigDir ?? null, null);
  for (const bad of ['../etc', '~/x/../../y', '$(id)']) assert.equal((await h.apiRaw('POST', '/employees', { name: `Bad ${bad.length}`, roleKey: 'backend', hostId: h.hostId, claudeConfigDir: bad })).status, 400, bad);
});
