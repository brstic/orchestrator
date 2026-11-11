/**
 * Several Claude accounts on one machine: the owner adds an account (the office makes its folder there and says how
 * to log in), and employees whose account has run out are put on another one that has room — by the figures of the
 * status line, by a turn Claude refused for the limit, or because the owner says so.
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
const inThreeDays = Math.floor(Date.now() / 1000) + 3 * 86400;
const limits = (dir: string, five: number, week = 10) => fs.writeFileSync(path.join(dir, 'fake-limits.json'), JSON.stringify({ five_hour: { used_percentage: five, resets_at: inAnHour }, seven_day: { used_percentage: week, resets_at: inThreeDays } }));
const logIn = (dir: string, email: string, five: number) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: 'Org' } }));
  limits(dir, five);
};
// A turn that lasts until it is cut off (a scripted pause cannot be interrupted in the middle, so many short ones).
const LONG = Array.from({ length: 150 }, () => 'sleep 200').join('; ');

let h: Harness;
const ids: Record<string, string> = {};
const usage = () => h.api<any[]>('GET', '/usage');
const employee = async (name: string) => (await h.state()).employees.find((e) => e.id === ids[name])!;
const account = async (dir: string | null) => (await usage()).find((r) => r.hostId === h.hostId && r.configDir === dir);
const switched = async () => (await h.api<any[]>('GET', '/events?limit=400')).filter((e) => e.type === 'account.switched');
const envOf = async (name: string) => {
  const s = await h.session(ids[name]!);
  return h.tmux('list-panes', '-a', '-F', '#{session_name} #{pane_start_command}').split('\n').find((l) => l.startsWith(s!.tmuxSession!)) ?? '';
};

before(async () => {
  logIn(home, 'first@example.test', 20);
  h = await createHarness({ timings: { accountFailoverMs: 400 } });
  const repo = h.makeRepo('shop');
  ids.project = (await h.project('Shop', repo)).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend'], ['Noor', 'qa']] as const) ids[name] = (await h.employee(name, role, { projectId: ids.project, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('an owner adds an account to a machine: the folder is made there, shares the conversations, and nobody is logged in yet', async () => {
  const added = await h.api('POST', `/hosts/${h.hostId}/accounts`, { dir: '~/.claude-2/' });
  assert.equal(added.dir, '~/.claude-2');
  assert.equal(added.loggedIn, false);
  assert.match(added.login, new RegExp(`^CLAUDE_CONFIG_DIR=${home}/\\.claude-2 `));
  const dir = path.join(home, '.claude-2');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  // The same conversations as the default account: a session moved here can go on with the one it had.
  assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(path.join(home, '.claude', 'projects')));
  const row = await account('~/.claude-2');
  assert.deepEqual([row.loggedIn, row.employeeIds, row.exhausted], [false, [], false]);
  assert.deepEqual((await h.state()).hosts.find((x) => x.id === h.hostId)!.claudeAccounts, ['~/.claude-2']);
  // Twice is once.
  await h.api('POST', `/hosts/${h.hostId}/accounts`, { dir: '~/.claude-2' });
  assert.equal((await h.state()).hosts.find((x) => x.id === h.hostId)!.claudeAccounts!.length, 1);
  for (const bad of ['../etc', '/etc/claude', '~/x/../../etc', '~/$(id)', '~/.claude', '']) {
    const res = await h.apiRaw('POST', `/hosts/${h.hostId}/accounts`, { dir: bad });
    assert.equal(res.status, 400, bad);
  }
  // Owners only: a colleague and a visitor may not add, check, move or remove accounts.
  for (const role of ['colleague', 'visitor'] as const) {
    for (const [m, p] of [['POST', `/hosts/${h.hostId}/accounts`], ['POST', `/hosts/${h.hostId}/accounts/check`], ['POST', `/hosts/${h.hostId}/accounts/move`], ['DELETE', `/hosts/${h.hostId}/accounts`]] as const) {
      assert.equal(mayCall(h.server.engine, { kind: 'guest', id: 'm1', name: 'M', role }, m, p, null).ok, false, `${role} ${m} ${p}`);
    }
  }
});

test('an account that has run out keeps its people while no other account has somebody logged in', async () => {
  limits(home, 100);
  await h.task({ projectId: ids.project, title: 'Alex reports', assigneeId: ids.Alex, description: '@@fake: write a.txt a; commit a; complete done@@' });
  await waitFor(async () => (await account(null))?.exhausted === true, { label: 'the default account is known to be used up', timeout: 30000 });
  ids.long = (await h.task({ projectId: ids.project, title: 'Alex long work', assigneeId: ids.Alex, description: `@@fake: ${LONG}; complete late@@` })).id;
  await waitFor(async () => (await h.getTask(ids.long!)).status === 'IN_PROGRESS' && (await h.session(ids.Alex!))?.inTurn === true, { label: 'Alex is in the middle of the long task', timeout: 30000 });
  await sleep(1500); // several looks of the office
  assert.equal((await employee('Alex')).claudeConfigDir ?? null, null);
  assert.equal((await switched()).length, 0);
});

test('once somebody is logged in to the other account, the people of the spent one are put on it and go on there', async () => {
  // Sarah is put on the second account by hand first: she is not one of those who get moved now.
  await h.api('PATCH', `/employees/${ids.Sarah}`, { claudeConfigDir: '~/.claude-2' });
  const before = await h.session(ids.Alex!);
  logIn(path.join(home, '.claude-2'), 'second@example.test', 5);
  const checked = await h.api('POST', `/hosts/${h.hostId}/accounts/check`, {});
  assert.deepEqual(checked.accounts.map((a: any) => [a.dir, a.loggedIn, a.email]), [[null, true, 'first@example.test'], ['~/.claude-2', true, 'second@example.test']]);
  await waitFor(async () => (await employee('Alex')).claudeConfigDir === '~/.claude-2', { label: 'Alex is on the second account', timeout: 15000 });
  // Noor had no session: only her account changed, nothing was started for her.
  await waitFor(async () => (await employee('Noor')).claudeConfigDir === '~/.claude-2', { label: 'Noor is on the second account', timeout: 5000 });
  assert.equal((await h.session(ids.Noor!))?.status === 'running', false);
  const s = await waitFor(async () => {
    const x = await h.session(ids.Alex!);
    return x?.status === 'running' && x.startedAt !== before!.startedAt ? x : null;
  }, { label: 'Alex runs again', timeout: 20000 });
  assert.equal(s.resumed, true, 'the same conversation, continued');
  assert.match(await envOf('Alex'), new RegExp(`CLAUDE_CONFIG_DIR=${home}/\\.claude-2`));
  // The task was not taken from him, and he is told to go on with it.
  assert.equal((await h.getTask(ids.long!)).assigneeId, ids.Alex);
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === ids.Alex && /started again on another Claude account/.test(m.body) && m.delivery.status !== 'queued'), { label: 'Alex is told to go on', timeout: 15000 });
  assert.match(told.body, /Go on with T-2 "Alex long work" from where you were/);
  const events = await switched();
  assert.equal(events.length, 2);
  assert.match(events.find((e) => e.employeeId === ids.Alex).summary, /Alex was put on another Claude account \(second@example\.test\): first@example\.test has used up its allowance until \d\d:\d\d UTC/);
  const rows = await usage();
  assert.deepEqual(rows.find((r) => r.configDir === '~/.claude-2').employeeIds.sort(), [ids.Alex, ids.Noor, ids.Sarah].sort());
  assert.deepEqual(rows.find((r) => r.configDir === null).employeeIds, []);
  // An account with people on it cannot be taken off the list.
  const refused = await h.apiRaw('DELETE', `/hosts/${h.hostId}/accounts?dir=${encodeURIComponent('~/.claude-2')}`);
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(refused.body), /on that account/);
});

test('a turn Claude refuses for the limit counts by itself — and with the switch off, people wait', async () => {
  await h.api('POST', `/hosts/${h.hostId}/accounts`, { dir: '~/.claude-3' });
  logIn(path.join(home, '.claude-3'), 'third@example.test', 10);
  await h.api('PATCH', '/settings', { accountFailover: false });
  ids.sarahTask = (await h.task({ projectId: ids.project, title: 'Sarah hits the limit', assigneeId: ids.Sarah, description: '@@fake: write s.txt s; limit@@' })).id;
  // The figures of the second account say 5 %: only the refused turn tells.
  const row = await waitFor(async () => {
    const r = await account('~/.claude-2');
    return r?.spentUntil ? r : null;
  }, { label: 'the second account counts as used up', timeout: 30000 });
  assert.equal(row.exhausted, true);
  assert.ok(Date.parse(row.spentUntil) > Date.now() + 50 * 60_000 && Date.parse(row.spentUntil) < Date.now() + 61 * 60_000, 'for an hour when no reset is known');
  await sleep(1500);
  assert.equal((await employee('Sarah')).claudeConfigDir, '~/.claude-2', 'switched off: she waits');
  await h.api('PATCH', '/settings', { accountFailover: true });
  await waitFor(async () => (await employee('Sarah')).claudeConfigDir === '~/.claude-3', { label: 'Sarah is on the third account', timeout: 15000 });
  await waitFor(async () => /CLAUDE_CONFIG_DIR=.*\.claude-3/.test(await envOf('Sarah')), { label: 'Sarah runs on the third account', timeout: 20000 });
  // Alex was moved a moment ago: not again within ten minutes, wherever his account stands.
  await sleep(1200);
  assert.equal((await employee('Alex')).claudeConfigDir, '~/.claude-2');
});

test('the owner moves an account\'s people now, whatever the figures and the waiting time; an empty account can be removed', async () => {
  const res = await h.api('POST', `/hosts/${h.hostId}/accounts/move`, { from: '~/.claude-2' });
  assert.equal(res.moved, 2); // Alex and Noor
  assert.equal((await employee('Alex')).claudeConfigDir, '~/.claude-3');
  assert.equal((await employee('Noor')).claudeConfigDir, '~/.claude-3');
  await waitFor(async () => /CLAUDE_CONFIG_DIR=.*\.claude-3/.test(await envOf('Alex')), { label: 'Alex runs on the third account', timeout: 20000 });
  assert.match((await switched()).find((e) => e.employeeId === ids.Alex && e.data.to === '~/.claude-3').summary, /by the boss/);
  await h.api('DELETE', `/hosts/${h.hostId}/accounts?dir=${encodeURIComponent('~/.claude-2')}`);
  assert.deepEqual((await h.state()).hosts.find((x) => x.id === h.hostId)!.claudeAccounts, ['~/.claude-3']);
  assert.ok(fs.existsSync(path.join(home, '.claude-2', '.claude.json')), 'nothing on the machine is deleted');
  assert.equal(await account('~/.claude-2'), undefined);
});

test('the accounts of a machine and who is on which survive a restart of the office', async () => {
  await h.restartServer();
  assert.deepEqual((await h.state()).hosts.find((x) => x.id === h.hostId)!.claudeAccounts, ['~/.claude-3']);
  assert.equal((await employee('Sarah')).claudeConfigDir, '~/.claude-3');
  assert.equal((await account(null)).exhausted, true);
});
