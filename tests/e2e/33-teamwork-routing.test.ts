/**
 * How work finds the right person in an office where everyone has the same trade and many projects are small —
 * a real server, a real host agent, real tmux sessions, scripted workers.
 *
 *  - a task that names nobody goes to the colleague it is about;
 *  - tasks can be proposed *for* somebody, also for a colleague on another project (who is lent, not moved);
 *  - a task can be handed over to a colleague on another project;
 *  - where nobody is a reviewer by trade, a colleague reviews — the task does not wait for the boss.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let shop = '';
let studio = '';
const ids: Record<string, string> = {};
const emp = async (name: string) => (await h.state()).employees.find((e) => e.id === ids[name])!;
/** What an office tool answered, read from the file the scripted worker wrote it to. */
async function ask(name: string, script: string, file: string): Promise<string> {
  // Somebody who has had no work yet has no session: they are started first.
  if ((await h.session(ids[name]!))?.status !== 'running') await h.api('POST', `/employees/${ids[name]}/start`, {});
  await waitFor(async () => (await h.session(ids[name]!))?.inTurn === false, { label: `${name} is up`, timeout: 30000 });
  const s = (await h.session(ids[name]!))!;
  const out = path.join(s.cwd, file);
  fs.rmSync(out, { force: true });
  await waitFor(async () => (await h.session(ids[name]!))!.inTurn === false, { label: `${name} between turns`, timeout: 20000 });
  await h.api('POST', `/employees/${ids[name]}/message`, { body: `Do this. @@fake: ${script}; result ${file}@@` });
  await waitFor(() => fs.existsSync(out), { label: `an answer for ${name}`, timeout: 20000 });
  const text = fs.readFileSync(out, 'utf8');
  fs.rmSync(out, { force: true });
  return text;
}

