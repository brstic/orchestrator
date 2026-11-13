/**
 * How much of each Claude account is used: every worker session passes on what Claude Code's
 * status line says about its account's limits; employees can be put on different accounts
 * (a Claude config folder of their own), and the owner — only the owner — sees one row per account.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mayCall } from '../../apps/server/src/access.ts';
import { buildHooksSettings } from '../../packages/execution/src/claude.ts';

// A home folder of its own for this file: the "machine's" Claude logins live in it.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-home-')));
process.env.HOME = home;
const { createHarness, waitFor } = await import('./harness.ts');
type Harness = Awaited<ReturnType<typeof createHarness>>;

const inAnHour = Math.floor(Date.now() / 1000) + 3600;
const inThreeDays = Math.floor(Date.now() / 1000) + 3 * 86400;
const login = (dir: string, email: string, org: string, limits: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: org }, somethingElse: 'not read' }));
  if (limits) fs.writeFileSync(path.join(dir, 'fake-limits.json'), JSON.stringify(limits));
};

let h: Harness;
const ids: Record<string, string> = {};
const usage = () => h.api<any[]>('GET', '/usage');

before(async () => {
  login(home, 'owner@example.test', 'Owner Org', { five_hour: { used_percentage: 23.5, resets_at: inAnHour }, seven_day: { used_percentage: 85, resets_at: inThreeDays } });
  login(path.join(home, '.claude-second'), 'second@example.test', 'Second Org', { five_hour: { used_percentage: 5, resets_at: inAnHour }, seven_day: { used_percentage: 10, resets_at: inThreeDays } });
  fs.mkdirSync(path.join(home, '.claude-empty'));
  h = await createHarness();
  const repo = h.makeRepo('shop');
  const projectId = (await h.project('Shop', repo)).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend'], ['Noor', 'qa']] as const) ids[name] = (await h.employee(name, role, { projectId, autonomy: 'auto' })).id;
  ids.project = projectId;
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks installed for sessions the office did not start leave the owner\'s own status line alone', () => {
  const s: any = buildHooksSettings({ socketPath: '/tmp/a b/agent.sock', token: "t'ok", sessionId: 'ses_1', claudeVersion: '2.1.322', approvalWaitSeconds: 20 });
  assert.equal(s.statusLine, undefined);
});

test('before anyone has worked, each account is listed without figures — not left out, not guessed', async () => {
  await h.api('PATCH', `/employees/${ids.Sarah}`, { claudeConfigDir: '~/.claude-second/' });
  const rows = await usage();
  assert.equal(rows.length, 2);
  const mine = rows.find((r) => r.configDir === null);
  const second = rows.find((r) => r.configDir === '~/.claude-second');
  assert.deepEqual(mine.employeeIds.sort(), [ids.Alex, ids.Noor].sort());
  assert.deepEqual(second.employeeIds, [ids.Sarah]);
  for (const r of rows) assert.deepEqual([r.reportedAt, r.fiveHour, r.sevenDay, r.email], [null, null, null, null]);
});

test('two employees on two accounts: each account shows what Claude Code said in their own session', async () => {
  await h.task({ projectId: ids.project, title: 'Alex works', assigneeId: ids.Alex, description: '@@fake: write a.txt a; commit a; complete done@@' });
  await h.task({ projectId: ids.project, title: 'Sarah works', assigneeId: ids.Sarah, description: '@@fake: write b.txt b; commit b; complete done@@' });
  const rows = await waitFor(async () => {
    const r = await usage();
    return r.every((x) => x.reportedAt) ? r : null;
  }, { label: 'both accounts reported', timeout: 30000 }).catch(async (e) => {
    const out = [];
    for (const n of ['Alex', 'Sarah']) {
      const x = await h.session(ids[n]);
      out.push(`${n}: ${x?.status}/${x?.activity}\n${x?.tmuxPane ? h.tmux('capture-pane', '-p', '-J', '-S', '-15', '-t', x.tmuxPane) : ''}`);
    }
    throw new Error(`${e.message}\n${JSON.stringify(await usage())}\n${out.join('\n')}`);
  });
  const mine = rows.find((r) => r.configDir === null);
  const second = rows.find((r) => r.configDir !== null);
  assert.equal(mine.email, 'owner@example.test');
  assert.equal(mine.organization, 'Owner Org');
  assert.equal(mine.fiveHour.usedPercent, 23.5);
  assert.equal(mine.sevenDay.usedPercent, 85);
  assert.equal(mine.fiveHour.resetsAt, new Date(inAnHour * 1000).toISOString());
  assert.equal(mine.reportedBy, ids.Alex);
  assert.equal(mine.key, `${h.hostId}|default`);
  // Sarah's session really ran in the other login: its figures and its identity are the second folder's.
  assert.equal(second.email, 'second@example.test');
  assert.equal(second.configDir, '~/.claude-second');
  assert.deepEqual([second.fiveHour.usedPercent, second.sevenDay.usedPercent], [5, 10]);
  assert.equal(second.reportedBy, ids.Sarah);
  // The busiest account comes first.
  assert.equal(rows[0].email, 'owner@example.test');
  const sarah = await h.session(ids.Sarah);
  assert.match(h.tmux('show-environment', '-t', sarah!.tmuxSession!).concat(h.started()), new RegExp(`CLAUDE_CONFIG_DIR=${home}/.claude-second`));
});

test('the figures survive a restart of the office, and a window that has reset no longer shows the old figure', async () => {
  await h.restartServer();
  const rows = await usage();
  assert.equal(rows.find((r: any) => r.configDir === null).sevenDay.usedPercent, 85);
  // Sarah's account reports a 5-hour window whose reset time is already behind us.
  fs.writeFileSync(path.join(home, '.claude-second', 'fake-limits.json'), JSON.stringify({ five_hour: { used_percentage: 97, resets_at: Math.floor(Date.now() / 1000) - 60 }, seven_day: { used_percentage: 11, resets_at: inThreeDays } }));
  await h.api('POST', `/employees/${ids.Sarah}/message`, { body: 'one more thing' });
  const second = await waitFor(async () => (await usage()).find((r) => r.configDir !== null && r.sevenDay?.usedPercent === 11), { label: 'second account reported again', timeout: 20000 });
  assert.deepEqual(second.fiveHour, { usedPercent: 0, resetsAt: null });
});

test('an account folder must be a real login in the home folder of that machine', async () => {
  for (const bad of ['../etc', 'relative/dir', '~/x/../../etc', '/tmp/$(id)']) {
    const res = await h.apiRaw('PATCH', `/employees/${ids.Noor}`, { claudeConfigDir: bad });
    assert.equal(res.status, 400, bad);
  }
  await h.api('PATCH', `/employees/${ids.Noor}`, { claudeConfigDir: '/etc/claude' });
  const outside = await h.apiRaw('POST', `/employees/${ids.Noor}/start`, {});
  assert.match(JSON.stringify(outside.body), /must be inside your home folder/);
  await h.api('PATCH', `/employees/${ids.Noor}`, { claudeConfigDir: '~/.claude-empty' });
  const empty = await h.apiRaw('POST', `/employees/${ids.Noor}/start`, {});
  assert.match(JSON.stringify(empty.body), /nobody is logged in to Claude Code in .*\.claude-empty/);
  assert.equal((await h.session(ids.Noor))?.status === 'running', false);
  // Cleared again: back on the machine's default login.
  const back = await h.api('PATCH', `/employees/${ids.Noor}`, { claudeConfigDir: '' });
  assert.equal(back.claudeConfigDir, null);
});

test('only a session of ours can report, and guests are not told about the accounts', async () => {
  const alex = await h.session(ids.Alex);
  const post = (token: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath: path.join(h.agentHome, 'agent.sock'), path: '/statusline', method: 'POST', headers: { 'content-type': 'application/json', 'x-orch-token': token, 'x-orch-session': alex!.id } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: inAnHour }, seven_day: { used_percentage: 1, resets_at: inThreeDays } } }));
    });
  assert.equal(await post('not-the-token'), 403);
  assert.equal((await usage()).find((r) => r.configDir === null).sevenDay.usedPercent, 85);
  // Everyone in the office may read how much is used (the clocks on the walls); whose account it is, only those who
  // may work on the machine it lives on.
  await h.api('POST', '/sharing', { open: true, port: 20000 + Math.floor(Math.random() * 20000) });
  const tokenOf = (invite: string) => JSON.parse(Buffer.from(invite.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8')).t as string;
  const as = async (role: string) => {
    const made = await h.api<any>('POST', '/guests', { name: `Usage ${role}`, role });
    const r = await fetch(`${h.url}/api/usage`, { headers: { authorization: `Bearer ${tokenOf(made.invite)}` } });
    return { status: r.status, rows: (await r.json()) as any[] };
  };
  // A visitor is told nothing about the accounts: not the percentages either.
  assert.equal((await as('visitor')).status, 403);
  const colleague = await as('colleague');
  assert.equal(colleague.rows.find((a) => a.configDir === null).email, 'owner@example.test', 'a colleague works on the shared machine and sees its account');
  assert.equal((await as('owner')).rows.find((a) => a.configDir === null).email, 'owner@example.test');
  await h.api('POST', '/sharing', { open: false });
  assert.equal(mayCall(h.server.engine, { kind: 'guest', id: 'm1', name: 'M', role: 'visitor' }, 'GET', '/usage', null).ok, false);
  assert.equal(mayCall(h.server.engine, { kind: 'guest', id: 'm2', name: 'M', role: 'colleague' }, 'GET', '/usage', null).ok, true);
});
