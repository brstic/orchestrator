/**
 * Goals — the office's /goal (the owner, 2026-11-13: "something like Claude Code's /goal, so that it can work until it
 * has finished everything the goal asks"). The real chain: the goal is typed into the fake CLI's session, each time its
 * turn ends the office's Stop hook sends it on, it says the goal holds, and the office's check decides.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
const ids: Record<string, string> = {};
const folder: Record<string, string> = {};

before(async () => {
  h = await createHarness();
  for (const name of ['Alex', 'Dana']) {
    folder[name] = h.makeRepo(name.toLowerCase());
    const project = (await h.project(`P-${name}`, folder[name]!, { workspace: 'in_place' })).id;
    ids[name] = (await h.employee(name, 'backend', { projectId: project, autonomy: 'auto' })).id;
  }
});
after(async () => {
  await h?.cleanup();
});

const emp = async (name: string) => (await h.state()).employees.find((e) => e.id === ids[name])!;

test('given a goal, they go on turn after turn until it holds — a step a turn — and the check confirms it', async () => {
  await h.api('POST', `/employees/${ids.Alex}/start`, {});
  await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.status === 'running' && s.inTurn === false ? s : null; }, { label: 'Alex is up', timeout: 30000 });
  // One step a turn; at the third the work is done and they say so. (What the fake CLI does is scripted in the words.)
  const condition = 'steps.txt has three lines. @@fake: bash echo step >> steps.txt; bash test $(wc -l < steps.txt) -lt 3 || touch goal-done.txt; iffile goal-done.txt mcp goal_met {"evidence":"steps.txt has three lines: I counted them with wc -l."}@@';
  const set = await h.api('PUT', `/employees/${ids.Alex}/goal`, { condition, check: 'test $(wc -l < steps.txt) -ge 3' });
  assert.equal(set.status, 'active');
  const met = await waitFor(async () => { const g = (await emp('Alex')).goal; return g?.status === 'met' ? g : null; }, { label: 'the goal is met', timeout: 60000 });
  // Exactly three steps: sent on twice, and not once more after it held.
  assert.equal(fs.readFileSync(path.join(folder.Alex!, 'steps.txt'), 'utf8').trim().split('\n').length, 3);
  assert.equal(met.turns, 2);
  assert.match(String(met.outcome), /three lines/);
  await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.inTurn === false ? s : null; }, { label: 'their turn ended', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.readFileSync(path.join(folder.Alex!, 'steps.txt'), 'utf8').trim().split('\n').length, 3, 'nothing sends them on after it holds');
  const events = (await h.state()).events.filter((e) => e.type === 'agent.goal' && e.employeeId === ids.Alex);
  assert.ok(events.some((e) => (e.data as any).phase === 'set') && events.some((e) => (e.data as any).phase === 'met'));
  assert.ok((await h.state()).notifications.some((n) => n.title === 'Alex met the goal you gave them'));
});

test('a goal they make no progress on stops by itself after three turns, and the owner is told', async () => {
  await h.api('POST', `/employees/${ids.Dana}/start`, {});
  await waitFor(async () => { const s = await h.session(ids.Dana!); return s?.status === 'running' && s.inTurn === false ? s : null; }, { label: 'Dana is up', timeout: 30000 });
  // Nothing in the words for the fake CLI to do: it answers and stops, every time.
  await h.api('PUT', `/employees/${ids.Dana}/goal`, { condition: 'The service is faster than it was.' });
  const stopped = await waitFor(async () => { const g = (await emp('Dana')).goal; return g?.status === 'stopped' ? g : null; }, { label: 'the goal stops', timeout: 60000 });
  assert.match(String(stopped.outcome), /no progress/);
  assert.ok((await h.state()).notifications.some((n) => n.title === 'Dana stopped working toward their goal'));
  // A person clears a goal; an employee cannot clear one a person gave (unit tests); a visitor is not sent it (access).
  await h.api('PUT', `/employees/${ids.Dana}/goal`, { condition: 'Write the changelog. @@fake: say thinking about it@@' });
  const cleared = await h.api('DELETE', `/employees/${ids.Dana}/goal`);
  assert.equal(cleared.goal.status, 'stopped');
  assert.match(cleared.goal.outcome, /cleared by the boss/);
});