before(async () => {
  h = await createHarness();
  shop = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  studio = (await h.project('Studio', h.makeRepo('studio'), { verifyCommand: null })).id;
  // Everyone has the same trade; what tells them apart is what each one keeps.
  for (const [name, projectId] of [['Shop Marketplace', shop], ['Shop Panel', shop], ['Shop Manager', shop], ['Studio Designer', studio]] as const) ids[name] = (await h.employee(name, 'fullstack', { projectId, autonomy: 'auto' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('a task that names nobody goes to the colleague it is about, not to whoever happens to be first', async () => {
  const a = await h.task({ projectId: shop, title: 'Panel: the month graph overflows', description: '@@fake: write graph.txt fixed; commit graph; complete graph fixed@@' });
  const b = await h.task({ projectId: shop, title: 'Marketplace: Stripe status on the sell page', description: '@@fake: write stripe.txt shown; commit stripe; complete status shown@@' });
  const doneA = await waitFor(async () => {
    const t = await h.getTask(a.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'the panel task done', timeout: 40000 });
  const doneB = await waitFor(async () => {
    const t = await h.getTask(b.id);
    return t.status === 'DONE' ? t : null;
  }, { label: 'the marketplace task done', timeout: 40000 });
  assert.equal(doneA.assigneeId, ids['Shop Panel']);
  assert.equal(doneB.assigneeId, ids['Shop Marketplace']);
});

test('the team as a colleague sees it: who keeps what, and to whom work can be given', async () => {
  const team = await ask('Shop Manager', 'mcp get_team {}', 'team.txt');
  assert.match(team, /- Shop Panel — .*/);
  assert.match(team, /- Studio Designer — .* · project Studio/);
  assert.doesNotMatch(team, /Shop Panel — [^\n]* · project /, 'a colleague on the same project needs no project named');
});

test('tasks are proposed for the people they are for — also for a colleague on another project, who is lent and not moved', async () => {
  const refused = await ask('Shop Manager', 'mcp propose_tasks {"tasks":[{"title":"Good one","description":"x","assignee":"Shop Panel"},{"title":"Nobody home","description":"y","assignee":"Mister Nobody"}]}', 'p0.txt');
  assert.match(refused, /^ERROR .*no teammate matches "Mister Nobody"/);
  assert.equal((await h.state()).tasks.some((t) => t.title === 'Good one'), false, 'nothing was created when one name was wrong');
  const res = await ask('Shop Manager', 'mcp propose_tasks {"rationale":"split by who keeps what","tasks":[{"title":"Tidy the price table","description":"do it","assignee":"Shop Panel"},{"title":"Redraw the hero picture","description":"needs the designer","assignee":"Studio Designer"},{"title":"Whoever is free","description":"small"}]}', 'p1.txt');
  assert.match(res, /^Created 3 tasks/);
  const tasks = (await h.state()).tasks;
  const of = (title: string) => tasks.find((t) => t.title === title)!;
  assert.equal(of('Tidy the price table').assigneeId, ids['Shop Panel']);
  assert.equal(of('Redraw the hero picture').assigneeId, ids['Studio Designer']);
  assert.equal(of('Redraw the hero picture').projectId, shop);
  assert.equal(of('Whoever is free').roleHint ?? null, null);
  const designer = await emp('Studio Designer');
  assert.equal(designer.projectId, studio, 'still the Studio\'s');
  assert.deepEqual(designer.alsoProjectIds, [shop], 'and lent to the Shop');
  // The lent colleague really gets it.
  await waitFor(async () => ['IN_PROGRESS', 'DONE', 'REVIEW'].includes((await h.getTask(of('Redraw the hero picture').id)).status), { label: 'the designer has the task', timeout: 40000 });
  assert.equal((await emp('Studio Designer')).projectId, studio);
  // (These were only there to see where they go: taken off the board again, so everyone is free for what follows.)
  for (const title of ['Tidy the price table', 'Redraw the hero picture', 'Whoever is free']) {
    const t = (await h.state()).tasks.find((x) => x.title === title);
    if (t && t.status !== 'DONE') await h.api('POST', `/tasks/${t.id}/stop`, { then: 'delete' });
  }
  await waitFor(async () => !(await h.state()).tasks.some((t) => t.status === 'IN_PROGRESS'), { label: 'everyone is free again', timeout: 20000 });
});

test('a task can be handed over to a colleague on another project', async () => {
  const task = await h.task({ projectId: shop, title: 'Needs a designer after all', assigneeId: ids['Shop Marketplace'], kind: 'research', description: '@@fake: say looking at it@@' });
  await waitFor(async () => (await h.getTask(task.id)).delivery.status === 'confirmed', { label: 'Marketplace has it', timeout: 40000 });
  const res = await ask('Shop Marketplace', 'mcp hand_off_task {"to":"Studio Designer","notes":"The analysis is done and written in the task. What is left is the picture itself, which is yours."}', 'handoff.txt');
  assert.doesNotMatch(res, /^ERROR/, res);
  const after = await h.getTask(task.id);
  assert.equal(after.assigneeId, ids['Studio Designer']);
});

test('where nobody is a reviewer by trade, a colleague reviews — unless the board is the boss\'s alone', async () => {
  const one = await h.task({ projectId: shop, title: 'Panel: export button', assigneeId: ids['Shop Panel'], requiresReview: true, description: '@@fake: write export.txt ok; commit export; complete export added@@' });
  const inReview = await waitFor(async () => {
    const t = await h.getTask(one.id);
    return t.status === 'REVIEW' ? t : null;
  }, { label: 'waiting for review', timeout: 40000 });
  assert.ok(inReview.reviewerId && inReview.reviewerId !== ids['Shop Panel'], 'a colleague, never the author');
  const reviewer = (await h.state()).employees.find((e) => e.id === inReview.reviewerId)!;
  assert.ok(['Shop Marketplace', 'Shop Manager', 'Studio Designer'].includes(reviewer.name));
  const review = (await h.state()).tasks.find((t) => t.reviewOf === one.id)!;
  assert.equal(review.assigneeId, reviewer.id);
  const events = await h.api<any[]>('GET', '/events?limit=400');
  assert.ok(events.some((e) => e.type === 'task.review_requested' && e.taskId === one.id && new RegExp(`waiting for review by ${reviewer.name}`).test(e.summary)));
  // With the board taken back, it waits for the boss as before.
  // (The designer first finishes what was handed over to them above.)
  await waitFor(async () => (await h.session(ids['Studio Designer']!))?.inTurn === false, { label: 'the designer between turns', timeout: 30000 });
  await h.api('POST', `/employees/${ids['Studio Designer']}/message`, { body: 'Finish it. @@fake: complete-nocode the picture is done@@' });
  await waitFor(async () => !(await h.state()).tasks.some((t) => t.assigneeId === ids['Studio Designer'] && t.status === 'IN_PROGRESS'), { label: 'the designer is free', timeout: 40000 });
  await h.api('PATCH', '/settings', { employeesManageBoard: false });
  const two = await h.task({ projectId: shop, title: 'Marketplace: new footer', assigneeId: ids['Shop Marketplace'], requiresReview: true, description: '@@fake: write footer.txt ok; commit footer; complete footer added@@' });
  const waiting = await waitFor(async () => {
    const t = await h.getTask(two.id);
    return t.status === 'REVIEW' ? t : null;
  }, { label: 'the second one waits for review', timeout: 40000 });
  assert.equal(waiting.reviewerId ?? null, null);
  await h.api('PATCH', '/settings', { employeesManageBoard: true });
  // What was left waiting for nobody is given to a colleague when the office next starts.
  await h.restartServer();
  const rerouted = await waitFor(async () => {
    const t = await h.getTask(two.id);
    return t.reviewerId ? t : null;
  }, { label: 'a colleague was asked after the restart', timeout: 20000 });
  assert.notEqual(rerouted.reviewerId, ids['Shop Marketplace']);
  assert.ok(rerouted.history.some((x) => /No reviewer had been asked: a colleague is asked now/.test(x.note)));
});
