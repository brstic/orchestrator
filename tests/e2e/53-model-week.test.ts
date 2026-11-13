/**
 * The limit of one model. A subscription limits its strongest model (Fable) apart from the limit for all models.
 * When it is reached, the owner's order (2026-11-13): **another model first** — the session goes on, with the same
 * conversation, on the next model that has room on the same account — **another organisation only when no model
 * can**. Claude Code's own menu after a refused turn never holds a session: it is left behind by the restart, or
 * answered "Stop and wait" — never "Switch to usage credits".
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
/** "Nov 19, 1pm (UTC)", three days from now — the way Claude Code says when a limit lifts. */
const lifts = (() => {
  const d = new Date(Date.now() + 3 * 86_400_000);
  return { words: `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCDate()}, 1pm (UTC)`, iso: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13)).toISOString() };
})();

let h: Harness;
const ids: Record<string, string> = {};
const usage = () => h.api<any[]>('GET', '/usage');
const account = async (dir: string | null) => (await usage()).find((r) => r.hostId === h.hostId && r.configDir === dir);
const on = async (name: string) => (await h.state()).employees.find((e) => e.id === ids[name])!.claudeConfigDir ?? null;
const switched = async () => (await h.api<any[]>('GET', '/events?limit=500')).filter((e) => e.type === 'account.switched').map((e) => e.employeeId);
const works = (name: string, what = 'write a.txt a; commit a; complete done') => h.task({ projectId: ids.project, title: `${name} works ${Math.random().toString(36).slice(2, 6)}`, assigneeId: ids[name], description: `@@fake: ${what}@@` });
const between = (name: string) => waitFor(async () => { const s = await h.session(ids[name]!); return s?.status === 'running' && s.inTurn === false ? s : null; }, { label: `${name} is between turns`, timeout: 30000 });
const runsOn = (name: string, model: string | null, dir: string | null) => waitFor(async () => { const s = await h.session(ids[name]!); return s?.status === 'running' && (s.model ?? null) === model && (s.claudeConfigDir ?? null) === dir ? s : null; }, { label: `${name} runs ${model ?? 'the default model'} on ${dir ?? 'the default account'}`, timeout: 30000 });
const credits = () => [home, second].some((d) => fs.existsSync(path.join(d, '.fake-usage-credits')));

before(async () => {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'first@example.test', organizationName: 'Org' } }));
  limits(home);
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'second@example.test', organizationName: 'Other Org' } }));
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

test('a model\'s limit reported by Claude Code: those on that model go on with the next one, on the same account; nobody moves', async () => {
  await works('Alex');
  await between('Alex');
  limits(home, { seven_day_fable: { used_percentage: 64, resets_at: inThreeDays } });
  await works('Sarah');
  const row = await waitFor(async () => { const a = await account(null); return a?.modelWeeks?.fable ? a : null; }, { label: 'the Fable limit is known', timeout: 30000 });
  assert.deepEqual([row.modelWeeks.fable.usedPercent, row.modelWeeks.fable.from, row.exhausted], [64, 'reported', false]);
  assert.equal((await h.session(ids.Alex!))!.model, 'fable');
  // Fable's limit is reached; the limit for all models has room.
  limits(home, { seven_day_fable: { used_percentage: 100, resets_at: inThreeDays } });
  await between('Sarah');
  await works('Sarah', 'write b.txt b; commit b; complete done');
  const alex = await runsOn('Alex', 'opus', null);
  assert.ok(h.started().split('\n').filter((l) => l.startsWith(alex.tmuxSession!)).pop()!.includes('--model opus'));
  assert.equal((await h.state()).employees.find((e) => e.id === ids.Alex)!.model, 'fable', 'his own setting stays Fable');
  assert.ok((await h.api<any[]>('GET', '/events?limit=300')).some((e) => e.employeeId === ids.Alex && /Alex goes on with Opus: Fable's limit is reached/.test(e.summary)));
  assert.equal((await h.session(ids.Sarah!))!.model, 'sonnet', 'Sonnet has room: Sarah goes on as she was');
  assert.deepEqual(await switched(), [], 'nobody moved to another organisation');
});

test('a turn refused with Claude Code\'s own words, and its menu: the office goes on with another model and is not held by the menu', async () => {
  // Noor's model is "whatever the account uses". Her turn is refused for Fable — so that is what she thinks with.
  const t = await works('Noor', `limit You've hit your Fable limit · resets ${lifts.words}`);
  const noor = await runsOn('Noor', 'opus', null);
  const row = await account(null);
  assert.deepEqual([row.modelWeeks.fable.from, row.modelWeeks.fable.resetsAt, row.exhausted], ['refused', lifts.iso, false], 'the account is not taken as used up');
  // Told to go on with her task, on the new model.
  const told = await waitFor(async () => (await h.api<any[]>('GET', '/events?limit=300')).find((e) => e.type === 'agent.message' && e.employeeId === ids.Noor && /Fable's limit is reached on your Claude account/.test(e.data?.body ?? e.summary ?? '')) ?? (await h.state()).messages.find((m: any) => m.toEmployeeId === ids.Noor && /Fable's limit is reached/.test(m.body)), { label: 'told to go on', timeout: 20000 });
  assert.ok(told);
  assert.equal(noor.resumed, true, 'the same conversation');
  assert.ok(!credits(), 'usage credits were never chosen');
  assert.deepEqual(await switched(), []);
  assert.notEqual((await h.getTask(t.id)).status, 'DONE');
});

test('the account\'s own limit: then another organisation — where the model of their own has room again', async () => {
  await between('Sarah');
  await works('Sarah', `limit You've hit your limit · resets ${lifts.words}`);
  // Everybody on the first account goes to the second one; Alex thinks with Fable there again.
  await waitFor(async () => (await on('Alex')) === '~/.claude-2' && (await on('Sarah')) === '~/.claude-2' && (await on('Noor')) === '~/.claude-2', { label: 'all moved to the other organisation', timeout: 30000 });
  const row = await account(null);
  assert.deepEqual([row.exhausted, row.spentUntil], [true, lifts.iso]);
  await runsOn('Alex', 'fable', '~/.claude-2');
  assert.deepEqual((await switched()).sort(), [ids.Alex, ids.Noor, ids.Sarah].sort());
  assert.ok(!credits());
});

test('nothing left — no model with room, no other account: the menu is answered "Stop and wait", never usage credits', async () => {
  // Hana thinks with Haiku (nothing weaker to go on with), on the second account; the first one is used up.
  ids.Hana = (await h.employee('Hana', 'backend', { projectId: ids.project, autonomy: 'auto', model: 'haiku', claudeConfigDir: '~/.claude-2' })).id;
  await works('Hana', `limit You've hit your Haiku limit · resets ${lifts.words}`);
  const s = await waitFor(async () => { const x = await h.session(ids.Hana!); return x && /Stopped\. Waiting for the limit to reset\./.test(h.tmux('capture-pane', '-p', '-t', x.tmuxPane!)) ? x : null; }, { label: 'the menu was answered', timeout: 30000 });
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.action === 'limit_menu.answered' && a.detail?.employee === 'Hana' && a.detail?.chose === 'Stop and wait for limit to reset'));
  assert.ok(!credits(), 'usage credits were never chosen');
  await sleep(1000);
  const now = (await h.session(ids.Hana!))!;
  assert.deepEqual([now.id, now.model, now.inTurn, await on('Hana')], [s.id, 'haiku', false, '~/.claude-2'], 'not started again, not moved');
});
