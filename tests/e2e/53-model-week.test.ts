/**
 * The week of one model. A subscription limits its strongest model (Fable) by the week apart from the week for all
 * models. The office keeps that week per account — from Claude Code's own report where it gives one, and from a
 * turn refused for it — shows it, and moves only those who think with that model, to an account where it has room.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-home-')));
process.env.HOME = home;
const { createHarness, waitFor, sleep } = await import('./harness.ts');
type Harness = Awaited<ReturnType<typeof createHarness>>;

const inAnHour = Math.floor(Date.now() / 1000) + 3600;
const inThreeDays = Math.floor(Date.now() / 1000) + 3 * 86400;
const limits = (dir: string, extra: Record<string, unknown> = {}) => fs.writeFileSync(path.join(dir, 'fake-limits.json'), JSON.stringify({ five_hour: { used_percentage: 20, resets_at: inAnHour }, seven_day: { used_percentage: 40, resets_at: inThreeDays }, ...extra }));
const second = path.join(home, '.claude-2');

let h: Harness;
const ids: Record<string, string> = {};
const usage = () => h.api<any[]>('GET', '/usage');
const account = async (dir: string | null) => (await usage()).find((r) => r.hostId === h.hostId && r.configDir === dir);
const on = async (name: string) => (await h.state()).employees.find((e) => e.id === ids[name])!.claudeConfigDir ?? null;
const switched = async () => (await h.api<any[]>('GET', '/events?limit=400')).filter((e) => e.type === 'account.switched').map((e) => e.employeeId);
const works = (name: string, what = 'write a.txt a; commit a; complete done') => h.task({ projectId: ids.project, title: `${name} works ${Math.random().toString(36).slice(2, 6)}`, assigneeId: ids[name], description: `@@fake: ${what}@@` });

before(async () => {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'first@example.test', organizationName: 'Org' } }));
  limits(home);
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'second@example.test', organizationName: 'Org' } }));
  limits(second);
  h = await createHarness({ timings: { accountFailoverMs: 400 } });
  const repo = h.makeRepo('shop');
  ids.project = (await h.project('Shop', repo)).id;
  await h.api('POST', `/hosts/${h.hostId}/accounts`, { dir: '~/.claude-2' });
  // Alex thinks with Fable, Sarah with Sonnet, Noor with whatever the account uses.
  for (const [name, model] of [['Alex', 'fable'], ['Sarah', 'sonnet'], ['Noor', null]] as const) ids[name] = (await h.employee(name, 'backend', { projectId: ids.project, autonomy: 'auto', model })).id;
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a model\'s week that Claude Code reports is kept beside the two windows; when it is used up, those who think with that model move and the others stay', async () => {
  limits(home, { seven_day_fable: { used_percentage: 64, resets_at: inThreeDays } });
  await works('Sarah');
  const row = await waitFor(async () => { const a = await account(null); return a?.modelWeeks?.fable ? a : null; }, { label: 'the Fable week is known', timeout: 30000 });
  assert.deepEqual([row.modelWeeks.fable.usedPercent, row.modelWeeks.fable.from, row.sevenDay.usedPercent, row.exhausted], [64, 'reported', 40, false]);
  assert.equal(new Date(row.modelWeeks.fable.resetsAt).getTime(), inThreeDays * 1000);
  await sleep(1200);
  assert.deepEqual(await switched(), [], 'with room left, nobody moves');
  // The week for Fable runs out; the week for all models has room.
  limits(home, { seven_day_fable: { used_percentage: 100, resets_at: inThreeDays } });
  await waitFor(async () => (await h.session(ids.Sarah!))?.inTurn === false, { label: 'Sarah between turns', timeout: 30000 });
  await works('Sarah', 'write b.txt b; commit b; complete done');
  await waitFor(async () => (await on('Alex')) === '~/.claude-2', { label: 'Alex, who thinks with Fable, is on the other account', timeout: 30000 });
  await sleep(1500);
  assert.deepEqual([await on('Sarah'), await on('Noor')], [null, null], 'Sonnet has room here; and nobody knows yet what Noor thinks with');
  assert.deepEqual(await switched(), [ids.Alex]);
  const after = await account(null);
  assert.deepEqual([after.exhausted, after.modelWeeks.fable.usedPercent], [false, 100], 'the account itself is not used up');
});

test('a turn refused for a model\'s week teaches the office that week — and who thinks with that model', async () => {
  // Noor's model is "whatever the account uses". Her turn is refused for Fable's week: so that is what she thinks with.
  await works('Noor', 'limit You have reached your weekly limit for Fable');
  await waitFor(async () => (await on('Noor')) === '~/.claude-2', { label: 'Noor is on the other account', timeout: 30000 });
  assert.deepEqual((await switched()).sort(), [ids.Alex, ids.Noor].sort());
  assert.equal(await on('Sarah'), null);
});

test('nobody is moved onto an account where the same model\'s week is used up too; a refusal that names when it lifts is believed', async () => {
  const until = new Date(Date.now() + 2 * 86_400_000);
  until.setMilliseconds(0);
  const before = (await switched()).length;
  // On the second account Fable's week runs out as well — said by a refusal that names when it lifts.
  await waitFor(async () => { const s = await h.session(ids.Alex!); return !s || s.inTurn === false; }, { label: 'Alex between turns', timeout: 30000 });
  await works('Alex', `limit Weekly limit reached for Fable, resets ${until.toISOString()}`);
  const row = await waitFor(async () => { const a = await account('~/.claude-2'); return a?.modelWeeks?.fable ? a : null; }, { label: 'the second account knows its Fable week', timeout: 30000 });
  assert.deepEqual([row.modelWeeks.fable.usedPercent, row.modelWeeks.fable.from, row.modelWeeks.fable.resetsAt, row.exhausted], [100, 'refused', until.toISOString(), false]);
  await sleep(2000);
  // The first account has no room for Fable either (its own report says 100 %): Alex and Noor stay where they are.
  assert.deepEqual([await on('Alex'), await on('Noor')], ['~/.claude-2', '~/.claude-2']);
  assert.equal((await switched()).length, before);
  // The figures survive a restart of the office.
  await h.restartServer();
  const again = await waitFor(async () => { const a = await account('~/.claude-2').catch(() => null); return a?.modelWeeks?.fable ? a : null; }, { label: 'known after the restart', timeout: 30000 });
  assert.deepEqual([again.modelWeeks.fable.resetsAt, (await account(null)).modelWeeks.fable.usedPercent], [until.toISOString(), 100]);
});
